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
    deploymentDeletionSchema,
    aliasSchema,
    appShutdownSchema,
    deploymentEventSchema,
    deploymentSchema,
    errorSchema,
    markDeploymentRecoveryBlocked,
    parseAliasConfig,
    parseDeploymentConfig,
    promotionOperationSchema,
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
    await issue("deleter", ["app:read", "app:deploy", "app:delete"]);
    await issue("deleter-p2", ["app:read", "app:delete"], [p2]);
    await issue("remover", ["app:delete"]);
    await issue("aliaser", ["app:read", "app:alias:manage"]);
    await issue("aliaser-p2", ["app:read", "app:alias:manage"], [p2]);
    await issue("promoter", ["app:read", "app:promote"]);
    await issue("promoter-p2", ["app:read", "app:promote"], [p2]);
    await issue("shutdowner", ["app:read", "app:delete", "app:alias:manage", "app:promote"]);
    await issue(
        "shutdowner-p2",
        ["app:read", "app:delete", "app:alias:manage", "app:promote"],
        [p2],
    );
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
        aliases: parseAliasConfig({ ...env, LAUNCHPAD_ALIASES: "on" }),
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
            ["DELETE", `${base()}/deployments/${randomUUID()}`, "app:delete"],
            ["POST", `${base()}/apps/${app}/aliases`, "app:alias:manage"],
            ["GET", `${base()}/apps/${app}/aliases`, "app:read"],
            ["GET", `${base()}/aliases/${randomUUID()}`, "app:read"],
            ["POST", `${base()}/aliases/${randomUUID()}/promotions`, "app:promote"],
            ["DELETE", `${base()}/aliases/${randomUUID()}`, "app:alias:manage"],
            ["GET", `${base()}/aliases/${randomUUID()}/operations`, "app:read"],
            ["DELETE", `${base()}/apps/${app}`, "app:delete"],
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
            { seq: "1", phase: "queued" },
        ]);
        const after = await call(
            api,
            "reader",
            "GET",
            `${base()}/deployments/${deployment.id}/events?after=1&limit=10`,
        );
        expect(await after.json()).toEqual([]);
        const maxCursor = await call(
            api,
            "reader",
            "GET",
            `${base()}/deployments/${deployment.id}/events?after=2147483647`,
        );
        expect(maxCursor.status).toBe(200);
        expect(await maxCursor.json()).toEqual([]);
        for (const query of [
            "after=abc",
            "limit=-1",
            "limit=0",
            "limit=501",
            "limit=1.5",
            "after=99999999999",
            "after=2147483648",
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
        expect(has("/deployments/{deploymentId}", "delete")).toBe(true);
        expect(has("/apps/{appId}/aliases", "post")).toBe(true);
        expect(has("/apps/{appId}/aliases", "get")).toBe(true);
        expect(has("/aliases/{aliasId}", "get")).toBe(true);
        expect(has("/aliases/{aliasId}/promotions", "post")).toBe(true);
        expect(has("/aliases/{aliasId}", "delete")).toBe(true);
        expect(has("/aliases/{aliasId}/operations", "get")).toBe(true);
        expect(has("/apps/{appId}", "delete")).toBe(true);
    });

    it("creates, lists and reads aliases within the key's scope and projects", async () => {
        const app = (await newApp()).json.id;
        const route = `${base()}/apps/${app}/aliases`;
        const created = await call(api, "aliaser", "POST", route, { body: { slug: "prod" } });
        expect(created.status).toBe(201);
        const alias = aliasSchema.parse(await created.json());
        expect(alias).toMatchObject({ state: "unbound", reservedGeneration: "0" });
        expect((await call(api, "aliaser", "POST", route, { body: { slug: "prod" } })).status).toBe(
            409,
        );
        expect((await call(api, "aliaser", "POST", route, { body: { slug: "BAD" } })).status).toBe(
            422,
        );
        // Another project's key cannot see the app, and the off switch refuses before any change.
        expect((await call(api, "aliaser-p2", "POST", route, { body: { slug: "x" } })).status).toBe(
            404,
        );
        expect((await call(offApi, "aliaser", "POST", route, { body: { slug: "x" } })).status).toBe(
            503,
        );
        const listed = z
            .array(aliasSchema)
            .parse(await (await call(api, "reader", "GET", route)).json());
        expect(listed.map((a) => a.id)).toEqual([alias.id]);
        const read = await call(api, "reader", "GET", `${base()}/aliases/${alias.id}`);
        expect(aliasSchema.parse(await read.json())).toEqual(alias);
        expect((await call(api, "aliaser-p2", "GET", `${base()}/aliases/${alias.id}`)).status).toBe(
            404,
        );
        // A deploy-capable key without the alias scope is refused, and a bad id is a 404.
        expect((await call(api, "full", "POST", route, { body: { slug: "x" } })).status).toBe(403);
        expect((await call(api, "reader", "GET", `${base()}/apps/not-a-uuid/aliases`)).status).toBe(
            404,
        );
        // Reads still work while aliases are off.
        expect((await call(offApi, "reader", "GET", route)).status).toBe(200);
    });

    it("promotes, withdraws and lists operations with separate scopes and an idempotency key", async () => {
        const app = (await newApp()).json.id;
        const route = `${base()}/apps/${app}/aliases`;
        const first = aliasSchema.parse(
            await (await call(api, "aliaser", "POST", route, { body: { slug: "prod" } })).json(),
        );
        const second = aliasSchema.parse(
            await (await call(api, "aliaser", "POST", route, { body: { slug: "stable" } })).json(),
        );
        const artifact = (await upload("full", p1)).json.id;
        const deployment = deploymentSchema.parse(
            await (
                await call(api, "full", "POST", `${base()}/apps/${app}/deployments`, {
                    body: { artifactId: artifact },
                })
            ).json(),
        );
        await sql`update deployment set status = 'succeeded', finished_at = now(), step_done = 'verify',
            image_tag = ${`launchpad/site:${deployment.id.replaceAll("-", "")}`},
            image_id = ${`sha256:${"f".repeat(64)}`} where id = ${deployment.id}`.execute(
            testDb.db,
        );
        const promote = `${base()}/aliases/${first.id}/promotions`;
        const body = { targetDeploymentId: deployment.id, expectedGeneration: "0" };

        // A key is required, and each action needs its own scope.
        expect((await call(api, "promoter", "POST", promote, { body })).status).toBe(422);
        const key = { "idempotency-key": "release-1" };
        expect((await call(api, "aliaser", "POST", promote, { body, headers: key })).status).toBe(
            403,
        );
        expect((await call(api, "full", "POST", promote, { body, headers: key })).status).toBe(403);
        expect(
            (await call(api, "promoter-p2", "POST", promote, { body, headers: key })).status,
        ).toBe(404);
        expect(
            (await call(offApi, "promoter", "POST", promote, { body, headers: key })).status,
        ).toBe(503);

        const accepted = await call(api, "promoter", "POST", promote, { body, headers: key });
        expect(accepted.status).toBe(202);
        const operation = promotionOperationSchema.parse(await accepted.json());
        expect(operation).toMatchObject({
            aliasId: first.id,
            action: "bind",
            status: "queued",
            generation: "1",
            desiredTargetDeploymentId: deployment.id,
        });
        // A retry returns the same operation; the same key for a different request is a conflict.
        const replay = await call(api, "promoter", "POST", promote, { body, headers: key });
        expect(promotionOperationSchema.parse(await replay.json()).id).toBe(operation.id);
        expect(
            (
                await call(api, "promoter", "POST", promote, {
                    body: { ...body, expectedGeneration: "5" },
                    headers: key,
                })
            ).status,
        ).toBe(409);
        // The alias now has an operation in progress, and a promote key cannot withdraw.
        expect(
            (
                await call(api, "promoter", "DELETE", `${base()}/aliases/${first.id}`, {
                    body: { expectedGeneration: "1" },
                    headers: { "idempotency-key": "w-1" },
                })
            ).status,
        ).toBe(403);
        expect(
            (
                await call(api, "aliaser", "DELETE", `${base()}/aliases/${first.id}`, {
                    body: { expectedGeneration: "1" },
                    headers: { "idempotency-key": "w-1" },
                })
            ).status,
        ).toBe(409);

        // Withdrawal of a bound alias is queued, and operations are listed newest first.
        await sql`update app_alias set state = 'bound', target_deployment_id = ${deployment.id},
            committed_generation = 1, reserved_generation = 1 where id = ${second.id}`.execute(
            testDb.db,
        );
        const withdrawal = await call(api, "aliaser", "DELETE", `${base()}/aliases/${second.id}`, {
            body: { expectedGeneration: "1" },
            headers: { "idempotency-key": "w-2" },
        });
        expect(withdrawal.status).toBe(202);
        expect(promotionOperationSchema.parse(await withdrawal.json())).toMatchObject({
            action: "withdraw",
            status: "queued",
            generation: "2",
            desiredTargetDeploymentId: null,
        });
        const listed = z
            .array(promotionOperationSchema)
            .parse(
                await (
                    await call(api, "reader", "GET", `${base()}/aliases/${first.id}/operations`)
                ).json(),
            );
        expect(listed.map((row) => row.id)).toEqual([operation.id]);
        expect(
            (await call(api, "promoter-p2", "GET", `${base()}/aliases/${first.id}/operations`))
                .status,
        ).toBe(404);

        // Shutdown needs all three scopes; with routes in progress it destroys nothing.
        expect((await call(api, "deleter", "DELETE", `${base()}/apps/${app}`)).status).toBe(403);
        expect((await call(api, "shutdowner-p2", "DELETE", `${base()}/apps/${app}`)).status).toBe(
            404,
        );
        // With the switch off, every new write answers 503 before anything about the request.
        expect((await call(offApi, "promoter", "POST", promote, { body })).status).toBe(503);
        expect(
            (await call(offApi, "aliaser", "DELETE", `${base()}/aliases/${first.id}`)).status,
        ).toBe(503);
        expect((await call(offApi, "shutdowner", "DELETE", `${base()}/apps/${app}`)).status).toBe(
            503,
        );
        const shutdown = await call(api, "shutdowner", "DELETE", `${base()}/apps/${app}`);
        expect(shutdown.status).toBe(202);
        expect(appShutdownSchema.parse(await shutdown.json())).toMatchObject({
            appId: app,
            state: "shutting-down",
            deletionsQueued: 0,
            blockedBy: ["alias-in-progress"],
        });
        expect(
            (
                await call(api, "full", "POST", `${base()}/apps/${app}/deployments`, {
                    body: { artifactId: artifact },
                })
            ).status,
        ).toBe(404);
    });

    it("answers a malformed id with 404 and a blocked recovery gate with 503 on deletion", async () => {
        expect(
            (await call(api, "deleter", "DELETE", `${base()}/deployments/not-a-uuid`)).status,
        ).toBe(404);
        const app = (await newApp()).json.id;
        const artifact = (await upload("full", p1)).json.id;
        const queued = await call(api, "full", "POST", `${base()}/apps/${app}/deployments`, {
            body: { artifactId: artifact },
        });
        const deployment = deploymentSchema.parse(await queued.json());
        await sql`update deployment set status = 'failed', finished_at = now()
            where id = ${deployment.id}`.execute(testDb.db);
        await markDeploymentRecoveryBlocked(dataDir);
        try {
            const blocked = await call(
                api,
                "deleter",
                "DELETE",
                `${base()}/deployments/${deployment.id}`,
            );
            expect(blocked.status).toBe(503);
            expect(errorSchema.parse(await blocked.json()).code).toBe("unavailable");
        } finally {
            await fs.rm(path.join(dataDir, "maintenance"), { recursive: true, force: true });
        }
    });

    it("queues a deletion only for a finished deployment, within the key's scope and projects", async () => {
        const app = (await newApp()).json.id;
        const artifact = (await upload("full", p1)).json.id;
        const queued = await call(api, "full", "POST", `${base()}/apps/${app}/deployments`, {
            body: { artifactId: artifact },
        });
        const deployment = deploymentSchema.parse(await queued.json());
        const route = `${base()}/deployments/${deployment.id}`;
        // Unfinished work cannot be deleted.
        expect((await call(api, "deleter", "DELETE", route)).status).toBe(409);
        await sql`update deployment set status = 'failed', finished_at = now(), step_done = 'app'
            where id = ${deployment.id}`.execute(testDb.db);
        // Another project's key cannot see it, and the off switch refuses before anything changes.
        expect((await call(api, "deleter-p2", "DELETE", route)).status).toBe(404);
        expect((await call(offApi, "deleter", "DELETE", route)).status).toBe(503);
        expect(
            deploymentSchema.parse(await (await call(api, "reader", "GET", route)).json())
                .desiredState,
        ).toBe("active");
        const accepted = await call(api, "deleter", "DELETE", route);
        expect(accepted.status).toBe(202);
        expect(deploymentDeletionSchema.parse(await accepted.json())).toMatchObject({
            deploymentId: deployment.id,
            status: "queued",
        });
        expect((await call(api, "deleter", "DELETE", route)).status).toBe(409);
        expect(
            deploymentSchema.parse(await (await call(api, "reader", "GET", route)).json())
                .desiredState,
        ).toBe("deleting");
        expect(
            (await call(api, "remover", "DELETE", `${base()}/deployments/${randomUUID()}`)).status,
        ).toBe(404);
    });
});
