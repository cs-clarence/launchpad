import { type Kysely, sql } from "kysely";

// Frozen in time: raw SQL on Kysely<any>, never app types. Forward-only.
export async function up(db: Kysely<any>): Promise<void> {
    // A preview's name is taken only while the preview exists: once it is deleted (or has
    // expired and been deleted) the same name in the same project may be used again. The
    // row stays for the record, its app name and hostname stay taken, but the slug does not.
    await sql`alter table preview drop constraint preview_project_id_slug_key`.execute(db);
    await sql`create unique index preview_project_slug_live_idx
        on preview (project_id, slug) where desired_state <> 'deleted'`.execute(db);

    // Facts about the instance that must survive a restart, such as when the lifecycle was
    // first switched on.
    await sql`create table instance_state (
        key text primary key check (length(key) between 1 and 64),
        value text not null check (length(value) <= 256),
        set_at timestamptz not null default now()
    )`.execute(db);
}
