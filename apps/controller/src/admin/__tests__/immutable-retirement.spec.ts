import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createTestDatabase } from "@launchpad-kit/database/testing";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Executable P1 specification only. No discovered migration imports this SQL.
// These hand-built states deliberately include damaged terminal records.
const candidate = await readFile(
    new URL("./fixtures/immutable-retirement.sql", import.meta.url),
    "utf8",
);
let source: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
let userId: string;
let organizationId: string;
let projectId: string;
let artifactId: string;
const db = () => source!.db;
const retire = () =>
    db()
        .transaction()
        .execute(async (trx) => {
            await sql.raw(candidate).execute(trx);
        });

beforeEach(async () => {
    source = await createTestDatabase();
    await source.migrate();
    userId = randomUUID();
    organizationId = randomUUID();
    await db()
        .insertInto("user")
        .values({
            id: userId,
            name: "Retirement fixture",
            email: "retirement@example.invalid",
            emailVerified: false,
            role: "user",
        })
        .execute();
    await db()
        .insertInto("organization")
        .values({
            id: organizationId,
            name: "Retirement fixture",
            slug: "retirement",
            createdAt: new Date("2026-01-01T00:00:00Z"),
        })
        .execute();
    projectId = (
        await db()
            .insertInto("project")
            .values({
                organization_id: organizationId,
                name: "Site",
                slug: "site",
                created_by: userId,
            })
            .returning("id")
            .executeTakeFirstOrThrow()
    ).id;
    artifactId = (
        await db()
            .insertInto("artifact")
            .values({
                organization_id: organizationId,
                digest: "a".repeat(64),
                size_bytes: 10,
                expanded_bytes: 10,
                entry_count: 1,
                storage_key: `artifacts/${"b".repeat(32)}/${"a".repeat(64)}.tar.gz`,
                created_by: userId,
            })
            .returning("id")
            .executeTakeFirstOrThrow()
    ).id;
});

afterEach(async () => {
    await source?.destroy();
    source = undefined;
});

