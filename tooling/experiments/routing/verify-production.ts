import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";

type Result = { out: string; err: string; code: number };
type Docker = (args: string[], allowFailure?: boolean, stdin?: string) => Promise<Result>;
interface Resources {
    dir: string;
    network: string;
    dokku: string;
    worker: string;
    router: string;
    upstream: string;
    ingress: string;
    routerTls: string;
    faultProxy: string;
    image: string;
    routerImage: string;
    apps: string[];
    volumes: string[];
}

// The same scenarios the accepted prototype experiment proved (docs/plans/routing-experiment-
// evidence.md), now against the production router image (apps/router) in front of a real Dokku.
// The router has no fault hooks, so delays and response loss come from proxies around it, and the
// authenticated-but-uncommitted old-epoch write (step 10) is proven at the store level by the
// package's own tests, not repeated here.
export async function verifyProduction({
    dir,
    resources: r,
    docker,
    command,
}: {
    dir: string;
    resources: Resources;
    docker: Docker;
    command: (args: string[], allowFailure?: boolean) => Promise<Result>;
}) {
    const appsDomain = "live.example.com";
    const instanceId = randomUUID();
    const source = `${process.cwd()}/tooling/experiments/routing`;
    const aliasIds = Object.fromEntries(
        ["one", "two", "unbound"].map((name) => [`view-${name}.${appsDomain}`, randomUUID()]),
    );
    const tokens = [0, 1, 2, 3].map(() => randomBytes(32).toString("hex"));
    const history: { epoch: string; token: string }[] = [];
    let current: { epoch: string; token: string } | undefined;

    const saveConfig = async () => {
        await writeFile(
            `${dir}/rehearsal-config.next`,
            JSON.stringify({ instanceId, appsDomain, aliasIds, current, history }),
            { mode: 0o600 },
        );
        await docker([
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
            "/experiment/rehearsal-config.next",
        ]);
        await rename(`${dir}/rehearsal-config.next`, `${dir}/rehearsal-config.json`);
    };
    const newVolume = async (name: string) => {
        r.volumes.push(name);
        await writeFile(`${dir}/resources.json`, JSON.stringify(r, null, 2));
        await docker(["volume", "create", name]);
        return name;
    };
    const env = (proxyUrl = "http://dokku:80", extra: string[] = []) => [
        "-e",
        `LAUNCHPAD_ROUTER_INSTANCE_ID=${instanceId}`,
        "-e",
        `LAUNCHPAD_APPS_DOMAIN=${appsDomain}`,
        "-e",
        "LAUNCHPAD_ROUTER_CONTROL_LISTEN=0.0.0.0:8081",
        "-e",
        "LAUNCHPAD_ROUTER_CONTROL_PRIVATE_NETWORK=1",
        "-e",
        "LAUNCHPAD_ROUTER_DATA_LISTEN=0.0.0.0:8080",
        "-e",
        `LAUNCHPAD_APPS_PROXY_URL=${proxyUrl}`,
        ...extra,
    ];
    const oneOff = (volume: string, args: string[], stdin?: string, proxyUrl?: string) =>
        docker(
            [
                "run",
                "--rm",
                "-i",
                "-v",
                `${volume}:/state`,
                ...env(proxyUrl),
                r.routerImage,
                ...args,
            ],
            true,
            stdin,
        );
    const startRouter = async (
        name: string,
        alias: string,
        volume: string,
        proxyUrl?: string,
        extra: string[] = [],
        mounts: string[] = [],
    ) => {
        await docker([
            "run",
            "-d",
            "--name",
            name,
            "--network",
            r.network,
            "--network-alias",
            alias,
            "-v",
            `${volume}:/state`,
            ...mounts,
            ...env(proxyUrl, extra),
            r.routerImage,
        ]);
        let healthy = false;
        for (let i = 0; i < 60 && !healthy; i++) {
            healthy =
                (await docker(["exec", name, "bun", "dist/index.js", "healthcheck"], true)).code ===
                0;
            if (!healthy) await Bun.sleep(500);
        }
        if (!healthy) {
            const logs = await docker(["logs", name], true);
            throw new Error(`Router ${name} not healthy: ${logs.out}\n${logs.err}`);
        }
    };
    const init = async (volume: string, token: string, proxyUrl?: string) => {
        const result = await oneOff(volume, ["init", "--token-stdin"], `${token}\n`, proxyUrl);
        assert.equal(result.code, 0, `init: ${result.err}`);
        assert.match(result.out, /^[0-9a-f-]{36}$/);
        assert.ok(!result.out.includes(token) && !result.err.includes(token));
        return result.out;
    };
    const phase = async (name: string, expected = 0) => {
        const result = await docker(
            ["exec", r.worker, "bun", "/experiment/rehearsal-driver.ts", name],
            true,
        );
        assert.equal(result.code, expected, `${name}: ${result.err}\n${result.out}`);
        console.log(result.out || `rehearsal phase ${name}: expected exit ${expected}`);
    };
    const support = (name: string, alias: string, mode: string, extra: string[] = []) =>
        docker([
            "run",
            "-d",
            "--name",
            name,
            "--network",
            r.network,
            "--network-alias",
            alias,
            "--entrypoint",
            "bun",
            "-v",
            `${source}:/source:ro`,
            "-v",
            `${dir}/data:/data:ro`,
            ...extra,
            r.image,
            "/source/proxies.ts",
            mode,
        ]);
    const own = (file: string) =>
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

    const idsBefore: string[] = [];
    for (const app of r.apps) {
        idsBefore.push(
            (await docker(["image", "inspect", "--format", "{{.Id}}", `dokku/${app}:latest`])).out,
        );
    }

    // The driver (and its support servers) run in the worker image, which has Bun.
    await Bun.write(
        `${dir}/rehearsal-driver.ts`,
        await Bun.file(`${source}/rehearsal-driver.ts`).text(),
    );
    await support(r.faultProxy, "fault-proxy", "control-proxy");
    await support(r.ingress, "ingress", "ingress");

    // 1. Fresh state, a real init from stdin, the real router.
    const volume = await newVolume(`${r.router}-state`);
    current = { epoch: await init(volume, tokens[0]!), token: tokens[0]! };
    history.push(current);
    await saveConfig();
    await startRouter(r.router, "router", volume);
    await phase("core");

    // 2. Restart: acknowledged routes, tombstones and epoch survive.
    await docker(["restart", r.router]);
    let back = false;
    for (let i = 0; i < 60 && !back; i++) {
        back =
            (await docker(["exec", r.router, "bun", "dist/index.js", "healthcheck"], true)).code ===
            0;
        if (!back) await Bun.sleep(500);
    }
    assert.ok(back, "the router did not come back after a restart");
    await phase("restart");

    // 3. A driver that dies after the router acknowledged, and its replacement.
    await phase("crash", 73);
    await phase("crash-recover");

    // 4. Durable state disappears under a running router: nothing falls through to Dokku, health
    //    reports it, and a restart without state refuses rather than creating an empty one.
    await docker(["exec", r.router, "mv", "/state/routes.sqlite", "/state/routes.sqlite.gone"]);
    await phase("unavailable");
    assert.notEqual(
        (await docker(["exec", r.router, "bun", "dist/index.js", "healthcheck"], true)).code,
        0,
    );
    await docker(["rm", "-f", r.router]);
    const stateless = await docker(
        ["run", "--rm", "-v", `${volume}:/state`, ...env(), r.routerImage],
        true,
    );
    assert.notEqual(stateless.code, 0, "a router must not start without its state");
    const listing = await docker([
        "run",
        "--rm",
        "--entrypoint",
        "ls",
        "-v",
        `${volume}:/state`,
        r.routerImage,
        "/state",
    ]);
    assert.ok(!listing.out.split("\n").includes("routes.sqlite"), "state must not be recreated");
    await docker([
        "run",
        "--rm",
        "--entrypoint",
        "mv",
        "-v",
        `${volume}:/state`,
        r.routerImage,
        "/state/routes.sqlite.gone",
        "/state/routes.sqlite",
    ]);
    await startRouter(r.router, "router", volume);
    await phase("after-recovery");

    // 5. Restore procedure: close ingress, fence every pre-restore writer with a new epoch and
    //    token, then reconcile from the authoritative read before reopening.
    await phase("pre-restore");
    // /data is read-write for the worker and read-only for the proxies that read the gate.
    await docker(["exec", r.worker, "touch", "/data/ingress-closed"]);
    await docker(["stop", "--time", "20", r.router]);
    const stopped = (await docker(["inspect", "--format", "{{.State.ExitCode}}", r.router])).out;
    assert.equal(stopped, "0");
    const rotated = await oneOff(volume, ["rotate", "--token-stdin"], `${tokens[1]}\n`);
    assert.equal(rotated.code, 0, rotated.err);
    current = { epoch: rotated.out, token: tokens[1]! };
    history.push(current);
    await saveConfig();
    await docker(["rm", "-f", r.router]);
    await startRouter(r.router, "router", volume);
    await phase("restore");
    await docker(["exec", r.worker, "rm", "-f", "/data/ingress-closed"]);
    await phase("reopened");

    // 6. Router state lost entirely: a fresh state in a new epoch rejects every old pair.
    await docker(["rm", "-f", r.router]);
    const volume2 = await newVolume(`${r.router}-state-2`);
    current = { epoch: await init(volume2, tokens[2]!), token: tokens[2]! };
    history.push(current);
    await saveConfig();
    await startRouter(r.router, "router", volume2);
    await phase("lost");

    // 7. Host, SNI and certificate verification, with isolated certificates.
    await mkdir(`${dir}/tls`);
    const openssl = (...args: string[]) => command(["openssl", ...args]);
    await openssl(
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        `${dir}/tls/ca.key`,
        "-out",
        `${dir}/tls/ca.crt`,
        "-days",
        "1",
        "-subj",
        "/CN=Rehearsal CA",
    );
    await openssl(
        "req",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        `${dir}/tls/server.key`,
        "-out",
        `${dir}/tls/server.csr`,
        "-subj",
        "/CN=tls.live.example.com",
    );
    await writeFile(
        `${dir}/tls/ext`,
        "subjectAltName=DNS:tls.live.example.com\nextendedKeyUsage=serverAuth\n",
    );
    await openssl(
        "x509",
        "-req",
        "-in",
        `${dir}/tls/server.csr`,
        "-CA",
        `${dir}/tls/ca.crt`,
        "-CAkey",
        `${dir}/tls/ca.key`,
        "-CAcreateserial",
        "-out",
        `${dir}/tls/server.crt`,
        "-days",
        "1",
        "-extfile",
        `${dir}/tls/ext`,
    );
    await chmod(`${dir}/tls`, 0o755);
    await chmod(`${dir}/tls/server.key`, 0o600);
    await chmod(`${dir}/tls/ca.key`, 0o600);
    await own("tls/server.key");
    await support(r.upstream, "tls-upstream", "tls-upstream", ["-v", `${dir}/tls:/tls:ro`]);
    const volume3 = await newVolume(`${r.router}-state-3`);
    const tlsEnvUrl = "https://tls-upstream:8443";
    const tlsEpoch = await init(volume3, tokens[3]!, tlsEnvUrl);
    const afterLost = current;
    current = { epoch: tlsEpoch, token: tokens[3]! };
    history.push(current);
    await saveConfig();
    await startRouter(
        r.routerTls,
        "router-tls",
        volume3,
        tlsEnvUrl,
        ["-e", "LAUNCHPAD_ROUTER_UPSTREAM_CA_FILE=/tls/ca.crt"],
        ["-v", `${dir}/tls:/tls:ro`],
    );
    await phase("tls");
    current = afterLost;

    const idsAfter: string[] = [];
    for (const app of r.apps) {
        idsAfter.push(
            (await docker(["image", "inspect", "--format", "{{.Id}}", `dokku/${app}:latest`])).out,
        );
    }
    assert.deepEqual(idsAfter, idsBefore);
    const sqlite = await docker([
        "run",
        "--rm",
        "--entrypoint",
        "bun",
        r.routerImage,
        "-e",
        "import{Database}from'bun:sqlite';console.log(new Database(':memory:').query('select sqlite_version() as v').get().v)",
    ]);
    await writeFile(
        `${dir}/image-identities.json`,
        JSON.stringify(
            {
                before: idsBefore,
                after: idsAfter,
                fixtureBuilds: 2,
                promotionBuilds: 0,
                routerImage: (
                    await docker(["image", "inspect", "--format", "{{.Id}}", r.routerImage])
                ).out,
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
                sqlite: sqlite.out,
                epochsUsed: history.length,
            },
            null,
            2,
        ),
    );
    console.log("Both fixture image IDs unchanged; production router rehearsal phases passed.");
}
