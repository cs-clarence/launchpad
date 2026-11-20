import type { Database, PromotionOperationTable } from "@launchpad-kit/database";
import { type Kysely, type Selectable, sql } from "kysely";
import { appendDeploymentEvent, DEPLOYMENT_LEASE_MS } from "./deployment-claims";
import { withModelMutation } from "./deployment-recovery";
import { isDeploymentPinned } from "./pins";

type Db = Kysely<Database>;
type Operation = Selectable<PromotionOperationTable>;
const runnable = ["queued", "applying", "verifying"] as const;
const now = sql<Date>`clock_timestamp()`;
const deadline = sql<Date>`clock_timestamp() + (${DEPLOYMENT_LEASE_MS} * interval '1 millisecond')`;
const uncertainCode = "route-outcome-unknown";
const uncertainMessage = "The alias route could not be confirmed.";

export interface PromotionClaimToken {
    id: string;
    owner: string;
    attempt: number;
    fence: string;
}

const uncertainState = (operation: Operation) =>
    operation.action === "bind" ? "binding-uncertain" : "withdrawal-uncertain";

async function markAliasUncertain(trx: Db, operation: Operation) {
    await trx
        .updateTable("app_alias")
        .set({ state: uncertainState(operation), updated_at: now })
        .where("id", "=", operation.alias_id)
        // A correction can bind back to the previous target of a withdrawal.
        // Preserve the original uncertainty and its allowed corrective outcomes.
        .where("state", "not in", ["binding-uncertain", "withdrawal-uncertain"])
        .executeTakeFirst();
}

export async function claimPromotion(db: Db, dataDir: string, owner: string) {
    if (!owner.trim()) throw new Error("A promotion claim needs a worker identity.");
    return withModelMutation(db, dataDir, async (trx) => {
        // All promotion writers serialize on the app. Skip busy apps rather than locking
        // operation rows ahead of their parent or making an unrelated app wait.
        const candidate = await trx
            .selectFrom("promotion_operation as op")
            .innerJoin("app", "app.id", "op.app_id")
            .select(["op.id", "op.alias_id"])
            .where("op.status", "in", [...runnable])
            .where("op.superseded_by_operation_id", "is", null)
            .where((eb) =>
                eb.or([
                    eb("op.lease_expires_at", "is", null),
                    eb("op.lease_expires_at", "<=", now),
                ]),
            )
            .orderBy("op.created_at")
            .orderBy("op.id")
            .limit(1)
            .forUpdate("app")
            .skipLocked()
            .executeTakeFirst();
        if (!candidate) return { kind: "idle" } as const;
        const alias = await lockAlias(trx, candidate.alias_id);
        // The candidate came from a statement snapshot. Re-read after acquiring its app lock.
        const operation = await trx
            .selectFrom("promotion_operation")
            .selectAll()
            .where("id", "=", candidate.id)
            .where("status", "in", [...runnable])
            .where("superseded_by_operation_id", "is", null)
            .where((eb) =>
                eb.or([eb("lease_expires_at", "is", null), eb("lease_expires_at", "<=", now)]),
            )
            .forUpdate()
            .executeTakeFirst();
        if (!operation) return { kind: "idle" } as const;
        if (alias.reserved_generation !== operation.generation) {
            // Inconsistent restored or manually edited state needs inspection, not dispatch.
            // Keep its pins and leave the alias alone: its newer state may be authoritative.
            await trx
                .updateTable("promotion_operation")
                .set({
                    ...heldValues(),
                    failure_code: "alias-generation-mismatch",
                    failure_message: "The alias reservation does not match this operation.",
                })
                .where("id", "=", operation.id)
                .executeTakeFirst();
            return { kind: "reconciliation-needed", id: operation.id } as const;
        }
        if (operation.step_pending === "dispatch") {
            await trx
                .updateTable("promotion_operation")
                .set(heldValues())
                .where("id", "=", operation.id)
                .returning("id")
                .executeTakeFirstOrThrow();
            await markAliasUncertain(trx, operation);
            return { kind: "reconciliation-needed", id: operation.id } as const;
        }
        const claimed = await trx
            .updateTable("promotion_operation")
            .set((eb) => ({
                status: operation.step_done === "dispatch" ? "verifying" : "applying",
                attempt: eb("attempt", "+", 1),
                fence: sql<string>`fence + 1`,
                lease_owner: owner,
                lease_expires_at: deadline,
                step_pending: null,
                updated_at: now,
            }))
            .where("id", "=", operation.id)
            .returningAll()
            .executeTakeFirstOrThrow();
        const target = claimed.desired_target_deployment_id
            ? await trx
                  .selectFrom("deployment")
                  .select(["id", "hostname"])
                  .where("id", "=", claimed.desired_target_deployment_id)
                  .executeTakeFirstOrThrow()
            : null;
        const token: PromotionClaimToken = {
            id: claimed.id,
            owner,
            attempt: claimed.attempt,
            fence: claimed.fence,
        };
        return { kind: "claimed", token, alias, operation: claimed, target } as const;
    });
}

