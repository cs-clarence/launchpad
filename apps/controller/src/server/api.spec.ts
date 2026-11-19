import { createAuth, loadAuthConfig } from "@launchpad-kit/auth";
import { createDatabase } from "@launchpad-kit/database";
import { describe, expect, it } from "vitest";
import { createApi } from "./api";
import { resolveClientIp } from "./client-ip";

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
    artifacts: { dataDir: "/nonexistent-launchpad-test" },
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
