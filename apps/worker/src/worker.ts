import type { Database } from "@launchpad/database";
import {
    claimNext,
    runDeployment,
    runLifecycleOnce,
    type DeployPorts,
    type DeploymentDeps,
    type LifecycleConfig,
    type LifecyclePorts,
    type LifecycleState,
    type RunOutcome,
} from "@launchpad/services";
import type { Kysely } from "kysely";

export interface WorkerOptions {
    owner: string;
    deps: DeploymentDeps;
    leaseMs: number;
    pollMs: number;
    signal: AbortSignal;
    log?: (line: Record<string, unknown>) => void;
    // Scheduled expiry, deletion and cleanup. Absent, or with `config.enabled` false, the
    // worker only deploys.
    lifecycle?: { ports: LifecyclePorts; config: LifecycleConfig; dataDir: string };
}

// Claims and runs at most one deployment. "idle" means there was nothing to do.
export async function runOnce(
    db: Kysely<Database>,
    ports: DeployPorts,
    options: Pick<WorkerOptions, "owner" | "deps" | "leaseMs" | "signal" | "log">,
): Promise<RunOutcome | "idle"> {
    const claim = await claimNext(db, options.owner, options.deps, options.leaseMs);
    if (!claim) return "idle";
    const outcome = await runDeployment(db, claim, ports, { signal: options.signal });
    options.log?.({ event: "deployment", id: claim.deploymentId, attempt: claim.attempt, outcome });
    return outcome;
}

export const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
        // An abort that already happened will not fire again.
        if (signal.aborted) return resolve();
        const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
        };
        const timer = setTimeout(done, ms);
        signal.addEventListener("abort", done, { once: true });
    });

// Polls until asked to stop. An error from one round (a database outage, say) is
// logged without detail and retried after a pause: the lease and the recorded intent
// are what make that safe, not this loop.
export async function runWorker(
    db: Kysely<Database>,
    ports: DeployPorts,
    options: WorkerOptions,
): Promise<void> {
    const state: LifecycleState = { lastCollect: 0 };
    while (!options.signal.aborted) {
        try {
            const result = await runOnce(db, ports, options);
            // Deployments first: lifecycle work only fills the time between them.
            let busy = result !== "idle";
            if (!busy && options.lifecycle?.config.enabled) {
                const round = await runLifecycleOnce(
                    db,
                    options.lifecycle.ports,
                    {
                        owner: options.owner,
                        config: options.lifecycle.config,
                        dataDir: options.lifecycle.dataDir,
                        signal: options.signal,
                    },
                    state,
                );
                if (round.expired > 0 || round.deletion !== "none" || round.collected > 0) {
                    options.log?.({ event: "lifecycle", ...round });
                    busy = round.deletion !== "none" && round.deletion !== "retry";
                }
            }
            if (!busy) await sleep(options.pollMs, options.signal);
        } catch {
            options.log?.({ event: "worker-error" });
            await sleep(Math.max(options.pollMs, 5000), options.signal);
        }
    }
}
