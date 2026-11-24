import { randomBytes, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type Database, INITIAL_SCHEMA_MIGRATION } from "@launchpad-kit/database";
import {
    lockDeploymentRecovery,
    withDeploymentRecoveryMaintenance,
} from "@launchpad-kit/database/deployment-lock";
import { type Kysely, sql } from "kysely";
import { compareDrift } from "./drift/compare";
import { readDriftDatabase } from "./drift/read-database";
import type { SourceRead } from "./drift/types";
import { assessRecoveryEvidence, type RecoveryEvidence } from "./recovery-evidence";
import {
    compareRouterInventory,
    counterProblems,
    toDriftRouter,
    type RouterView,
} from "./router-inventory";

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

// How the restore anchored the router epoch: the epoch itself (not a secret) and where it came
// from, or why there is none. The union keeps the two from disagreeing.
export type RouterAnchor =
    | { routerEpoch: string; note: "recorded" | "from-epoch-file" }
    | { routerEpoch: null; note: "not-configured" | "unreachable" | "history-unknown" };

export type RecoveryMarker = { version: 2; restoreStartedAt: string } & {
    routerEpoch: RouterAnchor["routerEpoch"];
    // "predates-anchor" is how a version 1 marker reads: it says nothing about any router.
    // "history-unknown" is what a retry writes over one (or over a damaged marker) that found no
    // router either, so the unknown provenance survives the rewrite.
    routerEpochNote: RouterAnchor["note"] | "predates-anchor";
};
const EPOCH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Reads the marker: null when there is none, "damaged" when what is there is not a well-formed
// version 1 or 2 record (the file still blocks; clear then treats it as having no anchor and says
// so). Only absence is ENOENT; any other I/O failure is an error, never readiness.
export async function readRecoveryMarker(
    dataDir: string,
): Promise<RecoveryMarker | "damaged" | null> {
    const dir = await maintenance(dataDir);
    if (!dir) return null;
    let text: string;
    try {
        const handle = await fs.open(
            path.join(dir, BLOCKED),
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
            if (!(await handle.stat()).isFile()) return "damaged";
            text = (await handle.readFile({ encoding: "utf8" })).slice(0, 4096);
        } finally {
            await handle.close();
        }
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return null;
        if (code === "ELOOP") return "damaged";
        throw error;
    }
    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
        return "damaged";
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "damaged";
    if (
        typeof parsed.restoreStartedAt !== "string" ||
        !Number.isFinite(Date.parse(parsed.restoreStartedAt))
    )
        return "damaged";
    if (parsed.version === 1) {
        return {
            version: 2,
            restoreStartedAt: parsed.restoreStartedAt,
            routerEpoch: null,
            routerEpochNote: "predates-anchor",
        };
    }
    if (parsed.version !== 2) return "damaged";
    const { routerEpoch: epoch, routerEpochNote: note } = parsed;
    if (
        typeof epoch === "string" &&
        EPOCH.test(epoch) &&
        (note === "recorded" || note === "from-epoch-file")
    ) {
        return {
            version: 2,
            restoreStartedAt: parsed.restoreStartedAt,
            routerEpoch: epoch,
            routerEpochNote: note,
        };
    }
    if (
        epoch === null &&
        (note === "not-configured" || note === "unreachable" || note === "history-unknown")
    ) {
        return {
            version: 2,
            restoreStartedAt: parsed.restoreStartedAt,
            routerEpoch: null,
            routerEpochNote: note,
        };
    }
    return "damaged";
}

