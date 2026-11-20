import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDatabase } from "@launchpad-kit/database/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
    addMember,
    createApp,
    createDeployment,
    createOrganization,
    createProject,
    getApp,
    getDeployment,
    listApps,
    listDeploymentEvents,
    listDeployments,
    markDeploymentRecoveryBlocked,
    parseDeploymentConfig,
    ServiceError,
    uploadArtifact,
    type AppDeps,
    type Principal,
} from "../index";
import { SITE, tarGz } from "../testing/tar-fixtures";

let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
const people: Record<string, Principal> = {};
let org = "";
let otherOrg = "";
let p1 = "";
let p2 = "";
let dataDir = "";

const env = {
    LAUNCHPAD_DEPLOYMENTS: "on",
    LAUNCHPAD_BASE_URL: "https://control.example.com",
    LAUNCHPAD_APPS_DOMAIN: "sites.example.net",
    // The tests create many apps; the quota tests set their own limits.
    LAUNCHPAD_MAX_APPS: "1000",
};
const deps = (extra: Record<string, string> = {}): AppDeps => ({
    dataDir,
    settings: parseDeploymentConfig({ ...env, ...extra }),
});

const code = (promise: Promise<unknown>) =>
    promise.then(
        () => "ok",
        (e) => (e instanceof ServiceError ? e.code : `unexpected: ${e}`),
    );

async function newUser(name: string, role: "user" | "operator" = "user") {
    const id = randomUUID();
    await testDb.db
        .insertInto("user")
        .values({
            id,
            name,
            email: `${name}@example.com`,
            emailVerified: false,
            role,
        })
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

let uploads = 0;
async function artifactFor(projectId: string, who = "dee", organizationId = org) {
    uploads++;
    const bytes = tarGz([...SITE, { name: `unique-${uploads}.txt`, content: String(uploads) }]);
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(bytes);
            controller.close();
        },
    });
    return (
        await uploadArtifact(
            testDb.db,
            people[who]!,
            organizationId,
            body,
            { contentLength: bytes.length, projectId },
            { dataDir, limits: {} },
        )
    ).id;
}

let appCount = 0;
async function newApp(projectId = p1, extra: Record<string, string> = {}) {
    appCount++;
    return createApp(
        testDb.db,
        people.dee!,
        org,
        projectId,
        { slug: `site-${appCount}` },
        deps(extra),
    );
}

// Finishes a deployment so the next one for the app is allowed.
const finish = (id: string) =>
    sql`update deployment set status = 'failed', finished_at = now() where id = ${id}`.execute(
        testDb.db,
    );

beforeAll(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "launchpad-apps-"));
    testDb = await createTestDatabase();
    await testDb.migrate();
    await newUser("root", "operator");
    for (const n of ["ann", "dee", "vic", "zoe"]) await newUser(n);
    org = (
        await createOrganization(testDb.db, people.root!, {
            name: "Acme",
            slug: "acme",
            ownerEmail: "ann@example.com",
        })
    ).id;
    otherOrg = (
        await createOrganization(testDb.db, people.root!, {
            name: "Beta",
            slug: "beta",
            ownerEmail: "zoe@example.com",
        })
    ).id;
    await addMember(testDb.db, people.ann!, org, { email: "dee@example.com", role: "deployer" });
    await addMember(testDb.db, people.ann!, org, { email: "vic@example.com", role: "viewer" });
    p1 = (await createProject(testDb.db, people.ann!, org, { name: "One", slug: "one" })).id;
    p2 = (await createProject(testDb.db, people.ann!, org, { name: "Two", slug: "two" })).id;
});
beforeEach(async () => {
    // A restore marker from one test must not leak into the next.
    await fs.rm(path.join(dataDir, "maintenance"), { recursive: true, force: true });
});
afterAll(async () => {
    await testDb.destroy();
    await fs.rm(dataDir, { recursive: true, force: true });
});

