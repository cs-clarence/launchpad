import { randomUUID } from "node:crypto";
import { createTestDatabase } from "@launchpad-kit/database/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
    beatHeartbeat,
    pruneHeartbeats,
    startHeartbeat,
    stopHeartbeat,
    type HeartbeatIdentity,
} from "../heartbeat";

let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
const identity = (name: string, beatSeconds = 15): HeartbeatIdentity => ({
    name,
    runId: randomUUID(),
    beatSeconds,
});
const rows = () => testDb.db.selectFrom("worker_heartbeat").selectAll().orderBy("name").execute();

beforeAll(async () => {
    testDb = await createTestDatabase();
    await testDb.migrate();
});
afterAll(async () => {
    await testDb?.destroy();
});
beforeEach(async () => {
    await testDb.db.deleteFrom("worker_heartbeat").execute();
});

describe("worker heartbeat rows", () => {
    it("updates the row in place when the same name starts again", async () => {
        const first = identity("w");
        await startHeartbeat(testDb.db, first, 60);
        const [before] = await rows();
        await stopHeartbeat(testDb.db, first);
        expect((await rows())[0]!.stopped_at).not.toBeNull();
        const second = identity("w");
        await sql`select pg_sleep(0.05)`.execute(testDb.db);
        await startHeartbeat(testDb.db, second, 60);
        const after = await rows();
        expect(after).toHaveLength(1);
        expect(after[0]).toMatchObject({ name: "w", run_id: second.runId, stopped_at: null });
        expect(after[0]!.started_at.getTime()).toBeGreaterThan(before!.started_at.getTime());
        expect(after[0]!.run_id).not.toBe(before!.run_id);
    });

    it("keeps one row per name", async () => {
        await startHeartbeat(testDb.db, identity("a"), 60);
        await startHeartbeat(testDb.db, identity("b"), 60);
        expect((await rows()).map((row) => row.name)).toEqual(["a", "b"]);
    });

    it("beats only its own run, and clears a stop mark", async () => {
        const mine = identity("w");
        await startHeartbeat(testDb.db, mine, 60);
        expect(await beatHeartbeat(testDb.db, mine)).toBe(true);
        expect(await beatHeartbeat(testDb.db, identity("w"))).toBe(false);
        expect(await beatHeartbeat(testDb.db, identity("gone"))).toBe(false);
        await stopHeartbeat(testDb.db, mine);
        expect((await rows())[0]!.stopped_at).not.toBeNull();
        await beatHeartbeat(testDb.db, mine);
        expect((await rows())[0]!.stopped_at).toBeNull();
    });

    it("lets a stale run neither beat nor stop the row of the run that replaced it", async () => {
        const old = identity("w");
        const current = identity("w");
        await startHeartbeat(testDb.db, old, 60);
        await startHeartbeat(testDb.db, current, 60);
        expect(await beatHeartbeat(testDb.db, old)).toBe(false);
        await stopHeartbeat(testDb.db, old);
        expect((await rows())[0]).toMatchObject({ run_id: current.runId, stopped_at: null });
    });

    it("reports another live run of the same name, and not a stopped or stale one", async () => {
        const first = identity("w");
        expect(await startHeartbeat(testDb.db, first, 60)).toEqual({ takenOver: false });
        expect(await startHeartbeat(testDb.db, identity("w"), 60)).toEqual({ takenOver: true });
        // A restart of the same run is not a takeover; a stopped one is not either.
        const run = identity("x");
        await startHeartbeat(testDb.db, run, 60);
        expect(await startHeartbeat(testDb.db, run, 60)).toEqual({ takenOver: false });
        const stopped = identity("y");
        await startHeartbeat(testDb.db, stopped, 60);
        await stopHeartbeat(testDb.db, stopped);
        expect(await startHeartbeat(testDb.db, identity("y"), 60)).toEqual({ takenOver: false });
        const stale = identity("z");
        await startHeartbeat(testDb.db, stale, 60);
        await sql`update worker_heartbeat set seen_at = clock_timestamp() - interval '10 minutes' where name = 'z'`.execute(
            testDb.db,
        );
        expect(await startHeartbeat(testDb.db, identity("z"), 60)).toEqual({ takenOver: false });
    });

    it("prunes only rows older than the age", async () => {
        for (const name of ["old", "recent", "fresh"]) {
            await startHeartbeat(testDb.db, identity(name), 60);
        }
        await sql`update worker_heartbeat set seen_at = clock_timestamp() - interval '8 days' where name = 'old'`.execute(
            testDb.db,
        );
        await sql`update worker_heartbeat set seen_at = clock_timestamp() - interval '6 days' where name = 'recent'`.execute(
            testDb.db,
        );
        expect(await pruneHeartbeats(testDb.db, 7 * 86_400)).toBe(1);
        expect((await rows()).map((row) => row.name)).toEqual(["fresh", "recent"]);
    });

    it("rejects a bad name and an out-of-range beat", async () => {
        await expect(startHeartbeat(testDb.db, identity("-bad"), 60)).rejects.toThrow();
        await expect(startHeartbeat(testDb.db, identity("has space"), 60)).rejects.toThrow();
        await expect(startHeartbeat(testDb.db, identity("a".repeat(65)), 60)).rejects.toThrow();
        await expect(startHeartbeat(testDb.db, identity("ok", 4), 60)).rejects.toThrow();
        await expect(startHeartbeat(testDb.db, identity("ok", 61), 60)).rejects.toThrow();
        await startHeartbeat(testDb.db, identity("ok5", 5), 60);
        await startHeartbeat(testDb.db, identity("ok60", 60), 60);
        expect(await rows()).toHaveLength(2);
    });
});
