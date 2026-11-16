import { randomUUID } from "node:crypto";
import { createTestDatabase } from "@launchpad/database/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrganization, createPreview, createProject, type Principal } from "../index";

let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
let root: Principal;
let owner: Principal;
let org = "";
let previewId = "";

beforeAll(async () => {
    testDb = await createTestDatabase();
    await testDb.migrate();
    const db = testDb.db;
    const user = async (name: string, role: "user" | "operator") => {
        const id = randomUUID();
        await db
            .insertInto("user")
            .values({
                id,
                name,
                email: `${name}@example.com`,
                emailVerified: false,
                image: null,
                role,
            })
            .execute();
        await db
            .insertInto("audit_event")
            .values({
                actor: "operator-cli",
                action: "user.provisioned",
                target_type: "user",
                target_id: id,
            })
            .execute();
        return { userId: id, instanceRole: role } as Principal;
    };
    root = await user("root", "operator");
    owner = await user("ann", "user");
    org = (
        await createOrganization(db, root, {
            name: "Acme",
            slug: "acme",
            ownerEmail: "ann@example.com",
        })
    ).id;
    const project = await createProject(db, owner, org, { name: "Site", slug: "site" });
    previewId = (
        await createPreview(
            db,
            owner,
            org,
            project.id,
            { slug: "review" },
            {
                previewDomain: "previews.example.com",
                maxPreviews: 100,
            },
        )
    ).id;
});
afterAll(async () => {
    await testDb.destroy();
});

const fails = (promise: Promise<unknown>) =>
    promise.then(
        () => "ok",
        (e: Error) => `${e.message}`,
    );

describe("the lifecycle schema", () => {
    it("gives existing and new previews no expiry and no deletion time", async () => {
        const row = await testDb.db
            .selectFrom("preview")
            .select(["expires_at", "deleted_at", "desired_state"])
            .where("id", "=", previewId)
            .executeTakeFirstOrThrow();
        expect(row).toEqual({ expires_at: null, deleted_at: null, desired_state: "active" });
    });

    it("ties deleted_at to the deleted state, in both directions", async () => {
        const mark = (set: Record<string, unknown>) =>
            fails(testDb.db.updateTable("preview").set(set).where("id", "=", previewId).execute());
        expect(await mark({ desired_state: "deleted" })).toMatch(
            /preview_deleted_at_matches_state/,
        );
        expect(await mark({ deleted_at: new Date() })).toMatch(/preview_deleted_at_matches_state/);
        expect(await mark({ desired_state: "deleting" })).toBe("ok");
        expect(await mark({ desired_state: "deleted", deleted_at: new Date() })).toBe("ok");
        expect(await mark({ desired_state: "active" })).toMatch(/preview_deleted_at_matches_state/);
    });

    it("allows one unfinished deletion per preview, and a new one once it has finished", async () => {
        const preview = (
            await testDb.db
                .insertInto("preview")
                .values({
                    organization_id: org,
                    project_id: (
                        await testDb.db.selectFrom("project").select("id").executeTakeFirstOrThrow()
                    ).id,
                    slug: "second",
                    app_name: "lp-aaaaaaaaaa",
                    hostname: "second-aaaaaa.previews.example.com",
                    created_by: owner.userId,
                })
                .returning("id")
                .executeTakeFirstOrThrow()
        ).id;
        const queue = (reason: "manual" | "expired" = "manual") =>
            fails(
                testDb.db
                    .insertInto("deletion_operation")
                    .values({
                        organization_id: org,
                        preview_id: preview,
                        reason,
                        requested_by: owner.userId,
                    })
                    .execute(),
            );
        expect(await queue()).toBe("ok");
        expect(await queue()).toMatch(/deletion_one_unfinished_per_preview/);
        for (const status of ["running", "reconciliation-needed"] as const) {
            await testDb.db
                .updateTable("deletion_operation")
                .set({ status })
                .where("preview_id", "=", preview)
                .execute();
            expect(await queue(), status).toMatch(/deletion_one_unfinished_per_preview/);
        }
        await testDb.db
            .updateTable("deletion_operation")
            .set({ status: "succeeded", finished_at: new Date() })
            .where("preview_id", "=", preview)
            .execute();
        expect(await queue("expired")).toBe("ok");
    });

    it("accepts a system (null) requester, and refuses a made-up reason, status or step", async () => {
        const preview = (
            await testDb.db
                .insertInto("preview")
                .values({
                    organization_id: org,
                    project_id: (
                        await testDb.db.selectFrom("project").select("id").executeTakeFirstOrThrow()
                    ).id,
                    slug: "third",
                    app_name: "lp-bbbbbbbbbb",
                    hostname: "third-bbbbbb.previews.example.com",
                    created_by: owner.userId,
                })
                .returning("id")
                .executeTakeFirstOrThrow()
        ).id;
        const insert = (values: Record<string, unknown>) =>
            fails(
                testDb.db
                    .insertInto("deletion_operation")
                    .values({
                        organization_id: org,
                        preview_id: preview,
                        reason: "expired",
                        requested_by: null,
                        ...values,
                    } as never)
                    .execute(),
            );
        expect(await insert({ reason: "because" })).toMatch(/reason/);
        expect(await insert({ status: "done" })).toMatch(/status/);
        expect(await insert({ step_pending: "prune" })).toMatch(/step_pending/);
        expect(await insert({ attempt: -1 })).toMatch(/attempt/);
        expect(await insert({})).toBe("ok");
    });

    it("keeps a deletion inside its own organization", async () => {
        const other = (
            await createOrganization(testDb.db, root, {
                name: "Beta",
                slug: "beta",
                ownerEmail: "ann@example.com",
            })
        ).id;
        expect(
            await fails(
                testDb.db
                    .insertInto("deletion_operation")
                    .values({
                        organization_id: other,
                        preview_id: previewId,
                        reason: "manual",
                        requested_by: null,
                    })
                    .execute(),
            ),
        ).toMatch(/foreign key|violates/);
    });

    it("records a worker heartbeat per worker id, bounded in size", async () => {
        await testDb.db
            .insertInto("worker_heartbeat")
            .values({ worker_id: "w1", version: "0.0.0" })
            .execute();
        expect(
            await fails(
                testDb.db
                    .insertInto("worker_heartbeat")
                    .values({ worker_id: "w1", version: "0.0.0" })
                    .execute(),
            ),
        ).toMatch(/worker_heartbeat/);
        expect(
            await fails(
                testDb.db
                    .insertInto("worker_heartbeat")
                    .values({ worker_id: "", version: "x" })
                    .execute(),
            ),
        ).toMatch(/worker_id/);
        expect(
            await fails(
                testDb.db
                    .insertInto("worker_heartbeat")
                    .values({ worker_id: "w2", version: "v".repeat(65) })
                    .execute(),
            ),
        ).toMatch(/version/);
    });
});
