import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    assertSchemaCurrent,
    migrateToLatest,
    migrationStatus,
    SchemaMismatchError,
} from "@launchpad/database";
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

const folders: string[] = [];
afterAll(async () => {
    await Promise.all(folders.map((dir) => rm(dir, { recursive: true, force: true })));
});

const folderWith = async (names: string[]) => {
    const dir = await mkdtemp(path.join(tmpdir(), "lp-status-"));
    folders.push(dir);
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
        await migrateToLatest(testDb.db, older);
        await sql`insert into launchpad_migration (name, timestamp) values ('20300101_099_future', now()::text)`.execute(
            testDb.db,
        );
        const status = await migrationStatus(testDb.db, older);
        expect(status.unknown).toEqual(["20300101_099_future"]);
        await expect(assertSchemaCurrent(testDb.db, older)).rejects.toThrow(SchemaMismatchError);
        await expect(assertSchemaCurrent(testDb.db, older)).rejects.toThrow(/newer Launchpad/);
    });

    it("reports unknown and pending migrations together", async () => {
        const both = await folderWith(["20300101_001_a.mjs", "20300101_002_b.mjs"]);
        const status = await migrationStatus(testDb.db, both);
        expect(status.pending).toEqual(["20300101_002_b"]);
        expect(status.unknown).toEqual(["20300101_099_future"]);
    });

    it("applies the same naming rules as migrate: a stray or misnamed file is an error", async () => {
        const stray = await folderWith(["20300101_001_a.mjs", "notes.txt"]);
        await expect(migrationStatus(testDb.db, stray)).rejects.toThrow(
            /Unexpected file.*notes.txt/,
        );
        const misnamed = await folderWith(["20300101_001_a.mjs", "20300101_2_b.mjs"]);
        await expect(migrationStatus(testDb.db, misnamed)).rejects.toThrow(/Unexpected file.*_2_b/);
        await expect(migrateToLatest(testDb.db, misnamed)).rejects.toThrow(/Unexpected file.*_2_b/);
    });

    it("finds the migrations folder from LAUNCHPAD_MIGRATIONS_DIR", async () => {
        const dir = await folderWith(["20300101_001_a.mjs"]);
        const before = process.env.LAUNCHPAD_MIGRATIONS_DIR;
        process.env.LAUNCHPAD_MIGRATIONS_DIR = dir;
        try {
            expect((await migrationStatus(testDb.db)).applied).toEqual(["20300101_001_a"]);
        } finally {
            if (before === undefined) delete process.env.LAUNCHPAD_MIGRATIONS_DIR;
            else process.env.LAUNCHPAD_MIGRATIONS_DIR = before;
        }
    });
});
