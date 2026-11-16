import type { Database } from "@launchpad/database";
import { type Kysely, sql, type Transaction } from "kysely";
import { ServiceError } from "./errors";

type Db = Kysely<Database>;

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

export type { Db as DeletionDb };
