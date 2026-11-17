import { type Kysely, sql } from "kysely";

// Frozen in time: raw SQL on Kysely<any>, never app types. Forward-only.
export async function up(db: Kysely<any>): Promise<void> {
    // Whether the worker that wrote the row runs the lifecycle, so an operator can see that
    // the controller and the worker disagree about it (a deletion accepted by one is never
    // run by the other).
    await sql`alter table worker_heartbeat
        add column lifecycle_enabled boolean not null default false`.execute(db);
}
