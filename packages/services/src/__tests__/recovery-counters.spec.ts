import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDatabase } from "@launchpad-kit/database/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    assertModelMutationsReady,
    blockRestoredModel,
    clearDeploymentRecovery,
    createAlias,
    createApp,
    createOrganization,
    createProject,
    markDeploymentRecoveryBlocked,
    readRecoveryMarker,
    parseAliasConfig,
    parseDeploymentConfig,
    raiseAliasCounters,
    withdrawUnknownRoute,
    type AliasDeps,
    type RouterInventory,
} from "../index";

// The restore hazard behind P4e: a database restored from an older backup can be behind the
// router's per-hostname counters, or the router can hold a route the database never heard of.
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let dataDir = "";
const authority = { instanceId: randomUUID(), epoch: randomUUID() };
const env = {
    LAUNCHPAD_DEPLOYMENTS: "on",
    LAUNCHPAD_ALIASES: "on",
    LAUNCHPAD_BASE_URL: "https://control.example.com",
    LAUNCHPAD_APPS_DOMAIN: "sites.example.net",
};
const deps = (): AliasDeps => ({
    dataDir,
    settings: parseDeploymentConfig(env),
    aliases: parseAliasConfig(env),
});

async function aliasFixture() {
    const root = randomUUID();
    await db.db
        .insertInto("user")
        .values({
            id: root,
            name: "root",
            email: "root@example.com",
            emailVerified: false,
            role: "operator",
        })
        .execute();
    const owner = { userId: randomUUID(), instanceRole: "user" as const };
    await db.db
        .insertInto("user")
        .values({
            id: owner.userId,
            name: "ann",
            email: "ann@example.com",
            emailVerified: false,
            role: "user",
        })
        .execute();
    await db.db
        .insertInto("audit_event")
        .values({
            actor: "operator-cli",
            action: "user.provisioned",
            target_type: "user",
            target_id: owner.userId,
        })
        .execute();
    const org = (
        await createOrganization(
            db.db,
            { userId: root, instanceRole: "operator" },
            { name: "Acme", slug: "acme", ownerEmail: "ann@example.com" },
        )
    ).id;
    const project = (await createProject(db.db, owner, org, { name: "One", slug: "one" })).id;
    const app = await createApp(db.db, owner, org, project, { slug: "web" }, deps());
    const alias = await createAlias(db.db, owner, org, app.id, { slug: "prod" }, deps());
    return alias;
}

const inventory = (routes: RouterInventory["routes"]): RouterInventory => ({
    ...authority,
    routes,
});
const route = (
    alias: { id: string; hostname: string },
    generation: string,
    target: RouterInventory["routes"][number]["target"] = {
        deploymentId: randomUUID(),
        hostname: "d.sites.example.net",
    },
) => ({
    aliasId: alias.id,
    hostname: alias.hostname,
    operationId: randomUUID(),
    generation,
    target,
});
const aliasRow = (id: string) =>
    db.db.selectFrom("app_alias").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
// The restore recorded an epoch the router has since moved off (authority.epoch differs), as it
// would after a rotation.
const blocked = async (anchor: string | null = randomUUID()) => {
    await markDeploymentRecoveryBlocked(
        dataDir,
        anchor ? { routerEpoch: anchor, note: "recorded" } : undefined,
    );
    await blockRestoredModel(db.db);
};

beforeEach(async () => {
    db = await createTestDatabase();
    await db.migrate();
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lp-counters-"));
});
afterEach(async () => {
    await db?.destroy();
    if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
});

