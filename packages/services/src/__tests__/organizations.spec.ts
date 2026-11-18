import { randomUUID } from "node:crypto";
import { createTestDatabase } from "@launchpad-kit/database/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    addMember,
    createOrganization,
    createProject,
    listMembers,
    listMyOrganizations,
    listProjects,
    removeMember,
    ServiceError,
    getOrganization,
    type Principal,
} from "../index";

let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
const people: Record<string, Principal & { email: string }> = {};

// By default a user is operator-provisioned (the audit event `admin create-user` writes),
// which is what may receive access by email. `selfRegistered` is an account that signed
// itself up: unverified, with no provisioning record.
async function newUser(
    name: string,
    instanceRole: "user" | "operator" = "user",
    options: { selfRegistered?: boolean } = {},
) {
    const id = randomUUID();
    const email = `${name}@example.com`;
    await testDb.db
        .insertInto("user")
        .values({ id, name, email, emailVerified: false, image: null, role: instanceRole })
        .execute();
    if (!options.selfRegistered) {
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
    people[name] = { userId: id, instanceRole, email };
    return people[name]!;
}

const code = (promise: Promise<unknown>) =>
    promise.then(
        () => "ok",
        (e) => (e instanceof ServiceError ? e.code : `unexpected: ${e}`),
    );

let acme = "";
let beta = "";

beforeAll(async () => {
    testDb = await createTestDatabase();
    await testDb.migrate();
    for (const name of ["root"]) await newUser(name, "operator");
    for (const name of ["ann", "ben", "dee", "vic", "eve", "zed"]) await newUser(name);
    const db = testDb.db;
    acme = (
        await createOrganization(db, people.root!, {
            name: "Acme",
            slug: "acme",
            ownerEmail: "ann@example.com",
        })
    ).id;
    beta = (
        await createOrganization(db, people.root!, {
            name: "Beta",
            slug: "beta",
            ownerEmail: "eve@example.com",
        })
    ).id;
    await addMember(db, people.ann!, acme, { email: "ben@example.com", role: "admin" });
    await addMember(db, people.ann!, acme, { email: "dee@example.com", role: "deployer" });
    await addMember(db, people.ann!, acme, { email: "vic@example.com", role: "viewer" });
});
afterAll(async () => {
    await testDb.destroy();
});

describe("organizations", () => {
    it("lets only the operator create organizations, and gives the operator no membership", async () => {
        const db = testDb.db;
        expect(
            await code(
                createOrganization(db, people.ann!, {
                    name: "X",
                    slug: "x",
                    ownerEmail: "ann@example.com",
                }),
            ),
        ).toBe("forbidden");
        expect(
            await code(
                createOrganization(db, people.root!, {
                    name: "Acme2",
                    slug: "acme",
                    ownerEmail: "ann@example.com",
                }),
            ),
        ).toBe("conflict");
        expect(
            await code(
                createOrganization(db, people.root!, {
                    name: "Y",
                    slug: "y",
                    ownerEmail: "nobody@example.com",
                }),
            ),
        ).toBe("invalid");
        expect(
            await code(
                createOrganization(db, people.root!, {
                    name: "Y",
                    slug: "Bad Slug",
                    ownerEmail: "ann@example.com",
                }),
            ),
        ).toBe("invalid");
        expect(await listMyOrganizations(db, people.root!)).toEqual([]);
    });

    it("hides organizations from non-members and other organizations' members", async () => {
        const db = testDb.db;
        for (const p of [people.root!, people.eve!, people.zed!]) {
            expect(await code(getOrganization(db, p, acme))).toBe("not-found");
            expect(await code(listMembers(db, p, acme))).toBe("not-found");
            expect(await code(listProjects(db, p, acme))).toBe("not-found");
            expect(await code(createProject(db, p, acme, { name: "P", slug: "p" }))).toBe(
                "not-found",
            );
        }
        expect((await listMyOrganizations(db, people.eve!)).map((o) => o.slug)).toEqual(["beta"]);
    });
});

describe("projects", () => {
    it("lets deployers and above create, viewers only read", async () => {
        const db = testDb.db;
        expect(
            await code(createProject(db, people.vic!, acme, { name: "Site", slug: "site" })),
        ).toBe("forbidden");
        expect(
            await code(createProject(db, people.dee!, acme, { name: "Site", slug: "site" })),
        ).toBe("ok");
        expect(
            await code(createProject(db, people.ann!, acme, { name: "Site again", slug: "site" })),
        ).toBe("conflict");
        expect(await code(createProject(db, people.ann!, acme, { name: "", slug: "ok" }))).toBe(
            "invalid",
        );
        expect((await listProjects(db, people.vic!, acme)).map((p) => p.slug)).toEqual(["site"]);
    });

    it("keeps slugs per organization and projects out of other organizations", async () => {
        const db = testDb.db;
        expect(
            await code(createProject(db, people.eve!, beta, { name: "Site", slug: "site" })),
        ).toBe("ok");
        expect((await listProjects(db, people.eve!, beta)).map((p) => p.slug)).toEqual(["site"]);
        const rows = await db.selectFrom("project").select(["organization_id"]).execute();
        expect(new Set(rows.map((r) => r.organization_id))).toEqual(new Set([acme, beta]));
    });
});

describe("membership", () => {
    it("restricts who can manage and which roles can be assigned", async () => {
        const db = testDb.db;
        expect(
            await code(
                addMember(db, people.dee!, acme, { email: "zed@example.com", role: "viewer" }),
            ),
        ).toBe("forbidden");
        expect(
            await code(
                addMember(db, people.ben!, acme, { email: "zed@example.com", role: "admin" }),
            ),
        ).toBe("forbidden");
        expect(
            await code(
                addMember(db, people.ben!, acme, { email: "zed@example.com", role: "owner" }),
            ),
        ).toBe("forbidden");
        expect(
            await code(
                addMember(db, people.ben!, acme, { email: "nobody@example.com", role: "viewer" }),
            ),
        ).toBe("invalid");
        expect(
            await code(
                addMember(db, people.ben!, acme, { email: "zed@example.com", role: "root" }),
            ),
        ).toBe("invalid");
        expect(
            await code(
                addMember(db, people.ben!, acme, { email: "zed@example.com", role: "viewer" }),
            ),
        ).toBe("ok");
        expect(
            await code(
                addMember(db, people.ben!, acme, { email: "zed@example.com", role: "viewer" }),
            ),
        ).toBe("conflict");
    });

    it("limits removal by role and protects the last owner", async () => {
        const db = testDb.db;
        expect(await code(removeMember(db, people.dee!, acme, people.zed!.userId))).toBe(
            "forbidden",
        );
        expect(await code(removeMember(db, people.ben!, acme, people.ann!.userId))).toBe(
            "forbidden",
        );
        expect(await code(removeMember(db, people.ben!, acme, people.zed!.userId))).toBe("ok");
        expect(await code(removeMember(db, people.ben!, acme, people.zed!.userId))).toBe(
            "not-found",
        );
        expect(await code(removeMember(db, people.ann!, acme, people.ann!.userId))).toBe(
            "conflict",
        );
        await addMember(db, people.ann!, acme, { email: "zed@example.com", role: "owner" });
        expect(await code(removeMember(db, people.ann!, acme, people.ann!.userId))).toBe("ok");
        expect(await code(removeMember(db, people.zed!, acme, people.zed!.userId))).toBe(
            "conflict",
        );
        expect((await listMembers(db, people.zed!, acme)).map((m) => m.role)).toContain("owner");
    });

    it("rejects an unknown role at the database level", async () => {
        await expect(
            testDb.db
                .insertInto("member")
                .values({
                    id: randomUUID(),
                    organizationId: beta,
                    userId: people.zed!.userId,
                    role: "root" as never,
                    createdAt: new Date(),
                })
                .execute(),
        ).rejects.toThrow();
    });
});

describe("concurrency and audit", () => {
    it("keeps one owner when two owners leave at the same time", async () => {
        const db = testDb.db;
        const org = (
            await createOrganization(db, people.root!, {
                name: "Race",
                slug: "race",
                ownerEmail: "ann@example.com",
            })
        ).id;
        await addMember(db, people.ann!, org, { email: "ben@example.com", role: "owner" });
        const results = await Promise.all([
            code(removeMember(db, people.ann!, org, people.ann!.userId)),
            code(removeMember(db, people.ben!, org, people.ben!.userId)),
        ]);
        expect(results.toSorted()).toEqual(["conflict", "ok"]);
        const owners = await db
            .selectFrom("member")
            .select("userId")
            .where("organizationId", "=", org)
            .where("role", "=", "owner")
            .execute();
        expect(owners).toHaveLength(1);
    });

    it("records who changed what, in the same transaction as the change", async () => {
        const db = testDb.db;
        const rows = await db
            .selectFrom("audit_event")
            .select(["actor", "action", "target_type", "target_id", "organization_id", "detail"])
            .where("organization_id", "=", acme)
            .execute();
        expect(rows).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    action: "member.added",
                    target_type: "member",
                    target_id: people.vic!.userId,
                    actor: `user:${people.ann!.userId}`,
                    detail: "role=viewer",
                }),
                expect.objectContaining({ action: "organization.created", target_id: acme }),
                expect.objectContaining({ action: "member.removed", detail: "role=viewer" }),
            ]),
        );
        const projectAudit = await db
            .selectFrom("audit_event")
            .select("action")
            .where("action", "=", "project.created")
            .execute();
        expect(projectAudit.length).toBeGreaterThanOrEqual(2);
    });

    it("rejects control and bidi characters in display names", async () => {
        const db = testDb.db;
        // Its own organization and owner: not whatever earlier tests left behind.
        await newUser("namer");
        const names = (
            await createOrganization(db, people.root!, {
                name: "Names",
                slug: "names",
                ownerEmail: "namer@example.com",
            })
        ).id;
        expect(
            await code(createProject(db, people.namer!, names, { name: "a\u202Eb", slug: "bidi" })),
        ).toBe("invalid");
        expect(
            await code(createProject(db, people.namer!, names, { name: "tab\tname", slug: "tab" })),
        ).toBe("invalid");
        expect(
            await code(createProject(db, people.namer!, names, { name: "Fine", slug: "fine" })),
        ).toBe("ok");
    });

    // A removed owner must not be able to add themselves back with a permission
    // check that was valid before their removal landed.
    it("does not let a concurrently removed owner re-add themselves", async () => {
        const db = testDb.db;
        for (let round = 0; round < 8; round++) {
            await newUser(`ra${round}`);
            await newUser(`rb${round}`);
            const org = (
                await createOrganization(db, people.root!, {
                    name: `Race ${round}`,
                    slug: `race-add-${round}`,
                    ownerEmail: `ra${round}@example.com`,
                })
            ).id;
            await addMember(db, people[`ra${round}`]!, org, {
                email: `rb${round}@example.com`,
                role: "owner",
            });
            const [removed, added] = await Promise.all([
                code(removeMember(db, people[`rb${round}`]!, org, people[`ra${round}`]!.userId)),
                code(
                    addMember(db, people[`ra${round}`]!, org, {
                        email: `ra${round}@example.com`,
                        role: "owner",
                    }),
                ),
            ]);
            expect(removed, `round ${round}`).toBe("ok");
            expect(["conflict", "not-found"], `round ${round}: ${added}`).toContain(added);
            const still = await db
                .selectFrom("member")
                .select("userId")
                .where("organizationId", "=", org)
                .where("userId", "=", people[`ra${round}`]!.userId)
                .execute();
            expect(still, `round ${round}`).toHaveLength(0);
        }
    });
});

