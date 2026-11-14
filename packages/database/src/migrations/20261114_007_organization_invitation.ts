import { type Kysely, sql } from "kysely";

// Frozen in time: raw SQL on Kysely<any>, never app types. Forward-only.
export async function up(db: Kysely<any>): Promise<void> {
    // Only a hash of the emailed token is stored. A pending invitation is one with
    // neither accepted_at nor revoked_at set and an expires_at in the future.
    await sql`create table organization_invitation (
        id uuid primary key default gen_random_uuid(),
        organization_id text not null references "organization" ("id") on delete cascade,
        email text not null,
        role text not null check (role in ('owner', 'admin', 'deployer', 'viewer')),
        token_hash text not null unique,
        invited_by text not null references "user" ("id") on delete restrict,
        created_at timestamptz not null default now(),
        expires_at timestamptz not null,
        accepted_at timestamptz,
        revoked_at timestamptz
    )`.execute(db);
    await sql`create index organization_invitation_org_idx on organization_invitation (organization_id)`.execute(
        db,
    );
}
