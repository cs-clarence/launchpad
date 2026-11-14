import { type Kysely, sql } from "kysely";

// Frozen in time: raw SQL on Kysely<any>, never app types. Forward-only.
export async function up(db: Kysely<any>): Promise<void> {
    // Only a SHA-256 hash of the secret is stored (the secret is 256 random bits, so a
    // fast hash is sufficient). `prefix` is the first characters of the secret, shown
    // so a key can be recognised. `project_ids` null means every project in the
    // organization; scopes are organization actions. A key is bound to the creator's
    // membership row (member_id): removing the member nulls it, so the key stays dead
    // even if the same user is added back later (that is a new membership). A key is
    // never usable beyond the member's current role. `restrict` on created_by blocks
    // deleting a user who has keys; revoke or let them age out first.
    await sql`create table api_key (
        id uuid primary key default gen_random_uuid(),
        organization_id text not null references "organization" ("id") on delete cascade,
        created_by text not null references "user" ("id") on delete restrict,
        member_id text references "member" ("id") on delete set null,
        name text not null,
        prefix text not null,
        secret_hash text not null unique,
        scopes text[] not null,
        project_ids uuid[],
        created_at timestamptz not null default now(),
        expires_at timestamptz not null,
        revoked_at timestamptz,
        last_used_at timestamptz,
        check (cardinality(scopes) > 0),
        check (project_ids is null or cardinality(project_ids) > 0)
    )`.execute(db);
    await sql`create index api_key_org_idx on api_key (organization_id)`.execute(db);
    await sql`create index api_key_creator_idx on api_key (organization_id, created_by)`.execute(
        db,
    );
    await sql`create index api_key_member_idx on api_key (member_id)`.execute(db);
}
