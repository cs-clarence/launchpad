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
    parseAliasConfig,
    parseDeploymentConfig,
    raiseAliasCounters,
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
const blocked = async () => {
    await markDeploymentRecoveryBlocked(dataDir);
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
});
