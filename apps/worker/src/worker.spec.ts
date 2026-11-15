import type { Database } from "@launchpad/database";
import type { DeployPorts } from "@launchpad/services";
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { runOnce, runWorker } from "./worker";

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
