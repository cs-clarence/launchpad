import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAuth, loadAuthConfig } from "@launchpad-kit/auth";
import { createDatabase } from "@launchpad-kit/database";
import { createTestDatabase } from "@launchpad-kit/database/testing";
import {
    appSchema,
    artifactSchema,
    createApiKey,
    createOrganization,
    createProject,
    deploymentEventSchema,
    deploymentSchema,
    errorSchema,
    parseDeploymentConfig,
    type Principal,
} from "@launchpad-kit/services";
import { SITE, tarGz } from "@launchpad-kit/services/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createApi } from "../api";

// The HTTP adapter against a real PostgreSQL: scopes, project restriction, framing, the off
// switch and response shapes, through bearer API keys exactly as automation sends them.
let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
let dataDir = "";
let org = "";
let p1 = "";
let p2 = "";
let owner: Principal;
let api: ReturnType<typeof createApi>;
let offApi: ReturnType<typeof createApi>;
const keys: Record<string, string> = {};
const BASE = "http://localhost:3000";

const env = {
    LAUNCHPAD_DEPLOYMENTS: "on",
    LAUNCHPAD_BASE_URL: "https://control.example.com",
    LAUNCHPAD_APPS_DOMAIN: "sites.example.net",
    LAUNCHPAD_MAX_APPS: "1000",
};

async function issue(name: string, scopes: string[], projectIds?: string[]) {
    const sessionId = randomUUID();
    await sql`insert into "session" ("id", "token", "userId", "expiresAt", "updatedAt")
        values (${sessionId}, ${randomUUID()}, ${owner.userId}, now() + interval '1 hour', now())`.execute(
        testDb.db,
    );
    const created = await createApiKey(
        testDb.db,
        owner,
        org,
        { name, scopes, expiresInDays: 1, ...(projectIds ? { projectIds } : {}) },
        sessionId,
    );
    keys[name] = created.secret;
}

function call(
    instance: ReturnType<typeof createApi>,
    key: string | null,
    method: string,
    pathname: string,
    options: { body?: unknown; raw?: Uint8Array; headers?: Record<string, string> } = {},
) {
    const headers: Record<string, string> = { ...options.headers };
    if (key) headers.authorization = `Bearer ${keys[key]}`;
    let body: BodyInit | undefined;
    if (options.raw) {
        body = options.raw as unknown as BodyInit;
        headers["content-length"] ??= String(options.raw.byteLength);
        headers["content-type"] ??= "application/gzip";
    } else if (options.body !== undefined) {
        body = JSON.stringify(options.body);
        // A fetch Request built in process has no length of its own; clients send one.
        headers["content-length"] = String(Buffer.byteLength(body));
        headers["content-type"] = "application/json";
    }
    return instance.fetch(new Request(`${BASE}/api${pathname}`, { method, headers, body }));
}

const base = () => `/v1/organizations/${org}`;
let counter = 0;
const archive = () => tarGz([...SITE, { name: `api-${++counter}.txt`, content: String(counter) }]);

async function upload(key: string, project: string, instance = api) {
    const response = await call(instance, key, "POST", `${base()}/projects/${project}/artifacts`, {
        raw: archive(),
    });
    return { response, json: (await response.json()) as { id: string } };
}

async function newApp(key = "full", project = p1) {
    counter++;
    const response = await call(api, key, "POST", `${base()}/projects/${project}/apps`, {
        body: { slug: `app-${counter}` },
    });
    return { response, json: (await response.json()) as { id: string } };
}

beforeAll(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "launchpad-deploy-api-"));
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
    org = (
        await createOrganization(
            testDb.db,
            { userId: root, instanceRole: "operator" },
            { name: "Acme", slug: "acme", ownerEmail: "ann@example.com" },
        )
    ).id;
    p1 = (await createProject(testDb.db, owner, org, { name: "One", slug: "one" })).id;
    p2 = (await createProject(testDb.db, owner, org, { name: "Two", slug: "two" })).id;
    await issue("full", ["app:read", "app:deploy"]);
    await issue("reader", ["app:read"]);
    await issue("deployer", ["app:deploy"]);
    await issue("only-p1", ["app:read", "app:deploy"], [p1]);
    await issue("only-p2", ["app:read", "app:deploy"], [p2]);
    const config = loadAuthConfig({
        LAUNCHPAD_AUTH_SECRET: "test-secret-".repeat(4),
        LAUNCHPAD_BASE_URL: "http://localhost:3000",
    });
    const db = createDatabase(testDb.url);
    const auth = createAuth({ db, config });
    const invitations = {
        enabled: false,
        mailer: null,
        baseUrl: config.baseUrl,
        publicSignup: false,
        hashPassword: async (password: string) => password,
    };
    const common = { auth, db, origin: config.origin, invitations, docs: true };
    api = createApi({
        ...common,
        artifacts: { dataDir, limits: { maxUploadBytes: 64 * 1024 } },
        deployments: { dataDir, settings: parseDeploymentConfig(env) },
    });
    offApi = createApi({
        ...common,
        artifacts: { dataDir, limits: {} },
        deployments: { dataDir, settings: { enabled: false } },
    });
});
afterAll(async () => {
    await testDb.destroy();
    await fs.rm(dataDir, { recursive: true, force: true });
});

