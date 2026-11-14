import { promises as fs } from "node:fs";
import path from "node:path";
import type { Kysely } from "kysely";
import { FileMigrationProvider, Migrator } from "kysely/migration";

// Every migration is one file in `./migrations`, named `<ISO date>_<sequence>_<what>`
// and exporting `up`. Adding a migration is adding a file; there is no list to
// forget. The folder holds migrations only: a file that exports no migration (a
// misspelled `up`, say) is an error, and so is a folder with none, so a migration
// can never be skipped silently. Kysely orders by name and refuses a new
// migration that sorts before one already applied. Migrations are read from the
// source folder at run time, so the module must run from source or ship the
// folder (see docs/plans/application.md, milestone 6).
const defaultFolder = path.join(import.meta.dirname, "migrations");

// Forward-only: no down migrations exist, and nothing runs them automatically.
// `folder` exists for tests of the loading rules.
export async function migrateToLatest(db: Kysely<any>, folder = defaultFolder) {
    const migrator = new Migrator({
        db,
        provider: new FileMigrationProvider({
            fs,
            path,
            migrationFolder: folder,
            onFileIgnored(fileName, reason) {
                throw new Error(
                    `Unexpected file in the migrations folder: ${fileName} (${reason})`,
                );
            },
        }),
        migrationTableName: "launchpad_migration",
        migrationLockTableName: "launchpad_migration_lock",
    });
    const known = await migrator.getMigrations().catch((error) => {
        throw error instanceof Error ? error : new Error(String(error));
    });
    if (known.length === 0) {
        throw new Error(`No migrations were found in ${folder}.`);
    }
    const { error, results } = await migrator.migrateToLatest();
    if (error) {
        throw error instanceof Error ? error : new Error(String(error));
    }
    return (results ?? []).map((r) => ({ name: r.migrationName, status: r.status }));
}
