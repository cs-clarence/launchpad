import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrateToLatest } from "@launchpad-kit/database";
import { createTestDatabase } from "@launchpad-kit/database/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
    testDb = await createTestDatabase();
});
afterAll(async () => {
    await testDb.destroy();
});

const folderWith = async (files: Record<string, string>) => {
    const dir = await mkdtemp(path.join(tmpdir(), "lp-migrations-"));
    for (const [name, body] of Object.entries(files)) await writeFile(path.join(dir, name), body);
    return dir;
};

describe("migration loading rules", () => {
    it("fails when the folder holds no migrations", async () => {
        await expect(migrateToLatest(testDb.db, await folderWith({}))).rejects.toThrow(
            /No migrations/,
        );
    });

    it("fails when the folder is missing", async () => {
        await expect(
            migrateToLatest(testDb.db, "/nonexistent/launchpad-migrations"),
        ).rejects.toThrow();
    });

    it("fails on a file that exports no migration, such as a misspelled up", async () => {
        const dir = await folderWith({
            "20300101_001_ok.mjs": "export async function up() {}",
            "20300101_002_typo.mjs": "export async function upp() {}",
        });
        await expect(migrateToLatest(testDb.db, dir)).rejects.toThrow(
            /Unexpected file.*20300101_002_typo/,
        );
    });

    it("fails on an unexpected non-migration file", async () => {
        const dir = await folderWith({
            "20300101_001_ok.mjs": "export async function up() {}",
            "notes.txt": "hello",
        });
        await expect(migrateToLatest(testDb.db, dir)).rejects.toThrow(/Unexpected file.*notes.txt/);
    });
});
