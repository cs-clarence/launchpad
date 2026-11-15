import type { Database, DeploymentStatus, DeploymentStep } from "@launchpad/database";
import { type Kysely, sql, type Transaction } from "kysely";
import { z } from "zod";
import type { Principal } from "./authorization";
import { isUniqueViolation, ServiceError } from "./errors";
import { recordAudit, requireMembership } from "./organizations";

type Db = Kysely<Database>;
type Trx = Transaction<Database>;

// The deployment row is the queue and the lease. Nothing here talks to Dokku directly:
// the worker passes `DeployPorts`, so the state machine is tested against a fake.

export const DEFAULT_LEASE_MS = 15 * 60 * 1000;
export const MAX_ATTEMPTS = 5;
// A call is aborted at this fraction of the lease, so a worker that has lost its
// lease has already been told to stop before a successor can start.
const SIGNAL_FRACTION = 0.8;

export const STEPS: readonly DeploymentStep[] = ["app", "build", "configure", "load", "verify"];
const STEP_STATUS: Record<DeploymentStep, DeploymentStatus> = {
    app: "preparing",
    build: "building",
    configure: "deploying",
    load: "deploying",
    verify: "verifying",
};
const RUNNING: DeploymentStatus[] = ["preparing", "building", "deploying", "verifying"];

export function deploymentsEnabled(value: string | undefined): boolean {
    if (value === undefined || value === "" || value === "off") return false;
    if (value === "on") return true;
    throw new Error('LAUNCHPAD_DEPLOYMENTS must be "on" or "off".');
}

// A worker that is no longer the current attempt. It must stop at once and touch
// nothing more: the successor owns the deployment.
export class StaleAttemptError extends Error {
    constructor() {
        super("This attempt no longer owns the deployment.");
        this.name = "StaleAttemptError";
    }
}

export interface DeployContext {
    deploymentId: string;
    appName: string;
    hostname: string;
    spa: boolean;
    storageKey: string;
}

// What the worker can do. `dokku` is structurally the @launchpad/dokku client.
export interface DeployPorts {
    dokku: {
        apps: {
            exists(app: string, signal?: AbortSignal): Promise<boolean>;
            create(app: string, signal?: AbortSignal): Promise<void>;
        };
        domains: { set(app: string, host: string, signal?: AbortSignal): Promise<void> };
        ports: { set(app: string, mapping: string, signal?: AbortSignal): Promise<void> };
    };
    // Builds the image for this deployment and returns its tag. Idempotent.
    build(context: DeployContext, signal: AbortSignal): Promise<{ imageTag: string }>;
    // Streams the built image to Dokku. Not idempotent in effect.
    loadImage(context: DeployContext, imageTag: string, signal: AbortSignal): Promise<void>;
    // Reads the app through the proxy; throws when it is not serving the new image.
    verify(context: DeployContext, signal: AbortSignal): Promise<void>;
}

export interface DeploymentDeps {
    enabled: boolean;
}

const enqueueSchema = z.object({ artifactId: z.uuid(), spa: z.boolean().default(false) });

// Records the deployment in the caller's transaction: either it exists and will be
// picked up, or it does not exist. A preview has at most one unfinished deployment
// (a database rule), so a second request while one runs, or one is awaiting
// reconciliation, is refused.
export async function enqueueDeployment(
    db: Db,
    principal: Principal,
    organizationId: string,
    previewId: string,
    input: unknown,
    deps: DeploymentDeps,
) {
    await requireMembership(db, principal, organizationId, "preview:deploy");
    if (!deps.enabled) throw new ServiceError("conflict", "Deployments are not enabled.");
    if (!z.uuid().safeParse(previewId).success) {
        throw new ServiceError("not-found", "Preview not found.");
    }
    const parsed = enqueueSchema.safeParse(input);
    if (!parsed.success) throw new ServiceError("invalid", "The deployment request is invalid.");
    try {
        return await db.transaction().execute(async (trx) => {
            await requireMembership(trx, principal, organizationId, "preview:deploy");
            const preview = await trx
                .selectFrom("preview")
                .select(["id", "desired_state"])
                .where("organization_id", "=", organizationId)
                .where("id", "=", previewId)
                .forUpdate()
                .executeTakeFirst();
            if (!preview) throw new ServiceError("not-found", "Preview not found.");
            if (preview.desired_state !== "active") {
                throw new ServiceError("conflict", "That preview is being deleted.");
            }
            const artifact = await trx
                .selectFrom("artifact")
                .select("id")
                .where("organization_id", "=", organizationId)
                .where("id", "=", parsed.data.artifactId)
                .executeTakeFirst();
            if (!artifact) throw new ServiceError("not-found", "Artifact not found.");
            const row = await trx
                .insertInto("deployment")
                .values({
                    organization_id: organizationId,
                    preview_id: previewId,
                    artifact_id: artifact.id,
                    spa: parsed.data.spa,
                    requested_by: principal.userId,
                })
                .returning(["id", "status", "created_at"])
                .executeTakeFirstOrThrow();
            await recordAudit(trx, {
                actor: principal,
                action: "deployment.queued",
                targetType: "deployment",
                targetId: row.id,
                organizationId,
            });
            return { id: row.id, status: row.status, createdAt: row.created_at.toISOString() };
        });
    } catch (error) {
        if (isUniqueViolation(error)) {
            throw new ServiceError(
                "conflict",
                "That preview already has an unfinished deployment.",
            );
        }
        throw error;
    }
}

