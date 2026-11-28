import { type Kysely, sql } from "kysely";

// Application settings that an operator may change without editing a process environment: one row
// per setting, resolved before its environment variable and built-in default (see
// packages/services/src/configuration-service.ts). Additive and forward-only: nothing existing
// changes.
export async function up(db: Kysely<unknown>): Promise<void> {
    await sql`create table app_setting (
            key text primary key check (length(key) between 1 and 64),
            value text not null check (length(value) <= 1024),
            updated_at timestamptz not null default now()
        )`.execute(db);
    // A writer of a different setting must not have to remember this column: the row's timestamp
    // always says when its value last changed.
    await sql`
        CREATE FUNCTION public.app_setting_touch() RETURNS trigger
        LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
        BEGIN
            NEW.updated_at = now();
            RETURN NEW;
        END;
        $function$
    `.execute(db);
    await sql`create trigger app_setting_touch before update on app_setting
        for each row execute function public.app_setting_touch()`.execute(db);
}
