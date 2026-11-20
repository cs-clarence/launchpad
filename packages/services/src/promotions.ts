import { promoteAliasSchema, withdrawAliasSchema } from "@launchpad-kit/contracts";
import type { Database } from "@launchpad-kit/database";
import { type Kysely, sql } from "kysely";
import type { AliasDeps } from "./aliases";
import { requireAliasesOn } from "./aliases";
import type { Principal } from "./authorization";
import { appendDeploymentEvent } from "./deployment-claims";
import { withModelMutation } from "./deployment-recovery";
import { isUniqueViolation, ServiceError } from "./errors";
import { isUuid } from "./ids";
import { parseInput, recordAudit, requireMembership } from "./organizations";

type Db = Kysely<Database>;

const MAX_GENERATION = 9223372036854775807n;
const STABLE = ["unbound", "bound"] as const;

const OPERATION_COLUMNS = [
    "promotion_operation.id",
    "promotion_operation.alias_id as aliasId",
    "promotion_operation.action",
    "promotion_operation.status",
    "promotion_operation.generation",
    "promotion_operation.expected_generation as expectedGeneration",
    "promotion_operation.previous_target_deployment_id as previousTargetDeploymentId",
    "promotion_operation.desired_target_deployment_id as desiredTargetDeploymentId",
    "promotion_operation.supersedes_operation_id as supersedesOperationId",
    "promotion_operation.superseded_by_operation_id as supersededByOperationId",
    "promotion_operation.failure_code as failureCode",
    "promotion_operation.created_at as createdAt",
    "promotion_operation.finished_at as finishedAt",
] as const;

const shape = <T extends { generation: unknown; expectedGeneration: unknown }>(row: T) => ({
    ...row,
    generation: String(row.generation),
    expectedGeneration: String(row.expectedGeneration),
});

function checkKey(key: string | undefined): string {
    if (!key || key.length > 128 || !/^[\x21-\x7e]+$/.test(key)) {
        throw new ServiceError(
            "invalid",
            "An Idempotency-Key of 1 to 128 printable characters is required.",
        );
    }
    return key;
}

interface Request {
    action: "bind" | "withdraw";
    target: string | null;
    expected: string;
    key: string;
}