export interface Claim {
    deploymentId: string;
    organizationId: string;
    attempt: number;
    owner: string;
    leaseMs: number;
    stepDone: DeploymentStep | null;
    stepPending: DeploymentStep | null;
}

// Takes the oldest queued deployment, or one whose worker's lease ran out. Taking it
// raises the attempt, which fences every earlier holder out. Deployments awaiting
// reconciliation are never taken.
export async function claimNext(
    db: Db,
    owner: string,
    leaseMs = DEFAULT_LEASE_MS,
): Promise<Claim | null> {
    return db.transaction().execute(async (trx) => {
        const next = await trx
            .selectFrom("deployment")
            .select(["id", "organization_id", "attempt", "step_done", "step_pending"])
            .where("status", "in", ["queued", ...RUNNING])
            // Free means never leased or the lease has run out: a deployment that is
            // claimed but still marked queued is not free.
            .where((eb) =>
                eb.or([
                    eb("lease_expires_at", "is", null),
                    eb("lease_expires_at", "<", sql<Date>`now()`),
                ]),
            )
            .orderBy("created_at")
            .limit(1)
            .forUpdate()
            .skipLocked()
            .executeTakeFirst();
        if (!next) return null;
        const attempt = next.attempt + 1;
        if (attempt > MAX_ATTEMPTS) {
            // A load that was in flight may have changed what is running: that is
            // held for a person, never turned into a plain failure.
            const unknownLoad = next.step_pending === "load";
            await trx
                .updateTable("deployment")
                .set({
                    status: unknownLoad ? "reconciliation-needed" : "failed",
                    failure_code: unknownLoad ? "load-uncertain" : "too-many-attempts",
                    failure_message: unknownLoad
                        ? "A previous attempt stopped while loading the image."
                        : "The deployment was abandoned too many times.",
                    ...(unknownLoad ? {} : { finished_at: sql<Date>`now()` }),
                    updated_at: sql<Date>`now()`,
                    lease_owner: null,
                    lease_expires_at: null,
                    attempt,
                })
                .where("id", "=", next.id)
                .execute();
            await event(trx, next.organization_id, next.id, "claim", "error", "Too many attempts.");
            return null;
        }
        await trx
            .updateTable("deployment")
            .set({
                attempt,
                lease_owner: owner,
                lease_expires_at: sql<Date>`now() + ${leaseMs} * interval '1 millisecond'`,
                updated_at: sql<Date>`now()`,
            })
            .where("id", "=", next.id)
            .execute();
        await event(trx, next.organization_id, next.id, "claim", "info", `Attempt ${attempt}.`);
        return {
            deploymentId: next.id,
            organizationId: next.organization_id,
            attempt,
            owner,
            leaseMs,
            stepDone: next.step_done,
            stepPending: next.step_pending,
        };
    });
}

async function event(
    trx: Trx,
    organizationId: string,
    deploymentId: string,
    phase: string,
    level: "info" | "warn" | "error",
    message: string,
) {
    const last = await trx
        .selectFrom("deployment_event")
        .select((eb) => eb.fn.max("seq").as("seq"))
        .where("deployment_id", "=", deploymentId)
        .executeTakeFirst();
    await trx
        .insertInto("deployment_event")
        .values({
            organization_id: organizationId,
            deployment_id: deploymentId,
            seq: (last?.seq ?? 0) + 1,
            phase,
            level,
            message: message.slice(0, 500),
        })
        .execute();
}

type Patch = Partial<{
    status: DeploymentStatus;
    step_done: DeploymentStep | null;
    step_pending: DeploymentStep | null;
    image_tag: string;
    failure_code: string;
    failure_message: string;
    finished: boolean;
    release: boolean;
}>;

// Every state write goes through here: it applies only while this attempt still holds
// a live lease on a deployment that is still running, and it extends the lease.
type Log = { phase: string; level?: "info" | "warn" | "error"; message: string };

async function fenced(db: Db, claim: Claim, patch: Patch, log?: Log) {
    await db.transaction().execute((trx) => fencedIn(trx, claim, patch, log));
}

