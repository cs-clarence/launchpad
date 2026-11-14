import { randomUUID } from "node:crypto";
import { createTestDatabase } from "@launchpad/database/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    acceptInvitation,
    addMember,
    createInvitation,
    createOrganization,
    type InvitationDeps,
    listInvitations,
    MAX_INVITATIONS_PER_DAY,
    previewInvitation,
    revokeInvitation,
    ServiceError,
    type Principal,
} from "../index";

let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
const people: Record<string, Principal & { email: string }> = {};
const sent: { to: string; subject: string; text: string }[] = [];
let failDelivery = false;

const deps: InvitationDeps = {
    enabled: true,
    baseUrl: "https://control.example.com",
    publicSignup: false,
    hashPassword: async (password) => `hashed:${password}`,
    mailer: {
        async send(message) {
            if (failDelivery) throw new Error("smtp down");
            sent.push(message);
        },
    },
};
const tokenOf = (mail: { text: string }) => /token=([A-Za-z0-9_-]+)/.exec(mail.text)![1]!;
const code = (promise: Promise<unknown>) =>
    promise.then(
        () => "ok",
        (e) => (e instanceof ServiceError ? e.code : `unexpected: ${e}`),
    );

async function newUser(name: string, role: "user" | "operator" = "user") {
    const id = randomUUID();
    const email = `${name}@example.com`;
    await testDb.db
        .insertInto("user")
        .values({ id, name, email, emailVerified: false, image: null, role })
        .execute();
    people[name] = { userId: id, instanceRole: role, email };
}

let org = "";
beforeAll(async () => {
    testDb = await createTestDatabase();
    await testDb.migrate();
    await newUser("root", "operator");
    for (const n of ["ann", "ben", "dee", "eve"]) await newUser(n);
    const db = testDb.db;
    org = (
        await createOrganization(db, people.root!, {
            name: "Acme",
            slug: "acme",
            ownerEmail: "ann@example.com",
        })
    ).id;
    await addMember(db, people.ann!, org, { email: "ben@example.com", role: "admin" });
    await addMember(db, people.ann!, org, { email: "dee@example.com", role: "deployer" });
});
afterAll(async () => {
    await testDb.destroy();
});

describe("creating invitations", () => {
    it("is unavailable unless enrollment and a mailer allow it", async () => {
        const db = testDb.db;
        const input = { email: "new@example.com", role: "viewer" };
        expect(
            await code(createInvitation(db, people.ann!, org, input, { ...deps, enabled: false })),
        ).toBe("not-found");
        expect(
            await code(createInvitation(db, people.ann!, org, input, { ...deps, mailer: null })),
        ).toBe("not-found");
        expect(sent).toHaveLength(0);
    });

    it("limits who can invite and which roles, hides the org from outsiders", async () => {
        const db = testDb.db;
        expect(
            await code(
                createInvitation(
                    db,
                    people.dee!,
                    org,
                    { email: "n1@example.com", role: "viewer" },
                    deps,
                ),
            ),
        ).toBe("forbidden");
        expect(
            await code(
                createInvitation(
                    db,
                    people.ben!,
                    org,
                    { email: "n1@example.com", role: "admin" },
                    deps,
                ),
            ),
        ).toBe("forbidden");
        expect(
            await code(
                createInvitation(
                    db,
                    people.eve!,
                    org,
                    { email: "n1@example.com", role: "viewer" },
                    deps,
                ),
            ),
        ).toBe("not-found");
        expect(
            await code(
                createInvitation(db, people.ann!, org, { email: "bad", role: "viewer" }, deps),
            ),
        ).toBe("invalid");
        expect(
            await code(
                createInvitation(
                    db,
                    people.ann!,
                    org,
                    { email: "ben@example.com", role: "viewer" },
                    deps,
                ),
            ),
        ).toBe("conflict");
    });

    it("stores only a token hash and mails a link, and replaces an older invitation", async () => {
        const db = testDb.db;
        await createInvitation(
            db,
            people.ann!,
            org,
            { email: "Fresh@Example.com", role: "viewer" },
            deps,
        );
        const first = sent.at(-1)!;
        expect(first.to).toBe("fresh@example.com");
        expect(first.text).toContain("https://control.example.com/accept-invitation?token=");
        const token = tokenOf(first);
        const rows = await db
            .selectFrom("organization_invitation")
            .select(["token_hash"])
            .execute();
        expect(rows.some((r) => r.token_hash === token)).toBe(false);

        await createInvitation(
            db,
            people.ann!,
            org,
            { email: "fresh@example.com", role: "deployer" },
            deps,
        );
        expect(await code(previewInvitation(db, token, deps))).toBe("not-found"); // replaced
        const pendingForFresh = (await listInvitations(db, people.ann!, org)).filter(
            (i) => i.email === "fresh@example.com",
        );
        expect(pendingForFresh).toHaveLength(1);
        expect(pendingForFresh[0]!.role).toBe("deployer");
    });

    it("revokes the invitation when delivery fails", async () => {
        const db = testDb.db;
        failDelivery = true;
        expect(
            await code(
                createInvitation(
                    db,
                    people.ann!,
                    org,
                    { email: "lost@example.com", role: "viewer" },
                    deps,
                ),
            ),
        ).toBe("delivery-failed");
        failDelivery = false;
        expect(
            (await listInvitations(db, people.ann!, org)).some(
                (i) => i.email === "lost@example.com",
            ),
        ).toBe(false);
    });
});

