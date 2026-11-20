import { setTimeout as delay } from "node:timers/promises";
import { type Kysely, sql } from "kysely";
import type { Database } from "./index";

type Db = Kysely<Database>;
const LOCK = "launchpad:deployment-recovery";

export async function lockDeploymentRecovery(db: Db, exclusive: boolean) {
    if (exclusive)
        await sql`select pg_advisory_xact_lock(hashtextextended(${LOCK}, 0))`.execute(db);
    else await sql`select pg_advisory_xact_lock_shared(hashtextextended(${LOCK}, 0))`.execute(db);
}

// Pin the session for maintenance that crosses transaction/process boundaries.
export async function withDeploymentRecoveryMaintenance<T>(
    db: Db,
    run: (connection: Db) => Promise<T>,
    signal?: AbortSignal,
) {
    return db.connection().execute(async (connection) => {
        signal?.throwIfAborted();
        if (!signal) {
            await sql`select pg_advisory_lock(hashtextextended(${LOCK}, 0))`.execute(connection);
        } else {
            for (;;) {
                signal.throwIfAborted();
                const locked = await sql<{ acquired: boolean }>`
                    select pg_try_advisory_lock(hashtextextended(${LOCK}, 0)) as acquired`.execute(
                    connection,
                );
                if (locked.rows[0]!.acquired) break;
                // Use the caller's abort reason, including TimeoutError, consistently.
                await delay(25, undefined, { signal }).catch((error: unknown) => {
                    signal.throwIfAborted();
                    throw error;
                });
            }
        }
        try {
            signal?.throwIfAborted();
            return await run(connection);
        } finally {
            await sql`select pg_advisory_unlock(hashtextextended(${LOCK}, 0))`.execute(connection);
        }
    });
}

// Catalog-only check: the rotation role needs CONNECT but no schema or table privileges, so it
// reads pg_catalog directly rather than resolving names through the public schema.
export async function isModelPrimary(db: Db) {
    const { rows } = await sql<{ ready: boolean }>`
        select not pg_is_in_recovery() and (
            select count(*) from pg_catalog.pg_class c
            join pg_catalog.pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'r'
              and c.relname in ('instance_state', 'promotion_operation')
        ) = 2 as ready
    `.execute(db);
    return rows[0]?.ready === true;
}
