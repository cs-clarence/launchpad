import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import path from "node:path";
import { createDatabase, migrateToLatest } from "./index";
import { createMigrator } from "./migrate";

// Integration tests need a disposable PostgreSQL server; they never run by
// default. Each test file gets its own freshly created database.
export function testDatabaseUrl(): string {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) {
        throw new Error(
            "TEST_DATABASE_URL is not set. Point it at a disposable PostgreSQL server, " +
                "e.g. postgres://postgres:dev@127.0.0.1:55432/postgres",
        );
    }
    return url;
}

export async function createTestDatabase() {
    // Small pools: test files run in parallel across projects, each with its own pools.
    const admin = new SQL({ url: testDatabaseUrl(), max: 1 });
    const name = `lp_test_${randomUUID().replaceAll("-", "")}`;
    try {
        await admin.unsafe(`create database ${name}`);
    } catch (error) {
        await admin.close();
        throw error;
    }
    const url = new URL(testDatabaseUrl());
    url.pathname = `/${name}`;
    const db = createDatabase(url.toString(), { max: 4 });
    return {
        db,
        url: url.toString(),
        migrate: () => migrateToLatest(db),
        // Migration fixtures need the real pre-cutover schema without copying its DDL.
        async migrateTo(name: string) {
            const migrator = createMigrator(db, path.join(import.meta.dirname, "migrations"));
            const { error } = await migrator.migrateTo(name);
            if (error) throw error;
        },
        async destroy() {
            try {
                await db.destroy();
                await admin.unsafe(`drop database ${name} with (force)`);
            } finally {
                await admin.close();
            }
        },
    };
}
