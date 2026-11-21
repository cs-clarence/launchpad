import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
    NAME,
    command,
    confirmedAbsent,
    createDocker,
    randomHex,
    raceRounds,
    type Evidence,
    type Resources,
} from "./harness";
import { runScenarios, type World } from "./scenarios";

// Opt-in full-stack rehearsal: the built controller, worker and router images against a
// disposable PostgreSQL and a disposable Dokku, driving the worked acceptance example over the
// real HTTP API. Never part of CI or a default task. See docs/plans/deployment-p7-acceptance.md.
if (process.env.LAUNCHPAD_ACCEPTANCE_REHEARSAL !== "1") {
    throw new Error(
        "Set LAUNCHPAD_ACCEPTANCE_REHEARSAL=1 to authorize the disposable PostgreSQL, Dokku and image runs.",
    );
}

const rounds = raceRounds(process.env.LAUNCHPAD_ACCEPTANCE_RACE_ROUNDS);
const root = process.cwd();
const source = `${root}/tooling/experiments/acceptance`;
const APPS_DOMAIN = "live.example.com";
const BASE_URL = "https://control.example.net";
await mkdir("/tmp/opencode", { recursive: true });
const dir = await mkdtemp("/tmp/opencode/lp-accept-");
// Containers need traversal to explicitly mounted files; secret files stay 0600.
await chmod(dir, 0o755);
const id = path.basename(dir).toLowerCase();
const r: Resources = {
    dir,
    network: `${id}-net`,
    containers: {
        dokku: `${id}-dokku`,
        postgres: `${id}-postgres`,
        router: `${id}-router`,
        proxy: `${id}-proxy`,
        controller: `${id}-controller`,
        worker1: `${id}-worker1`,
        worker2: `${id}-worker2`,
    },
    images: {
        controller: `${id}/controller:test`,
        worker: `${id}/worker:test`,
        router: `${id}/router:test`,
    },
    volumes: [],
    helpers: [],
    discovered: [],
};
const { docker, persist } = createDocker(r);
// The resource contract is on disk before anything is created.
await persist();
console.log(`Resources recorded before creation: ${dir}/resources.json`);

const evidence: Evidence[] = [];
const cleanup: string[] = [];
let failure: unknown;
const secretPaths = ["credentials", "dokku", "data", "controller.env", "worker.env", "site"];

function cleanupFailed(message: string) {
    cleanup.push(`${message}: FAILED OR UNVERIFIED`);
    failure ??= new Error(message);
}

async function record(label: string, write: () => Promise<unknown>) {
    try {
        await write();
    } catch {
        cleanupFailed(label);
    }
}

// A failed Docker invocation cannot vouch for absence and must not stop unrelated teardown.
async function cleanupDocker(args: string[]) {
    try {
        return await docker(args, true);
    } catch {
        cleanupFailed(`Docker ${args.slice(0, 2).join(" ")}`);
        return { code: -1, out: "", err: "" };
    }
}

async function removeVolumeFree(name: string) {
    await cleanupDocker(["rm", "-f", "-v", name]);
    const absent = confirmedAbsent(await cleanupDocker(["container", "inspect", name]));
    cleanup.push(`container ${name}: ${absent ? "absent" : "LEFTOVER OR UNVERIFIED"}`);
    if (!absent) failure ??= new Error("Container cleanup incomplete.");
    return absent;
}