describe("deployment configuration", () => {
    it("is off unless switched on, and reads nothing else while off", () => {
        expect(parseDeploymentConfig({})).toEqual({ enabled: false });
        expect(parseDeploymentConfig({ LAUNCHPAD_DEPLOYMENTS: "off" })).toEqual({
            enabled: false,
        });
        expect(parseDeploymentConfig({ LAUNCHPAD_DEPLOYMENTS: "" })).toEqual({ enabled: false });
        expect(() => parseDeploymentConfig({ LAUNCHPAD_DEPLOYMENTS: "yes" })).toThrow(
            /"on" or "off"/,
        );
    });

    it("needs only the domain and applies the documented defaults when on", () => {
        const config = parseDeploymentConfig(env);
        if (!config.enabled) throw new Error("expected enabled");
        expect([config.maxApps, config.maxDeploymentsPerApp, config.maxDeployments]).toEqual([
            1000, 20, 100,
        ]);
        const defaults = parseDeploymentConfig({ ...env, LAUNCHPAD_MAX_APPS: "" });
        if (!defaults.enabled) throw new Error("expected enabled");
        expect(defaults.maxApps).toBe(10);
        expect([config.defaultTtlSeconds, config.maxTtlSeconds]).toEqual([7 * 86_400, 30 * 86_400]);
        expect(() => parseDeploymentConfig({ LAUNCHPAD_DEPLOYMENTS: "on" })).toThrow(
            "LAUNCHPAD_APPS_DOMAIN",
        );
        expect(() =>
            parseDeploymentConfig({ ...env, LAUNCHPAD_APPS_DOMAIN: "sites.example.com" }),
        ).toThrow("different registrable domain");
        expect(() => parseDeploymentConfig({ ...env, LAUNCHPAD_MAX_PREVIEWS: "5" })).toThrow(
            "no longer used",
        );
        expect(() =>
            parseDeploymentConfig({ ...env, LAUNCHPAD_MAX_DEPLOYMENTS_PER_APP: "200" }),
        ).toThrow("cannot exceed");
        expect(() =>
            parseDeploymentConfig({
                ...env,
                LAUNCHPAD_DEFAULT_TTL: "40d",
                LAUNCHPAD_MAX_TTL: "30d",
            }),
        ).toThrow("LAUNCHPAD_DEFAULT_TTL");
        expect(() =>
            parseDeploymentConfig({ ...env, LAUNCHPAD_DEPLOYMENT_HOSTNAME_TEMPLATE: "{slug}" }),
        ).toThrow("LAUNCHPAD_DEPLOYMENT_HOSTNAME_TEMPLATE");
        const clamped = parseDeploymentConfig({ ...env, LAUNCHPAD_MAX_TTL: "2d" });
        if (!clamped.enabled) throw new Error("expected enabled");
        expect(clamped.defaultTtlSeconds).toBe(2 * 86_400);
    });
});