describe("grants by email", () => {
    it("refuses a self-registered, unverified account, whatever the sign-up setting is now", async () => {
        const db = testDb.db;
        await newUser("squatter", "user", { selfRegistered: true });
        const guarded = (
            await createOrganization(db, people.root!, {
                name: "Guarded G",
                slug: "guarded-g",
                ownerEmail: "ann@example.com",
            })
        ).id;
        expect(
            await code(
                addMember(db, people.ann!, guarded, {
                    email: "squatter@example.com",
                    role: "viewer",
                }),
            ),
        ).toBe("invalid");
        expect(
            await code(
                createOrganization(db, people.root!, {
                    name: "Squat",
                    slug: "squat",
                    ownerEmail: "squatter@example.com",
                }),
            ),
        ).toBe("invalid");
        const rows = await db
            .selectFrom("member")
            .select("userId")
            .where("userId", "=", people.squatter!.userId)
            .execute();
        expect(rows).toHaveLength(0);
    });

    it("allows operator-provisioned and verified accounts", async () => {
        const db = testDb.db;
        await newUser("verified", "user", { selfRegistered: true });
        await db
            .updateTable("user")
            .set({ emailVerified: true })
            .where("id", "=", people.verified!.userId)
            .execute();
        await newUser("provisioned");
        const org = (
            await createOrganization(db, people.root!, {
                name: "Open G",
                slug: "open-g",
                ownerEmail: "provisioned@example.com",
            })
        ).id;
        expect(
            await code(
                addMember(db, people.provisioned!, org, {
                    email: "verified@example.com",
                    role: "viewer",
                }),
            ),
        ).toBe("ok");
    });
});
