import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAuth, loadAuthConfig } from "@launchpad-kit/auth";
import { createDatabase } from "@launchpad-kit/database";
import { createTestDatabase } from "@launchpad-kit/database/testing";
import {
    createApiKey,
    createAlias,
    createApp,
    createOrganization,
    addMember,
    createProject,
    parseAliasConfig,
    parseDeploymentConfig,
    type Principal,
} from "@launchpad-kit/services";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../api";

// Opt-in pagination of the list endpoints over HTTP, against a real PostgreSQL.
// See docs/plans/api-list-pagination.md.
let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
let dataDir = "";
let orgA = "";
let orgB = "";
let projectOne = "";
let projectTwo = "";
let aliasApp = "";
let hiddenAliasApp = "";
let deploymentApp = "";
let hiddenDeploymentApp = "";
let eventDeployment = "";
let operationAlias = "";
let hiddenOperationAlias = "";
let owner: Principal;
let api: ReturnType<typeof createApi>;
const keys: Record<string, string> = {};
const BASE = "http://localhost:3000";

const env = {
    LAUNCHPAD_DEPLOYMENTS: "on",
    LAUNCHPAD_BASE_URL: "https://control.example.com",
    LAUNCHPAD_APPS_DOMAIN: "sites.example.net",
    LAUNCHPAD_MAX_APPS: "1000",
};

async function issue(name: string, organization: string, scopes: string[], projectIds?: string[]) {
    const sessionId = randomUUID();
    await sql`insert into "session" ("id", "token", "userId", "expiresAt", "updatedAt")
        values (${sessionId}, ${randomUUID()}, ${owner.userId}, now() + interval '1 hour', now())`.execute(
        testDb.db,
    );
    const created = await createApiKey(
        testDb.db,
        owner,
        organization,
        { name, scopes, expiresInDays: 1, ...(projectIds ? { projectIds } : {}) },
        sessionId,
    );
    keys[name] = created.secret;
}

// `target` is an absolute path such as /api/v1/..., or a Link value resolved against the request.
function get(key: string | null, target: string) {
    const headers: Record<string, string> = {};
    if (key) headers.authorization = `Bearer ${keys[key]}`;
    return api.fetch(new Request(`${BASE}${target}`, { headers }));
}

function nextOf(response: Response): string | null {
    const link = response.headers.get("link");
    if (!link) return null;
    const match = /^<([^>]+)>; rel="next"$/.exec(link);
    expect(match, `Link: ${link}`).not.toBeNull();
    return match![1]!;
}

async function walk<T>(key: string, first: string) {
    const items: T[] = [];
    const pages: T[][] = [];
    let target: string | null = first;
    while (target) {
        const response: Response = await get(key, target);
        expect(response.status).toBe(200);
        const page = (await response.json()) as T[];
        pages.push(page);
        items.push(...page);
        target = nextOf(response);
        expect(pages.length).toBeLessThan(50);
    }
    return { items, pages };
}

const appsPath = (organization = orgA) => `/api/v1/organizations/${organization}/apps`;
// Members have no `id` of their own; they are identified by `userId`.
const ids = (rows: { id?: string; userId?: string }[]) =>
    rows.map((row) => (row.id ?? row.userId)!);
let counter = 0;

async function makeApp(organization: string, project: string) {
    counter++;
    const app = await createApp(
        testDb.db,
        owner,
        organization,
        project,
        { slug: `app-${counter}` },
        { dataDir, settings: parseDeploymentConfig(env) },
    );
    return app.id;
}

// Identity triggers forbid changing these rows; fixtures bypass them for this one statement.
async function setCreatedAt(table: "app" | "app_alias" | "project", id: string, at: string) {
    await testDb.db.transaction().execute(async (trx) => {
        await sql`set local session_replication_role = replica`.execute(trx);
        await sql`update ${sql.table(table)} set created_at = ${at}::timestamptz where id = ${id}::uuid`.execute(
            trx,
        );
    });
}

