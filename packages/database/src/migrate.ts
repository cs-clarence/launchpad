import { promises as fs, readdirSync } from "node:fs";
import path from "node:path";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { FileMigrationProvider, Migrator } from "kysely/migration";

// Every migration is one file in a `migrations` folder, named `<ISO date>_<sequence>_<what>`
// and exporting `up`. Adding a migration is adding a file; there is no list to
// forget. The folder holds migrations only: a file that exports no migration (a
// misspelled `up`, say) is an error, and so is a folder with none, so a migration
// can never be skipped silently. Kysely orders by name and refuses a new
// migration that sorts before one already applied.
//
// Migrations are read from disk at run time. From source the folder sits next to this file;
// a built controller ships its migrations, bundled, next to its bundle, so the
// folder is searched for in this file's directory and the few above it.
// LAUNCHPAD_MIGRATIONS_DIR names one explicitly. See docs/plans/milestone-6-release.md.
function looksLikeMigrations(dir: string) {
    try {
        return readdirSync(dir).some((name) => /^\d{8}_\d{3}_/.test(name));
    } catch {
        return false;
    }
}

function defaultMigrationsFolder() {
    const explicit = process.env.LAUNCHPAD_MIGRATIONS_DIR;
    if (explicit) return path.resolve(explicit);
    let dir = import.meta.dirname;
    for (let depth = 0; depth < 4; depth++) {
        const candidate = path.join(dir, "migrations");
        if (looksLikeMigrations(candidate)) return candidate;
        dir = path.dirname(dir);
    }
    return path.join(import.meta.dirname, "migrations");
}

// Shared with testing.ts so migration fixtures use production loading/locking settings.
// Internal to this package (not re-exported from its public entry point).
export function createMigrator(db: Kysely<any>, folder: string) {
    return new Migrator({
        db,
        provider: new FileMigrationProvider({
            fs,
            path,
            migrationFolder: folder,
            onFileIgnored(fileName, reason) {
                // Declaration files may sit beside the migrations; status skips them too.
                if (/\.d\.[cm]?ts$/.test(fileName)) return;
                throw new Error(
                    `Unexpected file in the migrations folder: ${fileName} (${reason})`,
                );
            },
        }),
        migrationTableName: "launchpad_migration",
        migrationLockTableName: "launchpad_migration_lock",
    });
}

// Raised when the database and this build disagree about the schema (as opposed to the
// database being unreachable): the one failure an operator fixes with `migrate` or a restore.
export class SchemaMismatchError extends Error {
    override name = "SchemaMismatchError";
}

async function knownMigrations(migrator: Migrator, folder: string) {
    const known = await migrator.getMigrations().catch((error) => {
        throw error instanceof Error ? error : new Error(String(error));
    });
    if (known.length === 0) {
        throw new Error(`No migrations were found in ${folder}.`);
    }
    return known;
}

// Forward-only: no down migrations exist, and nothing runs them automatically.
// `folder` exists for tests of the loading rules.
export async function migrateToLatest(db: Kysely<any>, folder = defaultMigrationsFolder()) {
    // The same naming rules the status check applies, so the two cannot disagree.
    listMigrationNames(folder);
    const migrator = createMigrator(db, folder);
    await knownMigrations(migrator, folder);
    const { error, results } = await migrator.migrateToLatest();
    if (error) {
        throw error instanceof Error ? error : new Error(String(error));
    }
    return (results ?? []).map((r) => ({ name: r.migrationName, status: r.status }));
}

// The names only, read without loading any migration's code: a built artifact ships the files
// but a status check must not need their imports. Matches Kysely's naming (the file name
// without its extension); `migrateToLatest` still enforces the loading rules.
function listMigrationNames(folder: string) {
    const names = readdirSync(folder)
        .filter((file) => !/\.d\.[cm]?ts$/.test(file))
        .map((file) => {
            const name = /^(\d{8}_\d{3}_.+)\.(?:[cm]?[tj]s)$/.exec(file)?.[1];
            if (name === undefined) {
                throw new Error(
                    `Unexpected file in the migrations folder: ${file} (a migration is named <date>_<three digits>_<what> with a script extension)`,
                );
            }
            return name;
        })
        .sort();
    if (names.length === 0) {
        throw new Error(`No migrations were found in ${folder}.`);
    }
    return names;
}

export interface MigrationStatus {
    // Applied and present in this build.
    applied: string[];
    // Present in this build but not yet applied.
    pending: string[];
    // Applied to the database but unknown to this build: it was migrated by a newer one.
    unknown: string[];
}

// Read-only: never creates the migration tables and never applies anything.
export async function migrationStatus(
    db: Kysely<any>,
    folder = defaultMigrationsFolder(),
): Promise<MigrationStatus> {
    const known = listMigrationNames(folder).map((name) => ({ name }));
    const exists = await sql<{ present: boolean }>`
        select to_regclass('launchpad_migration') is not null as present`.execute(db);
    const recorded = exists.rows[0]?.present
        ? (
              await sql<{
                  name: string;
              }>`select name from launchpad_migration order by name`.execute(db)
          ).rows.map((row) => row.name)
        : [];
    const names = new Set(known.map((m) => m.name));
    const done = new Set(recorded);
    return {
        applied: known.filter((m) => done.has(m.name)).map((m) => m.name),
        pending: known.filter((m) => !done.has(m.name)).map((m) => m.name),
        unknown: recorded.filter((name) => !names.has(name)),
    };
}

// A process refuses to run against a schema it was not built for: a database that is behind
// (run `launchpad-admin migrate`, after a backup) or one a newer build has already migrated.
export async function assertSchemaCurrent(db: Kysely<any>, folder = defaultMigrationsFolder()) {
    const status = await migrationStatus(db, folder);
    if (status.unknown.length > 0) {
        throw new SchemaMismatchError(
            `The database has migrations this version does not know (${status.unknown.join(", ")}). ` +
                "It was migrated by a newer Launchpad: run that version, or restore a backup.",
        );
    }
    if (status.pending.length > 0) {
        throw new SchemaMismatchError(
            `The database schema is behind: ${status.pending.length} migration(s) pending ` +
                `(${status.pending.join(", ")}). Take a backup, then run \`launchpad-admin migrate\`.`,
        );
    }
}