// A restored ready row cannot clear this file: it lives outside the database dump. A rerun after an
// interrupted restore keeps the first anchor and start time (they mark when the writers stopped),
// but still writes the record durably: the earlier directory sync may have failed.
export async function markDeploymentRecoveryBlocked(
    dataDir: string,
    anchor: RouterAnchor = { routerEpoch: null, note: "not-configured" },
) {
    if (anchor.routerEpoch !== null && !EPOCH.test(anchor.routerEpoch)) {
        throw new DeploymentRecoveryError("The router epoch to record is not a valid epoch.");
    }
    const found = await readRecoveryMarker(dataDir);
    const existing = found && found !== "damaged" ? found : null;
    // A retry that merely finds no router configured must not erase what an earlier run knew: that
    // a router was unreachable, or that nothing was known (a version 1 or damaged marker). A valid
    // epoch still strengthens an unanchored marker.
    const earlier = found === "damaged" ? "history-unknown" : existing?.routerEpochNote;
    const note =
        anchor.routerEpoch === null && anchor.note === "not-configured"
            ? earlier === "unreachable"
                ? "unreachable"
                : earlier === "predates-anchor" || earlier === "history-unknown"
                  ? "history-unknown"
                  : anchor.note
            : anchor.note;
    const record: RecoveryMarker =
        existing && existing.routerEpoch !== null
            ? existing
            : ({
                  version: 2,
                  restoreStartedAt: existing?.restoreStartedAt ?? new Date().toISOString(),
                  routerEpoch: anchor.routerEpoch,
                  routerEpochNote: note,
              } as RecoveryMarker);
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
    const gate = await db
        .selectFrom("instance_state")
        .select("value")
        .where("key", "=", "deployment_recovery")
        .executeTakeFirst();
    if (gate?.value !== "ready") {
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

const WORKER_STOP_GRACE_MS = 25 * 60_000;

export function requireRecoveryGrace(marker: RecoveryMarker | null | "damaged") {
    const started = marker && marker !== "damaged" ? Date.parse(marker.restoreStartedAt) : NaN;
    if (!Number.isFinite(started)) {
        throw new DeploymentRecoveryError(
            "Recovery has no valid restore start time. Repeat the documented restore with all writers stopped.",
        );
    }
    if (Date.now() - started < WORKER_STOP_GRACE_MS) {
        throw new DeploymentRecoveryError(
            "Wait at least 25 minutes from the recorded restore start before clearing recovery.",
        );
    }
}

async function requiredEvidence<T>(name: string, read: () => Promise<T>): Promise<SourceRead<T>> {
    try {
        return { status: "ok", data: await read() };
    } catch (cause) {
        throw new DeploymentRecoveryError(
            `Recovery cannot verify ${name}; its requested source was unavailable.`,
            { cause },
        );
    }
}

export async function clearDeploymentRecovery(
    db: Db,
    dataDir: string,
    checkedDokkuHost: boolean,
    // Reads the router's routes. Required once the database holds any alias: a restore can leave
    // the router ahead of it, and clearing would let new operations reuse a generation.
    router: RouterView | undefined,
    // The restore recorded no router epoch (v1 marker, router down or unconfigured at the time):
    // the operator then confirms the rotation by hand, and it is audited.
    options: {
        evidence: RecoveryEvidence;
        routerEpochUnrecorded?: boolean;
        accept?: readonly string[];
    },
) {
    if (!checkedDokkuHost) {
        throw new DeploymentRecoveryError(
            "Clearing recovery requires --i-have-checked-the-dokku-host: confirm that no Dokku work dispatched before restore is still running (docs/restore.md).",
        );
    }
    return withDeploymentRecoveryMaintenance(db, async (connection) => {
        await assertNoPendingDeploymentImport(dataDir);
        await assertNoActiveDeploymentImportBackends(connection);
        const dir = await maintenance(dataDir);
        const marker = await readRecoveryMarker(dataDir);
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
        const epochAudit = await (async () => {
            const trx = connection;
            const table = await sql<{
                present: boolean;
            }>`select to_regclass('public.launchpad_migration') is not null as present`.execute(
                trx,
            );
            const applied = table.rows[0]!.present
                ? await sql`select 1 from public.launchpad_migration where name = ${INITIAL_SCHEMA_MIGRATION}`.execute(
                      trx,
                  )
                : { rows: [] };
            if (applied.rows.length !== 1)
                throw new DeploymentRecoveryError("Initialize the database before recovery-clear.");
            if (inventory === null) {
                throw new DeploymentRecoveryError(
                    `The router could not be read (${unreadable}), so its counters cannot be compared. Check that the router is running, and the router settings, epoch and token files, then retry.`,
                );
            }
            let epochAudit = "";
            const damaged = marker === "damaged";
            const anchor = marker && marker !== "damaged" ? marker.routerEpoch : null;
            // Nothing is known about any router: damaged, or written before anchors existed.
            const unknown =
                damaged ||
                marker?.routerEpochNote === "predates-anchor" ||
                marker?.routerEpochNote === "history-unknown";
            const fromFile =
                marker !== null &&
                marker !== "damaged" &&
                marker.routerEpochNote === "from-epoch-file";
            if (inventory) {
                // The anchor is the router's epoch when the restore began. A router still on it was
                // not rotated, so a delayed pre-restore write would still be accepted.
                if (anchor !== null && inventory.epoch === anchor) {
                    throw new DeploymentRecoveryError(
                        "The router's epoch has not changed since the restore began, so a delayed pre-restore write could still land. Stop the router, rotate its epoch and credentials (docs/restore.md), update the epoch and token files, then retry.",
                    );
                }
                if (anchor === null && !options.routerEpochUnrecorded) {
                    throw new DeploymentRecoveryError(
                        damaged
                            ? "The recovery marker is damaged, so the router rotation cannot be verified. After rotating the router, repeat with --router-epoch-unrecorded to confirm it yourself."
                            : "The restore recorded no router epoch (no router was configured or readable then, or the marker predates this check), so the rotation cannot be verified. After rotating the router, repeat with --router-epoch-unrecorded to confirm it yourself.",
                    );
                }
                // An anchor taken from the configured epoch file was not confirmed by the router: if
                // the file was stale, an unchanged router would also look rotated. It proves "not
                // rotated" when equal, but a difference needs the operator's confirmation.
                if (fromFile && !options.routerEpochUnrecorded) {
                    throw new DeploymentRecoveryError(
                        "The restore could not read the router, so its anchor is the epoch in the configured epoch file, which the router may not have been on. The router's epoch now differs, but that is not proof of a rotation made during recovery: after rotating the router, repeat with --router-epoch-unrecorded to confirm it yourself.",
                    );
                }
                epochAudit =
                    anchor === null
                        ? `;router-epoch=${damaged ? "marker-damaged-confirmed" : "unrecorded-confirmed"}`
                        : `;router-epoch=${fromFile ? "changed-file-anchor-confirmed" : "changed"};anchor=${anchor};current=${inventory.epoch}`;
                const report = await compareRouterInventory(trx, inventory);
                if (counterProblems(report)) {
                    const shown = report.unknownRoutes.slice(0, 5).join(", ");
                    const claimed = report.conflicting.slice(0, 5).join(", ");
                    throw new DeploymentRecoveryError(
                        `The router is ahead of the restored database or disagrees with it (${report.behind.length} alias counters behind, ${report.unknownRoutes.length} unknown routes${shown ? `: ${shown}` : ""}, ${report.conflicting.length} hostnames recorded for a different alias${claimed ? `: ${claimed}` : ""}). Run recovery-raise-counters, withdraw (recovery-withdraw-unknown) or restore anything unknown, and resolve any hostname recorded for another alias, before recovery-clear (docs/restore.md).`,
                    );
                }
            } else {
                // A router was configured when the restore began (an epoch was anchored, or the
                // router was unreachable then), so it must be read now: clearing without it would
                // skip the rotation check even on a database with no aliases.
                if (
                    marker &&
                    marker !== "damaged" &&
                    (anchor !== null || marker.routerEpochNote === "unreachable")
                ) {
                    throw new DeploymentRecoveryError(
                        "A router was configured when the restore began, so recovery-clear must read it to verify the rotation: configure the router settings (LAUNCHPAD_ALIAS_CONTROL_URL and the other LAUNCHPAD_ALIAS_* settings) and retry.",
                    );
                }
                // No router is read, and nothing is known about one: confirm it, as with a router.
                if (unknown) {
                    if (!options.routerEpochUnrecorded) {
                        throw new DeploymentRecoveryError(
                            damaged
                                ? "The recovery marker is damaged, so it is not known whether a router was in use. After rotating any router, repeat with --router-epoch-unrecorded to confirm it yourself."
                                : "It is not known whether a router was in use (the recovery marker predates router anchoring, or an earlier run could not tell). After rotating any router, repeat with --router-epoch-unrecorded to confirm it yourself.",
                        );
                    }
                    epochAudit = `;router-epoch=${damaged ? "marker-damaged-confirmed" : "unrecorded-confirmed"}`;
                }
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
            return epochAudit;
        })();
        requireRecoveryGrace(marker);
        const snapshot = await readDriftDatabase(connection);
        const [dokku, archives, probe] = await Promise.all([
            requiredEvidence("Dokku", () => options.evidence.dokku(snapshot)),
            requiredEvidence("stored archives", () => options.evidence.archives(snapshot)),
            options.evidence.probe
                ? requiredEvidence("served identities", () => options.evidence.probe!(snapshot))
                : Promise.resolve({ status: "skipped", reason: "Not configured." } as const),
        ]);
        const report = compareDrift({
            db: snapshot,
            dokku,
            archives,
            probe,
            router: inventory
                ? { status: "ok", data: toDriftRouter(inventory) }
                : { status: "skipped", reason: "No router in use." },
            config: {
                expectedEpoch: inventory?.epoch ?? "",
                appNamePattern: /^lp-[a-z0-9]{10}$/,
                now: new Date(),
                recovery: true,
            },
        });
        const { accepted, blocking } = assessRecoveryEvidence(report, options.accept ?? []);
        if (blocking.length) {
            const first = blocking
                .slice(0, 10)
                .map(
                    (f) =>
                        `${f.code} (${f.resources.map((r) => `${r.kind}:${r.id}`).join(", ")}): ${f.action}`,
                )
                .join("\n");
            throw new DeploymentRecoveryError(
                `Recovery is blocked by ${blocking.length} finding(s):\n${first}`,
            );
        }
        if (inventory && router) {
            const latest = await requiredEvidence("router authority", router);
            if (
                latest.status !== "ok" ||
                latest.data.epoch !== inventory.epoch ||
                latest.data.instanceId !== inventory.instanceId
            ) {
                throw new DeploymentRecoveryError(
                    "The router authority changed during verification; retry recovery-clear.",
                );
            }
        }
        await connection.transaction().execute(async (trx) => {
            await lockDeploymentRecovery(trx, true);
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
                    detail: `attested=checked-dokku-host${epochAudit}`,
                })
                .execute();
            if (accepted.length) {
                await trx
                    .insertInto("audit_event")
                    .values(
                        accepted.map(({ key, finding }) => ({
                            actor: "operator-cli",
                            action: "deployment.recovery-finding-accepted",
                            target_type: "instance",
                            target_id: "self",
                            organization_id: null,
                            detail: JSON.stringify({ key, finding }),
                        })),
                    )
                    .execute();
            }
        });
        // Commit ready first: failure or a crash here keeps the file and therefore stays blocked.
        if (dir) {
            await fs.unlink(path.join(dir, BLOCKED)).catch((error) => {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            });
            await syncDirectory(dir);
        }
        return report;
    });
}
