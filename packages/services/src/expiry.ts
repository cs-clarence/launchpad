import type { Database } from "@launchpad/database";
import { type Kysely, sql } from "kysely";
import { queueDeletion } from "./deletions";
import { LIFECYCLE_AUDIT } from "./lifecycle";

type Db = Kysely<Database>;

export const EXPIRY_BATCH = 50;

// Claims previews whose lifetime has run out and queues their deletion, oldest first, at
// most `limit` per call so that a long outage is worked off in bounded steps. A claim is
// one transaction per preview: it takes the row lock with SKIP LOCKED (a preview being
// extended or deleted right now is left for the next sweep, and two sweeps never claim the
// same one), re-checks that it is still overdue under the lock, and either flips it to
// `deleting` with its operation queued, or changes nothing. The caller is the system.
export async function expirePreviews(
    db: Db,
    options: { limit?: number } = {},
): Promise<{ claimed: string[] }> {
    const limit = options.limit ?? EXPIRY_BATCH;
    if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new Error("limit must be a positive integer.");
    }
    const claimed: string[] = [];
    for (let i = 0; i < limit; i++) {
        const id = await db.transaction().execute(async (trx) => {
            const row = await trx
                .selectFrom("preview")
                .select(["id", "organization_id"])
                .where("desired_state", "=", "active")
                .where("expires_at", "is not", null)
                .where("expires_at", "<=", sql<Date>`clock_timestamp()`)
                .orderBy("expires_at")
                .limit(1)
                .forUpdate()
                .skipLocked()
                .executeTakeFirst();
            if (!row) return null;
            await queueDeletion(trx, {
                organizationId: row.organization_id,
                previewId: row.id,
                reason: "expired",
                requestedBy: null,
            });
            await trx
                .insertInto("audit_event")
                .values({
                    actor: "system",
                    action: LIFECYCLE_AUDIT.previewExpired,
                    target_type: "preview",
                    target_id: row.id,
                    organization_id: row.organization_id,
                })
                .execute();
            return row.id;
        });
        if (id === null) break;
        claimed.push(id);
    }
    return { claimed };
}
