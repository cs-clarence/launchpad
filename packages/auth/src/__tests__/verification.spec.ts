import { randomUUID } from "node:crypto";
import { createTestDatabase } from "@launchpad-kit/database/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UnknownUserError } from "../recovery";
import { EmailVerificationNotAllowedError, verifyEmailForDevelopment } from "../verification";

let testDb: Awaited<ReturnType<typeof createTestDatabase>>;

beforeAll(async () => {
    testDb = await createTestDatabase();
    await testDb.migrate();
});
afterAll(async () => {
    await testDb.destroy();
});

async function addUser(email: string, verified = false) {
    const id = randomUUID();
    await testDb.db
        .insertInto("user")
        .values({ id, name: email, email, emailVerified: verified, image: null, role: "user" })
        .execute();
    return id;
}

describe("verifying a seeded account's email", () => {
    it("marks the address verified once, with an audit event", async () => {
        const email = `seed-${randomUUID().slice(0, 8)}@launchpad.local`;
        const id = await addUser(email);

        const first = await verifyEmailForDevelopment(
            { db: testDb.db },
            { email, actor: "operator-cli", development: true },
        );
        expect(first).toEqual({ id, email, changed: true });
        const user = await testDb.db
            .selectFrom("user")
            .select("emailVerified")
            .where("id", "=", id)
            .executeTakeFirstOrThrow();
        expect(user.emailVerified).toBe(true);
        const audit = await testDb.db
            .selectFrom("audit_event")
            .select(["actor", "action", "detail"])
            .where("target_id", "=", id)
            .where("action", "=", "user.email_verified")
            .execute();
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({ actor: "operator-cli" });

        // A re-run is a no-op, so the seed does not fill the audit log with duplicates.
        const again = await verifyEmailForDevelopment(
            { db: testDb.db },
            { email, actor: "operator-cli", development: true },
        );
        expect(again).toEqual({ id, email, changed: false });
        expect(
            await testDb.db
                .selectFrom("audit_event")
                .select("id")
                .where("target_id", "=", id)
                .where("action", "=", "user.email_verified")
                .execute(),
        ).toHaveLength(1);
    });

    it("refuses when development mode is off and leaves the account unverified", async () => {
        const email = `prod-${randomUUID().slice(0, 8)}@example.com`;
        const id = await addUser(email);
        await expect(
            verifyEmailForDevelopment(
                { db: testDb.db },
                { email, actor: "operator-cli", development: false },
            ),
        ).rejects.toBeInstanceOf(EmailVerificationNotAllowedError);
        const user = await testDb.db
            .selectFrom("user")
            .select("emailVerified")
            .where("id", "=", id)
            .executeTakeFirstOrThrow();
        expect(user.emailVerified).toBe(false);
    });

    it("refuses an unknown address", async () => {
        await expect(
            verifyEmailForDevelopment(
                { db: testDb.db },
                { email: "nobody@launchpad.local", actor: "operator-cli", development: true },
            ),
        ).rejects.toBeInstanceOf(UnknownUserError);
    });
});
