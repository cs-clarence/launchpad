import { SQL } from "bun";
import {
    AbortedTransactionError,
    CompiledQuery,
    type DatabaseConnection,
    type Dialect,
    type Driver,
    type Kysely,
    PostgresAdapter,
    PostgresIntrospector,
    PostgresQueryCompiler,
    type QueryResult,
    type TransactionSettings,
} from "kysely";

// Kysely driver on Bun's native PostgreSQL client. Every Kysely connection is a
// reserved Bun connection, so transactions and session-level state (advisory
// locks) stay on one backend connection.
class BunSqlConnection implements DatabaseConnection {
    constructor(private readonly reserved: Awaited<ReturnType<SQL["reserve"]>>) {}

    async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
        const { command: _command, ...result } = await this.execute<R>(compiled);
        return result;
    }

    // Like executeQuery, but also returns PostgreSQL's command tag.
    async execute<R>(compiled: CompiledQuery): Promise<QueryResult<R> & { command?: string }> {
        const result = await this.reserved.unsafe(compiled.sql, [...compiled.parameters]);
        const command = (result as { command?: string }).command;
        const count = (result as { count?: number }).count;
        const writes = command === "INSERT" || command === "UPDATE" || command === "DELETE";
        return {
            rows: [...result] as R[],
            numAffectedRows: writes && count !== undefined ? BigInt(count) : undefined,
            command,
        };
    }

    // oxlint-disable-next-line require-yield
    async *streamQuery(): AsyncIterableIterator<never> {
        throw new Error("Streaming queries are not supported by the Bun SQL dialect.");
    }

    release(): void {
        this.reserved.release();
    }
}

export interface BunSqlOptions {
    /** Largest number of connections the pool opens (Bun's default is 10). */
    max?: number;
}

class BunSqlDriver implements Driver {
    private client: SQL | undefined;

    constructor(
        private readonly connectionString: string,
        private readonly options: BunSqlOptions,
    ) {}

    async init(): Promise<void> {
        this.client = new SQL({ url: this.connectionString, ...this.options });
    }

    async acquireConnection(): Promise<DatabaseConnection> {
        if (!this.client) {
            throw new Error("The Bun SQL driver is not initialized.");
        }
        return new BunSqlConnection(await this.client.reserve());
    }

    async beginTransaction(
        connection: DatabaseConnection,
        settings: TransactionSettings,
    ): Promise<void> {
        const parts = ["start transaction"];
        if (settings.isolationLevel) {
            parts.push(`isolation level ${settings.isolationLevel}`);
        }
        if (settings.accessMode) {
            parts.push(settings.accessMode);
        }
        await connection.executeQuery(CompiledQuery.raw(parts.join(" ")));
    }

    async commitTransaction(connection: DatabaseConnection): Promise<void> {
        // PostgreSQL answers COMMIT with ROLLBACK when the transaction already failed
        // (for example a statement error the caller caught). Kysely requires that to
        // surface as an error, or the caller would believe its writes were saved.
        const result = await (connection as BunSqlConnection).execute(CompiledQuery.raw("commit"));
        if (result.command === "ROLLBACK") {
            throw new AbortedTransactionError();
        }
    }

    async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
        await connection.executeQuery(CompiledQuery.raw("rollback"));
    }

    async releaseConnection(connection: DatabaseConnection): Promise<void> {
        (connection as BunSqlConnection).release();
    }

    async destroy(): Promise<void> {
        await this.client?.close();
    }
}

// Lazy: the client connects on first use, so constructing a dialect is free.
export class BunSqlDialect implements Dialect {
    constructor(
        private readonly connectionString: string,
        private readonly options: BunSqlOptions = {},
    ) {}

    createDriver(): Driver {
        return new BunSqlDriver(this.connectionString, this.options);
    }
    createQueryCompiler() {
        return new PostgresQueryCompiler();
    }
    createAdapter() {
        return new PostgresAdapter();
    }
    createIntrospector(db: Kysely<any>) {
        return new PostgresIntrospector(db);
    }
}
