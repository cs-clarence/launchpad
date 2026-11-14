import { type Kysely, sql } from "kysely";
import { authSchemaSql } from "../auth-schema";

// Frozen in time: raw SQL on Kysely<any>, never app types. Forward-only.
export async function up(db: Kysely<any>): Promise<void> {
    await sql.raw(authSchemaSql).execute(db);
}