function lockAlias(trx: Db, id: string) {
    return trx
        .selectFrom("app_alias")
        .selectAll()
        .where("id", "=", id)
        .forUpdate()
        .executeTakeFirstOrThrow();
}

function fenced(trx: Db, token: PromotionClaimToken) {
    return trx
        .updateTable("promotion_operation")
        .where("id", "=", token.id)
        .where("lease_owner", "=", token.owner)
        .where("attempt", "=", token.attempt)
        .where("fence", "=", token.fence)
        .where("status", "in", ["applying", "verifying"])
        .where("superseded_by_operation_id", "is", null)
        .where("lease_expires_at", ">", now);
}

function lockOperation(trx: Db, id: string) {
    return trx
        .selectFrom("promotion_operation")
        .select("id")
        .where("id", "=", id)
        .forUpdate()
        .executeTakeFirstOrThrow();
}

async function lockParents(trx: Db, id: string) {
    const operation = await trx
        .selectFrom("promotion_operation")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
    if (!operation) return null;
    await trx
        .selectFrom("app")
        .select("id")
        .where("id", "=", operation.app_id)
        .forUpdate()
        .executeTakeFirstOrThrow();
    const alias = await lockAlias(trx, operation.alias_id);
    return { operation, alias };
}

function withClaim<T>(
    db: Db,
    dataDir: string,
    token: PromotionClaimToken,
    run: (trx: Db) => Promise<T>,
    // A run that must lock deployment rows takes the operation lock itself, after them.
    lockOperationFirst = true,
) {
    return withModelMutation(db, dataDir, async (trx) => {
        const parents = await lockParents(trx, token.id);
        if (!parents || parents.alias.reserved_generation !== parents.operation.generation)
            return null;
        // Evaluate expiry after waiting for the row, not against an earlier snapshot.
        if (lockOperationFirst) await lockOperation(trx, token.id);
        return run(trx);
    });
}

export function renewPromotionClaim(db: Db, dataDir: string, token: PromotionClaimToken) {
    return withClaim(db, dataDir, token, async (trx) => {
        const row = await fenced(trx, token)
            .set({ lease_expires_at: deadline, updated_at: now })
            .returning("lease_expires_at")
            .executeTakeFirst();
        return row?.lease_expires_at ?? null;
    });
}

export function beginPromotionStep(
    db: Db,
    dataDir: string,
    token: PromotionClaimToken,
    step: "dispatch" | "verify",
) {
    const dispatch = step === "dispatch";
    return withClaim(
        db,
        dataDir,
        token,
        async (trx) =>
            (await fenced(trx, token)
                .set({ step_pending: step, updated_at: now })
                .where("status", "=", dispatch ? "applying" : "verifying")
                .where("step_pending", "is", null)
                .where("step_done", dispatch ? "is" : "=", dispatch ? null : "dispatch")
                .returning("id")
                .executeTakeFirst()) ?? null,
    );
}

export function acknowledgePromotionDispatch(db: Db, dataDir: string, token: PromotionClaimToken) {
    return withClaim(
        db,
        dataDir,
        token,
        async (trx) =>
            (await fenced(trx, token)
                .set({
                    status: "verifying",
                    step_pending: null,
                    step_done: "dispatch",
                    updated_at: now,
                })
                .where("status", "=", "applying")
                .where("step_pending", "=", "dispatch")
                .returning("id")
                .executeTakeFirst()) ?? null,
    );
}

function heldValues() {
    return {
        status: "reconciliation-needed",
        lease_owner: null,
        lease_expires_at: null,
        failure_code: uncertainCode,
        failure_message: uncertainMessage,
        updated_at: now,
    } as const;
}

export function holdPromotion(db: Db, dataDir: string, token: PromotionClaimToken) {
    return withClaim(db, dataDir, token, async (trx) => {
        const operation = await fenced(trx, token)
            .set(heldValues())
            // Before any dispatch only a corrective operation may be held: an original one is
            // failed instead, but a chain's tip must stay for the operator to extend.
            .where((eb) =>
                eb.or([
                    eb("step_pending", "=", "dispatch"),
                    eb("step_done", "=", "dispatch"),
                    eb("supersedes_operation_id", "is not", null),
                ]),
            )
            .returningAll()
            .executeTakeFirst();
        if (!operation) return null;
        await markAliasUncertain(trx, operation);
        return { id: operation.id };
    });
}

