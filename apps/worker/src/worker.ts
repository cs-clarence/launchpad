import type { Database } from "@launchpad-kit/database";
import {
    claimNext,
    runDeployment,
    recordHeartbeat,
    runLifecycleOnce,
    type DeployPorts,
    type DeploymentDeps,
    type LifecycleConfig,
    type LifecyclePorts,
    type LifecycleState,
    type RunOutcome,
} from "@launchpad-kit/services";
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
    // Says to the operator that this worker is alive. Absent, none is written.
    heartbeat?: { version: string; everyMs?: number };
    // Called each time a heartbeat was recorded: the container healthcheck's signal of life.
    onHealthy?: () => void;
}

export const DEFAULT_HEARTBEAT_MS = 10_000;

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
    let lastLifecycle = 0;
    // On a timer of its own, not in the loop: a deployment can take minutes, and a worker
    // that is busy building is alive. A failed beat is only reported: it must never stop the
    // work it describes, and beats do not pile up behind a slow database.
    let beaten = false;
    let beating = false;
    let inFlight: Promise<void> = Promise.resolve();
    const beat = async () => {
        const settings = options.heartbeat;
        if (!settings || beating) return;
        beating = true;
        const done = Promise.withResolvers<void>();
        inFlight = done.promise;
        try {
            await recordHeartbeat(db, {
                workerId: options.owner,
                version: settings.version,
                lifecycleEnabled: options.lifecycle?.config.enabled ?? false,
                started: !beaten,
            });
            beaten = true;
            options.onHealthy?.();
        } catch {
            options.log?.({ event: "heartbeat-error" });
        } finally {
            beating = false;
            done.resolve();
        }
    };
    const timer = options.heartbeat
        ? setInterval(() => void beat(), options.heartbeat.everyMs ?? DEFAULT_HEARTBEAT_MS)
        : undefined;
    // The first one does not hold up starting, or stopping, if the database is slow.
    void beat();
    // Lifecycle work fills the time between deployments, but a worker that always has a
    // deployment to run must still expire and delete now and then.
    const LIFECYCLE_AT_LEAST_EVERY_MS = 30_000;
    try {
        while (!options.signal.aborted) {
            try {
                const result = await runOnce(db, ports, options);
                let busy = result !== "idle";
                const due = Date.now() - lastLifecycle >= LIFECYCLE_AT_LEAST_EVERY_MS;
                if ((!busy || due) && options.lifecycle?.config.enabled) {
                    lastLifecycle = Date.now();
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
                    if (
                        round.expired > 0 ||
                        round.deletion !== "none" ||
                        round.collected > 0 ||
                        round.collectionFailed
                    ) {
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
    } finally {
        if (timer) clearInterval(timer);
        // A beat already under way finishes before the caller closes the database.
        await inFlight;
    }
}
