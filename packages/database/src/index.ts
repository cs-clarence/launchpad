import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

// No tables are defined until the first feature and migration are designed.
export type Database = Record<never, never>;

// Explicit construction only; importing this package never opens a connection.
export function createDatabase(connectionString: string): Kysely<Database> {
    return new Kysely<Database>({
        dialect: new PostgresDialect({
            pool: new Pool({ connectionString }),
        }),
    });
}