// A definite refusal: the router rejected a request whose effect cannot have applied. Only an
// original (non-corrective) operation may fail; a corrective one must stay held, because failing
// the tip of a chain would leave its held ancestors with nothing left to supersede. Restores the
// alias to its previous stable state and releases the requested target's pin if nothing else
// holds it.
export function failPromotion(
    db: Db,
    dataDir: string,
    token: PromotionClaimToken,
    code: string,
    message: string,
) {
    return withClaim(
        db,
        dataDir,
        token,
        async (trx) => {
            const operation = await trx
                .selectFrom("promotion_operation")
                .selectAll()
                .where("id", "=", token.id)
                .executeTakeFirst();
            if (!operation || operation.supersedes_operation_id !== null) return null;
            const ids = [
                ...new Set(
                    [
                        operation.desired_target_deployment_id,
                        operation.previous_target_deployment_id,
                    ].filter((id): id is string => id !== null),
                ),
            ];
            const deployments = ids.length
                ? await trx
                      .selectFrom("deployment")
                      .select(["id", "organization_id"])
                      .where("id", "in", ids)
                      .orderBy("id")
                      .forUpdate()
                      .execute()
                : [];
            await lockOperation(trx, token.id);
            const failed = await fenced(trx, token)
                .set({
                    status: "failed",
                    step_pending: null,
                    lease_owner: null,
                    lease_expires_at: null,
                    failure_code: code,
                    failure_message: message.slice(0, 500),
                    finished_at: now,
                    updated_at: now,
                })
                .where("status", "=", "applying")
                .where("step_done", "is", null)
                .where("supersedes_operation_id", "is", null)
                .returning("id")
                .executeTakeFirst();
            if (!failed) return null;
            const alias = await trx
                .selectFrom("app_alias")
                .select(["target_deployment_id"])
                .where("id", "=", operation.alias_id)
                .executeTakeFirstOrThrow();
            await trx
                .updateTable("app_alias")
                .set({ state: alias.target_deployment_id ? "bound" : "unbound", updated_at: now })
                .where("id", "=", operation.alias_id)
                .where("state", "in", ["binding", "withdrawing"])
                .returning("id")
                .executeTakeFirstOrThrow();
            for (const deployment of deployments) {
                if (!(await isDeploymentPinned(trx, deployment.id))) {
                    await trx
                        .updateTable("deployment")
                        .set({ last_unpinned_at: now, updated_at: now })
                        .where("id", "=", deployment.id)
                        .returning("id")
                        .executeTakeFirstOrThrow();
                }
            }
            if (operation.desired_target_deployment_id) {
                const target = deployments.find(
                    ({ id }) => id === operation.desired_target_deployment_id,
                );
                if (target) {
                    await appendDeploymentEvent(
                        trx,
                        target,
                        "promotion-failed",
                        "error",
                        "The alias promotion was refused by the router.",
                    );
                }
            }
            return failed;
        },
        false,
    );
}

export interface PromotionReadback {
    instanceId: string;
    epoch: string;
    route: {
        aliasId: string;
        hostname: string;
        operationId: string;
        generation: string;
        target: { deploymentId: string; hostname: string } | null;
    } | null;
}

export async function boundedPromotionEvidence<T>(verify: (signal: AbortSignal) => Promise<T>) {
    const signal = AbortSignal.timeout(30_000);
    const timeout = Promise.withResolvers<never>();
    const abort = () => timeout.reject(new Error("Router verification timed out."));
    signal.addEventListener("abort", abort, { once: true });
    try {
        const evidence = await Promise.race([verify(signal), timeout.promise]);
        signal.throwIfAborted();
        return evidence;
    } finally {
        signal.removeEventListener("abort", abort);
    }
}