// One operation is requested here and nothing is dispatched: the intent, the compare-and-swap on
// the alias's reserved generation, the pins and the idempotent retry all commit together, under
// the documented lock order (app row, alias row, deployment rows by id, then operation rows).
async function request(
    db: Db,
    principal: Principal,
    organizationId: string,
    aliasId: string,
    deps: AliasDeps,
    restrictTo: string[] | null | undefined,
    scope: "app:promote" | "app:alias:manage",
    wanted: Request,
) {
    await requireMembership(db, principal, organizationId, scope);
    requireAliasesOn(deps);
    if (!isUuid(aliasId)) throw new ServiceError("not-found", "Alias not found.");
    return withModelMutation(db, deps.dataDir, async (trx) => {
        await requireMembership(trx, principal, organizationId, scope);
        const found = await trx
            .selectFrom("app_alias")
            .innerJoin("app", "app.id", "app_alias.app_id")
            .select(["app_alias.app_id as appId", "app.project_id as projectId"])
            .where("app_alias.id", "=", aliasId)
            .where("app_alias.organization_id", "=", organizationId)
            .where("app.state", "=", "active")
            .executeTakeFirst();
        if (!found || (restrictTo && !restrictTo.includes(found.projectId))) {
            throw new ServiceError("not-found", "Alias not found.");
        }
        const lockedApp = await trx
            .selectFrom("app")
            .select("id")
            .where("id", "=", found.appId)
            .where("state", "=", "active")
            .forUpdate()
            .executeTakeFirst();
        if (!lockedApp) throw new ServiceError("not-found", "Alias not found.");
        const alias = await trx
            .selectFrom("app_alias")
            .select(["id", "state", "target_deployment_id", "reserved_generation"])
            .where("id", "=", aliasId)
            .forUpdate()
            .executeTakeFirstOrThrow();
        const ids = [wanted.target, alias.target_deployment_id].filter(
            (id): id is string => id !== null,
        );
        const deployments = ids.length
            ? await trx
                  .selectFrom("deployment")
                  .select(["id", "organization_id", "status", "desired_state", "app_id"])
                  .where("id", "in", ids)
                  .where("app_id", "=", found.appId)
                  .where("organization_id", "=", organizationId)
                  .orderBy("id")
                  .forUpdate()
                  .execute()
            : [];

        // A retry returns what the first request made, whatever has happened since; a retry with
        // different contents is refused and changes nothing.
        const existing = await trx
            .selectFrom("promotion_operation")
            .select([...OPERATION_COLUMNS])
            .where("alias_id", "=", aliasId)
            .where("idempotency_key", "=", wanted.key)
            // A key belongs to the member who sent it: another member's identical key is theirs.
            .where("requested_by", "=", principal.userId)
            .executeTakeFirst();
        if (existing) {
            if (
                existing.action !== wanted.action ||
                existing.desiredTargetDeploymentId !== wanted.target ||
                String(existing.expectedGeneration) !== wanted.expected
            ) {
                throw new ServiceError(
                    "conflict",
                    "That Idempotency-Key was used for a different request.",
                );
            }
            return shape(existing);
        }

        if (!STABLE.includes(alias.state as (typeof STABLE)[number])) {
            throw new ServiceError(
                "conflict",
                alias.state === "withdrawn"
                    ? "This alias is withdrawn."
                    : "This alias has an operation in progress or needing reconciliation.",
            );
        }
        if (String(alias.reserved_generation) !== wanted.expected) {
            throw new ServiceError(
                "conflict",
                "The alias changed since you read it; read it again.",
            );
        }
        const next = BigInt(alias.reserved_generation) + 1n;
        if (next > MAX_GENERATION) {
            throw new ServiceError("conflict", "This alias has no generations left.");
        }
        if (wanted.action === "bind") {
            const target = deployments.find((deployment) => deployment.id === wanted.target);
            if (
                !target ||
                target.organization_id !== organizationId ||
                target.app_id !== found.appId
            ) {
                throw new ServiceError("not-found", "Deployment not found.");
            }
            if (target.status !== "succeeded" || target.desired_state !== "active") {
                throw new ServiceError(
                    "conflict",
                    "Only a succeeded, undeleted deployment can be promoted.",
                );
            }
            if (wanted.target === alias.target_deployment_id) {
                throw new ServiceError("conflict", "This alias already points at that deployment.");
            }
        }

        let operation;
        try {
            operation = await trx
                .insertInto("promotion_operation")
                .values({
                    organization_id: organizationId,
                    app_id: found.appId,
                    alias_id: aliasId,
                    action: wanted.action,
                    idempotency_key: wanted.key,
                    previous_target_deployment_id: alias.target_deployment_id,
                    desired_target_deployment_id: wanted.target,
                    expected_generation: wanted.expected,
                    generation: next.toString(),
                    requested_by: principal.userId,
                })
                .returning("id")
                .executeTakeFirstOrThrow();
        } catch (error) {
            if (isUniqueViolation(error)) {
                throw new ServiceError(
                    "conflict",
                    "The alias changed or has an operation in progress; read it again.",
                );
            }
            throw error;
        }
        await trx
            .updateTable("app_alias")
            .set({
                state: wanted.action === "bind" ? "binding" : "withdrawing",
                reserved_generation: next.toString(),
                updated_at: sql<Date>`clock_timestamp()`,
            })
            .where("id", "=", aliasId)
            .executeTakeFirstOrThrow();
        if (wanted.target) {
            // The target is pinned from here until the operation is resolved.
            await trx
                .updateTable("deployment")
                .set({ last_unpinned_at: null, updated_at: sql<Date>`clock_timestamp()` })
                .where("id", "=", wanted.target)
                .executeTakeFirstOrThrow();
            await appendDeploymentEvent(
                trx,
                { id: wanted.target, organization_id: organizationId },
                "promotion-requested",
                "info",
                "Promotion requested.",
            );
        }
        await recordAudit(trx, {
            actor: principal,
            action:
                wanted.action === "bind"
                    ? "alias.promotion-requested"
                    : "alias.withdrawal-requested",
            targetType: "alias",
            targetId: aliasId,
            organizationId,
        });
        return shape(
            await trx
                .selectFrom("promotion_operation")
                .select([...OPERATION_COLUMNS])
                .where("id", "=", operation.id)
                .executeTakeFirstOrThrow(),
        );
    });
}

export async function requestPromotion(
    db: Db,
    principal: Principal,
    organizationId: string,
    aliasId: string,
    input: unknown,
    idempotencyKey: string | undefined,
    deps: AliasDeps,
    restrictTo?: string[] | null,
) {
    await requireMembership(db, principal, organizationId, "app:promote");
    const key = checkKey(idempotencyKey);
    const data = parseInput(promoteAliasSchema, input);
    return request(db, principal, organizationId, aliasId, deps, restrictTo, "app:promote", {
        action: "bind",
        target: data.targetDeploymentId.toLowerCase(),
        expected: data.expectedGeneration,
        key,
    });
}

