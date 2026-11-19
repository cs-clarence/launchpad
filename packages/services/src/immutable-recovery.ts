import { randomBytes } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import type { Database } from "@launchpad-kit/database";
import { type Kysely, sql } from "kysely";

export const IMMUTABLE_MIGRATION = "20261119_018_immutable_deployment_model";
export const MODEL_TABLES = [
    "app",
    "immutable_deployment",
    "app_deployment_event",
    "app_alias",
    "promotion_operation",
    "deployment_deletion_operation",
    "hostname_reservation",
    "dokku_name_reservation",
] as const;
const LOCK = "launchpad:immutable-recovery";
const BLOCKED = "immutable-recovery-blocked";
const SEEN = "model-writer-seen";
type Db = Kysely<Database>;

export class ImmutableRecoveryError extends Error {
    override name = "ImmutableRecoveryError";
}

export async function requireModelDataDirectory(dataDir: string): Promise<string> {
    const root = path.resolve(dataDir);
    const info = await fs.lstat(root).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            throw new ImmutableRecoveryError(
                "LAUNCHPAD_DATA_DIR must be an existing mounted directory; restore does not create missing storage.",
            );
        }
        throw error;
    });
    if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new ImmutableRecoveryError(
            "LAUNCHPAD_DATA_DIR must be an existing plain directory shared by all writers.",
        );
    }
    return root;
}

