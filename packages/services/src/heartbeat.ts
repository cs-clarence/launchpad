import type { Database } from "@launchpad-kit/database";
import { type Kysely, sql } from "kysely";
import { MAX_BEAT_SECONDS, MIN_BEAT_SECONDS } from "./controller-config";

type Db = Kysely<Database>;

export interface HeartbeatIdentity {
    // Stable across restarts: the row's key.
    name: string;
    // New for every process.
    runId: string;
    beatSeconds: number;
}

const now = sql<Date>`clock_timestamp()`;

// The stale limit for one row: a worker that runs a slower beat than the controller's setting
// assumes is never mislabelled. A hand-edited `beat_seconds` is clamped to the allowed range.
export function effectiveStaleSeconds(staleAfterSeconds: number, beatSeconds: number): number {
    const beat = Math.min(MAX_BEAT_SECONDS, Math.max(MIN_BEAT_SECONDS, beatSeconds));
    return Math.max(staleAfterSeconds, 3 * beat);
}

// Records the start of a run: a restart updates the row in place, so rows do not multiply.
// `takenOver` is true when another run of the same name beat recently (two live workers with one
// name), which the worker logs.
export async function startHeartbeat(
    db: Db,
    identity: HeartbeatIdentity,
    staleAfterSeconds: number,
): Promise<{ takenOver: boolean }> {
    const existing = await db
        .selectFrom("worker_heartbeat")
        .select([
            "run_id",
            "beat_seconds",
            sql<number>`extract(epoch from clock_timestamp() - seen_at)`.as("age"),
            "stopped_at",
        ])
        .where("name", "=", identity.name)
        .executeTakeFirst();
    await db
        .insertInto("worker_heartbeat")
        .values({
            name: identity.name,
            run_id: identity.runId,
            started_at: now,
            seen_at: now,
            stopped_at: null,
            beat_seconds: identity.beatSeconds,
        })
        .onConflict((conflict) =>
            conflict.column("name").doUpdateSet({
                run_id: identity.runId,
                started_at: now,
                seen_at: now,
                stopped_at: null,
                beat_seconds: identity.beatSeconds,
            }),
        )
        .execute();
    return {
        takenOver:
            existing !== undefined &&
            existing.run_id !== identity.runId &&
            existing.stopped_at === null &&
            Number(existing.age) <= effectiveStaleSeconds(staleAfterSeconds, existing.beat_seconds),
    };
}

// An update, not an upsert: it only touches this run's own row. When the row is gone (pruned) or
// belongs to another run, the result says so and the caller starts again.
export async function beatHeartbeat(db: Db, identity: HeartbeatIdentity): Promise<boolean> {
    const result = await db
        .updateTable("worker_heartbeat")
        .set({ seen_at: now, stopped_at: null })
        .where("name", "=", identity.name)
        .where("run_id", "=", identity.runId)
        .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
}

// A clean shutdown. The next start clears it.
export async function stopHeartbeat(db: Db, identity: HeartbeatIdentity): Promise<void> {
    await db
        .updateTable("worker_heartbeat")
        .set({ stopped_at: now })
        .where("name", "=", identity.name)
        .where("run_id", "=", identity.runId)
        .execute();
}

// Keeps decommissioned or renamed workers from lingering.
export async function pruneHeartbeats(db: Db, olderThanSeconds: number): Promise<number> {
    const result = await db
        .deleteFrom("worker_heartbeat")
        .where(
            "seen_at",
            "<",
            sql<Date>`clock_timestamp() - make_interval(secs => ${olderThanSeconds})`,
        )
        .executeTakeFirst();
    return Number(result.numDeletedRows);
}
