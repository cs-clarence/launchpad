import type { Database } from "@launchpad-kit/database";
import type { Kysely } from "kysely";
import { requireDeploymentsOn, type AppDeps } from "./apps";
import type { Principal } from "./authorization";
import { withModelMutation } from "./deployment-recovery";
import { ServiceError } from "./errors";
import { isUuid } from "./ids";
import { recordAudit, requireMembership } from "./organizations";

export const RECONCILIATION_REQUESTED = "deployment-model.reconciliation-requested";

// This handoff deliberately cannot submit evidence or change an operation, alias,
// deployment, or pin. Instance operators still verify and settle the held work.
export async function requestReconciliation(
    db: Kysely<Database>,
    principal: Principal,
    organizationId: string,
    deps: AppDeps,
    target: { kind: "promotion" | "deployment"; id: string },
) {
    if (principal.credentialId) throw new ServiceError("forbidden", "A session is required.");
    await requireMembership(db, principal, organizationId, "app:request-reconciliation");
    if (!isUuid(target.id)) throw new ServiceError("not-found", "Resource not found.");
    requireDeploymentsOn(deps.settings);
    return withModelMutation(db, deps.dataDir, async (trx) => {
        const table = target.kind === "promotion" ? "promotion_operation" : "deployment";
        const resource = await trx
            .selectFrom(table)
            .select("status")
            .where("organization_id", "=", organizationId)
            .where("id", "=", target.id)
            .executeTakeFirst();
        if (!resource) throw new ServiceError("not-found", "Resource not found.");

        const deletion =
            target.kind === "deployment"
                ? await trx
                      .selectFrom("deployment_deletion_operation")
                      .select("id")
                      .where("organization_id", "=", organizationId)
                      .where("deployment_id", "=", target.id)
                      .where("status", "=", "reconciliation-needed")
                      .executeTakeFirst()
                : undefined;
        if (!deletion && resource.status !== "reconciliation-needed") {
            throw new ServiceError("conflict", "This resource is not held for reconciliation.");
        }
        // An operator rechecks current state. If the operation was settled since the
        // reads above, this is only a historical request, never permission to repair.
        await recordAudit(trx, {
            actor: principal,
            action: RECONCILIATION_REQUESTED,
            targetType: target.kind,
            targetId: target.id,
            organizationId,
            detail: deletion ? `deletionOperationId=${deletion.id}` : undefined,
        });
        return { ok: true as const };
    });
}
