import { createAuth, loadAuthConfig } from "@launchpad-kit/auth";
import { errorSchema } from "@launchpad-kit/contracts";
import { createDatabase } from "@launchpad-kit/database";
import { describe, expect, it } from "vitest";
import { createApi } from "./api";
import { resolveClientIp } from "./client-ip";
import type { GateOutcome } from "./schema-gate";

const config = loadAuthConfig({
    LAUNCHPAD_AUTH_SECRET: "test-secret-".repeat(4),
    LAUNCHPAD_BASE_URL: "http://localhost:3000",
});
// The pool is never queried here: these routes are answered before any database use.
const db = createDatabase("postgres://unused@127.0.0.1:1/unused");
const auth = createAuth({ db, config });
const invitations = {
    enabled: false,
    mailer: null,
    baseUrl: config.baseUrl,
    publicSignup: false,
    hashPassword: async (password: string) => password,
};
const api = createApi({
    auth,
    db,
    origin: config.origin,
    invitations,
});

describe("controller HTTP adapter", () => {
    it("delegates the scaffold health response to the service", async () => {
        const response = await api.fetch(new Request("http://localhost:3000/api/health"));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ name: "launchpad", phase: "bootstrap" });
    });

    it("has no deployment endpoint", async () => {
        const response = await api.fetch(
            new Request("http://localhost:3000/api/deployments", { method: "POST" }),
        );
        expect(response.status).toBe(404);
    });

    it("rejects an unauthenticated /me request", async () => {
        const response = await api.fetch(new Request("http://localhost:3000/api/v1/me"));
        expect(response.status).toBe(401);
    });

    it("rejects cookie-bearing mutations from another origin, including a sibling host", async () => {
        for (const origin of [
            "https://evil.example.net",
            "http://preview-ab12.localhost:3000",
            null,
        ]) {
            const headers: Record<string, string> = { cookie: "x=1" };
            if (origin) headers.origin = origin;
            const response = await api.fetch(
                new Request("http://localhost:3000/api/v1/anything", { method: "POST", headers }),
            );
            expect(response.status).toBe(403);
        }
    });
});

describe("request body limits", () => {
    const post = (headers: Record<string, string>, body = "{}") =>
        api.fetch(
            new Request("http://localhost:3000/api/v1/organizations", {
                method: "POST",
                // A real HTTP client declares the body's length; tests override it to probe.
                headers: {
                    "content-type": "application/json",
                    "content-length": String(new TextEncoder().encode(body).length),
                    ...headers,
                },
                body,
            }),
        );

    it("refuses oversized bodies before reading them", async () => {
        const big = JSON.stringify({ name: "x".repeat(70 * 1024) });
        // A real HTTP client always declares the length (or is chunked, refused below).
        expect((await post({ "content-length": String(big.length) }, big)).status).toBe(413);
        expect((await post({ "content-length": "999999" })).status).toBe(413);
    });

    it("refuses chunked or malformed lengths", async () => {
        for (const value of ["chunked", "Chunked", "gzip, chunked", "CHUNKED"]) {
            expect((await post({ "transfer-encoding": value })).status, value).toBe(411);
        }
        expect((await post({ "content-length": "-5" })).status).toBe(411);
    });

    it("refuses a body that arrives with no declared length at all", async () => {
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode("{}"));
                controller.close();
            },
        });
        const response = await api.fetch(
            new Request("http://localhost:3000/api/v1/organizations", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: stream,
                // @ts-expect-error `duplex` is required for streamed bodies but missing from the DOM types
                duplex: "half",
            }),
        );
        expect(response.status).toBe(411);
    });

    it("does not require a length for a request that has no body", async () => {
        const response = await api.fetch(
            new Request("http://localhost:3000/api/v1/organizations/x/members/y", {
                method: "DELETE",
            }),
        );
        expect(response.status).toBe(401);
    });

    it("lets ordinary small bodies through to authentication", async () => {
        expect((await post({})).status).toBe(401);
    });
});

