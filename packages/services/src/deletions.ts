import { startDeadline } from "./deadline";
import type { Database } from "@launchpad/database";
import { type Kysely, sql, type Transaction } from "kysely";
import { z } from "zod";
import type { Principal } from "./authorization";
import { StaleAttemptError } from "./deployments";
import { ServiceError } from "./errors";
import { LIFECYCLE_AUDIT } from "./lifecycle";
import { recordAudit, requireMembership } from "./organizations";

type Db = Kysely<Database>;
type Trx = Transaction<Database>;

// Project limits are enforced by transports, after this organization-scoped lookup.
export async function deletionProjectId(
    db: Db,
    principal: Principal,
    organizationId: string,
    operationId: string,
) {
    await requireMembership(db, principal, organizationId, "preview:read");
    if (!z.uuid().safeParse(operationId).success) {
        throw new ServiceError("not-found", "Deletion not found.");
    }
    const row = await db
        .selectFrom("deletion_operation as op")
        .innerJoin("preview as p", "p.id", "op.preview_id")
        .select("p.project_id")
        .where("op.organization_id", "=", organizationId)
        .where("p.organization_id", "=", organizationId)
        .where("op.id", "=", operationId)
        .executeTakeFirst();
    if (!row) throw new ServiceError("not-found", "Deletion not found.");
    return row.project_id;
}

// The latest deletion of a preview, so a client that did not start it (an expiry did, or the
// response was lost) can follow it and, if it is held, have it resolved.
export async function getPreviewDeletion(
    db: Db,
    principal: Principal,
    organizationId: string,
    previewId: string,
) {
    await requireMembership(db, principal, organizationId, "preview:read");
    if (!z.uuid().safeParse(previewId).success) {
        throw new ServiceError("not-found", "Preview not found.");
    }
    const row = await db
        .selectFrom("deletion_operation")
        .select("id")
        .where("organization_id", "=", organizationId)
        .where("preview_id", "=", previewId)
        .orderBy("created_at", "desc")
        .limit(1)
        .executeTakeFirst();
    if (!row) throw new ServiceError("not-found", "That preview has no deletion.");
    return getDeletion(db, principal, organizationId, row.id);
}

export async function getDeletion(
    db: Db,
    principal: Principal,
    organizationId: string,
    operationId: string,
) {
    await requireMembership(db, principal, organizationId, "preview:read");
    if (!z.uuid().safeParse(operationId).success) {
        throw new ServiceError("not-found", "Deletion not found.");
    }
    const row = await db
        .selectFrom("deletion_operation")
        .select([
            "id",
            "preview_id",
            "status",
            "reason",
            "failure_code",
            "failure_message",
            "created_at",
            "finished_at",
        ])
        .where("organization_id", "=", organizationId)
        .where("id", "=", operationId)
        .executeTakeFirst();
    if (!row) throw new ServiceError("not-found", "Deletion not found.");
    return {
        id: row.id,
        previewId: row.preview_id,
        status: row.status,
        reason: row.reason,
        failure: row.failure_code
            ? { code: row.failure_code, message: row.failure_message ?? "Deletion did not finish." }
            : null,
        createdAt: row.created_at.toISOString(),
        finishedAt: row.finished_at?.toISOString() ?? null,
    };
}

