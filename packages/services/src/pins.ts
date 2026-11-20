import type { Database } from "@launchpad-kit/database";
import type { Kysely } from "kysely";

type Db = Kysely<Database>;

// Operation statuses that can still route traffic, or whose outcome is not known. A held
// operation that has been superseded keeps its status, so a whole corrective chain stays pinned.
export const OPEN_OPERATION_STATUSES = [
    "queued",
    "applying",
    "verifying",
    "reconciliation-needed",
] as const;

// Whether anything can still route to a deployment: an alias that points at it, or an open
// operation that has it as its previous or desired target. Callers hold the app row lock: every
// write that adds a pin takes the same lock, so this read cannot race a new reservation. Deletion
// and the promotion worker's pin release both use this one definition.
export async function isDeploymentPinned(trx: Db, deploymentId: string): Promise<boolean> {
    const byAlias = await trx
        .selectFrom("app_alias")
        .select("id")
        .where("target_deployment_id", "=", deploymentId)
        .executeTakeFirst();
    if (byAlias) return true;
    const byOperation = await trx
        .selectFrom("promotion_operation")
        .select("id")
        .where((eb) =>
            eb.or([
                eb("previous_target_deployment_id", "=", deploymentId),
                eb("desired_target_deployment_id", "=", deploymentId),
            ]),
        )
        .where("status", "in", [...OPEN_OPERATION_STATUSES])
        .executeTakeFirst();
    return !!byOperation;
}
