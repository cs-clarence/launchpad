import { readdirSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createTestDatabase } from "@launchpad/database/testing";

const migrationFolder = path.join(import.meta.dirname, "../../../database/src/migrations");
let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
    testDb = await createTestDatabase();
});
afterAll(async () => {
    await testDb.destroy();
});

describe("migrations", () => {
    it("applies on a clean database and is a no-op the second time", async () => {
        const first = await testDb.migrate();
        expect(first).toHaveLength(readdirSync(migrationFolder).length);
        expect(first.every((r) => r.status === "Success")).toBe(true);
        expect(await testDb.migrate()).toEqual([]);
        const tables = await sql<{ table_name: string }>`
            select table_name from information_schema.tables where table_schema = 'public'`.execute(
            testDb.db,
        );
        const names = tables.rows.map((r) => r.table_name);
        for (const expected of [
            "user",
            "session",
            "account",
            "organization",
            "member",
            "rateLimit",
        ]) {
            expect(names).toContain(expected);
        }
    });

    it("rejects an unknown role and a second operator at the database level", async () => {
        await testDb.migrate(); // idempotent: this test must not rely on the one above
        const insert = (id: string, role: string) =>
            sql`insert into "user" (id, name, email, "emailVerified", role) values (${id}, ${id}, ${id + "@example.com"}, false, ${role})`.execute(
                testDb.db,
            );
        await expect(insert("x1", "root")).rejects.toThrow();
        await insert("op1", "operator");
        await expect(insert("op2", "operator")).rejects.toThrow();
    });
});
