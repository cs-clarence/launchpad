import { type Kysely, sql } from "kysely";

// Frozen in time: raw SQL on Kysely<any>, never app types. Forward-only.
export async function up(db: Kysely<any>): Promise<void> {
    // A rollback (re-deploying the previous release after a failed verify) is recorded
    // as an intent like any other step, so a worker that stops in the middle of one
    // leaves a trace its successor can act on.
    await sql`alter table deployment
        drop constraint deployment_step_pending_check,
        add constraint deployment_step_pending_check check (
            step_pending in ('app', 'build', 'configure', 'load', 'verify', 'rollback')
        )`.execute(db);
}