describe("accepting invitations", () => {
    it("creates a verified account for a new person, once", async () => {
        const db = testDb.db;
        await createInvitation(
            db,
            people.ann!,
            org,
            { email: "newbie@example.com", role: "viewer" },
            deps,
        );
        const token = tokenOf(sent.at(-1)!);
        const preview = await previewInvitation(db, token, deps);
        expect(preview).toMatchObject({
            organizationName: "Acme",
            role: "viewer",
            accountExists: false,
        });
        expect(await code(acceptInvitation(db, null, { token }, deps))).toBe("invalid"); // needs a password
        expect(
            await code(acceptInvitation(db, null, { token, name: "N", password: "short" }, deps)),
        ).toBe("invalid");
        const results = await Promise.all([
            code(
                acceptInvitation(
                    db,
                    null,
                    { token, name: "Newbie", password: "a-long-password-1" },
                    deps,
                ),
            ),
            code(
                acceptInvitation(
                    db,
                    null,
                    { token, name: "Newbie", password: "a-long-password-1" },
                    deps,
                ),
            ),
        ]);
        expect(results.toSorted()).toEqual(["not-found", "ok"]);
        const user = await db
            .selectFrom("user")
            .select(["id", "emailVerified", "role"])
            .where("email", "=", "newbie@example.com")
            .executeTakeFirstOrThrow();
        expect(user).toMatchObject({ emailVerified: true, role: "user" });
        const account = await db
            .selectFrom("account")
            .select("password")
            .where("userId", "=", user.id)
            .executeTakeFirstOrThrow();
        expect(account.password).toBe("hashed:a-long-password-1");
        const member = await db
            .selectFrom("member")
            .select("role")
            .where("userId", "=", user.id)
            .where("organizationId", "=", org)
            .executeTakeFirstOrThrow();
        expect(member.role).toBe("viewer");
        expect(
            await code(
                acceptInvitation(
                    db,
                    null,
                    { token, name: "x", password: "a-long-password-1" },
                    deps,
                ),
            ),
        ).toBe("not-found");
    });

    it("requires an existing account to be signed in as the invited user", async () => {
        const db = testDb.db;
        await createInvitation(
            db,
            people.ann!,
            org,
            { email: "eve@example.com", role: "deployer" },
            deps,
        );
        const token = tokenOf(sent.at(-1)!);
        expect(await previewInvitation(db, token, deps)).toMatchObject({ accountExists: true });
        expect(await code(acceptInvitation(db, null, { token }, deps))).toBe("forbidden");
        expect(await code(acceptInvitation(db, people.dee!, { token }, deps))).toBe("forbidden");
        expect(await code(acceptInvitation(db, people.eve!, { token }, deps))).toBe("ok");
        const eve = await db
            .selectFrom("user")
            .select("emailVerified")
            .where("id", "=", people.eve!.userId)
            .executeTakeFirstOrThrow();
        expect(eve.emailVerified).toBe(true);
        expect(await code(acceptInvitation(db, people.eve!, { token }, deps))).toBe("not-found");
    });

    it("rejects expired, revoked and unknown tokens identically", async () => {
        const db = testDb.db;
        await createInvitation(
            db,
            people.ann!,
            org,
            { email: "late@example.com", role: "viewer" },
            deps,
        );
        const expired = tokenOf(sent.at(-1)!);
        await db
            .updateTable("organization_invitation")
            .set({ expires_at: new Date(Date.now() - 1000) })
            .where("email", "=", "late@example.com")
            .execute();
        await createInvitation(
            db,
            people.ann!,
            org,
            { email: "gone@example.com", role: "viewer" },
            deps,
        );
        const revoked = tokenOf(sent.at(-1)!);
        const pendingGone = (await listInvitations(db, people.ann!, org)).find(
            (i) => i.email === "gone@example.com",
        )!;
        expect(await code(revokeInvitation(db, people.ben!, org, pendingGone.id))).toBe("ok");
        for (const token of [expired, revoked, "x".repeat(43)]) {
            expect(
                await code(
                    acceptInvitation(
                        db,
                        null,
                        { token, name: "Z", password: "a-long-password-1" },
                        deps,
                    ),
                ),
            ).toBe("not-found");
            expect(await code(previewInvitation(db, token, deps))).toBe("not-found");
        }
    });

    it("limits revocation by role", async () => {
        const db = testDb.db;
        await createInvitation(
            db,
            people.ann!,
            org,
            { email: "adm@example.com", role: "admin" },
            deps,
        );
        const adm = (await listInvitations(db, people.ann!, org)).find(
            (i) => i.email === "adm@example.com",
        )!;
        expect(await code(revokeInvitation(db, people.ben!, org, adm.id))).toBe("forbidden");
        expect(await code(revokeInvitation(db, people.dee!, org, adm.id))).toBe("forbidden");
        expect(await code(revokeInvitation(db, people.ann!, org, "not-a-uuid"))).toBe("not-found");
    });

    // Creates every event it asserts on, so it also works when run on its own.
    it("records the whole invitation lifecycle in the audit trail", async () => {
        const db = testDb.db;
        const audited = (
            await createOrganization(db, people.root!, {
                name: "Audited",
                slug: "audited",
                ownerEmail: "ann@example.com",
            })
        ).id;
        await createInvitation(
            db,
            people.ann!,
            audited,
            { email: "life1@example.com", role: "viewer" },
            deps,
        );
        const accepted = tokenOf(sent.at(-1)!);
        await acceptInvitation(
            db,
            null,
            { token: accepted, name: "L", password: "a-long-password-1" },
            deps,
        );
        await createInvitation(
            db,
            people.ann!,
            audited,
            { email: "life2@example.com", role: "viewer" },
            deps,
        );
        const pending = (await listInvitations(db, people.ann!, audited)).find(
            (i) => i.email === "life2@example.com",
        )!;
        await revokeInvitation(db, people.ann!, audited, pending.id);
        failDelivery = true;
        await code(
            createInvitation(
                db,
                people.ann!,
                audited,
                { email: "life3@example.com", role: "viewer" },
                deps,
            ),
        );
        failDelivery = false;
        const actions = (
            await db
                .selectFrom("audit_event")
                .select("action")
                .where("organization_id", "=", audited)
                .execute()
        ).map((a) => a.action);
        expect(actions).toEqual(
            expect.arrayContaining([
                "invitation.created",
                "invitation.accepted",
                "invitation.revoked",
                "invitation.delivery_failed",
            ]),
        );
    });
});

