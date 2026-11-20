import type { Database, DeploymentStatus, DeploymentStep } from "@launchpad-kit/database";
import { type Kysely, sql } from "kysely";
import { withModelMutation } from "./deployment-recovery";

type Db = Kysely<Database>;

const runnable = [
    "queued",
    "preparing",
    "building",
    "deploying",
    "verifying",
] as const satisfies readonly DeploymentStatus[];
export const DEPLOYMENT_LEASE_MS = 300_000;
const leaseDeadline = sql<Date>`clock_timestamp() + (${DEPLOYMENT_LEASE_MS} * interval '1 millisecond')`;
const databaseNow = sql<Date>`clock_timestamp()`;
const previousStep = {
    app: null,
    build: "app",
    configure: "build",
    load: "configure",
    verify: "load",
} as const satisfies Record<DeploymentStep, DeploymentStep | null>;
const stepStatus = {
    app: "preparing",
    build: "building",
    configure: "deploying",
    load: "deploying",
    verify: "verifying",
} as const satisfies Record<DeploymentStep, DeploymentStatus>;

export interface DeploymentClaimToken {
    id: string;
    owner: string;
    attempt: number;
    fence: string;
}

// Claim/reclaim runs under the recovery gate but never calls Docker or Dokku.
// The returned lease uses the database clock. The runner must bound its calls
// within that lease and treat a failed renewal as authority loss.
export async function claimDeployment(db: Db, dataDir: string, owner: string) {
    if (!owner.trim()) throw new Error("A deployment claim needs a worker identity.");
    return withModelMutation(db, dataDir, async (trx) => {
        const candidate = await trx
            .selectFrom("deployment")
            .select(["id", "organization_id", "status", "step_pending"])
            .where("desired_state", "=", "active")
            .where("status", "in", [...runnable])
            .where((eb) =>
                eb.or([
                    eb("lease_expires_at", "is", null),
                    eb("lease_expires_at", "<=", sql<Date>`clock_timestamp()`),
                ]),
            )
            .orderBy("created_at")
            .orderBy("id")
            .limit(1)
            .forUpdate()
            .skipLocked()
            .executeTakeFirst();
        if (!candidate) return { kind: "idle" } as const;

        // A durable pending effect is not proof that the effect ran or stopped.
        // Keep the pending step for reconciliation and never dispatch it again.
        // Verification alone is read-only and may be repeated.
        if (candidate.step_pending !== null && candidate.step_pending !== "verify") {
            await trx
                .updateTable("deployment")
                .set({
                    status: "reconciliation-needed",
                    failure_code: "lease-expired-with-pending-step",
                    failure_message: "The previous worker left an unconfirmed deployment step.",
                    lease_owner: null,
                    lease_expires_at: null,
                    updated_at: sql<Date>`clock_timestamp()`,
                })
                .where("id", "=", candidate.id)
                .executeTakeFirstOrThrow();
            await appendEvent(
                trx,
                candidate,
                "reconciliation-needed",
                "warn",
                "The previous worker left an unconfirmed deployment step.",
            );
            return { kind: "reconciliation-needed", id: candidate.id } as const;
        }

        const deployment = await trx
            .updateTable("deployment")
            .set((eb) => ({
                status: candidate.status === "queued" ? "preparing" : candidate.status,
                attempt: eb("attempt", "+", 1),
                fence: sql<string>`fence + 1`,
                lease_owner: owner,
                lease_expires_at: leaseDeadline,
                step_pending: null,
                updated_at: sql<Date>`clock_timestamp()`,
            }))
            .where("id", "=", candidate.id)
            .returningAll()
            .executeTakeFirstOrThrow();
        const token: DeploymentClaimToken = {
            id: deployment.id,
            owner,
            attempt: deployment.attempt,
            fence: deployment.fence,
        };
        const artifact = await trx
            .selectFrom("artifact")
            .select("storage_key")
            .where("id", "=", deployment.artifact_id)
            .where("organization_id", "=", deployment.organization_id)
            .executeTakeFirstOrThrow();
        return { kind: "claimed", token, deployment, storageKey: artifact.storage_key } as const;
    });
}

// Lock before evaluating expiration: a write that waited behind another
// transaction must use the clock after that wait, not its own start time.
function withLockedClaim<T>(
    db: Db,
    dataDir: string,
    token: DeploymentClaimToken,
    run: (trx: Db, update: ReturnType<typeof fencedUpdate>) => Promise<T>,
) {
    return withModelMutation(db, dataDir, async (trx) => {
        const row = await trx
            .selectFrom("deployment")
            .select("id")
            .where("id", "=", token.id)
            .forUpdate()
            .executeTakeFirst();
        if (!row) return null;
        return run(trx, fencedUpdate(trx, token));
    });
}

