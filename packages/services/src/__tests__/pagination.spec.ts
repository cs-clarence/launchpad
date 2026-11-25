// Database tests: keyset SQL for the session-only lists. Cursor unit tests are in ../pagination.spec.ts.
import { randomUUID } from "node:crypto";
import { createTestDatabase } from "@launchpad-kit/database/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    createApiKey,
    createOrganization,
    listApiKeys,
    listApiKeysPage,
    listAppsPage,
    listInvitations,
    listInvitationsPage,
    listMyOrganizations,
    listMyOrganizationsPage,
    listProjectsPage,
    ServiceError,
    type Page,
    type Principal,
} from "../index";

// The lists that need a signed-in user rather than an API key (invitations, API keys, a user's
// organizations) paged through the services, against a real PostgreSQL.
let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
let root: Principal;
let ann: Principal;
let org = "";
const organizations: string[] = [];

const code = (promise: Promise<unknown>) =>
    promise.then(
        () => "ok",
        (e) => (e instanceof ServiceError ? e.code : `unexpected: ${e}`),
    );

async function walk<T>(fetchPage: (cursor?: string) => Promise<Page<T>>, limit: number) {
    const pages: T[][] = [];
    let cursor: string | undefined;
    do {
        const page = await fetchPage(cursor);
        expect(page.items.length).toBeLessThanOrEqual(limit);
        pages.push(page.items);
        cursor = page.next ?? undefined;
        expect(pages.length).toBeLessThan(50);
    } while (cursor);
    return pages;
}

beforeAll(async () => {
    testDb = await createTestDatabase();
    await testDb.migrate();
    const [rootId, annId] = [randomUUID(), randomUUID()];
    for (const [id, name, role] of [
        [rootId, "root", "operator"],
        [annId, "ann", "user"],
    ] as const) {
        await testDb.db
            .insertInto("user")
            .values({ id, name, email: `${name}@example.com`, emailVerified: false, role })
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
    }
    root = { userId: rootId, instanceRole: "operator" };
    ann = { userId: annId, instanceRole: "user" };
    // Four organizations; two share a name, which only the id can order.
    for (const [name, slug] of [
        ["Same", "same-one"],
        ["Same", "same-two"],
        ["Other", "other"],
        ["Zed", "zed"],
    ] as const) {
        organizations.push(
            (
                await createOrganization(testDb.db, root, {
                    name,
                    slug,
                    ownerEmail: "ann@example.com",
                })
            ).id,
        );
    }
    org = organizations[0]!;

    for (let i = 0; i < 5; i++) {
        await testDb.db
            .insertInto("organization_invitation")
            .values({
                organization_id: org,
                email: `invitee-${i}@example.com`,
                role: "viewer",
                token_hash: `hash-${i}`,
                invited_by: ann.userId,
                expires_at: new Date(Date.now() + 86400000),
                created_at: sql<Date>`${i < 3 ? "2026-01-01T00:00:00.100000Z" : `2026-01-01T00:00:00.10000${i}Z`}::timestamptz`,
            })
            .execute();
    }

    const sessionId = randomUUID();
    await sql`insert into "session" ("id", "token", "userId", "expiresAt", "updatedAt")
        values (${sessionId}, ${sessionId}, ${ann.userId}, now() + interval '1 day', now())`.execute(
        testDb.db,
    );
    for (let i = 0; i < 5; i++) {
        await createApiKey(
            testDb.db,
            ann,
            org,
            { name: `key-${i}`, scopes: ["project:read"], expiresInDays: 30 },
            sessionId,
        );
    }
    await sql`update api_key set created_at = '2026-01-01T00:00:00.700000Z'::timestamptz
        where name in ('key-0', 'key-1', 'key-2')`.execute(testDb.db);
});

afterAll(async () => {
    await testDb.destroy();
});

describe("invitations", () => {
    it("pages in the order of the unpaginated list, across a tie", async () => {
        const all = (await listInvitations(testDb.db, ann, org)).map((row) => row.id);
        expect(all.length).toBe(5);
        const pages = await walk(
            (cursor) => listInvitationsPage(testDb.db, ann, org, { limit: 2, cursor }),
            2,
        );
        expect(pages.map((page) => page.length)).toEqual([2, 2, 1]);
        expect(pages.flat().map((row) => row.id)).toEqual(all);
    });

    it("refuses a cursor from another list or organization", async () => {
        const first = await listInvitationsPage(testDb.db, ann, org, { limit: 1 });
        expect(first.next).not.toBeNull();
        expect(
            await code(listInvitationsPage(testDb.db, ann, org, { limit: 1, cursor: "x" })),
        ).toBe("invalid");
        const keys = await listApiKeysPage(testDb.db, ann, org, { limit: 1 });
        expect(
            await code(listInvitationsPage(testDb.db, ann, org, { limit: 1, cursor: keys.next! })),
        ).toBe("invalid");
    });
});

describe("API keys", () => {
    it("pages newest first in the order of the unpaginated list, across a tie", async () => {
        const all = (await listApiKeys(testDb.db, ann, org)).map((row) => row.id);
        expect(all.length).toBe(5);
        const pages = await walk(
            (cursor) => listApiKeysPage(testDb.db, ann, org, { limit: 2, cursor }),
            2,
        );
        expect(pages.map((page) => page.length)).toEqual([2, 2, 1]);
        expect(pages.flat().map((row) => row.id)).toEqual(all);
        const stamps = (await listApiKeys(testDb.db, ann, org)).map((row) => row.createdAt);
        expect(stamps).toEqual([...stamps].sort((a, b) => b.getTime() - a.getTime()));
    });
});

describe("a user's organizations", () => {
    it("orders organizations that share a name by id, and pages without repeats", async () => {
        const all = (await listMyOrganizations(testDb.db, ann)).map((row) => row.id);
        expect(all.length).toBe(4);
        const pages = await walk(
            (cursor) => listMyOrganizationsPage(testDb.db, ann, { limit: 1, cursor }),
            1,
        );
        expect(pages.flat().map((row) => row.id)).toEqual(all);
        const names = (await listMyOrganizations(testDb.db, ann)).map((row) => row.name);
        expect(names).toEqual(["Other", "Same", "Same", "Zed"]);
    });

    it("filters to a key's own organization in SQL, so every page is full", async () => {
        const only = organizations[3]!;
        const page = await listMyOrganizationsPage(testDb.db, ann, { limit: 1 }, only);
        expect(page.items.map((row) => row.id)).toEqual([only]);
        expect(page.next).toBeNull();
        expect((await listMyOrganizations(testDb.db, ann, only)).map((row) => row.id)).toEqual([
            only,
        ]);
    });

    it("refuses a cursor from another list", async () => {
        const keys = await listApiKeysPage(testDb.db, ann, org, { limit: 1 });
        expect(
            await code(listMyOrganizationsPage(testDb.db, ann, { limit: 1, cursor: keys.next! })),
        ).toBe("invalid");
    });
});

describe("an empty project allow-list", () => {
    it("still refuses a malformed cursor, and gives an empty page without one", async () => {
        for (const list of [listAppsPage, listProjectsPage]) {
            const empty = await list(testDb.db, ann, org, { limit: 1 }, []);
            expect(empty).toEqual({ items: [], next: null });
            expect(
                await code(list(testDb.db, ann, org, { limit: 1, cursor: "not*base64" }, [])),
            ).toBe("invalid");
        }
    });
});
