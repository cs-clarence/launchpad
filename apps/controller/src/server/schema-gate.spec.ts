import { SchemaMismatchError } from "@launchpad-kit/database";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSchemaGate, SchemaCheckTimeoutError } from "./schema-gate";

const refused = Object.assign(new Error("Failed to connect"), {
    code: "ERR_POSTGRES_CONNECTION_REFUSED",
});

function setup(overrides: Partial<Parameters<typeof createSchemaGate>[0]> = {}) {
    const schema = vi.fn<() => Promise<void>>(async () => {});
    const directory = vi.fn<() => Promise<void>>(async () => {});
    const gate = createSchemaGate({
        checkSchema: schema,
        checkDataDirectory: directory,
        intervalMs: 10_000,
        retryMs: 3000,
        ...overrides,
    });
    return { gate, schema, directory };
}

beforeEach(() => {
    vi.useFakeTimers();
});
afterEach(() => {
    vi.useRealTimers();
});

describe("schema gate", () => {
    it("caches a pass for the interval and checks again after it", async () => {
        const { gate, schema } = setup();
        expect((await gate.check()).kind).toBe("ok");
        await vi.advanceTimersByTimeAsync(9_999);
        expect((await gate.check()).kind).toBe("ok");
        expect(schema).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(2);
        await gate.check();
        expect(schema).toHaveBeenCalledTimes(2);
    });

    it("treats a pass as final when the interval is null", async () => {
        const { gate, schema } = setup({ intervalMs: null });
        await gate.check();
        await vi.advanceTimersByTimeAsync(24 * 3600_000);
        expect((await gate.check()).kind).toBe("ok");
        expect(schema).toHaveBeenCalledTimes(1);
    });

    it("fails closed when a re-check of an expired pass fails, and recovers", async () => {
        const { gate, schema } = setup();
        await gate.check();
        schema.mockRejectedValueOnce(refused);
        await vi.advanceTimersByTimeAsync(10_000);
        expect((await gate.check()).kind).toBe("database-unavailable");
        // Within the retry window the failure is served without another query.
        expect((await gate.check()).kind).toBe("database-unavailable");
        expect(schema).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(3_000);
        expect((await gate.check()).kind).toBe("ok");
        expect(schema).toHaveBeenCalledTimes(3);
    });

    it("tells a schema mismatch from an unreachable database and from an unknown error", async () => {
        const mismatch = setup();
        mismatch.schema.mockRejectedValue(new SchemaMismatchError("behind"));
        expect((await mismatch.gate.check()).kind).toBe("schema-mismatch");
        const missing = setup();
        missing.schema.mockRejectedValue(Object.assign(new Error("x"), { errno: "42P01" }));
        expect((await missing.gate.check()).kind).toBe("schema-mismatch");
        const down = setup();
        down.schema.mockRejectedValue(refused);
        expect((await down.gate.check()).kind).toBe("database-unavailable");
        const odd = setup();
        const boom = new Error("boom");
        odd.schema.mockRejectedValue(boom);
        expect(await odd.gate.check()).toEqual({ kind: "failed", error: boom });
    });

    it("shares one check between concurrent callers", async () => {
        const { gate, schema } = setup();
        await Promise.all([gate.check(), gate.check(), gate.check()]);
        expect(schema).toHaveBeenCalledTimes(1);
    });

    it("invalidate makes the next check query again, even failures", async () => {
        const { gate, schema } = setup();
        await gate.check();
        gate.invalidate();
        await gate.check();
        expect(schema).toHaveBeenCalledTimes(2);
    });

    describe("data directory", () => {
        it("is checked on the first check, not on later traffic re-checks", async () => {
            const { gate, schema, directory } = setup();
            await gate.check();
            await vi.advanceTimersByTimeAsync(10_000);
            await gate.check();
            expect(schema).toHaveBeenCalledTimes(2);
            expect(directory).toHaveBeenCalledTimes(1);
        });

        it("is checked for readiness, and only reported there after the first pass", async () => {
            const { gate, directory } = setup();
            await gate.check();
            await vi.advanceTimersByTimeAsync(10_000);
            directory.mockRejectedValue(new Error("gone"));
            const ready = await gate.check({ includeDataDirectory: true });
            expect(ready.kind).toBe("unavailable");
            expect((await gate.check()).kind).toBe("ok");
        });

        it("makes the first check fail with `unavailable`, not a database outcome", async () => {
            const { gate, directory } = setup();
            directory.mockRejectedValue(new Error("no mount"));
            expect((await gate.check()).kind).toBe("unavailable");
        });

        it("reports an unrecognised data directory error as failed", async () => {
            const { gate, directory } = setup({ isDataDirectoryProblem: () => false });
            directory.mockRejectedValue(new Error("odd"));
            expect((await gate.check()).kind).toBe("failed");
        });

        it("is not run when the database stage failed", async () => {
            const { gate, schema, directory } = setup();
            schema.mockRejectedValue(refused);
            await gate.check({ includeDataDirectory: true });
            expect(directory).not.toHaveBeenCalled();
        });
    });

    describe("hard deadline", () => {
        it("answers database-unavailable at the deadline when the check never settles", async () => {
            const { gate, schema } = setup({ timeoutMs: 4000 });
            schema.mockImplementation(() => new Promise(() => {}));
            const pending = gate.check();
            await vi.advanceTimersByTimeAsync(3999);
            let settled = false;
            void pending.then(() => (settled = true));
            await vi.advanceTimersByTimeAsync(0);
            expect(settled).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            const outcome = await pending;
            expect(outcome.kind).toBe("database-unavailable");
            expect((outcome as { error: unknown }).error).toBeInstanceOf(SchemaCheckTimeoutError);
        });

        it("starts no second check while one is outstanding", async () => {
            const { gate, schema } = setup({ timeoutMs: 4000 });
            schema.mockImplementation(() => new Promise(() => {}));
            const first = gate.check();
            await vi.advanceTimersByTimeAsync(4000);
            await first;
            await vi.advanceTimersByTimeAsync(60_000);
            expect((await gate.check()).kind).toBe("database-unavailable");
            expect(schema).toHaveBeenCalledTimes(1);
        });

        it("accepts a late success as the next pass", async () => {
            const { gate, schema } = setup({ timeoutMs: 4000 });
            let finish: () => void = () => {};
            schema.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
            const first = gate.check();
            await vi.advanceTimersByTimeAsync(4000);
            expect((await first).kind).toBe("database-unavailable");
            finish();
            await vi.advanceTimersByTimeAsync(0);
            expect((await gate.check()).kind).toBe("ok");
            expect(schema).toHaveBeenCalledTimes(1);
        });

        it("lets a caller's shorter deadline answer first", async () => {
            const { gate, schema } = setup({ timeoutMs: 4000 });
            schema.mockImplementation(() => new Promise(() => {}));
            const pending = gate.check({ deadlineMs: 2000 });
            await vi.advanceTimersByTimeAsync(2000);
            expect((await pending).kind).toBe("database-unavailable");
        });
    });
});