function fencedUpdate(trx: Db, token: DeploymentClaimToken) {
    return trx
        .updateTable("deployment")
        .where("id", "=", token.id)
        .where("lease_owner", "=", token.owner)
        .where("attempt", "=", token.attempt)
        .where("fence", "=", token.fence)
        .where("desired_state", "=", "active")
        .where("status", "in", [...runnable])
        .where("lease_expires_at", ">", databaseNow);
}

export function renewDeploymentClaim(db: Db, dataDir: string, token: DeploymentClaimToken) {
    return withLockedClaim(db, dataDir, token, async (_trx, update) => {
        const renewed = await update
            .set({ lease_expires_at: leaseDeadline, updated_at: databaseNow })
            .returning("lease_expires_at")
            .executeTakeFirst();
        return renewed?.lease_expires_at ?? null;
    });
}

// The deployment row is locked through the event insert, serializing sequence
// allocation with both worker transitions and reconciliation on lease loss.
async function appendEvent(
    trx: Db,
    deployment: { id: string; organization_id: string },
    phase: string,
    level: "info" | "warn" | "error",
    message: string,
) {
    await sql`
        insert into app_deployment_event (organization_id, deployment_id, seq, phase, level, message)
        select ${deployment.organization_id}, ${deployment.id}, coalesce(max(seq), 0) + 1,
            ${phase}, ${level}, ${message}
        from app_deployment_event where deployment_id = ${deployment.id}
    `.execute(trx);
}

// Commit intent before dispatch, not after. A null return is never permission
// to perform the step, even when the caller believes it still holds the lease.
export function beginDeploymentStep(
    db: Db,
    dataDir: string,
    token: DeploymentClaimToken,
    step: DeploymentStep,
) {
    const previous = previousStep[step];
    return withLockedClaim(db, dataDir, token, async (trx, update) => {
        const row = await update
            .set({ status: stepStatus[step], step_pending: step, updated_at: databaseNow })
            .where("step_pending", "is", null)
            .where("step_done", previous === null ? "is" : "=", previous)
            .returningAll()
            .executeTakeFirst();
        if (!row) return null;
        await appendEvent(trx, row, step, "info", "Deployment step started.");
        return row;
    });
}

type StepCompletion =
    | { step: Exclude<DeploymentStep, "build"> }
    | { step: "build"; imageTag: string; imageId: string };

export function completeDeploymentStep(
    db: Db,
    dataDir: string,
    token: DeploymentClaimToken,
    completion: StepCompletion,
) {
    const { step } = completion;
    if (
        step === "build" &&
        completion.imageTag !== `launchpad/site:${token.id.replaceAll("-", "")}`
    ) {
        throw new Error("Image tag does not belong to this deployment.");
    }
    const verified = step === "verify";
    return withLockedClaim(db, dataDir, token, async (trx, update) => {
        const row = await update
            .set({
                step_done: step,
                step_pending: null,
                updated_at: databaseNow,
                ...(step === "build"
                    ? { image_tag: completion.imageTag, image_id: completion.imageId }
                    : {}),
                ...(verified
                    ? {
                          status: "succeeded",
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
        await appendEvent(
            trx,
            row,
            verified ? "succeeded" : step,
            "info",
            "Deployment step completed.",
        );
        return row;
    });
}

// The caller may report a definite failure only once it knows no remote work
// is still running. A lost or ambiguous response retains the step to reconcile.
export function stopDeploymentStep(
    db: Db,
    dataDir: string,
    token: DeploymentClaimToken,
    step: DeploymentStep,
    outcome: "failed" | "reconciliation-needed",
) {
    const failed = outcome === "failed";
    const message = failed
        ? "Deployment step failed."
        : "Deployment step outcome could not be confirmed.";
    return withLockedClaim(db, dataDir, token, async (trx, update) => {
        const row = await update
            .set({
                status: outcome,
                step_pending: failed ? null : step,
                failure_code: failed ? "step-failed" : "step-outcome-unknown",
                failure_message: message,
                finished_at: failed ? databaseNow : null,
                lease_owner: null,
                lease_expires_at: null,
                updated_at: databaseNow,
            })
            .where("step_pending", "=", step)
            .returningAll()
            .executeTakeFirst();
        if (!row) return null;
        await appendEvent(trx, row, outcome, failed ? "error" : "warn", message);
        return row;
    });
}