describe("races, caps and verification", () => {
    it("keeps at most one pending invitation per address when creates race", async () => {
        const db = testDb.db;
        const results = await Promise.all(
            [1, 2, 3].map(() =>
                code(
                    createInvitation(
                        db,
                        people.ann!,
                        org,
                        { email: "race@example.com", role: "viewer" },
                        deps,
                    ),
                ),
            ),
        );
        expect(results.every((r) => r === "ok" || r === "conflict")).toBe(true);
        expect(results).toContain("ok");
        const pending = (await listInvitations(db, people.ann!, org)).filter(
            (i) => i.email === "race@example.com",
        );
        expect(pending).toHaveLength(1);
    });

    it("does not revoke an invitation that was already accepted", async () => {
        const db = testDb.db;
        await createInvitation(
            db,
            people.ann!,
            org,
            { email: "once@example.com", role: "viewer" },
            deps,
        );
        const token = tokenOf(sent.at(-1)!);
        const invitation = (await listInvitations(db, people.ann!, org)).find(
            (i) => i.email === "once@example.com",
        )!;
        await acceptInvitation(
            db,
            null,
            { token, name: "Once", password: "a-long-password-1" },
            deps,
        );
        expect(await code(revokeInvitation(db, people.ann!, org, invitation.id))).toBe("not-found");
        const actions = (
            await db
                .selectFrom("audit_event")
                .select(["action", "target_id"])
                .where("target_id", "=", invitation.id)
                .execute()
        ).map((a) => a.action);
        expect(actions).not.toContain("invitation.revoked");
    });

    it("caps invitations per organization per day", async () => {
        const db = testDb.db;
        const other = (
            await createOrganization(db, people.root!, {
                name: "Cap",
                slug: "cap",
                ownerEmail: "ben@example.com",
            })
        ).id;
        await db
            .insertInto("organization_invitation")
            .values(
                Array.from({ length: MAX_INVITATIONS_PER_DAY }, (_, i) => ({
                    organization_id: other,
                    email: `bulk${i}@example.com`,
                    role: "viewer" as const,
                    token_hash: `hash-${i}`,
                    invited_by: people.ben!.userId,
                    expires_at: new Date(Date.now() + 1000 * 60),
                })),
            )
            .execute();
        expect(
            await code(
                createInvitation(
                    db,
                    people.ben!,
                    other,
                    { email: "one-more@example.com", role: "viewer" },
                    deps,
                ),
            ),
        ).toBe("conflict");
    });

    it("does not verify an existing account when public sign-up is on", async () => {
        const db = testDb.db;
        await newUser("squat");
        await createInvitation(
            db,
            people.ann!,
            org,
            { email: "squat@example.com", role: "viewer" },
            deps,
        );
        const token = tokenOf(sent.at(-1)!);
        expect(
            await code(
                acceptInvitation(db, people.squat!, { token }, { ...deps, publicSignup: true }),
            ),
        ).toBe("ok");
        const row = await db
            .selectFrom("user")
            .select("emailVerified")
            .where("email", "=", "squat@example.com")
            .executeTakeFirstOrThrow();
        expect(row.emailVerified).toBe(false);
    });

    it("serializes the daily cap across concurrent invitations to different addresses", async () => {
        const db = testDb.db;
        const capped = (
            await createOrganization(db, people.root!, {
                name: "Cap Race",
                slug: "cap-race",
                ownerEmail: "ann@example.com",
            })
        ).id;
        await db
            .insertInto("organization_invitation")
            .values(
                Array.from({ length: MAX_INVITATIONS_PER_DAY - 2 }, (_, i) => ({
                    organization_id: capped,
                    email: `pre${i}@example.com`,
                    role: "viewer" as const,
                    token_hash: `pre-hash-${i}`,
                    invited_by: people.ann!.userId,
                    expires_at: new Date(Date.now() + 60_000),
                })),
            )
            .execute();
        const results = await Promise.all(
            Array.from({ length: 6 }, (_, i) =>
                code(
                    createInvitation(
                        db,
                        people.ann!,
                        capped,
                        { email: `burst${i}@example.com`, role: "viewer" },
                        deps,
                    ),
                ),
            ),
        );
        expect(results.filter((r) => r === "ok")).toHaveLength(2);
        expect(results.filter((r) => r === "conflict")).toHaveLength(4);
        const total = await db
            .selectFrom("organization_invitation")
            .select((eb) => eb.fn.countAll<string>().as("n"))
            .where("organization_id", "=", capped)
            .executeTakeFirstOrThrow();
        expect(Number(total.n)).toBe(MAX_INVITATIONS_PER_DAY);
    });

    it("does not let a caller replace an invitation they could not revoke", async () => {
        const db = testDb.db;
        const guarded = (
            await createOrganization(db, people.root!, {
                name: "Guarded",
                slug: "guarded",
                ownerEmail: "ann@example.com",
            })
        ).id;
        await addMember(db, people.ann!, guarded, { email: "ben@example.com", role: "admin" });
        await createInvitation(
            db,
            people.ann!,
            guarded,
            { email: "target@example.com", role: "owner" },
            deps,
        );
        // An admin may not assign owner, so may not overwrite the pending owner invitation.
        expect(
            await code(
                createInvitation(
                    db,
                    people.ben!,
                    guarded,
                    { email: "target@example.com", role: "viewer" },
                    deps,
                ),
            ),
        ).toBe("forbidden");
        const still = await listInvitations(db, people.ann!, guarded);
        expect(still.filter((i) => i.email === "target@example.com").map((i) => i.role)).toEqual([
            "owner",
        ]);
        // The owner can replace it.
        expect(
            await code(
                createInvitation(
                    db,
                    people.ann!,
                    guarded,
                    { email: "target@example.com", role: "viewer" },
                    deps,
                ),
            ),
        ).toBe("ok");
    });

    it("stops redemption of pending invitations once invitations are disabled", async () => {
        const db = testDb.db;
        await createInvitation(
            db,
            people.ann!,
            org,
            { email: "later@example.com", role: "viewer" },
            deps,
        );
        const token = tokenOf(sent.at(-1)!);
        const off = { ...deps, enabled: false };
        expect(await code(previewInvitation(db, token, off))).toBe("not-found");
        expect(
            await code(
                acceptInvitation(
                    db,
                    null,
                    { token, name: "L", password: "a-long-password-1" },
                    off,
                ),
            ),
        ).toBe("not-found");
        // Nothing was consumed: turning invitations back on makes the same token work again.
        expect(
            await code(
                acceptInvitation(
                    db,
                    null,
                    { token, name: "L", password: "a-long-password-1" },
                    deps,
                ),
            ),
        ).toBe("ok");
    });
});
