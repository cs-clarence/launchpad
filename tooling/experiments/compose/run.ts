import { randomBytes } from "node:crypto";
import { chmod, mkdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo, type Server } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { confirmedAbsent, dokkuIdle } from "../acceptance/harness";
import { fixtureDocker } from "./docker";
import { planFixture } from "./fixture";
import { fixtureDeploymentGone, readInventory, type Deployment } from "./inventory";
import { aliasScenario } from "./scenario";
import { capacityScenario, parseStats, peaks, type Sample } from "./capacity";
import { controlProbePassed, controlProbes, safeProbeOutcome } from "./tls-probe";

if (Bun.env.LAUNCHPAD_COMPOSE_REHEARSAL !== "1")
    throw new Error("Set LAUNCHPAD_COMPOSE_REHEARSAL=1 only on a disposable, trusted Docker host.");

const root = "/tmp/opencode";
await mkdir(root, { recursive: true, mode: 0o700 });
if ((await realpath(root)) !== root) throw new Error("The fixture parent must not be a symlink.");
const socket = await stat("/var/run/docker.sock");
if (!socket.isSocket()) throw new Error("The local Docker socket is required.");
const random = (bytes: number) => randomBytes(bytes).toString("hex");
const abort = new AbortController();
const stop = () => abort.abort();
process.on("SIGINT", stop).on("SIGTERM", stop);

async function candidatePorts() {
    const sockets: Server[] = [];
    try {
        for (let i = 0; i < 5; i++) {
            const server = createServer();
            sockets.push(server);
            await new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(0, "127.0.0.1", resolve);
            });
        }
        return sockets.map((server) => (server.address() as AddressInfo).port);
    } finally {
        await Promise.all(
            sockets.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
        );
    }
}

const plan = planFixture(random(12), await candidatePorts(), socket.gid);
// Opt-in hardening experiment: a read-only root filesystem with a small /tmp for the
// application services. Everything else about the baseline is unchanged.
const readOnly = Bun.env.LAUNCHPAD_COMPOSE_READ_ONLY === "1";
if (readOnly) {
    const services = plan.override.services as Record<string, Record<string, unknown>>;
    for (const name of ["controller", "worker", "router", "admin"])
        services[name] = { ...services[name], read_only: true, tmpfs: ["/tmp:size=64m"] };
}
const { version } = await Bun.file(new URL("../../../package.json", import.meta.url)).json();
if (typeof version !== "string" || !/^[0-9A-Za-z.+-]+$/.test(version))
    throw new Error("Cannot determine the repository build version.");
