import { randomUUID } from "node:crypto";
import { createTestDatabase } from "@launchpad-kit/database/testing";
import { AbortedTransactionError } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
    testDb = await createTestDatabase();
    await testDb.migrate();
});
afterAll(async () => {
    await testDb.destroy();
});

const user = (id: string) => ({
    id,
    name: id,
    email: `${id}@example.com`,
    emailVerified: false,
    image: null,
    role: "user" as const,
});

describe("Bun SQL transactions", () => {
    it("commits a normal transaction", async () => {
        const id = randomUUID();
        await testDb.db
            .transaction()
            .execute((trx) => trx.insertInto("user").values(user(id)).execute());
        expect(
            await testDb.db.selectFrom("user").select("id").where("id", "=", id).execute(),
        ).toHaveLength(1);
    });

    // PostgreSQL answers COMMIT with ROLLBACK after a statement error, even if the
    // caller caught it. That must fail loudly: the caller believes its writes landed.
    it("rejects a COMMIT that PostgreSQL turns into a ROLLBACK", async () => {
        const id = randomUUID();
        await expect(
            testDb.db.transaction().execute(async (trx) => {
                await trx.insertInto("user").values(user(id)).execute();
                try {
                    await trx.insertInto("user").values(user(id)).execute(); // duplicate key
                } catch {
                    // swallowed: the transaction is now aborted
                }
            }),
        ).rejects.toBeInstanceOf(AbortedTransactionError);
        expect(
            await testDb.db.selectFrom("user").select("id").where("id", "=", id).execute(),
        ).toHaveLength(0);
    });
});