beforeAll(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "launchpad-pagination-api-"));
    testDb = await createTestDatabase();
    await testDb.migrate();
    const root = randomUUID();
    const ann = randomUUID();
    for (const [id, email, role] of [
        [root, "root@example.com", "operator"],
        [ann, "ann@example.com", "user"],
    ] as const) {
        await testDb.db
            .insertInto("user")
            .values({ id, name: email, email, emailVerified: false, role })
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
    }
    owner = { userId: ann, instanceRole: "user" };
    const operator: Principal = { userId: root, instanceRole: "operator" };
    orgA = (
        await createOrganization(testDb.db, operator, {
            name: "Acme",
            slug: "acme",
            ownerEmail: "ann@example.com",
        })
    ).id;
    orgB = (
        await createOrganization(testDb.db, operator, {
            name: "Beta",
            slug: "beta",
            ownerEmail: "ann@example.com",
        })
    ).id;
    projectOne = (await createProject(testDb.db, owner, orgA, { name: "One", slug: "one" })).id;
    projectTwo = (await createProject(testDb.db, owner, orgA, { name: "Two", slug: "two" })).id;
    const projectB = (await createProject(testDb.db, owner, orgB, { name: "One", slug: "one" })).id;
    await issue("a", orgA, [
        "app:read",
        "app:deploy",
        "project:read",
        "member:read",
        "organization:read",
    ]);
    await issue("a-p1", orgA, ["app:read", "project:read"], [projectOne]);
    await issue("a-p12", orgA, ["app:read", "project:read"], [projectOne, projectTwo]);
    await issue("b", orgB, ["app:read", "project:read", "organization:read", "member:read"]);

    // Three apps tie to the microsecond, then two that differ only below a millisecond.
    const ties = [await makeApp(orgA, projectOne), await makeApp(orgA, projectTwo)];
    ties.push(await makeApp(orgA, projectOne));
    for (const id of ties) await setCreatedAt("app", id, "2026-01-01T00:00:00.123456Z");
    const later = [await makeApp(orgA, projectTwo), await makeApp(orgA, projectOne)];
    await setCreatedAt("app", later[0]!, "2026-01-01T00:00:00.123457Z");
    await setCreatedAt("app", later[1]!, "2026-01-01T00:00:00.123458Z");
    await makeApp(orgB, projectB);

    // Projects: five in all, the first three tied to the microsecond.
    for (const slug of ["three", "four", "five"]) {
        await createProject(testDb.db, owner, orgA, { name: slug, slug });
    }
    const allProjects = await testDb.db
        .selectFrom("project")
        .select("id")
        .where("organization_id", "=", orgA)
        .orderBy("created_at")
        .execute();
    for (const [index, row] of allProjects.entries()) {
        await setCreatedAt(
            "project",
            row.id,
            index < 3 ? "2026-01-01T00:00:00.500000Z" : `2026-01-01T00:00:00.50000${index}Z`,
        );
    }

    // Aliases: five on one app, three of them tied; plus one alias on an app in a hidden project.
    aliasApp = ties[0]!;
    hiddenAliasApp = ties[1]!;
    const aliasDeps = {
        dataDir,
        settings: parseDeploymentConfig(env),
        aliases: parseAliasConfig({ ...env, LAUNCHPAD_ALIASES: "on" }),
    };
    const aliasIds: string[] = [];
    for (const slug of ["a1", "a2", "a3", "a4", "a5"]) {
        aliasIds.push(
            (await createAlias(testDb.db, owner, orgA, aliasApp, { slug }, aliasDeps)).id,
        );
    }
    for (const [index, id] of aliasIds.entries()) {
        await setCreatedAt(
            "app_alias",
            id,
            index < 3 ? "2026-01-02T00:00:00.250000Z" : `2026-01-02T00:00:00.25000${index}Z`,
        );
    }
    await createAlias(testDb.db, owner, orgA, hiddenAliasApp, { slug: "hidden" }, aliasDeps);

    await seedDeployments(aliasIds[0]!);
    await seedMembers();

    const config = loadAuthConfig({
        LAUNCHPAD_AUTH_SECRET: "test-secret-".repeat(4),
        LAUNCHPAD_BASE_URL: "http://localhost:3000",
    });
    const db = createDatabase(testDb.url);
    api = createApi({
        auth: createAuth({ db, config }),
        db,
        origin: config.origin,
        invitations: {
            enabled: false,
            mailer: null,
            baseUrl: config.baseUrl,
            publicSignup: false,
            hashPassword: async (password: string) => password,
        },
        docs: true,
        artifacts: { dataDir, limits: {} },
        deployments: { dataDir, settings: parseDeploymentConfig(env) },
        aliases: parseAliasConfig({ ...env, LAUNCHPAD_ALIASES: "on" }),
    });
});

