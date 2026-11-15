import { type Kysely, sql } from "kysely";

// Frozen in time: raw SQL on Kysely<any>, never app types. Forward-only.
export async function up(db: Kysely<any>): Promise<void> {
    // Content-addressed upload, deduplicated within an organization only: a digest
    // seen in another organization is never an existence oracle. A row exists only
    // once its upload was finalized, so partial uploads are never visible here.
    await sql`create table artifact (
        id uuid primary key default gen_random_uuid(),
        organization_id text not null references "organization" ("id") on delete restrict,
        digest text not null check (digest ~ '^[0-9a-f]{64}$'),
        size_bytes bigint not null check (size_bytes >= 0),
        expanded_bytes bigint not null check (expanded_bytes >= 0),
        entry_count integer not null check (entry_count >= 1),
        storage_key text not null,
        created_by text not null references "user" ("id") on delete restrict,
        created_at timestamptz not null default now(),
        unique (organization_id, id),
        unique (organization_id, digest)
    )`.execute(db);

    // app_name is the only identifier that reaches Dokku: generated, opaque, never a
    // display name. hostname is generated from the slug and the same opaque id.
    await sql`create table preview (
        id uuid primary key default gen_random_uuid(),
        organization_id text not null references "organization" ("id") on delete restrict,
        project_id uuid not null,
        slug text not null check (slug ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'),
        app_name text not null unique check (app_name ~ '^lp-[a-z0-9]{10}$'),
        hostname text not null unique check (length(hostname) <= 253),
        desired_state text not null default 'active'
            check (desired_state in ('active', 'deleting', 'deleted')),
        created_by text not null references "user" ("id") on delete restrict,
        created_at timestamptz not null default now(),
        unique (organization_id, id),
        unique (project_id, slug),
        foreign key (organization_id, project_id)
            references project (organization_id, id) on delete restrict
    )`.execute(db);

    // attempt is the fencing token: every state write carries the attempt it was started
    // with and is refused when it is no longer current. Dokku itself does not know the
    // attempt; calls are bounded by a lease-derived deadline instead.
    await sql`create table deployment (
        id uuid primary key default gen_random_uuid(),
        organization_id text not null references "organization" ("id") on delete restrict,
        preview_id uuid not null,
        artifact_id uuid not null,
        spa boolean not null default false,
        status text not null default 'queued' check (status in (
            'queued', 'preparing', 'building', 'deploying', 'verifying',
            'succeeded', 'failed', 'cancelled', 'reconciliation-needed'
        )),
        attempt integer not null default 0 check (attempt >= 0),
        image_tag text,
        failure_code text,
        failure_message text,
        requested_by text not null references "user" ("id") on delete restrict,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        finished_at timestamptz,
        unique (organization_id, id),
        unique (organization_id, preview_id, id),
        foreign key (organization_id, preview_id)
            references preview (organization_id, id) on delete restrict,
        foreign key (organization_id, artifact_id)
            references artifact (organization_id, id) on delete restrict
    )`.execute(db);
    // At most one unfinished deployment per preview, enforced by the database: no
    // two deployments can overlap on one app, and an uncertain one blocks the rest.
    await sql`create unique index deployment_one_unfinished_per_preview
        on deployment (preview_id)
        where status in ('queued', 'preparing', 'building', 'deploying', 'verifying',
            'reconciliation-needed')`.execute(db);
    await sql`create index deployment_preview_idx on deployment (preview_id, created_at desc)`.execute(
        db,
    );

    await sql`alter table preview add column active_deployment_id uuid`.execute(db);
    // The active deployment must belong to this very preview, not merely to the same
    // organization. A null active_deployment_id is not checked (MATCH SIMPLE).
    await sql`alter table preview add foreign key (organization_id, id, active_deployment_id)
        references deployment (organization_id, preview_id, id) on delete restrict`.execute(db);

    await sql`create table deployment_event (
        id bigint generated always as identity primary key,
        organization_id text not null references "organization" ("id") on delete restrict,
        deployment_id uuid not null,
        seq integer not null check (seq >= 1),
        phase text not null,
        level text not null default 'info' check (level in ('info', 'warn', 'error')),
        message text not null check (length(message) <= 500),
        created_at timestamptz not null default now(),
        unique (deployment_id, seq),
        foreign key (organization_id, deployment_id)
            references deployment (organization_id, id) on delete restrict
    )`.execute(db);

    // A repeated request key returns the first result; the same key with a different
    // payload is a conflict. Bound to organization, principal and endpoint.
    await sql`create table idempotency_key (
        organization_id text not null references "organization" ("id") on delete restrict,
        principal text not null,
        endpoint text not null,
        key text not null check (length(key) between 1 and 128),
        request_hash text not null,
        resource_id uuid,
        created_at timestamptz not null default now(),
        expires_at timestamptz not null,
        primary key (organization_id, principal, endpoint, key)
    )`.execute(db);
    await sql`create index idempotency_key_expiry_idx on idempotency_key (expires_at)`.execute(db);
}
