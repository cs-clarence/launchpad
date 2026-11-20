import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDatabase } from "@launchpad-kit/database/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    acknowledgePromotionDispatch,
    addMember,
    beginDeletionStep,
    beginPromotionStep,
    claimDeletion,
    claimPromotion,
    completeDeletionStep,
    createAlias,
    createApp,
    createDeployment,
    createOrganization,
    createProject,
    finalizePromotion,
    holdPromotion,
    parseAliasConfig,
    parseDeploymentConfig,
    requestAppShutdown,
    requestDeploymentDeletion,
    requestPromotion,
    ServiceError,
    uploadArtifact,
    type AliasDeps,
    type Principal,
} from "../index";
import { SITE, tarGz } from "../testing/tar-fixtures";

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let dataDir = "";
let org = "";
let project = "";
const people: Record<string, Principal> = {};
const env = {
    LAUNCHPAD_DEPLOYMENTS: "on",
    LAUNCHPAD_ALIASES: "on",
    LAUNCHPAD_BASE_URL: "https://control.example.com",
    LAUNCHPAD_APPS_DOMAIN: "sites.example.net",
    LAUNCHPAD_MAX_APPS: "1000",
    LAUNCHPAD_MAX_ALIASES_PER_APP: "50",
    LAUNCHPAD_MAX_ALIASES: "1000",
};
const deps = (extra: Record<string, string> = {}): AliasDeps => ({
    dataDir,
    settings: parseDeploymentConfig({ ...env, ...extra }),
    aliases: parseAliasConfig({ ...env, ...extra }),
});
const code = (promise: Promise<unknown>) =>
    promise.then(
        () => "ok",
        (error) => (error instanceof ServiceError ? error.code : `unexpected: ${error}`),
    );
const authority = { instanceId: randomUUID(), epoch: randomUUID() };

async function newUser(name: string) {
    const id = randomUUID();
    await db.db
        .insertInto("user")
        .values({ id, name, email: `${name}@example.com`, emailVerified: false, role: "user" })
        .execute();
    await db.db
        .insertInto("audit_event")
        .values({
            actor: "operator-cli",
            action: "user.provisioned",
            target_type: "user",
            target_id: id,
        })
        .execute();
    people[name] = { userId: id, instanceRole: "user" };
}

beforeAll(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "launchpad-shutdown-"));
    db = await createTestDatabase();
    await db.migrate();
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
    for (const name of ["ann", "ada", "dee"]) await newUser(name);
    org = (
        await createOrganization(
            db.db,
            { userId: root, instanceRole: "operator" },
            { name: "Acme", slug: "acme", ownerEmail: "ann@example.com" },
        )
    ).id;
    await addMember(db.db, people.ann!, org, { email: "ada@example.com", role: "admin" });
    await addMember(db.db, people.ann!, org, { email: "dee@example.com", role: "deployer" });
    project = (await createProject(db.db, people.ann!, org, { name: "One", slug: "one" })).id;
});
afterAll(async () => {
    await db?.destroy();
    await fs.rm(dataDir, { recursive: true, force: true });
});

let counter = 0;
async function artifact() {
    const bytes = tarGz([...SITE, { name: `s-${++counter}.txt`, content: String(counter) }]);
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(bytes);
            controller.close();
        },
    });
    return (
        await uploadArtifact(
            db.db,
            people.ann!,
            org,
            body,
            { contentLength: bytes.length, projectId: project },
            { dataDir, limits: { maxArtifacts: 1000 } },
        )
    ).id;
}

async function fixture() {
    const app = await createApp(
        db.db,
        people.ann!,
        org,
        project,
        { slug: `app-${++counter}` },
        deps(),
    );
    const alias = await createAlias(db.db, people.ann!, org, app.id, { slug: "prod" }, deps());
    const deployment = async (
        status: "succeeded" | "building" | "reconciliation-needed" = "succeeded",
    ) => {
        const created = await createDeployment(
            db.db,
            people.ann!,
            org,
            app.id,
            { artifactId: await artifact() },
            deps(),
        );
        // At most one unfinished deployment per app: settle it first.
        await db.db
            .updateTable("deployment")
            .set({
                status,
                ...(status === "succeeded"
                    ? {
                          finished_at: new Date(),
                          step_done: "verify" as const,
                          image_tag: `launchpad/site:${created.id.replaceAll("-", "")}`,
                          image_id: `sha256:${"f".repeat(64)}`,
                      }
                    : {}),
            })
            .where("id", "=", created.id)
            .execute();
        return created.id;
    };
    return { app, alias, deployment };
}