describe("recovery counters", () => {
    it("refuses to clear while any alias exists without a router to compare", async () => {
        await aliasFixture();
        await blocked();
        await expect(clearDeploymentRecovery(db.db, dataDir, true)).rejects.toThrow(
            /compare the router/,
        );
        await expect(assertModelMutationsReady(db.db, dataDir)).rejects.toThrow(/blocked/);
    });

    it("refuses when the router is ahead, holds an unknown route, or cannot be read", async () => {
        const alias = await aliasFixture();
        await blocked();
        const ahead = inventory([route(alias, "7")]);
        await expect(
            clearDeploymentRecovery(db.db, dataDir, true, async () => ahead),
        ).rejects.toThrow(/ahead of the restored database.*1 alias counters behind/);
        const stranger = inventory([
            route({ id: randomUUID(), hostname: "stranger.sites.example.net" }, "1"),
        ]);
        await expect(
            clearDeploymentRecovery(db.db, dataDir, true, async () => stranger),
        ).rejects.toThrow(/1 unknown routes: stranger\.sites\.example\.net/);
        // Another alias's hostname with a different alias id is unknown too.
        const impostor = inventory([{ ...route(alias, "0"), aliasId: randomUUID() }]);
        await expect(
            clearDeploymentRecovery(db.db, dataDir, true, async () => impostor),
        ).rejects.toThrow(/unknown routes/);
        await expect(
            clearDeploymentRecovery(db.db, dataDir, true, async () => {
                throw new Error("router down");
            }),
        ).rejects.toThrow(/router could not be read/);
        await expect(assertModelMutationsReady(db.db, dataDir)).rejects.toThrow(/blocked/);
    });

    it("raises counters only upward, leaves the committed generation, and audits it", async () => {
        const alias = await aliasFixture();
        await db.db
            .updateTable("app_alias")
            .set({ reserved_generation: "5" })
            .where("id", "=", alias.id)
            .execute();
        await blocked();
        // A router below the database changes nothing.
        expect(
            await raiseAliasCounters(db.db, dataDir, async () => inventory([route(alias, "3")])),
        ).toMatchObject({ raised: 0 });
        expect(await aliasRow(alias.id)).toMatchObject({ reserved_generation: "5" });
        // One above it raises to exactly the router's generation, and never lowers afterwards.
        const unknown = route({ id: randomUUID(), hostname: "stranger.sites.example.net" }, "2");
        const result = await raiseAliasCounters(db.db, dataDir, async () =>
            inventory([route(alias, "9"), unknown]),
        );
        expect(result).toEqual({
            raised: 1,
            unknownRoutes: ["stranger.sites.example.net"],
            unknownWithdrawn: [],
            conflicting: [],
        });
        expect(await aliasRow(alias.id)).toMatchObject({
            reserved_generation: "9",
            committed_generation: "0",
        });
        await raiseAliasCounters(db.db, dataDir, async () => inventory([route(alias, "4")]));
        expect(await aliasRow(alias.id)).toMatchObject({ reserved_generation: "9" });
        const audit = await db.db
            .selectFrom("audit_event")
            .select("detail")
            .where("action", "=", "deployment.recovery-counters-raised")
            .execute();
        expect(audit).toEqual([{ detail: "aliases=1" }]);
        // The gate is still closed: raising counters is not clearing.
        await expect(assertModelMutationsReady(db.db, dataDir)).rejects.toThrow(/blocked/);
    });

    it("clears once the counters match, ignoring a withdrawn route it does not know", async () => {
        const alias = await aliasFixture();
        await blocked();
        const view = async () =>
            inventory([
                route(alias, "6"),
                route({ id: randomUUID(), hostname: "old.sites.example.net" }, "3", null),
            ]);
        await expect(clearDeploymentRecovery(db.db, dataDir, true, view)).rejects.toThrow(/ahead/);
        expect(await raiseAliasCounters(db.db, dataDir, view)).toMatchObject({
            raised: 1,
            unknownRoutes: [],
            unknownWithdrawn: ["old.sites.example.net"],
        });
        await clearDeploymentRecovery(db.db, dataDir, true, view);
        await assertModelMutationsReady(db.db, dataDir);
    });

    it("clears an installation with no aliases without a router", async () => {
        await blocked();
        await clearDeploymentRecovery(db.db, dataDir, true);
        await assertModelMutationsReady(db.db, dataDir);
    });

    it("names why the router could not be read", async () => {
        await aliasFixture();
        await blocked();
        await expect(
            clearDeploymentRecovery(db.db, dataDir, true, async () => {
                throw new Error("Could not read the configured router credential file.");
            }),
        ).rejects.toThrow(
            /could not be read \(Could not read the configured router credential file\./,
        );
    });

    it("withdraws only a live route for an alias Launchpad does not know, at the next generation", async () => {
        const alias = await aliasFixture();
        const stranger = route({ id: randomUUID(), hostname: "stranger.sites.example.net" }, "6");
        const idle = route({ id: randomUUID(), hostname: "idle.sites.example.net" }, "2", null);
        const withdrawn: unknown[] = [];
        const router = {
            view: async () => inventory([route(alias, "1"), stranger, idle]),
            withdraw: async (written: unknown) => void withdrawn.push(written),
        };
        // A hostname the database owns is never withdrawn, whichever alias id the router recorded.
        const claimed = { ...route(alias, "3"), aliasId: randomUUID() };
        const clash = { ...router, view: async () => inventory([claimed]) };
        await expect(withdrawUnknownRoute(db.db, dataDir, alias.hostname, clash)).rejects.toThrow(
            /not a live route/,
        );
        for (const hostname of [alias.hostname, idle.hostname, "missing.sites.example.net"]) {
            await expect(withdrawUnknownRoute(db.db, dataDir, hostname, router)).rejects.toThrow(
                /not a live route/,
            );
        }
        expect(withdrawn).toEqual([]);
        expect(await withdrawUnknownRoute(db.db, dataDir, stranger.hostname, router)).toEqual({
            hostname: stranger.hostname,
            generation: "7",
        });
        expect(withdrawn).toEqual([
            { aliasId: stranger.aliasId, hostname: stranger.hostname, generation: "7" },
        ]);
        const audit = await db.db
            .selectFrom("audit_event")
            .select("detail")
            .where("action", "=", "deployment.unknown-route-withdrawn")
            .execute();
        expect(audit).toEqual([{ detail: "hostname=stranger.sites.example.net;generation=7" }]);
    });

    describe("the router epoch anchor", () => {
        const ok = (alias: { id: string; hostname: string }) => async () =>
            inventory([route(alias, "0")]);

        it("refuses while the router is still on the epoch recorded when the restore began", async () => {
            const alias = await aliasFixture();
            await blocked(authority.epoch);
            await expect(clearDeploymentRecovery(db.db, dataDir, true, ok(alias))).rejects.toThrow(
                /epoch has not changed since the restore began/,
            );
            await expect(assertModelMutationsReady(db.db, dataDir)).rejects.toThrow(/blocked/);
            // The unrecorded flag does not override a recorded anchor.
            await expect(
                clearDeploymentRecovery(db.db, dataDir, true, ok(alias), {
                    routerEpochUnrecorded: true,
                }),
            ).rejects.toThrow(/epoch has not changed/);
        });

        it("clears once it has been rotated, and audits that the epoch changed", async () => {
            const alias = await aliasFixture();
            await blocked(randomUUID());
            await clearDeploymentRecovery(db.db, dataDir, true, ok(alias));
            const audit = await db.db
                .selectFrom("audit_event")
                .select("detail")
                .where("action", "=", "deployment.recovery-cleared")
                .execute();
            expect(audit).toEqual([
                { detail: "attested=reconciled-router-and-dokku;router-epoch=changed" },
            ]);
        });

        it("needs the explicit flag when the restore recorded no epoch, and audits it", async () => {
            const alias = await aliasFixture();
            await blocked(null);
            expect(await readRecoveryMarker(dataDir)).toMatchObject({
                routerEpoch: null,
                routerEpochNote: "not-configured",
            });
            await expect(clearDeploymentRecovery(db.db, dataDir, true, ok(alias))).rejects.toThrow(
                /recorded no router epoch/,
            );
            await clearDeploymentRecovery(db.db, dataDir, true, ok(alias), {
                routerEpochUnrecorded: true,
            });
            const audit = await db.db
                .selectFrom("audit_event")
                .select("detail")
                .where("action", "=", "deployment.recovery-cleared")
                .execute();
            expect(audit).toEqual([
                {
                    detail: "attested=reconciled-router-and-dokku;router-epoch=unrecorded-confirmed",
                },
            ]);
        });

        it("keeps the first anchor and start time when an interrupted restore runs again", async () => {
            const first = randomUUID();
            await markDeploymentRecoveryBlocked(dataDir, { routerEpoch: first, note: "recorded" });
            const before = await readRecoveryMarker(dataDir);
            await markDeploymentRecoveryBlocked(dataDir, {
                routerEpoch: randomUUID(),
                note: "recorded",
            });
            expect(await readRecoveryMarker(dataDir)).toEqual(before);
            // A marker with no anchor yet is replaced by one that has it, keeping the start time.
            const other = await fs.mkdtemp(path.join(os.tmpdir(), "lp-anchor-"));
            try {
                await markDeploymentRecoveryBlocked(other, {
                    routerEpoch: null,
                    note: "unreachable",
                });
                const bare = await readRecoveryMarker(other);
                await markDeploymentRecoveryBlocked(other, {
                    routerEpoch: first,
                    note: "recorded",
                });
                expect(await readRecoveryMarker(other)).toMatchObject({
                    routerEpoch: first,
                    restoreStartedAt: bare!.restoreStartedAt,
                });
            } finally {
                await fs.rm(other, { recursive: true, force: true });
            }
        });

        it("reads a version 1 or damaged marker as having no anchor", async () => {
            await fs.mkdir(path.join(dataDir, "maintenance"), { mode: 0o700 });
            const file = path.join(dataDir, "maintenance/deployment-recovery-blocked");
            await fs.writeFile(
                file,
                '{"version":1,"restoreStartedAt":"2026-01-01T00:00:00.000Z"}\n',
            );
            expect(await readRecoveryMarker(dataDir)).toMatchObject({ routerEpoch: null });
            for (const text of [
                "not json",
                '{"version":3}',
                '{"version":2,"restoreStartedAt":"x","routerEpoch":"nope","routerEpochNote":"recorded"}',
            ]) {
                await fs.writeFile(file, text);
                expect(await readRecoveryMarker(dataDir)).toBeNull();
            }
        });
    });
});
