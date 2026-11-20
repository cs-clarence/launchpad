import { setTimeout as delay } from "node:timers/promises";
import type { createDatabase } from "@launchpad-kit/database";
import {
    beginDeploymentStep,
    claimDeployment,
    completeDeploymentStep,
    DeploymentRecoveryError,
    renewDeploymentClaim,
    stopDeploymentStep,
} from "@launchpad-kit/services";
import { runDeployment, type DeploymentRunnerPorts } from "./deployment-runner";

export async function workDeployments({
    db,
    dataDir,
    owner,
    ports,
    shutdown,
    markHealthy,
    log,
}: {
    db: ReturnType<typeof createDatabase>;
    dataDir: string;
    owner: string;
    ports: DeploymentRunnerPorts;
    shutdown: AbortSignal;
    markHealthy: () => void;
    log: (line: Record<string, unknown>) => void;
}) {
    let blocked = false;
    while (!shutdown.aborted) {
        try {
            const claim = await claimDeployment(db, dataDir, owner);
            blocked = false;
            markHealthy();
            if (shutdown.aborted) return;
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
                        begin: (step) => beginDeploymentStep(db, dataDir, token, step),
                        complete: (completion) =>
                            completeDeploymentStep(db, dataDir, token, completion),
                        stop: (step, outcome) =>
                            stopDeploymentStep(db, dataDir, token, step, outcome),
                        renew: async () => {
                            const lease = await renewDeploymentClaim(db, dataDir, token);
                            if (lease) markHealthy();
                            return lease;
                        },
                    },
                    ports,
                    shutdown,
                );
                log({ event: "deployment-run-ended", deploymentId: row.id, status });
                if (status !== "authority-lost") continue;
            } else if (claim.kind === "reconciliation-needed") {
                log({ event: "deployment-reconciliation-needed", deploymentId: claim.id });
                continue;
            }
        } catch (error) {
            if (shutdown.aborted) return;
            if (error instanceof DeploymentRecoveryError) {
                if (!blocked) log({ event: "deployment-recovery-blocked" });
                blocked = true;
            } else {
                // Adapter, SQL and filesystem errors can contain secrets or output. Neither
                // container logs nor deployment events should echo those details.
                log({ event: "deployment-worker-error" });
            }
        }
        await delay(2000, undefined, { signal: shutdown }).catch(() => undefined);
    }
}
