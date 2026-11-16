import type { Database } from "@launchpad/database";
import type { Kysely } from "kysely";
import { collectArtifacts, sweepOrphanArtifactFiles } from "./artifact-gc";
import {
    claimDeletion,
    runDeletion,
    type DeletionDeps,
    type DeletionOutcome,
    type LifecyclePorts,
} from "./deletions";
import { expirePreviews } from "./expiry";
import type { LifecycleConfig } from "./lifecycle";

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
