import { randomUUID } from "node:crypto";
import { createTestDatabase } from "@launchpad-kit/database/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { statusSchema } from "@launchpad-kit/contracts";
import { getStatus, ServiceError, type Principal } from "../index";

let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
let operator: Principal;
let member: Principal;
let org = "";

beforeAll(async () => {
    testDb = await createTestDatabase();
    await testDb.migrate();
    const ids = { operator: randomUUID(), member: randomUUID() };
    for (const [name, id] of Object.entries(ids)) {
        await testDb.db
            .insertInto("user")
            .values({
                id,
                name,
                email: `${name}@example.com`,
                emailVerified: false,
                image: null,
                role: name === "operator" ? "operator" : "user",
            })
            .execute();
    }
    operator = { userId: ids.operator, instanceRole: "operator" };
    member = { userId: ids.member, instanceRole: "user" };
    org = randomUUID();
    await testDb.db
        .insertInto("organization")
        .values({ id: org, name: "Org", slug: "org", createdAt: new Date() })
        .execute();
});

afterAll(async () => {
    await testDb.destroy();
});

const artifact = (size: number, collected: boolean) =>
    testDb.db
        .insertInto("artifact")
        .values({
            organization_id: org,
            digest: randomUUID().replaceAll("-", "").padEnd(64, "0"),
            size_bytes: size,
            expanded_bytes: size,
            entry_count: 1,
            storage_key: `artifacts/${"b".repeat(32)}/${randomUUID()}`,
            created_by: operator.userId,
            collected_at: collected ? new Date() : null,
        })
        .execute();

describe("operator status", () => {
    it("is for the instance operator only", async () => {
        await expect(getStatus(testDb.db, member)).rejects.toBeInstanceOf(ServiceError);
        await expect(getStatus(testDb.db, member)).rejects.toMatchObject({ code: "forbidden" });
    });

    it("reports a ready database and no stored artifacts on a fresh instance", async () => {
        const status = await getStatus(testDb.db, operator);
        expect(status.dependencies).toEqual({ database: "ok" });
        expect(status.artifacts).toEqual({ stored: 0, bytes: 0 });
        expect(status.warnings).toEqual([]);
        expect(status.workers).toEqual({ state: "off", items: [] });
        expect(status.leases).toEqual({ inFlight: 0, expiring: 0, expired: 0 });
        expect(statusSchema.safeParse(status).success).toBe(true);
        expect(Number.isNaN(Date.parse(status.generatedAt))).toBe(false);
    });

    it("counts stored archives and leaves collected ones out", async () => {
        await artifact(100, false);
        await artifact(50, false);
        await artifact(9999, true);
        const status = await getStatus(testDb.db, operator);
        expect(status.artifacts).toEqual({ stored: 2, bytes: 150 });
    });
});

describe("worker heartbeats and leases in the status", () => {
    const thresholds = { staleAfterSeconds: 60, warnBeforeSeconds: 90 };
    const on = { deploymentsEnabled: true, thresholds };

    beforeEach(async () => {
        await testDb.db.deleteFrom("worker_heartbeat").execute();
    });

    // A heartbeat row `age` seconds old (database clock).
    const worker = (name: string, age: number, extra: { beat?: number; stopped?: boolean } = {}) =>
        sql`insert into worker_heartbeat (name, run_id, started_at, seen_at, stopped_at, beat_seconds)
            values (${name}, gen_random_uuid(), clock_timestamp() - interval '1 hour',
                clock_timestamp() - make_interval(secs => ${age}),
                ${extra.stopped ? sql`clock_timestamp()` : null}, ${extra.beat ?? 15})`.execute(
            testDb.db,
        );

    it("is off when deployments are off, whatever the table holds", async () => {
        await worker("w", 1);
        const status = await getStatus(testDb.db, operator, {
            deploymentsEnabled: false,
            thresholds,
        });
        expect(status.workers.state).toBe("off");
        expect(status.warnings).toEqual([]);
    });

    it("is missing with no rows, and warns even with nothing in flight", async () => {
        const status = await getStatus(testDb.db, operator, on);
        expect(status.workers).toEqual({ state: "missing", items: [] });
        expect(status.warnings).toEqual(["No deployment worker has reported yet."]);
    });

    it("is ok for a beating worker and lists it newest first", async () => {
        await worker("older", 30);
        await worker("newer", 2);
        const status = await getStatus(testDb.db, operator, on);
        expect(status.workers.state).toBe("ok");
        expect(status.workers.items.map((item) => [item.name, item.state])).toEqual([
            ["newer", "ok"],
            ["older", "ok"],
        ]);
        expect(status.workers.items[0]!.lastSeenSecondsAgo).toBeLessThan(10);
        expect(status.warnings).toEqual([]);
        expect(statusSchema.safeParse(status).success).toBe(true);
    });

    it("draws the stale line at the threshold, not at one beat", async () => {
        await worker("w", 59);
        expect((await getStatus(testDb.db, operator, on)).workers.state).toBe("ok");
        await testDb.db.deleteFrom("worker_heartbeat").execute();
        await worker("w", 65);
        const status = await getStatus(testDb.db, operator, on);
        expect(status.workers.state).toBe("stale");
        expect(status.workers.items[0]).toMatchObject({ name: "w", state: "stale" });
        expect(status.warnings).toEqual([
            expect.stringMatching(/^No deployment worker has reported for 6\d seconds\.$/),
        ]);
    });

    it("derives stopped from the stop mark, not from age", async () => {
        await worker("w", 5, { stopped: true });
        const status = await getStatus(testDb.db, operator, on);
        expect(status.workers.items[0]!.state).toBe("stopped");
        // A stopped worker is not a live one.
        expect(status.workers.state).toBe("stale");
        expect(status.warnings).toHaveLength(1);
    });

    it("keeps another live worker enough: a stale row beside it does not warn", async () => {
        await worker("gone", 3600);
        await worker("live", 3);
        const status = await getStatus(testDb.db, operator, on);
        expect(status.workers.state).toBe("ok");
        expect(status.warnings).toEqual([]);
    });

    it("raises the stale limit to three of that worker's own beats", async () => {
        // 100 s old: stale at the 60 s default, but a 60 s beat gives it 180 s.
        await worker("slow", 100, { beat: 60 });
        expect((await getStatus(testDb.db, operator, on)).workers.state).toBe("ok");
        await testDb.db.deleteFrom("worker_heartbeat").execute();
        await worker("slow", 200, { beat: 60 });
        expect((await getStatus(testDb.db, operator, on)).workers.state).toBe("stale");
    });

    it("lists at most 20 workers", async () => {
        for (let i = 0; i < 25; i++) await worker(`w${i}`, i + 1);
        const status = await getStatus(testDb.db, operator, on);
        expect(status.workers.items).toHaveLength(20);
        expect(status.workers.items[0]!.name).toBe("w0");
    });
});
