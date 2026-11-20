import type { Database } from "@launchpad-kit/database";
import { type Kysely, sql } from "kysely";
import { requireDeploymentsOn, type AppDeps } from "./apps";
import type { Principal } from "./authorization";
import { appendDeploymentEvent, DEPLOYMENT_LEASE_MS } from "./deployment-claims";
import { withModelMutation } from "./deployment-recovery";
import { ServiceError } from "./errors";
import { recordAudit, requireMembership } from "./organizations";

type Db = Kysely<Database>;
type DeletionStep = "destroy" | "images";

const RETRY_DELAY_MS = 30_000;
const databaseNow = sql<Date>`clock_timestamp()`;
const leaseDeadline = sql<Date>`clock_timestamp() + (${DEPLOYMENT_LEASE_MS} * interval '1 millisecond')`;
const retryDeadline = sql<Date>`clock_timestamp() + (${RETRY_DELAY_MS} * interval '1 millisecond')`;
const previousStep = { destroy: null, images: "destroy" } as const;

export interface DeletionClaimToken {
    id: string;
    owner: string;
    attempt: number;
    fence: string;
}

// Lock order: recovery gate, app row, deployment row. The operation row is created while
// both are held, so a worker that claims it later locks operation then deployment without a
// cycle. A deployment that has not finished, or that needs reconciliation, is refused.
export async function requestDeploymentDeletion(
    db: Db,
    principal: Principal,
    organizationId: string,
    deploymentId: string,
    deps: AppDeps,
    restrictTo?: string[] | null,
) {
    await requireMembership(db, principal, organizationId, "app:delete");
    requireDeploymentsOn(deps.settings);
    return withModelMutation(db, deps.dataDir, async (trx) => {
        await requireMembership(trx, principal, organizationId, "app:delete");
        const found = await trx
            .selectFrom("deployment")
            .innerJoin("app", "app.id", "deployment.app_id")
            .select(["deployment.app_id as appId", "app.project_id as projectId"])
            .where("deployment.id", "=", deploymentId)
            .where("deployment.organization_id", "=", organizationId)
            .where("app.state", "=", "active")
            .executeTakeFirst();
        if (!found || (restrictTo && !restrictTo.includes(found.projectId))) {
            throw new ServiceError("not-found", "Deployment not found.");
        }
        const app = await trx
            .selectFrom("app")
            .select("id")
            .where("id", "=", found.appId)
            .where("state", "=", "active")
            .forUpdate()
            .executeTakeFirst();
        const deployment = app
            ? await trx
                  .selectFrom("deployment")
                  .select(["id", "status", "desired_state"])
                  .where("id", "=", deploymentId)
                  .forUpdate()
                  .executeTakeFirst()
            : undefined;
        if (!deployment) throw new ServiceError("not-found", "Deployment not found.");
        if (deployment.desired_state !== "active") {
            throw new ServiceError("conflict", "This deployment is already being deleted.");
        }
        if (!["succeeded", "failed", "cancelled"].includes(deployment.status)) {
            throw new ServiceError(
                "conflict",
                deployment.status === "reconciliation-needed"
                    ? "This deployment needs reconciliation before it can be deleted."
                    : "This deployment has not finished.",
            );
        }
        const operation = await trx
            .insertInto("deployment_deletion_operation")
            .values({
                organization_id: organizationId,
                app_id: found.appId,
                deployment_id: deploymentId,
                reason: "manual",
                requested_by: principal.userId,
            })
            .returning(["id", "status"])
            .executeTakeFirstOrThrow();
        await trx
            .updateTable("deployment")
            .set({ desired_state: "deleting", updated_at: databaseNow })
            .where("id", "=", deploymentId)
            .executeTakeFirstOrThrow();
        await appendDeploymentEvent(
            trx,
            { id: deploymentId, organization_id: organizationId },
            "deleting",
            "info",
            "Deletion requested.",
        );
        await recordAudit(trx, {
            actor: principal,
            action: "deployment.deletion-requested",
            targetType: "deployment",
            targetId: deploymentId,
            organizationId,
        });
        return { operationId: operation.id, deploymentId, status: operation.status };
    });
}

