import { type Kysely, sql } from "kysely";

// Frozen in time: raw SQL on Kysely<any>, never app types. Forward-only.
export async function up(db: Kysely<any>): Promise<void> {
    // No foreign key: audit history must outlive the organization it names.
    await sql`alter table audit_event add column organization_id text, add column detail text`.execute(
        db,
    );
}
