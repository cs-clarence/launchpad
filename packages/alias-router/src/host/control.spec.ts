import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createControlHandler, MAX_CONTROL_BODY_BYTES } from "./control";
import { hostFixture, type HostFixture } from "./test-support";

let fixture: HostFixture;
afterEach(() => fixture?.cleanup());

const A = randomUUID();
const B = randomUUID();
function setup() {
    fixture = hostFixture();
    const handle = createControlHandler(fixture.store);
    const call = (method: string, path: string, body?: unknown, headers = fixture.headers) =>
        handle(
            new Request(`http://router.internal${path}`, {
                method,
                headers,
                ...(body === undefined
                    ? {}
                    : { body: typeof body === "string" ? body : JSON.stringify(body) }),
            }),
        );
    return { handle, call };
}
const deployment = (id: string, name: string) => ({
    deploymentId: id,
    hostname: `${name}.sites.example.net`,
});
const route = (generation: string, target: string | null, aliasId = ALIAS) => ({
    aliasId,
    hostname: "view-site.sites.example.net",
    operationId: randomUUID(),
    generation,
    targetDeploymentId: target,
});
const ALIAS = randomUUID();

describe("control plane", () => {
    it("registers, binds, promotes and reads back, with no-store JSON responses", async () => {
        const { call } = setup();
        expect((await call("POST", "/v1/deployments", deployment(A, "a"))).status).toBe(200);
        await call("POST", "/v1/deployments", deployment(B, "b"));
        const bound = await call("POST", "/v1/routes", route("1", A));
        expect(bound.status).toBe(200);
        expect(bound.headers.get("cache-control")).toBe("no-store");
        expect(bound.headers.get("content-type")).toBe("application/json");
        const moved = route("2", B);
        const result = await (await call("POST", "/v1/routes", moved)).json();
        expect(result.route.target.deploymentId).toBe(B);
        const read = await (await call("GET", "/v1/routes/view-site.sites.example.net")).json();
        expect(read).toEqual(result);
        const page = await (await call("GET", "/v1/routes?limit=1")).json();
        expect(page.routes).toHaveLength(1);
        expect(page.nextCursor).toBeNull();
        // The same operation replays; a lower generation conflicts and changes nothing.
        expect((await call("POST", "/v1/routes", moved)).status).toBe(200);
        expect((await call("POST", "/v1/routes", route("1", A))).status).toBe(409);
        expect((await call("POST", "/v1/routes", route("3", randomUUID()))).status).toBe(400);
    });

    it("answers /healthz without credentials and with fixed bodies only", async () => {
        const { call } = setup();
        const ok = await call("GET", "/healthz", undefined, {});
        expect(ok.status).toBe(200);
        expect(await ok.json()).toEqual({ status: "ok" });
        expect((await call("POST", "/healthz", undefined, {})).status).toBe(405);
        fixture.store.close();
        const down = await call("GET", "/healthz", undefined, {});
        expect(down.status).toBe(503);
        expect(await down.json()).toEqual({ status: "unavailable" });
    });

    it("authenticates before routing: every failure is the same fixed 401, even for unknown paths", async () => {
        const { call, handle } = setup();
        const wrong = {
            "wrong token": {
                ...fixture.headers,
                authorization: `Bearer ${randomBytes(32).toString("hex")}`,
            },
            "no bearer": { ...fixture.headers, authorization: fixture.credentials.token },
            "no instance": { ...fixture.headers, "x-launchpad-instance": "" },
            "wrong instance": { ...fixture.headers, "x-launchpad-instance": randomUUID() },
            "stale epoch": { ...fixture.headers, "x-launchpad-epoch": randomUUID() },
        };
        const bodies = new Set<string>();
        for (const headers of Object.values(wrong)) {
            for (const [method, path] of [
                ["GET", "/v1/routes"],
                ["POST", "/v1/deployments"],
                ["DELETE", "/v1/nothing"],
                ["GET", "/v1"],
            ] as const) {
                const response = await call(method, path, undefined, headers);
                expect(response.status).toBe(401);
                bodies.add(await response.text());
            }
        }
        expect([...bodies]).toEqual(['{"error":"unauthorized"}']);
        const missing = new Request("http://router.internal/v1/routes");
        expect((await handle(missing)).status).toBe(401);
        expect(JSON.stringify(bodies)).not.toContain(fixture.credentials.token);
    });

    it("404s and 405s only after authenticating; no rotation, init or fault endpoint exists", async () => {
        const { call } = setup();
        for (const path of [
            "/v1/rotate",
            "/v1/init",
            "/v1/held",
            "/v1/release",
            "/v1/write",
            "/",
        ]) {
            for (const method of ["GET", "POST"]) {
                expect((await call(method, path, method === "POST" ? {} : undefined)).status).toBe(
                    404,
                );
            }
        }
        expect((await call("DELETE", "/v1/routes")).status).toBe(405);
        expect((await call("GET", "/v1/deployments")).status).toBe(405);
        expect((await call("POST", "/v1/routes/view-site.sites.example.net", {})).status).toBe(405);
    });

    it("bounds and strictly validates bodies before touching the store", async () => {
        const { call } = setup();
        const post = (body: unknown, headers = fixture.headers) =>
            call("POST", "/v1/deployments", body, headers);
        const { "content-type": _, ...noType } = fixture.headers;
        expect((await post(deployment(A, "a"), noType)).status).toBe(400);
        expect(
            (await post(deployment(A, "a"), { ...noType, "content-type": "text/plain" })).status,
        ).toBe(400);
        expect(
            (
                await post(deployment(A, "a"), {
                    ...noType,
                    "content-type": "application/json; charset=utf-8",
                })
            ).status,
        ).toBe(200);
        expect(
            (
                await post(deployment(B, "b"), {
                    ...noType,
                    "content-type": "application/json; boundary=x",
                })
            ).status,
        ).toBe(400);
        expect((await post("{not json")).status).toBe(400);
        expect((await post("null")).status).toBe(400);
        expect((await post({ ...deployment(B, "b"), address: "127.0.0.1" })).status).toBe(400);
        const huge = JSON.stringify({
            ...deployment(B, "b"),
            pad: "x".repeat(MAX_CONTROL_BODY_BYTES),
        });
        const declared = await post(huge);
        expect(declared.status).toBe(413);
        expect(await declared.json()).toEqual({ error: "too-large" });
        // A body that lies about, or omits, Content-Length is still cut off while streaming.
        const stream = new ReadableStream({
            start(controller) {
                for (let i = 0; i < 20; i++)
                    controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
                controller.close();
            },
        });
        const streamed = await createControlHandler(fixture.store)(
            new Request("http://router.internal/v1/deployments", {
                method: "POST",
                headers: fixture.headers,
                body: stream,
                duplex: "half",
            } as RequestInit),
        );
        expect(streamed.status).toBe(413);
        expect(fixture.store.readRoute("b.sites.example.net").route).toBeNull();
    });

    it("treats a body that fails mid-read as an invalid request, not a server error", async () => {
        const { call } = setup();
        const broken = new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode("{"));
                controller.error(new Error("client went away"));
            },
        });
        const response = await createControlHandler(fixture.store)(
            new Request("http://router.internal/v1/deployments", {
                method: "POST",
                headers: fixture.headers,
                body: broken,
                duplex: "half",
            } as RequestInit),
        );
        expect(response.status).toBe(400);
        expect(await response.text()).toBe('{"error":"invalid"}');
        void call;
    });

    it("validates path and query inputs with the canonical rules and never echoes them", async () => {
        const { call } = setup();
        for (const path of [
            "/v1/routes/UPPER.sites.example.net",
            "/v1/routes/bad%20host.sites.example.net",
            "/v1/routes/sites.example.net.",
            "/v1/routes?limit=1001",
            "/v1/routes?limit=-1",
            "/v1/routes?limit=abc",
            "/v1/routes?extra=1",
            "/v1/routes?after=NOT%20A%20HOST",
        ]) {
            const response = await call("GET", path);
            expect(response.status, path).toBe(400);
            expect(await response.text()).toBe('{"error":"invalid"}');
        }
        // URL parsing collapses an encoded dot segment to /v1/, which matches nothing.
        expect((await call("GET", "/v1/routes/%2e%2e")).status).toBe(404);
        const unknown = await call("GET", "/v1/routes/unknown.sites.example.net");
        expect(await unknown.json()).toMatchObject({ route: null });
    });

    it("loses authority at the commit: a rotated epoch is 401 and the 503 body is fixed text", async () => {
        const { call } = setup();
        await call("POST", "/v1/deployments", deployment(A, "a"));
        fixture.store.rotateAuthority({
            epoch: randomUUID(),
            token: randomBytes(32).toString("hex"),
        });
        const response = await call("POST", "/v1/routes", route("1", A));
        expect(response.status).toBe(401);
        expect(fixture.store.readRoute("view-site.sites.example.net").route).toBeNull();
        fixture.store.close();
        const closed = await call("GET", "/v1/routes");
        expect(closed.status).toBe(503);
        expect(await closed.text()).toBe('{"error":"unavailable"}');
    });
});