plan.env.LAUNCHPAD_VERSION = version;
const { directory, project } = plan;
const file = (name: string) => `${directory}/${name}`;
const env = file("fixture.env");
const override = file("override.json");
const docker = fixtureDocker(plan, { env, override });
const key = plan.env.LAUNCHPAD_ROUTER_TLS_KEY_FILE!;
const cert = plan.env.LAUNCHPAD_ROUTER_TLS_CERT_FILE!;
const ca = plan.env.LAUNCHPAD_ROUTER_TLS_CA_FILE!;
const ssh = plan.env.LAUNCHPAD_DOKKU_SSH_KEY_FILE!;
const token = random(32);
const operatorPassword = random(16);
const ownerPassword = random(16);
const services = ["controller", "worker", "dokku", "postgres", "router"];
const inventory = {
    project,
    directory,
    ports: Object.fromEntries(
        Object.entries(plan.env).filter(([name]) => name.endsWith("_HOST_PORT")),
    ),
    containers: services.map((service) => `${project}-${service}-1`),
    containerIds: {} as Record<string, string>,
    images: Object.values(plan.images),
    imageIds: {} as Record<string, string>,
    source: null as { revision: string; dirty: boolean; version: string } | null,
    networks: Object.values(plan.networks),
    volumes: Object.values(plan.volumes),
    helpers: [
        "ownership",
        "cleanup",
        "init",
        "migrate",
        "status",
        "operator",
        "owner",
        "capback",
        "capverify",
    ].map((s) => `${project}-${s}`),
    deployments: [] as Deployment[],
};
const evidence: object[] = [];
const privateWrite = (name: string, value: string) => writeFile(file(name), value, { mode: 0o600 });
async function persist() {
    await privateWrite("resources.json.next", JSON.stringify(inventory, null, 2));
    await rename(file("resources.json.next"), file("resources.json"));
}
async function record(name: string, observations?: object) {
    evidence.push({ name, observations });
    await privateWrite("evidence.json", JSON.stringify(evidence, null, 2));
    console.log(`PASS ${name}`);
}
async function wait<T>(
    label: string,
    read: (remainingMs: () => number) => Promise<T | false>,
    seconds = 330,
    cleanup = false,
): Promise<T> {
    const deadline = performance.now() + seconds * 1000;
    const remainingMs = () => Math.max(1, Math.ceil(deadline - performance.now()));
    do {
        if (!cleanup) abort.signal.throwIfAborted();
        const value = await read(remainingMs);
        if (value) return value;
        await delay(
            Math.min(2000, remainingMs()),
            undefined,
            cleanup ? undefined : { signal: abort.signal },
        );
    } while (performance.now() < deadline);
    throw new Error(`Timed out waiting for ${label}.`);
}
async function requireAbsent(kind: string, name: string) {
    if (!confirmedAbsent(await docker.run([kind, "inspect", name], true)))
        throw new Error(`Could not prove ${kind} ${name} absent.`);
}
async function projectMembers(kind: "container" | "network" | "volume") {
    const args =
        kind === "container"
            ? ["ps", "-a", "--no-trunc", "--format", "{{.ID}} {{.Names}}"]
            : [kind, "ls", "--format", "{{.Name}}"];
    const { out } = await docker.run([
        ...args,
        "--filter",
        `label=com.docker.compose.project=${project}`,
    ]);
    return out ? out.split("\n") : [];
}
async function verifyNamespace() {
    const seen = new Set<string>();
    for (const member of await projectMembers("container")) {
        const [id = "", name = "", extra] = member.split(" ");
        const service = services.find((service) => name === `${project}-${service}-1`);
        if (
            !service ||
            extra !== undefined ||
            !/^[0-9a-f]{64}$/.test(id) ||
            seen.has(name) ||
            (inventory.containerIds[name] && inventory.containerIds[name] !== id)
        )
            throw new Error("Unexpected member of the Compose fixture project.");
        seen.add(name);
        const { out } = await docker.run([
            "container",
            "inspect",
            "-f",
            '{{.Id}} {{index .Config.Labels "com.docker.compose.project"}} {{index .Config.Labels "com.docker.compose.service"}} {{index .Config.Labels "com.docker.compose.oneoff"}}',
            name,
        ]);
        if (out !== `${id} ${project} ${service} False`)
            throw new Error("Compose fixture container identity no longer matches.");
        inventory.containerIds[name] = id;
    }
    for (const name of inventory.containers)
        if (!seen.has(name)) await requireAbsent("container", name);
    for (const name of inventory.helpers) await requireAbsent("container", name);
    for (const [kind, names, labels] of [
        ["network", inventory.networks, ".Labels"],
        ["volume", inventory.volumes, ".Labels"],
    ] as const) {
        if ((await projectMembers(kind)).some((name) => !names.includes(name)))
            throw new Error("Unexpected resource in the Compose fixture namespace.");
        for (const name of names) {
            const result = await docker.run(
                [kind, "inspect", "-f", `{{index ${labels} "com.docker.compose.project"}}`, name],
                true,
            );
            if (!confirmedAbsent(result) && (result.code !== 0 || result.out !== project))
                throw new Error("Fixture resource ownership could not be confirmed.");
        }
    }
    await persist();
}
async function verifyProjectGone() {
    for (const kind of ["container", "network", "volume"] as const)
        if ((await projectMembers(kind)).length)
            throw new Error("Compose left resources in the fixture namespace.");
    for (const [kind, names] of [
        ["container", [...inventory.containers, ...inventory.helpers]],
        ["network", inventory.networks],
        ["volume", inventory.volumes],
    ] as const)
        for (const name of names) await requireAbsent(kind, name);
}
async function exists(service: string, timeoutMs?: number) {
    const args = [
        "ps",
        "-aq",
        "--filter",
        `label=com.docker.compose.project=${project}`,
        "--filter",
        `label=com.docker.compose.service=${service}`,
        "--filter",
        "label=com.docker.compose.oneoff=False",
    ] satisfies ["ps", ...string[]];
    const { out } =
        timeoutMs === undefined
            ? await docker.run(args)
            : await docker.read(args, timeoutMs, abort.signal);
    if (out.includes("\n")) throw new Error("More than one matching fixture service.");
    return out;
}
async function health(service: string) {
    await wait(
        `${service} health`,
        async (remainingMs) => {
            const id = await exists(service, remainingMs());
            if (!id) return false;
            const { out } = await docker.read(
                [
                    "inspect",
                    "-f",
                    "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}",
                    id,
                ],
                remainingMs(),
                abort.signal,
            );
            if (/^(exited|dead|restarting)\b/.test(out))
                throw new Error(`Fixture ${service} exited or restarted.`);
            return out === "running healthy";
        },
        service === "dokku" ? 660 : 420,
    );
}
async function readDeployments() {
    const { out } = await docker.compose([
        "exec",
        "-T",
        "postgres",
        "psql",
        "-X",
        "-U",
        "launchpad",
        "-d",
        "launchpad",
        "-At",
        "-F",
        " ",
        "-c",
        "select id, app_name, desired_state from deployment",
    ]);
    inventory.deployments = readInventory(out, inventory.deployments);
    await persist();
}
const changeCompose = (args: string[], input?: string) => {
    abort.signal.throwIfAborted();
    return docker.compose(args, input);
};
const composeRun = (name: string, service: string, args: string[], input?: string) =>
    changeCompose(
        [
            "run",
            "--rm",
            "--no-deps",
            "--pull",
            "never",
            "-T",
            "--name",
            `${project}-${name}`,
            service,
            ...args,
        ],
        input,
    );
