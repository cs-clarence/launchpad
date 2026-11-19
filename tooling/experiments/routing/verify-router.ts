import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";

type Result = { out: string; err: string; code: number };
type Resources = {
    dir: string;
    network: string;
    dokku: string;
    worker: string;
    router: string;
    upstream: string;
    ingress: string;
    image: string;
    apps: string[];
};
type Docker = (args: string[], allowFailure?: boolean, stdin?: string) => Promise<Result>;

export async function verifyRouter({
    dir,
    resources: r,
    docker,
}: {
    dir: string;
    resources: Resources;
    docker: Docker;
}) {
    const fixtures = await Bun.file(`${dir}/data/fixtures.json`).json();
    const fixturesBefore = [];
    for (const app of r.apps) {
        fixturesBefore.push(
            (await docker(["image", "inspect", "--format", "{{.Id}}", `dokku/${app}:latest`])).out,
        );
    }
    const config = {
        instance: randomUUID(),
        epoch: "",
        credential: "",
        epochs: Array.from({ length: 3 }, () => randomUUID()),
        credentials: Array.from({ length: 3 }, () => randomBytes(32).toString("hex")),
        aliases: Object.fromEntries(
            ["one", "two", "unbound"].map((name) => [`${name}.live.example.com`, randomUUID()]),
        ),
        targets: Object.fromEntries([
            ...fixtures.map((fixture: { deploymentId: string; hostname: string }) => [
                fixture.deploymentId,
                { hostname: fixture.hostname, address: "dokku", port: 80 },
            ]),
            [
                "tls-good",
                { hostname: "tls.live.example.com", address: "upstream", port: 8443, tls: true },
            ],
            [
                "tls-wrong-name",
                { hostname: "wrong.live.example.com", address: "upstream", port: 8443, tls: true },
            ],
        ]),
        ca: "/tls/ca.crt",
    };
    // A narrow root helper changes ownership only inside this fresh experiment directory.
    const own = async (file: string) =>
        docker([
            "run",
            "--rm",
            "--user",
            "0",
            "--entrypoint",
            "chown",
            "-v",
            `${dir}:/experiment`,
            r.image,
            "10001:10001",
            `/experiment/${file}`,
        ]);
    const writeConfig = async (index: number) => {
        config.epoch = config.epochs[index]!;
        config.credential = config.credentials[index]!;
        await writeFile(`${dir}/router-config.next`, JSON.stringify(config), { mode: 0o600 });
        await own("router-config.next");
        await rename(`${dir}/router-config.next`, `${dir}/router-config.json`);
    };
    await mkdir(`${dir}/tls`);
    async function openssl(args: string[]) {
        const child = Bun.spawn(["openssl", ...args], {
            cwd: `${dir}/tls`,
            stdout: "pipe",
            stderr: "pipe",
            env: { PATH: process.env.PATH! },
        });
        const [, err, code] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
        ]);
        if (code) throw new Error(`Test certificate generation failed: ${err}`);
    }
    await openssl([
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        "ca.key",
        "-out",
        "ca.crt",
        "-days",
        "1",
        "-subj",
        "/CN=Launchpad Experiment CA",
    ]);
    await openssl([
        "req",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        "server.key",
        "-out",
        "server.csr",
        "-subj",
        "/CN=tls.live.example.com",
    ]);
    await writeFile(
        `${dir}/tls/extensions`,
        "subjectAltName=DNS:tls.live.example.com\nextendedKeyUsage=serverAuth\n",
    );
    await openssl([
        "x509",
        "-req",
        "-in",
        "server.csr",
        "-CA",
        "ca.crt",
        "-CAkey",
        "ca.key",
        "-CAcreateserial",
        "-out",
        "server.crt",
        "-days",
        "1",
        "-extfile",
        "extensions",
    ]);
    await chmod(`${dir}/tls/ca.key`, 0o600);
    await chmod(`${dir}/tls/server.key`, 0o600);
    await own("tls/server.key");
    await writeConfig(0);
    // Mount source read-only; this is a local prototype, not a new published app/image.
    const source = `${process.cwd()}/tooling/experiments/routing`;
    await docker([
        "run",
        "-d",
        "--name",
        r.upstream,
        "--network",
        r.network,
        "--network-alias",
        "upstream",
        "--entrypoint",
        "bun",
        "-v",
        `${source}:/source:ro`,
        "-v",
        `${dir}/tls:/tls:ro`,
        "-v",
        `${dir}/data:/data:ro`,
        r.image,
        "/source/upstream.ts",
    ]);
    async function startRouter(initialize: boolean) {
        if (initialize) {
            await docker([
                "run",
                "--rm",
                "--entrypoint",
                "bun",
                "-v",
                `${source}:/source:ro`,
                "-v",
                `${dir}:/experiment:ro`,
                "-v",
                `${dir}/router-state:/state`,
                r.image,
                "/source/router.ts",
                "--initialize",
            ]);
        }
        await docker([
            "run",
            "-d",
            "--name",
            r.router,
            "--network",
            r.network,
            "--network-alias",
            "router",
            "--entrypoint",
            "bun",
            "-v",
            `${source}:/source:ro`,
            "-v",
            `${dir}:/experiment:ro`,
            "-v",
            `${dir}/router-state:/state`,
            "-v",
            `${dir}/tls:/tls:ro`,
            r.image,
            "/source/router.ts",
        ]);
    }
    async function ready() {
        for (let i = 0; i < 60; i++) {
            const result = await docker(
                [
                    "exec",
                    r.worker,
                    "bun",
                    "-e",
                    "await fetch('http://router:8081/routes',{signal:AbortSignal.timeout(500)}).then(r=>{if(r.status!==401)process.exit(1)})",
                ],
                true,
            );
            if (!result.code) return;
            await Bun.sleep(500);
        }
        const logs = await docker(["logs", r.router], true);
        throw new Error(`Router not ready: ${logs.out}\n${logs.err}`);
    }
    await startRouter(true);
    await ready();
    async function phase(name: string, expected = 0) {
        // driver is copied into the experiment dir for the worker's existing read-only mount.
        const result = await docker(["exec", r.worker, "bun", "/experiment/driver.ts", name], true);
        assert.equal(result.code, expected, `${name}: ${result.err}`);
        console.log(result.out || `router phase ${name}: expected exit ${expected}`);
    }
    await writeFile(`${dir}/driver.ts`, await Bun.file(`${source}/driver.ts`).text());
    await phase("core");
    await docker(["restart", r.router]);
    await ready();
    await phase("restart");
    await phase("crash", 73);
    await phase("crash-recover");
    // Lose the durable pathname while the router has an open DB; no stale-inode fallback.
    await docker(["exec", r.router, "mv", "/state/routes.sqlite", "/state/unavailable.sqlite"]);
    await phase("unavailable");
    await docker(["exec", r.worker, "touch", "/data/ingress-closed"]);
    await docker(["rm", "-f", r.router]);
    // Restart without the durable file: it must exit rather than create empty state.
    await startRouter(false);
    const exited = await docker(["wait", r.router]);
    assert.notEqual(exited.out, "0");
    await docker(["rm", r.router]);
    await rename(`${dir}/router-state`, `${dir}/old-router-state`);
    await mkdir(`${dir}/router-state`);
    await own("router-state");
    await writeConfig(2);
    await startRouter(true);
    await ready();
    await phase("lost");
    const fixturesAfter = [];
    for (const app of r.apps) {
        fixturesAfter.push(
            (await docker(["image", "inspect", "--format", "{{.Id}}", `dokku/${app}:latest`])).out,
        );
    }
    assert.deepEqual(fixturesAfter, fixturesBefore);
    await writeFile(
        `${dir}/image-identities.json`,
        JSON.stringify(
            {
                before: fixturesBefore,
                after: fixturesAfter,
                fixtureBuilds: 2,
                promotionBuilds: 0,
                workerImage: (await docker(["image", "inspect", "--format", "{{.Id}}", r.image]))
                    .out,
                dokkuImage: (
                    await docker([
                        "image",
                        "inspect",
                        "--format",
                        "{{.Id}}",
                        "launchpad/dokku:0.38.34",
                    ])
                ).out,
                bun: (await docker(["exec", r.worker, "bun", "--version"])).out,
                sqlite: (
                    await docker([
                        "exec",
                        r.worker,
                        "bun",
                        "-e",
                        "import{Database}from'bun:sqlite';console.log(new Database(':memory:').query('select sqlite_version() as v').get().v)",
                    ])
                ).out,
            },
            null,
            2,
        ),
    );
    console.log("Both fixture image IDs unchanged; router experiment phases passed.");
}
