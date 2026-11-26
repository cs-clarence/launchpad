import { type Kysely, sql } from "kysely";

// One row per worker name, kept current by the worker so the controller can say whether a worker
// is alive (`seen_at` on the database clock is the only liveness signal; state is derived when it
// is read). Additive and forward-only: nothing existing changes. There is no index: the table
// holds a handful of rows, and an index on the column every beat updates would only stop those
// updates from being HOT.
export async function up(db: Kysely<any>): Promise<void> {
    await sql`create table worker_heartbeat (
            name text primary key,
            run_id uuid not null,
            started_at timestamptz not null,
            seen_at timestamptz not null,
            stopped_at timestamptz,
            beat_seconds integer not null,
            constraint worker_heartbeat_name_check check (name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
            constraint worker_heartbeat_beat_seconds_check check (beat_seconds between 5 and 60)
        )`.execute(db);
}
