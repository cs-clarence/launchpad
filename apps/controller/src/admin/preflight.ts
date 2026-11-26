import { migrationStatus, assertSchemaCurrent, SchemaMismatchError } from "@launchpad-kit/database";
import { isArtifactStorageKey } from "@launchpad-kit/services";
import { promises as fs } from "node:fs";
import path from "node:path";

type Db = Parameters<typeof migrationStatus>[0];

export class PreflightError extends Error {
    override name = "PreflightError";
}

const OWNER_DIRECTORY = /^[0-9a-f]{32}$/;

async function lstatOrNull(target: string) {
    try {
        return await fs.lstat(target);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
}

// Counts stored archives under `<dataDir>/artifacts/`, stopping once `limit` are found, so the
// result means "at least that many". A missing directory counts 0. A symbolic link or any
// unreadable entry throws: the check fails closed rather than letting `migrate` run.
export async function countOrphanedArchives(dataDir: string, limit = 1): Promise<number> {
    const root = path.join(dataDir, "artifacts");
    const rootStat = await lstatOrNull(root);
    if (!rootStat) return 0;
    if (!rootStat.isDirectory()) {
        throw new Error(`${root} is not a plain directory (a symbolic link or a file).`);
    }
    let found = 0;
    for (const owner of await fs.readdir(root)) {
        if (!OWNER_DIRECTORY.test(owner)) continue;
        const ownerPath = path.join(root, owner);
        const ownerStat = await fs.lstat(ownerPath);
        if (ownerStat.isSymbolicLink()) {
            throw new Error(`${ownerPath} is a symbolic link.`);
        }
        if (!ownerStat.isDirectory()) continue;
        for (const name of await fs.readdir(ownerPath)) {
            if (!isArtifactStorageKey(`artifacts/${owner}/${name}`)) continue;
            if (!(await fs.lstat(path.join(ownerPath, name))).isFile()) continue;
            found += 1;
            if (found >= limit) return found;
        }
    }
    return found;
}

// Refuses to migrate a database with no applied migration next to a data directory that already
// holds archives: that is a lost or replaced database, which should be restored from a backup.
// Returns a warning when the operator overrides the refusal.
export async function assertMigrateSafe(options: {
    db: Db;
    dataDir: string;
    allowOrphanedData: boolean;
}): Promise<{ warning?: string }> {
    const status = await migrationStatus(options.db);
    if (status.applied.length > 0) return {};
    const archives = await countOrphanedArchives(options.dataDir);
    if (archives === 0) return {};
    const found = `at least ${archives} stored archive(s) in ${options.dataDir}`;
    if (options.allowOrphanedData) {
        return {
            warning:
                `Warning: migrating an empty database next to ${found}; ` +
                "those archives belong to no deployment record.",
        };
    }
    throw new PreflightError(
        `Refusing to migrate: the database has no applied migration but the data directory holds ${found}. ` +
            "The database looks lost or replaced. Restore a backup with `launchpad-admin restore --replace` " +
            "(docs/restore.md). To deliberately reuse this data directory with a fresh database, " +
            "run `launchpad-admin migrate --allow-orphaned-data`.",
    );
}

// For the read-only checks: an unmigrated database gets the schema message instead of a raw
// "relation does not exist". A database with nothing applied also gets the lost-database advice.
export async function assertReadyForCheck(db: Db): Promise<void> {
    try {
        await assertSchemaCurrent(db);
    } catch (error) {
        if (error instanceof SchemaMismatchError) {
            const status = await migrationStatus(db);
            if (status.applied.length === 0) {
                throw new SchemaMismatchError(
                    `${error.message} If the database was lost, restore a backup (docs/restore.md); ` +
                        "do not run `migrate` while the data directory holds archives.",
                );
            }
        }
        throw error;
    }
}