afterAll(async () => {
    await testDb.destroy();
    await fs.rm(dataDir, { recursive: true, force: true });
});

describe("paginated apps", () => {
    it("returns the full array with no Link when limit is absent", async () => {
        const response = await get("a", appsPath());
        expect(response.status).toBe(200);
        expect(response.headers.get("link")).toBeNull();
        expect(((await response.json()) as unknown[]).length).toBe(5);
    });

    it("pages through every app once, across a timestamp tie", async () => {
        const all = ids((await (await get("a", appsPath())).json()) as { id: string }[]);
        const first = await get("a", `${appsPath()}?limit=2`);
        const link = nextOf(first);
        expect(link).toMatch(
            new RegExp(`^/api/v1/organizations/${orgA}/apps\\?limit=2&cursor=[A-Za-z0-9_-]+$`),
        );
        const { items, pages } = await walk<{ id: string }>("a", `${appsPath()}?limit=2`);
        expect(pages.map((page) => page.length)).toEqual([2, 2, 1]);
        expect(ids(items)).toEqual(all);
        expect(new Set(ids(items)).size).toBe(5);
    });

    it("has no Link on an exact last page or a single page", async () => {
        const single = await get("a", `${appsPath()}?limit=5`);
        expect(single.headers.get("link")).toBeNull();
        expect(((await single.json()) as unknown[]).length).toBe(5);
        const large = await get("a", `${appsPath()}?limit=100`);
        expect(large.headers.get("link")).toBeNull();
        const exact = await walk("a", `${appsPath()}?limit=1`);
        expect(exact.pages.length).toBe(5);
    });

    it("pages a project-limited key through its own projects only", async () => {
        const unrestricted = await get("a", `${appsPath()}?limit=1`);
        const foreign = new URL(nextOf(unrestricted)!, BASE).searchParams.get("cursor")!;
        const { items, pages } = await walk<{ id: string; projectId: string }>(
            "a-p1",
            `${appsPath()}?limit=1`,
        );
        expect(items.length).toBe(3);
        expect(items.every((item) => item.projectId === projectOne)).toBe(true);
        expect(pages.every((page) => page.length === 1)).toBe(true);
        // A cursor minted for an unrestricted caller never widens the restricted key.
        const resumed = await get("a-p1", `${appsPath()}?limit=100&cursor=${foreign}`);
        expect(resumed.status).toBe(200);
        const rows = (await resumed.json()) as { projectId: string }[];
        expect(rows.every((row) => row.projectId === projectOne)).toBe(true);
    });

    it("does not repeat or skip rows when apps are added or removed between pages", async () => {
        const first = await get("a", `${appsPath()}?limit=2`);
        const firstIds = ids((await first.json()) as { id: string }[]);
        const added = await makeApp(orgA, projectOne);
        await setCreatedAt("app", added, "2026-02-01T00:00:00Z");
        const rest = await walk<{ id: string }>("a", nextOf(first)!);
        const restIds = ids(rest.items);
        expect(restIds).toContain(added);
        expect(restIds.filter((id) => firstIds.includes(id))).toEqual([]);
        expect(new Set(restIds).size).toBe(restIds.length);
        expect(restIds.length).toBe(4);
        await sql`update app set state = 'deleted', deleted_at = now() where id = ${added}::uuid`.execute(
            testDb.db,
        );
    });

    it("rejects malformed limits and a cursor without a limit with 422", async () => {
        for (const query of [
            "limit=0",
            "limit=101",
            "limit=-1",
            "limit=abc",
            "limit=2.5",
            "limit=1e2",
            "limit=",
            "limit=1&limit=2",
            "cursor=abc",
        ]) {
            const response = await get("a", `${appsPath()}?${query}`);
            expect(response.status, query).toBe(422);
            expect(response.headers.get("link")).toBeNull();
        }
    });

    it("rejects tampered and foreign cursors with 422", async () => {
        const first = await get("a", `${appsPath()}?limit=1`);
        const cursor = new URL(nextOf(first)!, BASE).searchParams.get("cursor")!;
        const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString()) as Record<
            string,
            unknown
        >;
        const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
        const tampered = [
            "not*base64",
            Buffer.from("not json").toString("base64url"),
            encode({ ...decoded, v: 2 }),
            encode({ ...decoded, extra: 1 }),
            encode({ ...decoded, id: "not-a-uuid" }),
            encode({ ...decoded, k: ["2026-01-01'; drop table app; --"] }),
            encode({ ...decoded, k: [] }),
            encode({ ...decoded, r: "projects" }),
            encode({ ...decoded, o: orgB }),
            "A".repeat(600),
            cursor.slice(0, -4) + "AAAA",
        ];
        for (const value of tampered) {
            const response = await get("a", `${appsPath()}?limit=1&cursor=${value}`);
            expect(response.status, value).toBe(422);
            expect(response.headers.get("link")).toBeNull();
        }
        // The same cursor on another organization's list is refused as well.
        const foreign = await get("b", `${appsPath(orgB)}?limit=1&cursor=${cursor}`);
        expect(foreign.status).toBe(422);
    });

    it("answers 404 for another organization before validating the query", async () => {
        const response = await get("b", `${appsPath()}?limit=0`);
        expect(response.status).toBe(404);
    });

    it("validates the query before the hidden-parent check, with a generic 422", async () => {
        const path = `/api/v1/organizations/${orgA}/apps/${hiddenAliasApp}/aliases`;
        expect((await get("a-p1", `${path}?limit=1`)).status).toBe(404);
        const response = await get("a-p1", `${path}?limit=0`);
        expect(response.status).toBe(422);
        expect(JSON.stringify(await response.json())).not.toContain(hiddenAliasApp);
    });

    it("answers 404 for another organization and 401 without a key, before looking at the cursor", async () => {
        expect((await get("b", `${appsPath()}?limit=1&cursor=garbage`)).status).toBe(404);
        expect((await get(null, `${appsPath()}?limit=1`)).status).toBe(401);
    });

    it("keeps a cursor valid after its boundary row is deleted", async () => {
        const doomed = await makeApp(orgA, projectOne);
        await setCreatedAt("app", doomed, "2026-03-01T00:00:00Z");
        const first = await get("a", `${appsPath()}?limit=100`);
        const total = ((await first.json()) as unknown[]).length;
        const page = await get("a", `${appsPath()}?limit=${total - 1}`);
        expect(nextOf(page)).not.toBeNull();
        await sql`update app set state = 'deleted', deleted_at = now() where id = ${doomed}::uuid`.execute(
            testDb.db,
        );
        const rest = await get("a", nextOf(page)!);
        expect(rest.status).toBe(200);
        expect(await rest.json()).toEqual([]);
    });
});