describe("apps and deployments over HTTP", () => {
    it("requires authentication and the right scope on every route", async () => {
        const app = (await newApp()).json.id;
        const routes: [string, string, string][] = [
            ["POST", `${base()}/projects/${p1}/artifacts`, "app:deploy"],
            ["POST", `${base()}/projects/${p1}/apps`, "app:deploy"],
            ["GET", `${base()}/apps`, "app:read"],
            ["GET", `${base()}/apps/${app}`, "app:read"],
            ["POST", `${base()}/apps/${app}/deployments`, "app:deploy"],
            ["GET", `${base()}/apps/${app}/deployments`, "app:read"],
            ["GET", `${base()}/deployments/${randomUUID()}`, "app:read"],
            ["GET", `${base()}/deployments/${randomUUID()}/events`, "app:read"],
        ];
        for (const [method, route, needs] of routes) {
            const anonymous = await call(
                api,
                null,
                method,
                route,
                method === "POST" ? { raw: archive() } : {},
            );
            expect(anonymous.status, `${method} ${route}`).toBe(401);
            // A key holding only the other scope is refused before any service runs.
            const wrong = needs === "app:read" ? "deployer" : "reader";
            const refused = await call(api, wrong, method, route, {
                ...(method === "POST" ? { body: {} } : {}),
            });
            expect(refused.status, `${method} ${route} with ${wrong}`).toBe(403);
        }
    });

    it("creates and reads an app with documented shapes", async () => {
        const created = await newApp();
        expect(created.response.status).toBe(201);
        const app = appSchema.parse(created.json);
        expect(app.projectId).toBe(p1);
        const read = await call(api, "reader", "GET", `${base()}/apps/${app.id}`);
        expect(read.status).toBe(200);
        expect(appSchema.parse(await read.json()).id).toBe(app.id);
        const list = await call(api, "reader", "GET", `${base()}/apps`);
        expect(
            z
                .array(appSchema)
                .parse(await list.json())
                .map((a) => a.id),
        ).toContain(app.id);
        const duplicate = await call(api, "full", "POST", `${base()}/projects/${p1}/apps`, {
            body: { slug: app.slug },
        });
        expect(duplicate.status).toBe(409);
        expect(errorSchema.parse(await duplicate.json()).code).toBe("conflict");
        const invalid = await call(api, "full", "POST", `${base()}/projects/${p1}/apps`, {
            body: { slug: "Not A Slug" },
        });
        expect(invalid.status).toBe(422);
    });

    it("limits a project-restricted key to its own projects, apps and deployments", async () => {
        const mine = await newApp("only-p1", p1);
        expect(mine.response.status).toBe(201);
        expect((await newApp("only-p1", p2)).response.status).toBe(404);
        expect((await call(api, "only-p2", "GET", `${base()}/apps/${mine.json.id}`)).status).toBe(
            404,
        );
        const list = z
            .array(appSchema)
            .parse(await (await call(api, "only-p2", "GET", `${base()}/apps`)).json());
        expect(list.every((a) => a.projectId === p2)).toBe(true);
        // Uploads are project-scoped too.
        expect((await upload("only-p1", p2)).response.status).toBe(404);
        expect((await upload("only-p1", p1)).response.status).toBe(201);
    });

    it("uploads an archive, reuses an identical one and validates framing", async () => {
        const bytes = archive();
        const send = (headers: Record<string, string> = {}, raw: Uint8Array = bytes) =>
            call(api, "deployer", "POST", `${base()}/projects/${p1}/artifacts`, {
                raw,
                headers,
            });
        const first = await send();
        expect(first.status).toBe(201);
        const stored = artifactSchema.parse(await first.json());
        expect(stored.reused).toBe(false);
        const again = artifactSchema.parse(await (await send()).json());
        expect([again.id, again.reused]).toEqual([stored.id, true]);
        expect((await send({ "content-type": "text/plain" })).status).toBe(422);
        // Larger than the configured upload limit: refused before it is read.
        const big = new Uint8Array(70 * 1024);
        expect((await send({}, big)).status).toBe(413);
        // A project that does not exist is not found, not forbidden.
        const unknown = await call(
            api,
            "deployer",
            "POST",
            `${base()}/projects/${randomUUID()}/artifacts`,
            { raw: archive() },
        );
        expect(unknown.status).toBe(404);
        // Ordinary JSON bodies keep the small limit even though uploads may be large.
        const oversizedJson = await call(api, "full", "POST", `${base()}/projects/${p1}/apps`, {
            body: { slug: "x".repeat(70 * 1024) },
        });
        expect(oversizedJson.status).toBe(413);
    });

    it("queues a deployment, exposes it and its events, and refuses a second", async () => {
        const app = (await newApp()).json.id;
        const artifact = (await upload("full", p1)).json.id;
        const queued = await call(api, "full", "POST", `${base()}/apps/${app}/deployments`, {
            body: { artifactId: artifact, spa: true, ttl: "2d" },
        });
        expect(queued.status).toBe(202);
        const deployment = deploymentSchema.parse(await queued.json());
        expect(deployment).toMatchObject({ status: "queued", spa: true, appId: app });
        expect(deployment.hostname.endsWith(".sites.example.net")).toBe(true);
        const read = await call(api, "reader", "GET", `${base()}/deployments/${deployment.id}`);
        expect(deploymentSchema.parse(await read.json()).id).toBe(deployment.id);
        const list = await call(api, "reader", "GET", `${base()}/apps/${app}/deployments`);
        expect(
            z
                .array(deploymentSchema)
                .parse(await list.json())
                .map((d) => d.id),
        ).toEqual([deployment.id]);
        const events = await call(
            api,
            "reader",
            "GET",
            `${base()}/deployments/${deployment.id}/events`,
        );
        expect(z.array(deploymentEventSchema).parse(await events.json())).toMatchObject([
            { seq: 1, phase: "queued" },
        ]);
        const after = await call(
            api,
            "reader",
            "GET",
            `${base()}/deployments/${deployment.id}/events?after=1&limit=10`,
        );
        expect(await after.json()).toEqual([]);
        for (const query of [
            "after=abc",
            "limit=-1",
            "limit=0",
            "limit=501",
            "limit=1.5",
            "after=99999999999",
        ]) {
            const bad = await call(
                api,
                "reader",
                "GET",
                `${base()}/deployments/${deployment.id}/events?${query}`,
            );
            expect(bad.status, query).toBe(422);
        }
        const second = await call(api, "full", "POST", `${base()}/apps/${app}/deployments`, {
            body: { artifactId: artifact },
        });
        expect(second.status).toBe(409);
        const invalid = await call(api, "full", "POST", `${base()}/apps/${app}/deployments`, {
            body: { artifactId: "not-a-uuid" },
        });
        expect(invalid.status).toBe(422);
    });

    it("lets a restricted key deploy only archives uploaded through the app's project", async () => {
        const app1 = (await newApp("only-p1", p1)).json.id;
        const through2 = (await upload("only-p2", p2)).json.id;
        const refused = await call(api, "only-p1", "POST", `${base()}/apps/${app1}/deployments`, {
            body: { artifactId: through2 },
        });
        expect(refused.status).toBe(404);
        const own = (await upload("only-p1", p1)).json.id;
        const accepted = await call(api, "only-p1", "POST", `${base()}/apps/${app1}/deployments`, {
            body: { artifactId: own },
        });
        expect(accepted.status).toBe(202);
    });

    it("answers 503 for every deployment write while deployments are off, and still reads", async () => {
        const app = (await newApp()).json.id;
        const off = (route: string, options: Parameters<typeof call>[4] = {}) =>
            call(offApi, "full", "POST", route, options);
        expect((await off(`${base()}/projects/${p1}/artifacts`, { raw: archive() })).status).toBe(
            503,
        );
        expect(
            (await off(`${base()}/projects/${p1}/apps`, { body: { slug: "off-app" } })).status,
        ).toBe(503);
        const refused = await off(`${base()}/apps/${app}/deployments`, {
            body: { artifactId: randomUUID() },
        });
        expect(refused.status).toBe(503);
        expect(errorSchema.parse(await refused.json()).code).toBe("unavailable");
        // The switch answers before the project is looked up on upload.
        expect(
            (await off(`${base()}/projects/${randomUUID()}/artifacts`, { raw: archive() })).status,
        ).toBe(503);
        expect((await call(offApi, "reader", "GET", `${base()}/apps/${app}`)).status).toBe(200);
        expect((await call(offApi, "reader", "GET", `${base()}/apps`)).status).toBe(200);
    });

    it("documents every new operation", async () => {
        const response = await api.fetch(new Request(`${BASE}/api/openapi/json`));
        const spec = (await response.json()) as { paths: Record<string, Record<string, unknown>> };
        const has = (route: string, method: string) =>
            !!spec.paths[`/api/v1/organizations/{orgId}${route}`]?.[method];
        expect(has("/projects/{projectId}/artifacts", "post")).toBe(true);
        expect(has("/projects/{projectId}/apps", "post")).toBe(true);
        expect(has("/apps", "get")).toBe(true);
        expect(has("/apps/{appId}", "get")).toBe(true);
        expect(has("/apps/{appId}/deployments", "post")).toBe(true);
        expect(has("/apps/{appId}/deployments", "get")).toBe(true);
        expect(has("/deployments/{deploymentId}", "get")).toBe(true);
        expect(has("/deployments/{deploymentId}/events", "get")).toBe(true);
    });
});
