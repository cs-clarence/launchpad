import { randomUUID } from "node:crypto";
import { createTestDatabase } from "@launchpad/database/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    addMember,
    createOrganization,
    createPreview,
    createProject,
    getPreview,
    IDEMPOTENCY_TTL_MS,
    listPreviews,
    MAX_PREVIEWS_PER_ORGANIZATION,
    removeMember,
    ServiceError,
    type Principal,
} from "../index";

let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
const people: Record<string, Principal> = {};
// A high cap for the shared organization; the cap itself is tested on its own.
const deps = { previewDomain: "previews.example.com", maxPreviews: 1000 };
let org = "";
let otherOrg = "";
let project = "";
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

const create = (who: string, slug: string, extra: { project?: string; key?: string } = {}) =>
    createPreview(
        testDb.db,
        people[who]!,
        org,
        extra.project ?? project,
        { slug },
        deps,
        extra.key,
    );

async function artifactIn(organizationId: string, by: string) {
    return testDb.db
        .insertInto("artifact")
        .values({
            organization_id: organizationId,
            digest: randomUUID().replaceAll("-", "").padEnd(64, "0"),
            size_bytes: 10,
            expanded_bytes: 20,
            entry_count: 1,
            storage_key: "x",
            created_by: people[by]!.userId,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
}

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
    project = (await createProject(db, people.ann!, org, { name: "Site", slug: "site" })).id;
    otherProject = (await createProject(db, people.zoe!, otherOrg, { name: "Z", slug: "z" })).id;
});
afterAll(async () => {
    await testDb.destroy();
});

describe("creating previews", () => {
    it("generates opaque names, and only identifiers it generated reach app_name", async () => {
        const a = await create("dee", "review");
        const b = await create("dee", "review-two");
        expect(a.hostname).toMatch(/^review-[a-z0-9]{6}\.previews\.example\.com$/);
        const rows = await testDb.db
            .selectFrom("preview")
            .select(["id", "app_name", "hostname"])
            .where("id", "in", [a.id, b.id])
            .execute();
        for (const row of rows) {
            expect(row.app_name).toMatch(/^lp-[a-z0-9]{10}$/);
            expect(row.app_name).not.toContain("review");
        }
        expect(new Set(rows.map((r) => r.app_name)).size).toBe(2);
        expect(JSON.stringify(a)).not.toContain("lp-");
        expect(a).toMatchObject({ projectId: project, state: "active", activeDeploymentId: null });
    });

    it("limits who can create, read and see the organization", async () => {
        expect(await code(create("vic", "viewer-try"))).toBe("forbidden");
        expect(await code(create("zoe", "outsider-try"))).toBe("not-found");
        expect(await code(create("root", "operator-try"))).toBe("not-found");
        expect(await code(create("ben", "admin-ok"))).toBe("ok");
        expect((await listPreviews(testDb.db, people.vic!, org)).items).not.toHaveLength(0);
        expect(await code(listPreviews(testDb.db, people.zoe!, org))).toBe("not-found");
        expect(await code(listPreviews(testDb.db, people.root!, org))).toBe("not-found");
    });

    it("refuses a creator removed meanwhile, and records an audit event", async () => {
        await newUser("gone");
        await addMember(testDb.db, people.ann!, org, {
            email: "gone@example.com",
            role: "deployer",
        });
        await removeMember(testDb.db, people.ann!, org, people.gone!.userId);
        expect(await code(create("gone", "late"))).toBe("not-found");
        const made = await create("ann", "audited");
        const audit = await testDb.db
            .selectFrom("audit_event")
            .select(["actor", "organization_id"])
            .where("target_id", "=", made.id)
            .where("action", "=", "preview.created")
            .execute();
        expect(audit).toEqual([{ actor: `user:${people.ann!.userId}`, organization_id: org }]);
    });

    it("validates input, the project and the preview domain", async () => {
        expect(await code(create("ann", "Bad Slug"))).toBe("invalid");
        expect(await code(create("ann", ""))).toBe("invalid");
        expect(await code(create("ann", "x", { project: randomUUID() }))).toBe("not-found");
        expect(await code(create("ann", "x", { project: "nope" }))).toBe("not-found");
        // A project of another organization is indistinguishable from none.
        expect(await code(create("ann", "x", { project: otherProject }))).toBe("not-found");
        for (const previewDomain of ["Example.com", "-bad.example.com", "nodot", "a b.com", ""]) {
            await expect(
                createPreview(
                    testDb.db,
                    people.ann!,
                    org,
                    project,
                    { slug: "dom" },
                    { previewDomain },
                ),
            ).rejects.toThrow(/preview domain/);
        }
    });

    it("rejects a duplicate name in a project", async () => {
        await create("ann", "dup");
        expect(await code(create("ann", "dup"))).toBe("conflict");
    });
});

