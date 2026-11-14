import { type Kysely, sql } from "kysely";

// Frozen in time: raw SQL on Kysely<any>, never app types. Forward-only.
export async function up(db: Kysely<any>): Promise<void> {
    // At most one live invitation per organization and address, even when two
    // requests race; a newer invitation first revokes the older one.
    await sql`create unique index organization_invitation_pending_idx
        on organization_invitation (organization_id, email)
        where accepted_at is null and revoked_at is null`.execute(db);
}
