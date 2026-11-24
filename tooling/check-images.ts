// Builds the controller, worker and router images and checks them as an operator would meet them:
// unprivileged, holding no secret and no source, able to run `migrate` and to start. The only
// services it touches are the disposable PostgreSQL named by TEST_DATABASE_URL and Docker itself;
// it never contacts Dokku. Every container, image and database it creates is removed by exact
// name (no prune), volumes included, and also when interrupted; BuildKit's build cache is left
// to Docker. Nothing is pushed. Run by `omni run test:images`.
import { SQL } from "bun";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const run = randomBytes(4).toString("hex");
const version: string = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
const images = {
    controller: `launchpad-image-check-${run}/controller:test`,
    worker: `launchpad-image-check-${run}/worker:test`,
    admin: `launchpad-image-check-${run}/admin:test`,
    router: `launchpad-image-check-${run}/router:test`,
};
const containers: string[] = [];
const volumes: string[] = [];
const problems: string[] = [];
const fail = (message: string) => problems.push(message);

// Once an interrupt arrives nothing new is created; commands already running are waited for, so
// the one shared cleanup sees everything this run made.
let stopping = false;
const inflight = new Set<Promise<unknown>>();

function docker(
    args: string[],
    options: { allowFailure?: boolean; cleanup?: boolean; input?: string } = {},
) {
    if (stopping && !options.cleanup) return Promise.reject(new Error("interrupted"));
    const running = dockerNow(args, options);
    inflight.add(running);
    void running.then(
        () => inflight.delete(running),
        () => inflight.delete(running),
    );
    return running;
}

async function dockerNow(args: string[], options: { allowFailure?: boolean; input?: string }) {
    const proc = Bun.spawn(["docker", ...args], {
        cwd: root,
        stdin: options.input === undefined ? "ignore" : new Blob([options.input]),
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15 * 60_000,
        killSignal: "SIGKILL",
    });
    const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    if (code !== 0 && !options.allowFailure) {
        // The disposable database's password must not end up in a log.
        const shown = args.join(" ").replace(/DATABASE_URL=\S+/g, "DATABASE_URL=<redacted>");
        throw new Error(`docker ${shown} failed (${code}):\n${out}\n${err}`);
    }
    return { out: out.trim(), err: err.trim(), code };
}

// Paths that must never be in an image: env files, version control, keys and the source tree.
const FORBIDDEN_IN_IMAGE = [
    /(^|\/)\.env/,
    /(^|\/)\.git(\/|$)/,
    // Keys and certificates, other than the system's own trusted roots.
    /^(?!(etc\/ssl|etc\/ca-certificates|usr\/lib\/ssl|usr\/share\/ca-certificates)\/).*\.(pem|key)$/,
    /(^|\/)id_(rsa|ed25519|ecdsa)/,
    /(^|\/)\.npmrc$/,
    /^app\/(apps|packages|docs|tooling)\//,
];
const EPOCH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECRET_IN_HISTORY = /(PASSWORD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY)\s*=\s*\S/i;

async function logs(name: string) {
    const result = await docker(["logs", name], { allowFailure: true });
    return `${result.out}\n${result.err}`;
}

// Temporary directories this run made, removed by the shared cleanup as well as by the normal path.
const tempDirs = new Set<string>();

// Runs a host tool (tar) tracked like a docker command, and fails on a non-zero exit: an
// incomplete listing must never read as a clean scan.
function hostTool(args: string[]) {
    if (stopping) return Promise.reject(new Error("interrupted"));
    const running = (async () => {
        const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", timeout: 5 * 60_000 });
        const [out, err, code] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);
        if (code !== 0) throw new Error(`${args.join(" ")} failed (${code}): ${err.trim()}`);
        return out;
    })();
    inflight.add(running);
    void running.then(
        () => inflight.delete(running),
        () => inflight.delete(running),
    );
    return running;
}

let inspected = 0;

