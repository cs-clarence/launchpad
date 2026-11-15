import { type Kysely, sql } from "kysely";

// Frozen in time: raw SQL on Kysely<any>, never app types. Forward-only.
export async function up(db: Kysely<any>): Promise<void> {
    // The deployment row is the queue: enqueueing is the insert, in the caller's own
    // transaction, and a claim is a fenced update. lease_* says who may act now;
    // step_done / step_pending are a write-ahead record of progress, so a successor
    // knows which Dokku call may have been in flight when its predecessor stopped.
    await sql`alter table deployment
        add column lease_owner text,
        add column lease_expires_at timestamptz,
        add column step_done text check (step_done in ('app', 'build', 'configure', 'load', 'verify')),
        add column step_pending text check (step_pending in ('app', 'build', 'configure', 'load', 'verify'))`.execute(
        db,
    );
    await sql`create index deployment_claim_idx on deployment (created_at)
        where status in ('queued', 'preparing', 'building', 'deploying', 'verifying')`.execute(db);
}
