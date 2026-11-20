import type { Database } from "@launchpad-kit/database";
import { type Kysely, sql } from "kysely";
import type { Principal } from "./authorization";
import { appendDeploymentEvent } from "./deployment-claims";
import { isUniqueViolation, ServiceError } from "./errors";
import { recordAudit } from "./organizations";

type Db = Kysely<Database>;
export const MAX_GENERATION = 9223372036854775807n;

export interface PromotionWanted {
    action: "bind" | "withdraw";
    target: string | null;
    expected: string;
    key: string;
}

// The one place an operation is reserved: callers hold the app, alias and target-deployment locks
// and have already validated eligibility. Used by a member's request and by app shutdown.
export async function reservePromotionOperation(
    trx: Db,
    principal: Principal,
    organizationId: string,
    appId: string,
    aliasId: string,
    alias: {
        reserved_generation: string | number | bigint;
        target_deployment_id: string | null;
    },
    wanted: PromotionWanted,
) {
    const next = BigInt(alias.reserved_generation) + 1n;
    if (next > MAX_GENERATION) {
        throw new ServiceError("conflict", "This alias has no generations left.");
    }
    let operation;
    try {
        operation = await trx
            .insertInto("promotion_operation")
            .values({
                organization_id: organizationId,
                app_id: appId,
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
            wanted.action === "bind" ? "alias.promotion-requested" : "alias.withdrawal-requested",
        targetType: "alias",
        targetId: aliasId,
        organizationId,
    });
    return operation.id;
}
