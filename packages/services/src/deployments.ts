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
// A worker starts no Dokku call after this fraction of the lease has passed on its own
// monotonic clock, and aborts calls under way at that point. This bounds, but cannot
// remove, the overlap with a successor: a process frozen between its check and the
// call is not covered, and killing the local ssh does not stop a command already
// running on the Dokku host. Dokku itself does not know the attempt.
const SIGNAL_FRACTION = 0.8;

export const STEPS: readonly DeploymentStep[] = ["app", "build", "configure", "load", "verify"];
const STEP_STATUS: Record<DeploymentStep, DeploymentStatus> = {
    app: "preparing",
    build: "building",
    configure: "deploying",
    load: "deploying",
    verify: "verifying",
};
const KNOWN_KINDS = ["invalid-argument", "trust", "not-started", "failed", "uncertain"];
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
    // Puts the previously active release back: rebuilds it from its own stored
    // artifact, loads it, and checks that it is the one serving. `context` is this
    // deployment (which failed to verify); `previous` is the release to restore.
    rollback(context: DeployContext, previous: DeployContext, signal: AbortSignal): Promise<void>;
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
    stepPending: DeploymentStep | "rollback" | null;
}

// Takes the oldest queued deployment, or one whose worker's lease ran out. Taking it
// raises the attempt, which fences every earlier holder out. Deployments awaiting
// reconciliation are never taken.
export async function claimNext(
    db: Db,
    owner: string,
    deps: DeploymentDeps,
    leaseMs = DEFAULT_LEASE_MS,
): Promise<Claim | null> {
    // Turning the feature off stops work that is already queued, not only new requests.
    if (!deps.enabled) return null;
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
            const unknownLoad =
                next.step_pending === "load" ||
                next.step_pending === "rollback" ||
                next.step_done === "load" ||
                next.step_done === "verify";
            await trx
                .updateTable("deployment")
                .set({
                    status: unknownLoad ? "reconciliation-needed" : "failed",
                    failure_code: unknownLoad ? "load-uncertain" : "too-many-attempts",
                    failure_message: unknownLoad
                        ? "Abandoned too many times during or after the image load."
                        : "The deployment was abandoned too many times.",
                    ...(unknownLoad ? {} : { finished_at: sql<Date>`now()` }),
                    updated_at: sql<Date>`now()`,
                    lease_owner: null,
                    lease_expires_at: null,
                    attempt,
                })
                .where("id", "=", next.id)
                .execute();
            await event(
                trx,
                next.organization_id,
                next.id,
                "claim",
                "error",
                unknownLoad
                    ? "Abandoned around the load; needs reconciliation."
                    : "Too many attempts.",
            );
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
    step_pending: DeploymentStep | "rollback" | null;
    image_tag: string;
    failure_code: string;
    failure_message: string;
    finished: boolean;
    release: boolean;
    // A longer lease for a step known to take longer than the usual one.
    leaseMs: number;
}>;

// Every state write goes through here: it applies only while this attempt still holds
// a live lease on a deployment that is still running, and it extends the lease.
type Log = { phase: string; level?: "info" | "warn" | "error"; message: string };

async function fenced(db: Db, claim: Claim, patch: Patch, log?: Log) {
    await db.transaction().execute((trx) => fencedIn(trx, claim, patch, log));
}

