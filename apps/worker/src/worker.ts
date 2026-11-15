import type { Database } from "@launchpad/database";
import {
    claimNext,
    runDeployment,
    type DeployPorts,
    type DeploymentDeps,
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

const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                resolve();
            },
            { once: true },
        );
    });

// Polls until asked to stop. An error from one round (a database outage, say) is
// logged without detail and retried after a pause: the lease and the recorded intent
// are what make that safe, not this loop.
export async function runWorker(
    db: Kysely<Database>,
    ports: DeployPorts,
    options: WorkerOptions,
): Promise<void> {
    while (!options.signal.aborted) {
        try {
            const result = await runOnce(db, ports, options);
            if (result === "idle") await sleep(options.pollMs, options.signal);
        } catch {
            options.log?.({ event: "worker-error" });
            await sleep(Math.max(options.pollMs, 5000), options.signal);
        }
    }
}
