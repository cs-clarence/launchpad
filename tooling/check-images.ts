// Builds the controller and worker images and checks them as an operator would meet them:
// unprivileged, holding no secret and no source, able to run `migrate` and to start. The only
// services it touches are the disposable PostgreSQL named by TEST_DATABASE_URL and Docker itself;
// it never contacts Dokku. Every container, image and database it creates is removed by exact
// name (no prune). Nothing is pushed. Run by `omni run test:images`.
import { SQL } from "bun";
import { randomBytes } from "node:crypto";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const run = randomBytes(4).toString("hex");
const images = {
    controller: `launchpad-image-check-${run}/controller:test`,
    worker: `launchpad-image-check-${run}/worker:test`,
};
const containers: string[] = [];
const problems: string[] = [];
const fail = (message: string) => problems.push(message);

async function docker(args: string[], options: { allowFailure?: boolean } = {}) {
    const proc = Bun.spawn(["docker", ...args], {
        cwd: root,
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
        throw new Error(`docker ${args.join(" ")} failed (${code}):\n${out}\n${err}`);
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
const SECRET_IN_HISTORY = /(PASSWORD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY)\s*=\s*\S/i;

async function inspectImage(name: string, expectFiles: string[]) {
    const config = JSON.parse((await docker(["image", "inspect", name])).out)[0].Config;
    if (!/^\d+:\d+$/.test(config.User ?? "") || config.User.startsWith("0:")) {
        fail(`${name}: runs as "${config.User}", not a fixed unprivileged uid:gid`);
    }
    const history = (await docker(["history", "--no-trunc", "--format", "{{.CreatedBy}}", name]))
        .out;
    if (SECRET_IN_HISTORY.test(history))
        fail(`${name}: a layer sets something that looks like a secret`);

    const created = (await docker(["create", name])).out;
    containers.push(created);
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
    await docker(["rm", "-f", created]);
    return config;
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
    try {
        for (const [name, file] of Object.entries({
            controller: "containers/controller/Dockerfile",
            worker: "containers/worker/Dockerfile",
        })) {
            await docker([
                "build",
                "-q",
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
            "app/.output/migrations/20261114_001_auth_schema.mjs",
        ]);
        if (!controller.Healthcheck) fail("the controller image has no healthcheck");
        await inspectImage(images.worker, [
            "app/dist/index.js",
            "app/dist/migrations/20261114_001_auth_schema.mjs",
        ]);

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
            fail(
                `the controller did not answer /api/health:\n${(await docker(["logs", name], { allowFailure: true })).err}`,
            );
        } else {
            console.log("the controller answers");
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
        await docker(["rm", "-f", name]);

        // The worker with deployments off idles; it carries the tools it needs.
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
            idle = (await docker(["logs", workerName], { allowFailure: true })).out.includes(
                '"event":"disabled"',
            );
            if (!idle) await Bun.sleep(500);
        }
        if (!idle) fail("the worker did not report that deployments are off");
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
        console.log("the worker starts");
    } finally {
        for (const container of containers)
            await docker(["rm", "-f", container], { allowFailure: true });
        for (const image of Object.values(images))
            await docker(["image", "rm", image], { allowFailure: true });
        await admin.unsafe(`drop database if exists ${database} with (force)`).catch(() => {});
        await admin.close();
    }
}

await main().catch((error) => fail(String(error instanceof Error ? error.stack : error)));
if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s):\n${problems.map((p) => `- ${p}`).join("\n")}`);
    process.exit(1);
}
console.log("The images build, hold no secret or source, and run.");
