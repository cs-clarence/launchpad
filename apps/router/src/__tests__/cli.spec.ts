import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireProcessLock } from "../lock";
import { newToken, secretFile, tempState, type TempState } from "../test-support";
import { freePort, refused } from "./support";

// The CLI as an operator runs it: a subprocess with a clean environment. Secrets are given by
// file or stdin; nothing sensitive is ever on its command line or in its environment.

const ENTRY = path.resolve(__dirname, "../index.ts");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let state: TempState;
const running: ChildProcessWithoutNullStreams[] = [];
let upstream: http.Server | undefined;
afterEach(async () => {
    for (const child of running.splice(0)) child.kill("SIGKILL");
    await new Promise<void>((done) => (upstream ? upstream.close(() => done()) : done()));
    upstream = undefined;
    state?.cleanup();
});

interface Settings {
    [name: string]: string | undefined;
}
function settings(overrides: Settings = {}): Settings {
    return {
        LAUNCHPAD_ROUTER_STATE_FILE: state.stateFile,
        LAUNCHPAD_ROUTER_INSTANCE_ID: state.config.instanceId,
        LAUNCHPAD_APPS_DOMAIN: state.config.appsDomain,
        LAUNCHPAD_ROUTER_CONTROL_LISTEN: "127.0.0.1:1",
        LAUNCHPAD_ROUTER_DATA_LISTEN: "127.0.0.1:2",
        LAUNCHPAD_APPS_PROXY_URL: "http://127.0.0.1:3",
        ...overrides,
    };
}

function run(args: string[], env: Settings, stdin?: string) {
    return new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
        const child = spawn("bun", [ENTRY, ...args], {
            env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } as NodeJS.ProcessEnv,
        });
        running.push(child);
        let out = "";
        let err = "";
        child.stdout.on("data", (c) => (out += c));
        child.stderr.on("data", (c) => (err += c));
        child.on("close", (code) => resolve({ code, out, err }));
        child.stdin.end(stdin ?? "");
    });
}

describe("launchpad-router commands", () => {
    it("init prints only the epoch, rotate takes the token from stdin, and neither echoes a secret", async () => {
        state = tempState();
        const token = newToken();
        const file = secretFile(state.directory, `${token}\n`);
        const init = await run(["init", "--token-file", file], settings());
        expect(init).toMatchObject({ code: 0, err: "" });
        expect(init.out.trim()).toMatch(UUID);
        expect(init.out.trim().split("\n")).toHaveLength(1);
        const again = await run(["init", "--token-file", file], settings());
        expect(again.code).toBe(1);
        expect(again.err).not.toContain(token);
        const next = newToken();
        const rotate = await run(["rotate", "--token-stdin"], settings(), `${next}\n`);
        expect(rotate.code).toBe(0);
        expect(rotate.out.trim()).toMatch(UUID);
        expect(rotate.out.trim()).not.toBe(init.out.trim());
        expect(rotate.out + rotate.err).not.toContain(next);
    });

    it("refuses bad usage, bad secrets and bad settings with fixed messages", async () => {
        state = tempState();
        const loose = secretFile(state.directory, newToken(), 0o644, "loose");
        const bad = secretFile(state.directory, "NOT-A-TOKEN-SECRET-VALUE", 0o600, "bad");
        const cases: [string[], Settings, string | undefined, RegExp][] = [
            [["unknown"], settings(), undefined, /unknown command/],
            [["init"], settings(), undefined, /exactly one of/],
            [
                ["init", "--token-file", bad, "--token-stdin"],
                settings(),
                undefined,
                /exactly one of/,
            ],
            [["init", "--token-file", loose], settings(), undefined, /readable only by you/],
            [["init", "--token-file", bad], settings(), undefined, /64 lowercase/],
            [["init", "--token-stdin"], settings(), "short", /64 lowercase/],
            [["init", "--token-file", "relative"], settings(), undefined, /absolute path/],
            [
                ["serve"],
                settings({ LAUNCHPAD_ROUTER_INSTANCE_ID: undefined }),
                undefined,
                /LAUNCHPAD_ROUTER_INSTANCE_ID/,
            ],
            [["init", "--bogus"], settings(), undefined, /exactly one of/],
            [["serve", "--token-file", "x"], settings(), undefined, /takes no arguments/],
            [
                ["serve"],
                settings({ LAUNCHPAD_ROUTER_CONTROL_LISTEN: "0.0.0.0:9" }),
                undefined,
                /PRIVATE_NETWORK/,
            ],
        ];
        for (const [args, env, stdin, expected] of cases) {
            const result = await run(args, env, stdin);
            expect(result.code, args.join(" ")).toBe(1);
            expect(result.err, args.join(" ")).toMatch(expected);
            expect(result.out).toBe("");
            expect(result.err).not.toContain("NOT-A-TOKEN-SECRET-VALUE");
        }
        expect((await run(["--help"], settings())).out).toContain("Usage: launchpad-router");
    });
});

