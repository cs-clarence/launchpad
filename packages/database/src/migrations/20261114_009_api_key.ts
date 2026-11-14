import { type Kysely, sql } from "kysely";

// Frozen in time: raw SQL on Kysely<any>, never app types. Forward-only.
export async function up(db: Kysely<any>): Promise<void> {
    // Only a SHA-256 hash of the secret is stored (the secret is 256 random bits, so a
    // fast hash is sufficient). `prefix` is the first characters of the secret, shown
    // so a key can be recognised. `project_ids` null means every project in the
    // organization; scopes are organization actions. A key is usable only while its
    // creator is still a member, and never beyond that member's current role.
    await sql`create table api_key (
        id uuid primary key default gen_random_uuid(),
        organization_id text not null references "organization" ("id") on delete cascade,
        created_by text not null references "user" ("id") on delete restrict,
        name text not null,
        prefix text not null,
        secret_hash text not null unique,
        scopes text[] not null,
        project_ids uuid[],
        created_at timestamptz not null default now(),
        expires_at timestamptz not null,
        revoked_at timestamptz,
        last_used_at timestamptz
    )`.execute(db);
    await sql`create index api_key_org_idx on api_key (organization_id)`.execute(db);
}