async function fencedIn(trx: Trx, claim: Claim, patch: Patch, log?: Log) {
    {
        const { finished, release, leaseMs, ...columns } = patch;
        const updated = await trx
            .updateTable("deployment")
            .set({
                ...columns,
                updated_at: sql<Date>`now()`,
                ...(finished ? { finished_at: sql<Date>`now()` } : {}),
                ...(release
                    ? { lease_owner: null, lease_expires_at: null }
                    : {
                          lease_expires_at: sql<Date>`clock_timestamp() + ${leaseMs ?? claim.leaseMs} * interval '1 millisecond'`,
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

export type RunOutcome =
    | "succeeded"
    | "failed"
    | "reconciliation-needed"
    | "stale"
    // Asked to shut down: the lease was released and a successor continues.
    | "stopped";

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
    if (claim.stepPending === "load" || claim.stepPending === "rollback") {
        await fenced(
            db,
            claim,
            {
                status: "reconciliation-needed",
                failure_code: "load-uncertain",
                failure_message: "A previous attempt stopped while loading the image.",
                release: true,
            },
            {
                phase: claim.stepPending,
                level: "error",
                message: "Outcome unknown; needs reconciliation.",
            },
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
    // Once an image load has begun, Dokku may be serving what this deployment built:
    // any failure from then on is held for a person, never a plain failure.
    let loadBegun = claim.stepDone === "load" || claim.stepDone === "verify";

    const failAfterVerify = async (): Promise<RunOutcome> => {
        const active = await db
            .selectFrom("preview")
            .select("active_deployment_id")
            .where("id", "=", row.preview_id)
            .where("organization_id", "=", claim.organizationId)
            .executeTakeFirst();
        const previous = active?.active_deployment_id
            ? await db
                  .selectFrom("deployment as d")
                  .innerJoin("artifact as a", (join) =>
                      join
                          .onRef("a.id", "=", "d.artifact_id")
                          .onRef("a.organization_id", "=", "d.organization_id"),
                  )
                  .select(["d.id as id", "d.spa as spa", "a.storage_key as storage_key"])
                  .where("d.id", "=", active.active_deployment_id)
                  .where("d.organization_id", "=", claim.organizationId)
                  .executeTakeFirst()
            : undefined;
        if (active?.active_deployment_id && !previous) {
            // There is a release that should be restored but it cannot be found: do not
            // call that "nothing to restore" while a broken image is serving.
            await fenced(
                db,
                claim,
                {
                    status: "reconciliation-needed",
                    failure_code: "rollback-unavailable",
                    failure_message: "The previous release cannot be restored.",
                    release: true,
                },
                { phase: "rollback", level: "error", message: "The previous release is missing." },
            );
            return "reconciliation-needed";
        }
        if (!previous) {
            // Nothing was serving before, so there is nothing to put back; the preview
            // simply has no active release until the next deployment.
            await fenced(
                db,
                claim,
                {
                    status: "failed",
                    failure_code: "verify-failed",
                    failure_message: "The new release did not become ready.",
                    finished: true,
                    release: true,
                    step_pending: null,
                },
                {
                    phase: "verify",
                    level: "error",
                    message: "The new release did not become ready.",
                },
            );
            return "failed";
        }
        // A rollback rebuilds, loads and probes in one go, which takes longer than any
        // single step, so it is given twice the usual lease and deadline.
        const rollbackLeaseMs = claim.leaseMs * 2;
        const deadline = performance.now() + Math.floor(rollbackLeaseMs * SIGNAL_FRACTION);
        await fenced(
            db,
            claim,
            { status: "verifying", step_pending: "rollback", leaseMs: rollbackLeaseMs },
            { phase: "rollback", level: "warn", message: "Restoring the previous release." },
        );
        try {
            if (performance.now() >= deadline) throw new StaleAttemptError();
            await ports.rollback(
                context,
                {
                    deploymentId: previous.id,
                    appName: row.app_name,
                    hostname: row.hostname,
                    spa: previous.spa,
                    storageKey: previous.storage_key,
                },
                AbortSignal.timeout(Math.max(1, Math.floor(deadline - performance.now()))),
            );
        } catch (error) {
            if (error instanceof StaleAttemptError) throw error;
            // Whatever is serving now is neither known to be the old release nor the
            // new one: held for a person.
            await fenced(
                db,
                claim,
                {
                    status: "reconciliation-needed",
                    failure_code: "rollback-failed",
                    failure_message: "Restoring the previous release failed.",
                    release: true,
                },
                {
                    phase: "rollback",
                    level: "error",
                    message: "The rollback failed; needs reconciliation.",
                },
            );
            return "reconciliation-needed";
        }
        await fenced(
            db,
            claim,
            {
                status: "failed",
                failure_code: "verify-failed-rolled-back",
                failure_message:
                    "The new release did not become ready; the previous one was restored.",
                finished: true,
                release: true,
                step_pending: null,
            },
            { phase: "rollback", level: "warn", message: "The previous release was restored." },
        );
        return "failed";
    };

    const done = claim.stepPending
        ? STEPS.indexOf(claim.stepPending) - 1
        : claim.stepDone
          ? STEPS.indexOf(claim.stepDone)
          : -1;
    for (const step of STEPS.slice(done + 1)) {
        // The deadline is taken on this machine's monotonic clock before the lease is
        // written, so it can only be earlier than the lease the database grants.
        const deadline = performance.now() + Math.floor(claim.leaseMs * SIGNAL_FRACTION);
        // Asked to stop before this step (and so before any load) begins: hand the
        // deployment on without recording an intent that would later look like a load.
        if (options.signal?.aborted && !loadBegun) {
            await fenced(
                db,
                claim,
                { release: true },
                {
                    phase: step,
                    level: "warn",
                    message: "The worker stopped; another will continue.",
                },
            );
            return "stopped";
        }
        // Intent is recorded, fenced, before anything is changed: if this worker
        // stops after the change, the successor sees which step was in flight.
        await fenced(
            db,
            claim,
            { status: STEP_STATUS[step], step_pending: step },
            { phase: step, message: `Starting ${step}.` },
        );
        let loadInvoked = false;
        if (step === "load") loadBegun = true;
        // Checked immediately before every call: a worker that was paused past its
        // deadline (a frozen process, a stalled commit) starts nothing more.
        const guard = () => {
            if (performance.now() >= deadline) throw new StaleAttemptError();
        };
        // A shutdown request does not interrupt a load that is already under way.
        const signal = AbortSignal.any([
            ...(options.signal && step !== "load" ? [options.signal] : []),
            AbortSignal.timeout(Math.max(1, Math.floor(deadline - performance.now()))),
        ]);
        try {
            if (step === "app") {
                guard();
                if (!(await ports.dokku.apps.exists(context.appName, signal))) {
                    guard();
                    await ports.dokku.apps.create(context.appName, signal);
                }
            } else if (step === "build") {
                guard();
                const built = await ports.build(context, signal);
                if (!built.imageTag) throw new Error("The build produced no image tag.");
                imageTag = built.imageTag;
            } else if (step === "configure") {
                guard();
                await ports.dokku.domains.set(context.appName, context.hostname, signal);
                guard();
                await ports.dokku.ports.set(context.appName, "http:80:80", signal);
            } else if (step === "load") {
                guard();
                loadInvoked = true;
                await ports.loadImage(context, imageTag as string, signal);
            } else {
                guard();
                await ports.verify(context, signal);
            }
        } catch (error) {
            if (error instanceof StaleAttemptError) {
                // The deadline passed before the load was started: nothing was sent, so
                // the intent is withdrawn (best effort; a lost lease means a successor
                // owns the row) and the next attempt runs the load as a plain step.
                if (step === "load" && !loadInvoked) {
                    await fenced(db, claim, { step_pending: null, release: true }).catch(
                        () => undefined,
                    );
                }
                throw error;
            }
            // Asked to stop: hand the deployment on, with its intent still recorded.
            if (options.signal?.aborted && step !== "load" && !loadBegun) {
                await fenced(
                    db,
                    claim,
                    { release: true },
                    {
                        phase: step,
                        level: "warn",
                        message: "The worker stopped; another will continue.",
                    },
                );
                return "stopped";
            }
            // A verify is a read: a shutdown just hands it on to be repeated.
            if (options.signal?.aborted && step === "verify") {
                await fenced(
                    db,
                    claim,
                    { release: true },
                    {
                        phase: step,
                        level: "warn",
                        message: "The worker stopped; another will continue.",
                    },
                );
                return "stopped";
            }
            // The image loaded cleanly but is not serving: put the previous release
            // back if there is one, otherwise the deployment simply failed.
            if (step === "verify") return await failAfterVerify();
            const { kind } = kindOf(error);
            // Only a load that certainly never ran leaves the running image as it was.
            const untouched = ["invalid-argument", "trust", "not-started"];
            if (loadBegun && !(step === "load" && kind && untouched.includes(kind))) {
                // From the load on, what Dokku is serving may be this deployment's image.
                await fenced(
                    db,
                    claim,
                    {
                        status: "reconciliation-needed",
                        failure_code: step === "load" ? "load-uncertain" : `${step}-after-load`,
                        failure_message:
                            step === "load"
                                ? "The image load ended without a clear result."
                                : `The ${step} step failed after the image was loaded.`,
                        release: true,
                    },
                    {
                        phase: step,
                        level: "error",
                        message: "The running image may differ from the active deployment.",
                    },
                );
                return "reconciliation-needed";
            }
            await fenced(
                db,
                claim,
                {
                    status: "failed",
                    failure_code:
                        kind && KNOWN_KINDS.includes(kind) ? `dokku-${kind}` : `${step}-failed`,
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
                ...(step === "build" ? { image_tag: imageTag as string } : {}),
            },
            { phase: step, message: `Finished ${step}.` },
        );
    }

    // Activation and success are one transaction, fenced: the preview points at this
    // deployment only if this attempt still owns it. The preview is locked first, the
    // order enqueueing and resolving use, so none of them can wait on another.
    await db.transaction().execute(async (trx) => {
        await trx
            .selectFrom("preview")
            .select("id")
            .where("id", "=", row.preview_id)
            .where("organization_id", "=", claim.organizationId)
            .forUpdate()
            .execute();
        await fencedIn(
            trx,
            claim,
            { status: "succeeded", finished: true, release: true },
            { phase: "activate", message: "Deployment succeeded." },
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
    // Checked at run time: a value from outside the type system must not leave a
    // deployment resumable.
    if (outcome !== "failed" && outcome !== "succeeded") {
        throw new ServiceError("invalid", "The outcome must be failed or succeeded.");
    }
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