describe("apps", () => {
    it("lets a deployer create and read an app, audited, and refuses everyone else", async () => {
        const app = await createApp(testDb.db, people.dee!, org, p1, { slug: "website" }, deps());
        expect(app).toMatchObject({ slug: "website", projectId: p1, state: "active" });
        expect(await getApp(testDb.db, people.vic!, org, app.id)).toMatchObject({ id: app.id });
        expect((await listApps(testDb.db, people.vic!, org)).map((a) => a.id)).toContain(app.id);
        const audit = await testDb.db
            .selectFrom("audit_event")
            .select("detail")
            .where("action", "=", "app.created")
            .where("target_id", "=", app.id)
            .execute();
        expect(audit).toHaveLength(1);
        expect(
            await code(createApp(testDb.db, people.vic!, org, p1, { slug: "nope" }, deps())),
        ).toBe("forbidden");
        expect(
            await code(createApp(testDb.db, people.zoe!, org, p1, { slug: "nope" }, deps())),
        ).toBe("not-found");
        expect(await code(getApp(testDb.db, people.zoe!, otherOrg, app.id))).toBe("not-found");
        expect(
            await code(createApp(testDb.db, people.dee!, org, p1, { slug: "website" }, deps())),
        ).toBe("conflict");
        expect(
            await code(createApp(testDb.db, people.dee!, org, p1, { slug: "Bad Slug" }, deps())),
        ).toBe("invalid");
    });

    it("honors the off switch and a key's project restriction", async () => {
        expect(
            await code(
                createApp(
                    testDb.db,
                    people.dee!,
                    org,
                    p1,
                    { slug: "off" },
                    {
                        dataDir,
                        settings: { enabled: false },
                    },
                ),
            ),
        ).toBe("unavailable");
        expect(
            await code(createApp(testDb.db, people.dee!, org, p1, { slug: "r" }, deps(), [p2])),
        ).toBe("not-found");
        const app = await newApp(p1);
        expect(await code(getApp(testDb.db, people.dee!, org, app.id, [p2]))).toBe("not-found");
        expect(await code(getApp(testDb.db, people.dee!, org, app.id, [p1]))).toBe("ok");
        expect(await listApps(testDb.db, people.dee!, org, [])).toEqual([]);
        expect(
            (await listApps(testDb.db, people.dee!, org, [p2])).every((a) => a.projectId === p2),
        ).toBe(true);
    });

    it("refuses an app over the organization's quota and serializes racing creators", async () => {
        const other = (
            await createOrganization(testDb.db, people.root!, {
                name: "Quota",
                slug: "quota",
                ownerEmail: "vic@example.com",
            })
        ).id;
        const project = (
            await createProject(testDb.db, people.vic!, other, { name: "Q", slug: "q" })
        ).id;
        const limited = deps({ LAUNCHPAD_MAX_APPS: "3" });
        const results = await Promise.all(
            ["a", "b", "c", "d", "e"].map((slug) =>
                code(createApp(testDb.db, people.vic!, other, project, { slug }, limited)),
            ),
        );
        expect(results.filter((r) => r === "ok")).toHaveLength(3);
        expect(results.filter((r) => r === "conflict")).toHaveLength(2);
    });
});

