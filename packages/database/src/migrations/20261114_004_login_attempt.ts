import { type Kysely, sql } from "kysely";

// Frozen in time: raw SQL on Kysely<any>, never app types. Forward-only.
export async function up(db: Kysely<any>): Promise<void> {
    // Fixed-window counters for sign-in throttling; keys are hashes, so no
    // email address or IP is stored.
    await sql`create table login_attempt (
            key text primary key,
            window_start timestamptz not null,
            count integer not null
        )`.execute(db);
}
