import type { Database } from "@launchpad/database";
import { type Kysely, sql } from "kysely";
import { collectArtifacts, sweepOrphanArtifactFiles } from "./artifact-gc";
import {
    claimDeletion,
    runDeletion,
    type DeletionDeps,
    type DeletionOutcome,
    type LifecyclePorts,
} from "./deletions";
import { expirePreviews } from "./expiry";
import { LIFECYCLE_AUDIT, type LifecycleConfig } from "./lifecycle";

export interface LifecycleOptions {
    owner: string;
    config: LifecycleConfig;
    dataDir: string;
    leaseMs?: number;
    signal?: AbortSignal;
    deletion?: Omit<DeletionDeps, "enabled">;
    // How often artifacts are collected; the scheduler and deletions run on every call.
    collectEveryMs?: number;
}

export interface LifecycleState {
    lastCollect: number;
    // Whether this process has made sure the first switch-on was handled.
    started?: boolean;
}

export const FIRST_ENABLE_GRACE_SECONDS = 24 * 3600;

// The first time the lifecycle is ever switched on for this database, previews that are
// already overdue (new previews have had a lifetime since it was recorded, while nothing
// acted on it) are given a fresh grace period instead of being deleted within minutes. Done
// once: a marker is recorded in the same transaction, so a second worker or a restart does
// nothing. Returns how many previews were given the grace.
export async function beginLifecycle(
    db: Kysely<Database>,
    graceSeconds = FIRST_ENABLE_GRACE_SECONDS,
): Promise<{ first: boolean; graced: number }> {
    return db.transaction().execute(async (trx) => {
        await sql`select pg_advisory_xact_lock(hashtextextended('lifecycle:first-enable', 0))`.execute(
            trx,
        );
        const marker = await trx
            .insertInto("instance_state")
            .values({ key: "lifecycle.enabled_at", value: new Date().toISOString() })
            .onConflict((oc) => oc.doNothing())
            .returning("key")
            .executeTakeFirst();
        if (!marker) return { first: false, graced: 0 };
        const graced = await trx
            .updateTable("preview")
            .set({ expires_at: sql<Date>`now() + ${graceSeconds} * interval '1 second'` })
            .where("desired_state", "=", "active")
            .where("expires_at", "is not", null)
            .where("expires_at", "<=", sql<Date>`now()`)
            .returning("id")
            .execute();
        await trx
            .insertInto("audit_event")
            .values({
                actor: "system",
                action: LIFECYCLE_AUDIT.lifecycleEnabled,
                target_type: "instance",
                target_id: "lifecycle",
                detail: JSON.stringify({ gracedPreviews: graced.length, graceSeconds }),
            })
            .execute();
        return { first: true, graced: graced.length };
    });
}

export interface LifecycleResult {
    expired: number;
    deletion: DeletionOutcome | "none";
    collected: number;
    swept: number;
}

// One round of the lifecycle work, for a worker to call between deployments: claim what has
// expired, run at most one deletion, and now and then collect artifacts. Everything is off
// unless the lifecycle is switched on, and a switched-off instance does not even read the
// tables. `state` is the caller's, so the rhythm of collection survives between rounds.
export async function runLifecycleOnce(
    db: Kysely<Database>,
    ports: LifecyclePorts,
    options: LifecycleOptions,
    state: LifecycleState = { lastCollect: 0 },
): Promise<LifecycleResult> {
    const result: LifecycleResult = { expired: 0, deletion: "none", collected: 0, swept: 0 };
    if (!options.config.enabled || options.signal?.aborted) return result;
    if (!state.started) {
        await beginLifecycle(db);
        state.started = true;
    }
    result.expired = (await expirePreviews(db)).claimed.length;
    const deps: DeletionDeps = { ...options.deletion, enabled: true };
    const claim = await claimDeletion(db, options.owner, deps, options.leaseMs);
    if (claim) {
        result.deletion = await runDeletion(db, claim, ports, deps, { signal: options.signal });
    }
    const every = options.collectEveryMs ?? 10 * 60_000;
    if (Date.now() - state.lastCollect >= every && !options.signal?.aborted) {
        state.lastCollect = Date.now();
        const retentionSeconds = options.config.artifactRetentionSeconds;
        result.collected = (
            await collectArtifacts(db, { dataDir: options.dataDir, retentionSeconds })
        ).collected.length;
        const swept = await sweepOrphanArtifactFiles(db, {
            dataDir: options.dataDir,
            retentionSeconds,
        });
        result.swept = swept.removed + swept.restored;
    }
    return result;
}
