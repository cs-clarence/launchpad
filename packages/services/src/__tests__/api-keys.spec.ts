import { randomUUID } from "node:crypto";
import { createTestDatabase } from "@launchpad/database/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    addMember,
    authenticateApiKey,
    createApiKey,
    createOrganization,
    createProject,
    listApiKeys,
    MAX_ACTIVE_KEYS_PER_ORGANIZATION,
    removeMember,
    revokeApiKey,
    ServiceError,
    type Principal,
} from "../index";

let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
const people: Record<string, Principal> = {};
let org = "";
let otherOrg = "";
let projectA = "";
let otherProject = "";

const code = (promise: Promise<unknown>) =>
    promise.then(
        () => "ok",
        (e) => (e instanceof ServiceError ? e.code : `unexpected: ${e}`),
    );

async function newUser(name: string, role: "user" | "operator" = "user") {
    const id = randomUUID();
    await testDb.db
        .insertInto("user")
        .values({ id, name, email: `${name}@example.com`, emailVerified: false, image: null, role })
        .execute();
    await testDb.db
        .insertInto("audit_event")
        .values({
            actor: "operator-cli",
            action: "user.provisioned",
            target_type: "user",
            target_id: id,
        })
        .execute();
    people[name] = { userId: id, instanceRole: role };
}

const issue = (who: string, extra: Record<string, unknown> = {}, organization = org) =>
    createApiKey(testDb.db, people[who]!, organization, {
        name: "ci",
        scopes: ["project:read"],
        expiresInDays: 30,
        ...extra,
    });

beforeAll(async () => {
    testDb = await createTestDatabase();
    await testDb.migrate();
    await newUser("root", "operator");
    for (const n of ["ann", "ben", "dee", "vic", "zoe"]) await newUser(n);
    const db = testDb.db;
    org = (
        await createOrganization(db, people.root!, {
            name: "Acme",
            slug: "acme",
            ownerEmail: "ann@example.com",
        })
    ).id;
    otherOrg = (
        await createOrganization(db, people.root!, {
            name: "Beta",
            slug: "beta",
            ownerEmail: "zoe@example.com",
        })
    ).id;
    await addMember(db, people.ann!, org, { email: "ben@example.com", role: "admin" });
    await addMember(db, people.ann!, org, { email: "dee@example.com", role: "deployer" });
    await addMember(db, people.ann!, org, { email: "vic@example.com", role: "viewer" });
    projectA = (await createProject(db, people.ann!, org, { name: "A", slug: "a" })).id;
    otherProject = (await createProject(db, people.zoe!, otherOrg, { name: "Z", slug: "z" })).id;
});
afterAll(async () => {
    await testDb.destroy();
});

describe("issuing keys", () => {
    it("reveals the secret once and stores only a hash", async () => {
        const key = await issue("ann");
        expect(key.secret.startsWith("lp_")).toBe(true);
        const rows = await testDb.db
            .selectFrom("api_key")
            .selectAll()
            .where("id", "=", key.id)
            .execute();
        expect(JSON.stringify(rows)).not.toContain(key.secret);
        const listed = await listApiKeys(testDb.db, people.ann!, org);
        expect(JSON.stringify(listed)).not.toContain(key.secret);
        const audit = await testDb.db
            .selectFrom("audit_event")
            .select("action")
            .where("target_id", "=", key.id)
            .execute();
        expect(audit.map((a) => a.action)).toEqual(["api_key.created"]);
    });

    it("limits who can manage keys and hides the org from outsiders", async () => {
        expect(await code(issue("dee"))).toBe("forbidden");
        expect(await code(issue("vic"))).toBe("forbidden");
        expect(await code(issue("zoe"))).toBe("not-found");
        expect(await code(listApiKeys(testDb.db, people.dee!, org))).toBe("forbidden");
    });

    it("never grants more than the creator's role, or any management scope", async () => {
        expect(await code(issue("ben", { scopes: ["member:manage"] }))).toBe("invalid");
        expect(await code(issue("ben", { scopes: ["apikey:manage"] }))).toBe("invalid");
        expect(await code(issue("ben", { scopes: ["organization:delete"] }))).toBe("invalid");
        expect(await code(issue("ben", { scopes: ["project:delete", "project:create"] }))).toBe(
            "ok",
        );
    });

    it("validates expiry, scopes and project restrictions", async () => {
        expect(await code(issue("ann", { expiresInDays: 0 }))).toBe("invalid");
        expect(await code(issue("ann", { expiresInDays: 366 }))).toBe("invalid");
        expect(await code(issue("ann", { scopes: [] }))).toBe("invalid");
        expect(await code(issue("ann", { projectIds: [otherProject] }))).toBe("invalid");
        expect(await code(issue("ann", { projectIds: [randomUUID()] }))).toBe("invalid");
        expect(await code(issue("ann", { projectIds: [projectA] }))).toBe("ok");
    });

    it("caps active keys per organization, even under concurrency", async () => {
        const capOrg = (
            await createOrganization(testDb.db, people.root!, {
                name: "Cap",
                slug: "cap",
                ownerEmail: "ann@example.com",
            })
        ).id;
        const results = await Promise.all(
            Array.from({ length: MAX_ACTIVE_KEYS_PER_ORGANIZATION + 5 }, () =>
                code(issue("ann", {}, capOrg)),
            ),
        );
        expect(results.filter((r) => r === "ok")).toHaveLength(MAX_ACTIVE_KEYS_PER_ORGANIZATION);
        expect(results.filter((r) => r === "conflict")).toHaveLength(5);
    });
});