export async function claimDeletion(db: Db, dataDir: string, owner: string) {
    if (!owner.trim()) throw new Error("A deletion claim needs a worker identity.");
    return withModelMutation(db, dataDir, async (trx) => {
        const candidate = await trx
            .selectFrom("deployment_deletion_operation")
            .select(["id", "organization_id", "deployment_id", "step_pending"])
            .where("status", "in", ["queued", "running"])
            .where((eb) =>
                eb.or([
                    eb("lease_expires_at", "is", null),
                    eb("lease_expires_at", "<=", databaseNow),
                ]),
            )
            .orderBy("created_at")
            .orderBy("id")
            .limit(1)
            .forUpdate()
            .skipLocked()
            .executeTakeFirst();
        if (!candidate) return { kind: "idle" } as const;
        const deployment = await trx
            .selectFrom("deployment")
            .select(["id", "organization_id", "app_name", "step_done"])
            .where("id", "=", candidate.deployment_id)
            .forUpdate()
            .executeTakeFirstOrThrow();
        // A pending destroy may or may not have happened. Image removal can be repeated.
        if (candidate.step_pending === "destroy") {
            await trx
                .updateTable("deployment_deletion_operation")
                .set({
                    status: "reconciliation-needed",
                    failure_code: "lease-expired-with-pending-step",
                    failure_message: "The previous worker left an unconfirmed deletion step.",
                    lease_owner: null,
                    lease_expires_at: null,
                    updated_at: databaseNow,
                })
                .where("id", "=", candidate.id)
                .executeTakeFirstOrThrow();
            await appendDeploymentEvent(
                trx,
                deployment,
                "deletion-reconciliation-needed",
                "warn",
                "The previous worker left an unconfirmed deletion step.",
            );
            return { kind: "reconciliation-needed", id: candidate.id } as const;
        }
        const operation = await trx
            .updateTable("deployment_deletion_operation")
            .set((eb) => ({
                status: "running",
                attempt: eb("attempt", "+", 1),
                fence: sql<string>`fence + 1`,
                lease_owner: owner,
                lease_expires_at: leaseDeadline,
                step_pending: null,
                updated_at: databaseNow,
            }))
            .where("id", "=", candidate.id)
            .returningAll()
            .executeTakeFirstOrThrow();
        return {
            kind: "claimed",
            token: {
                id: operation.id,
                owner,
                attempt: operation.attempt,
                fence: operation.fence,
            } satisfies DeletionClaimToken,
            deletion: {
                deploymentId: deployment.id,
                appName: deployment.app_name,
                // A name that was already taken was never this deployment's app.
                ownsRemoteApp: deployment.step_done !== null,
                stepDone: operation.step_done,
            },
        } as const;
    });
}

function withLockedClaim<T>(
    db: Db,
    dataDir: string,
    token: DeletionClaimToken,
    run: (trx: Db, update: ReturnType<typeof fencedUpdate>) => Promise<T>,
) {
    return withModelMutation(db, dataDir, async (trx) => {
        const row = await trx
            .selectFrom("deployment_deletion_operation")
            .select("id")
            .where("id", "=", token.id)
            .forUpdate()
            .executeTakeFirst();
        if (!row) return null;
        return run(trx, fencedUpdate(trx, token));
    });
}

function fencedUpdate(trx: Db, token: DeletionClaimToken) {
    return trx
        .updateTable("deployment_deletion_operation")
        .where("id", "=", token.id)
        .where("lease_owner", "=", token.owner)
        .where("attempt", "=", token.attempt)
        .where("fence", "=", token.fence)
        .where("status", "=", "running")
        .where("lease_expires_at", ">", databaseNow);
}

