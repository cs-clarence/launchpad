import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuth, loadAuthConfig } from "../index";
import { provisionUser } from "../provision";
import { revokeAllCredentials } from "../recovery";
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

describe("revokeAllCredentials", () => {
    it("ends every restored session, key, token and open invitation, and nothing else", async () => {
        const auth = createAuth({ db: testDb.db, config });
        const user = await provisionUser(
            { db: testDb.db, auth },
            {
                email: "rev@example.com",
                name: "Rev",
                password: "correct-horse-battery",
                actor: "t",
            },
        );
        const signIn = () =>
            auth.handler(
                new Request("http://127.0.0.1:3000/api/auth/sign-in/email", {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        origin: "http://127.0.0.1:3000",
                        "x-launchpad-client-ip": `10.8.0.${Math.floor(Math.random() * 250) + 1}`,
                    },
                    body: JSON.stringify({
                        email: "rev@example.com",
                        password: "correct-horse-battery",
                    }),
                }),
            );
        expect((await signIn()).status).toBe(200);
        expect((await signIn()).status).toBe(200);

        const db = testDb.db;
        const later = new Date(Date.now() + 3600_000);
        await db
            .insertInto("verification")
            .values(
                ["reset-password:a", "email-verification:b"].map((identifier) => ({
                    id: randomUUID(),
                    identifier,
                    value: user.id,
                    expiresAt: later,
                })),
            )
            .execute();
        const orgId = randomUUID();
        await db
            .insertInto("organization")
            .values({
                id: orgId,
                name: "Rev",
                slug: `rev-${orgId.slice(0, 8)}`,
                logo: null,
                metadata: null,
                createdAt: new Date(),
            })
            .execute();
        const memberId = randomUUID();
        await db
            .insertInto("member")
            .values({
                id: memberId,
                organizationId: orgId,
                userId: user.id,
                role: "admin",
                createdAt: new Date(),
            })
            .execute();
        const oldRevocation = new Date("2026-01-01T00:00:00Z");
        const key = (revoked: Date | null) => ({
            organization_id: orgId,
            created_by: user.id,
            member_id: memberId,
            name: "k",
            prefix: "lp_abcdef",
            secret_hash: randomUUID(),
            scopes: ["project:read"],
            project_ids: null,
            expires_at: later,
            revoked_at: revoked,
            last_used_at: null,
        });
        await db
            .insertInto("api_key")
            .values([key(null), key(null), key(oldRevocation)])
            .execute();
        const invitation = (extra: object) => ({
            organization_id: orgId,
            email: `${randomUUID()}@example.com`,
            role: "viewer" as const,
            token_hash: randomUUID(),
            invited_by: user.id,
            expires_at: later,
            accepted_at: null,
            revoked_at: null,
            ...extra,
        });
        await db
            .insertInto("organization_invitation")
            .values([
                invitation({}),
                invitation({ accepted_at: oldRevocation }),
                invitation({ revoked_at: oldRevocation }),
            ])
            .execute();

        const result = await revokeAllCredentials({ db }, { actor: "operator-cli" });
        expect(result).toEqual({ sessions: 2, apiKeys: 2, verificationTokens: 2, invitations: 1 });

        expect(await db.selectFrom("session").select("id").execute()).toHaveLength(0);
        expect(await db.selectFrom("verification").select("id").execute()).toHaveLength(0);
        const keys = await db.selectFrom("api_key").select("revoked_at").execute();
        expect(keys.every((row) => row.revoked_at !== null)).toBe(true);
        expect(
            keys.filter((row) => row.revoked_at?.getTime() === oldRevocation.getTime()),
        ).toHaveLength(1);
        const invites = await db
            .selectFrom("organization_invitation")
            .select(["accepted_at", "revoked_at"])
            .execute();
        expect(invites.filter((row) => row.accepted_at && !row.revoked_at)).toHaveLength(1);
        expect(invites.filter((row) => row.revoked_at)).toHaveLength(2);

        // Passwords are unchanged: the user signs in again and gets a fresh session.
        expect((await signIn()).status).toBe(200);
        expect(await db.selectFrom("session").select("id").execute()).toHaveLength(1);

        const audit = await db
            .selectFrom("audit_event")
            .select(["actor", "target_type", "detail"])
            .where("action", "=", "instance.credentials_revoked")
            .execute();
        expect(audit).toHaveLength(1);
        expect(audit[0]!.actor).toBe("operator-cli");
        expect(JSON.parse(audit[0]!.detail!)).toEqual(result);

        // Idempotent: a second run revokes nothing more except the new session, and is audited.
        expect(await revokeAllCredentials({ db }, { actor: "operator-cli" })).toEqual({
            sessions: 1,
            apiKeys: 0,
            verificationTokens: 0,
            invitations: 0,
        });
    });
});