async function preview(state: "active" | "deleting" | "deleted" = "deleted", hostname?: string) {
    const app = `lp-${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    return db()
        .insertInto("preview")
        .values({
            organization_id: organizationId,
            project_id: projectId,
            slug: "reusable",
            app_name: app,
            hostname: hostname ?? `${app}.legacy.example.net`,
            created_by: userId,
            desired_state: state,
            deleted_at: state === "deleted" ? new Date("2026-01-02T00:00:00Z") : null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
}

async function deployment(previewId: string, status = "succeeded") {
    return db()
        .insertInto("deployment")
        .values({
            organization_id: organizationId,
            preview_id: previewId,
            artifact_id: artifactId,
            status: status as "succeeded",
            image_tag: `launchpad/site:${randomUUID()}`,
            requested_by: userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
}

async function key(scopes: string[], revokedAt: Date | null = null) {
    return db()
        .insertInto("api_key")
        .values({
            organization_id: organizationId,
            created_by: userId,
            member_id: null,
            name: "Synthetic key",
            prefix: "fixture",
            secret_hash: randomUUID().replaceAll("-", "").padEnd(64, "0"),
            scopes,
            project_ids: [projectId],
            expires_at: new Date("2100-01-01T00:00:00Z"),
            revoked_at: revokedAt,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
}

async function snapshot() {
    // Include schema shape and all data this segment may change, so refusal is
    // tested for transactionality rather than only a nonzero/error result.
    const data = await sql`
        select jsonb_build_object(
            'previews', (select jsonb_agg(to_jsonb(p) order by id) from preview p),
            'deployments', (select jsonb_agg(to_jsonb(d) order by id) from deployment d),
            'events', (select jsonb_agg(to_jsonb(e) order by id) from deployment_event e),
            'deletions', (select jsonb_agg(to_jsonb(d) order by id) from deletion_operation d),
            'keys', (select jsonb_agg(to_jsonb(k) order by id) from api_key k),
            'audit', (select jsonb_agg(to_jsonb(a) order by id) from audit_event a),
            'state', (select jsonb_agg(to_jsonb(s) order by key) from instance_state s),
            'migrations', (select jsonb_agg(to_jsonb(m) order by name) from launchpad_migration m)
        ) as data`.execute(db());
    const schema = await sql`
        select c.relname, c.relkind, a.attname, a.attidentity
        from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        left join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum > 0
        where n.nspname = 'public'
        order by c.relname, a.attnum`.execute(db());
    const constraints = await sql`
        select conrelid::regclass::text as owner, conname, pg_get_constraintdef(oid) as definition
        from pg_catalog.pg_constraint
        where connamespace = 'public'::regnamespace
        order by owner, conname`.execute(db());
    return { data: data.rows, schema: schema.rows, constraints: constraints.rows };
}

async function refusesWithoutMutation(message: RegExp) {
    await key(["preview:deploy", "project:read"]);
    const before = await snapshot();
    await expect(retire()).rejects.toThrow(message);
    expect(await snapshot()).toEqual(before);
}

describe("immutable retirement SQL candidate (not migration 018)", () => {
    it("runs on the candidate's currently supported PostgreSQL major (17)", async () => {
        const result = await sql<{ major: number }>`
            select current_setting('server_version_num')::int / 10000 as major
        `.execute(db());
        // Extend this matrix only after actually exercising another major.
        // Filtering NOT NULL catalog entries does not establish PG18 support.
        expect(result.rows).toEqual([{ major: 17 }]);
    });

    it("accepts the empty baseline without claiming the immutable migration was applied", async () => {
        await retire();
        const result = await sql<{ count: number; floor: boolean; old: string | null }>`
            select count(*)::int as count,
                bool_or(name = '20261119_018_immutable_deployment_model') as floor,
                to_regclass('public.preview')::text as old
            from launchpad_migration`.execute(db());
        expect(result.rows).toEqual([{ count: 17, floor: false, old: null }]);
    });

    it("preserves every retired row, identity, reference and event sequence across slug reuse", async () => {
        const first = await preview();
        const second = await preview();
        const oldRelease = await deployment(first.id);
        const newRelease = await deployment(second.id);
        await deployment(second.id, "failed");
        await db()
            .updateTable("preview")
            .set({ active_deployment_id: oldRelease.id })
            .where("id", "=", first.id)
            .execute();
        await db()
            .updateTable("preview")
            .set({ active_deployment_id: newRelease.id })
            .where("id", "=", second.id)
            .execute();
        const event = await db()
            .insertInto("deployment_event")
            .values({
                organization_id: organizationId,
                deployment_id: oldRelease.id,
                seq: 1,
                phase: "verify",
                level: "info",
                message: "Verified",
            })
            .returningAll()
            .executeTakeFirstOrThrow();
        await db()
            .insertInto("deletion_operation")
            .values({
                organization_id: organizationId,
                preview_id: first.id,
                reason: "manual",
                status: "succeeded",
                attempt: 2,
                fence: 3,
                step_done: "images",
            })
            .execute();
        const expected = {
            previews: await db().selectFrom("preview").selectAll().orderBy("id").execute(),
            deployments: await db().selectFrom("deployment").selectAll().orderBy("id").execute(),
            events: await db().selectFrom("deployment_event").selectAll().orderBy("id").execute(),
            deletions: await db()
                .selectFrom("deletion_operation")
                .selectAll()
                .orderBy("id")
                .execute(),
            artifacts: await db().selectFrom("artifact").selectAll().orderBy("id").execute(),
        };

        await retire();
        expect((await sql`select * from legacy_preview order by id`.execute(db())).rows).toEqual(
            expected.previews,
        );
        expect((await sql`select * from legacy_deployment order by id`.execute(db())).rows).toEqual(
            expected.deployments,
        );
        expect(
            (await sql`select * from legacy_deployment_event order by id`.execute(db())).rows,
        ).toEqual(expected.events);
        expect(
            (await sql`select * from legacy_deletion_operation order by id`.execute(db())).rows,
        ).toEqual(expected.deletions);
        expect(await db().selectFrom("artifact").selectAll().orderBy("id").execute()).toEqual(
            expected.artifacts,
        );
        const next = await sql<{ id: string }>`
            insert into legacy_deployment_event
                (organization_id, deployment_id, seq, phase, message)
            values (${organizationId}, ${oldRelease.id}, 2, 'history', 'History preserved')
            returning id`.execute(db());
        expect(BigInt(next.rows[0]!.id)).toBeGreaterThan(BigInt(event.id));
        expect(
            (
                await sql<{ sequence: string }>`
                    select pg_get_serial_sequence('public.legacy_deployment_event', 'id') as sequence
                `.execute(db())
            ).rows,
        ).toEqual([{ sequence: "public.legacy_deployment_event_id_seq" }]);
        // The old mutable vocabulary has no compatibility view or table.
        const names = await sql<{ old: string | null }>`
            select to_regclass(name)::text as old from unnest(array[
                'public.preview', 'public.deployment',
                'public.deployment_event', 'public.deletion_operation'
            ]) as names(name)`.execute(db());
        expect(names.rows).toEqual(Array.from({ length: 4 }, () => ({ old: null })));
        const foreignKeys = await sql<{ target: string }>`
            select confrelid::regclass::text as target
            from pg_constraint
            where conrelid = 'legacy_preview'::regclass
              and conname = 'legacy_preview_organization_id_id_active_deployment_id_fkey'
        `.execute(db());
        expect(foreignKeys.rows).toEqual([{ target: "legacy_deployment" }]);
    });

    it.each(["active", "deleting"] as const)("refuses a %s preview atomically", async (state) => {
        await preview(state);
        await refusesWithoutMutation(/not settled/);
    });

    it.each(["queued", "preparing", "building", "deploying", "verifying", "reconciliation-needed"])(
        "refuses a %s deployment even when the preview is deleted",
        async (status) => {
            await deployment((await preview()).id, status);
            await refusesWithoutMutation(/not settled/);
        },
    );

    it.each(["queued", "running", "reconciliation-needed"] as const)(
        "refuses a %s deletion even when the preview is deleted",
        async (status) => {
            await db()
                .insertInto("deletion_operation")
                .values({
                    organization_id: organizationId,
                    preview_id: (await preview()).id,
                    reason: "manual",
                    status,
                })
                .execute();
            await refusesWithoutMutation(/not settled/);
        },
    );

    it.each(["succeeded", "failed", "cancelled"])(
        "refuses pending rollback on a %s deployment",
        async (status) => {
            const job = await deployment((await preview()).id, status);
            await db()
                .updateTable("deployment")
                .set({ step_pending: "rollback" })
                .where("id", "=", job.id)
                .execute();
            await refusesWithoutMutation(/not settled/);
        },
    );

    it.each([
        { lease_owner: "old-worker", lease_expires_at: null },
        { lease_owner: null, lease_expires_at: new Date("2000-01-01T00:00:00Z") },
        { lease_owner: null, lease_expires_at: new Date("2100-01-01T00:00:00Z") },
    ])("refuses any leftover deployment lease field: %j", async (lease) => {
        const job = await deployment((await preview()).id);
        await db().updateTable("deployment").set(lease).where("id", "=", job.id).execute();
        await refusesWithoutMutation(/not settled/);
    });

    it.each([
        { step_pending: "destroy" as const },
        { step_pending: "images" as const },
        { lease_owner: "old-worker" },
        { lease_expires_at: new Date("2000-01-01T00:00:00Z") },
        { lease_expires_at: new Date("2100-01-01T00:00:00Z") },
    ])("refuses leftover intent/lease on a succeeded deletion: %j", async (leftover) => {
        await db()
            .insertInto("deletion_operation")
            .values({
                organization_id: organizationId,
                preview_id: (await preview()).id,
                reason: "manual",
                status: "succeeded",
                ...leftover,
            })
            .execute();
        await refusesWithoutMutation(/not settled/);
    });

    it.each([
        "UPPER.legacy.example.net",
        "a..legacy.example.net",
        "a.legacy.example.net.",
        `${"a".repeat(64)}.legacy.example.net`,
        "ü.legacy.example.net",
        "localhost",
    ])("refuses noncanonical legacy hostname %s without rewriting it", async (hostname) => {
        await preview("deleted", hostname);
        await refusesWithoutMutation(/hostname history/);
    });

    it("refuses case-colliding deleted history instead of merging reservations", async () => {
        await preview("deleted", "a.legacy.example.net");
        await preview("deleted", "A.legacy.example.net");
        await refusesWithoutMutation(/hostname history/);
    });

    it.each(["lp-abc", "lp-ABCDEFGHIJ", "other-app", "lp-1234567890/extra"])(
        "refuses invalid Dokku name %s even when its named check was weakened",
        async (name) => {
            const owner = await preview();
            // Simulate out-of-band schema damage without changing the expected
            // constraint name. Name inventory alone cannot prove definitions.
            await sql`alter table preview drop constraint preview_app_name_check`.execute(db());
            await sql`
                alter table preview add constraint preview_app_name_check check (true)
            `.execute(db());
            await db()
                .updateTable("preview")
                .set({ app_name: name })
                .where("id", "=", owner.id)
                .execute();
            await refusesWithoutMutation(/legacy Dokku app name history is invalid/);
        },
    );

    it("refuses an unreviewed constraint", async () => {
        await sql`alter table preview add constraint unreviewed check (length(slug) > 0)`.execute(
            db(),
        );
        await refusesWithoutMutation(/constraint inventory/);
    });

    it("refuses an unreviewed index", async () => {
        await sql`create index unreviewed on preview (created_at)`.execute(db());
        await refusesWithoutMutation(/index, trigger or identity inventory/);
    });

    it("refuses an unreviewed trigger", async () => {
        await sql`
            create function public.fixture_trigger() returns trigger
            language plpgsql as $body$ begin return new; end $body$
        `.execute(db());
        await sql`
            create trigger unreviewed before update on preview
            for each row execute function public.fixture_trigger()
        `.execute(db());
        await refusesWithoutMutation(/index, trigger or identity inventory/);
    });

    it("refuses an unexpectedly named identity sequence", async () => {
        await sql`alter sequence deployment_event_id_seq rename to unexpected_sequence`.execute(
            db(),
        );
        await refusesWithoutMutation(/index, trigger or identity inventory/);
    });

    it("rolls back earlier renames if a later target name is already occupied", async () => {
        await preview();
        await sql`create table legacy_deployment (id uuid primary key)`.execute(db());
        await refusesWithoutMutation(/relation "legacy_deployment" already exists/);
        const restored = await sql<{ name: string | null }>`
            select to_regclass('public.preview')::text as name
        `.execute(db());
        expect(restored.rows).toEqual([{ name: "preview" }]);
    });

    it("refuses an incomplete migration baseline", async () => {
        await sql`
            delete from launchpad_migration
            where name = '20261116_017_worker_heartbeat_lifecycle'
        `.execute(db());
        await refusesWithoutMutation(/schema-017 baseline/);
    });

    it("revokes exact legacy prefixes, preserves unrelated keys/sessions and audits only counts", async () => {
        const legacy = await key(["preview:read"]);
        const mixed = await key(["project:read", "preview:deploy"]);
        const unknownLegacy = await key(["preview:not-a-known-scope"]);
        const priorTime = new Date("2026-01-01T00:00:00Z");
        const already = await key(["preview:delete"], priorTime);
        const unrelated = await key(["project:read"]);
        const nearPrefix = await key(["previewish:read"]);
        const caseVariant = await key(["Preview:read"]);
        // SessionTable is intentionally a minimal service-facing projection;
        // the frozen auth schema, not that projection, owns these insert fields.
        await sql`
            insert into "session" (id, "userId", token, "expiresAt", "updatedAt")
            values (${randomUUID()}, ${userId}, 'synthetic-session-fixture',
                ${new Date("2100-01-01T00:00:00Z")}, ${priorTime})
        `.execute(db());
        const sessions = await db().selectFrom("session").selectAll().execute();
        await retire();
        const keys = await db().selectFrom("api_key").selectAll().execute();
        for (const id of [legacy.id, mixed.id, unknownLegacy.id]) {
            expect(keys.find((entry) => entry.id === id)?.revoked_at).toBeInstanceOf(Date);
        }
        expect(keys.find((entry) => entry.id === already.id)).toEqual(already);
        for (const original of [unrelated, nearPrefix, caseVariant]) {
            expect(keys.find((entry) => entry.id === original.id)).toEqual(original);
        }
        expect(await db().selectFrom("session").selectAll().execute()).toEqual(sessions);
        const audit = await db()
            .selectFrom("audit_event")
            .select(["action", "target_type", "target_id", "detail"])
            .execute();
        expect(audit).toEqual([
            {
                action: "schema.immutable.preview-keys-revoked",
                target_type: "instance",
                target_id: "immutable-deployment-model",
                detail: expect.any(String),
            },
        ]);
        expect(JSON.parse(audit[0]!.detail!)).toEqual({ affected: 4, newlyRevoked: 3 });
        expect(audit[0]!.detail).not.toContain(legacy.secret_hash);
    });

    it("rolls back table/object renames, revocation and audit if a later cutover segment fails", async () => {
        await preview();
        await key(["preview:deploy"]);
        const before = await snapshot();
        await expect(
            db()
                .transaction()
                .execute(async (trx) => {
                    await sql.raw(candidate).execute(trx);
                    throw new Error("later segment refused");
                }),
        ).rejects.toThrow("later segment refused");
        expect(await snapshot()).toEqual(before);
        // A failed attempt did not consume the ability to retire later.
        await retire();
    });

    it("refuses a second application without duplicating its audit", async () => {
        await retire();
        const before = await db().selectFrom("audit_event").selectAll().execute();
        await expect(retire()).rejects.toThrow('relation "public.preview" does not exist');
        expect(await db().selectFrom("audit_event").selectAll().execute()).toEqual(before);
    });
});
