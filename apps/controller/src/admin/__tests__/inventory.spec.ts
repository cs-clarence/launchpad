import { randomUUID } from "node:crypto";
import { createTestDatabase } from "@launchpad-kit/database/testing";
import { createOrganization, createProject, type Principal } from "@launchpad-kit/services";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inventoryPreviews } from "../inventory";

let source: Awaited<ReturnType<typeof createTestDatabase>>;
let owner: Principal;
let org = "";
let projectId = "";
let artifactId = "";

async function addPreview(slug: string, state: "active" | "deleting" | "deleted" = "active") {
    const id = randomUUID();
    const app = `lp-${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    await source.db
        .insertInto("preview")
        .values({
            id,
            organization_id: org,
            project_id: projectId,
            slug,
            app_name: app,
            hostname: `${slug}-${app.slice(3, 9)}.previews.example.com`,
            created_by: owner.userId,
            desired_state: state,
            deleted_at: state === "deleted" ? sql<Date>`now()` : null,
        })
        .execute();
    return { id, app };
}

async function addDeployment(previewId: string, status: string, imageTag: string | null = null) {
    await source.db
        .insertInto("deployment")
        .values({
            organization_id: org,
            preview_id: previewId,
            artifact_id: artifactId,
            status: status as "succeeded",
            image_tag: imageTag,
            requested_by: owner.userId,
        })
        .execute();
}

beforeEach(async () => {
    source = await createTestDatabase();
    await source.migrate();
    const rootId = randomUUID();
    const ownerId = randomUUID();
    for (const [id, name, role] of [
        [rootId, "root", "operator"],
        [ownerId, "ann", "user"],
    ] as const) {
        await source.db
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
        await source.db
            .insertInto("audit_event")
            .values({
                actor: "operator-cli",
                action: "user.provisioned",
                target_type: "user",
                target_id: id,
            })
            .execute();
    }
    org = (
        await createOrganization(
            source.db,
            { userId: rootId, instanceRole: "operator" },
            { name: "Acme", slug: "acme", ownerEmail: "ann@example.com" },
        )
    ).id;
    owner = { userId: ownerId, instanceRole: "user" };
    projectId = (await createProject(source.db, owner, org, { name: "Site", slug: "site" })).id;
    artifactId = (
        await source.db
            .insertInto("artifact")
            .values({
                organization_id: org,
                digest: "a".repeat(64),
                size_bytes: 10,
                expanded_bytes: 10,
                entry_count: 1,
                storage_key: `artifacts/${"b".repeat(32)}/${"a".repeat(64)}.tar.gz`,
                created_by: owner.userId,
            })
            .returning("id")
            .executeTakeFirstOrThrow()
    ).id;
});

afterEach(async () => {
    await source?.destroy();
});

describe("inventoryPreviews", () => {
    it("is ready to retire when nothing was ever recorded", async () => {
        const empty = await inventoryPreviews(source.db);
        expect(empty).toEqual({ items: [], blocking: [], readyToRetire: true });
    });

    it("lists exactly what is recorded, names what blocks, and changes nothing", async () => {
        const live = await addPreview("live");
        await addDeployment(live.id, "succeeded", "launchpad/site:abc");
        await addDeployment(live.id, "succeeded", "launchpad/site:abc");
        const running = await addPreview("running", "deleting");
        await addDeployment(running.id, "building");
        const held = await addPreview("held", "deleted");
        await addDeployment(held.id, "reconciliation-needed");
        const gone = await addPreview("gone", "deleted");
        await addDeployment(gone.id, "succeeded", "launchpad/site:old");
        await source.db
            .insertInto("deletion_operation")
            .values({
                organization_id: org,
                preview_id: running.id,
                reason: "manual",
                requested_by: owner.userId,
            })
            .execute();

        const before = JSON.stringify(
            await sql`select * from preview order by id`.execute(source.db),
        );
        const inventory = await inventoryPreviews(source.db);
        expect(
            JSON.stringify(await sql`select * from preview order by id`.execute(source.db)),
        ).toBe(before);

        expect(inventory.items).toHaveLength(4);
        expect(inventory.readyToRetire).toBe(false);
        const byApp = (app: string) => inventory.items.find((i) => i.appName === app)!;
        expect(byApp(live.app)).toMatchObject({
            state: "active",
            imageTags: ["launchpad/site:abc"],
            deletion: null,
        });
        expect(byApp(running.app)).toMatchObject({ unfinishedDeployments: 1, deletion: "queued" });
        expect(byApp(held.app)).toMatchObject({ state: "deleted", heldDeployments: 1 });
        expect(byApp(gone.app)).toMatchObject({
            state: "deleted",
            imageTags: ["launchpad/site:old"],
        });
        // A deleted preview with no open work does not block; a held deployment still does.
        expect(inventory.blocking.map((i) => i.appName).toSorted()).toEqual(
            [live.app, running.app, held.app].toSorted(),
        );
    });

    it("becomes ready once every preview is terminally deleted and no work is open", async () => {
        const preview = await addPreview("to-retire");
        await addDeployment(preview.id, "building");
        expect((await inventoryPreviews(source.db)).readyToRetire).toBe(false);
        await source.db.deleteFrom("deletion_operation").execute();
        await source.db
            .deleteFrom("deployment")
            .where("status", "in", ["building", "reconciliation-needed"])
            .execute();
        await source.db
            .updateTable("preview")
            .set({ desired_state: "deleted", deleted_at: sql<Date>`now()` })
            .where("desired_state", "<>", "deleted")
            .execute();
        const inventory = await inventoryPreviews(source.db);
        expect(inventory.readyToRetire).toBe(true);
        expect(inventory.blocking).toEqual([]);
        expect(inventory.items).toHaveLength(1);
    });

    // Hand-built defensive states, not claims about states reachable through the
    // public API. P2 must feed them to migration too; this tests only inventory.
    it.each([
        "queued",
        "preparing",
        "building",
        "deploying",
        "verifying",
        "reconciliation-needed",
    ] as const)("retains a deleted preview with a %s deployment as blocking", async (status) => {
        const preview = await addPreview(`job-${status}`, "deleted");
        await addDeployment(preview.id, status);
        const before = await source.db
            .selectFrom("deployment")
            .selectAll()
            .where("preview_id", "=", preview.id)
            .executeTakeFirstOrThrow();

        const inventory = await inventoryPreviews(source.db);
        expect(inventory.readyToRetire).toBe(false);
        expect(inventory.blocking.find((item) => item.previewId === preview.id)).toMatchObject({
            state: "deleted",
            unfinishedDeployments: status === "reconciliation-needed" ? 0 : 1,
            heldDeployments: status === "reconciliation-needed" ? 1 : 0,
        });
        expect(
            await source.db
                .selectFrom("deployment")
                .selectAll()
                .where("id", "=", before.id)
                .executeTakeFirstOrThrow(),
        ).toEqual(before);
    });

    it.each(["queued", "running", "reconciliation-needed"] as const)(
        "retains a deleted preview with a %s deletion as blocking",
        async (status) => {
            const preview = await addPreview(`delete-${status}`, "deleted");
            await source.db
                .insertInto("deletion_operation")
                .values({
                    organization_id: org,
                    preview_id: preview.id,
                    reason: "manual",
                    status,
                    requested_by: owner.userId,
                })
                .execute();
            const inventory = await inventoryPreviews(source.db);
            expect(inventory.readyToRetire).toBe(false);
            expect(inventory.blocking.find((item) => item.previewId === preview.id)).toMatchObject({
                state: "deleted",
                deletion: status,
            });
            expect(
                await source.db
                    .selectFrom("deletion_operation")
                    .select("status")
                    .where("preview_id", "=", preview.id)
                    .executeTakeFirstOrThrow(),
            ).toEqual({ status });
        },
    );

    it("lists both retired preview identities and images after slug reuse", async () => {
        const older = await addPreview("reused", "deleted");
        const newer = await addPreview("reused", "deleted");
        await addDeployment(older.id, "succeeded", "launchpad/site:retained-old");
        await addDeployment(newer.id, "succeeded", "launchpad/site:retained-new");
        await addDeployment(newer.id, "failed", "launchpad/site:failed-candidate");
        const inventory = await inventoryPreviews(source.db);
        const items = inventory.items.filter((item) => item.slug === "reused");
        expect(items).toHaveLength(2);
        expect(items.map((item) => item.appName).toSorted()).toEqual(
            [older.app, newer.app].toSorted(),
        );
        expect(new Set(items.map((item) => item.hostname)).size).toBe(2);
        expect(items.find((item) => item.previewId === older.id)?.imageTags).toEqual([
            "launchpad/site:retained-old",
        ]);
        expect(items.find((item) => item.previewId === newer.id)?.imageTags).toEqual([
            "launchpad/site:failed-candidate",
            "launchpad/site:retained-new",
        ]);
        expect(
            inventory.blocking.filter(
                (item) => item.previewId === older.id || item.previewId === newer.id,
            ),
        ).toEqual([]);
    });

    it.each(["succeeded", "failed", "cancelled"] as const)(
        "blocks a terminal %s deployment with pending rollback intent",
        async (status) => {
            const preview = await addPreview("rollback-leftover", "deleted");
            await addDeployment(preview.id, status);
            await source.db
                .updateTable("deployment")
                .set({ step_pending: "rollback" })
                .where("preview_id", "=", preview.id)
                .execute();
            const before = await source.db.selectFrom("deployment").selectAll().execute();
            const inventory = await inventoryPreviews(source.db);
            expect(inventory.readyToRetire).toBe(false);
            expect(inventory.blocking.map((item) => item.previewId)).toEqual([preview.id]);
            expect(await source.db.selectFrom("deployment").selectAll().execute()).toEqual(before);
        },
    );

    it.each([
        { lease_owner: "old-worker", lease_expires_at: null },
        { lease_owner: null, lease_expires_at: new Date("2000-01-01T00:00:00Z") },
        { lease_owner: null, lease_expires_at: new Date("2100-01-01T00:00:00Z") },
    ])("blocks a terminal deployment with leftover lease fields: %j", async (lease) => {
        const preview = await addPreview("lease-leftover", "deleted");
        await addDeployment(preview.id, "succeeded");
        await source.db
            .updateTable("deployment")
            .set(lease)
            .where("preview_id", "=", preview.id)
            .execute();
        const before = await source.db.selectFrom("deployment").selectAll().execute();
        const inventory = await inventoryPreviews(source.db);
        expect(inventory.readyToRetire).toBe(false);
        expect(inventory.blocking.map((item) => item.previewId)).toEqual([preview.id]);
        expect(await source.db.selectFrom("deployment").selectAll().execute()).toEqual(before);
    });

    it.each([
        { step_pending: "destroy" as const },
        { step_pending: "images" as const },
        { lease_owner: "old-worker" },
        { lease_expires_at: new Date("2000-01-01T00:00:00Z") },
        { lease_expires_at: new Date("2100-01-01T00:00:00Z") },
    ])("blocks a succeeded deletion with leftover intent or lease: %j", async (leftover) => {
        const preview = await addPreview("deletion-leftover", "deleted");
        await source.db
            .insertInto("deletion_operation")
            .values({
                organization_id: org,
                preview_id: preview.id,
                reason: "manual",
                status: "succeeded",
                ...leftover,
            })
            .execute();
        const before = await source.db.selectFrom("deletion_operation").selectAll().execute();
        const inventory = await inventoryPreviews(source.db);
        expect(inventory.readyToRetire).toBe(false);
        expect(inventory.blocking.map((item) => item.previewId)).toEqual([preview.id]);
        expect(await source.db.selectFrom("deletion_operation").selectAll().execute()).toEqual(
            before,
        );
    });

    it("accepts settled terminal history without clearing historical completed steps", async () => {
        const preview = await addPreview("settled", "deleted");
        for (const status of ["succeeded", "failed", "cancelled"]) {
            await addDeployment(preview.id, status);
        }
        await source.db
            .updateTable("deployment")
            .set({ step_done: "verify" })
            .where("preview_id", "=", preview.id)
            .execute();
        await source.db
            .insertInto("deletion_operation")
            .values({
                organization_id: org,
                preview_id: preview.id,
                reason: "manual",
                status: "succeeded",
                step_done: "images",
            })
            .execute();
        const inventory = await inventoryPreviews(source.db);
        expect(inventory.readyToRetire).toBe(true);
        expect(inventory.blocking).toEqual([]);
    });
});
