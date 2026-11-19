import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { initRouter, rotateRouter } from "../commands";
import { LockError } from "../lock";
import { startRouter, type RunningRouter } from "../serve";
import { newToken, tempState, type TempState } from "../test-support";
import { get, raw, refused } from "./support";

// Loopback listeners only: a real router (lock, store, both listeners) in front of a stand-in for
// Dokku's proxy.

let state: TempState;
let router: RunningRouter | undefined;
let upstream: http.Server | undefined;
const hosts: (string | undefined)[] = [];
const paths: (string | undefined)[] = [];
let delayMs = 0;
// Called when a request reaches the stand-in upstream, so a test can wait for "in flight".
let onArrival: (() => void) | undefined;

afterEach(async () => {
    await router?.shutdown();
    router = undefined;
    upstream?.closeAllConnections();
    await new Promise<void>((done) => (upstream ? upstream.close(() => done()) : done()));
    upstream = undefined;
    hosts.length = 0;
    paths.length = 0;
    delayMs = 0;
    onArrival = undefined;
    state?.cleanup();
});

async function boot() {
    state = tempState();
    const token = newToken();
    const epoch = initRouter(state.config, token);
    upstream = http.createServer((req, res) => {
        hosts.push(req.headers.host);
        paths.push(req.url);
        onArrival?.();
        setTimeout(() => res.end(`served:${req.headers.host}`), delayMs);
    });
    await new Promise<void>((done) => upstream!.listen(0, "127.0.0.1", done));
    const upstreamPort = (upstream.address() as AddressInfo).port;
    const config = () => ({
        ...state.config,
        control: { host: "127.0.0.1", port: 0 },
        data: { host: "127.0.0.1", port: 0 },
        upstreamOrigin: new URL(`http://127.0.0.1:${upstreamPort}`),
        upstreamCaFile: null,
    });
    router = startRouter(config());
    const api = (epochValue = epoch, tokenValue = token) => {
        const headers = {
            authorization: `Bearer ${tokenValue}`,
            "x-launchpad-instance": state.config.instanceId,
            "x-launchpad-epoch": epochValue,
            "content-type": "application/json",
        };
        const base = () => `http://127.0.0.1:${router!.control.port}`;
        return {
            post: (path: string, body: unknown) =>
                fetch(`${base()}${path}`, { method: "POST", headers, body: JSON.stringify(body) }),
            get: (path: string) => fetch(`${base()}${path}`, { headers }),
        };
    };
    return { token, epoch, api, config };
}

const A = randomUUID();
const B = randomUUID();
const ALIAS = randomUUID();
const ALIAS_HOST = "view-site.sites.example.net";
const bind = (generation: string, target: string | null) => ({
    aliasId: ALIAS,
    hostname: ALIAS_HOST,
    operationId: randomUUID(),
    generation,
    targetDeploymentId: target,
});