describe("launchpad-router serve", () => {
    it("serves, refuses a second instance and a concurrent rotate, and stops cleanly on SIGTERM", async () => {
        state = tempState();
        const token = newToken();
        const epoch = (
            await run(["init", "--token-file", secretFile(state.directory, token)], settings())
        ).out.trim();
        upstream = http.createServer((req, res) => res.end(`served:${req.headers.host}`));
        await new Promise<void>((done) => upstream!.listen(0, "127.0.0.1", done));
        const controlPort = await freePort();
        const dataPort = await freePort();
        const env = settings({
            LAUNCHPAD_ROUTER_CONTROL_LISTEN: `127.0.0.1:${controlPort}`,
            LAUNCHPAD_ROUTER_DATA_LISTEN: `127.0.0.1:${dataPort}`,
            LAUNCHPAD_APPS_PROXY_URL: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
        });
        const child = spawn("bun", [ENTRY, "serve"], {
            env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } as NodeJS.ProcessEnv,
        });
        running.push(child);
        let out = "";
        child.stdout.on("data", (c) => (out += c));
        const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
        await expect.poll(() => out.includes('"listening"'), { timeout: 10_000 }).toBe(true);
        expect(JSON.parse(out.split("\n")[0]!)).toMatchObject({
            event: "listening",
            control: { port: controlPort },
            data: { port: dataPort },
        });
        expect(out).not.toContain(token);

        const headers = {
            authorization: `Bearer ${token}`,
            "x-launchpad-instance": state.config.instanceId,
            "x-launchpad-epoch": epoch,
            "content-type": "application/json",
        };
        const A = randomUUID();
        const call = (p: string, body: unknown) =>
            fetch(`http://127.0.0.1:${controlPort}${p}`, {
                method: "POST",
                headers,
                body: JSON.stringify(body),
            });
        expect(
            (await call("/v1/deployments", { deploymentId: A, hostname: "a.sites.example.net" }))
                .status,
        ).toBe(200);
        expect(
            (
                await call("/v1/routes", {
                    aliasId: randomUUID(),
                    hostname: "view-site.sites.example.net",
                    operationId: randomUUID(),
                    generation: "1",
                    targetDeploymentId: A,
                })
            ).status,
        ).toBe(200);

        const second = await run(["serve"], env);
        expect(second.code).toBe(1);
        expect(second.err).toContain("holds the state lock");
        const rotate = await run(["rotate", "--token-stdin"], env, newToken());
        expect(rotate.code).toBe(1);
        expect(rotate.err).toContain("holds the state lock");

        child.kill("SIGTERM");
        expect(await exited).toBe(0);
        expect(out).toContain('"stopping"');
        expect(await refused(controlPort)).toBe(true);
        expect(await refused(dataPort)).toBe(true);
        acquireProcessLock(state.stateFile).release();
    });

    it("releases the lock when the process is killed", async () => {
        state = tempState();
        await run(["init", "--token-file", secretFile(state.directory, newToken())], settings());
        const env = settings({
            LAUNCHPAD_ROUTER_CONTROL_LISTEN: `127.0.0.1:${await freePort()}`,
            LAUNCHPAD_ROUTER_DATA_LISTEN: `127.0.0.1:${await freePort()}`,
        });
        const child = spawn("bun", [ENTRY, "serve"], {
            env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } as NodeJS.ProcessEnv,
        });
        running.push(child);
        let out = "";
        child.stdout.on("data", (c) => (out += c));
        const exited = new Promise<void>((resolve) => child.on("close", () => resolve()));
        await expect.poll(() => out.includes('"listening"'), { timeout: 10_000 }).toBe(true);
        expect((await run(["serve"], env)).err).toContain("holds the state lock");
        child.kill("SIGKILL");
        await exited;
        // No shutdown code ran: the kernel released the lock, so there is no stale lock to clear.
        acquireProcessLock(state.stateFile).release();
        expect((await run(["rotate", "--token-stdin"], env, newToken())).code).toBe(0);
    });

    it("refuses to start without complete state", async () => {
        state = tempState();
        const result = await run(
            ["serve"],
            settings({
                LAUNCHPAD_ROUTER_CONTROL_LISTEN: `127.0.0.1:${await freePort()}`,
                LAUNCHPAD_ROUTER_DATA_LISTEN: `127.0.0.1:${await freePort()}`,
            }),
        );
        expect(result.code).toBe(1);
        expect(result.err).toContain("unavailable");
        expect(result.out).toBe("");
    });
});