async function fencedIn(trx: Trx, claim: Claim, patch: Patch, log?: Log) {
    {
        const { finished, release, ...columns } = patch;
        const updated = await trx
            .updateTable("deployment")
            .set({
                ...columns,
                updated_at: sql<Date>`now()`,
                ...(finished ? { finished_at: sql<Date>`now()` } : {}),
                ...(release
                    ? { lease_owner: null, lease_expires_at: null }
                    : {
                          lease_expires_at: sql<Date>`clock_timestamp() + ${claim.leaseMs} * interval '1 millisecond'`,
                      }),
            })
            .where("id", "=", claim.deploymentId)
            .where("attempt", "=", claim.attempt)
            .where("lease_owner", "=", claim.owner)
            // The statement-time clock, not the transaction start: a write that waited past the
            // lease must not commit under it.
            .where("lease_expires_at", ">", sql<Date>`clock_timestamp()`)
            .where("status", "in", ["queued", ...RUNNING])
            .returning("id")
            .executeTakeFirst();
        if (!updated) throw new StaleAttemptError();
        if (log) {
            await event(
                trx,
                claim.organizationId,
                claim.deploymentId,
                log.phase,
                log.level ?? "info",
                log.message,
            );
        }
    }
}

const kindOf = (error: unknown): { kind?: string } =>
    typeof error === "object" && error !== null && (error as Error).name === "DokkuError"
        ? (error as { kind?: string })
        : {};

export interface RunOptions {
    signal?: AbortSignal;
}

export type RunOutcome = "succeeded" | "failed" | "reconciliation-needed" | "stale";

// Runs one claimed deployment to a terminal state. A stale attempt stops quietly with
// "stale"; a database failure propagates (the lease then runs out and a successor
// reconciles from the recorded step).
export async function runDeployment(
    db: Db,
    claim: Claim,
    ports: DeployPorts,
    options: RunOptions = {},
): Promise<RunOutcome> {
    try {
        return await execute(db, claim, ports, options);
    } catch (error) {
        if (error instanceof StaleAttemptError) return "stale";
        throw error;
    }
}

async function execute(
    db: Db,
    claim: Claim,
    ports: DeployPorts,
    options: RunOptions,
): Promise<RunOutcome> {
    // A `load` that was in flight when its worker stopped may or may not have replaced
    // the running app, and nothing readable tells which image is live. Do not guess.
    if (claim.stepPending === "load") {
        await fenced(
            db,
            claim,
            {
                status: "reconciliation-needed",
                failure_code: "load-uncertain",
                failure_message: "A previous attempt stopped while loading the image.",
                release: true,
            },
            { phase: "load", level: "error", message: "Outcome unknown; needs reconciliation." },
        );
        return "reconciliation-needed";
    }

    const row = await db
        .selectFrom("deployment")
        .innerJoin("preview", (join) =>
            join
                .onRef("preview.id", "=", "deployment.preview_id")
                .onRef("preview.organization_id", "=", "deployment.organization_id"),
        )
        .innerJoin("artifact", (join) =>
            join
                .onRef("artifact.id", "=", "deployment.artifact_id")
                .onRef("artifact.organization_id", "=", "deployment.organization_id"),
        )
        .select([
            "deployment.spa",
            "deployment.image_tag",
            "preview.id as preview_id",
            "preview.app_name",
            "preview.hostname",
            "artifact.storage_key",
        ])
        .where("deployment.id", "=", claim.deploymentId)
        .where("deployment.organization_id", "=", claim.organizationId)
        .executeTakeFirstOrThrow();
    const context: DeployContext = {
        deploymentId: claim.deploymentId,
        appName: row.app_name,
        hostname: row.hostname,
        spa: row.spa,
        storageKey: row.storage_key,
    };
    let imageTag = row.image_tag;

    const done = claim.stepPending
        ? STEPS.indexOf(claim.stepPending) - 1
        : claim.stepDone
          ? STEPS.indexOf(claim.stepDone)
          : -1;
    for (const step of STEPS.slice(done + 1)) {
        // Intent is recorded, fenced, before anything is changed: if this worker
        // stops after the change, the successor sees which step was in flight.
        await fenced(
            db,
            claim,
            { status: STEP_STATUS[step], step_pending: step },
            { phase: step, message: `Starting ${step}.` },
        );
        const signal = AbortSignal.any([
            ...(options.signal ? [options.signal] : []),
            AbortSignal.timeout(Math.floor(claim.leaseMs * SIGNAL_FRACTION)),
        ]);
        try {
            if (step === "app") {
                if (!(await ports.dokku.apps.exists(context.appName, signal))) {
                    await ports.dokku.apps.create(context.appName, signal);
                }
            } else if (step === "build") {
                imageTag = (await ports.build(context, signal)).imageTag;
            } else if (step === "configure") {
                await ports.dokku.domains.set(context.appName, context.hostname, signal);
                await ports.dokku.ports.set(context.appName, "http:80:80", signal);
            } else if (step === "load") {
                await ports.loadImage(context, imageTag as string, signal);
            } else {
                await ports.verify(context, signal);
            }
        } catch (error) {
            const { kind } = kindOf(error);
            // An image load that did not clearly fail cannot be undone or checked: stop, and hold the
            // preview until a person has looked. Any other step is idempotent, so its
            // failure, even an uncertain one, only fails this deployment.
            const known = ["invalid-argument", "trust", "not-started", "failed"];
            if (step === "load" && !(kind && known.includes(kind))) {
                await fenced(
                    db,
                    claim,
                    {
                        status: "reconciliation-needed",
                        failure_code: "load-uncertain",
                        failure_message: "The image load ended with an unknown outcome.",
                        release: true,
                    },
                    {
                        phase: step,
                        level: "error",
                        message: "Outcome unknown; needs reconciliation.",
                    },
                );
                return "reconciliation-needed";
            }
            await fenced(
                db,
                claim,
                {
                    status: "failed",
                    failure_code: kind ? `dokku-${kind}` : `${step}-failed`,
                    failure_message: `The ${step} step failed.`,
                    finished: true,
                    release: true,
                    step_pending: null,
                },
                { phase: step, level: "error", message: `The ${step} step failed.` },
            );
            return "failed";
        }
        await fenced(
            db,
            claim,
            {
                step_done: step,
                step_pending: null,
                ...(step === "build" && imageTag ? { image_tag: imageTag } : {}),
            },
            { phase: step, message: `Finished ${step}.` },
        );
    }

    // Activation and success are one transaction, fenced: the preview points at this
    // deployment only if this attempt still owns it.
    await db.transaction().execute(async (trx) => {
        await fencedIn(
            trx,
            claim,
            { status: "succeeded", finished: true, release: true },
            {
                phase: "activate",
                message: "Deployment succeeded.",
            },
        );
        await trx
            .updateTable("preview")
            .set({ active_deployment_id: claim.deploymentId })
            .where("id", "=", row.preview_id)
            .where("organization_id", "=", claim.organizationId)
            .execute();
    });
    return "succeeded";
}