describe("creating a deployment", () => {
    it("queues it with a permanent identity, reservations and a first event", async () => {
        const app = await newApp();
        const artifact = await artifactFor(p1);
        const deployment = await createDeployment(
            testDb.db,
            people.dee!,
            org,
            app.id,
            { artifactId: artifact },
            deps(),
        );
        expect(deployment).toMatchObject({ status: "queued", desiredState: "active", spa: false });
        expect(deployment.hostname).toMatch(
            new RegExp(`^${app.slug}-[a-z0-9]{10}-preview\\.sites\\.example\\.net$`),
        );
        const row = await testDb.db
            .selectFrom("deployment")
            .select(["app_name", "preview_expires_at", "requested_by"])
            .where("id", "=", deployment.id)
            .executeTakeFirstOrThrow();
        expect(row.app_name).toMatch(/^lp-[a-z0-9]{10}$/);
        expect(row.requested_by).toBe(people.dee!.userId);
        const days = (row.preview_expires_at.getTime() - Date.now()) / 86_400_000;
        expect(days).toBeGreaterThan(6.9);
        expect(days).toBeLessThan(7.1);
        const reservations = await sql<{ n: number }>`
            select (select count(*) from hostname_reservation where owner_id = ${deployment.id})
                 + (select count(*) from dokku_name_reservation where owner_id = ${deployment.id}) as n`.execute(
            testDb.db,
        );
        expect(Number(reservations.rows[0]!.n)).toBe(2);
        const events = await listDeploymentEvents(testDb.db, people.vic!, org, deployment.id);
        expect(events).toMatchObject([{ seq: 1, phase: "queued", level: "info" }]);
        expect(await getDeployment(testDb.db, people.vic!, org, deployment.id)).toMatchObject({
            id: deployment.id,
        });
        expect(
            (await listDeployments(testDb.db, people.vic!, org, app.id)).map((d) => d.id),
        ).toEqual([deployment.id]);
    });

    it("applies the ttl: shorter is allowed, longer than the maximum is refused", async () => {
        const app = await newApp();
        const artifact = await artifactFor(p1);
        expect(
            await code(
                createDeployment(
                    testDb.db,
                    people.dee!,
                    org,
                    app.id,
                    { artifactId: artifact, ttl: "31d" },
                    deps(),
                ),
            ),
        ).toBe("invalid");
        const short = await createDeployment(
            testDb.db,
            people.dee!,
            org,
            app.id,
            { artifactId: artifact, ttl: "1h", spa: true },
            deps(),
        );
        expect(short.spa).toBe(true);
        const stored = await testDb.db
            .selectFrom("deployment")
            .select("preview_expires_at")
            .where("id", "=", short.id)
            .executeTakeFirstOrThrow();
        expect(stored.preview_expires_at.getTime() - Date.now()).toBeLessThan(3_700_000);
    });

    it("refuses a second unfinished deployment and allows one after it finishes", async () => {
        const app = await newApp();
        const artifact = await artifactFor(p1);
        const first = await createDeployment(
            testDb.db,
            people.dee!,
            org,
            app.id,
            { artifactId: artifact },
            deps(),
        );
        expect(
            await code(
                createDeployment(
                    testDb.db,
                    people.dee!,
                    org,
                    app.id,
                    { artifactId: artifact },
                    deps(),
                ),
            ),
        ).toBe("conflict");
        await finish(first.id);
        const second = await createDeployment(
            testDb.db,
            people.dee!,
            org,
            app.id,
            { artifactId: artifact },
            deps(),
        );
        expect(second.id).not.toBe(first.id);
        // Two deployments never share a remote identity.
        const names = await sql<{ app_name: string; hostname: string }>`
            select app_name, hostname from deployment where app_id = ${app.id}`.execute(testDb.db);
        expect(new Set(names.rows.map((r) => r.app_name)).size).toBe(2);
        expect(new Set(names.rows.map((r) => r.hostname)).size).toBe(2);
    });

    it("serializes racing requests for one app: exactly one is accepted", async () => {
        const app = await newApp();
        const artifact = await artifactFor(p1);
        const results = await Promise.all(
            Array.from({ length: 6 }, () =>
                code(
                    createDeployment(
                        testDb.db,
                        people.dee!,
                        org,
                        app.id,
                        { artifactId: artifact },
                        deps(),
                    ),
                ),
            ),
        );
        expect(results.filter((r) => r === "ok")).toHaveLength(1);
        expect(results.filter((r) => r === "conflict")).toHaveLength(5);
    });

    it("enforces the per-app and per-organization deployment quotas", async () => {
        const app = await newApp();
        const artifact = await artifactFor(p1);
        const perApp = deps({ LAUNCHPAD_MAX_DEPLOYMENTS_PER_APP: "2" });
        for (let i = 0; i < 2; i++) {
            const d = await createDeployment(
                testDb.db,
                people.dee!,
                org,
                app.id,
                { artifactId: artifact },
                perApp,
            );
            await finish(d.id);
        }
        expect(
            await code(
                createDeployment(
                    testDb.db,
                    people.dee!,
                    org,
                    app.id,
                    { artifactId: artifact },
                    perApp,
                ),
            ),
        ).toBe("conflict");
        // The organization total counts every app; a tiny limit is already exceeded.
        const another = await newApp();
        expect(
            await code(
                createDeployment(
                    testDb.db,
                    people.dee!,
                    org,
                    another.id,
                    { artifactId: artifact },
                    deps({
                        LAUNCHPAD_MAX_DEPLOYMENTS: "1",
                        LAUNCHPAD_MAX_DEPLOYMENTS_PER_APP: "1",
                    }),
                ),
            ),
        ).toBe("conflict");
    });

    it("checks authority, the artifact's organization and the off switch", async () => {
        const app = await newApp();
        const artifact = await artifactFor(p1);
        const foreign = await artifactFor(
            (await createProject(testDb.db, people.zoe!, otherOrg, { name: "F", slug: "f" })).id,
            "zoe",
            otherOrg,
        );
        const create = (who: string, artifactId: string, d = deps()) =>
            code(createDeployment(testDb.db, people[who]!, org, app.id, { artifactId }, d));
        expect(await create("vic", artifact)).toBe("forbidden");
        expect(await create("zoe", artifact)).toBe("not-found");
        expect(await create("dee", foreign)).toBe("not-found");
        expect(await create("dee", randomUUID())).toBe("not-found");
        expect(await create("dee", artifact, { dataDir, settings: { enabled: false } })).toBe(
            "unavailable",
        );
        expect(
            await code(
                createDeployment(
                    testDb.db,
                    people.dee!,
                    org,
                    randomUUID(),
                    { artifactId: artifact },
                    deps(),
                ),
            ),
        ).toBe("not-found");
    });

    it("lets a project-restricted key use only artifacts uploaded through the app's project", async () => {
        // Two keys with the same creator, restricted to different projects.
        const app1 = await newApp(p1);
        const app2 = await newApp(p2);
        const through2 = await artifactFor(p2);
        const attempt = (appId: string, artifactId: string, restrictTo: string[] | null) =>
            code(
                createDeployment(
                    testDb.db,
                    people.dee!,
                    org,
                    appId,
                    { artifactId },
                    deps(),
                    restrictTo,
                ),
            );
        // The key for project 1 cannot use project 2's upload, even though the creator is the same.
        expect(await attempt(app1.id, through2, [p1])).toBe("not-found");
        // A key for project 2 cannot reach the app in project 1 at all.
        expect(await attempt(app1.id, through2, [p2])).toBe("not-found");
        expect(await attempt(app2.id, through2, [p2])).toBe("ok");
        // An unrestricted key (or a session) needs only the organization match.
        const finishedApp = await newApp(p1);
        expect(await attempt(finishedApp.id, through2, null)).toBe("ok");
        // The same bytes uploaded through project 1 as well make it usable there.
        const reupload = await artifactFor(p1);
        expect(await attempt(app1.id, reupload, [p1])).toBe("ok");
        // An older artifact with no provenance is refused to restricted keys only.
        const legacy = await testDb.db
            .insertInto("artifact")
            .values({
                organization_id: org,
                digest: "e".repeat(64),
                size_bytes: 10,
                expanded_bytes: 10,
                entry_count: 1,
                storage_key: "legacy",
                created_by: people.dee!.userId,
            })
            .returning("id")
            .executeTakeFirstOrThrow();
        const legacyApp = await newApp(p1);
        expect(await attempt(legacyApp.id, legacy.id, [p1])).toBe("not-found");
        expect(await attempt(legacyApp.id, legacy.id, null)).toBe("ok");
    });

    it("refuses while model recovery is blocked, and records the writer first", async () => {
        const app = await newApp();
        const artifact = await artifactFor(p1);
        await markDeploymentRecoveryBlocked(dataDir);
        await expect(
            createDeployment(testDb.db, people.dee!, org, app.id, { artifactId: artifact }, deps()),
        ).rejects.toThrow(/recovery is blocked/i);
        expect(
            await testDb.db
                .selectFrom("deployment")
                .select("id")
                .where("app_id", "=", app.id)
                .execute(),
        ).toEqual([]);
    });

    it("hides deployments and events of other organizations and projects", async () => {
        const app = await newApp(p1);
        const artifact = await artifactFor(p1);
        const deployment = await createDeployment(
            testDb.db,
            people.dee!,
            org,
            app.id,
            { artifactId: artifact },
            deps(),
        );
        expect(await code(getDeployment(testDb.db, people.zoe!, org, deployment.id))).toBe(
            "not-found",
        );
        expect(await code(getDeployment(testDb.db, people.zoe!, otherOrg, deployment.id))).toBe(
            "not-found",
        );
        expect(await code(getDeployment(testDb.db, people.vic!, org, deployment.id, [p2]))).toBe(
            "not-found",
        );
        expect(
            await code(listDeploymentEvents(testDb.db, people.vic!, org, deployment.id, {}, [p2])),
        ).toBe("not-found");
        expect(await code(listDeployments(testDb.db, people.vic!, org, app.id, [p2]))).toBe(
            "not-found",
        );
        expect(
            await listDeploymentEvents(testDb.db, people.vic!, org, deployment.id, { afterSeq: 1 }),
        ).toEqual([]);
    });
});