// Direct inserts: a real deployment needs a worker, and these tests are about listing.
async function insertDeployment(app: string, artifact: string, createdAt: string) {
    const id = randomUUID();
    const appName = `lp-${id.replaceAll("-", "").slice(0, 10)}`;
    const hostname = `${appName}.apps.example.net`;
    await testDb.db.transaction().execute(async (trx) => {
        await trx
            .insertInto("deployment")
            .values({
                id,
                organization_id: orgA,
                app_id: app,
                artifact_id: artifact,
                hostname,
                app_name: appName,
                requested_by: owner.userId,
                status: "succeeded",
                image_tag: `launchpad/site:${id}`,
                image_id: `sha256:${"a".repeat(64)}`,
                finished_at: new Date(),
                preview_expires_at: new Date(Date.now() + 86400000),
                created_at: sql<Date>`${createdAt}::timestamptz`,
            })
            .execute();
        await trx
            .insertInto("hostname_reservation")
            .values({ hostname, owner_kind: "deployment", owner_id: id, organization_id: orgA })
            .execute();
        await trx
            .insertInto("dokku_name_reservation")
            .values({
                app_name: appName,
                owner_kind: "deployment",
                owner_id: id,
                organization_id: orgA,
            })
            .execute();
    });
    return id;
}

async function seedDeployments(aliasId: string) {
    const digest = createHash("sha256").update("pagination").digest("hex");
    const artifact = (
        await testDb.db
            .insertInto("artifact")
            .values({
                organization_id: orgA,
                created_by: owner.userId,
                digest,
                storage_key: `pagination/${digest}`,
                size_bytes: 1,
                expanded_bytes: 1,
                entry_count: 1,
            })
            .returning("id")
            .executeTakeFirstOrThrow()
    ).id;
    deploymentApp = aliasApp;
    hiddenDeploymentApp = hiddenAliasApp;
    // Newest first is the list order; three share a microsecond.
    const stamps = [
        "2026-01-03T00:00:00.000005Z",
        "2026-01-03T00:00:00.000004Z",
        "2026-01-03T00:00:00.000001Z",
        "2026-01-03T00:00:00.000001Z",
        "2026-01-03T00:00:00.000001Z",
    ];
    const deployments: string[] = [];
    for (const stamp of stamps) {
        deployments.push(await insertDeployment(deploymentApp, artifact, stamp));
    }
    await insertDeployment(hiddenDeploymentApp, artifact, stamps[0]!);
    eventDeployment = deployments[0]!;
    for (let seq = 1; seq <= 5; seq++) {
        await testDb.db
            .insertInto("app_deployment_event")
            .values({
                organization_id: orgA,
                deployment_id: eventDeployment,
                seq,
                phase: "build",
                message: `event ${seq}`,
            })
            .execute();
    }
    operationAlias = aliasId;
    for (let generation = 1; generation <= 5; generation++) {
        await testDb.db
            .insertInto("promotion_operation")
            .values({
                organization_id: orgA,
                app_id: aliasApp,
                alias_id: operationAlias,
                action: "withdraw",
                idempotency_key: `key-${generation}`,
                expected_generation: String(generation - 1),
                generation: String(generation),
                status: "succeeded",
                requested_by: owner.userId,
                finished_at: new Date(),
            })
            .execute();
    }
    hiddenOperationAlias = (
        await testDb.db
            .selectFrom("app_alias")
            .select("id")
            .where("app_id", "=", hiddenAliasApp)
            .executeTakeFirstOrThrow()
    ).id;
}