// A person has checked Dokku and decides how a deployment held for reconciliation
// ends. It never touches Dokku; it only unblocks the preview.
export async function resolveReconciliation(
    db: Db,
    principal: Principal,
    organizationId: string,
    deploymentId: string,
    outcome: "failed" | "succeeded",
) {
    await requireMembership(db, principal, organizationId, "preview:resolve");
    if (!z.uuid().safeParse(deploymentId).success) {
        throw new ServiceError("not-found", "Deployment not found.");
    }
    await db.transaction().execute(async (trx) => {
        await requireMembership(trx, principal, organizationId, "preview:resolve");
        // Preview before deployment, as enqueueing and activation do.
        const owner = await trx
            .selectFrom("deployment")
            .select("preview_id")
            .where("organization_id", "=", organizationId)
            .where("id", "=", deploymentId)
            .executeTakeFirst();
        if (!owner) throw new ServiceError("not-found", "Deployment not found.");
        await trx
            .selectFrom("preview")
            .select("id")
            .where("id", "=", owner.preview_id)
            .where("organization_id", "=", organizationId)
            .forUpdate()
            .execute();
        const row = await trx
            .selectFrom("deployment")
            .select(["preview_id", "status"])
            .where("organization_id", "=", organizationId)
            .where("id", "=", deploymentId)
            .forUpdate()
            .executeTakeFirst();
        if (!row) throw new ServiceError("not-found", "Deployment not found.");
        if (row.status !== "reconciliation-needed") {
            throw new ServiceError("conflict", "That deployment is not awaiting reconciliation.");
        }
        await trx
            .updateTable("deployment")
            .set({
                status: outcome,
                finished_at: sql<Date>`now()`,
                updated_at: sql<Date>`now()`,
                step_pending: null,
                ...(outcome === "failed"
                    ? {
                          failure_code: "resolved-failed",
                          failure_message: "Resolved by an administrator.",
                      }
                    : { failure_code: null, failure_message: null }),
            })
            .where("id", "=", deploymentId)
            .execute();
        if (outcome === "succeeded") {
            await trx
                .updateTable("preview")
                .set({ active_deployment_id: deploymentId })
                .where("id", "=", row.preview_id)
                .where("organization_id", "=", organizationId)
                .execute();
        }
        await event(
            trx,
            organizationId,
            deploymentId,
            "resolve",
            "info",
            `Resolved as ${outcome}.`,
        );
        await recordAudit(trx, {
            actor: principal,
            action: "deployment.reconciliation-resolved",
            targetType: "deployment",
            targetId: deploymentId,
            organizationId,
            detail: outcome,
        });
    });
}
