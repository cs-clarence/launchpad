import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrationStatus, SchemaMismatchError } from "@launchpad-kit/database";
import { createTestDatabase } from "@launchpad-kit/database/testing";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertMigrateSafe, assertReadyForCheck, PreflightError } from "../preflight";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let dataDir: string;
beforeEach(async () => {
    database = await createTestDatabase();
    dataDir = mkdtempSync(path.join(tmpdir(), "preflight-db-"));
});
afterEach(async () => {
    await database.destroy();
    rmSync(dataDir, { recursive: true, force: true });
});

const withArchive = () => {
    const owner = path.join(dataDir, "artifacts", "a".repeat(32));
    mkdirSync(owner, { recursive: true });
    writeFileSync(path.join(owner, `${"b".repeat(64)}.tar.gz`), "x");
};
const tables = async () =>
    (
        await sql<{
            table_name: string;
        }>`select table_name from information_schema.tables where table_schema = 'public'`.execute(
            database.db,
        )
    ).rows;

describe("assertMigrateSafe", () => {
    it("refuses an empty database next to archives and changes nothing", async () => {
        withArchive();
        await expect(
            assertMigrateSafe({ db: database.db, dataDir, allowOrphanedData: false }),
        ).rejects.toThrow(PreflightError);
        expect(await tables()).toEqual([]);
        const status = await migrationStatus(database.db);
        expect(status.applied).toEqual([]);
        expect(status.pending.length).toBeGreaterThan(0);
    });

    it("passes with the override, and warns", async () => {
        withArchive();
        const result = await assertMigrateSafe({
            db: database.db,
            dataDir,
            allowOrphanedData: true,
        });
        expect(result.warning).toMatch(/at least 1 stored archive/);
    });

    it("passes for an empty database with an empty or missing data directory", async () => {
        expect(
            await assertMigrateSafe({ db: database.db, dataDir, allowOrphanedData: false }),
        ).toEqual({});
        expect(
            await assertMigrateSafe({
                db: database.db,
                dataDir: path.join(dataDir, "missing"),
                allowOrphanedData: false,
            }),
        ).toEqual({});
    });

    it("passes for a migrated database next to archives (an upgrade)", async () => {
        await database.migrate();
        withArchive();
        expect(
            await assertMigrateSafe({ db: database.db, dataDir, allowOrphanedData: false }),
        ).toEqual({});
    });
});

describe("assertReadyForCheck", () => {
    it("explains an unmigrated database and creates nothing", async () => {
        const error = await assertReadyForCheck(database.db).catch((e) => e);
        expect(error).toBeInstanceOf(SchemaMismatchError);
        expect(error.message).toMatch(/schema is behind/);
        expect(error.message).toMatch(/restore a backup/);
        expect(await tables()).toEqual([]);
    });

    it("passes for a migrated database", async () => {
        await database.migrate();
        await expect(assertReadyForCheck(database.db)).resolves.toBeUndefined();
    });
});
