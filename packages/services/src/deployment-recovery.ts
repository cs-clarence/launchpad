import { randomBytes, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Database } from "@launchpad-kit/database";
import {
    lockDeploymentRecovery,
    withDeploymentRecoveryMaintenance,
} from "@launchpad-kit/database/deployment-lock";
import { type Kysely, sql } from "kysely";
import { compareRouterInventory, counterProblems, type RouterView } from "./router-inventory";

export const DEPLOYMENT_MIGRATION = "20261119_018_deployment_model";
export const MODEL_TABLES = [
    "app",
    "deployment",
    "app_deployment_event",
    "app_alias",
    "promotion_operation",
    "deployment_deletion_operation",
    "hostname_reservation",
    "dokku_name_reservation",
] as const;
const BLOCKED = "deployment-recovery-blocked";
const SEEN = "model-writer-seen";
const IMPORT = "deployment-import-in-progress";
type Db = Kysely<Database>;

export class DeploymentRecoveryError extends Error {
    override name = "DeploymentRecoveryError";
}

export async function requireModelDataDirectory(dataDir: string): Promise<string> {
    const root = path.resolve(dataDir);
    const info = await fs.lstat(root).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            throw new DeploymentRecoveryError(
                "LAUNCHPAD_DATA_DIR must be an existing mounted directory; restore does not create missing storage.",
            );
        }
        throw error;
    });
    if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new DeploymentRecoveryError(
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
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        // A prior mkdir may have survived a failed parent fsync. EEXIST does
        // not prove the directory entry is durable, so sync on retry too.
        await syncDirectory(root);
    }
    try {
        const info = await fs.lstat(dir);
        if (!info.isDirectory() || info.isSymbolicLink()) {
            throw new DeploymentRecoveryError(
                "The deployment maintenance path must be a plain directory.",
            );
        }
        if (info.mode & 0o077) {
            throw new DeploymentRecoveryError(
                "The deployment maintenance directory must be owner-only (0700).",
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

// What the recovery marker records. The router epoch is not a secret: it is the router's active
// epoch at the moment the restore began, so recovery-clear can verify it has changed since.
export interface RecoveryMarker {
    version: 2;
    restoreStartedAt: string;
    routerEpoch: string | null;
    // Why there is no anchor: no router is configured, or it could not be read at the time.
    routerEpochNote: "recorded" | "not-configured" | "unreachable";
}
const EPOCH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Reads the marker if it is a well-formed version 1 or 2 record. Anything else (absent, corrupt,
// unknown version) reads as no anchor: the file still blocks, and clear then needs the explicit flag.
export async function readRecoveryMarker(dataDir: string): Promise<RecoveryMarker | null> {
    const dir = await maintenance(dataDir);
    if (!dir) return null;
    try {
        const parsed = JSON.parse(await fs.readFile(path.join(dir, BLOCKED), "utf8")) as Record<
            string,
            unknown
        >;
        if (typeof parsed.restoreStartedAt !== "string") return null;
        if (parsed.version === 1) {
            return {
                version: 2,
                restoreStartedAt: parsed.restoreStartedAt,
                routerEpoch: null,
                routerEpochNote: "not-configured",
            };
        }
        if (parsed.version !== 2) return null;
        const epoch = parsed.routerEpoch;
        if (epoch !== null && !(typeof epoch === "string" && EPOCH.test(epoch))) return null;
        const note = parsed.routerEpochNote;
        if (note !== "recorded" && note !== "not-configured" && note !== "unreachable") return null;
        return {
            version: 2,
            restoreStartedAt: parsed.restoreStartedAt,
            routerEpoch: epoch,
            routerEpochNote: note,
        };
    } catch {
        return null;
    }
}

// A restored ready row cannot clear this file: it lives outside the database dump. A rerun after an
// interrupted restore keeps the first anchor and start time: they mark when the writers stopped.
export async function markDeploymentRecoveryBlocked(
    dataDir: string,
    anchor: { routerEpoch: string | null; note: RecoveryMarker["routerEpochNote"] } = {
        routerEpoch: null,
        note: "not-configured",
    },
) {
    const existing = await readRecoveryMarker(dataDir);
    if (existing && existing.routerEpoch !== null) return;
    const record: RecoveryMarker = {
        version: 2,
        restoreStartedAt: existing?.restoreStartedAt ?? new Date().toISOString(),
        routerEpoch: anchor.routerEpoch,
        routerEpochNote: anchor.routerEpoch === null ? anchor.note : "recorded",
    };
    await writeDurableRecord(dataDir, BLOCKED, record);
}

async function writeDurableRecord(dataDir: string, name: string, record: unknown) {
    const dir = (await maintenance(dataDir, true))!;
    const temp = path.join(dir, `.recovery-${randomBytes(12).toString("hex")}`);
    try {
        const handle = await fs.open(temp, "wx", 0o600);
        try {
            await handle.writeFile(JSON.stringify(record) + "\n");
            await handle.sync();
        } finally {
            await handle.close();
        }
        await fs.rename(temp, path.join(dir, name));
        await syncDirectory(dir);
    } finally {
        await fs.rm(temp, { force: true });
    }
}

export { lockDeploymentRecovery, withDeploymentRecoveryMaintenance };

export interface DeploymentImportRecord {
    version: 1;
    id: string;
    databaseIdentity: string;
    applicationName: string;
    startedAt: string;
    adminPid: number;
}

export async function assertNoPendingDeploymentImport(dataDir: string) {
    if (await exists(await maintenance(dataDir), IMPORT)) {
        throw new DeploymentRecoveryError(
            "A previous pg_restore may still be running. Stop and verify its OS process and database backend, then run recovery-ack-import --i-have-stopped-the-importer before retrying.",
        );
    }
}

// Caller holds the exclusive maintenance lock. This file outlives the admin's
// session lock if it dies; absence is restored only after observing child exit.
export async function beginDeploymentImport(
    dataDir: string,
    databaseIdentity: string,
): Promise<DeploymentImportRecord> {
    await assertNoPendingDeploymentImport(dataDir);
    const id = randomUUID();
    const record: DeploymentImportRecord = {
        version: 1,
        id,
        databaseIdentity,
        applicationName: `launchpad-restore-${id}`,
        startedAt: new Date().toISOString(),
        adminPid: process.pid,
    };
    await writeDurableRecord(dataDir, IMPORT, record);
    return record;
}

// Only for failures before pg_restore is spawned, when no importer can exist.
export async function abandonDeploymentImport(dataDir: string) {
    const dir = await maintenance(dataDir);
    if (!dir) return;
    await fs.rm(path.join(dir, IMPORT), { force: true });
    await syncDirectory(dir);
}

async function readImportRecord(dataDir: string): Promise<DeploymentImportRecord> {
    const dir = await maintenance(dataDir);
    if (!dir) throw new DeploymentRecoveryError("No pending import record exists.");
    const handle = await fs.open(
        path.join(dir, IMPORT),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > 4096)
            throw new DeploymentRecoveryError(
                "Invalid import record; keep recovery closed and investigate.",
            );
        const value = JSON.parse(await handle.readFile("utf8")) as DeploymentImportRecord;
        if (
            value.version !== 1 ||
            typeof value.id !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.id) ||
            value.applicationName !== `launchpad-restore-${value.id}` ||
            typeof value.databaseIdentity !== "string" ||
            !value.databaseIdentity.length ||
            value.databaseIdentity.length > 1024 ||
            typeof value.startedAt !== "string" ||
            !Number.isFinite(Date.parse(value.startedAt)) ||
            !Number.isSafeInteger(value.adminPid) ||
            value.adminPid <= 0
        ) {
            throw new DeploymentRecoveryError(
                "Invalid import record; keep recovery closed and investigate.",
            );
        }
        return value;
    } finally {
        await handle.close();
    }
}

async function activeImportBackends(db: Db) {
    const active = await sql<{ n: number }>`
        select count(*)::int as n from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid()
          and (application_name = 'pg_restore' or application_name like 'launchpad-restore-%')
    `.execute(db);
    return active.rows[0]!.n;
}

export async function assertNoActiveDeploymentImportBackends(db: Db) {
    if (await activeImportBackends(db)) {
        throw new DeploymentRecoveryError(
            "An import backend is still connected (including any other pg_restore on this database); no restore/recovery changes are permitted.",
        );
    }
}

export async function finishDeploymentImport(
    db: Db,
    dataDir: string,
    record: DeploymentImportRecord,
) {
    // Client exit can precede backend cleanup, especially after disconnect/abort.
    // Do not undo schemas or clear the guard while a backend could still commit.
    const deadline = Date.now() + 2000;
    while (await activeImportBackends(db)) {
        if (Date.now() >= deadline)
            throw new DeploymentRecoveryError(
                "Importer backend exit is unproven; preserve the import record and stop recovery.",
            );
        await delay(25);
    }
    const current = await readImportRecord(dataDir);
    if (current.id !== record.id)
        throw new DeploymentRecoveryError("The pending import record changed unexpectedly.");
    const dir = (await maintenance(dataDir))!;
    await fs.unlink(path.join(dir, IMPORT));
    await syncDirectory(dir);
}

// This cannot prove OS-process exit: the explicit confirmation covers that,
// including wrappers that might connect later. The backend check is additional
// refusal evidence, never a replacement for the attestation.
export async function acknowledgeDeploymentImport(
    db: Db,
    dataDir: string,
    databaseIdentity: string,
    importerStopped: boolean,
) {
    if (!importerStopped)
        throw new DeploymentRecoveryError(
            "Confirm the previous importer and its database backend have exited (--i-have-stopped-the-importer).",
        );
    await withDeploymentRecoveryMaintenance(db, async (connection) => {
        const record = await readImportRecord(dataDir);
        if (record.databaseIdentity !== databaseIdentity)
            throw new DeploymentRecoveryError(
                "Import acknowledgement targets a different database.",
            );
        await assertNoActiveDeploymentImportBackends(connection);
        // The next restore replaces public, and it may currently be empty. Audit
        // outside the dump so acknowledgement is durable in both cases.
        await writeDurableRecord(dataDir, `deployment-import-ack-${record.id}`, {
            version: 1,
            acknowledgementRequestedAt: new Date().toISOString(),
            attestedStoppedImports: 1,
            activeImportBackends: 0,
            stoppedImporterAttested: true,
        });
        await finishDeploymentImport(connection, dataDir, record);
    });
}

export async function assertModelMutationsReady(db: Db, dataDir: string) {
    await assertNoPendingDeploymentImport(dataDir);
    const dir = await maintenance(dataDir);
    if (await exists(dir, BLOCKED))
        throw new DeploymentRecoveryError(
            "Deployment recovery is blocked; reconcile before recovery-clear.",
        );
    const present = await sql<{ migrations: boolean; state: boolean }>`
        select to_regclass('public.launchpad_migration') is not null as migrations,
               to_regclass('public.instance_state') is not null as state`.execute(db);
    const knows = present.rows[0]!.migrations
        ? (
              await sql`select 1 from public.launchpad_migration where name = ${DEPLOYMENT_MIGRATION}`.execute(
                  db,
              )
          ).rows.length > 0
        : false;
    const gate = present.rows[0]!.state
        ? await db
              .selectFrom("instance_state")
              .select("value")
              .where("key", "=", "deployment_recovery")
              .executeTakeFirst()
        : undefined;
    if ((gate && gate.value !== "ready") || (knows && !gate)) {
        throw new DeploymentRecoveryError(
            "The deployment database recovery gate is blocked or missing.",
        );
    }
    if (await exists(await maintenance(dataDir), BLOCKED)) {
        throw new DeploymentRecoveryError(
            "Deployment recovery started while readiness was being checked.",
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
            throw new DeploymentRecoveryError("Writer-seen path is not a plain file.");
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
        await lockDeploymentRecovery(trx, false);
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
        .values({ key: "deployment_recovery", value: "blocked" })
        .onConflict((oc) => oc.column("key").doUpdateSet({ value: "blocked", set_at: new Date() }))
        .execute();
    const row = await db
        .selectFrom("instance_state")
        .select("value")
        .where("key", "=", "deployment_recovery")
        .executeTakeFirstOrThrow();
    if (row.value !== "blocked")
        throw new DeploymentRecoveryError("Restored model recovery gate could not be blocked.");
}

// Interim rule (P3a, until P5 verifies reconciliation): never consult the writer-seen file or the
// model tables. The file lives on the data volume, which a restore from an older dump can replace,
// and empty tables cannot be told from a never-used installation. The operator must attest the
// manual reconciliation procedure every time, so the confirmation is mandatory.
export async function clearDeploymentRecovery(
    db: Db,
    dataDir: string,
    attested: boolean,
    // Reads the router's routes. Required once the database holds any alias: a restore can leave
    // the router ahead of it, and clearing would let new operations reuse a generation.
    router?: RouterView,
    // The restore recorded no router epoch (v1 marker, router down or unconfigured at the time):
    // the operator then confirms the rotation by hand, and it is audited.
    options: { routerEpochUnrecorded?: boolean } = {},
) {
    if (!attested) {
        throw new DeploymentRecoveryError(
            "Clearing recovery requires --i-have-reconciled-router-and-dokku: close ingress, settle dispatched Dokku work, rotate the router epoch and credentials if a router is in use, and reconcile router and Dokku against the restored database first (docs/restore.md).",
        );
    }
    return withDeploymentRecoveryMaintenance(db, async (connection) => {
        await assertNoPendingDeploymentImport(dataDir);
        await assertNoActiveDeploymentImportBackends(connection);
        const dir = await maintenance(dataDir);
        // Read the router while the maintenance lock excludes every model writer.
        let unreadable = "";
        const inventory = router
            ? await Promise.resolve()
                  .then(router)
                  .catch((error: unknown) => {
                      // Client and credential errors are fixed text: safe to show the operator.
                      unreadable = error instanceof Error ? error.message : "unknown error";
                      return null;
                  })
            : undefined;
        await connection.transaction().execute(async (trx) => {
            await lockDeploymentRecovery(trx, true);
            const table = await sql<{
                present: boolean;
            }>`select to_regclass('public.launchpad_migration') is not null as present`.execute(
                trx,
            );
            const applied = table.rows[0]!.present
                ? await sql`select 1 from public.launchpad_migration where name = ${DEPLOYMENT_MIGRATION}`.execute(
                      trx,
                  )
                : { rows: [] };
            if (applied.rows.length !== 1)
                throw new DeploymentRecoveryError("Run migration 018 before recovery-clear.");
            if (inventory === null) {
                throw new DeploymentRecoveryError(
                    `The router could not be read (${unreadable}), so its counters cannot be compared. Check that the router is running, and the router settings, epoch and token files, then retry.`,
                );
            }
            let epochAudit = "";
            if (inventory) {
                // The anchor is the router's epoch when the restore began. A router still on it was
                // not rotated, so a delayed pre-restore write would still be accepted.
                const anchor = (await readRecoveryMarker(dataDir))?.routerEpoch ?? null;
                if (anchor !== null && inventory.epoch === anchor) {
                    throw new DeploymentRecoveryError(
                        "The router's epoch has not changed since the restore began, so a delayed pre-restore write could still land. Stop the router, rotate its epoch and credentials (docs/restore.md), update the epoch and token files, then retry.",
                    );
                }
                if (anchor === null && !options.routerEpochUnrecorded) {
                    throw new DeploymentRecoveryError(
                        "The restore recorded no router epoch (the router was unreachable or unconfigured then, or the marker predates this check), so the rotation cannot be verified. After rotating the router, repeat with --router-epoch-unrecorded to confirm it yourself.",
                    );
                }
                epochAudit =
                    anchor === null
                        ? ";router-epoch=unrecorded-confirmed"
                        : ";router-epoch=changed";
                const report = await compareRouterInventory(trx, inventory);
                if (counterProblems(report)) {
                    const shown = report.unknownRoutes.slice(0, 5).join(", ");
                    const claimed = report.conflicting.slice(0, 5).join(", ");
                    throw new DeploymentRecoveryError(
                        `The router is ahead of the restored database or disagrees with it (${report.behind.length} alias counters behind, ${report.unknownRoutes.length} unknown routes${shown ? `: ${shown}` : ""}, ${report.conflicting.length} hostnames recorded for a different alias${claimed ? `: ${claimed}` : ""}). Run recovery-raise-counters, withdraw (recovery-withdraw-unknown) or restore anything unknown, and resolve any hostname recorded for another alias, before recovery-clear (docs/restore.md).`,
                    );
                }
            } else {
                const anyAlias = await trx
                    .selectFrom("app_alias")
                    .select("id")
                    .limit(1)
                    .executeTakeFirst();
                if (anyAlias) {
                    throw new DeploymentRecoveryError(
                        "The database holds aliases, so recovery-clear must compare the router's counters: configure the router settings (LAUNCHPAD_APPS_DOMAIN and the LAUNCHPAD_ALIAS_* settings) and retry.",
                    );
                }
            }
            await trx
                .insertInto("instance_state")
                .values({ key: "deployment_recovery", value: "ready" })
                .onConflict((oc) =>
                    oc.column("key").doUpdateSet({ value: "ready", set_at: new Date() }),
                )
                .execute();
            await trx
                .insertInto("audit_event")
                .values({
                    actor: "operator-cli",
                    action: "deployment.recovery-cleared",
                    target_type: "instance",
                    target_id: "self",
                    organization_id: null,
                    detail: `attested=reconciled-router-and-dokku${epochAudit}`,
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