// Starts a deletion inside the caller's transaction, which must hold the preview's row
// lock. Either the preview is `deleting` with its operation queued, or nothing changed:
// the two are one commit. New deployments are refused from here on (a preview that is not
// active takes none), and the ones still queued, which never started, are cancelled so
// none can begin after the deletion. A deployment that is already running finishes first;
// the operation does not start while one is unfinished.
export async function queueDeletion(
    trx: Transaction<Database>,
    input: {
        organizationId: string;
        previewId: string;
        reason: "manual" | "expired";
        // null: the system (scheduled expiry).
        requestedBy: string | null;
    },
): Promise<{ operationId: string }> {
    const moved = await trx
        .updateTable("preview")
        .set({ desired_state: "deleting" })
        .where("organization_id", "=", input.organizationId)
        .where("id", "=", input.previewId)
        .where("desired_state", "=", "active")
        .returning("id")
        .executeTakeFirst();
    if (!moved) throw new ServiceError("conflict", "That preview is already being deleted.");
    await trx
        .updateTable("deployment")
        .set({
            status: "cancelled",
            failure_code: "preview-deleted",
            failure_message: "The preview was deleted before this deployment started.",
            finished_at: sql<Date>`now()`,
            updated_at: sql<Date>`now()`,
        })
        .where("preview_id", "=", input.previewId)
        .where("status", "=", "queued")
        .execute();
    const operation = await trx
        .insertInto("deletion_operation")
        .values({
            organization_id: input.organizationId,
            preview_id: input.previewId,
            reason: input.reason,
            requested_by: input.requestedBy,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
    return { operationId: operation.id };
}

// ---- Requesting a deletion -------------------------------------------------------------

// Starts the deletion of a preview. A deletion is an operation like a deployment: this
// flips the preview to `deleting` and queues the operation in one commit, and nothing
// waits on Dokku inside the request. Repeating the request returns the operation already
// queued (a delete is naturally idempotent), and a preview that is already gone is
// not-found like any other deleted resource.
export async function requestPreviewDeletion(
    db: Db,
    principal: Principal,
    organizationId: string,
    previewId: string,
    deps: { enabled: boolean },
) {
    await requireMembership(db, principal, organizationId, "preview:delete");
    if (!z.uuid().safeParse(previewId).success) {
        throw new ServiceError("not-found", "Preview not found.");
    }
    return db.transaction().execute(async (trx) => {
        const preview = await trx
            .selectFrom("preview")
            .select(["id", "desired_state"])
            .where("organization_id", "=", organizationId)
            .where("id", "=", previewId)
            .forUpdate()
            .executeTakeFirst();
        // Authority is re-read now that the lock is held: it can change while waiting for it.
        await requireMembership(trx, principal, organizationId, "preview:delete");
        if (!preview || preview.desired_state === "deleted") {
            throw new ServiceError("not-found", "Preview not found.");
        }
        if (preview.desired_state === "deleting") {
            const existing = await trx
                .selectFrom("deletion_operation")
                .select(["id", "status"])
                .where("preview_id", "=", previewId)
                .orderBy("created_at", "desc")
                .limit(1)
                .executeTakeFirstOrThrow();
            return { operationId: existing.id, state: "deleting" as const };
        }
        // Nothing would ever process a new operation: a preview left `deleting` can neither
        // be deployed nor revived, and its app would keep serving. Repeating a request for
        // one already queued (by expiry, say) is still answered above.
        if (!deps.enabled) throw new ServiceError("conflict", "Deletion is not enabled.");
        const { operationId } = await queueDeletion(trx, {
            organizationId,
            previewId,
            reason: "manual",
            requestedBy: principal.userId,
        });
        await recordAudit(trx, {
            actor: principal,
            action: LIFECYCLE_AUDIT.previewDeletionRequested,
            targetType: "preview",
            targetId: previewId,
            organizationId,
        });
        return { operationId, state: "deleting" as const };
    });
}

// ---- Running a deletion ----------------------------------------------------------------

export const DEFAULT_DELETION_LEASE_MS = 5 * 60 * 1000;
export const MAX_DELETION_ATTEMPTS = 5;
// As for deployments: no Dokku call starts after this fraction of the lease has passed on
// the worker's own clock, and calls under way are aborted then.
const SIGNAL_FRACTION = 0.8;

// The only app names Launchpad ever destroys: the generated names of its own previews.
// It is an argument of the run, not a setting: production uses this, and only an opt-in
// test against a disposable Dokku passes a different, guarded one.
export const OWNED_APP_PATTERN = /^lp-[a-z0-9]{10}$/;

export interface DeletionDeps {
    enabled: boolean;
    // Which recorded app names may be destroyed. Defaults to OWNED_APP_PATTERN.
    ownedApp?: RegExp;
    // How long a failed attempt waits before it is tried again. Defaults to a minute that
    // doubles with each attempt, at most half an hour.
    retryBackoffMs?: (attempt: number) => number;
    // How long a deployment held for reconciliation keeps a deletion waiting: its image load
    // may still be running on the Dokku host after it was abandoned. Defaults to an hour,
    // twice the longest lease.
    heldDeploymentWaitMs?: number;
}

export interface DeletionContext {
    previewId: string;
    appName: string;
}

// What the worker can do for a deletion. `dokku.apps` is structurally the @launchpad/dokku
// client's; there is deliberately nothing here that prunes, lists or removes anything but
// one named app and this preview's own images.
export interface LifecyclePorts {
    dokku: {
        apps: {
            exists(app: string, signal?: AbortSignal): Promise<boolean>;
            destroy(app: string, signal?: AbortSignal): Promise<void>;
        };
    };
    // Removes the images the worker built for this preview, by the exact tags recorded on
    // its deployments. Removing an image that is already gone is not an error.
    removeImages(
        context: DeletionContext & { imageTags: string[] },
        signal: AbortSignal,
    ): Promise<void>;
}

export interface DeletionClaim {
    operationId: string;
    organizationId: string;
    previewId: string;
    attempt: number;
    // The fencing generation: monotonic across claims, unlike the retry budget.
    fence: number;
    owner: string;
    leaseMs: number;
    stepDone: "destroy" | "images" | null;
    stepPending: "destroy" | "images" | null;
}

const WAITING_DEPLOYMENT = ["queued", "preparing", "building", "deploying", "verifying"] as const;

// Claims the next deletion that may start: a queued one, or one whose lease has run out
// (its worker died). It does not start while a deployment of the preview is still
// running: that one finishes first, and an operation that waits is simply left for the
// next poll. A deployment held for reconciliation blocks it only for a while after it was
// abandoned (its image load may still be running on the host); once that has passed, it does
// not: destroying the app is what puts the host right either way.
export async function claimDeletion(
    db: Db,
    owner: string,
    deps: DeletionDeps,
    leaseMs = DEFAULT_DELETION_LEASE_MS,
): Promise<DeletionClaim | null> {
    if (!deps.enabled) return null;
    return db.transaction().execute(async (trx) => {
        const next = await trx
            .selectFrom("deletion_operation as op")
            .select([
                "op.id",
                "op.organization_id",
                "op.preview_id",
                "op.attempt",
                "op.fence",
                "op.step_done",
                "op.step_pending",
            ])
            .where("op.status", "in", ["queued", "running"])
            .where((eb) =>
                eb.or([
                    eb("op.lease_expires_at", "is", null),
                    eb("op.lease_expires_at", "<", sql<Date>`clock_timestamp()`),
                ]),
            )
            .where(({ not, exists, selectFrom }) =>
                not(
                    exists(
                        selectFrom("deployment as d")
                            .select("d.id")
                            .whereRef("d.preview_id", "=", "op.preview_id")
                            .where((eb) =>
                                eb.or([
                                    eb("d.status", "in", [...WAITING_DEPLOYMENT]),
                                    eb.and([
                                        eb("d.status", "=", "reconciliation-needed"),
                                        eb(
                                            "d.updated_at",
                                            ">",
                                            sql<Date>`now() - ${deps.heldDeploymentWaitMs ?? 3_600_000} * interval '1 millisecond'`,
                                        ),
                                    ]),
                                ]),
                            ),
                    ),
                ),
            )
            .orderBy("op.created_at")
            .limit(1)
            .forUpdate("op")
            .skipLocked()
            .executeTakeFirst();
        if (!next) return null;
        const attempt = next.attempt + 1;
        const fence = next.fence + 1;
        if (attempt > MAX_DELETION_ATTEMPTS) {
            // Abandoned too often to trust: held for a person, never guessed at.
            await trx
                .updateTable("deletion_operation")
                .set({
                    status: "reconciliation-needed",
                    failure_code: "too-many-attempts",
                    failure_message: "The deletion was abandoned too many times.",
                    updated_at: sql<Date>`now()`,
                    lease_owner: null,
                    lease_expires_at: null,
                    attempt,
                    fence,
                })
                .where("id", "=", next.id)
                .execute();
            return null;
        }
        await trx
            .updateTable("deletion_operation")
            .set({
                attempt,
                fence,
                lease_owner: owner,
                lease_expires_at: sql<Date>`clock_timestamp() + ${leaseMs} * interval '1 millisecond'`,
                updated_at: sql<Date>`now()`,
            })
            .where("id", "=", next.id)
            .execute();
        return {
            operationId: next.id,
            organizationId: next.organization_id,
            previewId: next.preview_id,
            attempt,
            fence,
            owner,
            leaseMs,
            stepDone: next.step_done,
            stepPending: next.step_pending,
        };
    });
}

type Patch = Partial<{
    status: "running" | "succeeded" | "reconciliation-needed";
    step_done: "destroy" | "images" | null;
    step_pending: "destroy" | "images" | null;
    failure_code: string | null;
    failure_message: string | null;
    // The retry budget used so far. Lowered when an attempt did not really count.
    attempt: number;
    finished: boolean;
    // Give the operation up for now, to be claimed again after this long (0: at once).
    retryAfterMs: number;
}>;

// Every state write goes through here: it applies only while this claim (by its fence)
// still holds a live lease on an operation that is still running, and it extends the lease.
async function fenced(trx: Trx | Db, claim: DeletionClaim, patch: Patch) {
    const { finished, retryAfterMs, ...columns } = patch;
    // Finishing, or handing the operation to a person, lets go of the lease; giving it up
    // for a retry lets go of it too, but only becomes claimable after the wait; anything
    // else is progress and extends the lease.
    const release = finished || columns.status === "reconciliation-needed";
    const lease = release
        ? { lease_owner: null, lease_expires_at: null }
        : retryAfterMs !== undefined
          ? {
                lease_owner: null,
                lease_expires_at: sql<Date>`clock_timestamp() + ${retryAfterMs} * interval '1 millisecond'`,
            }
          : {
                lease_expires_at: sql<Date>`clock_timestamp() + ${claim.leaseMs} * interval '1 millisecond'`,
            };
    const updated = await trx
        .updateTable("deletion_operation")
        .set({
            ...columns,
            updated_at: sql<Date>`now()`,
            ...(finished ? { finished_at: sql<Date>`now()` } : {}),
            ...lease,
        })
        .where("id", "=", claim.operationId)
        .where("fence", "=", claim.fence)
        .where("lease_owner", "=", claim.owner)
        // The statement-time clock: a write that waited past the lease must not commit under it.
        .where("lease_expires_at", ">", sql<Date>`clock_timestamp()`)
        .where("status", "in", ["queued", "running"])
        .returning("id")
        .executeTakeFirst();
    if (!updated) throw new StaleAttemptError();
}

export type DeletionOutcome =
    | "succeeded"
    | "retry"
    | "reconciliation-needed"
    | "stale"
    // Asked to shut down: the lease was given up and a successor continues.
    | "stopped";

export interface DeletionRunOptions {
    signal?: AbortSignal;
}

const kindOf = (error: unknown): string | undefined =>
    typeof error === "object" && error !== null && (error as Error).name === "DokkuError"
        ? (error as { kind?: string }).kind
        : undefined;

// Runs one claimed deletion. A stale attempt stops quietly with "stale"; a database
// failure propagates (the lease then runs out and a successor continues from the recorded
// step).
export async function runDeletion(
    db: Db,
    claim: DeletionClaim,
    ports: LifecyclePorts,
    deps: DeletionDeps,
    options: DeletionRunOptions = {},
): Promise<DeletionOutcome> {
    try {
        return await execute(db, claim, ports, deps, options);
    } catch (error) {
        if (error instanceof StaleAttemptError) return "stale";
        throw error;
    }
}

async function execute(
    db: Db,
    claim: DeletionClaim,
    ports: LifecyclePorts,
    deps: DeletionDeps,
    options: DeletionRunOptions,
): Promise<DeletionOutcome> {
    const backoff =
        deps.retryBackoffMs ??
        ((attempt: number) => Math.min(60_000 * 2 ** (attempt - 1), 30 * 60_000));
    const row = await db
        .selectFrom("deletion_operation as op")
        .innerJoin("preview", (join) =>
            join
                .onRef("preview.id", "=", "op.preview_id")
                .onRef("preview.organization_id", "=", "op.organization_id"),
        )
        .select(["preview.app_name", "preview.desired_state"])
        .where("op.id", "=", claim.operationId)
        .where("op.organization_id", "=", claim.organizationId)
        .executeTakeFirstOrThrow();
    const hold = (code: string, message: string) =>
        fenced(db, claim, {
            status: "reconciliation-needed",
            failure_code: code,
            failure_message: message,
        });
    // Only a preview that is being deleted, and only an app of the owned kind: anything
    // else is not ours to destroy, and nothing is sent to Dokku for it.
    if (row.desired_state !== "deleting") {
        await hold("unexpected-state", "The preview is not being deleted.");
        return "reconciliation-needed";
    }
    if (!(deps.ownedApp ?? OWNED_APP_PATTERN).test(row.app_name)) {
        await hold("not-owned", "That app is not one Launchpad created.");
        return "reconciliation-needed";
    }
    const context: DeletionContext = { previewId: claim.previewId, appName: row.app_name };

    // A deadline on this machine's monotonic clock, taken before the lease is written, so
    // it can only be earlier than the lease the database grants.
    const deadlineFor = () => startDeadline(Math.floor(claim.leaseMs * SIGNAL_FRACTION));
    const stopped = async (): Promise<DeletionOutcome> => {
        await fenced(db, claim, { retryAfterMs: 0 });
        return "stopped";
    };

    if (claim.stepDone === null) {
        if (options.signal?.aborted) return stopped();
        const deadline = deadlineFor();
        const guard = () => {
            if (deadline.passed()) throw new StaleAttemptError();
        };
        // Intent first, fenced: a worker that stops after the destroy leaves this behind, and
        // its successor then asks whether the app is still there before doing anything.
        await fenced(db, claim, { status: "running", step_pending: "destroy" });
        const signal = deadline.signal();
        let destroying = false;
        try {
            guard();
            if (await ports.dokku.apps.exists(row.app_name, signal)) {
                guard();
                destroying = true;
                await ports.dokku.apps.destroy(row.app_name, signal);
            }
        } catch (error) {
            if (error instanceof StaleAttemptError) throw error;
            const kind = kindOf(error);
            // A call that was refused before it ran is not an uncertain outcome, and
            // repeating it cannot help; anything else may or may not have happened, and the
            // next attempt checks before it acts. Both are bounded.
            if (kind === "invalid-argument" || kind === "trust") {
                await hold("destroy-rejected", "Dokku refused to destroy the app.");
                return "reconciliation-needed";
            }
            // The connection never opened, so the command certainly did not run: an outage of
            // the host is waited out, not counted against the attempts that would otherwise
            // send every pending deletion to a person.
            // A probe that timed out never asked for a destroy either: nothing to be unsure of.
            if (kind === "not-started" || (!destroying && kind === "uncertain")) {
                await fenced(db, claim, {
                    attempt: claim.attempt - 1,
                    retryAfterMs: 60_000,
                    failure_code: "destroy-waiting",
                    failure_message: "Dokku could not be reached; it will be tried again.",
                });
                return "retry";
            }
            if (claim.attempt >= MAX_DELETION_ATTEMPTS) {
                await hold("destroy-uncertain", "Destroying the app did not finish clearly.");
                return "reconciliation-needed";
            }
            await fenced(db, claim, {
                retryAfterMs: backoff(claim.attempt),
                failure_code: "destroy-retry",
                failure_message: "Destroying the app did not finish; it will be tried again.",
            });
            return "retry";
        } finally {
            deadline.stop();
        }
        await fenced(db, claim, { step_done: "destroy", step_pending: null });
    }

    let imagesLeft = false;
    if (claim.stepDone !== "images") {
        if (options.signal?.aborted) return stopped();
        const deadline = deadlineFor();
        await fenced(db, claim, { step_pending: "images" });
        const tags = await db
            .selectFrom("deployment")
            .select("image_tag")
            .distinct()
            .where("organization_id", "=", claim.organizationId)
            .where("preview_id", "=", claim.previewId)
            .where("image_tag", "is not", null)
            .execute();
        const imageTags = tags.map((t) => t.image_tag as string);
        try {
            if (deadline.passed()) throw new StaleAttemptError();
            await ports.removeImages({ ...context, imageTags }, deadline.signal());
        } catch (error) {
            if (error instanceof StaleAttemptError) throw error;
            if (claim.attempt < MAX_DELETION_ATTEMPTS) {
                await fenced(db, claim, {
                    retryAfterMs: backoff(claim.attempt),
                    failure_code: "images-retry",
                    failure_message: "Removing the images did not finish; it will be tried again.",
                });
                return "retry";
            }
            // The app is gone; leftover images cost disk, not correctness, so the deletion
            // is finished and the leftover is recorded rather than held for a person.
            imagesLeft = true;
        } finally {
            deadline.stop();
        }
        await fenced(db, claim, { step_done: "images", step_pending: null });
    }

    await finishDeletion(db, claim, {
        failure_code: imagesLeft ? "images-left-behind" : null,
        failure_message: imagesLeft ? "The app is gone; some images could not be removed." : null,
    });
    return "succeeded";
}

// The preview is deleted and the operation succeeded in one fenced transaction: the
// preview is marked only if this attempt still owns the operation. The row is locked
// first, the order requesting and extending use.
async function finishDeletion(
    db: Db,
    claim: DeletionClaim,
    note: { failure_code: string | null; failure_message: string | null },
) {
    await db.transaction().execute(async (trx) => {
        await trx
            .selectFrom("preview")
            .select("id")
            .where("id", "=", claim.previewId)
            .where("organization_id", "=", claim.organizationId)
            .forUpdate()
            .execute();
        await fenced(trx, claim, { status: "succeeded", finished: true, ...note });
        await markDeleted(trx, claim.organizationId, claim.previewId, claim.operationId);
    });
}

async function markDeleted(
    trx: Trx,
    organizationId: string,
    previewId: string,
    operationId: string,
) {
    await trx
        .updateTable("preview")
        .set({ desired_state: "deleted", deleted_at: sql<Date>`now()` })
        .where("organization_id", "=", organizationId)
        .where("id", "=", previewId)
        .where("desired_state", "=", "deleting")
        .execute();
    // A deployment held for an administrator was asking what the host is serving: destroying
    // the app answers it, and nothing could resolve it once the preview is gone from the
    // dashboard. Closing it also lets its archive be collected.
    const closed = await trx
        .updateTable("deployment")
        .set({
            status: "failed",
            failure_code: "preview-deleted",
            failure_message:
                "The preview was deleted while this deployment waited for an administrator.",
            step_pending: null,
            finished_at: sql<Date>`now()`,
            updated_at: sql<Date>`now()`,
        })
        .where("preview_id", "=", previewId)
        .where("status", "=", "reconciliation-needed")
        .returning("id")
        .execute();
    await trx
        .insertInto("audit_event")
        .values({
            actor: "system",
            action: LIFECYCLE_AUDIT.previewDeleted,
            target_type: "preview",
            target_id: previewId,
            organization_id: organizationId,
            detail: JSON.stringify({
                operation: operationId,
                closedDeployments: closed.map((d) => d.id),
            }),
        })
        .execute();
}

// ---- Recovery by a person --------------------------------------------------------------

// A person has looked at Dokku and decides how a deletion held for reconciliation ends:
// "deleted" (the app is gone, finish the deletion) or "retry" (it is still there, run it
// again from the start). It never touches Dokku; it only unblocks the operation.
export async function resolveDeletion(
    db: Db,
    principal: Principal,
    organizationId: string,
    operationId: string,
    outcome: "deleted" | "retry",
) {
    await requireMembership(db, principal, organizationId, "preview:resolve");
    if (outcome !== "deleted" && outcome !== "retry") {
        throw new ServiceError("invalid", "The outcome must be deleted or retry.");
    }
    if (!z.uuid().safeParse(operationId).success) {
        throw new ServiceError("not-found", "Deletion not found.");
    }
    await db.transaction().execute(async (trx) => {
        await requireMembership(trx, principal, organizationId, "preview:resolve");
        const owner = await trx
            .selectFrom("deletion_operation")
            .select("preview_id")
            .where("organization_id", "=", organizationId)
            .where("id", "=", operationId)
            .executeTakeFirst();
        if (!owner) throw new ServiceError("not-found", "Deletion not found.");
        // The preview first, then the operation, as every other path does.
        await trx
            .selectFrom("preview")
            .select("id")
            .where("id", "=", owner.preview_id)
            .where("organization_id", "=", organizationId)
            .forUpdate()
            .execute();
        const op = await trx
            .selectFrom("deletion_operation")
            .select(["status"])
            .where("organization_id", "=", organizationId)
            .where("id", "=", operationId)
            .forUpdate()
            .executeTakeFirst();
        if (!op) throw new ServiceError("not-found", "Deletion not found.");
        // Authority is re-read now that the locks are held: it can change while waiting for them.
        await requireMembership(trx, principal, organizationId, "preview:resolve");
        if (op.status !== "reconciliation-needed") {
            throw new ServiceError("conflict", "That deletion is not awaiting reconciliation.");
        }
        if (outcome === "deleted") {
            await trx
                .updateTable("deletion_operation")
                .set({
                    status: "succeeded",
                    failure_code: "resolved-deleted",
                    failure_message: "Resolved by an administrator.",
                    step_pending: null,
                    lease_owner: null,
                    lease_expires_at: null,
                    finished_at: sql<Date>`now()`,
                    updated_at: sql<Date>`now()`,
                })
                .where("id", "=", operationId)
                .execute();
            await markDeleted(trx, organizationId, owner.preview_id, operationId);
        } else {
            await trx
                .updateTable("deletion_operation")
                .set({
                    status: "queued",
                    // The retry budget starts again; the fence does not.
                    attempt: 0,
                    failure_code: null,
                    failure_message: null,
                    step_done: null,
                    step_pending: null,
                    lease_owner: null,
                    lease_expires_at: null,
                    updated_at: sql<Date>`now()`,
                })
                .where("id", "=", operationId)
                .execute();
        }
        await recordAudit(trx, {
            actor: principal,
            action: LIFECYCLE_AUDIT.deletionResolved,
            targetType: "preview",
            targetId: owner.preview_id,
            organizationId,
            detail: `${operationId}: ${outcome}`,
        });
    });
}
