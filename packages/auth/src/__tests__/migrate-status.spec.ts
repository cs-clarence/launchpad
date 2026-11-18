import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertSchemaCurrent, migrateToLatest, migrationStatus } from "@launchpad/database";
import { createTestDatabase } from "@launchpad/database/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
    testDb = await createTestDatabase();
});
afterAll(async () => {
    await testDb.destroy();
});

const folderWith = async (names: string[]) => {
    const dir = await mkdtemp(path.join(tmpdir(), "lp-status-"));
    for (const name of names)
        await writeFile(path.join(dir, name), "export async function up() {}");
    return dir;
};

describe("migration status and the schema guard", () => {
    it("lists everything as pending on an empty database without creating tables", async () => {
        const dir = await folderWith(["20300101_001_a.mjs", "20300101_002_b.mjs"]);
        const status = await migrationStatus(testDb.db, dir);
        expect(status).toEqual({
            applied: [],
            pending: ["20300101_001_a", "20300101_002_b"],
            unknown: [],
        });
        const present = await sql<{ present: boolean }>`
            select to_regclass('launchpad_migration') is not null as present`.execute(testDb.db);
        expect(present.rows[0]?.present).toBe(false);
        await expect(assertSchemaCurrent(testDb.db, dir)).rejects.toThrow(/behind.*2 migration/);
    });

    it("is current once migrated, and reports a database behind this build", async () => {
        const first = await folderWith(["20300101_001_a.mjs"]);
        await migrateToLatest(testDb.db, first);
        await expect(assertSchemaCurrent(testDb.db, first)).resolves.toBeUndefined();
        const both = await folderWith(["20300101_001_a.mjs", "20300101_002_b.mjs"]);
        const status = await migrationStatus(testDb.db, both);
        expect(status.applied).toEqual(["20300101_001_a"]);
        expect(status.pending).toEqual(["20300101_002_b"]);
        await expect(assertSchemaCurrent(testDb.db, both)).rejects.toThrow(
            /behind.*20300101_002_b.*launchpad-admin migrate/,
        );
    });

    it("refuses a database a newer build already migrated", async () => {
        const older = await folderWith(["20300101_001_a.mjs"]);
        await sql`insert into launchpad_migration (name, timestamp) values ('20300101_099_future', now()::text)`.execute(
            testDb.db,
        );
        const status = await migrationStatus(testDb.db, older);
        expect(status.unknown).toEqual(["20300101_099_future"]);
        await expect(assertSchemaCurrent(testDb.db, older)).rejects.toThrow(/newer Launchpad/);
    });
});
