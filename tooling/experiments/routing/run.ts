import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { verifyFaultTransport } from "./fault-proxy";

// This task is opt-in, never a dependency of a default check or CI. By default it runs the
// accepted prototype-router experiment; LAUNCHPAD_ROUTING_REHEARSAL=1 runs the same scenarios against
// the production router image (apps/router) instead.
const rehearsal = process.env.LAUNCHPAD_ROUTING_REHEARSAL === "1";
if (!rehearsal && process.env.LAUNCHPAD_ROUTING_EXPERIMENT !== "1") {
    throw new Error(
        "Set LAUNCHPAD_ROUTING_EXPERIMENT=1 (prototype) or LAUNCHPAD_ROUTING_REHEARSAL=1 (production " +
            "router image) to authorize disposable Docker checks.",
    );
}
await verifyFaultTransport();
if (process.env.LAUNCHPAD_ROUTING_TRANSPORT_ONLY === "1") process.exit(0);
const root = process.cwd();
await mkdir("/tmp/opencode", { recursive: true });
const dir = await mkdtemp(`/tmp/opencode/${rehearsal ? "lp-rehearsal" : "lp-routing"}-`);
// Containers need traversal to the explicitly mounted fixture files; secret files stay 0600.
await chmod(dir, 0o755);
const id = path.basename(dir).toLowerCase();
const resources = {
    dir,
    network: `${id}-net`,
    dokku: `${id}-dokku`,
    worker: `${id}-worker`,
    router: `${id}-router`,
    upstream: `${id}-upstream`,
    ingress: `${id}-ingress`,
    routerTls: `${id}-router-tls`,
    faultProxy: `${id}-fault-proxy`,
    image: `${id}/worker:test`,
    routerImage: `${id}/router:test`,
    volumes: [] as string[],
    apps: Array.from({ length: 2 }, () => `lp-test-${randomBytes(3).toString("hex")}`),
    helpers: [] as string[],
};
await writeFile(`${dir}/resources.json`, JSON.stringify(resources, null, 2));
console.log(`Resources recorded before creation: ${dir}/resources.json`);

// Docker commands never inherit the repository's .env.local or production settings.
async function command(args: string[], allowFailure = false, stdin?: string) {
    const p = Bun.spawn(args, {
        env: { PATH: process.env.PATH!, HOME: process.env.HOME!, DOCKER_BUILDKIT: "1" },
        stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
        stdout: "pipe",
        stderr: "pipe",
    });
    const deadline = setTimeout(() => p.kill("SIGKILL"), 900_000);
    const [out, err, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited.finally(() => clearTimeout(deadline)),
    ]);
    if (code && !allowFailure) throw new Error(`${args.slice(0, 3).join(" ")}: ${err}`);
    return { out: out.trim(), err: err.trim(), code };
}
const docker = async (args: string[], allowFailure = false, stdin?: string) => {
    if (args[0] === "run") {
        args = [...args];
        if (!args.includes("--name")) {
            const name = `${id}-helper-${resources.helpers.length + 1}`;
            resources.helpers.push(name);
            await writeFile(`${dir}/resources.json`, JSON.stringify(resources, null, 2));
            args.splice(1, 0, "--name", name);
        }
        // The worker base declares VOLUME /data. Helpers/router need no anonymous
        // volume: use tmpfs unless this invocation explicitly binds its artifact data.
        if (args.includes(resources.image) && !args.some((arg) => arg.includes(":/data"))) {
            args.splice(1, 0, "--tmpfs", "/data");
        }
    }
    return command(["docker", ...args], allowFailure, stdin);
};
const cleanup: string[] = [];
// "Absent" only when Docker says so. A failed inspection (the engine unreachable, say) proves nothing.
// Matched on the resource-specific diagnostics: a lost daemon socket also says "no such file or
// directory", which must never read as "the resource is gone".
const NOT_FOUND = /\bno such (container|image|network|volume|object)\b|\bnetwork \S+ not found\b/i;
const confirmedAbsent = (result: { code: number; err: string }) =>
    result.code !== 0 && NOT_FOUND.test(result.err);
