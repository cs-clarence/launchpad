import { describe, expect, it } from "vitest";
import { checkHealth, healthUrl } from "./healthcheck";

describe("healthUrl", () => {
    it("targets the control listener on loopback even when it binds a wildcard", () => {
        expect(healthUrl({ host: "0.0.0.0", port: 8081 })).toBe("http://127.0.0.1:8081/healthz");
        expect(healthUrl({ host: "::", port: 8081 })).toBe("http://[::1]:8081/healthz");
        expect(healthUrl({ host: "::1", port: 9 })).toBe("http://[::1]:9/healthz");
        expect(healthUrl({ host: "10.0.0.5", port: 1 })).toBe("http://10.0.0.5:1/healthz");
        expect(healthUrl({ host: "localhost", port: 1 })).toBe("http://localhost:1/healthz");
    });
});

describe("checkHealth", () => {
    const answer = (status: number, body: unknown): typeof fetch =>
        (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    const control = { host: "127.0.0.1", port: 1 };

    it("is healthy only for a 200 with status ok", async () => {
        expect(await checkHealth(control, answer(200, { status: "ok" }))).toBe(true);
        expect(await checkHealth(control, answer(503, { status: "unavailable" }))).toBe(false);
        expect(await checkHealth(control, answer(200, { status: "unavailable" }))).toBe(false);
        expect(await checkHealth(control, answer(200, {}))).toBe(false);
        expect(await checkHealth(control, answer(302, { status: "ok" }))).toBe(false);
    });

    it("is unhealthy when the request fails, is not JSON, or times out", async () => {
        const failing = (async () => {
            throw new Error("refused");
        }) as unknown as typeof fetch;
        expect(await checkHealth(control, failing)).toBe(false);
        const notJson = (async () =>
            new Response("<html>", { status: 200 })) as unknown as typeof fetch;
        expect(await checkHealth(control, notJson)).toBe(false);
        const hanging = ((_: unknown, init?: RequestInit) =>
            new Promise((_, reject) => {
                init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            })) as unknown as typeof fetch;
        expect(await checkHealth(control, hanging, 50)).toBe(false);
    });
});
