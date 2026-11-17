import type { Database } from "@launchpad/database";
import type { DeployPorts } from "@launchpad/services";
import {
    Kysely,
    PostgresAdapter,
    PostgresIntrospector,
    PostgresQueryCompiler,
    type DatabaseConnection,
    type Driver,
} from "kysely";
import { describe, expect, it } from "vitest";
import { getEventListeners } from "node:events";
import { runOnce, runWorker, sleep } from "./worker";

const ports = {} as DeployPorts;
// A database that must never be touched, or one that always fails.
const untouched = new Proxy(
    {},
    {
        get: () => {
            throw new Error("touched");
        },
    },
) as Kysely<Database>;
const broken = {
    transaction: () => ({
        execute: async () => {
            throw new Error("db down: password=hunter2");
        },
    }),
} as unknown as Kysely<Database>;

describe("the worker loop", () => {
    it("claims nothing while the feature is off, without touching the database", async () => {
        const result = await runOnce(untouched, ports, {
            owner: "w",
            deps: { enabled: false },
            leaseMs: 60_000,
            signal: new AbortController().signal,
        });
        expect(result).toBe("idle");
    });

    it("survives a database failure, logs no detail, and stops when asked", async () => {
        const controller = new AbortController();
        const lines: Record<string, unknown>[] = [];
        const done = runWorker(broken, ports, {
            owner: "w",
            deps: { enabled: true },
            leaseMs: 60_000,
            pollMs: 100,
            signal: controller.signal,
            log: (line) => lines.push(line),
        });
        setTimeout(() => controller.abort(), 300);
        await done;
        expect(lines).toEqual([{ event: "worker-error" }]);
        expect(JSON.stringify(lines)).not.toContain("hunter2");
    });

    it("does not wait out the poll interval when stopped before it starts, or leak listeners", async () => {
        const aborted = new AbortController();
        aborted.abort();
        const started = Date.now();
        await sleep(60_000, aborted.signal);
        expect(Date.now() - started).toBeLessThan(1000);

        const live = new AbortController();
        for (let i = 0; i < 20; i++) await sleep(1, live.signal);
        expect(getEventListeners(live.signal, "abort")).toHaveLength(0);
    });

    it("stops promptly when idle", async () => {
        const controller = new AbortController();
        const done = runWorker(untouched, ports, {
            owner: "w",
            deps: { enabled: false },
            leaseMs: 60_000,
            pollMs: 60_000,
            signal: controller.signal,
        });
        setTimeout(() => controller.abort(), 100);
        const started = Date.now();
        await done;
        expect(Date.now() - started).toBeLessThan(3000);
    });
});

// A database that records what it is asked, and can be made to fail.
function recordingDb() {
    const state = { statements: [] as string[], fail: false, slowOthers: false };
    const connection: DatabaseConnection = {
        executeQuery: async (query) => {
            state.statements.push(query.sql);
            if (state.slowOthers && !query.sql.includes("worker_heartbeat")) {
                await new Promise((resolve) => setTimeout(resolve, 250));
                throw new Error("gave up");
            }
            if (state.fail) throw new Error("db down: password=hunter2");
            return { rows: [] };
        },
        streamQuery: () => {
            throw new Error("not used");
        },
    };
    const driver: Driver = {
        init: async () => {},
        acquireConnection: async () => connection,
        beginTransaction: async () => {},
        commitTransaction: async () => {},
        rollbackTransaction: async () => {},
        releaseConnection: async () => {},
        destroy: async () => {},
    };
    const db = new Kysely<Database>({
        dialect: {
            createAdapter: () => new PostgresAdapter(),
            createDriver: () => driver,
            createIntrospector: (k) => new PostgresIntrospector(k),
            createQueryCompiler: () => new PostgresQueryCompiler(),
        },
    });
    return { db, state };
}

describe("the worker's heartbeat", () => {
    const run = async (
        db: Kysely<Database>,
        over: Partial<Parameters<typeof runWorker>[2]>,
        forMs: number,
    ) => {
        const controller = new AbortController();
        const lines: Record<string, unknown>[] = [];
        const done = runWorker(db, ports, {
            owner: "w-test",
            deps: { enabled: false },
            leaseMs: 60_000,
            pollMs: 5,
            signal: controller.signal,
            log: (line) => lines.push(line),
            ...over,
        });
        setTimeout(() => controller.abort(), forMs);
        await done;
        return lines;
    };
    const beats = (statements: string[]) =>
        statements.filter((sql) => sql.startsWith("insert") && sql.includes("worker_heartbeat"))
            .length;

    it("writes at the start and then on its own timer, not on every poll", async () => {
        const { db, state } = recordingDb();
        await run(db, { heartbeat: { version: "9.9.9", everyMs: 60 } }, 400);
        // The loop polled dozens of times; the beats follow the timer.
        expect(beats(state.statements)).toBeGreaterThanOrEqual(3);
        expect(beats(state.statements)).toBeLessThanOrEqual(9);
        expect(
            state.statements.some(
                (sql) => sql.startsWith("delete") && sql.includes("worker_heartbeat"),
            ),
        ).toBe(true);
    });

    it("writes nothing when it is not asked to", async () => {
        const { db, state } = recordingDb();
        await run(db, {}, 100);
        expect(state.statements).toEqual([]);
    });

    it("beats while a long deployment runs, because the timer is not the loop", async () => {
        const { db, state } = recordingDb();
        // Everything but a heartbeat is held for most of the run, as a long deployment is.
        state.slowOthers = true;
        await run(db, { deps: { enabled: true }, heartbeat: { version: "1", everyMs: 40 } }, 300);
        expect(beats(state.statements)).toBeGreaterThanOrEqual(3);
    });

    it("reports a failed beat without detail, and the work goes on", async () => {
        const { db, state } = recordingDb();
        state.fail = true;
        const lines = await run(db, { heartbeat: { version: "1", everyMs: 40 } }, 250);
        expect(lines.filter((l) => l.event === "heartbeat-error").length).toBeGreaterThanOrEqual(2);
        expect(JSON.stringify(lines)).not.toContain("hunter2");
        // And it was still running (the loop did not die with the first failure).
        expect(lines.every((l) => l.event === "heartbeat-error")).toBe(true);
    });
});
