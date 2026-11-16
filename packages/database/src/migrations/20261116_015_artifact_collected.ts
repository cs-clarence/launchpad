import { type Kysely, sql } from "kysely";

// Frozen in time: raw SQL on Kysely<any>, never app types. Forward-only.
export async function up(db: Kysely<any>): Promise<void> {
    // A collected artifact keeps its row (deployments, including those of deleted previews,
    // still point at it, and the record is part of the audit trail) but its stored archive
    // is gone: collected_at says so. An upload of the same bytes later stores the archive
    // again and clears it.
    await sql`alter table artifact add column collected_at timestamptz`.execute(db);
    await sql`create index artifact_collectable_idx on artifact (created_at)
        where collected_at is null`.execute(db);
}