describe("client address resolution", () => {
    it("ignores X-Forwarded-For unless a proxy is trusted", () => {
        expect(
            resolveClientIp({ forwardedFor: "1.2.3.4", socketIp: "10.0.0.9", trustedProxy: false }),
        ).toBe("10.0.0.9");
    });

    it("takes the address appended by the single trusted proxy, not a client-chosen one", () => {
        expect(
            resolveClientIp({
                forwardedFor: "6.6.6.6, 203.0.113.7",
                socketIp: "10.0.0.9",
                trustedProxy: true,
            }),
        ).toBe("203.0.113.7");
    });

    it("falls back to the socket address and returns null when nothing is known", () => {
        expect(
            resolveClientIp({ forwardedFor: null, socketIp: "10.0.0.9", trustedProxy: true }),
        ).toBe("10.0.0.9");
        expect(
            resolveClientIp({ forwardedFor: null, socketIp: null, trustedProxy: true }),
        ).toBeNull();
    });
});

describe("OpenAPI document", () => {
    const documented = createApi({ auth, db, origin: config.origin, invitations, docs: true });
    const PAGINATED = [
        "/api/v1/organizations/{orgId}/apps",
        "/api/v1/organizations/{orgId}/projects",
        "/api/v1/organizations/{orgId}/invitations",
        "/api/v1/organizations/{orgId}/apps/{appId}/aliases",
        "/api/v1/organizations",
        "/api/v1/organizations/{orgId}/members",
        "/api/v1/organizations/{orgId}/api-keys",
        "/api/v1/organizations/{orgId}/apps/{appId}/deployments",
        "/api/v1/organizations/{orgId}/aliases/{aliasId}/operations",
    ];

    it("lists limit, cursor, the Link header and 422 on each paginated route", async () => {
        const response = await documented.fetch(
            new Request("http://localhost:3000/api/openapi/json"),
        );
        expect(response.status).toBe(200);
        const doc = (await response.json()) as {
            paths: Record<string, { get?: Record<string, any> }>;
        };
        for (const route of PAGINATED) {
            const operation = doc.paths[route]!.get!;
            const parameters = operation.parameters as { name: string; schema: any }[];
            const limit = parameters.find((p) => p.name === "limit")!;
            expect(limit.schema).toMatchObject({ type: "integer", minimum: 1, maximum: 100 });
            expect(parameters.map((p) => p.name)).toContain("cursor");
            expect(operation.responses["200"].headers.Link).toBeDefined();
            expect(operation.responses["422"]).toBeDefined();
        }
    });

    it("leaves query validation to the services", async () => {
        const query = "limit=1&limit=2&cursor=%00&cursor=x";
        const response = await documented.fetch(
            new Request(`http://localhost:3000/api/v1/organizations/o/apps?${query}`),
        );
        expect(response.status).toBe(401);
    });

    it("documents the events route's after, limit and Link", async () => {
        const response = await documented.fetch(
            new Request("http://localhost:3000/api/openapi/json"),
        );
        const doc = (await response.json()) as { paths: Record<string, { get?: any }> };
        const operation =
            doc.paths["/api/v1/organizations/{orgId}/deployments/{deploymentId}/events"]!.get;
        const names = operation.parameters.map((p: { name: string }) => p.name);
        expect(names).toEqual(expect.arrayContaining(["after", "limit"]));
        expect(operation.responses["200"].headers.Link).toBeDefined();
    });
});