const shutdown = (appId: string, who = "ada", extra: Record<string, string> = {}) =>
    requestAppShutdown(db.db, people[who]!, org, appId, deps(extra));
const aliasState = async (id: string) =>
    await db.db.selectFrom("app_alias").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const appState = async (id: string) =>
    await db.db
        .selectFrom("app")
        .select(["state", "deleted_at"])
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
const bind = (aliasId: string, target: string) =>
    db.db
        .updateTable("app_alias")
        .set({
            state: "bound",
            target_deployment_id: target,
            committed_generation: "1",
            reserved_generation: "1",
        })
        .where("id", "=", aliasId)
        .execute();

// Drives the claimed withdrawal like a worker that verified the router: dispatch, acknowledge,
// verify, commit with a readback that names the operation.
async function finishWithdrawal(aliasId: string, hostname: string) {
    const claim = await claimPromotion(db.db, dataDir, "worker");
    if (claim.kind !== "claimed") throw new Error(`Expected a claim, got ${claim.kind}`);
    expect(claim.alias.id).toBe(aliasId);
    await beginPromotionStep(db.db, dataDir, claim.token, "dispatch");
    await acknowledgePromotionDispatch(db.db, dataDir, claim.token);
    await beginPromotionStep(db.db, dataDir, claim.token, "verify");
    const done = await finalizePromotion(db.db, dataDir, claim.token, authority, async () => ({
        ...authority,
        route: {
            aliasId,
            hostname,
            operationId: claim.operation.id,
            generation: String(claim.operation.generation),
            target: null,
        },
    }));
    expect(done).not.toBeNull();
}

async function runDeletions() {
    for (;;) {
        const claim = await claimDeletion(db.db, dataDir, "worker");
        if (claim.kind !== "claimed") return;
        for (const step of ["destroy", "images"] as const) {
            await beginDeletionStep(db.db, dataDir, claim.token, step);
            await completeDeletionStep(db.db, dataDir, claim.token, step);
        }
    }
}