async function inspectImage(name: string, expectFiles: string[]) {
    const config = JSON.parse((await docker(["image", "inspect", name])).out)[0].Config;
    if (!/^\d+:\d+$/.test(config.User ?? "") || config.User.startsWith("0:")) {
        fail(`${name}: runs as "${config.User}", not a fixed unprivileged uid:gid`);
    }
    if (!(config.Env ?? []).includes(`LAUNCHPAD_VERSION=${version}`)) {
        fail(`${name}: does not record the release version ${version}`);
    }
    const history = (await docker(["history", "--no-trunc", "--format", "{{.CreatedBy}}", name]))
        .out;
    if (SECRET_IN_HISTORY.test(history))
        fail(`${name}: a layer sets something that looks like a secret`);

    // Named first, so a cleanup that starts while the create is still running can remove it.
    const created = `launchpad-image-check-${run}-inspect-${++inspected}`;
    containers.push(created);
    await docker(["create", "--name", created, name]);
    const exportProc = Bun.spawn(["sh", "-c", `docker export ${created} | tar tf -`], {
        stdout: "pipe",
        stderr: "pipe",
    });
    const listing = (await new Response(exportProc.stdout).text()).split("\n").filter(Boolean);
    await exportProc.exited;
    for (const file of listing) {
        if (FORBIDDEN_IN_IMAGE.some((pattern) => pattern.test(file))) {
            fail(`${name}: ${file} must not be in the image`);
        }
    }
    for (const wanted of expectFiles) {
        if (!listing.includes(wanted)) fail(`${name}: ${wanted} is missing`);
    }
    await docker(["rm", "-fv", created]);

    // A file one layer adds and a later layer deletes is not in the final filesystem but is still
    // in the image: every layer is scanned, deletions (whiteouts) read as the file they hide.
    const saved = mkdtempSync(path.join(tmpdir(), "launchpad-image-save-"));
    tempDirs.add(saved);
    try {
        const archive = path.join(saved, "image.tar");
        await docker(["save", "-o", archive, name]);
        await hostTool(["tar", "xf", archive, "-C", saved]);
        const manifest = JSON.parse(readFileSync(path.join(saved, "manifest.json"), "utf8"));
        for (const layer of manifest[0].Layers as string[]) {
            const names = (await hostTool(["tar", "tf", path.join(saved, layer)]))
                .split("\n")
                .filter(Boolean);
            for (const entry of names) {
                const file = entry.replace(/^\.\//, "").replace(/(^|\/)\.wh\./, "$1");
                if (FORBIDDEN_IN_IMAGE.some((pattern) => pattern.test(file))) {
                    fail(`${name}: a layer contains ${file}, even if a later layer removes it`);
                }
            }
        }
    } finally {
        rmSync(saved, { recursive: true, force: true });
        tempDirs.delete(saved);
    }
    return config;
}

let cleanup: () => Promise<void> = async () => {};
for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
        void cleanup().finally(() => process.exit(130));
    });
}