describe("authenticating keys", () => {
    it("resolves a valid key to its organization, creator, scopes and projects", async () => {
        const key = await issue("ann", {
            scopes: ["project:read", "project:create"],
            projectIds: [projectA],
        });
        const auth = await authenticateApiKey(testDb.db, key.secret);
        expect(auth).toMatchObject({
            keyId: key.id,
            organizationId: org,
            principal: { userId: people.ann!.userId },
            scopes: ["project:read", "project:create"],
            projectIds: [projectA],
        });
        const row = await testDb.db
            .selectFrom("api_key")
            .select("last_used_at")
            .where("id", "=", key.id)
            .executeTakeFirstOrThrow();
        expect(row.last_used_at).not.toBeNull();
    });

    it("rejects unknown, malformed, revoked and expired keys identically", async () => {
        const db = testDb.db;
        expect(await authenticateApiKey(db, "lp_nope")).toBeNull();
        expect(await authenticateApiKey(db, "not-a-key")).toBeNull();
        expect(await authenticateApiKey(db, "lp_" + "x".repeat(500))).toBeNull();
        const revoked = await issue("ann");
        await revokeApiKey(db, people.ann!, org, revoked.id);
        expect(await authenticateApiKey(db, revoked.secret)).toBeNull();
        const expired = await issue("ann");
        await db
            .updateTable("api_key")
            .set({ expires_at: new Date(Date.now() - 1000) })
            .where("id", "=", expired.id)
            .execute();
        expect(await authenticateApiKey(db, expired.secret)).toBeNull();
    });

    it("narrows scopes when the creator is demoted, and stops when removed", async () => {
        const db = testDb.db;
        await newUser("kim");
        await addMember(db, people.ann!, org, { email: "kim@example.com", role: "admin" });
        const key = await issue("kim", { scopes: ["project:read", "project:delete"] });
        expect((await authenticateApiKey(db, key.secret))?.scopes).toEqual([
            "project:read",
            "project:delete",
        ]);
        await db
            .updateTable("member")
            .set({ role: "viewer" })
            .where("userId", "=", people.kim!.userId)
            .where("organizationId", "=", org)
            .execute();
        expect((await authenticateApiKey(db, key.secret))?.scopes).toEqual(["project:read"]);
        await removeMember(db, people.ann!, org, people.kim!.userId);
        expect(await authenticateApiKey(db, key.secret)).toBeNull();
    });
});

describe("revoking keys", () => {
    it("is idempotent, audited, and limited to the key's organization", async () => {
        const db = testDb.db;
        const key = await issue("ann");
        expect(await code(revokeApiKey(db, people.dee!, org, key.id))).toBe("forbidden");
        expect(await code(revokeApiKey(db, people.zoe!, otherOrg, key.id))).toBe("not-found");
        expect(await code(revokeApiKey(db, people.ben!, org, key.id))).toBe("ok");
        const first = await db
            .selectFrom("api_key")
            .select("revoked_at")
            .where("id", "=", key.id)
            .executeTakeFirstOrThrow();
        expect(await code(revokeApiKey(db, people.ann!, org, key.id))).toBe("ok");
        const second = await db
            .selectFrom("api_key")
            .select("revoked_at")
            .where("id", "=", key.id)
            .executeTakeFirstOrThrow();
        expect(second.revoked_at).toEqual(first.revoked_at);
        const audit = await db
            .selectFrom("audit_event")
            .select("action")
            .where("target_id", "=", key.id)
            .execute();
        expect(audit.map((a) => a.action).toSorted()).toEqual([
            "api_key.created",
            "api_key.revoked",
        ]);
        expect(await code(revokeApiKey(db, people.ann!, org, "not-a-uuid"))).toBe("not-found");
    });
});
