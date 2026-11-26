import type { Database } from "@launchpad-kit/database";
import { type Kysely, sql } from "kysely";
import type { Principal } from "./authorization";
import { DEFAULT_HEARTBEAT, type HeartbeatConfig } from "./controller-config";
import { ServiceError } from "./errors";
import { effectiveStaleSeconds } from "./heartbeat";

type Db = Kysely<Database>;

export interface StatusOptions {
    // With deployments off there is no worker to report on.
    deploymentsEnabled: boolean;
    thresholds: Pick<HeartbeatConfig, "staleAfterSeconds" | "warnBeforeSeconds">;
}

const MAX_ITEMS = 20;
// Rows kept in view for the overall state; the table holds a handful, and old ones are removed.
const MAX_ROWS = 200;
// How long past its lease an operation must be, with a worker reporting, to count as wedged.
const WEDGED_AFTER_SECONDS = 60;

type WorkerState = "ok" | "stale" | "stopped";

// How the instance is doing, for the operator: that the database answers, what is stored, whether
// a worker is alive and how many operations hold a lease about to lapse. Counts and durations
// only: no ids or text that came from a remote system. Worker names are operator-chosen or derived
// from the hostname (this is operator-only). Every time comes from the
// database clock.
export async function getStatus(
    db: Db,
    principal: Principal,
    options: StatusOptions = { deploymentsEnabled: false, thresholds: DEFAULT_HEARTBEAT },
) {
    if (principal.instanceRole !== "operator") {
        throw new ServiceError("forbidden", "Only the instance operator may read this.");
    }
    const { deploymentsEnabled, thresholds } = options;
    const artifacts = await db
        .selectFrom("artifact")
        .select([
            sql<number>`count(*)::int`.as("n"),
            sql<number>`coalesce(sum(size_bytes), 0)::float8`.as("bytes"),
        ])
        .where("collected_at", "is", null)
        .executeTakeFirstOrThrow();

    const heartbeats = await db
        .selectFrom("worker_heartbeat")
        .select([
            "name",
            "started_at",
            "stopped_at",
            "beat_seconds",
            sql<number>`extract(epoch from clock_timestamp() - seen_at)::float8`.as("age"),
        ])
        .orderBy("seen_at", "desc")
        .limit(MAX_ROWS)
        .execute();
    const rows = heartbeats.map((row) => {
        const age = Math.max(0, Number(row.age));
        const state: WorkerState =
            row.stopped_at !== null
                ? "stopped"
                : age <= effectiveStaleSeconds(thresholds.staleAfterSeconds, row.beat_seconds)
                  ? "ok"
                  : "stale";
        return {
            name: row.name,
            state,
            lastSeenSecondsAgo: Math.floor(age),
            runStartedAt: row.started_at.toISOString(),
        };
    });
    const workerState = !deploymentsEnabled
        ? ("off" as const)
        : rows.some((row) => row.state === "ok")
          ? ("ok" as const)
          : rows.length > 0
            ? ("stale" as const)
            : ("missing" as const);

    const lease = (
        await sql<{ inFlight: number; expiring: number; expired: number; wedged: number }>`
            select count(*)::int as "inFlight",
                count(*) filter (
                    where lease_expires_at > clock_timestamp()
                    and lease_expires_at <= clock_timestamp() + make_interval(secs => ${thresholds.warnBeforeSeconds})
                )::int as expiring,
                count(*) filter (where lease_expires_at <= clock_timestamp())::int as expired,
                count(*) filter (
                    where lease_expires_at <= clock_timestamp() - make_interval(secs => ${WEDGED_AFTER_SECONDS})
                )::int as wedged
            from (
                select lease_expires_at from deployment
                    where status in ('preparing', 'building', 'deploying', 'verifying')
                    and lease_expires_at is not null
                union all
                select lease_expires_at from deployment_deletion_operation
                    where status = 'running' and lease_expires_at is not null
                union all
                select lease_expires_at from promotion_operation
                    where status in ('applying', 'verifying') and lease_expires_at is not null
            ) held`.execute(db)
    ).rows[0]!;

    const warnings: string[] = [];
    if (deploymentsEnabled) {
        const noWorker = workerState === "stale" || workerState === "missing";
        if (noWorker) {
            const newest = rows[0]?.lastSeenSecondsAgo;
            warnings.push(
                newest === undefined
                    ? "No deployment worker has reported yet."
                    : `No deployment worker has reported for ${newest} seconds.`,
            );
            const atRisk = lease.expiring + lease.expired;
            if (atRisk > 0) {
                warnings.push(
                    `${atRisk} deployment operation(s) hold a lease that is about to expire or has ` +
                        "expired, and no worker is running; they are held for reconciliation when a worker starts.",
                );
            }
        } else if (lease.wedged > 0) {
            warnings.push(
                `${lease.wedged} operation(s) are past their lease while a worker reports in.`,
            );
        }
    }

    return {
        generatedAt: new Date().toISOString(),
        dependencies: { database: "ok" as const },
        artifacts: { stored: artifacts.n, bytes: artifacts.bytes },
        workers: { state: workerState, items: rows.slice(0, MAX_ITEMS) },
        leases: { inFlight: lease.inFlight, expiring: lease.expiring, expired: lease.expired },
        warnings,
    };
}