export async function requestWithdrawal(
    db: Db,
    principal: Principal,
    organizationId: string,
    aliasId: string,
    input: unknown,
    idempotencyKey: string | undefined,
    deps: AliasDeps,
    restrictTo?: string[] | null,
) {
    await requireMembership(db, principal, organizationId, "app:alias:manage");
    const key = checkKey(idempotencyKey);
    const data = parseInput(withdrawAliasSchema, input);
    return request(db, principal, organizationId, aliasId, deps, restrictTo, "app:alias:manage", {
        action: "withdraw",
        target: null,
        expected: data.expectedGeneration,
        key,
    });
}

export async function listAliasOperations(
    db: Db,
    principal: Principal,
    organizationId: string,
    aliasId: string,
    restrictTo?: string[] | null,
) {
    await requireMembership(db, principal, organizationId, "app:read");
    if (!isUuid(aliasId)) throw new ServiceError("not-found", "Alias not found.");
    const alias = await db
        .selectFrom("app_alias")
        .innerJoin("app", "app.id", "app_alias.app_id")
        .select("app.project_id as projectId")
        .where("app_alias.id", "=", aliasId)
        .where("app_alias.organization_id", "=", organizationId)
        .where("app.state", "<>", "deleted")
        .executeTakeFirst();
    if (!alias || (restrictTo && !restrictTo.includes(alias.projectId))) {
        throw new ServiceError("not-found", "Alias not found.");
    }
    const rows = await db
        .selectFrom("promotion_operation")
        .select([...OPERATION_COLUMNS])
        .where("alias_id", "=", aliasId)
        .orderBy("generation", "desc")
        .execute();
    return rows.map(shape);
}

