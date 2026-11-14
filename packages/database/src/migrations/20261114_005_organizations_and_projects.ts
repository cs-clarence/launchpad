import { type Kysely, sql } from "kysely";

// Frozen in time: raw SQL on Kysely<any>, never app types. Forward-only.
export async function up(db: Kysely<any>): Promise<void> {
    await sql`alter table "member" add constraint member_role_check check ("role" in ('owner', 'admin', 'deployer', 'viewer'))`.execute(
        db,
    );
    await sql`alter table "organization" add constraint organization_slug_check check ("slug" ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$')`.execute(
        db,
    );
    // Children carry organization_id and reference (organization_id, id), so a
    // row can never point into another organization.
    await sql`create table project (
            id uuid primary key default gen_random_uuid(),
            organization_id text not null references "organization" ("id") on delete restrict,
            slug text not null check (slug ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'),
            name text not null check (length(name) between 1 and 80),
            created_by text not null references "user" ("id") on delete restrict,
            created_at timestamptz not null default now(),
            unique (organization_id, slug),
            unique (organization_id, id)
        )`.execute(db);
}
