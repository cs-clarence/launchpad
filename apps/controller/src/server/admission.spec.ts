import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { admit, probeOf, refusal } from "./admission";
import { createSchemaGate, type GateOutcome } from "./schema-gate";

const get = (path: string, method = "GET") =>
    new Request(`http://localhost:3000${path}`, { method });
const runtime = () => ({ runtime: true });
const gateOf = (outcome: GateOutcome) => ({ check: vi.fn(async () => outcome) });
const FAILURES = ["schema-mismatch", "database-unavailable", "unavailable", "failed"] as const;

describe("probeOf", () => {
    it("recognises only GET and HEAD of the two probes", () => {
        expect(probeOf(get("/api/health"))).toBe("health");
        expect(probeOf(get("/api/health", "HEAD"))).toBe("health");
        expect(probeOf(get("/api/ready"))).toBe("ready");
        expect(probeOf(get("/api/health", "POST"))).toBeNull();
        expect(probeOf(get("/api/v1/me"))).toBeNull();
    });
});

describe("admit", () => {
    it("serves every request when the gate passes", async () => {
        for (const path of ["/api/health", "/api/v1/me"]) {
            expect(await admit(get(path), { gate: gateOf({ kind: "ok" }), runtime })).toEqual({
                ok: true,
                runtime: { runtime: true },
            });
        }
    });

    it("never runs the gate for /api/ready: the route renders its own outcome", async () => {
        const gate = gateOf({ kind: "schema-mismatch", error: new Error("x") });
        expect((await admit(get("/api/ready"), { gate, runtime })).ok).toBe(true);
        expect(gate.check).not.toHaveBeenCalled();
    });

    it.each(FAILURES.filter((kind) => kind !== "schema-mismatch"))(
        "keeps /api/health 200 (liveness) when the gate says %s",
        async (kind) => {
            const gate = gateOf({ kind, error: new Error("x") });
            expect((await admit(get("/api/health"), { gate, runtime })).ok).toBe(true);
        },
    );

    it("keeps /api/health 503 for a proven schema mismatch, as before", async () => {
        const gate = gateOf({ kind: "schema-mismatch", error: new Error("x") });
        const result = await admit(get("/api/health"), { gate, runtime });
        if (result.ok) throw new Error("expected a refusal");
        expect((await refusal(result.failure).json()).code).toBe("schema-mismatch");
    });

    it.each(FAILURES)("refuses other routes when the gate says %s", async (kind) => {
        const gate = gateOf({ kind, error: new Error("x") });
        expect((await admit(get("/api/v1/me"), { gate, runtime })).ok).toBe(false);
    });

    it("asks the gate for health under a 2 s deadline", async () => {
        const gate = gateOf({ kind: "ok" });
        await admit(get("/api/health"), { gate, runtime });
        expect(gate.check).toHaveBeenCalledWith({ deadlineMs: 2000 });
    });
});

describe("refusal", () => {
    it("maps known problems to 503 and rethrows an unclassified failure (a 500, as before)", async () => {
        const response = refusal({ kind: "database-unavailable", error: new Error("secret") });
        expect(response.status).toBe(503);
        expect(response.headers.get("retry-after")).toBe("5");
        expect(await response.json()).toEqual({
            code: "database-unavailable",
            status: 503,
            title: "The database is unavailable.",
        });
        const boom = new Error("boom");
        expect(() => refusal({ kind: "failed", error: boom })).toThrow(boom);
    });
});

describe("with a hung database", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("still answers /api/health within 2 s and /api/ready's gate within its deadline", async () => {
        const gate = createSchemaGate({
            checkSchema: () => new Promise(() => {}),
            checkDataDirectory: async () => {},
            intervalMs: 10_000,
            retryMs: 3000,
            timeoutMs: 4000,
        });
        const health = admit(get("/api/health"), { gate, runtime });
        await vi.advanceTimersByTimeAsync(2000);
        expect((await health).ok).toBe(true);
        const ready = gate.check({ includeDataDirectory: true });
        await vi.advanceTimersByTimeAsync(2000);
        expect((await ready).kind).toBe("database-unavailable");
        const traffic = admit(get("/api/v1/me"), { gate, runtime });
        await vi.advanceTimersByTimeAsync(0);
        expect((await traffic).ok).toBe(false);
    });
});