// A corrective operation for one the worker could not settle (an operator action; the audited
// attribution is the operator CLI, and the row keeps the original requester because the schema
// requires a user). It takes the next higher generation, links the held operation to it, and from
// then on only the new operation can be dispatched. The held operation keeps its status, and so
// every target it could have routed stays pinned, until a verified outcome finalizes the chain.
export async function supersedeOperation(
    db: Db,
    dataDir: string,
    input: {
        operationId: string;
        action: "bind" | "withdraw";
        targetDeploymentId?: string;
        attested: boolean;
    },
) {
    if (!input.attested) {
        throw new ServiceError(
            "invalid",
            "Correcting needs --i-have-verified-the-router-by-exact-route: read the router for this alias first.",
        );
    }
    if (!isUuid(input.operationId)) throw new ServiceError("not-found", "Operation not found.");
    if (input.targetDeploymentId !== undefined) {
        if (!isUuid(input.targetDeploymentId)) {
            throw new ServiceError("invalid", "The target is not a deployment ID.");
        }
        // PostgreSQL returns lowercase ids, so compare and store the normalized form.
        input = { ...input, targetDeploymentId: input.targetDeploymentId.toLowerCase() };
    }
    if ((input.action === "bind") !== (input.targetDeploymentId !== undefined)) {
        throw new ServiceError("invalid", "A bind needs a target; a withdrawal has none.");
    }
    return withModelMutation(db, dataDir, async (trx) => {
        const found = await trx
            .selectFrom("promotion_operation")
            .select(["id", "app_id", "alias_id", "organization_id"])
            .where("id", "=", input.operationId)
            .executeTakeFirst();
        if (!found) throw new ServiceError("not-found", "Operation not found.");
        await trx
            .selectFrom("app")
            .select("id")
            .where("id", "=", found.app_id)
            .forUpdate()
            .executeTakeFirstOrThrow();
        const alias = await trx
            .selectFrom("app_alias")
            .select(["id", "state", "target_deployment_id", "reserved_generation"])
            .where("id", "=", found.alias_id)
            .forUpdate()
            .executeTakeFirstOrThrow();
        const ids = [input.targetDeploymentId, alias.target_deployment_id].filter(
            (id): id is string => !!id,
        );
        const deployments = ids.length
            ? await trx
                  .selectFrom("deployment")
                  .select(["id", "status", "desired_state", "app_id"])
                  .where("id", "in", ids)
                  .where("app_id", "=", found.app_id)
                  .orderBy("id")
                  .forUpdate()
                  .execute()
            : [];
        const held = await trx
            .selectFrom("promotion_operation")
            .select([
                "id",
                "status",
                "superseded_by_operation_id",
                "requested_by",
                "previous_target_deployment_id",
                "desired_target_deployment_id",
            ])
            .where("id", "=", found.id)
            .forUpdate()
            .executeTakeFirstOrThrow();
        if (held.status !== "reconciliation-needed" || held.superseded_by_operation_id !== null) {
            throw new ServiceError(
                "conflict",
                "Only an operation held for reconciliation can be corrected.",
            );
        }
        if (alias.state !== "binding-uncertain" && alias.state !== "withdrawal-uncertain") {
            throw new ServiceError("conflict", "The alias is not waiting for reconciliation.");
        }
        // A held bind may end at its target or at the prior stable target; a held withdrawal may
        // end withdrawn or back at the prior target. A corrective operation inherits the options of
        // the whole chain it extends, so the targets are those of every operation in it.
        // The whole chain, however long: a recursive walk up the supersession links.
        const chain = await sql<{ previous: string | null; desired: string | null }>`
            with recursive chain as (
                select id, previous_target_deployment_id, desired_target_deployment_id,
                    supersedes_operation_id
                from promotion_operation where id = ${held.id}
                union all
                select o.id, o.previous_target_deployment_id, o.desired_target_deployment_id,
                    o.supersedes_operation_id
                from promotion_operation o join chain c on o.id = c.supersedes_operation_id
            )
            select previous_target_deployment_id as previous,
                desired_target_deployment_id as desired from chain`.execute(trx);
        const chainTargets = new Set<string | null>(
            chain.rows.flatMap((row) => [row.previous, row.desired]),
        );
        const allowed =
            input.action === "withdraw"
                ? alias.state === "withdrawal-uncertain"
                : input.targetDeploymentId !== undefined &&
                  chainTargets.has(input.targetDeploymentId);
        if (!allowed) {
            throw new ServiceError(
                "invalid",
                "That correction is not a permitted outcome for this operation.",
            );
        }
        if (input.targetDeploymentId) {
            const target = deployments.find(
                (deployment) => deployment.id === input.targetDeploymentId,
            );
            if (!target || target.app_id !== found.app_id)
                throw new ServiceError("not-found", "Deployment not found.");
            if (target.status !== "succeeded" || target.desired_state !== "active") {
                throw new ServiceError(
                    "conflict",
                    "Only a succeeded, undeleted deployment can be promoted.",
                );
            }
        }
        const next = BigInt(alias.reserved_generation) + 1n;
        if (next > MAX_GENERATION)
            throw new ServiceError("conflict", "This alias has no generations left.");
        const id = crypto.randomUUID();
        // The held operation points at its successor first: the unfinished-per-alias index would
        // otherwise see two. The reference is deferred, so the order inside the transaction is free.
        await trx
            .updateTable("promotion_operation")
            .set({ superseded_by_operation_id: id, updated_at: sql<Date>`clock_timestamp()` })
            .where("id", "=", held.id)
            .executeTakeFirstOrThrow();
        await trx
            .insertInto("promotion_operation")
            .values({
                id,
                organization_id: found.organization_id,
                app_id: found.app_id,
                alias_id: found.alias_id,
                action: input.action,
                // A space is refused in a caller's key, so this cannot collide with one.
                idempotency_key: `correction ${held.id}`,
                previous_target_deployment_id: alias.target_deployment_id,
                desired_target_deployment_id: input.targetDeploymentId ?? null,
                expected_generation: String(alias.reserved_generation),
                generation: next.toString(),
                supersedes_operation_id: held.id,
                requested_by: held.requested_by,
            })
            .execute();
        await trx
            .updateTable("app_alias")
            .set({ reserved_generation: next.toString(), updated_at: sql<Date>`clock_timestamp()` })
            .where("id", "=", found.alias_id)
            .executeTakeFirstOrThrow();
        if (input.targetDeploymentId) {
            await trx
                .updateTable("deployment")
                .set({ last_unpinned_at: null, updated_at: sql<Date>`clock_timestamp()` })
                .where("id", "=", input.targetDeploymentId)
                .executeTakeFirstOrThrow();
        }
        if (input.targetDeploymentId) {
            await appendDeploymentEvent(
                trx,
                { id: input.targetDeploymentId, organization_id: found.organization_id },
                "promotion-requested",
                "info",
                "Corrective promotion requested.",
            );
        }
        await trx
            .insertInto("audit_event")
            .values({
                actor: "operator-cli",
                action: "alias.operation-superseded",
                target_type: "alias",
                target_id: found.alias_id,
                organization_id: found.organization_id,
                detail: `attested=router-read;superseded=${held.id};new=${id};action=${input.action};generation=${next}${input.targetDeploymentId ? `;target=${input.targetDeploymentId}` : ""}`,
            })
            .execute();
        return { operationId: id, supersedes: held.id, generation: next.toString() };
    });
}
