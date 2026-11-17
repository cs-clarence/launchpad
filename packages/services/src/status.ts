import { promises as fs } from "node:fs";
import type { Database } from "@launchpad/database";
import { type Kysely, sql } from "kysely";
import type { Principal } from "./authorization";
import { ServiceError } from "./errors";

type Db = Kysely<Database>;

// A worker writes its row at least every 10 s; a minute without one is a worker that is
// not running.
export const WORKER_LIVE_SECONDS = 60;
// Rows of workers that stopped long ago are not kept.
const FORGET_AFTER = "1 day";

// A worker says it is alive: once when it starts (`started`, which also restarts its clock
// for an id that is reused) and then on every round, throttled by the caller.
export async function recordHeartbeat(
    db: Db,
    input: { workerId: string; version: string; lifecycleEnabled: boolean; started?: boolean },
): Promise<void> {
    await db
        .insertInto("worker_heartbeat")
        .values({
            worker_id: input.workerId,
            version: input.version,
            lifecycle_enabled: input.lifecycleEnabled,
        })
        .onConflict((oc) =>
            oc.column("worker_id").doUpdateSet({
                version: input.version,
                lifecycle_enabled: input.lifecycleEnabled,
                last_seen_at: sql<Date>`now()`,
                ...(input.started ? { started_at: sql<Date>`now()` } : {}),
            }),
        )
        .execute();
    await db
        .deleteFrom("worker_heartbeat")
        .where("last_seen_at", "<", sql<Date>`now() - ${FORGET_AFTER}::interval`)
        .execute();
}

export interface StatusDeps {
    dataDir: string;
    deploymentsEnabled: boolean;
    // The setting, and whether the controller will accept a new deletion (it needs both the
    // lifecycle and deployments): what a worker has to agree with is the second.
    lifecycleEnabled: boolean;
    deletionsAccepted: boolean;
}

// A running deployment that has not moved for this long is stuck, whatever the worker's
// heartbeat says: its builds and probes time out well before.
export const STUCK_RUNNING_SECONDS = 30 * 60;

const HELD_DEPLOYMENT = "reconciliation-needed" as const;
const RUNNING_DEPLOYMENT = ["preparing", "building", "deploying", "verifying"] as const;