async function main() {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required (a disposable PostgreSQL).");
    const admin = new SQL({ url: databaseUrl, max: 1 });
    const database = `lp_image_${run}`;
    await admin.unsafe(`create database ${database}`);
    const url = new URL(databaseUrl);
    url.pathname = `/${database}`;
    const env = [
        "-e",
        `DATABASE_URL=${url.toString()}`,
        "-e",
        `LAUNCHPAD_AUTH_SECRET=${"image-check-secret-".repeat(3)}`,
    ];
    // What this run created, removed by exact name (also when it is interrupted).
    let cleaning: Promise<void> | undefined;
    cleanup = () =>
        (cleaning ??= (async () => {
            stopping = true;
            await Promise.allSettled(inflight);
            for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
            for (const container of containers) {
                await docker(["rm", "-fv", container], { allowFailure: true, cleanup: true });
            }
            for (const volume of volumes) {
                // `-f` ignores a volume that is already gone, so a non-zero exit is a real failure
                // (for example one still in use): report it, and carry on with the rest.
                const removed = await docker(["volume", "rm", "-f", volume], {
                    allowFailure: true,
                    cleanup: true,
                });
                if (removed.code !== 0) {
                    fail(`could not remove the volume ${volume}: ${removed.err}`);
                }
            }
            for (const image of Object.values(images)) {
                await docker(["image", "rm", image], { allowFailure: true, cleanup: true });
            }
            await admin.unsafe(`drop database if exists ${database} with (force)`).catch(() => {});
            await admin.close().catch(() => {});
        })());
    try {
        for (const [name, file] of Object.entries({
            controller: "apps/controller/Dockerfile",
            worker: "apps/worker/Dockerfile",
            router: "apps/router/Dockerfile",
        })) {
            await docker([
                "build",
                "-q",
                "--build-arg",
                `LAUNCHPAD_VERSION=${version}`,
                "-f",
                file,
                "-t",
                images[name as keyof typeof images],
                ".",
            ]);
            console.log(`built ${name}`);
        }

        const controller = await inspectImage(images.controller, [
            "app/.output/server/index.mjs",
            "app/.output/admin.mjs",
            "app/.output/migrations/20261124_001_initial_schema.mjs",
        ]);
        if (!controller.Healthcheck) fail("the controller image has no healthcheck");
        const workerConfig = JSON.parse((await docker(["image", "inspect", images.worker])).out)[0]
            .Config;
        if (!workerConfig.Healthcheck) fail("the worker image has no healthcheck");
        await inspectImage(images.worker, ["app/dist/index.js"]);

        // The database is empty: the guard must refuse, `migrate` must work from the image alone.
        const status = await docker(
            [
                "run",
                "--rm",
                "--network",
                "host",
                ...env,
                images.controller,
                "bun",
                ".output/admin.mjs",
                "migrate",
                "--status",
            ],
            { allowFailure: true },
        );
        if (status.code === 0)
            fail("migrate --status on an empty database should report pending migrations");
        const migrate = await docker(
            [
                "run",
                "--rm",
                "--network",
                "host",
                ...env,
                images.controller,
                "bun",
                ".output/admin.mjs",
                "migrate",
            ],
            { allowFailure: true },
        );
        if (migrate.code !== 0)
            fail(`migrate from the image failed:\n${migrate.out}\n${migrate.err}`);
        const after = await docker(
            [
                "run",
                "--rm",
                "--network",
                "host",
                ...env,
                images.controller,
                "bun",
                ".output/admin.mjs",
                "migrate",
                "--status",
            ],
            { allowFailure: true },
        );
        if (after.code !== 0) fail(`migrations still pending after migrate:\n${after.out}`);
        else console.log("migrate runs from the image");

        // The server starts, answers, is healthy and can write its data directory.
        const port = 40000 + Math.floor(Math.random() * 20000);
        const name = `launchpad-image-check-${run}-controller`;
        containers.push(name);
        await docker([
            "run",
            "-d",
            "--name",
            name,
            "--network",
            "host",
            ...env,
            "-e",
            `PORT=${port}`,
            "-e",
            "HOST=127.0.0.1",
            "-e",
            `LAUNCHPAD_BASE_URL=http://127.0.0.1:${port}`,
            images.controller,
        ]);
        let ready = false;
        for (let i = 0; i < 120 && !ready; i++) {
            ready = await fetch(`http://127.0.0.1:${port}/api/health`).then(
                (r) => r.ok,
                () => false,
            );
            if (!ready) await Bun.sleep(500);
        }
        if (!ready) {
            fail(`the controller did not answer /api/health:\n${await logs(name)}`);
        } else {
            console.log("the controller answers");
            // Not another process's answer on the shared host network: this container is up and
            // it is the one that says it listens on this port.
            const state = (await docker(["inspect", "--format", "{{.State.Running}}", name])).out;
            if (state !== "true" || !(await logs(name)).includes(String(port))) {
                fail(`the answer on port ${port} did not come from the controller container`);
            }
            const uid = (await docker(["exec", name, "id", "-u"])).out;
            if (uid !== "10001") fail(`the controller runs as uid ${uid}`);
            const write = await docker(
                ["exec", name, "sh", "-c", "touch /data/probe && rm /data/probe"],
                { allowFailure: true },
            );
            if (write.code !== 0) fail("the controller cannot write /data");
            const readonly = await docker(["exec", name, "sh", "-c", "touch /app/.output/probe"], {
                allowFailure: true,
            });
            if (readonly.code === 0) fail("the controller can write its own program files");
            let health = "";
            for (let i = 0; i < 40 && health !== "healthy"; i++) {
                health = (await docker(["inspect", "--format", "{{.State.Health.Status}}", name]))
                    .out;
                if (health !== "healthy") await Bun.sleep(1000);
            }
            if (health !== "healthy") fail(`the controller's healthcheck says "${health}"`);
        }
        // A stop is graceful: it exits 0 well within a few seconds.
        await docker(["stop", "--time", "20", name], { allowFailure: true });
        const stopped = (await docker(["inspect", "--format", "{{.State.ExitCode}}", name])).out;
        if (stopped !== "0") fail(`the controller exited ${stopped} on a stop, not 0`);
        await docker(["rm", "-fv", name]);

        // With deployments off the worker stays healthy without connecting to Dokku or Docker.
        const workerName = `launchpad-image-check-${run}-worker`;
        containers.push(workerName);
        await docker([
            "run",
            "-d",
            "--name",
            workerName,
            "--network",
            "host",
            ...env,
            images.worker,
        ]);
        let idle = false;
        for (let i = 0; i < 40 && !idle; i++) {
            idle = (await logs(workerName)).includes('"event":"deployment-worker-idle"');
            if (!idle) await Bun.sleep(500);
        }
        if (!idle) fail("the worker did not report that it is idle");
        // Idle is healthy, not stuck: the healthcheck must say so.
        let workerHealth = "";
        for (let i = 0; i < 60 && workerHealth !== "healthy"; i++) {
            workerHealth = (
                await docker(["inspect", "--format", "{{.State.Health.Status}}", workerName])
            ).out;
            if (workerHealth !== "healthy") await Bun.sleep(1000);
        }
        if (workerHealth !== "healthy") fail(`the worker's healthcheck says "${workerHealth}"`);
        for (const command of [
            ["docker", "--version"],
            ["ssh", "-V"],
        ]) {
            if (
                (await docker(["exec", workerName, ...command], { allowFailure: true })).code !== 0
            ) {
                fail(`the worker image cannot run ${command.join(" ")}`);
            }
        }
        const workerUid = (await docker(["exec", workerName, "id", "-u"])).out;
        if (workerUid !== "10001") fail(`the worker runs as uid ${workerUid}`);
        const asked = Date.now();
        await docker(["stop", "--time", "20", workerName], { allowFailure: true });
        const workerStopped = (
            await docker(["inspect", "--format", "{{.State.ExitCode}}", workerName])
        ).out;
        if (workerStopped !== "0" || Date.now() - asked > 15_000) {
            fail(`the worker did not stop gracefully (exit ${workerStopped})`);
        }
        console.log("the worker starts and stops");

        // The router: unprivileged, no secret, owns a fresh 0700 state volume, takes its token on
        // stdin, runs, reports healthy, answers the planes as designed and stops gracefully.
        const router = await inspectImage(images.router, ["app/dist/index.js"]);
        if (!router.Healthcheck) fail("the router image has no healthcheck");
        if (Object.keys(router.ExposedPorts ?? {}).length > 0) {
            fail("the router image EXPOSEs ports: binding is the operator's choice");
        }
        const routerName = `launchpad-image-check-${run}-router`;
        const routerVolume = `launchpad-image-check-${run}-router-state`;
        containers.push(routerName);
        volumes.push(routerVolume);
        await docker(["volume", "create", routerVolume]);
        const instance = crypto.randomUUID();
        const routerEnv = [
            "-e",
            `LAUNCHPAD_ROUTER_INSTANCE_ID=${instance}`,
            "-e",
            "LAUNCHPAD_APPS_DOMAIN=sites.example.net",
            "-e",
            "LAUNCHPAD_ROUTER_CONTROL_LISTEN=0.0.0.0:8081",
            "-e",
            "LAUNCHPAD_ROUTER_CONTROL_PRIVATE_NETWORK=1",
            "-e",
            "LAUNCHPAD_ROUTER_DATA_LISTEN=0.0.0.0:8080",
            "-e",
            "LAUNCHPAD_APPS_PROXY_URL=http://127.0.0.1:9",
        ];
        const routerToken = randomBytes(32).toString("hex");
        const oneOff = (args: string[], input?: string) =>
            docker(
                [
                    "run",
                    "--rm",
                    "-i",
                    "-v",
                    `${routerVolume}:/state`,
                    ...routerEnv,
                    images.router,
                    ...args,
                ],
                { allowFailure: true, ...(input === undefined ? {} : { input }) },
            );
        // A router that wrongly starts would run forever, so these two are named (cleanup can
        // remove them) and bounded, and still running after a few seconds is the failure.
        const expectRefusal = async (name: string, label: string, contains?: string) => {
            containers.push(name);
            await docker([
                "run",
                "-d",
                "--name",
                name,
                "-v",
                `${routerVolume}:/state`,
                ...routerEnv,
                images.router,
            ]);
            let running = true;
            for (let i = 0; i < 20 && running; i++) {
                running =
                    (await docker(["inspect", "--format", "{{.State.Running}}", name])).out ===
                    "true";
                if (running) await Bun.sleep(500);
            }
            const output = await logs(name);
            const code = (await docker(["inspect", "--format", "{{.State.ExitCode}}", name])).out;
            await docker(["rm", "-fv", name]);
            if (running) fail(`${label}: it was still running, so nothing refused it`);
            else if (code === "0") fail(`${label}: it exited 0`);
            else if (contains && !output.includes(contains)) fail(`${label}: it did not say why`);
        };
        await expectRefusal(
            `${routerName}-nostate`,
            "a router started without any state",
            "unavailable",
        );
        const init = await oneOff(["init", "--token-stdin"], `${routerToken}\n`);
        const epoch = init.out.trim();
        if (init.code !== 0 || !EPOCH.test(epoch)) {
            fail(`router init failed or printed more than an epoch: ${init.out} ${init.err}`);
        }
        if (init.out.includes(routerToken) || init.err.includes(routerToken)) {
            fail("router init echoed the token");
        }
        if ((await oneOff(["init", "--token-stdin"], `${routerToken}\n`)).code === 0) {
            fail("router init reinitialized existing state");
        }
        await docker([
            "run",
            "-d",
            "--name",
            routerName,
            "-v",
            `${routerVolume}:/state`,
            ...routerEnv,
            images.router,
        ]);
        let routerHealth = "";
        for (let i = 0; i < 60 && routerHealth !== "healthy"; i++) {
            const state = (
                await docker(
                    [
                        "inspect",
                        "--format",
                        "{{.State.Running}} {{.State.Health.Status}}",
                        routerName,
                    ],
                    { allowFailure: true },
                )
            ).out.split(" ");
            routerHealth = state[1] ?? "";
            // A container that already exited will never become healthy: stop waiting.
            if (state[0] !== "true") break;
            if (routerHealth !== "healthy") await Bun.sleep(1000);
        }
        if (routerHealth !== "healthy") {
            fail(
                `the router's healthcheck says "${routerHealth}": ${(await logs(routerName)).slice(-400)}`,
            );
        }
        const routerUid = (await docker(["exec", routerName, "id", "-u"])).out;
        if (routerUid !== "10001") fail(`the router runs as uid ${routerUid}`);
        // From inside the container: the control plane wants credentials, the data plane serves
        // nothing for an unknown host, and a second router on the same state is refused.
        const probe = await docker([
            "exec",
            routerName,
            "bun",
            "-e",
            `const c = await fetch("http://127.0.0.1:8081/v1/routes");
             const http = await import("node:http");
             const d = await new Promise((resolve, reject) => {
                 const r = http.request({ host: "127.0.0.1", port: 8080, path: "/", headers: { host: "unknown.sites.example.net" } },
                     (res) => { let b = ""; res.on("data", (x) => (b += x)); res.on("end", () => resolve([res.statusCode, b])); });
                 r.on("error", reject); r.end();
             });
             console.log(JSON.stringify([c.status, d[0], d[1]]));`,
        ]);
        if (probe.out !== '[401,404,"Not found\\n"]')
            fail(`the router's planes answered ${probe.out}`);
        await expectRefusal(
            `${routerName}-second`,
            "a second router on the same state",
            "holds the state lock",
        );
        const routerAsked = Date.now();
        await docker(["stop", "--time", "20", routerName], { allowFailure: true });
        const routerStopped = (
            await docker(["inspect", "--format", "{{.State.ExitCode}}", routerName])
        ).out;
        if (routerStopped !== "0" || Date.now() - routerAsked > 15_000) {
            fail(`the router did not stop gracefully (exit ${routerStopped})`);
        }
        // Once stopped the lock is free (a stop releases it), so rotation can run and starts a new epoch.
        const rotated = await oneOff(
            ["rotate", "--standalone", "--token-stdin"],
            `${randomBytes(32).toString("hex")}\n`,
        );
        const rotatedEpoch = rotated.out.trim();
        if (rotated.code !== 0 || !EPOCH.test(rotatedEpoch) || rotatedEpoch === epoch) {
            fail(`router rotate did not print a new, valid epoch: ${rotated.out} ${rotated.err}`);
        }
        await docker(["rm", "-fv", routerName]);
        console.log("the router initializes, runs, serves both planes and stops");

        // The operator image: the controller's program and user plus PostgreSQL client tools of
        // at least the disposable server's major version, and the admin command as its entry point.
        await docker([
            "build",
            "-q",
            "--target",
            "admin",
            "--build-arg",
            `LAUNCHPAD_VERSION=${version}`,
            "-f",
            "apps/controller/Dockerfile",
            "-t",
            images.admin,
            ".",
        ]);
        const adminConfig = JSON.parse((await docker(["image", "inspect", images.admin])).out)[0]
            .Config;
        if (adminConfig.User !== "10001:10001")
            fail(`the admin image runs as "${adminConfig.User}"`);
        if (adminConfig.Healthcheck)
            fail("the admin image has a healthcheck: it is a one-off, not a service");
        const dump = await docker(
            ["run", "--rm", "--entrypoint", "pg_dump", images.admin, "--version"],
            {
                allowFailure: true,
            },
        );
        const major = Number(/\(PostgreSQL\) (\d+)/.exec(dump.out)?.[1]);
        if (!(major >= 17)) fail(`the admin image's pg_dump is "${dump.out}", not 17 or newer`);
        const restore = await docker(
            ["run", "--rm", "--entrypoint", "pg_restore", images.admin, "--version"],
            { allowFailure: true },
        );
        if (restore.code !== 0) fail("the admin image has no pg_restore");
        const help = await docker(["run", "--rm", images.admin, "--help"], { allowFailure: true });
        if (help.code !== 0 || !help.out.includes("backup"))
            fail("the admin image does not run the admin command");
        console.log("the admin image has the client tools and runs the admin command");
    } finally {
        await cleanup();
    }
}

await main().catch((error) => fail(String(error instanceof Error ? error.stack : error)));
if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s):\n${problems.map((p) => `- ${p}`).join("\n")}`);
    process.exit(1);
}
console.log("The images build, hold no secret or source, and run.");