const exec = (service: string, ...args: string[]) =>
    docker.compose(["exec", "-T", service, ...args]);
async function command(args: string[]) {
    const p = Bun.spawn(args, {
        env: { PATH: Bun.env.PATH ?? "", HOME: Bun.env.HOME ?? "" },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
    });
    const timer = setTimeout(() => p.kill("SIGKILL"), 60_000);
    if ((await p.exited.finally(() => clearTimeout(timer))) !== 0)
        throw new Error(`${args[0]} failed in fixture preparation.`);
}
function gitOutput(args: string[]) {
    const result = Bun.spawnSync(["git", ...args], { stderr: "ignore", stdout: "pipe" });
    if (!result.success) throw new Error("Could not record the fixture source revision.");
    return result.stdout.toString().trim();
}
const fixedPaths = [
    "dokku",
    "backups",
    "tls",
    "credentials",
    "fixture.env",
    "override.json",
    "index.html",
    "site.tar.gz",
    "capacity",
];
const capacity = Bun.env.LAUNCHPAD_COMPOSE_CAPACITY === "1";
let sampler: Sample[] | undefined;
async function sampleOnce() {
    const ids = (
        await docker.run([
            "ps",
            "-q",
            "--no-trunc",
            "--filter",
            `label=com.docker.compose.project=${project}`,
        ])
    ).out
        .split("\n")
        .filter(Boolean);
    if (!ids.length) return [];
    const { out } = await docker.read(
        ["stats", "--no-stream", "--format", "{{json .}}", ...ids],
        30_000,
        abort.signal,
    );
    return parseStats(out);
}
async function measure<T>(label: string, run: () => Promise<T>) {
    sampler = [];
    const samples = sampler;
    let running = true;
    const loop = (async () => {
        while (running) {
            try {
                samples.push(...(await sampleOnce()));
            } catch {
                // A missed sample never decides a result; the scenario itself does.
            }
        }
    })();
    const started = performance.now();
    try {
        const value = await run();
        return {
            value,
            seconds: Math.round((performance.now() - started) / 100) / 10,
            peaks: peaks(samples),
        };
    } finally {
        running = false;
        await loop;
        void label;
    }
}
async function makeArchives() {
    const dir = file("capacity");
    await mkdir(dir, { mode: 0o700 });
    const build = async (name: string, script: string) => {
        await mkdir(`${dir}/${name}`, { mode: 0o700 });
        await command([
            "sh",
            "-ec",
            `cd "${dir}/${name}" && printf '<!doctype html><title>${name}</title>\\n' > index.html && ${script} && tar -czf "${dir}/${name}.tar.gz" -C "${dir}/${name}" .`,
        ]);
        return Bun.file(`${dir}/${name}.tar.gz`).arrayBuffer();
    };
    return {
        small: await Bun.file(file("site.tar.gz")).arrayBuffer(),
        "near-limit": await build("near", "head -c 44M /dev/urandom > blob.bin"),
        "expanded-limit": await build("expanded", "head -c 190M /dev/zero > zeros.bin"),
        "many-files": await build(
            "files",
            "i=0; while [ $i -lt 4500 ]; do printf x > f$i.txt; i=$((i+1)); done",
        ),
    };
}
let ready = false;
let broughtUp = false;
let activeWriters = false;
let phase = "preflight";
let failed = false;
let cleanupProgress = "No teardown verified.";