describe("app shutdown", () => {
    it("needs the admin role and a live app", async () => {
        const { app } = await fixture();
        expect(await code(shutdown(app.id, "dee"))).toBe("forbidden");
        expect(await code(shutdown(randomUUID()))).toBe("not-found");
        expect(await code(shutdown("not-a-uuid"))).toBe("not-found");
        expect(
            await code(
                shutdown(app.id, "ada", { LAUNCHPAD_DEPLOYMENTS: "off", LAUNCHPAD_ALIASES: "off" }),
            ),
        ).toBe("unavailable");
        expect(await appState(app.id)).toMatchObject({ state: "active" });
    });

    it("withdraws routes first, destroys nothing until they are verified, then deletes", async () => {
        const { app, alias, deployment } = await fixture();
        const live = await deployment();
        const spare = await deployment();
        await bind(alias.id, live);

        const first = await shutdown(app.id);
        expect(first).toEqual({
            appId: app.id,
            state: "shutting-down",
            withdrawalsQueued: 1,
            deletionsQueued: 0,
            blockedBy: [],
        });
        // The app is closed to new work, and a manual deletion is refused while it shuts down.
        expect(
            await code(
                createDeployment(
                    db.db,
                    people.ann!,
                    org,
                    app.id,
                    { artifactId: await artifact() },
                    deps(),
                ),
            ),
        ).toBe("not-found");
        expect(
            await code(
                requestPromotion(
                    db.db,
                    people.ann!,
                    org,
                    alias.id,
                    { targetDeploymentId: spare, expectedGeneration: "1" },
                    "k",
                    deps(),
                ),
            ),
        ).toBe("not-found");
        expect(await code(requestDeploymentDeletion(db.db, people.ann!, org, spare, deps()))).toBe(
            "not-found",
        );

        // A repeat while the route is still being withdrawn queues nothing and destroys nothing.
        expect(await shutdown(app.id)).toMatchObject({
            withdrawalsQueued: 0,
            deletionsQueued: 0,
            blockedBy: ["alias-in-progress"],
        });
        expect(
            await db.db.selectFrom("deployment_deletion_operation").select("id").execute(),
        ).toHaveLength(0);

        await finishWithdrawal(alias.id, alias.hostname);
        expect(await aliasState(alias.id)).toMatchObject({
            state: "withdrawn",
            target_deployment_id: null,
        });

        const second = await shutdown(app.id);
        expect(second).toMatchObject({
            state: "shutting-down",
            withdrawalsQueued: 0,
            deletionsQueued: 2,
            blockedBy: [],
        });
        // Deletions in flight are reported, never duplicated.
        expect(await shutdown(app.id)).toMatchObject({
            deletionsQueued: 0,
            blockedBy: ["deployment-deleting"],
        });

        await runDeletions();
        expect(await appState(app.id)).toMatchObject({
            state: "deleted",
            deleted_at: expect.any(Date),
        });
        expect(await code(shutdown(app.id))).toBe("not-found");
        // Names stay reserved: the hostnames of both deployments remain registered.
        const reserved = await db.db
            .selectFrom("hostname_reservation")
            .select("hostname")
            .execute();
        expect(reserved.length).toBeGreaterThanOrEqual(3);
        const audit = await db.db
            .selectFrom("audit_event")
            .select("action")
            .where("target_id", "=", app.id)
            .execute();
        expect(audit.map((row) => row.action)).toEqual(
            expect.arrayContaining([
                "app.shutdown-requested",
                "app.shutdown-deletions-queued",
                "app.shutdown-completed",
            ]),
        );
    });

    it("is blocked by an uncertain route, an unfinished deployment, or aliases being off", async () => {
        const uncertain = await fixture();
        const target = await uncertain.deployment();
        await bind(uncertain.alias.id, target);
        await shutdown(uncertain.app.id);
        const claim = await claimPromotion(db.db, dataDir, "worker");
        if (claim.kind !== "claimed") throw new Error("Expected a claim");
        await beginPromotionStep(db.db, dataDir, claim.token, "dispatch");
        expect(await holdPromotion(db.db, dataDir, claim.token)).not.toBeNull();
        expect(await shutdown(uncertain.app.id)).toMatchObject({
            deletionsQueued: 0,
            blockedBy: ["alias-needs-reconciliation"],
        });
        expect(await code(requestDeploymentDeletion(db.db, people.ann!, org, target, deps()))).toBe(
            "not-found",
        );

        const unfinished = await fixture();
        const building = await unfinished.deployment("building");
        expect(await shutdown(unfinished.app.id)).toMatchObject({
            deletionsQueued: 0,
            blockedBy: ["deployment-unfinished"],
        });
        await db.db
            .updateTable("deployment")
            .set({ status: "reconciliation-needed" })
            .where("id", "=", building)
            .execute();
        expect(await shutdown(unfinished.app.id)).toMatchObject({
            blockedBy: ["deployment-needs-reconciliation"],
        });
        await db.db
            .updateTable("deployment")
            .set({ status: "failed", finished_at: new Date() })
            .where("id", "=", building)
            .execute();
        expect(await shutdown(unfinished.app.id)).toMatchObject({
            deletionsQueued: 1,
            blockedBy: [],
        });

        const off = await fixture();
        const bound = await off.deployment();
        await bind(off.alias.id, bound);
        expect(await shutdown(off.app.id, "ada", { LAUNCHPAD_ALIASES: "off" })).toMatchObject({
            withdrawalsQueued: 0,
            deletionsQueued: 0,
            blockedBy: ["aliases-disabled"],
        });
    });

    it("settles an app with nothing to remove at once, and keeps a withdrawn alias's hostname", async () => {
        const empty = await fixture();
        expect(await shutdown(empty.app.id)).toMatchObject({ state: "deleted", blockedBy: [] });
        expect(await appState(empty.app.id)).toMatchObject({ state: "deleted" });
        expect(
            await db.db
                .selectFrom("hostname_reservation")
                .select("hostname")
                .where("hostname", "=", empty.alias.hostname)
                .execute(),
        ).toHaveLength(1);
    });
});
