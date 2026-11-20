import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Database } from "@launchpad-kit/database";
import { createTestDatabase } from "@launchpad-kit/database/testing";
import { type Kysely, sql } from "kysely";
import { FileMigrationProvider } from "kysely/migration";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type Db = Kysely<Database>;
// Load the real discovered migration, without importing another package's source
// into the controller's TypeScript root or keeping a second SQL fixture.
const migrations = await new FileMigrationProvider({
    fs,
    path,
    migrationFolder: path.resolve(
        import.meta.dirname,
        "../../../../../packages/database/src/migrations",
    ),
}).getMigrations();
const cutover = migrations["20261119_018_deployment_model"]!.up;
interface Tenant {
    org: string;
    project: string;
    artifact: string;
}
interface App extends Tenant {
    id: string;
}
let source: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
let actor: string;
let a: Tenant;
let b: Tenant;
const db = () => source!.db;
const token = () => randomUUID().replaceAll("-", "").slice(0, 10);

async function tenant(slug: string): Promise<Tenant> {
    const org = randomUUID();
    await db()
        .insertInto("organization")
        .values({
            id: org,
            name: slug,
            slug,
            createdAt: new Date("2026-01-01T00:00:00Z"),
        })
        .execute();
    const project = await db()
        .insertInto("project")
        .values({
            organization_id: org,
            slug: "site",
            name: "Site",
            created_by: actor,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
    const artifact = await db()
        .insertInto("artifact")
        .values({
            organization_id: org,
            digest: "a".repeat(64),
            size_bytes: 10,
            expanded_bytes: 10,
            entry_count: 1,
            storage_key: `fixture-${org}`,
            created_by: actor,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
    return { org, project: project.id, artifact: artifact.id };
}

beforeEach(async () => {
    source = await createTestDatabase();
    await source.migrate();
    actor = randomUUID();
    await db()
        .insertInto("user")
        .values({
            id: actor,
            name: "Model fixture",
            email: "model@example.invalid",
            emailVerified: false,
            role: "user",
        })
        .execute();
    a = await tenant("org-a");
    b = await tenant("org-b");
});

afterEach(async () => {
    await source?.destroy();
    source = undefined;
});

async function app(owner = a, slug = `site-${token()}`, connection: Db = db()): Promise<App> {
    const id = randomUUID();
    await sql`insert into app (id, organization_id, project_id, slug, created_by)
        values (${id}, ${owner.org}, ${owner.project}, ${slug}, ${actor})`.execute(connection);
    return { ...owner, id };
}

async function hostReservation(
    connection: Db,
    kind: string,
    id: string,
    org: string,
    hostname: string,
) {
    await sql`insert into hostname_reservation (hostname, owner_kind, owner_id, organization_id)
        values (${hostname}, ${kind}, ${id}, ${org})`.execute(connection);
}

async function nameReservation(
    connection: Db,
    kind: string,
    id: string,
    org: string,
    name: string,
) {
    await sql`insert into dokku_name_reservation (app_name, owner_kind, owner_id, organization_id)
        values (${name}, ${kind}, ${id}, ${org})`.execute(connection);
}

async function deployment(
    connection: Db,
    parent: App,
    options: {
        hostname?: string;
        name?: string;
        status?: string;
        artifact?: string;
        omitHost?: boolean;
        omitName?: boolean;
        reservationsFirst?: boolean;
    } = {},
) {
    const id = randomUUID();
    const hostname = options.hostname ?? `d-${token()}.apps.example.net`;
    const name = options.name ?? `lp-${token()}`;
    const status = options.status ?? "succeeded";
    const reserve = async () => {
        if (!options.omitHost)
            await hostReservation(connection, "deployment", id, parent.org, hostname);
        if (!options.omitName)
            await nameReservation(connection, "deployment", id, parent.org, name);
    };
    if (options.reservationsFirst) await reserve();
    await sql`insert into deployment
        (id, organization_id, app_id, artifact_id, hostname, app_name, status,
         image_tag, image_id, finished_at, requested_by, preview_expires_at)
        values (${id}, ${parent.org}, ${parent.id}, ${options.artifact ?? parent.artifact},
            ${hostname}, ${name}, ${status}, ${`launchpad/site:${id}`}, ${`sha256:${"a".repeat(64)}`},
            ${status === "succeeded" ? new Date("2026-01-03T00:00:00Z") : null},
            ${actor}, ${new Date("2026-01-10T00:00:00Z")})`.execute(connection);
    if (!options.reservationsFirst) await reserve();
    return { id, hostname, name };
}

async function alias(
    connection: Db,
    parent: App,
    options: {
        hostname?: string;
        slug?: string;
        omitHost?: boolean;
        reservationsFirst?: boolean;
    } = {},
) {
    const id = randomUUID();
    const hostname = options.hostname ?? `a-${token()}.apps.example.net`;
    const reserve = () => hostReservation(connection, "alias", id, parent.org, hostname);
    if (!options.omitHost && options.reservationsFirst) await reserve();
    await sql`insert into app_alias (id, organization_id, app_id, slug, hostname, created_by)
        values (${id}, ${parent.org}, ${parent.id}, ${options.slug ?? `alias-${token()}`},
            ${hostname}, ${actor})`.execute(connection);
    if (!options.omitHost && !options.reservationsFirst) await reserve();
    return { id, hostname };
}

const allocateDeployment = (parent: App, options: Parameters<typeof deployment>[2] = {}) =>
    db()
        .transaction()
        .execute((trx) => deployment(trx, parent, options));
const allocateAlias = (parent: App, options: Parameters<typeof alias>[2] = {}) =>
    db()
        .transaction()
        .execute((trx) => alias(trx, parent, options));

async function promotion(
    connection: Db,
    parent: App,
    aliasId: string,
    target: string | null,
    options: {
        id?: string;
        generation?: string;
        expected?: string;
        previous?: string | null;
        action?: string;
        supersedes?: string | null;
        supersededBy?: string | null;
        status?: string;
    } = {},
) {
    const id = options.id ?? randomUUID();
    await sql`insert into promotion_operation
        (id, organization_id, app_id, alias_id, action, previous_target_deployment_id,
         desired_target_deployment_id, expected_generation, generation, requested_by,
         supersedes_operation_id, superseded_by_operation_id, status, idempotency_key)
        values (${id}, ${parent.org}, ${parent.id}, ${aliasId}, ${options.action ?? "bind"},
            ${options.previous ?? null}, ${target}, ${options.expected ?? "0"}, ${options.generation ?? "1"},
            ${actor}, ${options.supersedes ?? null}, ${options.supersededBy ?? null}, ${options.status ?? "queued"}, ${id})
    `.execute(connection);
    return id;
}

describe("migration 018 deployment model and reservations", () => {
    it("keeps bigint generations as decimal strings without JavaScript precision loss", async () => {
        const route = await allocateAlias(await app());
        const before = await db()
            .selectFrom("app_alias")
            .select("reserved_generation")
            .where("id", "=", route.id)
            .executeTakeFirstOrThrow();
        expect(before.reserved_generation).toBe("0");
        await db()
            .updateTable("app_alias")
            .set({ reserved_generation: "9223372036854775807" })
            .where("id", "=", route.id)
            .execute();
        const after = await db()
            .selectFrom("app_alias")
            .select("reserved_generation")
            .where("id", "=", route.id)
            .executeTakeFirstOrThrow();
        expect(after.reserved_generation).toBe("9223372036854775807");
    });
    it("starts with empty permanent registries and a ready recovery gate", async () => {
        const hosts = await sql<{ hostname: string; owner_id: string; owner_kind: string }>`
            select hostname, owner_id, owner_kind from hostname_reservation order by hostname
        `.execute(db());
        expect(hosts.rows).toEqual([]);
        const names = await sql<{ app_name: string; owner_id: string }>`
            select app_name, owner_id from dokku_name_reservation order by app_name
        `.execute(db());
        expect(names.rows).toEqual([]);
        expect((await sql`select name from launchpad_migration`.execute(db())).rows).toHaveLength(
            18,
        );
        expect(
            (
                await sql`select * from instance_state where key = 'deployment_recovery'`.execute(
                    db(),
                )
            ).rows,
        ).toMatchObject([{ value: "ready" }]);
    });

    it.each([true, false])("admits matching owners with reservationsFirst=%s", async (first) => {
        const parent = await app();
        await allocateDeployment(parent, { reservationsFirst: first });
        await allocateAlias(parent, { reservationsFirst: first });
        expect((await sql`select * from deployment`.execute(db())).rows).toHaveLength(1);
        expect((await sql`select * from app_alias`.execute(db())).rows).toHaveLength(1);
    });

    it.each(["host", "name"] as const)(
        "rejects an owner missing its %s registry row at COMMIT",
        async (missing) => {
            const parent = await app();
            let bodyCompleted = false;
            await expect(
                db()
                    .transaction()
                    .execute(async (trx) => {
                        await deployment(trx, parent, {
                            omitHost: missing === "host",
                            omitName: missing === "name",
                        });
                        bodyCompleted = true;
                    }),
            ).rejects.toThrow(/owner and .* reservation must match/);
            expect(bodyCompleted).toBe(true);
            expect((await sql`select * from deployment`.execute(db())).rows).toEqual([]);
            expect(
                (
                    await sql`select * from hostname_reservation where owner_kind = 'deployment'`.execute(
                        db(),
                    )
                ).rows,
            ).toEqual([]);
        },
    );

    it("rejects an alias missing its reservation only at transaction end", async () => {
        const parent = await app();
        let bodyCompleted = false;
        await expect(
            db()
                .transaction()
                .execute(async (trx) => {
                    await alias(trx, parent, { omitHost: true });
                    bodyCompleted = true;
                }),
        ).rejects.toThrow(/owner and hostname reservation/);
        expect(bodyCompleted).toBe(true);
    });

    it.each(["alias", "deployment"])(
        "rejects a %s reservation without an owner at COMMIT",
        async (kind) => {
            let bodyCompleted = false;
            await expect(
                db()
                    .transaction()
                    .execute(async (trx) => {
                        await hostReservation(
                            trx,
                            kind,
                            randomUUID(),
                            a.org,
                            `ghost-${token()}.apps.example.net`,
                        );
                        bodyCompleted = true;
                    }),
            ).rejects.toThrow(/owner and hostname reservation/);
            expect(bodyCompleted).toBe(true);
        },
    );

    it.each(["hostname", "organization"] as const)(
        "rejects reciprocal alias %s mismatch",
        async (mismatch) => {
            const parent = await app();
            await expect(
                db()
                    .transaction()
                    .execute(async (trx) => {
                        const owner = await alias(trx, parent, { omitHost: true });
                        await hostReservation(
                            trx,
                            "alias",
                            owner.id,
                            mismatch === "organization" ? b.org : a.org,
                            mismatch === "hostname"
                                ? `wrong-${token()}.apps.example.net`
                                : owner.hostname,
                        );
                    }),
            ).rejects.toThrow(/owner and hostname reservation/);
        },
    );

    it.each(["name", "organization"] as const)(
        "rejects reciprocal Dokku %s mismatch",
        async (mismatch) => {
            const parent = await app();
            await expect(
                db()
                    .transaction()
                    .execute(async (trx) => {
                        const owner = await deployment(trx, parent, { omitName: true });
                        await nameReservation(
                            trx,
                            "deployment",
                            owner.id,
                            mismatch === "organization" ? b.org : a.org,
                            mismatch === "name" ? `lp-${token()}` : owner.name,
                        );
                    }),
            ).rejects.toThrow(/owner and Dokku name reservation/);
        },
    );

    it("shares one hostname namespace across deployments and aliases", async () => {
        const parent = await app();
        const deployed = await allocateDeployment(parent);
        await expect(allocateAlias(parent, { hostname: deployed.hostname })).rejects.toThrow(
            /duplicate key/,
        );
    });

    it("does not free names after release, deletion or withdrawal", async () => {
        const parent = await app();
        const deployed = await allocateDeployment(parent);
        const route = await allocateAlias(parent, { slug: "production" });
        await sql`update deployment set desired_state = 'deleted', deleted_at = now()
            where id = ${deployed.id}`.execute(db());
        await sql`update app_alias set state = 'withdrawn', reserved_generation = 1, committed_generation = 1
            where id = ${route.id}`.execute(db());
        await sql`update hostname_reservation set released_at = clock_timestamp()
            where hostname in (${deployed.hostname}, ${route.hostname})`.execute(db());
        await sql`update dokku_name_reservation set released_at = clock_timestamp()
            where app_name = ${deployed.name}`.execute(db());
        await expect(allocateDeployment(parent, { name: deployed.name })).rejects.toThrow(
            /duplicate key/,
        );
        await expect(allocateAlias(parent, { hostname: route.hostname })).rejects.toThrow(
            /duplicate key/,
        );
        // Only the display slug may be reused, with a fresh ID/hostname.
        const replacement = await allocateAlias(parent, { slug: "production" });
        expect(replacement.id).not.toBe(route.id);
        expect(replacement.hostname).not.toBe(route.hostname);
    });

    it("cannot delete/reassign registry history or hard-delete its owner", async () => {
        const parent = await app();
        const route = await allocateAlias(parent);
        await expect(
            sql`delete from hostname_reservation where hostname = ${route.hostname}`.execute(db()),
        ).rejects.toThrow(/history is permanent/);
        await expect(
            sql`update hostname_reservation set owner_id = ${randomUUID()}
            where hostname = ${route.hostname}`.execute(db()),
        ).rejects.toThrow(/identity .* immutable/);
        await expect(
            sql`delete from app_alias where id = ${route.id}`.execute(db()),
        ).rejects.toThrow(/history is permanent/);
        await sql`update app_alias set state = 'withdrawn', reserved_generation = 1, committed_generation = 1
            where id = ${route.id}`.execute(db());
        await sql`update hostname_reservation set released_at = clock_timestamp()
            where hostname = ${route.hostname}`.execute(db());
        await expect(
            sql`update hostname_reservation set released_at = null
            where hostname = ${route.hostname}`.execute(db()),
        ).rejects.toThrow(/release history/);
    });

    it("refuses TRUNCATE of permanent hostname history", async () => {
        const before = (
            await sql`select * from hostname_reservation order by hostname`.execute(db())
        ).rows;
        await expect(sql`truncate table public.hostname_reservation`.execute(db())).rejects.toThrow(
            /history cannot be truncated/,
        );
        expect(
            (await sql`select * from hostname_reservation order by hostname`.execute(db())).rows,
        ).toEqual(before);
    });

    it("rejects cross-organization project/artifact ownership", async () => {
        await expect(app({ ...a, project: b.project })).rejects.toThrow(/foreign key/);
        const parent = await app();
        await expect(allocateDeployment(parent, { artifact: b.artifact })).rejects.toThrow(
            /foreign key/,
        );
    });

    it("rejects cross-app alias targets, promotion targets and deletion references", async () => {
        const parent = await app();
        const other = await app();
        const route = await allocateAlias(parent);
        const foreign = await allocateDeployment(other);
        await expect(
            sql`update app_alias set state = 'bound', target_deployment_id = ${foreign.id},
            reserved_generation = 1, committed_generation = 1 where id = ${route.id}`.execute(db()),
        ).rejects.toThrow(/foreign key/);
        await expect(promotion(db(), parent, route.id, foreign.id)).rejects.toThrow(/foreign key/);
        await expect(
            sql`insert into deployment_deletion_operation
             (organization_id, app_id, deployment_id, reason, requested_by) values
             (${a.org}, ${parent.id}, ${foreign.id}, 'manual', ${actor})`.execute(db()),
        ).rejects.toThrow(/foreign key/);
    });

    it("rejects cross-organization events", async () => {
        const parent = await app();
        const deployed = await allocateDeployment(parent);
        await expect(
            sql`insert into app_deployment_event
            (organization_id, deployment_id, seq, phase, message)
            values (${b.org}, ${deployed.id}, 1, 'verify', 'Verified')`.execute(db()),
        ).rejects.toThrow(/foreign key/);
    });

    it("serializes unfinished deployment allocation per app, including held outcomes", async () => {
        const parent = await app();
        await allocateDeployment(parent, { status: "reconciliation-needed" });
        await expect(allocateDeployment(parent, { status: "queued" })).rejects.toThrow(
            /duplicate key/,
        );
        await allocateDeployment(await app(), { status: "queued" });
    });

    it("keeps bigint generations exact and rejects lowering or overflowing them", async () => {
        const route = await allocateAlias(await app());
        await sql`update app_alias set reserved_generation = ${"9007199254740993"}
            where id = ${route.id}`.execute(db());
        const result = await sql<{
            generation: string;
        }>`select reserved_generation::text as generation
            from app_alias where id = ${route.id}`.execute(db());
        expect(result.rows).toEqual([{ generation: "9007199254740993" }]);
        await expect(
            sql`update app_alias set reserved_generation = ${"9007199254740992"}
            where id = ${route.id}`.execute(db()),
        ).rejects.toThrow(/generations .* fenced/);
        await expect(
            sql`update app_alias set reserved_generation = ${"9223372036854775808"}
            where id = ${route.id}`.execute(db()),
        ).rejects.toThrow(/out of range/);
    });

    it("requires generation uniqueness and at most one unsuperseded unfinished promotion", async () => {
        const parent = await app();
        const route = await allocateAlias(parent);
        const deployed = await allocateDeployment(parent);
        await promotion(db(), parent, route.id, deployed.id);
        await expect(promotion(db(), parent, route.id, deployed.id)).rejects.toThrow(
            /duplicate key/,
        );
        await expect(
            promotion(db(), parent, route.id, deployed.id, { generation: "2", expected: "1" }),
        ).rejects.toThrow(/duplicate key/);
    });

    it("links supersession within one alias while retaining all target FKs", async () => {
        const parent = await app();
        const route = await allocateAlias(parent);
        const first = await allocateDeployment(parent);
        const next = await allocateDeployment(parent);
        const original = await promotion(db(), parent, route.id, first.id, {
            status: "reconciliation-needed",
        });
        const correction = randomUUID();
        await db()
            .transaction()
            .execute(async (trx) => {
                await sql`update promotion_operation set superseded_by_operation_id = ${correction}
                where id = ${original}`.execute(trx);
                await promotion(trx, parent, route.id, next.id, {
                    id: correction,
                    generation: "2",
                    expected: "1",
                    previous: first.id,
                    supersedes: original,
                });
            });
        const ops =
            await sql`select id from promotion_operation where alias_id = ${route.id}`.execute(
                db(),
            );
        expect(ops.rows).toHaveLength(2);
        const otherRoute = await allocateAlias(parent);
        await expect(
            db()
                .transaction()
                .execute((trx) =>
                    promotion(trx, parent, otherRoute.id, first.id, {
                        supersedes: original,
                    }),
                ),
        ).rejects.toThrow(/foreign key/);
    });

    it("does not mutate a completed deployment's artifact, image, identity or status", async () => {
        const parent = await app();
        const deployed = await allocateDeployment(parent);
        await expect(
            sql`update deployment set image_id = ${`sha256:${"b".repeat(64)}`}
            where id = ${deployed.id}`.execute(db()),
        ).rejects.toThrow(/cannot be redeployed/);
        await expect(
            sql`update deployment set status = 'queued'
            where id = ${deployed.id}`.execute(db()),
        ).rejects.toThrow(/cannot be redeployed/);
        await expect(
            sql`update deployment set spa = true
            where id = ${deployed.id}`.execute(db()),
        ).rejects.toThrow(/deployment identity/);
        await expect(
            sql`update deployment set hostname = 'changed.apps.example.net'
            where id = ${deployed.id}`.execute(db()),
        ).rejects.toThrow(/resource identity/);
    });

    it("does not assign one image tag to two deployment owners", async () => {
        const first = await allocateDeployment(await app());
        const second = await allocateDeployment(await app(), { status: "queued" });
        await expect(
            sql`update deployment set image_tag = ${`launchpad/site:${first.id}`}
            where id = ${second.id}`.execute(db()),
        ).rejects.toThrow(/duplicate key/);
    });

    it("uses deferred hardened validators with no public direct execute grant", async () => {
        const triggers = await sql<{ name: string; deferred: boolean }>`
            select tgname as name, tgdeferrable and tginitdeferred as deferred
            from pg_trigger where tgname in (
                'hostname_reservation_owner', 'dokku_name_reservation_owner',
                'deployment_reservations', 'app_alias_reservations'
            )`.execute(db());
        expect(triggers.rows).toHaveLength(4);
        expect(triggers.rows.every((row) => row.deferred)).toBe(true);
        const functions = await sql<{
            name: string;
            definer: boolean;
            config: string[];
            public_execute: boolean;
        }>`
            select p.proname as name, p.prosecdef as definer, p.proconfig as config,
                exists(select from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
                    where acl.grantee = 0 and acl.privilege_type = 'EXECUTE') as public_execute
            from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in (
                'deployment_check_reservations', 'deployment_validate_reservation', 'deployment_validate_owner'
            )`.execute(db());
        expect(functions.rows).toHaveLength(3);
        for (const fn of functions.rows) {
            expect(fn.definer).toBe(false);
            expect(fn.config).toContain("search_path=pg_catalog");
            expect(fn.public_execute).toBe(false);
        }
        // Invoker permissions and trigger enforcement are exercised below.
    });

    it.each([
        "UPPER.apps.example.net",
        "empty..apps.example.net",
        "trailing.apps.example.net.",
        `${"a".repeat(64)}.apps.example.net`,
        "bad_name.apps.example.net",
        "ü.apps.example.net",
        "localhost",
    ])("rejects noncanonical new hostname %s", async (hostname) => {
        await expect(allocateAlias(await app(), { hostname })).rejects.toThrow(/check constraint/);
    });

    it("accepts a 63-character label without truncation", async () => {
        const hostname = `${"a".repeat(63)}.apps.example.net`;
        const route = await allocateAlias(await app(), { hostname });
        expect(route.hostname).toBe(hostname);
    });

    it("rejects a second reservation for the same owner", async () => {
        const route = await allocateAlias(await app());
        await expect(
            hostReservation(db(), "alias", route.id, a.org, `other-${token()}.apps.example.net`),
        ).rejects.toThrow(/duplicate key/);
    });

    it("blocks competing cross-kind hostname allocation while the first transaction is uncommitted", async () => {
        const firstApp = await app();
        const secondApp = await app();
        const hostname = `race-${token()}.apps.example.net`;
        const ready = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const first = db()
            .transaction()
            .execute(async (trx) => {
                await alias(trx, firstApp, { hostname });
                ready.resolve();
                await release.promise;
            });
        // A failure before ready must fail the test instead of hanging it.
        void first.catch(ready.reject);
        try {
            await ready.promise;
            await expect(
                db()
                    .transaction()
                    .execute(async (trx) => {
                        await sql`set local lock_timeout = '250ms'`.execute(trx);
                        await deployment(trx, secondApp, { hostname });
                    }),
            ).rejects.toThrow(/lock timeout/);
        } finally {
            release.resolve();
            await first;
        }
        expect(
            (await sql`select * from app_alias where hostname = ${hostname}`.execute(db())).rows,
        ).toHaveLength(1);
        expect((await sql`select * from deployment`.execute(db())).rows).toEqual([]);
    });

    it("keeps app/project identity stable and allows only soft retirement", async () => {
        const parent = await app(a, "stable");
        await expect(
            sql`update app set project_id = ${b.project} where id = ${parent.id}`.execute(db()),
        ).rejects.toThrow(/app identity/);
        await expect(sql`delete from app where id = ${parent.id}`.execute(db())).rejects.toThrow(
            /history is permanent/,
        );
        await sql`update app set state = 'deleted', deleted_at = now()
            where id = ${parent.id}`.execute(db());
        await expect(
            sql`update app set state = 'active', deleted_at = null
            where id = ${parent.id}`.execute(db()),
        ).rejects.toThrow(/app identity and retirement/);
        expect((await app(a, "stable")).id).not.toBe(parent.id);
    });

    it("does not rewrite promotion intent or lower its independent fence", async () => {
        const parent = await app();
        const route = await allocateAlias(parent);
        const first = await allocateDeployment(parent);
        const second = await allocateDeployment(parent);
        const op = await promotion(db(), parent, route.id, first.id);
        await expect(
            sql`update promotion_operation set desired_target_deployment_id = ${second.id}
            where id = ${op}`.execute(db()),
        ).rejects.toThrow(/promotion intent/);
        await expect(
            sql`update promotion_operation set generation = 2
            where id = ${op}`.execute(db()),
        ).rejects.toThrow(/promotion intent/);
        await expect(
            sql`update promotion_operation set idempotency_key = 'different-request'
            where id = ${op}`.execute(db()),
        ).rejects.toThrow(/promotion intent/);
        await sql`update promotion_operation set fence = 2, attempt = 2
            where id = ${op}`.execute(db());
        await expect(
            sql`update promotion_operation set fence = 1
            where id = ${op}`.execute(db()),
        ).rejects.toThrow(/operation identity and fence/);
        await expect(
            sql`delete from promotion_operation where id = ${op}`.execute(db()),
        ).rejects.toThrow(/operation history is permanent/);
    });

    it("does not rewrite deletion intent or reopen a completed deletion", async () => {
        const parent = await app();
        const deployed = await allocateDeployment(parent);
        const op = randomUUID();
        await sql`insert into deployment_deletion_operation
            (id, organization_id, app_id, deployment_id, reason, requested_by)
            values (${op}, ${a.org}, ${parent.id}, ${deployed.id}, 'manual', ${actor})`.execute(
            db(),
        );
        await expect(
            sql`update deployment_deletion_operation set reason = 'expired'
            where id = ${op}`.execute(db()),
        ).rejects.toThrow(/deletion intent/);
        await sql`update deployment_deletion_operation set status = 'succeeded', fence = 3
            where id = ${op}`.execute(db());
        await expect(
            sql`update deployment_deletion_operation set status = 'queued'
            where id = ${op}`.execute(db()),
        ).rejects.toThrow(/deletion intent/);
        await expect(
            sql`update deployment_deletion_operation set fence = 2
            where id = ${op}`.execute(db()),
        ).rejects.toThrow(/operation identity and fence/);
    });

    it("rolls back the destructive cutover if a later stage refuses", async () => {
        const fresh = await createTestDatabase();
        try {
            await fresh.migrateTo("20261116_017_worker_heartbeat_lifecycle");
            await expect(
                fresh.db.transaction().execute(async (trx) => {
                    await cutover(trx);
                    throw new Error("recovery stage refused");
                }),
            ).rejects.toThrow("recovery stage refused");
            const result = await sql<{
                old: string | null;
                model: string | null;
                retired: string | null;
            }>`
                select to_regclass('public.preview')::text as old,
                    to_regclass('public.app')::text as model,
                    to_regclass('public.legacy_preview')::text as retired
            `.execute(fresh.db);
            expect(result.rows).toEqual([{ old: "preview", model: null, retired: null }]);
            expect(await fresh.db.selectFrom("audit_event").selectAll().execute()).toEqual([]);
        } finally {
            await fresh.destroy();
        }
    });

    it("installs BEFORE TRUNCATE statement guards on all eight model tables", async () => {
        const guards = await sql<{ name: string }>`select tgrelid::regclass::text as name
            from pg_trigger where tgfoid = 'public.deployment_protect_truncate()'::regprocedure
                and (tgtype & 32) = 32 and (tgtype & 2) = 2 and (tgtype & 1) = 0
            order by name`.execute(db());
        expect(guards.rows.map((row) => row.name)).toEqual([
            "app",
            "app_alias",
            "app_deployment_event",
            "deployment",
            "deployment_deletion_operation",
            "dokku_name_reservation",
            "hostname_reservation",
            "promotion_operation",
        ]);
    });

    it("makes deployment events append only", async () => {
        const parent = await app();
        const deployed = await allocateDeployment(parent);
        await sql`insert into app_deployment_event (organization_id, deployment_id, seq, phase, message)
            values (${a.org}, ${deployed.id}, 1, 'verify', 'Verified')`.execute(db());
        const before = (await sql`select * from app_deployment_event`.execute(db())).rows;
        await expect(
            sql`update app_deployment_event set message = 'Edited'
            where deployment_id = ${deployed.id}`.execute(db()),
        ).rejects.toThrow(/events are append only/);
        await expect(
            sql`delete from app_deployment_event where deployment_id = ${deployed.id}`.execute(
                db(),
            ),
        ).rejects.toThrow(/events are append only/);
        expect((await sql`select * from app_deployment_event`.execute(db())).rows).toEqual(before);
    });

    it("requires a manual deletion actor but allows a system expiry request", async () => {
        const parent = await app();
        const deployed = await allocateDeployment(parent);
        await expect(
            sql`insert into deployment_deletion_operation
            (organization_id, app_id, deployment_id, reason)
            values (${a.org}, ${parent.id}, ${deployed.id}, 'manual')`.execute(db()),
        ).rejects.toThrow(/check constraint/);
        await sql`insert into deployment_deletion_operation
            (organization_id, app_id, deployment_id, reason)
            values (${a.org}, ${parent.id}, ${deployed.id}, 'expired')`.execute(db());
    });

    it("does not cancel a deployment deletion once started", async () => {
        const deployed = await allocateDeployment(await app());
        await sql`update deployment set desired_state = 'deleting'
            where id = ${deployed.id}`.execute(db());
        await expect(
            sql`update deployment set desired_state = 'active'
            where id = ${deployed.id}`.execute(db()),
        ).rejects.toThrow(/deletion cannot be cancelled/);
    });

    it.each(["hostname", "name"] as const)(
        "rejects a live deployment's %s release at COMMIT",
        async (which) => {
            const deployed = await allocateDeployment(await app());
            let bodyCompleted = false;
            await expect(
                db()
                    .transaction()
                    .execute(async (trx) => {
                        if (which === "hostname") {
                            await sql`update hostname_reservation set released_at = clock_timestamp()
                    where hostname = ${deployed.hostname}`.execute(trx);
                        } else {
                            await sql`update dokku_name_reservation set released_at = clock_timestamp()
                    where app_name = ${deployed.name}`.execute(trx);
                        }
                        bodyCompleted = true;
                    }),
            ).rejects.toThrow(/release requires a retired owner/);
            expect(bodyCompleted).toBe(true);
        },
    );

    it("rejects a live alias release, but accepts retirement later in the same transaction", async () => {
        const route = await allocateAlias(await app());
        await expect(
            sql`update hostname_reservation set released_at = clock_timestamp()
            where hostname = ${route.hostname}`.execute(db()),
        ).rejects.toThrow(/release requires a retired owner/);
        await db()
            .transaction()
            .execute(async (trx) => {
                await sql`update hostname_reservation set released_at = clock_timestamp()
                where hostname = ${route.hostname}`.execute(trx);
                await sql`update app_alias set state = 'withdrawn', reserved_generation = 1, committed_generation = 1
                where id = ${route.id}`.execute(trx);
            });
    });

    it("keeps a linked predecessor unfinished until its corrective barrier is finalized", async () => {
        const parent = await app();
        const route = await allocateAlias(parent);
        const deployed = await allocateDeployment(parent);
        const old = await promotion(db(), parent, route.id, deployed.id, {
            status: "reconciliation-needed",
        });
        const correction = randomUUID();
        await db()
            .transaction()
            .execute(async (trx) => {
                await sql`update promotion_operation set superseded_by_operation_id = ${correction}
                where id = ${old}`.execute(trx);
                await promotion(trx, parent, route.id, deployed.id, {
                    id: correction,
                    generation: "2",
                    expected: "1",
                    supersedes: old,
                });
            });
        const pending = await sql<{ status: string; successor: string }>`
            select status, superseded_by_operation_id as successor from promotion_operation where id = ${old}
        `.execute(db());
        expect(pending.rows).toEqual([{ status: "reconciliation-needed", successor: correction }]);
        // Only service verification may authorize this finalization; this test
        // checks the schema permits the designed linked-then-finalized ordering.
        await sql`update promotion_operation set status = 'superseded' where id = ${old}`.execute(
            db(),
        );
    });

    it("rejects superseded status without a successor", async () => {
        const parent = await app();
        const route = await allocateAlias(parent);
        const deployed = await allocateDeployment(parent);
        const op = await promotion(db(), parent, route.id, deployed.id);
        await expect(
            sql`update promotion_operation set status = 'superseded'
            where id = ${op}`.execute(db()),
        ).rejects.toThrow(/check constraint/);
    });

    it.each(["succeeded", "failed"])(
        "does not attach a corrective successor to an already %s operation",
        async (status) => {
            const parent = await app();
            const route = await allocateAlias(parent);
            const deployed = await allocateDeployment(parent);
            const op = await promotion(db(), parent, route.id, deployed.id, { status });
            await expect(
                sql`update promotion_operation set superseded_by_operation_id = ${randomUUID()}
            where id = ${op}`.execute(db()),
            ).rejects.toThrow(/promotion intent and settled outcome/);
        },
    );
});

// A test-only non-owner application role. Validators are invokers, so it needs
// read access and explicit function execution, but cannot disable owner guards.
// Production role provisioning remains the Compose deployment gate.
describe("deployment model under restricted roles (test-only roles)", () => {
    let application = "";

    beforeEach(async () => {
        const suffix = randomUUID().replaceAll("-", "").slice(0, 8);
        application = `lp_test_app_${suffix}`;
        await sql.raw(`create role ${application} nologin`).execute(db());
        const grant = (text: string) => sql.raw(text).execute(db());
        await grant(`grant usage on schema public to ${application}`);
        for (const fn of [
            "deployment_check_reservations(text, uuid)",
            "deployment_validate_reservation()",
            "deployment_validate_owner()",
        ]) {
            await grant(`grant execute on function public.${fn} to ${application}`);
        }
        // The application can read and write rows. It cannot delete, truncate,
        // own tables or disable their guards.
        await grant(
            `grant select, insert, update on public.app, public.deployment,
                public.app_deployment_event, public.app_alias, public.promotion_operation,
                public.deployment_deletion_operation, public.hostname_reservation,
                public.dokku_name_reservation to ${application}`,
        );
        await grant(
            `grant select on public.artifact, public.project, public.organization, public."user"
                to ${application}`,
        );
    });

    afterEach(async () => {
        if (!source) return;
        await sql.raw(`drop owned by ${application}`).execute(db());
        await sql.raw(`drop role ${application}`).execute(db());
    });

    const asApplication = <T>(work: (trx: Db) => Promise<T>) =>
        db()
            .transaction()
            .execute(async (trx) => {
                await sql.raw(`set local role ${application}`).execute(trx);
                return work(trx);
            });

    it("lets the application allocate reciprocal owners with ordinary invoker validators", async () => {
        const parent = await asApplication((trx) => app(a, `site-${token()}`, trx));
        await asApplication(async (trx) => {
            await deployment(trx, parent);
            await alias(trx, parent);
        });
        expect((await sql`select * from deployment`.execute(db())).rows).toHaveLength(1);
    });

    it("still fails a missing reservation at COMMIT under the restricted role", async () => {
        const parent = await asApplication((trx) => app(a, `site-${token()}`, trx));
        await expect(
            asApplication((trx) => deployment(trx, parent, { omitHost: true })),
        ).rejects.toThrow(/owner and hostname reservation must match/);
        expect((await sql`select * from deployment`.execute(db())).rows).toEqual([]);
    });

    it.each([
        ["truncate a registry", "truncate table public.hostname_reservation"],
        ["delete registry history", "delete from public.hostname_reservation"],
        ["disable a guard trigger", "alter table public.hostname_reservation disable trigger user"],
        ["bypass triggers", "set session_replication_role = replica"],
        ["drop a guard function", "drop function public.deployment_protect_truncate() cascade"],
        [
            "replace a validator",
            "alter function public.deployment_check_reservations(text, uuid) owner to current_user",
        ],
    ])("denies the application role the ability to %s", async (_name, statement) => {
        const before = (
            await sql`select count(*)::int as n from hostname_reservation`.execute(db())
        ).rows;
        await expect(asApplication((trx) => sql.raw(statement).execute(trx))).rejects.toThrow(
            /permission denied|must be owner/,
        );
        expect(
            (await sql`select count(*)::int as n from hostname_reservation`.execute(db())).rows,
        ).toEqual(before);
    });

    it("keeps validators invoker-only: fixed search path, no PUBLIC execute", async () => {
        const rows = await sql<{ name: string; owner: string; definer: boolean; config: string[] }>`
            select p.proname as name, pg_get_userbyid(p.proowner) as owner,
                p.prosecdef as definer, p.proconfig as config
            from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in (
                'deployment_check_reservations', 'deployment_validate_reservation',
                'deployment_validate_owner')
            order by p.proname`.execute(db());
        expect(rows.rows).toHaveLength(3);
        for (const fn of rows.rows) {
            expect(fn.owner).not.toBe(application);
            expect(fn.definer).toBe(false);
            expect(fn.config).toContain("search_path=pg_catalog");
        }
    });
});
