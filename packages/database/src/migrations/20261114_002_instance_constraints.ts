import { type Kysely, sql } from "kysely";

// Frozen in time: raw SQL on Kysely<any>, never app types. Forward-only.
export async function up(db: Kysely<any>): Promise<void> {
    await sql`alter table "user" add constraint user_role_check check ("role" in ('user', 'operator'))`.execute(
        db,
    );
    // Second guard for the one-operator bootstrap: the setup command is
    // also serialized by an advisory lock.
    await sql`create unique index user_single_operator_idx on "user" (("role")) where "role" = 'operator'`.execute(
        db,
    );
    await sql`alter table "member" add constraint member_user_organization_unique unique ("organizationId", "userId")`.execute(
        db,
    );
}