describe("reading previews", () => {
    it("keeps organizations apart", async () => {
        const mine = await create("ann", "isolated");
        expect((await getPreview(testDb.db, people.vic!, org, mine.id)).slug).toBe("isolated");
        expect(await code(getPreview(testDb.db, people.zoe!, otherOrg, mine.id))).toBe("not-found");
        expect(await code(getPreview(testDb.db, people.vic!, org, "nope"))).toBe("not-found");
        const other = await createPreview(
            testDb.db,
            people.zoe!,
            otherOrg,
            otherProject,
            { slug: "theirs" },
            deps,
        );
        const listed = (await listPreviews(testDb.db, people.vic!, org)).items;
        expect(listed.map((p) => p.id)).not.toContain(other.id);
        expect(await code(getPreview(testDb.db, people.vic!, org, other.id))).toBe("not-found");
        expect(await listPreviews(testDb.db, people.vic!, org, { projectId: "nope" })).toEqual({
            items: [],
            nextCursor: null,
        });
    });
});

describe("the live-preview cap", () => {
    it("holds under concurrent creation", async () => {
        const capOrg = (
            await createOrganization(testDb.db, people.root!, {
                name: "Cap",
                slug: "cap-org",
                ownerEmail: "ann@example.com",
            })
        ).id;
        const capProject = (
            await createProject(testDb.db, people.ann!, capOrg, { name: "P", slug: "p" })
        ).id;
        const results = await Promise.all(
            Array.from({ length: MAX_PREVIEWS_PER_ORGANIZATION + 4 }, (_, i) =>
                code(
                    createPreview(
                        testDb.db,
                        people.ann!,
                        capOrg,
                        capProject,
                        { slug: `p-${i}` },
                        { previewDomain: deps.previewDomain },
                    ),
                ),
            ),
        );
        expect(results.filter((r) => r === "ok")).toHaveLength(MAX_PREVIEWS_PER_ORGANIZATION);
        expect(results.filter((r) => r === "conflict")).toHaveLength(4);
    });
});

describe("listing past one page", () => {
    it("reaches every preview through the cursor, in a stable order", async () => {
        const bigOrg = (
            await createOrganization(testDb.db, people.root!, {
                name: "Big",
                slug: "big-org",
                ownerEmail: "ann@example.com",
            })
        ).id;
        const bigProject = (
            await createProject(testDb.db, people.ann!, bigOrg, { name: "B", slug: "b" })
        ).id;
        const created: string[] = [];
        for (let i = 0; i < 105; i++) {
            created.push(
                (
                    await createPreview(
                        testDb.db,
                        people.ann!,
                        bigOrg,
                        bigProject,
                        { slug: `n-${i}` },
                        { ...deps, maxPreviews: 150 },
                    )
                ).id,
            );
        }
        const seen: string[] = [];
        let after: string | undefined;
        const sizes: number[] = [];
        do {
            const page = await listPreviews(testDb.db, people.ann!, bigOrg, { after });
            sizes.push(page.items.length);
            seen.push(...page.items.map((p) => p.id));
            after = page.nextCursor ?? undefined;
        } while (after);
        expect(sizes).toEqual([100, 5]);
        expect(new Set(seen).size).toBe(105);
        expect(seen.toSorted()).toEqual(created.toSorted());
        // A malformed cursor is invalid; one from another organization finds nothing.
        expect(await code(listPreviews(testDb.db, people.ann!, bigOrg, { after: "nope" }))).toBe(
            "invalid",
        );
        const foreign = await listPreviews(testDb.db, people.ann!, bigOrg, { after: randomUUID() });
        expect(foreign.items).toEqual([]);
    });
});