// How the instance is doing, for the operator: readiness of what it depends on, each worker's
// age, the work waiting, and what looks wrong in plain words. Counts and ages only: no ids,
// names or text that came from a remote system.
export async function getStatus(db: Db, principal: Principal, deps: StatusDeps) {
    if (principal.instanceRole !== "operator") {
        throw new ServiceError("forbidden", "Only the instance operator may read this.");
    }
    const count = sql<number>`count(*)::int`;
    const [deployments, oldest, stalest, overdue, deletions, artifacts, workers] =
        await Promise.all([
            db
                .selectFrom("deployment")
                .select(["status", count.as("n")])
                .where("status", "in", ["queued", HELD_DEPLOYMENT, ...RUNNING_DEPLOYMENT])
                .groupBy("status")
                .execute(),
            db
                .selectFrom("deployment")
                .select(
                    sql<number | null>`extract(epoch from now() - min(created_at))::int`.as("age"),
                )
                .where("status", "=", "queued")
                .executeTakeFirstOrThrow(),
            db
                .selectFrom("deployment")
                .select(
                    sql<number | null>`extract(epoch from now() - min(updated_at))::int`.as("age"),
                )
                .where("status", "in", [...RUNNING_DEPLOYMENT])
                .executeTakeFirstOrThrow(),
            db
                .selectFrom("preview")
                .select(count.as("n"))
                .where("desired_state", "=", "active")
                .where("expires_at", "<=", sql<Date>`now()`)
                .executeTakeFirstOrThrow(),
            db
                .selectFrom("deletion_operation")
                .select(["status", count.as("n")])
                .where("status", "in", ["queued", "running", "reconciliation-needed"])
                .groupBy("status")
                .execute(),
            db
                .selectFrom("artifact")
                .select([
                    count.as("n"),
                    sql<number>`coalesce(sum(size_bytes), 0)::float8`.as("bytes"),
                ])
                .where("collected_at", "is", null)
                .executeTakeFirstOrThrow(),
            db
                .selectFrom("worker_heartbeat")
                .select([
                    "worker_id",
                    "version",
                    "lifecycle_enabled",
                    "started_at",
                    sql<number>`extract(epoch from now() - last_seen_at)::int`.as("age"),
                ])
                .orderBy("last_seen_at", "desc")
                .orderBy("worker_id")
                .limit(50)
                .execute(),
        ]);
    const by = (rows: { status: string; n: number }[], ...names: string[]) =>
        rows.filter((r) => names.includes(r.status)).reduce((sum, r) => sum + r.n, 0);
    // Only where uploads and builds use it, and only a directory counts.
    const dataDirectory = !deps.deploymentsEnabled
        ? ("not-checked" as const)
        : await fs
              .stat(deps.dataDir)
              .then(async (entry) => {
                  if (!entry.isDirectory()) return "not-a-directory" as const;
                  return fs.access(deps.dataDir, fs.constants.W_OK).then(
                      () => "ok" as const,
                      () => "not-writable" as const,
                  );
              })
              .catch((error: NodeJS.ErrnoException) =>
                  error.code === "ENOENT" ? ("missing" as const) : ("not-writable" as const),
              );

    const workerRows = workers.map((w) => ({
        id: w.worker_id,
        version: w.version,
        lifecycleEnabled: w.lifecycle_enabled,
        startedAt: w.started_at.toISOString(),
        lastSeenSecondsAgo: Math.max(0, w.age),
        live: w.age <= WORKER_LIVE_SECONDS,
    }));
    const live = workerRows.filter((w) => w.live);
    const queued = by(deployments, "queued");
    const held = by(deployments, HELD_DEPLOYMENT);
    const running = by(deployments, ...RUNNING_DEPLOYMENT);
    const waitingDeletions = by(deletions, "queued", "running");
    const heldDeletions = by(deletions, "reconciliation-needed");

    const warnings: string[] = [];
    // Work only counts where it will be done: expiry and deletion need the lifecycle.
    const waiting =
        queued + running > 0 || (deps.lifecycleEnabled && (overdue.n > 0 || waitingDeletions > 0));
    if (live.length === 0 && waiting) {
        warnings.push("No worker has reported in the last minute, but there is work waiting.");
    }
    if (deps.lifecycleEnabled && !deps.deploymentsEnabled) {
        warnings.push("The lifecycle is on but deployments are off, so deletions are refused.");
    }
    if (deps.deletionsAccepted && !live.some((w) => w.lifecycleEnabled)) {
        warnings.push(
            "The controller accepts deletions but no live worker has the lifecycle on: they will not run.",
        );
    }
    if (!deps.deletionsAccepted && live.some((w) => w.lifecycleEnabled)) {
        warnings.push(
            "A worker has the lifecycle on but the controller does not accept deletions: new ones are refused.",
        );
    }
    if (stalest.age !== null && stalest.age > STUCK_RUNNING_SECONDS) {
        warnings.push(
            `A deployment has been running for over ${Math.floor(STUCK_RUNNING_SECONDS / 60)} minutes without moving: a worker may be stuck.`,
        );
    }
    if (held > 0) warnings.push(`${held} deployment(s) need an administrator.`);
    if (heldDeletions > 0) warnings.push(`${heldDeletions} deletion(s) need an administrator.`);
    if (dataDirectory !== "ok" && dataDirectory !== "not-checked") {
        warnings.push(`The data directory is ${dataDirectory.replaceAll("-", " ")}.`);
    }

    return {
        generatedAt: new Date().toISOString(),
        dependencies: { database: "ok" as const, dataDirectory },
        controller: {
            deploymentsEnabled: deps.deploymentsEnabled,
            lifecycleEnabled: deps.lifecycleEnabled,
            deletionsAccepted: deps.deletionsAccepted,
        },
        workers: workerRows,
        deployments: {
            queued,
            running,
            held,
            oldestQueuedSeconds: oldest.age === null ? null : Math.max(0, oldest.age),
            oldestRunningSeconds: stalest.age === null ? null : Math.max(0, stalest.age),
        },
        expiry: { overdue: overdue.n },
        deletions: {
            waiting: waitingDeletions,
            held: heldDeletions,
        },
        artifacts: { stored: artifacts.n, bytes: artifacts.bytes },
        warnings,
    };
}
