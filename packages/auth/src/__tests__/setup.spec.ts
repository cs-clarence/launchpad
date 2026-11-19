import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuth, loadAuthConfig } from "../index";
import { provisionUser } from "../provision";
import { resetPassword, UnknownUserError } from "../recovery";
import { InvalidSetupInputError, OperatorExistsError, setupFirstOperator } from "../setup";
import { createTestDatabase } from "@launchpad-kit/database/testing";

let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
const config = loadAuthConfig({
    LAUNCHPAD_AUTH_SECRET: "test-secret-".repeat(4),
    LAUNCHPAD_BASE_URL: "http://127.0.0.1:3000",
});

beforeAll(async () => {
    testDb = await createTestDatabase();
    await testDb.migrate();
});
afterAll(async () => {
    await testDb.destroy();
});

describe("first operator setup", () => {
    it("creates exactly one operator under concurrent attempts, who can then sign in", async () => {
        const auth = createAuth({ db: testDb.db, config });
        const attempt = (n: number) =>
            setupFirstOperator(
                { db: testDb.db, auth },
                { email: `op${n}@example.com`, name: `op${n}`, password: "correct-horse-battery" },
            );
        const results = await Promise.allSettled([1, 2, 3, 4, 5].map(attempt));
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        for (const r of results) {
            if (r.status === "rejected") {
                expect(r.reason).toBeInstanceOf(OperatorExistsError);
            }
        }
        const winner = results.find((r) => r.status === "fulfilled");
        const email = (winner as PromiseFulfilledResult<{ email: string }>).value.email;
        const signIn = await auth.handler(
            new Request("http://127.0.0.1:3000/api/auth/sign-in/email", {
                method: "POST",
                headers: { "content-type": "application/json", origin: "http://127.0.0.1:3000" },
                body: JSON.stringify({ email, password: "correct-horse-battery" }),
            }),
        );
        expect(signIn.status).toBe(200);
    });

    it("rejects weak passwords and bad emails without creating a user", async () => {
        const auth = createAuth({ db: testDb.db, config });
        await expect(
            setupFirstOperator(
                { db: testDb.db, auth },
                { email: "a@example.com", name: "a", password: "short" },
            ),
        ).rejects.toBeInstanceOf(InvalidSetupInputError);
        await expect(
            setupFirstOperator(
                { db: testDb.db, auth },
                { email: "op..name@example.com", name: "a", password: "correct-horse-battery" },
            ),
        ).rejects.toBeInstanceOf(InvalidSetupInputError);
        await expect(
            setupFirstOperator(
                { db: testDb.db, auth },
                { email: "nope", name: "a", password: "correct-horse-battery" },
            ),
        ).rejects.toBeInstanceOf(InvalidSetupInputError);
    });

    it("resets a password, revokes sessions, audits, and invalidates pending reset tokens", async () => {
        const auth = createAuth({ db: testDb.db, config });
        // Its own user, so the test does not depend on what sibling tests created.
        const user = await provisionUser(
            { db: testDb.db, auth },
            {
                email: "rec@example.com",
                name: "Rec",
                password: "correct-horse-battery",
                actor: "test",
            },
        );
        const other = await provisionUser(
            { db: testDb.db, auth },
            {
                email: "rec-other@example.com",
                name: "Other",
                password: "correct-horse-battery",
                actor: "test",
            },
        );
        const signIn = (password: string) =>
            auth.handler(
                new Request("http://127.0.0.1:3000/api/auth/sign-in/email", {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        origin: "http://127.0.0.1:3000",
                        "x-launchpad-client-ip": `10.9.0.${Math.floor(Math.random() * 250) + 1}`,
                    },
                    body: JSON.stringify({ email: "rec@example.com", password }),
                }),
            );
        expect((await signIn("correct-horse-battery")).status).toBe(200);
        const sessions = await testDb.db
            .selectFrom("session")
            .select("id")
            .where("userId", "=", user.id)
            .execute();
        expect(sessions.length).toBeGreaterThan(0);

        // An emailed reset token issued before the operator's reset, and another user's.
        const expiresAt = new Date(Date.now() + 3600_000);
        await testDb.db
            .insertInto("verification")
            .values([
                {
                    id: randomUUID(),
                    identifier: "reset-password:stale-token",
                    value: user.id,
                    expiresAt,
                },
                {
                    id: randomUUID(),
                    identifier: "reset-password:other-token",
                    value: other.id,
                    expiresAt,
                },
            ])
            .execute();

        // API keys are credentials of the account: one for this user, one for another.
        const orgId = randomUUID();
        await testDb.db
            .insertInto("organization")
            .values({
                id: orgId,
                name: "Keys",
                slug: `keys-${orgId.slice(0, 8)}`,
                logo: null,
                metadata: null,
                createdAt: new Date(),
            })
            .execute();
        const keyRows = [];
        for (const owner of [user.id, other.id]) {
            const memberId = randomUUID();
            await testDb.db
                .insertInto("member")
                .values({
                    id: memberId,
                    organizationId: orgId,
                    userId: owner,
                    role: "admin",
                    createdAt: new Date(),
                })
                .execute();
            keyRows.push({
                organization_id: orgId,
                created_by: owner,
                member_id: memberId,
                name: "k",
                prefix: "lp_abcdef",
                secret_hash: randomUUID(),
                scopes: ["project:read"],
                project_ids: null,
                expires_at: expiresAt,
                revoked_at: null,
                last_used_at: null,
            });
        }
        await testDb.db.insertInto("api_key").values(keyRows).execute();

        const result = await resetPassword(
            { db: testDb.db, auth },
            { email: "REC@example.com", password: "a-brand-new-password", actor: "operator-cli" },
        );
        expect(result.revokedSessions).toBe(sessions.length);
        expect(result.revokedKeys).toBe(1);
        const live = await testDb.db
            .selectFrom("api_key")
            .select("created_by")
            .where("revoked_at", "is", null)
            .execute();
        expect(live.map((k) => k.created_by)).toEqual([other.id]);
        expect(
            await testDb.db
                .selectFrom("session")
                .select("id")
                .where("userId", "=", user.id)
                .execute(),
        ).toHaveLength(0);
        expect((await signIn("correct-horse-battery")).status).toBe(401);
        expect((await signIn("a-brand-new-password")).status).toBe(200);

        const remaining = await testDb.db
            .selectFrom("verification")
            .select("identifier")
            .where("identifier", "like", "reset-password:%")
            .execute();
        expect(remaining.map((r) => r.identifier)).toEqual(["reset-password:other-token"]);

        const audit = await testDb.db
            .selectFrom("audit_event")
            .select(["action", "detail"])
            .where("target_id", "=", user.id)
            .execute();
        expect(audit.map((a) => a.action)).toContain("user.password_reset");
        expect(
            JSON.parse(audit.find((row) => row.action === "user.password_reset")!.detail!),
        ).toEqual({
            revokedSessions: sessions.length,
            revokedKeys: 1,
        });
        await expect(
            resetPassword(
                { db: testDb.db, auth },
                {
                    email: "nobody@example.com",
                    password: "a-brand-new-password",
                    actor: "operator-cli",
                },
            ),
        ).rejects.toBeInstanceOf(UnknownUserError);
        await expect(
            resetPassword(
                { db: testDb.db, auth },
                { email: "rec@example.com", password: "short", actor: "x" },
            ),
        ).rejects.toBeInstanceOf(InvalidSetupInputError);
    });

    it("rejects addresses that Better Auth's sign-in would reject, in both provisioning paths", async () => {
        const auth = createAuth({ db: testDb.db, config });
        for (const bad of [
            "op..name@example.com",
            "a b@example.com",
            ".lead@example.com",
            "no-at-sign",
            "a@b",
        ]) {
            await expect(
                provisionUser(
                    { db: testDb.db, auth },
                    { email: bad, name: "x", password: "correct-horse-battery", actor: "t" },
                ),
                bad,
            ).rejects.toBeInstanceOf(InvalidSetupInputError);
        }
    });

    it("provisions an ordinary user who can sign in but is not an operator", async () => {
        const auth = createAuth({ db: testDb.db, config });
        await provisionUser(
            { db: testDb.db, auth },
            {
                email: "Pat@Example.com",
                name: "Pat",
                password: "a-long-enough-pass",
                actor: "operator-cli",
            },
        );
        const row = await testDb.db
            .selectFrom("user")
            .select("role")
            .where("email", "=", "pat@example.com")
            .executeTakeFirstOrThrow();
        expect(row.role).toBe("user");
        const response = await auth.handler(
            new Request("http://127.0.0.1:3000/api/auth/sign-in/email", {
                method: "POST",
                headers: { "content-type": "application/json", origin: "http://127.0.0.1:3000" },
                body: JSON.stringify({ email: "pat@example.com", password: "a-long-enough-pass" }),
            }),
        );
        expect(response.status).toBe(200);
        await expect(
            provisionUser(
                { db: testDb.db, auth },
                { email: "pat@example.com", name: "", password: "a-long-enough-pass", actor: "x" },
            ),
        ).rejects.toBeInstanceOf(InvalidSetupInputError);
    });
});