describe("router over real listeners", () => {
    it("serves promotion and rollback through the control and data planes", async () => {
        const { api } = await boot();
        const control = api();
        await control.post("/v1/deployments", { deploymentId: A, hostname: "a.sites.example.net" });
        await control.post("/v1/deployments", { deploymentId: B, hostname: "b.sites.example.net" });
        expect((await get(router!.data.port, ALIAS_HOST)).status).toBe(404);
        expect((await control.post("/v1/routes", bind("1", A))).status).toBe(200);
        expect((await get(router!.data.port, ALIAS_HOST)).body).toBe("served:a.sites.example.net");
        await control.post("/v1/routes", bind("2", B));
        expect((await get(router!.data.port, ALIAS_HOST)).body).toBe("served:b.sites.example.net");
        await control.post("/v1/routes", bind("3", A));
        expect((await get(router!.data.port, ALIAS_HOST)).body).toBe("served:a.sites.example.net");
        await control.post("/v1/routes", bind("4", null));
        const withdrawn = await get(router!.data.port, ALIAS_HOST);
        expect(withdrawn.status).toBe(404);
        expect(withdrawn.body).toBe("Not found\n");
        expect(hosts).toEqual([
            "a.sites.example.net",
            "b.sites.example.net",
            "a.sites.example.net",
        ]);
    });

    it("keeps the planes separate and exposes no rotation, initialization or fault endpoint", async () => {
        const { api } = await boot();
        const control = api();
        expect((await fetch(`http://127.0.0.1:${router!.control.port}/healthz`)).status).toBe(200);
        expect((await fetch(`http://127.0.0.1:${router!.data.port}/healthz`)).status).toBe(404);
        expect((await get(router!.data.port, "x.sites.example.net", "", "/v1/routes")).status).toBe(
            404,
        );
        expect((await fetch(`http://127.0.0.1:${router!.control.port}/v1/routes`)).status).toBe(
            401,
        );
        for (const path of ["/v1/rotate", "/v1/init", "/v1/held", "/v1/release"]) {
            expect((await control.post(path, {})).status).toBe(404);
        }
        // A non-canonical write is rejected by the real listener exactly as by the handler.
        expect(
            (await control.post("/v1/routes", { ...bind("1", A), upstream: "http://127.0.0.1" }))
                .status,
        ).toBe(400);
    });

    it("answers malformed or hostile request lines and Host headers with a fixed non-success, never reaching the upstream", async () => {
        const { api } = await boot();
        const control = api();
        await control.post("/v1/deployments", { deploymentId: A, hostname: "a.sites.example.net" });
        await control.post("/v1/routes", bind("1", A));
        const port = router!.data.port;
        const attempts: Record<string, string> = {
            "duplicate Host": `GET / HTTP/1.1\r\nHost: ${ALIAS_HOST}\r\nHost: evil.example.org\r\nConnection: close\r\n\r\n`,
            "absolute-form to another host": `GET http://evil.example.org/ HTTP/1.1\r\nHost: unknown.sites.example.net\r\nConnection: close\r\n\r\n`,
            "absolute-form with matching Host": `GET http://evil.example.org/ HTTP/1.1\r\nHost: ${ALIAS_HOST}\r\nConnection: close\r\n\r\n`,
            "bracketed IPv6 Host": `GET / HTTP/1.1\r\nHost: [::1]\r\nConnection: close\r\n\r\n`,
            "userinfo Host": `GET / HTTP/1.1\r\nHost: user@${ALIAS_HOST}\r\nConnection: close\r\n\r\n`,
            "bad port Host": `GET / HTTP/1.1\r\nHost: ${ALIAS_HOST}:99999\r\nConnection: close\r\n\r\n`,
            "trailing dot Host": `GET / HTTP/1.1\r\nHost: ${ALIAS_HOST}.\r\nConnection: close\r\n\r\n`,
            POST: `POST / HTTP/1.1\r\nHost: ${ALIAS_HOST}\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi`,
            "GET with a body": `GET / HTTP/1.1\r\nHost: ${ALIAS_HOST}\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi`,
            "chunked GET": `GET / HTTP/1.1\r\nHost: ${ALIAS_HOST}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n0\r\n\r\n`,
            CONNECT: `CONNECT ${ALIAS_HOST}:443 HTTP/1.1\r\nHost: ${ALIAS_HOST}:443\r\nConnection: close\r\n\r\n`,
            "asterisk-form OPTIONS": `OPTIONS * HTTP/1.1\r\nHost: ${ALIAS_HOST}\r\nConnection: close\r\n\r\n`,
            "HTTP/1.0 without Host": `GET / HTTP/1.0\r\n\r\n`,
        };
        const results: Record<string, number> = {};
        for (const [name, request] of Object.entries(attempts)) {
            // Only a connection the parser itself reset counts as "refused" (status 0). A timeout or
            // any other error is a real failure and must not pass as one.
            const response = await raw(port, request).catch((error: NodeJS.ErrnoException) => {
                if (error.code === "ECONNRESET" || error.code === "EPIPE") return { status: 0 };
                throw error;
            });
            results[name] = response.status;
        }
        // No hostile form is ever served. Where Bun's HTTP parser itself refuses the request the
        // connection may close without a response (status 0). One form is deliberately pinned:
        // Bun routes an absolute-form request by its Host header and ignores the target's authority
        // (RFC 9112 says the authority wins). That cannot redirect traffic, because the upstream is
        // chosen only from the registry, but a front proxy that routes on the request target must
        // normalise it (recorded in the plan and README).
        for (const [name, status] of Object.entries(results)) {
            const allowed =
                name === "absolute-form with matching Host"
                    ? [200, 400, 404]
                    : [0, 400, 404, 405, 411, 413, 431, 501];
            expect(allowed, `${name}: ${status}`).toContain(status);
        }
        expect(hosts).not.toContain("evil.example.org");
        // Everything that was served went to the registry's hostname and only the origin-form path.
        for (const host of hosts) expect(host).toBe("a.sites.example.net");
        for (const requested of paths) expect(requested).toBe("/");
        // A well-formed request still works afterwards.
        expect((await get(port, ALIAS_HOST)).status).toBe(200);
    });

    it("holds the process lock, refuses a second router and a concurrent rotate, and releases on shutdown", async () => {
        const { config } = await boot();
        expect(() => startRouter(config())).toThrow(LockError);
        expect(() => rotateRouter(state.config, newToken())).toThrow(LockError);
        const { port } = router!.data;
        const controlPort = router!.control.port;
        await router!.shutdown();
        // The last connection to the store closed cleanly: SQLite removes its WAL sidecars then, and
        // a leaked connection would leave them behind.
        expect(existsSync(`${state.stateFile}-wal`)).toBe(false);
        expect(existsSync(`${state.stateFile}-shm`)).toBe(false);
        expect(await refused(port)).toBe(true);
        expect(await refused(controlPort)).toBe(true);
        router = startRouter(config());
        expect((await fetch(`http://127.0.0.1:${router.control.port}/healthz`)).status).toBe(200);
    });

    it("persists routes across a restart and fences the old credentials after a rotation", async () => {
        const { api, epoch, token, config } = await boot();
        const control = api();
        await control.post("/v1/deployments", { deploymentId: A, hostname: "a.sites.example.net" });
        await control.post("/v1/routes", bind("1", A));
        await router!.shutdown();
        const next = newToken();
        const nextEpoch = rotateRouter(state.config, next);
        router = startRouter(config());
        expect((await get(router.data.port, ALIAS_HOST)).body).toBe("served:a.sites.example.net");
        expect((await api(epoch, token).get("/v1/routes")).status).toBe(401);
        expect((await api(epoch, token).post("/v1/routes", bind("9", null))).status).toBe(401);
        const fresh = api(nextEpoch, next);
        expect((await fresh.get("/v1/routes")).status).toBe(200);
        expect((await get(router.data.port, ALIAS_HOST)).status).toBe(200);
    });

    it("drains an in-flight request on shutdown, then refuses new connections", async () => {
        const { api } = await boot();
        const control = api();
        await control.post("/v1/deployments", { deploymentId: A, hostname: "a.sites.example.net" });
        await control.post("/v1/routes", bind("1", A));
        delayMs = 400;
        // Shutdown starts only once the request has reached the upstream: truly in flight.
        const arrived = new Promise<void>((resolve) => (onArrival = resolve));
        const inflight = get(router!.data.port, ALIAS_HOST);
        await arrived;
        const port = router!.data.port;
        await router!.shutdown();
        const finished = await inflight;
        expect(finished.status).toBe(200);
        expect(finished.body).toBe("served:a.sites.example.net");
        expect(await refused(port)).toBe(true);
    });
});
