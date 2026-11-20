import { setTimeout as delay } from "node:timers/promises";
import type { createDatabase } from "@launchpad-kit/database";
import {
    beginDeletionStep,
    beginDeploymentStep,
    claimDeletion,
    claimDeployment,
    completeDeletionStep,
    completeDeploymentStep,
    DeploymentRecoveryError,
    renewDeletionClaim,
    renewDeploymentClaim,
    stopDeletionStep,
    stopDeploymentStep,
} from "@launchpad-kit/services";
import { DeadlineExceeded, withinDeadline } from "./deadline";
import { runDeletion, type DeletionRunnerPorts } from "./deletion-runner";
import { runDeployment, type DeploymentRunnerPorts } from "./deployment-runner";
import { imageTagFor } from "./template";

export async function workDeployments({
    db,
    dataDir,
    owner,
    ports,
    deletionPorts,
    shutdown,
    markHealthy,
    log,
    // Wall-clock fail-stop budget for the entire operation, including the
    // recovery check and fsync. It deliberately caps multiple SQL waits.
    databaseTimeoutMs = 8000,
}: {
    db: ReturnType<typeof createDatabase>;
    dataDir: string;
    owner: string;
    ports: DeploymentRunnerPorts;
    deletionPorts: DeletionRunnerPorts;
    shutdown: AbortSignal;
    markHealthy: () => void;
    log: (line: Record<string, unknown>) => void;
    databaseTimeoutMs?: number;
}) {
    const fault = new AbortController();
    const signal = AbortSignal.any([shutdown, fault.signal]);

    async function database<T>(run: () => Promise<T>): Promise<T> {
        fault.signal.throwIfAborted();
        try {
            return await withinDeadline(run, databaseTimeoutMs, fault.signal);
        } catch (error) {
            if (error instanceof DeadlineExceeded) {
                fault.abort(new Error("Deployment worker database deadline exceeded."));
            }
            fault.signal.throwIfAborted();
            throw error;
        }
    }

    // Returns whether a deletion was claimed, so the loop continues without sleeping.
    async function deleteOne(): Promise<boolean> {
        const claim = await database(() => claimDeletion(db, dataDir, owner));
        markHealthy();
        if (signal.aborted || claim.kind === "idle") return false;
        if (claim.kind === "reconciliation-needed") {
            log({ event: "deletion-reconciliation-needed", operationId: claim.id });
            return true;
        }
        const { token, deletion } = claim;
        const status = await runDeletion(
            {
                appName: deletion.appName,
                imageTag: imageTagFor(deletion.deploymentId),
                ownsRemoteApp: deletion.ownsRemoteApp,
            },
            { stepDone: deletion.stepDone },
            {
                begin: (step) => database(() => beginDeletionStep(db, dataDir, token, step)),
                complete: (step) => database(() => completeDeletionStep(db, dataDir, token, step)),
                stop: (step, outcome) =>
                    database(() => stopDeletionStep(db, dataDir, token, step, outcome)),
                renew: async () => {
                    const lease = await database(() => renewDeletionClaim(db, dataDir, token));
                    if (lease) markHealthy();
                    return lease;
                },
            },
            deletionPorts,
            signal,
        );
        log({ event: "deletion-run-ended", operationId: token.id, status });
        return status !== "authority-lost";
    }

    let blocked = false;
    let turn = 0;
    while (!signal.aborted) {
        try {
            // Alternate so a steady stream of deployments cannot starve deletions.
            if (turn++ % 2 === 1 && (await deleteOne())) continue;
            if (signal.aborted) break;
            const claim = await database(() => claimDeployment(db, dataDir, owner));
            blocked = false;
            markHealthy();
            if (signal.aborted) break;
            if (claim.kind === "claimed") {
                const { deployment: row, token, storageKey } = claim;
                const status = await runDeployment(
                    {
                        deploymentId: row.id,
                        appName: row.app_name,
                        hostname: row.hostname,
                        spa: row.spa,
                        storageKey,
                    },
                    {
                        stepDone: row.step_done,
                        image:
                            row.image_tag && row.image_id
                                ? { imageTag: row.image_tag, imageId: row.image_id }
                                : null,
                    },
                    {
                        begin: (step) =>
                            database(() => beginDeploymentStep(db, dataDir, token, step)),
                        complete: (completion) =>
                            database(() => completeDeploymentStep(db, dataDir, token, completion)),
                        stop: (step, outcome) =>
                            database(() => stopDeploymentStep(db, dataDir, token, step, outcome)),
                        renew: async () => {
                            const lease = await database(() =>
                                renewDeploymentClaim(db, dataDir, token),
                            );
                            if (lease) markHealthy();
                            return lease;
                        },
                    },
                    ports,
                    signal,
                );
                log({ event: "deployment-run-ended", deploymentId: row.id, status });
                if (status !== "authority-lost") continue;
            } else if (claim.kind === "reconciliation-needed") {
                log({ event: "deployment-reconciliation-needed", deploymentId: claim.id });
                continue;
            } else if (await deleteOne()) {
                continue;
            }
        } catch (error) {
            if (signal.aborted) break;
            if (error instanceof DeploymentRecoveryError) {
                if (!blocked) log({ event: "deployment-recovery-blocked" });
                blocked = true;
            } else {
                // Adapter, SQL and filesystem errors can contain secrets or output. Neither
                // container logs nor deployment events should echo those details.
                log({ event: "deployment-worker-error" });
            }
        }
        await delay(2000, undefined, { signal }).catch(() => undefined);
    }
    // Do not start another claim with a pool that may still have a stuck query.
    // The entrypoint closes the pool with a bounded disconnect and exits.
    fault.signal.throwIfAborted();
}