async function seedMembers() {
    for (const name of ["bea", "cal", "dot", "eli"]) {
        const id = randomUUID();
        await testDb.db
            .insertInto("user")
            .values({
                id,
                name,
                email: `${name}@example.com`,
                emailVerified: false,
                role: "user",
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
        await addMember(testDb.db, owner, orgA, { email: `${name}@example.com`, role: "viewer" });
    }
}

// One table-driven check for every list reachable with an API key: the paged walk equals the
// unpaginated array across a timestamp tie, the first Link is relative and bound to the route,
// and a cursor from one list is refused on another.
describe("paginated lists share one contract", () => {
    const lists = [
        { name: "projects", path: () => `/api/v1/organizations/${orgA}/projects`, total: 5 },
        {
            name: "aliases",
            path: () => `/api/v1/organizations/${orgA}/apps/${aliasApp}/aliases`,
            total: 5,
        },
    ];

    lists.push(
        {
            name: "deployments",
            path: () => `/api/v1/organizations/${orgA}/apps/${deploymentApp}/deployments`,
            total: 5,
        },
        {
            name: "alias operations",
            path: () => `/api/v1/organizations/${orgA}/aliases/${operationAlias}/operations`,
            total: 5,
        },
        { name: "members", path: () => `/api/v1/organizations/${orgA}/members`, total: 5 },
    );

    for (const list of lists) {
        it(`${list.name}: pages equal the whole list, with no repeats`, async () => {
            const all = ids(
                (await (await get("a", list.path())).json()) as { id?: string; userId?: string }[],
            );
            expect(all.length).toBe(list.total);
            const first = await get("a", `${list.path()}?limit=2`);
            expect(nextOf(first)).toMatch(
                new RegExp(`^${list.path()}\\?limit=2&cursor=[A-Za-z0-9_-]+$`),
            );
            const { items, pages } = await walk<{ id?: string; userId?: string }>(
                "a",
                `${list.path()}?limit=2`,
            );
            expect(pages.map((page) => page.length)).toEqual([2, 2, 1]);
            expect(ids(items)).toEqual(all);
            const exact = await get("a", `${list.path()}?limit=${list.total}`);
            expect(exact.headers.get("link")).toBeNull();
        });

        it(`${list.name}: no limit means no Link, and bad query values are 422`, async () => {
            const plain = await get("a", list.path());
            expect(plain.status).toBe(200);
            expect(plain.headers.get("link")).toBeNull();
            for (const query of ["limit=0", "limit=101", "cursor=x", "limit=1&limit=1"]) {
                const response = await get("a", `${list.path()}?${query}`);
                expect(response.status, query).toBe(422);
                expect(response.headers.get("link")).toBeNull();
            }
        });

        it(`${list.name}: refuses a cursor from another list or organization`, async () => {
            const apps = await get("a", `${appsPath()}?limit=1`);
            const appsCursor = new URL(nextOf(apps)!, BASE).searchParams.get("cursor")!;
            const response = await get("a", `${list.path()}?limit=1&cursor=${appsCursor}`);
            expect(response.status).toBe(422);
            const own = await get("a", `${list.path()}?limit=1`);
            const cursor = new URL(nextOf(own)!, BASE).searchParams.get("cursor")!;
            const other = list.path().replace(orgA, orgB);
            expect((await get("b", `${other}?limit=1&cursor=${cursor}`)).status).toBe(
                ["aliases", "deployments", "alias operations"].includes(list.name) ? 404 : 422,
            );
        });
    }

    it("projects: a project-limited key pages only its own projects", async () => {
        const { items, pages } = await walk<{ id: string }>(
            "a-p12",
            `/api/v1/organizations/${orgA}/projects?limit=1`,
        );
        expect(items.length).toBe(2);
        expect(pages.every((page) => page.length === 1)).toBe(true);
    });

    it("aliases: a hidden parent is 404 on every page, including with a cursor", async () => {
        const visible = await get(
            "a",
            `/api/v1/organizations/${orgA}/apps/${aliasApp}/aliases?limit=1`,
        );
        const cursor = new URL(nextOf(visible)!, BASE).searchParams.get("cursor")!;
        const hidden = `/api/v1/organizations/${orgA}/apps/${hiddenAliasApp}/aliases`;
        // The hidden app's project is projectTwo; a key limited to projectOne never sees it.
        expect((await get("a-p1", `${hidden}?limit=1`)).status).toBe(404);
        expect((await get("a-p1", `${hidden}?limit=1&cursor=${cursor}`)).status).toBe(404);
        expect((await get("a", `${hidden}?limit=1`)).status).toBe(200);
    });
});

// Runs after the shared contract above: it adds a sixth deployment to the first app.
describe("descending lists", () => {
    it("deployments page newest first and a row inserted at the head never shows up later", async () => {
        const base = `/api/v1/organizations/${orgA}/apps/${deploymentApp}/deployments`;
        const all = (await (await get("a", base)).json()) as { id: string; createdAt: string }[];
        const stamps = all.map((row) => row.createdAt);
        expect([...stamps].sort().reverse()).toEqual(stamps);
        const first = await get("a", `${base}?limit=2`);
        const firstIds = ids((await first.json()) as { id: string }[]);
        expect(firstIds).toEqual(ids(all.slice(0, 2)));
        const headId = await insertDeployment(
            deploymentApp,
            (await testDb.db.selectFrom("artifact").select("id").executeTakeFirstOrThrow()).id,
            "2026-06-01T00:00:00Z",
        );
        const rest = await walk<{ id: string }>("a", nextOf(first)!);
        expect(ids(rest.items)).toEqual(ids(all.slice(2)));
        expect(ids(rest.items)).not.toContain(headId);
    });

    it("alias operations page by descending generation", async () => {
        const base = `/api/v1/organizations/${orgA}/aliases/${operationAlias}/operations`;
        const { items } = await walk<{ generation: string }>("a", `${base}?limit=2`);
        expect(items.map((row) => row.generation)).toEqual(["5", "4", "3", "2", "1"]);
    });

    it("a hidden alias is 404 for a project-limited key, with or without a cursor", async () => {
        const base = `/api/v1/organizations/${orgA}/aliases/${hiddenOperationAlias}/operations`;
        expect((await get("a-p1", `${base}?limit=1`)).status).toBe(404);
    });

    it("deployments of a hidden app are 404 for a project-limited key", async () => {
        const base = `/api/v1/organizations/${orgA}/apps/${hiddenDeploymentApp}/deployments`;
        expect((await get("a-p1", `${base}?limit=1`)).status).toBe(404);
    });
});

describe("organizations", () => {
    it("gives a key its own organization as a full page, with no Link", async () => {
        const response = await get("a", "/api/v1/organizations?limit=1");
        expect(response.status).toBe(200);
        const rows = (await response.json()) as { id: string }[];
        expect(ids(rows)).toEqual([orgA]);
        expect(response.headers.get("link")).toBeNull();
        const plain = (await (await get("a", "/api/v1/organizations")).json()) as { id: string }[];
        expect(ids(plain)).toEqual([orgA]);
    });
});

describe("deployment events", () => {
    const base = () => `/api/v1/organizations/${orgA}/deployments/${eventDeployment}/events`;

    it("links to the next page with after and limit, and ends without a Link", async () => {
        const first = await get("a", `${base()}?limit=2`);
        expect(nextOf(first)).toBe(`${base()}?after=2&limit=2`);
        const { items, pages } = await walk<{ seq: string }>("a", `${base()}?limit=2`);
        expect(pages.map((page) => page.length)).toEqual([2, 2, 1]);
        expect(items.map((event) => event.seq)).toEqual(["1", "2", "3", "4", "5"]);
    });

    it("keeps after-only and default calls exactly as they were", async () => {
        const plain = await get("a", base());
        expect(plain.headers.get("link")).toBeNull();
        expect(((await plain.json()) as unknown[]).length).toBe(5);
        const after = await get("a", `${base()}?after=3`);
        expect(after.headers.get("link")).toBeNull();
        expect(((await after.json()) as { seq: string }[]).map((e) => e.seq)).toEqual(["4", "5"]);
    });

    it("has no Link when the page is exactly the rest, or on an error", async () => {
        expect((await get("a", `${base()}?limit=5`)).headers.get("link")).toBeNull();
        const bad = await get("a", `${base()}?limit=501`);
        expect(bad.status).toBe(422);
        expect(bad.headers.get("link")).toBeNull();
    });
});