export function renewDeletionClaim(db: Db, dataDir: string, token: DeletionClaimToken) {
    return withLockedClaim(db, dataDir, token, async (_trx, update) => {
        const renewed = await update
            .set({ lease_expires_at: leaseDeadline, updated_at: databaseNow })
            .returning("lease_expires_at")
            .executeTakeFirst();
        return renewed?.lease_expires_at ?? null;
    });
}

export function beginDeletionStep(
    db: Db,
    dataDir: string,
    token: DeletionClaimToken,
    step: DeletionStep,
) {
    const previous = previousStep[step];
    return withLockedClaim(db, dataDir, token, (_trx, update) =>
        update
            .set({ step_pending: step, updated_at: databaseNow })
            .where("step_pending", "is", null)
            .where("step_done", previous === null ? "is" : "=", previous)
            .returningAll()
            .executeTakeFirst()
            .then((row) => row ?? null),
    );
}

// Finishing the last step settles the deployment as deleted in the same transaction. The
// hostname and Dokku-name reservations are never touched: they stay reserved permanently.
export function completeDeletionStep(
    db: Db,
    dataDir: string,
    token: DeletionClaimToken,
    step: DeletionStep,
) {
    const last = step === "images";
    return withLockedClaim(db, dataDir, token, async (trx, update) => {
        const row = await update
            .set({
                step_done: step,
                step_pending: null,
                updated_at: databaseNow,
                ...(last
                    ? {
                          status: "succeeded" as const,
                          finished_at: databaseNow,
                          lease_owner: null,
                          lease_expires_at: null,
                      }
                    : {}),
            })
            .where("step_pending", "=", step)
            .returningAll()
            .executeTakeFirst();
        if (!row) return null;
        if (last) {
            const deployment = await trx
                .selectFrom("deployment")
                .select(["id", "organization_id"])
                .where("id", "=", row.deployment_id)
                .forUpdate()
                .executeTakeFirstOrThrow();
            await trx
                .updateTable("deployment")
                .set({ desired_state: "deleted", deleted_at: databaseNow, updated_at: databaseNow })
                .where("id", "=", deployment.id)
                .executeTakeFirstOrThrow();
            await appendDeploymentEvent(trx, deployment, "deleted", "info", "Deleted.");
        }
        return row;
    });
}

// `retry` is only for a step the caller knows never started or that is safe to repeat; it may
// follow a read that ran before the step was recorded. It waits before the operation can be
// claimed again. Anything uncertain is held for reconciliation.
export function stopDeletionStep(
    db: Db,
    dataDir: string,
    token: DeletionClaimToken,
    step: DeletionStep,
    outcome: "retry" | "reconciliation-needed",
) {
    const retry = outcome === "retry";
    return withLockedClaim(db, dataDir, token, async (trx, update) => {
        const row = await update
            .set({
                status: retry ? "queued" : "reconciliation-needed",
                step_pending: retry ? null : step,
                failure_code: retry ? "step-failed" : "step-outcome-unknown",
                failure_message: retry
                    ? "Deletion step failed and will be retried."
                    : "Deletion step outcome could not be confirmed.",
                lease_owner: null,
                lease_expires_at: retry ? retryDeadline : null,
                updated_at: databaseNow,
            })
            .where((eb) =>
                retry
                    ? eb.or([eb("step_pending", "=", step), eb("step_pending", "is", null)])
                    : eb("step_pending", "=", step),
            )
            .returningAll()
            .executeTakeFirst();
        if (!row) return null;
        if (!retry) {
            const deployment = await trx
                .selectFrom("deployment")
                .select(["id", "organization_id"])
                .where("id", "=", row.deployment_id)
                .forUpdate()
                .executeTakeFirstOrThrow();
            await appendDeploymentEvent(
                trx,
                deployment,
                "deletion-reconciliation-needed",
                "warn",
                "Deletion step outcome could not be confirmed.",
            );
        }
        return row;
    });
}