describe("the configured cap", () => {
    it("rejects a value that would silently remove or distort it", async () => {
        for (const maxPreviews of [Number.NaN, Infinity, 1.5, 0, -1, 2 ** 60]) {
            await expect(
                createPreview(
                    testDb.db,
                    people.ann!,
                    org,
                    project,
                    { slug: "cap-bad" },
                    { ...deps, maxPreviews },
                ),
                String(maxPreviews),
            ).rejects.toThrow(/maxPreviews/);
        }
    });
});

describe("idempotency", () => {
    it("returns the first result for a repeated key and payload", async () => {
        const first = await create("dee", "idem", { key: "k-1" });
        const again = await create("dee", "idem", { key: "k-1" });
        expect(again.id).toBe(first.id);
        const rows = await testDb.db
            .selectFrom("preview")
            .select("id")
            .where("slug", "=", "idem")
            .execute();
        expect(rows).toHaveLength(1);
    });

    it("conflicts on the same key with a different payload, and is bound to the caller", async () => {
        await create("dee", "idem-a", { key: "k-2" });
        expect(await code(create("dee", "idem-b", { key: "k-2" }))).toBe("conflict");
        // The same key is a different request for another principal.
        expect(await code(create("ben", "idem-b", { key: "k-2" }))).toBe("ok");
        expect(await code(create("dee", "idem-c", { key: "" }))).toBe("invalid");
        expect(await code(create("dee", "idem-c", { key: "x".repeat(129) }))).toBe("invalid");
    });

    it("creates exactly once under concurrent requests with one key", async () => {
        const results = await Promise.all(
            Array.from({ length: 6 }, () =>
                create("dee", "race", { key: "k-race" }).then((p) => p.id),
            ),
        );
        expect(new Set(results).size).toBe(1);
        const rows = await testDb.db
            .selectFrom("preview")
            .select("id")
            .where("slug", "=", "race")
            .execute();
        expect(rows).toHaveLength(1);
    });

    it("forgets an expired key", async () => {
        await create("dee", "idem-old", { key: "k-old" });
        await testDb.db
            .updateTable("idempotency_key")
            .set({ expires_at: new Date(Date.now() - 1000) })
            .where("key", "=", "k-old")
            .execute();
        // The old key no longer protects against a different payload.
        expect(await code(create("dee", "idem-new", { key: "k-old" }))).toBe("ok");
        expect(IDEMPOTENCY_TTL_MS).toBe(24 * 60 * 60 * 1000);
    });
});

