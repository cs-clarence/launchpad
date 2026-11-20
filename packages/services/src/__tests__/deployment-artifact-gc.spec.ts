import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDatabase } from "@launchpad-kit/database/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { artifactStorageKey, resolveArtifactPath } from "../artifacts";
import { collectArtifacts, sweepOrphanArtifactFiles } from "../artifact-gc";
import { markDeploymentRecoveryBlocked } from "../deployment-recovery";

let source: Awaited<ReturnType<typeof createTestDatabase>>;
let dataDir: string;
let actor: string;
let org: string;
let app: string;
beforeEach(async () => {
    source = await createTestDatabase();
    await source.migrate();
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lp-model-gc-"));
    actor = randomUUID();
    org = randomUUID();
    await source.db
        .insertInto("user")
        .values({
            id: actor,
            name: "Owner",
            email: "gc@example.invalid",
            emailVerified: false,
            role: "user",
        })
        .execute();
    await source.db
        .insertInto("organization")
        .values({
            id: org,
            name: "GC",
            slug: "gc",
            createdAt: new Date(),
        })
        .execute();
    const project = await source.db
        .insertInto("project")
        .values({
            organization_id: org,
            created_by: actor,
            slug: "site",
            name: "Site",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
    app = (
        await source.db
            .insertInto("app")
            .values({
                organization_id: org,
                project_id: project.id,
                slug: "site",
                created_by: actor,
            })
            .returning("id")
            .executeTakeFirstOrThrow()
    ).id;
});
afterEach(async () => {
    await source?.destroy();
    if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
});

async function artifact() {
    const content = Buffer.from("archive-fixture");
    const digest = createHash("sha256").update(content).digest("hex");
    const storageKey = artifactStorageKey(org, digest);
    const file = resolveArtifactPath(dataDir, storageKey);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, content);
    const row = await source.db
        .insertInto("artifact")
        .values({
            organization_id: org,
            created_by: actor,
            digest,
            storage_key: storageKey,
            size_bytes: content.length,
            expanded_bytes: content.length,
            entry_count: 1,
            created_at: new Date(Date.now() - 86400000 * 3),
        })
        .returning("id")
        .executeTakeFirstOrThrow();
    return { id: row.id, file };
}

async function pin(
    artifactId: string,
    state: "active" | "deleted",
    status: "succeeded" | "reconciliation-needed",
    recent: boolean,
) {
    const id = randomUUID();
    const appName = `lp-${id.replaceAll("-", "").slice(0, 10)}`;
    const hostname = `${appName}.apps.example.net`;
    await source.db.transaction().execute(async (trx) => {
        await trx
            .insertInto("deployment")
            .values({
                id,
                organization_id: org,
                app_id: app,
                artifact_id: artifactId,
                hostname,
                app_name: appName,
                requested_by: actor,
                status,
                desired_state: state,
                image_tag: `launchpad/site:${id}`,
                image_id: `sha256:${"a".repeat(64)}`,
                finished_at: status === "succeeded" ? new Date() : null,
                preview_expires_at: new Date(Date.now() + 86400000),
                deleted_at:
                    state === "deleted" ? new Date(Date.now() - (recent ? 1000 : 86400000)) : null,
            })
            .execute();
        await trx
            .insertInto("hostname_reservation")
            .values({
                hostname,
                owner_kind: "deployment",
                owner_id: id,
                organization_id: org,
            })
            .execute();
        await trx
            .insertInto("dokku_name_reservation")
            .values({
                app_name: appName,
                owner_kind: "deployment",
                owner_id: id,
                organization_id: org,
            })
            .execute();
    });
}

describe("deployment artifact pins", () => {
    it.each([
        ["active", "succeeded", false, false],
        ["deleted", "reconciliation-needed", false, false],
        ["deleted", "succeeded", true, false],
        ["deleted", "succeeded", false, true],
    ] as const)(
        "applies state=%s, status=%s, recent=%s retention",
        async (state, status, recent, eligible) => {
            const row = await artifact();
            await pin(row.id, state, status, recent);
            const result = await collectArtifacts(source.db, { dataDir, retentionSeconds: 3600 });
            expect(result.collected).toEqual(eligible ? [row.id] : []);
            const stored = await source.db
                .selectFrom("artifact")
                .select("collected_at")
                .where("id", "=", row.id)
                .executeTakeFirstOrThrow();
            expect(stored.collected_at !== null).toBe(eligible);
            if (eligible) await expect(fs.stat(row.file)).rejects.toMatchObject({ code: "ENOENT" });
            else expect((await fs.stat(row.file)).isFile()).toBe(true);
        },
    );

    it("collects an old unreferenced upload without any legacy table", async () => {
        const row = await artifact();
        expect(
            (await collectArtifacts(source.db, { dataDir, retentionSeconds: 3600 })).collected,
        ).toEqual([row.id]);
    });

    it("refuses collection and sweep before any filesystem/database mutation while recovery is blocked", async () => {
        const row = await artifact();
        await markDeploymentRecoveryBlocked(dataDir);
        await expect(collectArtifacts(source.db, { dataDir, retentionSeconds: 0 })).rejects.toThrow(
            /blocked/,
        );
        await expect(
            sweepOrphanArtifactFiles(source.db, { dataDir, retentionSeconds: 0 }),
        ).rejects.toThrow(/blocked/);
        expect((await fs.stat(row.file)).isFile()).toBe(true);
        expect(
            (
                await source.db
                    .selectFrom("artifact")
                    .select("collected_at")
                    .where("id", "=", row.id)
                    .executeTakeFirstOrThrow()
            ).collected_at,
        ).toBeNull();
    });
});
