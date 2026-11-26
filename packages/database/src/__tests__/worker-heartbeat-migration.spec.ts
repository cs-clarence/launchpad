import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    assertSchemaCurrent,
    migrateToLatest,
    migrationStatus,
    SchemaMismatchError,
} from "../index";
import { createTestDatabase } from "../testing";

const FIRST = "20261124_001_initial_schema";
const SECOND = "20261126_002_worker_heartbeat";

// Every case gets its own database, so a focused run does not depend on an earlier case.
let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
beforeEach(async () => {
    testDb = await createTestDatabase();
});
afterEach(async () => {
    await testDb?.destroy();
});

const tableExists = async () =>
    (
        await sql<{
            found: boolean;
        }>`select to_regclass('public.worker_heartbeat') is not null as found`.execute(testDb.db)
    ).rows[0]!.found;

describe("the worker_heartbeat migration", () => {
    it("applies on an empty database after the baseline", async () => {
        expect((await migrationStatus(testDb.db)).pending).toEqual([FIRST, SECOND]);
        await testDb.migrate();
        expect((await migrationStatus(testDb.db)).applied).toEqual([FIRST, SECOND]);
        expect(await tableExists()).toBe(true);
    });

    it("applies on a database at the baseline and leaves its rows alone", async () => {
        await testDb.migrate();
        await sql`drop table worker_heartbeat`.execute(testDb.db);
        await sql`delete from launchpad_migration where name = ${SECOND}`.execute(testDb.db);
        await sql`insert into audit_event (actor, action, target_type, target_id) values ('t', 'a', 'x', '1')`.execute(
            testDb.db,
        );
        const status = await migrationStatus(testDb.db);
        expect(status.applied).toEqual([FIRST]);
        expect(status.pending).toEqual([SECOND]);
        await migrateToLatest(testDb.db);
        expect((await migrationStatus(testDb.db)).pending).toEqual([]);
        expect(
            (await sql`select * from audit_event where actor = 't'`.execute(testDb.db)).rows,
        ).toHaveLength(1);
        expect(await tableExists()).toBe(true);
    });

    it("constrains the name and the beat", async () => {
        await testDb.migrate();
        const insert = (name: string, beat: number) =>
            sql`insert into worker_heartbeat (name, run_id, started_at, seen_at, beat_seconds)
                values (${name}, gen_random_uuid(), now(), now(), ${beat})`.execute(testDb.db);
        await expect(insert("-bad", 15)).rejects.toThrow();
        await expect(insert("ok", 4)).rejects.toThrow();
        await expect(insert("ok", 61)).rejects.toThrow();
        await insert("ok-1.a_b", 5);
        await insert("ok-2", 60);
        await sql`delete from worker_heartbeat`.execute(testDb.db);
    });

    it("makes a build that does not know it refuse the database (the rollback gate)", async () => {
        await testDb.migrate();
        const folder = await fs.mkdtemp(path.join(os.tmpdir(), "lp-older-build-"));
        try {
            await fs.writeFile(path.join(folder, `${FIRST}.mjs`), "export async function up() {}");
            await expect(assertSchemaCurrent(testDb.db, folder)).rejects.toThrow(
                SchemaMismatchError,
            );
            await expect(assertSchemaCurrent(testDb.db, folder)).rejects.toThrow(SECOND);
        } finally {
            await fs.rm(folder, { recursive: true, force: true });
        }
    });
});