// The runner must read the router and verify the served identity (or fixed 404) inside
// this callback, not return cached evidence. The recovery lock excludes managed rotation
// through commit. Do not hold app/alias row locks during network verification.
export function finalizePromotion(
    db: Db,
    dataDir: string,
    token: PromotionClaimToken,
    expectedAuthority: { instanceId: string; epoch: string },
    verify: (signal: AbortSignal) => Promise<PromotionReadback>,
) {
    const authority = { ...expectedAuthority };
    return withModelMutation(db, dataDir, async (trx) => {
        const observed = await boundedPromotionEvidence(verify);
        // Validate and persist the same values across subsequent row lock waits.
        const { instanceId, epoch } = observed;
        const route = observed.route && {
            ...observed.route,
            target: observed.route.target && { ...observed.route.target },
        };
        const parents = await lockParents(trx, token.id);
        if (!parents) return null;
        const { operation, alias } = parents;
        if (
            !route ||
            instanceId !== authority.instanceId ||
            epoch !== authority.epoch ||
            route.aliasId !== alias.id ||
            route.hostname !== alias.hostname ||
            route.operationId !== operation.id ||
            route.generation !== operation.generation ||
            alias.reserved_generation !== operation.generation ||
            (route.target?.deploymentId ?? null) !== operation.desired_target_deployment_id
        )
            return null;

        // All chain writes take the app lock. Read the chain to find every candidate pin
        // before locking deployment rows in UUID order, then lock the operation rows.
        const chain = await sql<{
            id: string;
            previous: string | null;
            desired: string | null;
        }>`
            with recursive chain as (
                select id, supersedes_operation_id, previous_target_deployment_id, desired_target_deployment_id
                from promotion_operation where id = ${operation.id}
                union
                select p.id, p.supersedes_operation_id, p.previous_target_deployment_id, p.desired_target_deployment_id
                from promotion_operation p join chain c on p.id = c.supersedes_operation_id
            )
            select id, previous_target_deployment_id as previous, desired_target_deployment_id as desired
            from chain
        `.execute(trx);
        const ids = [
            ...new Set(
                chain.rows
                    .flatMap(({ previous, desired }) => [previous, desired])
                    .filter((id): id is string => id !== null),
            ),
        ];
        const targets = ids.length
            ? await trx
                  .selectFrom("deployment")
                  .select(["id", "hostname", "status", "desired_state"])
                  .where("app_id", "=", operation.app_id)
                  .where("id", "in", ids)
                  .orderBy("id")
                  .forUpdate()
                  .execute()
            : [];
        if (route.target) {
            const target = targets.find(({ id }) => id === route.target?.deploymentId);
            if (
                !target ||
                target.status !== "succeeded" ||
                target.desired_state !== "active" ||
                target.hostname !== route.target.hostname
            )
                return null;
        }

        await lockOperation(trx, token.id);
        const recorded = {
            observed_epoch: epoch,
            observed_generation: route.generation,
            observed_operation_id: route.operationId,
            observed_target_deployment_id: route.target?.deploymentId ?? null,
            finished_at: now,
            updated_at: now,
        };
        const result = await fenced(trx, token)
            .set({
                ...recorded,
                status: "succeeded",
                step_done: "verify",
                step_pending: null,
                lease_owner: null,
                lease_expires_at: null,
                failure_code: null,
                failure_message: null,
            })
            .where("status", "=", "verifying")
            .where("step_pending", "=", "verify")
            .where("step_done", "=", "dispatch")
            .returning("id")
            .executeTakeFirst();
        if (!result) return null;
        const ancestors = chain.rows.map(({ id }) => id).filter((id) => id !== operation.id);
        if (ancestors.length) {
            const settled = await trx
                .updateTable("promotion_operation")
                .set({ ...recorded, status: "superseded", step_pending: null })
                .where("id", "in", ancestors)
                .where("status", "=", "reconciliation-needed")
                .where("superseded_by_operation_id", "is not", null)
                .returning("id")
                .execute();
            if (settled.length !== ancestors.length)
                throw new Error("Promotion chain is not held.");
        }
        await trx
            .updateTable("app_alias")
            .set({
                state: route.target ? "bound" : "withdrawn",
                target_deployment_id: route.target?.deploymentId ?? null,
                committed_generation: route.generation,
                updated_at: now,
            })
            .where("id", "=", alias.id)
            .returning("id")
            .executeTakeFirstOrThrow();
        if (!route.target) {
            await trx
                .updateTable("hostname_reservation")
                .set({ released_at: now })
                .where("owner_kind", "=", "alias")
                .where("owner_id", "=", alias.id)
                .where("released_at", "is", null)
                .returning("hostname")
                .executeTakeFirstOrThrow();
        }
        for (const { id } of targets) {
            if (!(await isDeploymentPinned(trx, id))) {
                await trx
                    .updateTable("deployment")
                    .set({ last_unpinned_at: now, updated_at: now })
                    .where("id", "=", id)
                    .returning("id")
                    .executeTakeFirstOrThrow();
            }
        }
        return result;
    });
}