async function maintenance(dataDir: string, create = false) {
    const root = await requireModelDataDirectory(dataDir);
    const dir = path.join(root, "maintenance");
    if (create) {
        try {
            await fs.mkdir(dir, { mode: 0o700 });
            await syncDirectory(root);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
    }
    try {
        const info = await fs.lstat(dir);
        if (!info.isDirectory() || info.isSymbolicLink()) {
            throw new ImmutableRecoveryError(
                "The immutable maintenance path must be a plain directory.",
            );
        }
        if (info.mode & 0o077) {
            throw new ImmutableRecoveryError(
                "The immutable maintenance directory must be owner-only (0700).",
            );
        }
        // ENOENT is the only allowed absence. Permission and I/O failures are never readiness.
        await fs.access(dir, constants.R_OK | constants.X_OK);
    } catch (error) {
        if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
    return dir;
}

async function syncDirectory(dir: string) {
    const handle = await fs.open(
        dir,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

async function exists(dir: string | null, name: string) {
    if (!dir) return false;
    try {
        await fs.lstat(path.join(dir, name));
        return true; // Any object at the marker path blocks, even a symlink or corrupt marker.
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

// A restored ready row cannot clear this file: it lives outside the database dump.
export async function markImmutableRecoveryBlocked(dataDir: string) {
    const dir = (await maintenance(dataDir, true))!;
    const temp = path.join(dir, `.recovery-${randomBytes(12).toString("hex")}`);
    try {
        const handle = await fs.open(temp, "wx", 0o600);
        try {
            await handle.writeFile(
                JSON.stringify({ version: 1, restoreStartedAt: new Date().toISOString() }) + "\n",
            );
            await handle.sync();
        } finally {
            await handle.close();
        }
        await fs.rename(temp, path.join(dir, BLOCKED));
        await syncDirectory(dir);
    } finally {
        await fs.rm(temp, { force: true });
    }
}

export async function lockImmutableRecovery(db: Db, exclusive: boolean) {
    if (exclusive)
        await sql`select pg_advisory_xact_lock(hashtextextended(${LOCK}, 0))`.execute(db);
    else await sql`select pg_advisory_xact_lock_shared(hashtextextended(${LOCK}, 0))`.execute(db);
}

// A restore spans filesystem copies and pg_restore, not one SQL transaction.
// Keep this session pinned so the exclusive lock survives the schema swap.
export async function withImmutableRecoveryMaintenance<T>(
    db: Db,
    run: (connection: Db) => Promise<T>,
) {
    return db.connection().execute(async (connection) => {
        await sql`select pg_advisory_lock(hashtextextended(${LOCK}, 0))`.execute(connection);
        try {
            return await run(connection);
        } finally {
            await sql`select pg_advisory_unlock(hashtextextended(${LOCK}, 0))`.execute(connection);
        }
    });
}

export async function assertModelMutationsReady(db: Db, dataDir: string) {
    const dir = await maintenance(dataDir);
    if (await exists(dir, BLOCKED))
        throw new ImmutableRecoveryError(
            "Immutable recovery is blocked; reconcile before recovery-clear.",
        );
    const present = await sql<{ migrations: boolean; state: boolean }>`
        select to_regclass('public.launchpad_migration') is not null as migrations,
               to_regclass('public.instance_state') is not null as state`.execute(db);
    const knows = present.rows[0]!.migrations
        ? (
              await sql`select 1 from public.launchpad_migration where name = ${IMMUTABLE_MIGRATION}`.execute(
                  db,
              )
          ).rows.length > 0
        : false;
    const gate = present.rows[0]!.state
        ? await db
              .selectFrom("instance_state")
              .select("value")
              .where("key", "=", "immutable_recovery")
              .executeTakeFirst()
        : undefined;
    if ((gate && gate.value !== "ready") || (knows && !gate)) {
        throw new ImmutableRecoveryError(
            "The immutable database recovery gate is blocked or missing.",
        );
    }
    if (await exists(await maintenance(dataDir), BLOCKED)) {
        throw new ImmutableRecoveryError(
            "Immutable recovery started while readiness was being checked.",
        );
    }
}

// P3 must call this before the first model write or remote side effect. A file
// created before a crash is conservative: it can only make recovery refuse.
export async function recordModelWriterSeen(dataDir: string) {
    const dir = (await maintenance(dataDir, true))!;
    const file = path.join(dir, SEEN);
    const handle = await fs.open(
        file,
        constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        0o600,
    );
    try {
        if (!(await handle.stat()).isFile())
            throw new ImmutableRecoveryError("Writer-seen path is not a plain file.");
        await handle.sync();
    } finally {
        await handle.close();
    }
    await syncDirectory(dir);
}

// Hold the shared gate lock until the mutation commits. Restore/clear use the
// exclusive lock; their CLI still requires all old writers and remote work stopped.
export async function withModelMutation<T>(db: Db, dataDir: string, run: (trx: Db) => Promise<T>) {
    return db.transaction().execute(async (trx) => {
        await lockImmutableRecovery(trx, false);
        await assertModelMutationsReady(trx, dataDir);
        await recordModelWriterSeen(dataDir);
        return run(trx);
    });
}

export async function blockRestoredModel(db: Db) {
    const hasState = await sql<{ present: boolean }>`
        select to_regclass('public.instance_state') is not null as present`.execute(db);
    if (!hasState.rows[0]!.present) return; // An old dump: the durable marker still blocks after migrate.
    await db
        .insertInto("instance_state")
        .values({ key: "immutable_recovery", value: "blocked" })
        .onConflict((oc) => oc.column("key").doUpdateSet({ value: "blocked", set_at: new Date() }))
        .execute();
    const row = await db
        .selectFrom("instance_state")
        .select("value")
        .where("key", "=", "immutable_recovery")
        .executeTakeFirstOrThrow();
    if (row.value !== "blocked")
        throw new ImmutableRecoveryError("Restored model recovery gate could not be blocked.");
}

// P2b only: no writer exists in the deployed runtime. P3 MUST replace this rule
// with the audited attestation regardless of empty tables or a replaced volume.
export async function clearImmutableRecovery(db: Db, dataDir: string) {
    return withImmutableRecoveryMaintenance(db, async (connection) => {
        const dir = await maintenance(dataDir);
        await connection.transaction().execute(async (trx) => {
            await lockImmutableRecovery(trx, true);
            const applied =
                await sql`select 1 from public.launchpad_migration where name = ${IMMUTABLE_MIGRATION}`.execute(
                    trx,
                );
            if (applied.rows.length !== 1)
                throw new ImmutableRecoveryError("Run migration 018 before recovery-clear.");
            // Prevent a direct SQL writer from inserting between the emptiness check and commit.
            await sql.raw(`lock table ${MODEL_TABLES.join(", ")} in share mode`).execute(trx);
            if (await exists(dir, SEEN)) {
                throw new ImmutableRecoveryError(
                    "A model writer has run; P2b cannot clear recovery.",
                );
            }
            for (const table of MODEL_TABLES) {
                if ((await sql.raw(`select 1 from ${table} limit 1`).execute(trx)).rows.length) {
                    throw new ImmutableRecoveryError(
                        "Model tables are not empty; P2b cannot clear recovery.",
                    );
                }
            }
            await trx
                .insertInto("instance_state")
                .values({ key: "immutable_recovery", value: "ready" })
                .onConflict((oc) =>
                    oc.column("key").doUpdateSet({ value: "ready", set_at: new Date() }),
                )
                .execute();
            await trx
                .insertInto("audit_event")
                .values({
                    actor: "operator-cli",
                    action: "immutable.recovery-cleared",
                    target_type: "instance",
                    target_id: "self",
                    organization_id: null,
                    detail: "model_rows=0;writer_seen=0",
                })
                .execute();
        });
        // Commit ready first: failure or a crash here keeps the file and therefore stays blocked.
        if (dir) {
            await fs.unlink(path.join(dir, BLOCKED)).catch((error) => {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            });
            await syncDirectory(dir);
        }
    });
}