await mkdir(directory, { mode: 0o700 }); // exclusive: never reuse an existing directory
try {
    await persist();
    console.log(`Fixture inventory: ${file("resources.json")}`);
    for (const [kind, names] of [
        ["container", [...inventory.containers, ...inventory.helpers]],
        ["image", inventory.images],
        ["network", inventory.networks],
        ["volume", inventory.volumes],
    ] as const)
        for (const name of names) await requireAbsent(kind, name);
    ready = true;
    await privateWrite(
        "fixture.env",
        Object.entries(plan.env)
            .map(([k, v]) => `${k}=${v}\n`)
            .join(""),
    );
    await privateWrite("override.json", JSON.stringify(plan.override));
    await docker.validate();
    abort.signal.throwIfAborted();

    phase = "fixture preparation";
    await mkdir(file("dokku"), { mode: 0o755 });
    await chmod(file("dokku"), 0o755);
    for (const name of ["backups", "tls", "credentials"]) await mkdir(file(name), { mode: 0o700 });
    for (const name of ["epoch", "known_hosts"]) await privateWrite(`credentials/${name}`, "");
    await privateWrite("credentials/token", `${token}\n`);
    await command(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", ssh]);
    await command([
        "openssl",
        "req",
        "-new",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "2",
        "-subj",
        "/CN=Disposable Compose CA",
        "-addext",
        "basicConstraints=critical,CA:TRUE",
        "-keyout",
        file("tls/ca.key"),
        "-out",
        ca,
    ]);
    await command([
        "openssl",
        "req",
        "-new",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-subj",
        "/CN=router",
        "-keyout",
        key,
        "-out",
        file("tls/server.csr"),
    ]);
    await privateWrite(
        "tls/extensions",
        "subjectAltName=DNS:router\nextendedKeyUsage=serverAuth\n",
    );
    await command([
        "openssl",
        "x509",
        "-req",
        "-days",
        "2",
        "-in",
        file("tls/server.csr"),
        "-CA",
        ca,
        "-CAkey",
        file("tls/ca.key"),
        "-CAcreateserial",
        "-extfile",
        file("tls/extensions"),
        "-out",
        cert,
    ]);
    await rm(file("tls/ca.key"));
    await Promise.all([chmod(ca, 0o644), chmod(cert, 0o644)]);
    await privateWrite("index.html", "<!doctype html><title>Compose fixture</title>\n");
    await command(["tar", "-czf", file("site.tar.gz"), "-C", directory, "index.html"]);

    phase = "image build";
    abort.signal.throwIfAborted();
    const { out: builder } = await docker.run(["buildx", "inspect", "default"]);
    if (
        !/^Driver:\s+docker$/m.test(builder) ||
        [...builder.matchAll(/^Endpoint:\s+(\S+)$/gm)].map((match) => match[1]).join() !==
            "default" ||
        !/^Status:\s+running$/m.test(builder)
    )
        throw new Error("Fixture builds require the local default Docker builder.");
    inventory.source = {
        revision: gitOutput(["rev-parse", "HEAD"]),
        dirty: Boolean(gitOutput(["status", "--porcelain", "--untracked-files=normal"])),
        version,
    };
    await persist();
    await changeCompose(["--profile", "admin", "build", "--builder", "default"]);
    for (const image of inventory.images) {
        const { out } = await docker.run(["image", "inspect", "-f", "{{.Id}}", image]);
        if (!/^sha256:[a-f0-9]{64}$/.test(out))
            throw new Error("Fixture image was not built locally.");
        inventory.imageIds[image] = out;
    }
    await persist();
    await record("Fixture images built under unique tags", {
        source: inventory.source,
        images: inventory.imageIds,
    });
    phase = "bootstrap";
    abort.signal.throwIfAborted();
    broughtUp = true;
    await changeCompose(["up", "-d", "--no-build", "postgres", "dokku"]);
    await verifyNamespace();
    await health("postgres");
    await health("dokku");
    await changeCompose([
        "exec",
        "-T",
        "dokku",
        "dokku",
        "network:set",
        "--global",
        "initial-network",
        plan.networks.apps!,
    ]);
    const { out: hostKey } = await exec("dokku", "cat", "/etc/ssh/ssh_host_ed25519_key.pub");
    if (!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/.test(hostKey))
        throw new Error("Unexpected fixture Dokku host key.");
    await privateWrite("credentials/known_hosts", `dokku ${hostKey}\n`);
    await changeCompose(
        ["exec", "-T", "dokku", "dokku", "ssh-keys:add", "launchpad-worker"],
        await Bun.file(`${ssh}.pub`).text(),
    );
    const { out: epoch } = await composeRun(
        "init",
        "router",
        ["init", "--token-stdin"],
        `${token}\n`,
    );
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(epoch))
        throw new Error("Unexpected fixture router epoch.");
    await privateWrite("credentials/epoch", `${epoch}\n`);
    abort.signal.throwIfAborted();
    await docker.run([
        "run",
        "--rm",
        "--name",
        `${project}-ownership`,
        "--network",
        "none",
        "-v",
        `${directory}:/fixture`,
        "--user",
        "0",
        "--entrypoint",
        "chown",
        plan.images.worker!,
        "10001:10001",
        ...[
            "tls/server.key",
            "credentials/id_ed25519",
            "credentials/token",
            "credentials/epoch",
            "credentials/known_hosts",
            "backups",
        ].map((name) => `/fixture/${name}`),
    ]);
    await composeRun("migrate", "admin", ["migrate"]);
    if (!/^pending: 0$/m.test((await composeRun("status", "admin", ["migrate", "--status"])).out))
        throw new Error("Fixture migrations are pending.");
    await composeRun(
        "operator",
        "admin",
        ["setup", "--email", "operator@example.net"],
        `${operatorPassword}\n`,
    );
    await composeRun(
        "owner",
        "admin",
        ["create-user", "--email", "owner@example.net"],
        `${ownerPassword}\n`,
    );
    abort.signal.throwIfAborted();
    activeWriters = true;
    await changeCompose(["up", "-d", "--no-build", "--pull", "never"]);
    await verifyNamespace();
    for (const name of ["controller", "router", "worker"]) await health(name);
    await record("Aliases-on services healthy after explicit operator bootstrap", { readOnly });

    phase = "TLS verification";
    for (const [mode, url] of controlProbes) {
        const { out } = await exec(
            "router",
            "bun",
            "-e",
            `
            const [mode,url] = process.argv.slice(1);
            const ca = await Bun.file('/tls/control-ca.pem').text();
            const response = await fetch(url, { signal: AbortSignal.timeout(4000), redirect: 'error',
                ...(mode === 'untrusted' ? {} : { tls: { ca, rejectUnauthorized: true } }) })
                .catch(error => error);
            if (response instanceof Response) console.log(response.status);
            else console.log(response.code ?? response.name);
        `,
            "--",
            mode,
            url,
        );
        const outcome = safeProbeOutcome(out);
        if (!controlProbePassed(mode, out)) {
            phase = `TLS verification (${mode}: ${outcome})`;
            throw new Error("Unexpected TLS probe outcome.");
        }
        await record(`Control probe ${mode}`, { outcome });
    }
    await record("Private HTTPS verified; untrusted CA, wrong name and plaintext refused");
    phase = "alias flow";
    await aliasScenario({
        plan,
        operatorPassword,
        ownerPassword,
        archive: await Bun.file(file("site.tar.gz")).arrayBuffer(),
        signal: abort.signal,
        wait,
        record,
        inventory: readDeployments,
        extra: capacity
            ? async (context) => {
                  phase = "capacity measurements";
                  await capacityScenario({
                      plan,
                      context,
                      archives: await makeArchives(),
                      measure,
                      backup: async () => {
                          const started = performance.now();
                          await composeRun("capback", "admin", ["backup", "/backups/capacity"]);
                          await composeRun("capverify", "admin", [
                              "verify-backup",
                              "/backups/capacity",
                          ]);
                          return Math.round((performance.now() - started) / 100) / 10;
                      },
                  });
              }
            : undefined,
    });
} catch {
    failed = true;
    await privateWrite(
        "failure.log",
        `Fixture failed in ${phase}. Command output is not retained.\n`,
    );
    console.error(`Fixture failed in ${phase}; see ${file("failure.log")}.`);
} finally {
    // Ignore a second ordinary signal while verifying/cleaning the fixture.
    const cleanup = async () => {
        if (docker.uncertain()) throw new Error("Docker operation may still be running.");
        if (broughtUp) await verifyNamespace();
        if (activeWriters) {
            for (const name of ["worker", "controller"]) {
                const id = await exists(name);
                if (id) {
                    const recorded = inventory.containerIds[`${project}-${name}-1`];
                    if (!recorded || !recorded.startsWith(id))
                        throw new Error("Unidentified fixture writer.");
                    await docker.run(["stop", "--time", "30", recorded]);
                    if (
                        (await docker.run(["inspect", "-f", "{{.State.Status}}", recorded])).out !==
                        "exited"
                    )
                        throw new Error("Fixture writer did not stop.");
                }
            }
            cleanupProgress = "Fixture writers verified stopped.";
            await readDeployments();
            const id = await exists("dokku");
            await wait(
                "Dokku settlement",
                async (remainingMs) =>
                    !!id &&
                    dokkuIdle(
                        await docker.read(["top", id, "-eo", "pid,comm,args"], remainingMs()),
                    ),
                310,
                true,
            );
            for (const deployment of inventory.deployments) {
                const app = await docker.run(
                    ["exec", id, "dokku", "apps:exists", deployment.app],
                    true,
                );
                const containers = await docker.run([
                    "ps",
                    "-aq",
                    "--filter",
                    `label=com.dokku.app-name=${deployment.app}`,
                ]);
                const images = await docker.run([
                    "image",
                    "ls",
                    "-q",
                    "--filter",
                    `reference=dokku/${deployment.app}`,
                ]);
                if (!fixtureDeploymentGone(deployment, app, containers, images))
                    throw new Error(
                        "A deployment may still own fixture resources; preserving the fixture.",
                    );
                await requireAbsent("image", deployment.image);
            }
        }
        if (broughtUp) {
            await verifyNamespace();
            await docker.compose(["--profile", "admin", "down", "--volumes"]);
        }
        if (ready) {
            await verifyProjectGone();
            cleanupProgress = "Compose containers, networks, volumes and helpers verified absent.";
            const worker = plan.images.worker!;
            // Do not run or remove a tag whose local identity changed after the build.
            const present = new Set<string>();
            for (const image of inventory.images) {
                const result = await docker.run(["image", "inspect", "-f", "{{.Id}}", image], true);
                if (confirmedAbsent(result)) continue;
                if (result.code !== 0 || result.out !== inventory.imageIds[image])
                    throw new Error("Fixture image identity could not be verified.");
                present.add(image);
            }
            const absent = !present.has(worker);
            if (absent) {
                for (const name of fixedPaths)
                    await rm(file(name), { recursive: true, force: true });
            } else {
                // Root-owned bind data can only be deleted by a bounded fixture helper.
                await docker.run([
                    "run",
                    "--pull",
                    "never",
                    "--rm",
                    "--name",
                    `${project}-cleanup`,
                    "--network",
                    "none",
                    "--user",
                    "0",
                    "-v",
                    `${directory}:/fixture`,
                    "--entrypoint",
                    "rm",
                    worker,
                    "-rf",
                    ...fixedPaths.map((name) => `/fixture/${name}`),
                ]);
            }
            cleanupProgress =
                "Compose resources verified absent and fixture bind cleanup executed.";
            for (const image of inventory.images) {
                if (present.has(image)) await docker.run(["image", "rm", image], true);
                await requireAbsent("image", image);
            }
            await verifyProjectGone();
            for (const name of fixedPaths)
                if (
                    await stat(file(name)).then(
                        () => true,
                        (error: NodeJS.ErrnoException) => error.code !== "ENOENT",
                    )
                )
                    throw new Error("A recorded fixture file was not removed.");
            await privateWrite(
                "cleanup.log",
                "Verified absent: fixture containers, networks, volumes, images, apps and secret files.\n",
            );
            console.log("PASS fixture cleanup");
        }
    };
    try {
        await cleanup();
    } catch {
        failed = true;
        await privateWrite(
            "cleanup.log",
            `Cleanup not verified. ${cleanupProgress} Preserve remaining resources. Reconcile their current state against resources.json before acting.\n`,
        );
        console.error(`Cleanup not verified; ${file("resources.json")} records the fixture.`);
    }
    process.off("SIGINT", stop).off("SIGTERM", stop);
}
if (failed || abort.signal.aborted) process.exitCode = 1;