describe("database problems", () => {
    const refused = Object.assign(new Error("Failed to connect to 127.0.0.1:5432"), {
        code: "ERR_POSTGRES_CONNECTION_REFUSED",
    });
    const missingTable = Object.assign(new Error('relation "secret_table" does not exist'), {
        code: "ERR_POSTGRES_SERVER_ERROR",
        errno: "42P01",
    });
    // A database whose every query fails with the given error.
    const failingDb = (error: unknown) =>
        new Proxy(
            {},
            {
                get() {
                    return () => {
                        throw error;
                    };
                },
            },
        ) as unknown as typeof db;
    const apiWith = (error: unknown, extra: Partial<Parameters<typeof createApi>[0]> = {}) =>
        createApi({ auth, db: failingDb(error), origin: config.origin, invitations, ...extra });
    const keyRequest = () =>
        new Request("http://localhost:3000/api/v1/organizations", {
            headers: { authorization: "Bearer lp_deadbeefdeadbeef_secret" },
        });

    it("answers 503 database-unavailable with Retry-After and no error text", async () => {
        const response = await apiWith(refused).fetch(keyRequest());
        expect(response.status).toBe(503);
        expect(response.headers.get("retry-after")).toBe("5");
        const body = errorSchema.parse(await response.json());
        expect(body).toEqual({
            code: "database-unavailable",
            status: 503,
            title: "The database is unavailable.",
        });
    });

    it("answers 503 schema-mismatch for a missing table and asks for a new check", async () => {
        let invalidated = 0;
        const response = await apiWith(missingTable, { onSchemaError: () => invalidated++ }).fetch(
            keyRequest(),
        );
        expect(response.status).toBe(503);
        const text = await response.text();
        expect(errorSchema.parse(JSON.parse(text)).code).toBe("schema-mismatch");
        expect(text).not.toContain("secret_table");
        expect(invalidated).toBe(1);
    });

    it("leaves an unclassified error to the framework's own 500", async () => {
        const response = await apiWith(new Error("boom")).fetch(keyRequest());
        expect(response.status).toBe(500);
        expect(response.headers.get("retry-after")).toBeNull();
    });

    it("maps failures outside execute (sign-in throttling) through the root hook", async () => {
        const body = JSON.stringify({ email: "a@example.com", password: "x" });
        const response = await apiWith(refused).fetch(
            new Request("http://localhost:3000/api/auth/sign-in/email", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "content-length": String(new TextEncoder().encode(body).length),
                    "x-launchpad-client-ip": "203.0.113.9",
                },
                body,
            }),
        );
        expect(response.status).toBe(503);
        expect(errorSchema.parse(await response.json()).code).toBe("database-unavailable");
    });

    it("uses the real driver's refused-connection error", async () => {
        const unreachable = createDatabase("postgres://postgres:x@127.0.0.1:1/x", {
            connectionTimeout: 1,
        });
        const response = await createApi({
            auth: createAuth({ db: unreachable, config }),
            db: unreachable,
            origin: config.origin,
            invitations,
        }).fetch(keyRequest());
        expect(response.status).toBe(503);
        expect(errorSchema.parse(await response.json()).code).toBe("database-unavailable");
        await unreachable.destroy();
    });
});

describe("GET /api/ready", () => {
    const readyWith = (outcome: GateOutcome) =>
        createApi({
            auth,
            db,
            origin: config.origin,
            invitations,
            readiness: async () => outcome,
        }).fetch(new Request("http://localhost:3000/api/ready"));

    it("answers 200 when ready, without a sign-in", async () => {
        const response = await readyWith({ kind: "ok" });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ status: "ready" });
    });

    it.each([
        ["schema-mismatch", 503, "schema-mismatch"],
        ["database-unavailable", 503, "database-unavailable"],
        ["unavailable", 503, "unavailable"],
        ["failed", 503, "unavailable"],
    ] as const)("answers %s as a stable 503 %s and no detail", async (kind, status, code) => {
        const secret = "postgres://user:hunter2@db.internal:5432/launchpad";
        const response = await readyWith({ kind, error: new Error(secret) });
        expect(response.status).toBe(status);
        const text = await response.text();
        expect(errorSchema.parse(JSON.parse(text)).code).toBe(code);
        expect(text).not.toContain("hunter2");
        expect(response.headers.get("retry-after")).toBe(
            kind === "database-unavailable" ? "5" : null,
        );
    });

    it("is documented as a public operation", async () => {
        const documented = createApi({ auth, db, origin: config.origin, invitations, docs: true });
        const doc = (await (
            await documented.fetch(new Request("http://localhost:3000/api/openapi/json"))
        ).json()) as { paths: Record<string, { get?: { security?: unknown[]; responses: any } }> };
        const operation = doc.paths["/api/ready"]!.get!;
        expect(operation.security).toEqual([]);
        expect(operation.responses["503"]).toBeDefined();
    });
});