let failure: unknown;
try {
    for (const app of resources.apps) {
        const existing = await docker(["ps", "-aq", "--filter", `label=com.dokku.app-name=${app}`]);
        const image = await docker(["image", "inspect", `dokku/${app}:latest`], true);
        if (existing.out || !image.code)
            throw new Error("Generated app name collides with existing engine resources.");
    }
    await mkdir(`${dir}/credentials`);
    await mkdir(`${dir}/data`);
    await mkdir(`${dir}/dokku`);
    await mkdir(`${dir}/router-state`);
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
    await command([
        "bun",
        "build",
        "--target=bun",
        `${root}/tooling/experiments/routing/fixtures.ts`,
        "--outfile",
        `${dir}/fixtures.js`,
    ]);
    await docker(["network", "create", resources.network]);
    await docker(["build", "-q", "-f", "apps/worker/Dockerfile", "-t", resources.image, "."]);
    if (rehearsal) {
        await docker([
            "build",
            "-q",
            "-f",
            "apps/router/Dockerfile",
            "-t",
            resources.routerImage,
            ".",
        ]);
    }
    await docker([
        "run",
        "-d",
        "--name",
        resources.dokku,
        "--network",
        "bridge",
        "--label",
        `launchpad.experiment=${id}`,
        "-e",
        "DOKKU_HOSTNAME=live.example.com",
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
    await docker(["network", "connect", "--alias", "dokku", resources.network, resources.dokku]);
    // Bounded readiness, not a fixed startup delay.
    let ready = false;
    let lastReadiness = "";
    for (let attempt = 0; attempt < 90; attempt++) {
        const check = await docker(
            [
                "exec",
                resources.dokku,
                "sh",
                "-c",
                "test -s /etc/ssh/ssh_host_ed25519_key.pub || { ls -l /etc/ssh; exit 1; }; dokku version",
            ],
            true,
        );
        lastReadiness = `${check.out}\n${check.err}`;
        if (!check.code) {
            ready = true;
            break;
        }
        await Bun.sleep(1000);
    }
    if (!ready) throw new Error(`Disposable Dokku did not initialize: ${lastReadiness}`);
    // Pin via the container's local public key, not an unauthenticated network scan.
    const hostKey = (
        await docker(["exec", resources.dokku, "cat", "/etc/ssh/ssh_host_ed25519_key.pub"])
    ).out;
    await writeFile(`${dir}/credentials/known_hosts`, `dokku ${hostKey}\n`, { mode: 0o600 });
    const publicKey = await readFile(`${dir}/credentials/id_ed25519.pub`, "utf8");
    await docker(["exec", "-i", resources.dokku, "dokku", "ssh-keys:add", id], false, publicKey);
    // Chown only fresh directories created above; never existing user data.
    await docker([
        "run",
        "--rm",
        "--user",
        "0",
        "--entrypoint",
        "sh",
        "-v",
        `${dir}/credentials:/credentials`,
        "-v",
        `${dir}/data:/data`,
        "-v",
        `${dir}/router-state:/state`,
        resources.image,
        "-c",
        "chown -R 10001:10001 /credentials /data /state",
    ]);
    const socketGroup = (await command(["stat", "-c", "%g", "/var/run/docker.sock"])).out;
    await docker([
        "run",
        "-d",
        "--name",
        resources.worker,
        "--network",
        resources.network,
        "--group-add",
        socketGroup,
        "--entrypoint",
        "sleep",
        "-v",
        "/var/run/docker.sock:/var/run/docker.sock",
        "-v",
        `${dir}/credentials:/credentials:ro`,
        "-v",
        `${dir}/data:/data`,
        "-v",
        `${dir}:/experiment:ro`,
        resources.image,
        "infinity",
    ]);
    const fixtureResult = await docker([
        "exec",
        resources.worker,
        "bun",
        "/experiment/fixtures.js",
    ]);
    console.log(fixtureResult.out);
    await writeFile(`${dir}/topology.log`, fixtureResult.out);
    console.log(`Topology fixtures passed; evidence: ${dir}/data/fixtures.json`);
    // Router experiment is a separate process using the same recorded fixture inventory.
    if (rehearsal) {
        const production = await import("./verify-production");
        await production.verifyProduction({ dir, resources, docker, command });
    } else {
        const routerExperiment = await import("./verify-router");
        await routerExperiment.verifyRouter({ dir, resources, docker });
    }
} catch (error) {
    failure = error;
    await writeFile(`${dir}/failure.log`, String(error));
    console.error(String(error));
} finally {
    const dokkuLog = await docker(["logs", resources.dokku], true);
    await writeFile(`${dir}/dokku.log`, `${dokkuLog.out}\n${dokkuLog.err}`);
    // The journal is read once and validated: only entries for apps this run recorded, with the
    // image tag derived from their own deployment ID, are ever used. Only a missing journal is
    // "nothing created"; an unreadable one is reported, and the apps recorded before creation
    // (exact random names, safe to destroy when absent) are still cleaned up.
    let journalTrusted = true;
    const created: { app: string; deploymentId: string; imageTag: string }[] = [];
    try {
        const text = await readFile(`${dir}/data/created-apps.json`, "utf8").catch(
            (error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return "[]";
                throw error;
            },
        );
        for (const entry of JSON.parse(text) as typeof created) {
            const expectedTag = `launchpad/site:${String(entry.deploymentId).replaceAll("-", "")}`;
            if (resources.apps.includes(entry.app) && entry.imageTag === expectedTag) {
                created.push(entry);
            } else {
                // Not usable, and not to be trusted: fall back to the names recorded before
                // creation, without ever passing the rejected tag to Docker.
                journalTrusted = false;
                failure ??= new Error("Cleanup journal contains an entry this run did not make.");
            }
        }
    } catch (error) {
        journalTrusted = false;
        failure ??= new Error(`The cleanup journal is unreadable: ${String(error)}`);
    }
    for (const app of journalTrusted ? created.map((entry) => entry.app) : resources.apps) {
        // Only the random exact names recorded before this run; apps:destroy is safe if absent.
        const result = await docker(
            ["exec", resources.dokku, "dokku", "--force", "apps:destroy", app],
            true,
        );
        cleanup.push(`app ${app}: ${result.code === 0 ? "destroyed" : result.err}`);
        const inspect = await docker(["image", "inspect", `dokku/${app}:latest`], true);
        if (!inspect.code) await docker(["rmi", `dokku/${app}:latest`], true);
    }
    // Source tags may survive a failed build/load; names come only from this run's validated journal.
    const verified: { app: string; imageTag?: string }[] = journalTrusted
        ? created
        : resources.apps.map((app) => ({ app }));
    for (const fixture of verified) {
        if (fixture.imageTag) await docker(["rmi", fixture.imageTag], true);
        const containers = await docker([
            "ps",
            "-aq",
            "--filter",
            `label=com.dokku.app-name=${fixture.app}`,
        ]);
        const image = await docker(["image", "inspect", `dokku/${fixture.app}:latest`], true);
        const source = fixture.imageTag
            ? await docker(["image", "inspect", fixture.imageTag], true)
            : { code: 1, err: "No such image" };
        const absent = !containers.out && confirmedAbsent(image) && confirmedAbsent(source);
        cleanup.push(
            `fixture ${fixture.app}: ${absent ? "containers and image tags absent" : "LEFTOVER OR UNVERIFIED"}`,
        );
        if (!absent) failure ??= new Error("Fixture cleanup incomplete.");
    }
    for (const name of [
        resources.faultProxy,
        resources.routerTls,
        resources.ingress,
        resources.upstream,
        resources.router,
        resources.worker,
        resources.dokku,
    ]) {
        await docker(["rm", "-f", "-v", name], true);
        const absent = confirmedAbsent(await docker(["inspect", name], true));
        cleanup.push(`container ${name}: ${absent ? "absent" : "LEFTOVER OR UNVERIFIED"}`);
        if (!absent) failure ??= new Error("Container cleanup incomplete.");
    }
    await docker(["network", "rm", resources.network], true);
    for (const volume of resources.volumes) {
        await docker(["volume", "rm", "-f", volume], true);
        const absent = confirmedAbsent(await docker(["volume", "inspect", volume], true));
        cleanup.push(`volume ${volume}: ${absent ? "absent" : "LEFTOVER OR UNVERIFIED"}`);
        if (!absent) failure ??= new Error("Volume cleanup incomplete.");
    }
    // Use the image we already built, before removing it. A failed helper must not
    // skip the cleanup report or replace the original experiment failure.
    const secretPaths = [
        "credentials",
        "dokku",
        "router-state",
        "old-router-state",
        "tls",
        "router-config.json",
        "router-config.next",
        "rehearsal-config.json",
        "rehearsal-config.next",
    ];
    // Host-owned paths (an ssh key made before the image existed, say) are removed directly: the
    // helper below needs the worker image, which may never have been built. Paths handed to the
    // container user are left to it.
    for (const name of secretPaths) {
        await rm(`${dir}/${name}`, { recursive: true, force: true }).catch(() => undefined);
    }
    const removed = await docker(
        [
            "run",
            "--rm",
            "--pull=never",
            "--user",
            "0",
            "--entrypoint",
            "rm",
            "-v",
            `${dir}:/experiment`,
            resources.image,
            "-rf",
            ...secretPaths.map((name) => `/experiment/${name}`),
        ],
        true,
    );
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
    await docker(["rmi", resources.image], true);
    await docker(["rmi", resources.routerImage], true);
    for (const [kind, name] of [
        ["network", resources.network],
        ["image", resources.image],
        ...(rehearsal ? [["image", resources.routerImage]] : []),
    ]) {
        const absent = confirmedAbsent(await docker([kind!, "inspect", name!], true));
        cleanup.push(`${kind} ${name}: ${absent ? "absent" : "LEFTOVER OR UNVERIFIED"}`);
        if (!absent) failure ??= new Error("Network/image cleanup incomplete.");
    }
    for (const name of resources.helpers) {
        const absent = confirmedAbsent(await docker(["inspect", name], true));
        cleanup.push(`helper ${name}: ${absent ? "absent" : "LEFTOVER OR UNVERIFIED"}`);
        if (!absent) failure ??= new Error("Helper cleanup incomplete.");
    }
    await writeFile(`${dir}/cleanup.log`, cleanup.join("\n"));
    console.log(cleanup.join("\n"));
    console.log(`Evidence directory: ${dir}`);
}
if (failure) throw failure;