describe("database invariants", () => {
    const insertPreview = (organizationId: string, projectId: string, slug: string) =>
        testDb.db
            .insertInto("preview")
            .values({
                organization_id: organizationId,
                project_id: projectId,
                slug,
                app_name: `lp-${randomUUID().replaceAll("-", "").slice(0, 10)}`,
                hostname: `${slug}-${randomUUID().slice(0, 6)}.previews.example.com`,
                active_deployment_id: null,
                created_by: people.ann!.userId,
            })
            .execute();

    it("cannot point a preview at another organization's project", async () => {
        await expect(insertPreview(org, otherProject, "cross")).rejects.toThrow();
    });

    it("cannot deploy another organization's artifact or preview", async () => {
        const mine = await create("ann", "fk-own");
        const theirArtifact = await artifactIn(otherOrg, "zoe");
        const myArtifact = await artifactIn(org, "ann");
        const insert = (organizationId: string, preview: string, artifact: string) =>
            testDb.db
                .insertInto("deployment")
                .values({
                    organization_id: organizationId,
                    preview_id: preview,
                    artifact_id: artifact,
                    image_tag: null,
                    failure_code: null,
                    failure_message: null,
                    finished_at: null,
                    requested_by: people.ann!.userId,
                })
                .execute();
        await expect(insert(org, mine.id, theirArtifact.id)).rejects.toThrow();
        await expect(insert(otherOrg, mine.id, theirArtifact.id)).rejects.toThrow();
        await expect(insert(org, mine.id, myArtifact.id)).resolves.toBeDefined();
    });

    it("allows one unfinished deployment per preview, and an uncertain one blocks the next", async () => {
        const target = await create("ann", "serial");
        const artifact = await artifactIn(org, "ann");
        const start = (status: string) =>
            testDb.db
                .insertInto("deployment")
                .values({
                    organization_id: org,
                    preview_id: target.id,
                    artifact_id: artifact.id,
                    status: status as never,
                    image_tag: null,
                    failure_code: null,
                    failure_message: null,
                    finished_at: null,
                    requested_by: people.ann!.userId,
                })
                .execute();
        await start("succeeded");
        await start("failed");
        await start("queued");
        for (const status of ["queued", "building", "reconciliation-needed"]) {
            await expect(start(status), status).rejects.toThrow();
        }
        await testDb.db
            .updateTable("deployment")
            .set({ status: "reconciliation-needed" })
            .where("preview_id", "=", target.id)
            .where("status", "=", "queued")
            .execute();
        await expect(start("queued")).rejects.toThrow();
        await expect(start("not-a-status")).rejects.toThrow();
        await testDb.db
            .updateTable("deployment")
            .set({ status: "failed" })
            .where("preview_id", "=", target.id)
            .where("status", "=", "reconciliation-needed")
            .execute();
        await expect(start("queued")).resolves.toBeDefined();
    });

    it("cannot make another preview's deployment active, even within one organization", async () => {
        const first = await create("ann", "active-a");
        const second = await create("ann", "active-b");
        const artifact = await artifactIn(org, "ann");
        const deployment = await testDb.db
            .insertInto("deployment")
            .values({
                organization_id: org,
                preview_id: first.id,
                artifact_id: artifact.id,
                status: "succeeded",
                image_tag: null,
                failure_code: null,
                failure_message: null,
                finished_at: null,
                requested_by: people.ann!.userId,
            })
            .returning("id")
            .executeTakeFirstOrThrow();
        const activate = (previewId: string) =>
            testDb.db
                .updateTable("preview")
                .set({ active_deployment_id: deployment.id })
                .where("id", "=", previewId)
                .execute();
        await expect(activate(second.id)).rejects.toThrow();
        await expect(activate(first.id)).resolves.toBeDefined();
    });

    it("deduplicates artifacts within an organization only, and rejects malformed digests", async () => {
        const digest = "ab".repeat(32);
        const base = {
            digest,
            size_bytes: 1,
            expanded_bytes: 1,
            entry_count: 1,
            storage_key: "k",
        };
        const put = (organizationId: string, by: string, overrides = {}) =>
            testDb.db
                .insertInto("artifact")
                .values({
                    ...base,
                    ...overrides,
                    organization_id: organizationId,
                    created_by: people[by]!.userId,
                })
                .execute();
        await put(org, "ann");
        await put(otherOrg, "zoe");
        await expect(put(org, "ann")).rejects.toThrow();
        await expect(put(org, "ann", { digest: "XYZ" })).rejects.toThrow();
    });
});
