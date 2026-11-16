import { type Kysely, sql } from "kysely";

// Frozen in time: raw SQL on Kysely<any>, never app types. Forward-only.
export async function up(db: Kysely<any>): Promise<void> {
    // The fencing generation: it only ever goes up, one for every claim. `attempt` is the
    // retry budget, which a person may reset after reconciliation; a fence that could be
    // reset could let an old claim pass again and write alongside its successor.
    await sql`alter table deletion_operation
        add column fence integer not null default 0 check (fence >= 0)`.execute(db);
    await sql`update deletion_operation set fence = attempt`.execute(db);
}