let world: World | undefined;
try {
    const operatorPassword = randomHex(12);
    const annPassword = randomHex(12);
    const dbPassword = randomHex(16);
    const routerToken = randomHex(32);
    const instanceId = randomUUID();
    await mkdir(`${dir}/credentials`);
    await mkdir(`${dir}/data`);
    await mkdir(`${dir}/dokku`);
    await mkdir(`${dir}/site`);
    await command([
        "ssh-keygen",
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-f",
        `${dir}/credentials/id_ed25519`,
    ]);

    for (const [name, image] of [
        ["controller", "apps/controller/Dockerfile"],
        ["worker", "apps/worker/Dockerfile"],
        ["router", "apps/router/Dockerfile"],
    ] as const) {
        await docker([
            "build",
            "-q",
            "--build-arg",
            "LAUNCHPAD_VERSION=acceptance",
            "-f",
            image,
            "-t",
            r.images[name],
            ".",
        ]);
    }
    await docker(["network", "create", r.network]);

    // PostgreSQL: tmpfs data, so no anonymous volume exists to leak. log_statement=mod lets the
    // stale-worker scenario count what a resumed worker tried to write.
    await writeFile(
        `${dir}/credentials/postgres.env`,
        `POSTGRES_USER=launchpad\nPOSTGRES_DB=launchpad\nPOSTGRES_PASSWORD=${dbPassword}\n`,
        { mode: 0o600 },
    );
    await docker([
        "run",
        "-d",
        "--name",
        r.containers.postgres,
        "--network",
        r.network,
        "--network-alias",
        "postgres",
        "--tmpfs",
        "/var/lib/postgresql/data",
        "--env-file",
        `${dir}/credentials/postgres.env`,
        "postgres:17-alpine",
        "-c",
        "log_statement=mod",
        "-c",
        "log_line_prefix=%m ",
    ]);
    // The init-time server listens on a socket only and is restarted: wait for the real one.
    let pgReady = false;
    for (let i = 0; i < 90 && !pgReady; i++) {
        const logs = await docker(["logs", r.containers.postgres], true);
        const text = `${logs.out}\n${logs.err}`;
        pgReady = (text.match(/ready to accept connections/g) ?? []).length >= 2;
        if (!pgReady) await Bun.sleep(1000);
    }
    if (!pgReady) throw new Error("Disposable PostgreSQL did not become ready.");

    await docker([
        "run",
        "-d",
        "--name",
        r.containers.dokku,
        "--network",
        "bridge",
        "--label",
        `launchpad.experiment=${id}`,
        "-e",
        `DOKKU_HOSTNAME=${APPS_DOMAIN}`,
        "-e",
        `DOKKU_HOST_ROOT=${dir}/dokku/home/dokku`,
        "-e",
        `DOKKU_LIB_HOST_ROOT=${dir}/dokku/var/lib/dokku`,
        "-v",
        `${dir}/dokku:/mnt/dokku`,
        "-v",
        "/var/run/docker.sock:/var/run/docker.sock",
        "launchpad/dokku:0.38.34",
    ]);
    await docker(["network", "connect", "--alias", "dokku", r.network, r.containers.dokku]);
    let dokkuReady = false;
    let lastReadiness = "";
    for (let attempt = 0; attempt < 90 && !dokkuReady; attempt++) {
        const check = await docker(
            [
                "exec",
                r.containers.dokku,
                "sh",
                "-c",
                "test -s /etc/ssh/ssh_host_ed25519_key.pub || exit 1; dokku version",
            ],
            true,
        );
        lastReadiness = `${check.out}\n${check.err}`;
        dokkuReady = !check.code;
        if (!dokkuReady) await Bun.sleep(1000);
    }
    if (!dokkuReady) throw new Error(`Disposable Dokku did not initialize: ${lastReadiness}`);
    const hostKey = (
        await docker(["exec", r.containers.dokku, "cat", "/etc/ssh/ssh_host_ed25519_key.pub"])
    ).out;
    await writeFile(`${dir}/credentials/known_hosts`, `dokku ${hostKey}\n`, { mode: 0o600 });
    await docker(
        ["exec", "-i", r.containers.dokku, "dokku", "ssh-keys:add", id],
        false,
        await readFile(`${dir}/credentials/id_ed25519.pub`, "utf8"),
    );

    // The router: state in a recorded volume, one init from stdin, the real image.
    const stateVolume = `${id}-router-state`;
    r.volumes.push(stateVolume);
    await persist();
    await docker(["volume", "create", stateVolume]);
    const routerEnv = [
        "-e",
        `LAUNCHPAD_ROUTER_INSTANCE_ID=${instanceId}`,
        "-e",
        `LAUNCHPAD_APPS_DOMAIN=${APPS_DOMAIN}`,
        "-e",
        "LAUNCHPAD_ROUTER_CONTROL_LISTEN=0.0.0.0:8081",
        "-e",
        "LAUNCHPAD_ROUTER_CONTROL_PRIVATE_NETWORK=1",
        "-e",
        "LAUNCHPAD_ROUTER_DATA_LISTEN=0.0.0.0:8080",
        "-e",
        "LAUNCHPAD_APPS_PROXY_URL=http://dokku:80",
    ];
    const init = await docker(
        [
            "run",
            "--rm",
            "-i",
            "-v",
            `${stateVolume}:/state`,
            ...routerEnv,
            r.images.router,
            "init",
            "--token-stdin",
        ],
        false,
        `${routerToken}\n`,
    );
    const epoch = init.out;
    if (!/^[0-9a-f-]{36}$/.test(epoch)) throw new Error("The router init did not print an epoch.");
    await writeFile(`${dir}/credentials/router-token`, `${routerToken}\n`, { mode: 0o600 });
    await writeFile(`${dir}/credentials/router-epoch`, `${epoch}\n`, { mode: 0o600 });
    await docker([
        "run",
        "-d",
        "--name",
        r.containers.router,
        "--network",
        r.network,
        "--network-alias",
        "router",
        "-v",
        `${stateVolume}:/state`,
        ...routerEnv,
        r.images.router,
    ]);
    for (let i = 0, healthy = false; !healthy; i++) {
        if (i >= 60) throw new Error("The router did not become healthy.");
        healthy =
            (
                await docker(
                    ["exec", r.containers.router, "bun", "dist/index.js", "healthcheck"],
                    true,
                )
            ).code === 0;
        if (!healthy) await Bun.sleep(500);
    }

    const sharedWorker = [
        `DATABASE_URL=postgres://launchpad:${dbPassword}@postgres:5432/launchpad`,
        "LAUNCHPAD_DATA_DIR=/data",
        `LAUNCHPAD_BASE_URL=${BASE_URL}`,
        `LAUNCHPAD_APPS_DOMAIN=${APPS_DOMAIN}`,
        "LAUNCHPAD_DEPLOYMENTS=on",
        "LAUNCHPAD_ALIASES=on",
        "LAUNCHPAD_MAX_ALIASES_PER_APP=12",
        "LAUNCHPAD_MAX_DEPLOYMENTS_PER_APP=20",
    ];
    await writeFile(
        `${dir}/worker.env`,
        [
            ...sharedWorker,
            "LAUNCHPAD_APPS_PROXY_URL=http://dokku:80",
            "DOKKU_SSH_HOST=dokku",
            "DOKKU_SSH_KEY_PATH=/credentials/id_ed25519",
            "DOKKU_SSH_KNOWN_HOSTS_PATH=/credentials/known_hosts",
            `LAUNCHPAD_ALIAS_INSTANCE_ID=${instanceId}`,
            // The control client accepts plain HTTP only on loopback: workers share the proxy's
            // network namespace, so 127.0.0.1:8082 is the fault proxy in front of the router.
            "LAUNCHPAD_ALIAS_CONTROL_URL=http://127.0.0.1:8082",
            "LAUNCHPAD_ALIAS_PROBE_URL=http://router:8080",
            "LAUNCHPAD_ALIAS_CONTROL_TOKEN_FILE=/credentials/router-token",
            "LAUNCHPAD_ALIAS_ROUTER_EPOCH_FILE=/credentials/router-epoch",
            "",
        ].join("\n"),
        { mode: 0o600 },
    );
    await writeFile(
        `${dir}/controller.env`,
        [
            ...sharedWorker,
            `LAUNCHPAD_AUTH_SECRET=${randomHex(32)}`,
            "HOST=0.0.0.0",
            "PORT=3000",
            "NODE_ENV=production",
            "",
        ].join("\n"),
        { mode: 0o600 },
    );
    // Chown only the fresh directories and files created above.
    await docker([
        "run",
        "--rm",
        "--user",
        "0",
        "--entrypoint",
        "sh",
        "-v",
        `${dir}:/experiment`,
        r.images.worker,
        "-c",
        "chown -R 10001:10001 /experiment/credentials /experiment/data",
    ]);

    await docker([
        "run",
        "-d",
        "--name",
        r.containers.proxy,
        "--network",
        r.network,
        "--entrypoint",
        "bun",
        "-v",
        `${source}:/source:ro`,
        r.images.worker,
        "/source/proxy.ts",
    ]);
    for (let i = 0, ready = false; !ready; i++) {
        if (i >= 60) throw new Error("The control proxy did not become ready.");
        const logs = await docker(["logs", r.containers.proxy], true);
        ready = `${logs.out}\n${logs.err}`.includes("control-proxy ready");
        if (!ready) await Bun.sleep(500);
    }

    const adminEnv = ["--env-file", `${dir}/controller.env`];
    const migrate = await docker([
        "run",
        "--rm",
        "--network",
        r.network,
        ...adminEnv,
        "--entrypoint",
        "bun",
        r.images.controller,
        ".output/admin.mjs",
        "migrate",
    ]);
    for (const [email, name, password] of [
        ["operator@example.com", "Operator", operatorPassword],
        ["ann@example.com", "Ann", annPassword],
    ] as const) {
        const args =
            name === "Operator"
                ? ["setup", "--email", email, "--name", name]
                : ["create-user", "--email", email, "--name", name];
        const result = await docker(
            [
                "run",
                "--rm",
                "-i",
                "--network",
                r.network,
                ...adminEnv,
                "--entrypoint",
                "bun",
                r.images.controller,
                ".output/admin.mjs",
                ...args,
            ],
            true,
            `${password}\n`,
        );
        if (result.code)
            throw new Error(`${args[0]} failed: ${result.err.replaceAll(password, "")}`);
    }
    await docker([
        "run",
        "-d",
        "--name",
        r.containers.controller,
        "--network",
        r.network,
        "--network-alias",
        "controller",
        ...adminEnv,
        "-v",
        `${dir}/data:/data`,
        r.images.controller,
    ]);
    const socketGroup = (await command(["stat", "-c", "%g", "/var/run/docker.sock"])).out;

    world = await buildWorld({
        migrateOutput: migrate.out,
        operator: { email: "operator@example.com", password: operatorPassword },
        ann: { email: "ann@example.com", password: annPassword },
        socketGroup,
        epoch,
        routerToken,
        instanceId,
    });
    await runScenarios(world, evidence, rounds);
} catch (error) {
    failure = error;
    await record("Write failure.log", () => writeFile(`${dir}/failure.log`, String(error)));
    console.error(String(error));
} finally {
    await record("Write evidence.json", () =>
        writeFile(`${dir}/evidence.json`, JSON.stringify(evidence, null, 2)),
    );
    // No worker may dispatch another effect while we take inventory and sweep fixtures.
    for (const name of [r.containers.worker1, r.containers.worker2]) {
        await cleanupDocker(["unpause", name]); // A failed scenario may have left worker 1 paused.
    }
    const worker1Gone = await removeVolumeFree(r.containers.worker1);
    const worker2Gone = await removeVolumeFree(r.containers.worker2);
    const settled = worker1Gone && worker2Gone;
    const builtWorld = world;
    if (builtWorld) await record("Write proxy-log.json", () => builtWorld.finish());
    const dokkuLog = await cleanupDocker(["logs", r.containers.dokku]);
    await record("Write dokku.log", () =>
        writeFile(`${dir}/dokku.log`, `${dokkuLog.out}\n${dokkuLog.err}`),
    );

    // Names the product chose: those recorded as they were reported, plus whatever this run's own
    // database still holds. Only the product's fixed name shapes are ever acted on.
    const fromDatabase = await cleanupDocker([
        "exec",
        r.containers.postgres,
        "psql",
        "-U",
        "launchpad",
        "-d",
        "launchpad",
        "-At",
        "-F",
        " ",
        "-c",
        "select id, app_name from deployment",
    ]);
    if (world && fromDatabase.code) cleanupFailed("Read fixture inventory from PostgreSQL");
    const known = new Map(r.discovered.map((entry) => [entry.deploymentId, entry]));
    if (!fromDatabase.code) {
        for (const line of fromDatabase.out.split("\n").filter(Boolean)) {
            const [deploymentId, app] = line.split(" ");
            if (deploymentId && app && !known.has(deploymentId)) {
                const imageTag = `launchpad/site:${deploymentId.replaceAll("-", "")}`;
                known.set(deploymentId, { deploymentId, app, imageTag });
            }
        }
    }
    const fixtures = [...known.values()].filter(
        (entry) => NAME.app.test(entry.app) && NAME.tag.test(entry.imageTag),
    );
    if (!settled) cleanupFailed("Fixture sweep skipped: worker absence not confirmed");
    for (const fixture of settled ? fixtures : []) {
        const destroyed = await cleanupDocker([
            "exec",
            r.containers.dokku,
            "dokku",
            "--force",
            "apps:destroy",
            fixture.app,
        ]);
        cleanup.push(
            `app ${fixture.app}: ${destroyed.code === 0 ? "destroyed" : "not destroyed (already absent or unreachable)"}`,
        );
        const leftover = await cleanupDocker([
            "ps",
            "-aq",
            "--filter",
            `label=com.dokku.app-name=${fixture.app}`,
        ]);
        if (leftover.code) cleanupFailed(`List fixture containers for ${fixture.app}`);
        for (const container of leftover.out.split("\n").filter(Boolean)) {
            await cleanupDocker(["rm", "-f", "-v", container]);
        }
        const images = await cleanupDocker([
            "image",
            "ls",
            "--format",
            "{{.Repository}}:{{.Tag}}",
            "--filter",
            `reference=dokku/${fixture.app}`,
        ]);
        if (images.code) cleanupFailed(`List fixture images for ${fixture.app}`);
        for (const tag of images.out.split("\n").filter(Boolean)) {
            if (tag.startsWith(`dokku/${fixture.app}:`)) await cleanupDocker(["rmi", tag]);
        }
        await cleanupDocker(["rmi", fixture.imageTag]);
    }
    for (const fixture of fixtures) {
        const containers = await cleanupDocker([
            "ps",
            "-aq",
            "--filter",
            `label=com.dokku.app-name=${fixture.app}`,
        ]);
        const dokkuImages = await cleanupDocker([
            "image",
            "ls",
            "-q",
            "--filter",
            `reference=dokku/${fixture.app}`,
        ]);
        const source = await cleanupDocker(["image", "inspect", fixture.imageTag]);
        const absent =
            settled &&
            !containers.code &&
            !dokkuImages.code &&
            !containers.out &&
            !dokkuImages.out &&
            confirmedAbsent(source);
        cleanup.push(
            `fixture ${fixture.app}: ${absent ? "containers and image tags absent" : "LEFTOVER OR UNVERIFIED"}`,
        );
        if (!absent) failure ??= new Error("Fixture cleanup incomplete.");
    }

    for (const name of [
        r.containers.controller,
        r.containers.proxy,
        r.containers.router,
        r.containers.postgres,
        r.containers.dokku,
    ]) {
        await removeVolumeFree(name);
    }
    // Secrets and state, removed while the worker image (root helper) still exists.
    for (const name of secretPaths) {
        await rm(`${dir}/${name}`, { recursive: true, force: true }).catch(() => undefined);
    }
    const removed = await cleanupDocker([
        "run",
        "--rm",
        "--pull=never",
        "--user",
        "0",
        "--entrypoint",
        "rm",
        "-v",
        `${dir}:/experiment`,
        r.images.worker,
        "-rf",
        ...secretPaths.map((name) => `/experiment/${name}`),
    ]);
    if (removed.code) {
        cleanup.push("secret/state removal helper: FAILED");
        failure ??= new Error("Secret/state removal helper failed.");
    }
    for (const name of secretPaths) {
        const absent = await lstat(`${dir}/${name}`).then(
            () => false,
            (error: NodeJS.ErrnoException) => error.code === "ENOENT",
        );
        cleanup.push(`secret/state path ${name}: ${absent ? "absent" : "LEFTOVER"}`);
        if (!absent) failure ??= new Error("Secret/state cleanup incomplete; see cleanup.log.");
    }
    // Include the last helper, which was registered by the secret/state removal above.
    for (const name of r.helpers) {
        await cleanupDocker(["rm", "-f", "-v", name]);
        const absent = confirmedAbsent(await cleanupDocker(["container", "inspect", name]));
        cleanup.push(`helper ${name}: ${absent ? "absent" : "LEFTOVER OR UNVERIFIED"}`);
        if (!absent) failure ??= new Error("Helper cleanup incomplete.");
    }
    await cleanupDocker(["network", "rm", r.network]);
    for (const volume of r.volumes) {
        await cleanupDocker(["volume", "rm", "-f", volume]);
        const absent = confirmedAbsent(await cleanupDocker(["volume", "inspect", volume]));
        cleanup.push(`volume ${volume}: ${absent ? "absent" : "LEFTOVER OR UNVERIFIED"}`);
        if (!absent) failure ??= new Error("Volume cleanup incomplete.");
    }
    for (const image of Object.values(r.images)) await cleanupDocker(["rmi", image]);
    for (const [kind, name] of [
        ["network", r.network],
        ...Object.values(r.images).map((image) => ["image", image] as const),
    ] as const) {
        const absent = confirmedAbsent(await cleanupDocker([kind, "inspect", name]));
        cleanup.push(`${kind} ${name}: ${absent ? "absent" : "LEFTOVER OR UNVERIFIED"}`);
        if (!absent) failure ??= new Error("Network/image cleanup incomplete.");
    }
    await record("Write cleanup.log", () => writeFile(`${dir}/cleanup.log`, cleanup.join("\n")));
    console.log(cleanup.join("\n"));
    console.log(`Evidence directory: ${dir}`);
}
if (failure) throw failure;
if (evidence.some((entry) => entry.result !== "pass")) {
    throw new Error("A scenario failed; see evidence.json.");
}

async function buildWorld(input: {
    migrateOutput: string;
    operator: { email: string; password: string };
    ann: { email: string; password: string };
    socketGroup: string;
    epoch: string;
    routerToken: string;
    instanceId: string;
}): Promise<World> {
    const { buildWorld: build } = await import("./world");
    return build({
        r,
        dir,
        docker,
        persist,
        baseUrl: BASE_URL,
        appsDomain: APPS_DOMAIN,
        ...input,
    });
}
