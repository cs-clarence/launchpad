import { type Kysely, sql } from "kysely";

// Frozen in time: raw SQL on Kysely<any>, never app types. Forward-only.
export async function up(db: Kysely<any>): Promise<void> {
    // null expires_at means "never": previews that exist before this change keep living
    // until someone gives them a lifetime. A deleted preview keeps its row (the audit
    // trail, and the hostname and app name stay taken), marked by deleted_at.
    await sql`alter table preview
        add column expires_at timestamptz,
        add column deleted_at timestamptz`.execute(db);
    await sql`alter table preview add constraint preview_deleted_at_matches_state
        check ((desired_state = 'deleted') = (deleted_at is not null))`.execute(db);
    // What the expiry scheduler scans: only live previews that have a lifetime.
    await sql`create index preview_expiry_idx on preview (expires_at)
        where desired_state = 'active' and expires_at is not null`.execute(db);

    // A deletion is an operation, like a deployment: the row is the queue and the lease,
    // `attempt` fences every state write, and step_pending is written ahead of each
    // external call so a successor knows which one may have been in flight. A null
    // requested_by is the system (scheduled expiry).
    await sql`create table deletion_operation (
        id uuid primary key default gen_random_uuid(),
        organization_id text not null references "organization" ("id") on delete restrict,
        preview_id uuid not null,
        reason text not null check (reason in ('manual', 'expired')),
        status text not null default 'queued' check (status in (
            'queued', 'running', 'succeeded', 'reconciliation-needed'
        )),
        attempt integer not null default 0 check (attempt >= 0),
        requested_by text references "user" ("id") on delete restrict,
        failure_code text,
        failure_message text,
        lease_owner text,
        lease_expires_at timestamptz,
        step_done text check (step_done in ('destroy', 'images')),
        step_pending text check (step_pending in ('destroy', 'images')),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        finished_at timestamptz,
        unique (organization_id, id),
        foreign key (organization_id, preview_id)
            references preview (organization_id, id) on delete restrict
    )`.execute(db);
    // At most one unfinished deletion per preview, enforced by the database: a repeated
    // request cannot start a second destroy, and an uncertain one blocks the rest.
    await sql`create unique index deletion_one_unfinished_per_preview
        on deletion_operation (preview_id)
        where status in ('queued', 'running', 'reconciliation-needed')`.execute(db);
    await sql`create index deletion_claim_idx on deletion_operation (created_at)
        where status in ('queued', 'running')`.execute(db);

    // One row per worker process, refreshed on every poll: how an operator sees that a
    // worker is alive, and how far behind it is.
    await sql`create table worker_heartbeat (
        worker_id text primary key check (length(worker_id) between 1 and 128),
        version text not null check (length(version) <= 64),
        started_at timestamptz not null default now(),
        last_seen_at timestamptz not null default now()
    )`.execute(db);
}
