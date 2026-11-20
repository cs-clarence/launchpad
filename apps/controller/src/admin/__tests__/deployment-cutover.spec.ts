import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertSchemaCurrent, migrationStatus } from "@launchpad-kit/database";
import { createTestDatabase } from "@launchpad-kit/database/testing";
import { type Kysely, sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

const BEFORE_018 = "20261116_017_worker_heartbeat_lifecycle";
const resources = [
    "app",
    "deployment",
    "app_deployment_event",
    "app_alias",
    "promotion_operation",
    "deployment_deletion_operation",
    "hostname_reservation",
    "dokku_name_reservation",
] as const;
let source: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
afterEach(async () => {
    await source?.destroy();
    source = undefined;
});

async function seed(before = BEFORE_018) {
    source = await createTestDatabase();
    await source.migrateTo(before);
    // Historical fixture writes deliberately do not use the current Database table map.
    const db: Kysely<any> = source.db;
    const actor = randomUUID();
    const org = randomUUID();
    await db
        .insertInto("user")
        .values({
            id: actor,
            name: "Cutover",
            email: "cutover@example.invalid",
            emailVerified: false,
            role: "operator",
        })
        .execute();
    await db
        .insertInto("organization")
        .values({
            id: org,
            name: "Cutover",
            slug: "cutover",
            createdAt: new Date(),
        })
        .execute();
    const project = await db
        .insertInto("project")
        .values({
            organization_id: org,
            slug: "site",
            name: "Site",
            created_by: actor,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
    const artifact = await db
        .insertInto("artifact")
        .values({
            organization_id: org,
            created_by: actor,
            digest: "a".repeat(64),
            storage_key: "fixture",
            size_bytes: 10,
            expanded_bytes: 10,
            entry_count: 1,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
    for (const state of ["active", "deleting", "deleted"] as const) {
        const name = `lp-${randomUUID().replaceAll("-", "").slice(0, 10)}`;
        const preview = await db
            .insertInto("preview")
            .values({
                organization_id: org,
                project_id: project.id,
                slug: state,
                app_name: name,
                hostname: `${name}.old.example.net`,
                created_by: actor,
                desired_state: state,
                deleted_at: state === "deleted" ? new Date() : null,
            })
            .returning("id")
            .executeTakeFirstOrThrow();
        const deployment = await db
            .insertInto("deployment")
            .values({
                organization_id: org,
                preview_id: preview.id,
                artifact_id: artifact.id,
                requested_by: actor,
                status: "reconciliation-needed",
                step_pending: "rollback",
            })
            .returning("id")
            .executeTakeFirstOrThrow();
        await db
            .updateTable("preview")
            .set({ active_deployment_id: deployment.id })
            .where("id", "=", preview.id)
            .execute();
        await db
            .insertInto("deployment_event")
            .values({
                organization_id: org,
                deployment_id: deployment.id,
                seq: 1,
                phase: "verify",
                level: "warn",
                message: "Held",
            })
            .execute();
    }
    await db
        .insertInto("worker_heartbeat")
        .values({
            worker_id: "old-worker",
            version: "old",
        })
        .execute();
    await db
        .insertInto("idempotency_key")
        .values({
            organization_id: org,
            principal: actor,
            endpoint: "preview:create",
            key: "old",
            request_hash: "old",
            resource_id: null,
            expires_at: new Date(Date.now() + 60_000),
        })
        .execute();
    await sql`insert into session (id, "userId", "expiresAt", token, "updatedAt")
        values ('preserved-session', ${actor}, now() + interval '1 hour',
            ${randomUUID()}, now())`.execute(db);
    return { db, actor, org };
}

describe("migration 018 destructive replacement", () => {
    it("rejects the 018 schema against an older binary's 017 migration manifest", async () => {
        const { db } = await seed();
        await source!.migrate();
        const folder = await fs.mkdtemp(path.join(os.tmpdir(), "lp-old-manifest-"));
        try {
            const status = await migrationStatus(db);
            for (const name of status.applied.filter((name) => !name.includes("_018_"))) {
                // Startup status loads names only, just as the old bundled binary did.
                await fs.writeFile(
                    path.join(folder, `${name}.mjs`),
                    "export async function up() {}",
                );
            }
            await expect(assertSchemaCurrent(db, folder)).rejects.toThrow(/newer Launchpad/);
        } finally {
            await fs.rm(folder, { recursive: true, force: true });
        }
    });
    it.each(["20261116_014_deletion_fence", BEFORE_018])(
        "replaces populated schema %s without retaining any preview identity",
        async (before) => {
            const { db } = await seed(before);
            const oldDeployment = await sql<{ oid: number }>`
                select 'public.deployment'::regclass::oid as oid`.execute(db);
            if (before === BEFORE_018) {
                await db
                    .insertInto("instance_state")
                    .values({
                        key: "lifecycle.enabled_at",
                        value: new Date().toISOString(),
                    })
                    .execute();
            }
            await source!.migrate();
            const tables = await sql<{ name: string }>`
                select tablename as name from pg_tables where schemaname = 'public'
            `.execute(db);
            const names = tables.rows.map((row) => row.name);
            for (const old of [
                "preview",
                "deployment_event",
                "deletion_operation",
                "worker_heartbeat",
            ]) {
                expect(names).not.toContain(old);
            }
            // The name is reused, not the preview-era table or its rows/shape.
            const newDeployment = await sql<{ oid: number }>`
                select 'public.deployment'::regclass::oid as oid`.execute(db);
            expect(newDeployment.rows[0]!.oid).not.toBe(oldDeployment.rows[0]!.oid);
            const deploymentColumns = await sql<{ name: string }>`
                select column_name as name from information_schema.columns
                where table_schema = 'public' and table_name = 'deployment'`.execute(db);
            expect(deploymentColumns.rows.map((row) => row.name)).toContain("app_id");
            expect(deploymentColumns.rows.map((row) => row.name)).not.toContain("preview_id");
            expect(names.some((name) => name.startsWith("legacy_"))).toBe(false);
            for (const table of resources) {
                expect((await sql.raw(`select * from ${table}`).execute(db)).rows).toEqual([]);
            }
            expect(await db.selectFrom("idempotency_key").selectAll().execute()).toEqual([]);
            expect(
                await db.selectFrom("instance_state").select(["key", "value"]).execute(),
            ).toEqual([{ key: "deployment_recovery", value: "ready" }]);
            expect(await db.selectFrom("session").select("id").execute()).toEqual([
                { id: "preserved-session" },
            ]);
            expect(await db.selectFrom("artifact").select("id").execute()).toHaveLength(1);
        },
    );

    it("revokes exact preview prefixes and audits only counts, not credentials or names", async () => {
        const { db, actor, org } = await seed();
        const prior = new Date("2026-01-01T00:00:00Z");
        const inputs = [
            ["preview:read"],
            ["project:read", "preview:deploy"],
            ["preview:unknown"],
            ["Preview:read"],
            ["other:preview:read"],
            ["project:read"],
            ["preview:delete"],
        ];
        const keys: { id: string }[] = [];
        for (const [index, scopes] of inputs.entries()) {
            keys.push(
                await db
                    .insertInto("api_key")
                    .values({
                        organization_id: org,
                        created_by: actor,
                        member_id: null,
                        name: `private-name-${index}`,
                        prefix: "lp_private",
                        secret_hash: randomUUID(),
                        scopes,
                        project_ids: null,
                        expires_at: new Date("2100-01-01T00:00:00Z"),
                        revoked_at: index === 6 ? prior : null,
                    })
                    .returning("id")
                    .executeTakeFirstOrThrow(),
            );
        }
        await source!.migrate();
        const rows = await db.selectFrom("api_key").select(["id", "revoked_at"]).execute();
        for (let index = 0; index < keys.length; index++) {
            const row = rows.find((row) => row.id === keys[index]!.id)!;
            if (index < 3) expect(row.revoked_at).toBeInstanceOf(Date);
            else if (index === 6) expect(row.revoked_at).toEqual(prior);
            else expect(row.revoked_at).toBeNull();
        }
        const audit = await db
            .selectFrom("audit_event")
            .select(["actor", "action", "target_type", "target_id", "organization_id", "detail"])
            .execute();
        expect(audit).toEqual([
            {
                actor: "system",
                action: "deployment.cutover",
                target_type: "instance",
                target_id: "self",
                organization_id: null,
                detail: "revoked_keys=3",
            },
        ]);
    });

    it("refuses unexpected dependents without CASCADE and rolls back every change", async () => {
        const { db } = await seed();
        await sql`create view unexpected_preview_reader as select id from preview`.execute(db);
        await expect(source!.migrate()).rejects.toThrow(/depend/);
        expect(await db.selectFrom("preview").select("id").execute()).toHaveLength(3);
        expect(await db.selectFrom("idempotency_key").select("key").execute()).toHaveLength(1);
        expect((await sql`select to_regclass('public.app') as name`.execute(db)).rows).toEqual([
            { name: null },
        ]);
        expect(
            (await sql`select name from launchpad_migration where name like '%_018_%'`.execute(db))
                .rows,
        ).toEqual([]);
        expect(await db.selectFrom("audit_event").selectAll().execute()).toEqual([]);
    });

    it("fails a conflicting table lock within the migration bound and leaves 017 intact", async () => {
        const { db } = await seed();
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        let locked!: () => void;
        const ready = new Promise<void>((resolve) => {
            locked = resolve;
        });
        const blocker = db.transaction().execute(async (trx) => {
            await sql`lock table preview in access share mode`.execute(trx);
            locked();
            await held;
        });
        try {
            await ready;
            await expect(source!.migrate()).rejects.toThrow(/lock timeout/);
        } finally {
            release();
            await blocker;
        }
        expect(await db.selectFrom("preview").select("id").execute()).toHaveLength(3);
        expect((await sql`select to_regclass('public.app') as name`.execute(db)).rows).toEqual([
            { name: null },
        ]);
    });
});
