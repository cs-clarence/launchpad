import { type Kysely, sql } from "kysely";

// Frozen in time: raw SQL on Kysely<any>, never app types. Forward-only.
export async function up(db: Kysely<any>): Promise<void> {
    await sql`create table audit_event (
            id uuid primary key default gen_random_uuid(),
            occurred_at timestamptz not null default now(),
            actor text not null,
            action text not null,
            target_type text not null,
            target_id text not null
        )`.execute(db);
    await sql`create index audit_event_target_idx on audit_event (target_type, target_id, occurred_at)`.execute(
        db,
    );
}
