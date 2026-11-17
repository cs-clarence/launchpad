import { randomUUID } from "node:crypto";
import { type ChildProcess, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createAuth, loadAuthConfig, setupFirstOperator } from "@launchpad/auth";
import {
    createContext,
    deploy as deployWithClient,
    deploymentEvents,
    getDeployment,
    listPreviews,
} from "@launchpad/client-core";
import {
    acceptedInvitationSchema,
    addedMemberSchema,
    artifactSchema,
    createdApiKeySchema,
    createdDeploymentSchema,
    requestedDeletionSchema,
    deletionSchema,
    deploymentEventsSchema,
    deploymentSchema,
    previewListSchema,
    previewSchema,
    createdInvitationSchema,
    keyInfoSchema,
    apiKeySummarySchema,
    createdOrganizationSchema,
    createdProjectSchema,
    errorSchema,
    invitationPreviewSchema,
    invitationSchema,
    memberSchema,
    meSchema,
    okSchema,
    organizationSummarySchema,
    projectSchema,
} from "@launchpad/services";
import { z } from "zod";
import { type FakeSmtp, mailText, startFakeSmtp } from "@launchpad/auth/testing";
import { createTestDatabase } from "@launchpad/database/testing";
import { SITE, tarGz } from "@launchpad/services/testing";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Exercises the real built TanStack Start server (Nitro) -> Elysia -> Better Auth
// -> PostgreSQL path over HTTP, in production mode, including cookies. Two server
// instances differ only in LAUNCHPAD_TRUSTED_PROXY.
const PASSWORD = "correct-horse-battery";
const USER_PASSWORD = "another-long-password";

interface Instance {
    base: string;
    proc: ChildProcess;
    logs: string;
}

let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
let direct: Instance; // no trusted proxy
let proxied: Instance; // one trusted proxy hop
let mailed: Instance; // trusted proxy, SMTP and invitation enrollment
let smtp: FakeSmtp;
// Uploaded archives are staged and stored here for every server instance.
let dataDir = "";
const UPLOAD_LIMIT = 8 * 1024 * 1024;

// A random base so concurrent test runs on one machine rarely overlap.
let nextPort = 43100 + Math.floor(Math.random() * 600) * 3;

// A port picked here can be taken by another process before the server binds it (a
// shared CI runner has other services). That is the only startup failure worth
// retrying, and only with a different port.
async function start(
    trustedProxy: boolean,
    extraEnv: Record<string, string> = {},
): Promise<Instance> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await startOnce(trustedProxy, extraEnv);
        } catch (error) {
            const inUse = error instanceof Error && error.message.includes("EADDRINUSE");
            if (!inUse || attempt >= 5) throw error;
            nextPort += 1 + Math.floor(Math.random() * 50);
        }
    }
}

async function startOnce(
    trustedProxy: boolean,
    extraEnv: Record<string, string> = {},
): Promise<Instance> {
    // Distinct per instance: three servers start in one run, and two random ports can collide.
    const port = nextPort++;
    const base = `http://127.0.0.1:${port}`;
    // Inherit the PATH but none of vitest's own variables (VITEST, NODE_ENV, ...).
    const env = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: "production",
        DATABASE_URL: testDb.url,
        LAUNCHPAD_AUTH_SECRET: "integration-secret-".repeat(3),
        LAUNCHPAD_BASE_URL: base,
        LAUNCHPAD_TRUSTED_PROXY: String(trustedProxy),
        LAUNCHPAD_DATA_DIR: dataDir,
        LAUNCHPAD_MAX_UPLOAD_BYTES: String(UPLOAD_LIMIT),
        LAUNCHPAD_UPLOAD_TIMEOUT_SECONDS: "3",
        HOST: "127.0.0.1",
        PORT: String(port),
        ...extraEnv,
    };
    const proc = spawn("bun", [".output/server/index.mjs"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
    });
    const instance: Instance = { base, proc, logs: "" };
    proc.stdout?.on("data", (d) => (instance.logs += d));
    proc.stderr?.on("data", (d) => (instance.logs += d));
    for (let i = 0; i < 100; i++) {
        // A child that has already exited will never answer: fail now, with its output.
        if (proc.exitCode !== null) break;
        try {
            if ((await fetch(`${base}/api/health`)).ok) return instance;
        } catch {}
        await new Promise((r) => setTimeout(r, 200));
    }
    // Do not leave the child running when startup fails: afterAll may never see it.
    proc.kill("SIGTERM");
    throw new Error(`controller did not start:\n${instance.logs}`);
}

const post = (
    instance: Instance,
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
) =>
    fetch(`${instance.base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: instance.base, ...headers },
        body: JSON.stringify(body),
    });

const signIn = (instance: Instance, email: string, password: string, ip?: string) =>
    post(
        instance,
        "/api/auth/sign-in/email",
        { email, password },
        ip ? { "x-forwarded-for": ip } : {},
    );

beforeAll(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "launchpad-hop-data-"));
    testDb = await createTestDatabase();
    await testDb.migrate();
    const config = loadAuthConfig({
        LAUNCHPAD_AUTH_SECRET: "integration-secret-".repeat(3),
        LAUNCHPAD_BASE_URL: "http://127.0.0.1:1",
    });
    const auth = createAuth({ db: testDb.db, config });
    await setupFirstOperator(
        { db: testDb.db, auth },
        { email: "op@example.com", name: "Op", password: PASSWORD },
    );
    // Ordinary users, provisioned directly: there is no public path to create them.
    for (const email of ["user@example.com", "other@example.com"]) {
        const id = randomUUID();
        await testDb.db
            .insertInto("user")
            .values({ id, name: email, email, emailVerified: false, image: null, role: "user" })
            .execute();
        // Operator-provisioned (what `admin create-user` records), so it may be granted access.
        await testDb.db
            .insertInto("audit_event")
            .values({
                actor: "operator-cli",
                action: "user.provisioned",
                target_type: "user",
                target_id: id,
            })
            .execute();
        await testDb.db
            .insertInto("account")
            .values({
                id: randomUUID(),
                accountId: id,
                providerId: "credential",
                userId: id,
                password: await (await auth.$context).password.hash(USER_PASSWORD),
                updatedAt: new Date(),
            })
            .execute();
    }
    // Lifecycle is on here while deployments are off: a deletion would never be run.
    direct = await start(false, { LAUNCHPAD_API_DOCS: "false", LAUNCHPAD_LIFECYCLE: "on" });
    // Deployments are on here (no worker runs in these tests); `direct` leaves them off.
    proxied = await start(true, {
        LAUNCHPAD_DEPLOYMENTS: "on",
        LAUNCHPAD_LIFECYCLE: "on",
        LAUNCHPAD_PREVIEW_DOMAIN: "previews.example.com",
    });
    smtp = startFakeSmtp();
    mailed = await start(true, {
        LAUNCHPAD_SMTP_URL: smtp.url,
        LAUNCHPAD_EMAIL_FROM: "launchpad@example.com",
        LAUNCHPAD_ENROLLMENT: "invitation",
    });
});

afterAll(async () => {
    direct?.proc.kill("SIGTERM");
    proxied?.proc.kill("SIGTERM");
    mailed?.proc.kill("SIGTERM");
    smtp?.stop();
    await testDb?.destroy();
    if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
});

describe("Start -> Elysia -> Better Auth -> PostgreSQL", () => {
    let cookie = "";

    it("redirects the protected page to /login and serves the login page", async () => {
        const home = await fetch(`${proxied.base}/`, { redirect: "manual" });
        expect([302, 307]).toContain(home.status);
        expect(home.headers.get("location")).toContain("/login");
        const login = await fetch(`${proxied.base}/login`);
        expect(login.status).toBe(200);
        expect(await login.text()).toContain("Sign in to Launchpad");
    });

    it("denies public sign-up", async () => {
        const response = await post(
            proxied,
            "/api/auth/sign-up/email",
            {
                email: "x@example.com",
                password: PASSWORD,
                name: "x",
            },
            { "x-forwarded-for": "198.51.100.200" },
        );
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.status).toBeLessThan(500);
    });

    it("signs in with a hardened session cookie and reads the session", async () => {
        const response = await signIn(proxied, "op@example.com", PASSWORD, "198.51.100.1");
        expect(response.status).toBe(200);
        const setCookie = response.headers.getSetCookie();
        const sessionCookie = setCookie.find((c) => c.includes("session_token")) ?? "";
        expect(sessionCookie).toMatch(/HttpOnly/i);
        expect(sessionCookie).toMatch(/SameSite=Lax/i);
        expect(sessionCookie).not.toMatch(/Domain=/i);
        cookie = setCookie.map((c) => c.split(";")[0]).join("; ");

        const me = await fetch(`${proxied.base}/api/v1/me`, { headers: { cookie } });
        expect(me.status).toBe(200);
        expect(meSchema.parse(await me.json())).toMatchObject({
            email: "op@example.com",
            role: "operator",
        });

        const home = await fetch(`${proxied.base}/`, { headers: { cookie }, redirect: "manual" });
        expect(home.status).toBe(200);
        expect(await home.text()).toContain("op@example.com");
    });

    it("rejects cookie mutations from a foreign or sibling origin", async () => {
        for (const origin of ["https://evil.example.net", "http://preview-ab12.127.0.0.1"]) {
            const response = await fetch(`${proxied.base}/api/v1/anything`, {
                method: "POST",
                headers: { cookie, origin },
            });
            expect(response.status).toBe(403);
        }
        const crossSignOut = await fetch(`${proxied.base}/api/auth/sign-out`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                cookie,
                origin: "https://evil.example.net",
            },
            body: "{}",
        });
        expect(crossSignOut.status).toBeGreaterThanOrEqual(400);
        expect((await fetch(`${proxied.base}/api/v1/me`, { headers: { cookie } })).status).toBe(
            200,
        );
    });

    it("does not let an ordinary user create organizations or become an operator", async () => {
        const login = await signIn(proxied, "user@example.com", USER_PASSWORD, "198.51.100.2");
        expect(login.status).toBe(200);
        const userCookie = login.headers
            .getSetCookie()
            .map((c) => c.split(";")[0])
            .join("; ");
        const create = await post(
            proxied,
            "/api/auth/organization/create",
            { name: "Evil", slug: "evil" },
            { cookie: userCookie, "x-forwarded-for": "198.51.100.2" },
        );
        expect(create.status).toBe(404); // Better Auth's organization endpoints are not exposed
        await post(
            proxied,
            "/api/auth/update-user",
            { role: "operator", name: "U2" },
            { cookie: userCookie, "x-forwarded-for": "198.51.100.2" },
        );
        const me = await fetch(`${proxied.base}/api/v1/me`, { headers: { cookie: userCookie } });
        expect(await me.json()).toMatchObject({ role: "user" });
    });

    it("revokes the session on sign-out", async () => {
        const out = await post(
            proxied,
            "/api/auth/sign-out",
            {},
            { cookie, "x-forwarded-for": "198.51.100.1" },
        );
        expect(out.status).toBe(200);
        expect((await fetch(`${proxied.base}/api/v1/me`, { headers: { cookie } })).status).toBe(
            401,
        );
    });
});

async function login(email: string, password: string, ip: string) {
    const response = await signIn(proxied, email, password, ip);
    expect(response.status).toBe(200);
    return response.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");
}

const api = (cookie: string, path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${proxied.base}/api/v1${path}`, {
        method: init.method ?? "GET",
        headers: { cookie, origin: proxied.base, "content-type": "application/json" },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

describe("organizations and projects over HTTP", () => {
    let operator = "";
    let owner = "";
    let outsider = "";
    let orgId = "";

    it("lets only the operator create an organization, who is not then a member", async () => {
        operator = await login("op@example.com", PASSWORD, "198.51.100.10");
        owner = await login("user@example.com", USER_PASSWORD, "198.51.100.11");
        outsider = await login("other@example.com", USER_PASSWORD, "198.51.100.12");
        const input = { name: "Acme", slug: "acme", ownerEmail: "user@example.com" };

        const anonymous = await api("", "/organizations", { method: "POST", body: input });
        expect(anonymous.status).toBe(401);
        expect(errorSchema.parse(await anonymous.json()).code).toBe("unauthenticated");
        expect((await api(owner, "/organizations", { method: "POST", body: input })).status).toBe(
            403,
        );
        const created = await api(operator, "/organizations", { method: "POST", body: input });
        expect(created.status).toBe(201);
        orgId = createdOrganizationSchema.parse(await created.json()).id;
        expect(
            (await api(operator, "/organizations", { method: "POST", body: input })).status,
        ).toBe(409);
        expect(
            (await api(operator, "/organizations", { method: "POST", body: "nope" })).status,
        ).toBe(422);

        expect(
            z
                .array(organizationSummarySchema)
                .parse(await (await api(operator, "/organizations")).json()),
        ).toEqual([]);
        const hidden = await api(operator, `/organizations/${orgId}`);
        expect(hidden.status).toBe(404);
        expect(errorSchema.parse(await hidden.json()).code).toBe("not-found");
        expect((await api(operator, `/organizations/${orgId}/projects`)).status).toBe(404);
    });

    it("lets the owner create and list projects and manage members", async () => {
        const list = (await (await api(owner, "/organizations")).json()) as {
            slug: string;
            role: string;
        }[];
        expect(list).toMatchObject([{ slug: "acme", role: "owner" }]);
        expect(
            organizationSummarySchema.parse(
                await (await api(owner, `/organizations/${orgId}`)).json(),
            ),
        ).toMatchObject({ slug: "acme", role: "owner" });
        const project = await api(owner, `/organizations/${orgId}/projects`, {
            method: "POST",
            body: { name: "Website", slug: "website" },
        });
        expect(project.status).toBe(201);
        createdProjectSchema.parse(await project.json());
        expect(
            z
                .array(projectSchema)
                .parse(await (await api(owner, `/organizations/${orgId}/projects`)).json()),
        ).toHaveLength(1);
        expect(
            z
                .array(memberSchema)
                .parse(await (await api(owner, `/organizations/${orgId}/members`)).json()),
        ).toHaveLength(1);
        const added = await api(owner, `/organizations/${orgId}/members`, {
            method: "POST",
            body: { email: "other@example.com", role: "viewer" },
        });
        expect(added.status).toBe(201);
        addedMemberSchema.parse(await added.json());
    });

    it("renders organization pages only for members, and operator-only creation form", async () => {
        const page = (cookie: string, path: string) =>
            fetch(`${proxied.base}${path}`, { headers: { cookie }, redirect: "manual" }).then((r) =>
                r.text(),
            );
        const ownerHome = await page(owner, "/");
        expect(ownerHome).toContain("Acme");
        expect(ownerHome).not.toContain("Create organization");
        const operatorHome = await page(operator, "/");
        expect(operatorHome).toContain("Create organization");
        expect(operatorHome).not.toContain("Acme");

        const ownerOrg = await page(owner, `/orgs/${orgId}`);
        expect(ownerOrg).toContain("Website");
        expect(ownerOrg).toContain("Add member");
        const operatorOrg = await page(operator, `/orgs/${orgId}`);
        expect(operatorOrg).not.toContain("Website");
        expect(operatorOrg).toContain("Organization not found");
    });

    it("lets a viewer read but not create, and hides the organization from others after removal", async () => {
        expect((await api(outsider, `/organizations/${orgId}/projects`)).status).toBe(200);
        const denied = await api(outsider, `/organizations/${orgId}/projects`, {
            method: "POST",
            body: { name: "Nope", slug: "nope" },
        });
        expect(denied.status).toBe(403);
        expect(errorSchema.parse(await denied.json())).toMatchObject({
            code: "forbidden",
            status: 403,
        });
        const outsiderId = (await (await api(outsider, "/me")).json()) as { id: string };
        const removed = await api(owner, `/organizations/${orgId}/members/${outsiderId.id}`, {
            method: "DELETE",
        });
        expect(removed.status).toBe(200);
        expect(okSchema.parse(await removed.json())).toEqual({ ok: true });
        expect((await api(outsider, `/organizations/${orgId}/projects`)).status).toBe(404);
        const create = await api(outsider, `/organizations/${orgId}/projects`, {
            method: "POST",
            body: { name: "Nope", slug: "nope" },
        });
        expect(create.status).toBe(404);
    });

    it("keeps two organizations apart: neither side can reach the other's resources", async () => {
        const created = await api(operator, "/organizations", {
            method: "POST",
            body: { name: "Beta", slug: "beta", ownerEmail: "other@example.com" },
        });
        expect(created.status).toBe(201);
        const betaId = createdOrganizationSchema.parse(await created.json()).id;
        const betaProject = await api(outsider, `/organizations/${betaId}/projects`, {
            method: "POST",
            body: { name: "Secret", slug: "secret" },
        });
        expect(betaProject.status).toBe(201);
        const otherId = (await (await api(outsider, "/me")).json()) as { id: string };
        const ownerId = (await (await api(owner, "/me")).json()) as { id: string };

        // Acme's owner against Beta, and Beta's owner against Acme: every verb is 404.
        const probes = (id: string, member: string) =>
            [
                ["GET", `/organizations/${id}`],
                ["GET", `/organizations/${id}/members`],
                ["GET", `/organizations/${id}/projects`],
                ["GET", `/organizations/${id}/invitations`],
                ["POST", `/organizations/${id}/projects`, { name: "X", slug: "x" }],
                [
                    "POST",
                    `/organizations/${id}/members`,
                    { email: "op@example.com", role: "viewer" },
                ],
                [
                    "POST",
                    `/organizations/${id}/invitations`,
                    { email: "z@example.com", role: "viewer" },
                ],
                ["DELETE", `/organizations/${id}/members/${member}`],
            ] as const;
        const attempts: [string, ReturnType<typeof probes>][] = [
            [owner, probes(betaId, otherId.id)],
            [outsider, probes(orgId, ownerId.id)],
        ];
        for (const [cookie, list] of attempts) {
            for (const [method, path, body] of list) {
                const response = await api(cookie, path, { method, body });
                expect(response.status, `${method} ${path}`).toBe(404);
                expect(errorSchema.parse(await response.json()).code).toBe("not-found");
            }
        }
        // Nothing was changed by those attempts.
        expect(
            z
                .array(projectSchema)
                .parse(await (await api(outsider, `/organizations/${betaId}/projects`)).json()),
        ).toHaveLength(1);
        expect(
            z
                .array(memberSchema)
                .parse(await (await api(owner, `/organizations/${orgId}/members`)).json()),
        ).toHaveLength(1);
    });

    it("does not expose Better Auth's organization endpoints", async () => {
        for (const path of [
            "/api/auth/organization/create",
            "/api/auth/organization/list",
            "/api/auth/Organization/list",
        ]) {
            const response = await fetch(`${proxied.base}${path}`, {
                method: path.endsWith("create") ? "POST" : "GET",
                headers: {
                    cookie: operator,
                    origin: proxied.base,
                    "content-type": "application/json",
                },
                body: path.endsWith("create")
                    ? JSON.stringify({ name: "x", slug: "x" })
                    : undefined,
            });
            expect(response.status).toBe(404);
        }
    });
});

const mailedApi = (cookie: string, path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${mailed.base}/api/v1${path}`, {
        method: init.method ?? "GET",
        headers: { cookie, origin: mailed.base, "content-type": "application/json" },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

describe("hardening", () => {
    it("sends anti-framing, anti-sniffing and no-referrer headers on pages and the API", async () => {
        for (const path of ["/login", "/api/health", "/api/v1/me"]) {
            const response = await fetch(`${proxied.base}${path}`);
            expect(response.headers.get("x-frame-options"), path).toBe("DENY");
            expect(response.headers.get("x-content-type-options"), path).toBe("nosniff");
            expect(response.headers.get("content-security-policy"), path).toContain(
                "frame-ancestors 'none'",
            );
            expect(response.headers.get("referrer-policy"), path).toBe("no-referrer");
        }
    });

    it("marks API responses no-store, so a shared cache never serves one account's data to another", async () => {
        for (const path of ["/api/v1/me", "/api/v1/organizations", "/api/health"]) {
            const response = await fetch(`${proxied.base}${path}`);
            expect(response.headers.get("cache-control"), path).toBe("no-store");
        }
    });

    it("refuses oversized request bodies over real HTTP, on product and auth routes", async () => {
        const big = JSON.stringify({ email: "a@example.com", password: "x".repeat(70 * 1024) });
        for (const path of ["/api/v1/organizations", "/api/auth/sign-in/email"]) {
            const response = await post(proxied, path, JSON.parse(big), {
                "x-forwarded-for": "198.51.100.90",
            });
            expect(response.status, path).toBe(413);
            if (path.startsWith("/api/v1")) {
                expect(errorSchema.parse(await response.json())).toMatchObject({ status: 413 });
            }
        }
    });
});

describe("API keys over HTTP", () => {
    const bearer = (key: string, path: string, init: { method?: string; body?: unknown } = {}) =>
        fetch(`${proxied.base}/api/v1${path}`, {
            method: init.method ?? "GET",
            headers: {
                authorization: `Bearer ${key}`,
                ...(init.body === undefined ? {} : { "content-type": "application/json" }),
            },
            body: init.body === undefined ? undefined : JSON.stringify(init.body),
        });
    let owner = "";
    let orgId = "";
    let otherOrgId = "";
    let projectId = "";
    let readKey = "";
    let writeKey = "";
    let readKey2 = "";

    it("is issued by a signed-in owner, shown once, and listed without its secret", async () => {
        const operator = await login("op@example.com", PASSWORD, "198.51.100.20");
        owner = await login("user@example.com", USER_PASSWORD, "198.51.100.21");
        const make = async (name: string, slug: string) =>
            createdOrganizationSchema.parse(
                await (
                    await api(operator, "/organizations", {
                        method: "POST",
                        body: { name, slug, ownerEmail: "user@example.com" },
                    })
                ).json(),
            ).id;
        orgId = await make("Keys One", "keys-one");
        otherOrgId = await make("Keys Two", "keys-two");
        projectId = createdProjectSchema.parse(
            await (
                await api(owner, `/organizations/${orgId}/projects`, {
                    method: "POST",
                    body: { name: "P", slug: "p" },
                })
            ).json(),
        ).id;
        await api(owner, `/organizations/${orgId}/projects`, {
            method: "POST",
            body: { name: "Q", slug: "q" },
        });

        const read = await api(owner, `/organizations/${orgId}/api-keys`, {
            method: "POST",
            body: {
                name: "reader",
                scopes: ["project:read", "organization:read"],
                expiresInDays: 7,
            },
        });
        expect(read.status).toBe(201);
        readKey = createdApiKeySchema.parse(await read.json()).secret;
        const write = await api(owner, `/organizations/${orgId}/api-keys`, {
            method: "POST",
            body: { name: "writer", scopes: ["project:create", "project:read"], expiresInDays: 7 },
        });
        writeKey = createdApiKeySchema.parse(await write.json()).secret;
        // Kept apart from readKey, which a later test revokes.
        readKey2 = createdApiKeySchema.parse(
            await (
                await api(owner, `/organizations/${orgId}/api-keys`, {
                    method: "POST",
                    body: { name: "reader2", scopes: ["project:read"], expiresInDays: 7 },
                })
            ).json(),
        ).secret;

        const listed = await (await api(owner, `/organizations/${orgId}/api-keys`)).text();
        expect(listed).not.toContain(readKey);
        expect(z.array(apiKeySummarySchema).parse(JSON.parse(listed))).toHaveLength(3);
    });

    it("renders safe key metadata only to administrators, never the one-time values", async () => {
        const page = (cookie: string, path = `/orgs/${orgId}`) =>
            fetch(`${proxied.base}${path}`, { headers: { cookie }, redirect: "manual" });
        const metadata = z
            .array(apiKeySummarySchema)
            .parse(await (await api(owner, `/organizations/${orgId}/api-keys`)).json());
        const admin = await page(owner);
        expect(admin.headers.get("cache-control")).toContain("no-store");
        const html = await admin.text();
        expect(html).toContain('id="api-keys-heading"');
        expect(html).toContain("Issue an API key");
        for (const key of metadata) expect(html).toContain(key.prefix);
        for (const value of [readKey, readKey2, writeKey, "secret_hash", '"secret":']) {
            expect(html).not.toContain(value);
        }
        expect(html).not.toMatch(/lp_[A-Za-z0-9_-]{20,}/);

        expect(
            (
                await api(owner, `/organizations/${orgId}/members`, {
                    method: "POST",
                    body: { email: "other@example.com", role: "viewer" },
                })
            ).status,
        ).toBe(201);
        const viewer = await login("other@example.com", USER_PASSWORD, "198.51.100.22");
        const operator = await login("op@example.com", PASSWORD, "198.51.100.23");
        for (const cookie of [viewer, operator]) {
            const response = await page(cookie);
            expect(response.headers.get("cache-control")).toContain("no-store");
            const body = await response.text();
            expect(body).not.toContain('id="api-keys-heading"');
            for (const key of metadata) expect(body).not.toContain(key.prefix);
        }
        for (const path of ["/", "/_serverFn/missing-fixture-function"]) {
            expect((await page(owner, path)).headers.get("cache-control")).toContain("no-store");
        }
    });

    it("authenticates as a key, limited to its organization and scopes", async () => {
        const info = keyInfoSchema.parse(await (await bearer(readKey, "/key")).json());
        expect(info).toMatchObject({ organizationId: orgId, name: "reader" });
        // A key learns about itself, never about its creator.
        expect((await bearer(readKey, "/me")).status).toBe(403);
        const orgs = z
            .array(organizationSummarySchema)
            .parse(await (await bearer(readKey, "/organizations")).json());
        expect(orgs.map((o) => o.id)).toEqual([orgId]); // the owner is also in another org
        expect(
            z
                .array(projectSchema)
                .parse(await (await bearer(readKey, `/organizations/${orgId}/projects`)).json()),
        ).toHaveLength(2);
        // another organization of the same user: indistinguishable from absent
        expect((await bearer(readKey, `/organizations/${otherOrgId}/projects`)).status).toBe(404);
        // a scope it was not given
        expect((await bearer(readKey, `/organizations/${orgId}/members`)).status).toBe(403);
        const denied = await bearer(readKey, `/organizations/${orgId}/projects`, {
            method: "POST",
            body: { name: "No", slug: "no" },
        });
        expect(denied.status).toBe(403);
        expect(
            (
                await bearer(writeKey, `/organizations/${orgId}/projects`, {
                    method: "POST",
                    body: { name: "Yes", slug: "yes" },
                })
            ).status,
        ).toBe(201);
    });

    it("cannot manage keys, members, invitations or organizations, nor see /key as a session", async () => {
        const body = { name: "x", scopes: ["project:read"], expiresInDays: 1 };
        for (const [method, path, payload] of [
            ["GET", `/organizations/${orgId}/api-keys`, undefined],
            ["POST", `/organizations/${orgId}/api-keys`, body],
            [
                "POST",
                `/organizations/${orgId}/members`,
                { email: "other@example.com", role: "viewer" },
            ],
            ["GET", `/organizations/${orgId}/invitations`, undefined],
            ["POST", "/organizations", { name: "N", slug: "n", ownerEmail: "user@example.com" }],
        ] as const) {
            const response = await bearer(readKey, path, { method, body: payload });
            expect(response.status, `${method} ${path}`).toBe(403);
        }
        expect((await api(owner, "/key")).status).toBe(403);
    });

    it("limits a key to named projects and cannot widen itself by creating one", async () => {
        const invalid = await api(owner, `/organizations/${orgId}/api-keys`, {
            method: "POST",
            body: {
                name: "invalid-project-creator",
                scopes: ["project:create"],
                projectIds: [projectId],
                expiresInDays: 1,
            },
        });
        expect(invalid.status).toBe(422);
        const limited = createdApiKeySchema.parse(
            await (
                await api(owner, `/organizations/${orgId}/api-keys`, {
                    method: "POST",
                    body: {
                        name: "one-project",
                        scopes: ["project:read"],
                        projectIds: [projectId],
                        expiresInDays: 1,
                    },
                })
            ).json(),
        );
        const seen = z
            .array(projectSchema)
            .parse(await (await bearer(limited.secret, `/organizations/${orgId}/projects`)).json());
        expect(seen.map((p) => p.id)).toEqual([projectId]);
        // Keys issued before input validation tightened can still carry this
        // combination. Keep the route's project-limit defense for those rows.
        await testDb.db
            .updateTable("api_key")
            .set({ scopes: ["project:read", "project:create"] })
            .where("id", "=", limited.id)
            .execute();
        const create = await bearer(limited.secret, `/organizations/${orgId}/projects`, {
            method: "POST",
            body: { name: "Wide", slug: "wide" },
        });
        expect(create.status).toBe(403);
    });

    it("refuses every session-only operation to a key, driven from the OpenAPI document", async () => {
        const spec = (await (await fetch(`${proxied.base}/api/openapi/json`)).json()) as {
            paths: Record<string, Record<string, { security?: Record<string, unknown>[] }>>;
        };
        const zero = "00000000-0000-4000-8000-000000000000";
        let checked = 0;
        for (const [template, methods] of Object.entries(spec.paths)) {
            for (const [method, operation] of Object.entries(methods)) {
                const security = operation.security ?? [];
                if (security.length === 0 || security.some((entry) => "bearerKey" in entry))
                    continue;
                const path = template
                    .replace("/api/v1", "")
                    .replace("{orgId}", orgId)
                    .replace(/\{\w+\}/g, zero);
                const response = await bearer(readKey2, path, {
                    method: method.toUpperCase(),
                    body: method === "get" || method === "delete" ? undefined : {},
                });
                expect(response.status, `${method} ${template}`).toBe(403);
                checked++;
            }
        }
        expect(checked).toBeGreaterThanOrEqual(8);
    });

    it("needs a fresh sign-in to issue a key, and keeps the origin check when a cookie rides along", async () => {
        const session = await testDb.db
            .selectFrom("session")
            .innerJoin("user", "user.id", "session.userId")
            .select("session.id")
            .where("user.email", "=", "user@example.com")
            .execute();
        await testDb.db
            .updateTable("session")
            .set({ createdAt: new Date(Date.now() - 3_600_000) })
            .where(
                "id",
                "in",
                session.map((s) => s.id),
            )
            .execute();
        const stale = await api(owner, `/organizations/${orgId}/api-keys`, {
            method: "POST",
            body: { name: "late", scopes: ["project:read"], expiresInDays: 1 },
        });
        expect(stale.status).toBe(403);
        const stalePage = await fetch(`${proxied.base}/orgs/${orgId}`, {
            headers: { cookie: owner },
        });
        expect(await stalePage.text()).toContain("Sign out and sign in again");
        await testDb.db
            .updateTable("session")
            .set({ createdAt: new Date() })
            .where(
                "id",
                "in",
                session.map((s) => s.id),
            )
            .execute();
        const crossOrigin = await fetch(`${proxied.base}/api/v1/organizations/${orgId}/projects`, {
            method: "POST",
            headers: {
                cookie: owner,
                origin: "https://evil.example.com",
                authorization: `Bearer ${writeKey}`,
                "content-type": "application/json",
            },
            body: JSON.stringify({ name: "Evil", slug: "evil" }),
        });
        expect(crossOrigin.status).toBe(403);
        expect(errorSchema.parse(await crossOrigin.json()).code).toBe("forbidden-origin");
    });

    it("rejects an expired key, and refuses an Authorization header on public routes", async () => {
        const expired = createdApiKeySchema.parse(
            await (
                await api(owner, `/organizations/${orgId}/api-keys`, {
                    method: "POST",
                    body: { name: "short", scopes: ["project:read"], expiresInDays: 1 },
                })
            ).json(),
        );
        await testDb.db
            .updateTable("api_key")
            .set({ expires_at: new Date(Date.now() - 1000) })
            .where("id", "=", expired.id)
            .execute();
        expect((await bearer(expired.secret, "/organizations")).status).toBe(401);
        const preview = await fetch(`${proxied.base}/api/v1/invitations/preview`, {
            method: "POST",
            headers: { authorization: `Bearer ${writeKey}`, "content-type": "application/json" },
            body: JSON.stringify({ token: "x".repeat(30) }),
        });
        expect(preview.status).toBe(401);
    });

    it("rejects bad credentials with 401 and never falls back to the cookie", async () => {
        expect((await bearer("lp_nope", "/organizations")).status).toBe(401);
        expect(
            (
                await fetch(`${proxied.base}/api/v1/organizations`, {
                    headers: { authorization: "Basic abc", cookie: owner },
                })
            ).status,
        ).toBe(401);
        expect(
            (
                await fetch(`${proxied.base}/api/v1/organizations`, {
                    headers: { authorization: "Bearer lp_nope", cookie: owner },
                })
            ).status,
        ).toBe(401);
    });

    it("stops working when revoked", async () => {
        const list = z
            .array(apiKeySummarySchema)
            .parse(await (await api(owner, `/organizations/${orgId}/api-keys`)).json());
        const reader = list.find((k) => k.name === "reader")!;
        expect(
            (
                await api(owner, `/organizations/${orgId}/api-keys/${reader.id}`, {
                    method: "DELETE",
                })
            ).status,
        ).toBe(200);
        expect((await bearer(readKey, "/organizations")).status).toBe(401);
        // Revoking one key leaves the others valid; this one simply lacks organization:read.
        expect((await bearer(writeKey, "/organizations")).status).toBe(403);
    });
});

// Sends one HTTP request over a raw socket, for what fetch will not send: a length
// that was never delivered, chunked bodies, and connections that drop or stall.
function rawUpload(
    instance: Instance,
    headers: Record<string, string>,
    send: (socket: net.Socket) => void,
    target = uploadPath,
): Promise<{ status: number; elapsedMs: number }> {
    const url = new URL(instance.base);
    const started = Date.now();
    return new Promise((resolve, reject) => {
        const socket = net.connect(Number(url.port), url.hostname);
        let head = "";
        socket.setTimeout(15_000, () => {
            socket.destroy();
            reject(new Error("no response"));
        });
        socket.on("data", (chunk) => {
            head += chunk.toString("latin1");
            const status = /^HTTP\/1\.1 (\d{3})/.exec(head)?.[1];
            if (status) {
                socket.destroy();
                resolve({ status: Number(status), elapsedMs: Date.now() - started });
            }
        });
        socket.on("error", () => {});
        socket.on("close", () => {
            if (!/^HTTP\/1\.1 \d{3}/.test(head)) {
                resolve({ status: 0, elapsedMs: Date.now() - started });
            }
        });
        const lines = [
            `POST ${target} HTTP/1.1`,
            `Host: ${url.host}`,
            ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
            "",
            "",
        ];
        socket.write(lines.join("\r\n"));
        send(socket);
    });
}
let uploadPath = "";
const rawUploadTo = (target: string, headers: Record<string, string>) =>
    rawUpload(proxied, headers, (socket) => socket.write("5\r\nhello\r\n0\r\n\r\n"), target);

describe("artifact upload over HTTP", () => {
    let owner = "";
    let viewer = "";
    let orgId = "";
    const archive = (extra: { name: string; content: string | Buffer }[] = []) =>
        tarGz([...SITE, ...extra]);
    const post = (cookie: string, body: Buffer | string, headers: Record<string, string> = {}) =>
        fetch(`${proxied.base}/api/v1/organizations/${orgId}/artifacts`, {
            method: "POST",
            headers: {
                cookie,
                origin: proxied.base,
                "content-type": "application/gzip",
                ...headers,
            },
            body: body as BodyInit,
        });
    const tmpFiles = () => fs.readdir(path.join(dataDir, "tmp")).catch(() => [] as string[]);
    const rows = () => testDb.db.selectFrom("artifact").select("id").execute();
    const cookieHeaders = (extra: Record<string, string> = {}) => ({
        Cookie: owner,
        Origin: proxied.base,
        "Content-Type": "application/gzip",
        Connection: "close",
        ...extra,
    });

    it("stores a multi-megabyte archive streamed through the built server", async () => {
        const operator = await login("op@example.com", PASSWORD, "198.51.100.40");
        owner = await login("user@example.com", USER_PASSWORD, "198.51.100.41");
        viewer = await login("other@example.com", USER_PASSWORD, "198.51.100.42");
        orgId = createdOrganizationSchema.parse(
            await (
                await api(operator, "/organizations", {
                    method: "POST",
                    body: { name: "Uploads", slug: "uploads", ownerEmail: "user@example.com" },
                })
            ).json(),
        ).id;
        uploadPath = `/api/v1/organizations/${orgId}/artifacts`;
        await api(owner, `/organizations/${orgId}/members`, {
            method: "POST",
            body: { email: "other@example.com", role: "viewer" },
        });

        // Incompressible, so the stored archive is genuinely several megabytes.
        const bytes = archive([{ name: "assets/big.bin", content: randomBytes(5 * 1024 * 1024) }]);
        expect(bytes.length).toBeGreaterThan(5 * 1024 * 1024);
        const response = await post(owner, bytes);
        expect(response.status).toBe(201);
        expect(response.headers.get("cache-control")).toContain("no-store");
        const artifact = artifactSchema.parse(await response.json());
        expect(artifact).toMatchObject({ reused: false, sizeBytes: bytes.length });
        const stored = await testDb.db
            .selectFrom("artifact")
            .select("storage_key")
            .where("id", "=", artifact.id)
            .executeTakeFirstOrThrow();
        expect((await fs.readFile(path.join(dataDir, stored.storage_key))).equals(bytes)).toBe(
            true,
        );
        expect(await tmpFiles()).toEqual([]);

        const again = artifactSchema.parse(await (await post(owner, bytes)).json());
        expect(again).toMatchObject({ id: artifact.id, reused: true });
    });

    it("refuses wrong content types, hostile archives and unauthorized callers", async () => {
        const before = (await rows()).length;
        const json = await post(owner, "{}", { "content-type": "application/json" });
        expect(json.status).toBe(422);
        const hostile = await post(
            owner,
            tarGz([...SITE, { name: "../escape.txt", content: "x" }]),
        );
        expect(hostile.status).toBe(422);
        const problem = errorSchema.parse(await hostile.json());
        expect(problem.code).toBe("invalid");
        expect(problem.title).not.toContain(dataDir);
        expect((await post(owner, tarGz([{ name: "other.html", content: "x" }]))).status).toBe(422);
        expect((await post(viewer, archive())).status).toBe(403);
        expect(
            (
                await fetch(`${proxied.base}/api/v1/organizations/${orgId}/artifacts`, {
                    method: "POST",
                    headers: { origin: proxied.base, "content-type": "application/gzip" },
                    body: archive(),
                })
            ).status,
        ).toBe(401);
        const foreign = await post(owner, archive(), { origin: "https://evil.example.com" });
        expect(foreign.status).toBe(403);
        expect(errorSchema.parse(await foreign.json()).code).toBe("forbidden-origin");
        expect((await rows()).length).toBe(before);
        expect(await tmpFiles()).toEqual([]);
    });

    it("rejects an oversized or unframed upload before reading its body", async () => {
        const tooBig = await rawUpload(
            proxied,
            cookieHeaders({ "Content-Length": String(UPLOAD_LIMIT + 1) }),
            () => {},
        );
        expect(tooBig.status).toBe(413);
        const chunked = await rawUpload(
            proxied,
            cookieHeaders({ "Transfer-Encoding": "chunked" }),
            (socket) => socket.write("5\r\nhello\r\n0\r\n\r\n"),
        );
        expect(chunked.status).toBe(411);
        // Not signed in: refused without waiting for the (never sent) rest of the body.
        const anonymous = await rawUpload(
            proxied,
            {
                Origin: proxied.base,
                "Content-Type": "application/gzip",
                "Content-Length": "4000000",
                Connection: "close",
            },
            (socket) => socket.write(randomBytes(1000)),
        );
        expect(anonymous.status).toBe(401);
        expect(anonymous.elapsedMs).toBeLessThan(3000);
        // A path that merely contains an auth route's name must not reach the JSON
        // readers of the password-reset and sign-in throttles, which would buffer an
        // upload-sized body before authentication.
        for (const name of ["request-password-reset", "sign-in/email"]) {
            const lookalike = await rawUpload(
                proxied,
                {
                    Origin: proxied.base,
                    "Content-Type": "application/gzip",
                    "Content-Length": "4000000",
                    Connection: "close",
                },
                (socket) => socket.write(randomBytes(1000)),
                `/api/v1/organizations/${encodeURIComponent(name)}/artifacts`,
            );
            expect(lookalike.status, name).toBe(401);
            expect(lookalike.elapsedMs, name).toBeLessThan(3000);
        }
        expect(await tmpFiles()).toEqual([]);
    });

    it("cleans up an upload whose connection drops, and keeps serving", async () => {
        const before = (await rows()).length;
        let staged = 0;
        await rawUpload(proxied, cookieHeaders({ "Content-Length": "3000000" }), (socket) => {
            socket.write(randomBytes(500_000));
            // Drop only once the server really has a staged file, so cleanup is exercised.
            void expect
                .poll(async () => (staged = (await tmpFiles()).length), { timeout: 8000 })
                .toBe(1)
                .finally(() => socket.destroy());
        });
        await expect.poll(async () => (await tmpFiles()).length, { timeout: 10_000 }).toBe(0);
        expect(staged).toBe(1);
        expect((await rows()).length).toBe(before);
        expect((await fetch(`${proxied.base}/api/health`)).ok).toBe(true);
    });

    it("times out a stalled upload with 408 and cleans up", async () => {
        const stalled = await rawUpload(
            proxied,
            cookieHeaders({ "Content-Length": "3000000" }),
            (socket) => socket.write(randomBytes(200_000)),
        );
        expect(stalled.status).toBe(408);
        expect(stalled.elapsedMs).toBeLessThan(12_000);
        await expect.poll(async () => (await tmpFiles()).length, { timeout: 10_000 }).toBe(0);
    });
});

describe("previews and deployments over HTTP", () => {
    let owner = "";
    let viewer = "";
    let orgId = "";
    let otherOrgId = "";
    let p1 = "";
    let p2 = "";
    let deployKey = "";
    let limitedKey = "";
    let readKey = "";
    let artifactId = "";
    let previewId = "";
    let otherPreviewId = "";
    let deploymentId = "";

    const call = (
        key: string,
        path: string,
        init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
    ) =>
        fetch(`${proxied.base}/api/v1${path}`, {
            method: init.method ?? "GET",
            headers: {
                authorization: `Bearer ${key}`,
                ...(init.body === undefined ? {} : { "content-type": "application/json" }),
                ...init.headers,
            },
            body: init.body === undefined ? undefined : JSON.stringify(init.body),
        });
    const status = async (promise: Promise<Response>) => (await promise).status;
    const mintKey = async (name: string, scopes: string[], projectIds?: string[]) =>
        createdApiKeySchema.parse(
            await (
                await api(owner, `/organizations/${orgId}/api-keys`, {
                    method: "POST",
                    body: { name, scopes, expiresInDays: 7, ...(projectIds ? { projectIds } : {}) },
                })
            ).json(),
        ).secret;

    it("is set up: two projects, keys of different reach, a viewer", async () => {
        const operator = await login("op@example.com", PASSWORD, "198.51.100.60");
        owner = await login("user@example.com", USER_PASSWORD, "198.51.100.61");
        viewer = await login("other@example.com", USER_PASSWORD, "198.51.100.62");
        const makeOrg = async (name: string, slug: string, email: string) =>
            createdOrganizationSchema.parse(
                await (
                    await api(operator, "/organizations", {
                        method: "POST",
                        body: { name, slug, ownerEmail: email },
                    })
                ).json(),
            ).id;
        orgId = await makeOrg("Previews", "previews-org", "user@example.com");
        otherOrgId = await makeOrg("Previews Two", "previews-two", "other@example.com");
        await api(owner, `/organizations/${orgId}/members`, {
            method: "POST",
            body: { email: "other@example.com", role: "viewer" },
        });
        const project = async (slug: string) =>
            createdProjectSchema.parse(
                await (
                    await api(owner, `/organizations/${orgId}/projects`, {
                        method: "POST",
                        body: { name: slug, slug },
                    })
                ).json(),
            ).id;
        p1 = await project("site");
        p2 = await project("docs");
        const all = ["preview:read", "preview:create", "preview:deploy", "project:read"];
        deployKey = await mintKey("deployer", all);
        limitedKey = await mintKey("limited", all, [p1]);
        readKey = await mintKey("reader", ["preview:read"]);
    });

    it("creates a preview with a generated hostname, and repeats safely with an idempotency key", async () => {
        const path = `/organizations/${orgId}/projects/${p1}/previews`;
        const first = await call(deployKey, path, {
            method: "POST",
            body: { slug: "review" },
            headers: { "idempotency-key": "create-1" },
        });
        expect(first.status).toBe(201);
        const preview = previewSchema.parse(await first.json());
        previewId = preview.id;
        expect(preview.hostname).toMatch(/^review-[a-z0-9]{6}\.previews\.example\.com$/);
        expect(preview).toMatchObject({ state: "active", activeDeploymentId: null });

        const replay = await call(deployKey, path, {
            method: "POST",
            body: { slug: "review" },
            headers: { "idempotency-key": "create-1" },
        });
        expect(previewSchema.parse(await replay.json()).id).toBe(previewId);
        const clash = await call(deployKey, path, {
            method: "POST",
            body: { slug: "other-name" },
            headers: { "idempotency-key": "create-1" },
        });
        expect(clash.status).toBe(409);

        otherPreviewId = previewSchema.parse(
            await (
                await call(deployKey, `/organizations/${orgId}/projects/${p2}/previews`, {
                    method: "POST",
                    body: { slug: "docs-review" },
                })
            ).json(),
        ).id;
    });

    it("keeps keys to their scopes, projects and organization", async () => {
        const p1Path = `/organizations/${orgId}/projects/${p1}/previews`;
        const p2Path = `/organizations/${orgId}/projects/${p2}/previews`;
        // No scope: forbidden. A limited key reaches its own project only.
        expect(
            await status(call(readKey, p1Path, { method: "POST", body: { slug: "nope" } })),
        ).toBe(403);
        expect(
            await status(call(limitedKey, p2Path, { method: "POST", body: { slug: "nope" } })),
        ).toBe(404);
        expect(
            await status(call(limitedKey, p1Path, { method: "POST", body: { slug: "mine" } })),
        ).toBe(201);
        // Its reads are limited the same way, however the preview is named.
        expect(
            await status(call(limitedKey, `/organizations/${orgId}/previews/${previewId}`)),
        ).toBe(200);
        expect(
            await status(call(limitedKey, `/organizations/${orgId}/previews/${otherPreviewId}`)),
        ).toBe(404);
        const listed = previewListSchema.parse(
            await (await call(limitedKey, `/organizations/${orgId}/previews`)).json(),
        );
        expect(listed.items.map((p) => p.projectId)).toEqual([p1, p1]);
        const unlimited = previewListSchema.parse(
            await (await call(readKey, `/organizations/${orgId}/previews`)).json(),
        );
        expect(unlimited.items).toHaveLength(3);
        expect(
            previewListSchema.parse(
                await (
                    await call(readKey, `/organizations/${orgId}/previews?projectId=${p2}`)
                ).json(),
            ).items,
        ).toHaveLength(1);
        expect(
            await status(call(limitedKey, `/organizations/${orgId}/previews?projectId=${p2}`)),
        ).toBe(404);
        expect(await status(call(readKey, `/organizations/${orgId}/previews?cursor=nope`))).toBe(
            422,
        );
        // Another organization is indistinguishable from one that does not exist.
        expect(await status(call(deployKey, `/organizations/${otherOrgId}/previews`))).toBe(404);
        // A viewer reads but cannot create.
        expect((await api(viewer, `/organizations/${orgId}/previews`)).status).toBe(200);
        expect(
            (await api(viewer, p1Path, { method: "POST", body: { slug: "viewer" } })).status,
        ).toBe(403);
    });

    it("accepts an upload from a key with the deploy scope, and from nobody else", async () => {
        const upload = (key: string) =>
            fetch(`${proxied.base}/api/v1/organizations/${orgId}/artifacts`, {
                method: "POST",
                headers: { authorization: `Bearer ${key}`, "content-type": "application/gzip" },
                body: tarGz(SITE) as BodyInit,
            });
        expect(await status(upload(readKey))).toBe(403);
        const ok = await upload(deployKey);
        expect(ok.status).toBe(201);
        artifactId = artifactSchema.parse(await ok.json()).id;
    });

    it("queues a deployment once, repeats safely, and refuses a second while one is unfinished", async () => {
        const path = `/organizations/${orgId}/previews/${previewId}/deployments`;
        const deploy = (key: string, body: unknown, idem?: string) =>
            call(key, path, {
                method: "POST",
                body,
                headers: idem ? { "idempotency-key": idem } : {},
            });
        const first = await deploy(deployKey, { artifactId, spa: true }, "deploy-1");
        expect(first.status).toBe(202);
        const queued = createdDeploymentSchema.parse(await first.json());
        deploymentId = queued.id;
        expect(queued.status).toBe("queued");

        const replay = await deploy(deployKey, { artifactId, spa: true }, "deploy-1");
        expect(createdDeploymentSchema.parse(await replay.json()).id).toBe(deploymentId);
        expect(await status(deploy(deployKey, { artifactId, spa: false }, "deploy-1"))).toBe(409);
        // A different request while this one is unfinished.
        expect(await status(deploy(deployKey, { artifactId }, "deploy-2"))).toBe(409);
        expect(await status(deploy(deployKey, { artifactId }))).toBe(409);

        expect(await status(deploy(readKey, { artifactId }))).toBe(403);
        expect(
            await status(
                call(limitedKey, `/organizations/${orgId}/previews/${otherPreviewId}/deployments`, {
                    method: "POST",
                    body: { artifactId },
                }),
            ),
        ).toBe(404);
        expect(await status(deploy(deployKey, { artifactId: "not-a-uuid" }))).toBe(422);
        expect(await status(deploy(deployKey, { artifactId, extra: 1 }))).toBe(422);
        const viewerAttempt = await fetch(`${proxied.base}/api/v1${path}`, {
            method: "POST",
            headers: { cookie: viewer, origin: proxied.base, "content-type": "application/json" },
            body: JSON.stringify({ artifactId }),
        });
        expect(viewerAttempt.status).toBe(403);
    });

    it("reports status, a safe failure and ordered events, and hides them from other reach", async () => {
        const base = `/organizations/${orgId}/deployments/${deploymentId}`;
        const got = deploymentSchema.parse(await (await call(readKey, base)).json());
        expect(got).toMatchObject({
            id: deploymentId,
            previewId,
            artifactId,
            spa: true,
            status: "queued",
            failure: null,
        });
        expect(JSON.stringify(got)).not.toMatch(/image|attempt|lease|app_name|lp-/);

        await testDb.db
            .insertInto("deployment_event")
            .values(
                [1, 2, 3].map((seq) => ({
                    organization_id: orgId,
                    deployment_id: deploymentId,
                    seq,
                    phase: "build",
                    message: `step ${seq}`,
                })),
            )
            .execute();
        const events = deploymentEventsSchema.parse(
            await (await call(readKey, `${base}/events?after=1`)).json(),
        );
        expect(events.items.map((e) => e.seq)).toEqual([2, 3]);
        expect(events.nextAfter).toBeNull();
        expect(await status(call(readKey, `${base}/events?after=-1`))).toBe(404);

        await testDb.db
            .updateTable("deployment")
            .set({
                status: "failed",
                failure_code: "build-failed",
                failure_message: "The build step failed.",
                finished_at: new Date(),
            })
            .where("id", "=", deploymentId)
            .execute();
        const failed = deploymentSchema.parse(await (await call(readKey, base)).json());
        expect(failed.failure).toEqual({ code: "build-failed", message: "The build step failed." });
        expect(failed.finishedAt).not.toBeNull();

        const history = await call(
            readKey,
            `/organizations/${orgId}/previews/${previewId}/deployments`,
        );
        expect((await history.json()).items[0].id).toBe(deploymentId);

        // The same ids through a key limited to the other project, or another organization.
        const other = await testDb.db
            .insertInto("deployment")
            .values({
                organization_id: orgId,
                preview_id: otherPreviewId,
                artifact_id: artifactId,
                requested_by: (
                    await testDb.db
                        .selectFrom("user")
                        .select("id")
                        .where("email", "=", "user@example.com")
                        .executeTakeFirstOrThrow()
                ).id,
            })
            .returning("id")
            .executeTakeFirstOrThrow();
        expect(
            await status(call(limitedKey, `/organizations/${orgId}/deployments/${other.id}`)),
        ).toBe(404);
        expect(
            await status(
                call(limitedKey, `/organizations/${orgId}/deployments/${other.id}/events`),
            ),
        ).toBe(404);
        expect(
            await status(
                call(deployKey, `/organizations/${otherOrgId}/deployments/${deploymentId}`),
            ),
        ).toBe(404);
        expect(
            await status(
                call(
                    readKey,
                    `/organizations/${orgId}/deployments/${"0".repeat(8)}-0000-4000-8000-000000000000`,
                ),
            ),
        ).toBe(404);
        // A failed deployment frees the preview for the next one.
        await testDb.db.deleteFrom("deployment").where("id", "=", other.id).execute();
        expect(
            await status(
                call(deployKey, `/organizations/${orgId}/previews/${previewId}/deployments`, {
                    method: "POST",
                    body: { artifactId },
                }),
            ),
        ).toBe(202);
    });

    it("is driven end to end by the client library: its parsers accept the real controller", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "launchpad-e2e-site-"));
        const config = await fs.mkdtemp(path.join(os.tmpdir(), "launchpad-e2e-config-"));
        try {
            await fs.writeFile(path.join(root, "index.html"), "<p>hello</p>");
            await fs.mkdir(path.join(root, "assets"));
            await fs.writeFile(path.join(root, "assets", "app.js"), "console.log(1)");
            const ctx = createContext({
                LAUNCHPAD_CONFIG_DIR: config,
                LAUNCHPAD_CONTROLLER: proxied.base,
                LAUNCHPAD_API_KEY: deployKey,
            });
            // No worker runs here, so the deployment stays queued: --no-wait.
            const result = await deployWithClient(ctx, {
                source: root,
                project: "site",
                name: "from-the-cli",
                spa: true,
                wait: false,
            });
            expect(result.outcome).toBe("queued");
            expect(result.preview.hostname).toMatch(
                /^from-the-cli-[a-z0-9]{6}\.previews\.example\.com$/,
            );
            // Deploying the same site again finds the same preview (and conflicts while
            // the first deployment is unfinished).
            await expect(
                deployWithClient(ctx, {
                    source: root,
                    project: "site",
                    name: "from-the-cli",
                    wait: false,
                }),
            ).rejects.toMatchObject({ status: 409 });
            const deployment = await getDeployment(ctx, result.deployment.id);
            expect(deployment).toMatchObject({ status: "queued", spa: true, failure: null });
            expect((await deploymentEvents(ctx, deployment.id, { after: 0 })).items).toEqual([]);
            const previews = await listPreviews(ctx, { project: "site" });
            expect(previews.items.map((p) => p.slug)).toContain("from-the-cli");
        } finally {
            await fs.rm(root, { recursive: true, force: true });
            await fs.rm(config, { recursive: true, force: true });
        }
    });

    it("is driven by a real MCP client over stdio: the built binary reads, deploys within its policy, and follows the deployment", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "launchpad-mcp-e2e-"));
        const config = await fs.mkdtemp(path.join(os.tmpdir(), "launchpad-mcp-e2e-config-"));
        const binary = path.resolve(import.meta.dirname, "../../../mcp/dist/index.js");
        const connect = async (key: string, extra: string[]) => {
            const client = new Client({ name: "e2e", version: "1" });
            await client.connect(
                new StdioClientTransport({
                    command: process.execPath,
                    args: [binary, "--shared", ...extra],
                    env: {
                        PATH: process.env.PATH ?? "",
                        LAUNCHPAD_CONFIG_DIR: config,
                        LAUNCHPAD_CONTROLLER: proxied.base,
                        LAUNCHPAD_API_KEY: key,
                    },
                    stderr: "pipe",
                }),
            );
            return client;
        };
        const clients: Client[] = [];
        let standIn: Promise<void> | undefined;
        let stopStandIn = false;
        try {
            await fs.mkdir(path.join(root, "dist", "private"), { recursive: true });
            await fs.writeFile(path.join(root, "dist", "index.html"), "<p>hello</p>");
            await fs.writeFile(path.join(root, "dist", "app.js"), "console.log(1)");
            await fs.writeFile(path.join(root, "dist", "app.js.map"), "{}");
            await fs.writeFile(path.join(root, "dist", "private", "notes.txt"), "internal");
            const policy = [
                "--allow-deploy",
                "--include",
                "dist/**",
                "--exclude",
                "**/*.map",
                "--exclude",
                "dist/private/**",
            ];

            const reader = await connect(deployKey, []);
            clients.push(reader);
            expect((await reader.listTools()).tools.map((t) => t.name)).not.toContain("deploy");
            const projects = await reader.callTool({
                name: "list_projects",
                arguments: { working_dir: root },
            });
            expect(projects.isError).toBe(false);
            expect(JSON.stringify(projects.structuredContent)).toContain('"slug":"site"');

            const client = await connect(deployKey, policy);
            clients.push(client);
            expect((await client.listTools()).tools.map((t) => t.name)).toContain("deploy");
            // No worker runs in this suite, so a stand-in finishes the deployment the way one
            // would (the state machine itself is tested in the services): it waits for the
            // queued row, then marks it succeeded while the tool is still following it.
            standIn = (async () => {
                for (let i = 0; i < 200 && !stopStandIn; i++) {
                    const row = await testDb.db
                        .selectFrom("deployment")
                        .innerJoin("preview", "preview.id", "deployment.preview_id")
                        .select(["deployment.id", "deployment.preview_id"])
                        .where("preview.slug", "=", "from-mcp")
                        .where("deployment.status", "=", "queued")
                        .executeTakeFirst();
                    if (row) {
                        await testDb.db
                            .updateTable("deployment")
                            .set({ status: "succeeded", finished_at: new Date() })
                            .where("id", "=", row.id)
                            .execute();
                        await testDb.db
                            .updateTable("preview")
                            .set({ active_deployment_id: row.id })
                            .where("id", "=", row.preview_id)
                            .execute();
                        return;
                    }
                    await new Promise((resolve) => setTimeout(resolve, 50));
                }
                if (!stopStandIn) throw new Error("the deployment was never queued");
            })();
            const deployed = await client.callTool({
                name: "deploy",
                arguments: {
                    working_dir: root,
                    path: "dist",
                    project: "site",
                    name: "from-mcp",
                    confirm: true,
                    wait_seconds: 60,
                },
            });
            await standIn;
            expect(deployed.isError, JSON.stringify(deployed)).toBe(false);
            const data = (
                deployed.structuredContent as {
                    data: {
                        outcome: string;
                        preview: { id: string; hostname: string };
                        artifact: { id: string };
                        deployment: { id: string };
                    };
                }
            ).data;
            expect(data.outcome).toBe("succeeded");
            expect(data.preview.hostname).toMatch(/^from-mcp-[a-z0-9]{6}\.previews\.example\.com$/);

            // The controller stored exactly what the policy allowed.
            const stored = await testDb.db
                .selectFrom("artifact")
                .select("storage_key")
                .where("id", "=", data.artifact.id)
                .executeTakeFirstOrThrow();
            const tar = Bun.gunzipSync(await fs.readFile(path.join(dataDir, stored.storage_key)));
            const headers = Buffer.from(tar).toString("latin1");
            expect(headers).toContain("index.html");
            expect(headers).toContain("app.js");
            expect(headers).not.toContain("app.js.map");
            expect(headers).not.toContain("notes.txt");

            const followed = await client.callTool({
                name: "get_deployment",
                arguments: { working_dir: root, deployment_id: data.deployment.id },
            });
            expect(followed.structuredContent).toMatchObject({
                data: { id: data.deployment.id, status: "succeeded", failure: null },
            });
            const listed = await client.callTool({
                name: "list_previews",
                arguments: { working_dir: root, project: "site" },
            });
            expect(JSON.stringify(listed.structuredContent)).toContain("from-mcp");

            // A key that can do everything but deploy is refused by the controller, at the
            // deploy scope, not by a hint and not for lacking some earlier permission.
            const noDeploy = await mintKey("no-deploy", [
                "preview:read",
                "preview:create",
                "project:read",
            ]);
            const artifactsBefore = (await testDb.db.selectFrom("artifact").select("id").execute())
                .length;
            const limited = await connect(noDeploy, policy);
            clients.push(limited);
            const refused = await limited.callTool({
                name: "deploy",
                arguments: {
                    working_dir: root,
                    path: "dist",
                    project: "site",
                    name: "from-mcp-two",
                    confirm: true,
                    wait_seconds: 0,
                },
            });
            expect(refused.isError).toBe(true);
            expect(refused.structuredContent).toMatchObject({
                data: { code: "forbidden", status: 403 },
            });
            expect((await testDb.db.selectFrom("artifact").select("id").execute()).length).toBe(
                artifactsBefore,
            );
        } finally {
            // Stop the stand-in and wait for it, so it never touches the database after the
            // test, even when the call above failed.
            stopStandIn = true;
            await standIn?.catch(() => {});
            for (const client of clients) await client.close().catch(() => {});
            await fs.rm(root, { recursive: true, force: true });
            await fs.rm(config, { recursive: true, force: true });
        }
    });

    it("runs from its built file alone, outside the repository and its node_modules", async () => {
        const alone = await fs.mkdtemp(path.join(os.tmpdir(), "launchpad-standalone-"));
        try {
            for (const app of ["mcp", "cli"]) {
                const built = path.resolve(import.meta.dirname, `../../../${app}/dist/index.js`);
                await fs.copyFile(built, path.join(alone, `${app}.js`));
            }
            const client = new Client({ name: "standalone", version: "1" });
            try {
                await client.connect(
                    new StdioClientTransport({
                        command: process.execPath,
                        args: [path.join(alone, "mcp.js"), "--shared"],
                        cwd: alone,
                        env: { PATH: process.env.PATH ?? "", HOME: alone },
                    }),
                );
                expect((await client.listTools()).tools.length).toBeGreaterThan(0);
            } finally {
                await client.close().catch(() => {});
            }
            const help = await new Promise<{ code: number | null; out: string }>((resolve) => {
                const child = spawn(process.execPath, [path.join(alone, "cli.js"), "--help"], {
                    cwd: alone,
                    env: { PATH: process.env.PATH ?? "", HOME: alone },
                });
                let out = "";
                child.stdout.on("data", (b) => (out += b));
                child.stderr.on("data", (b) => (out += b));
                child.on("close", (code) => resolve({ code, out }));
            });
            expect(help.code).toBe(0);
            expect(help.out).toContain("launchpad");
        } finally {
            await fs.rm(alone, { recursive: true, force: true });
        }
    });

    it("lets an administrator resolve a deployment that needs one, and nobody else", async () => {
        // One unfinished deployment per preview: leave only this one.
        await testDb.db
            .deleteFrom("deployment")
            .where("preview_id", "=", previewId)
            .where("id", "!=", deploymentId)
            .execute();
        await testDb.db
            .updateTable("deployment")
            .set({ status: "reconciliation-needed" })
            .where("id", "=", deploymentId)
            .execute();
        const path = `/organizations/${orgId}/deployments/${deploymentId}/resolution`;
        // An API key cannot do this, whatever its scopes.
        expect(
            await status(call(deployKey, path, { method: "POST", body: { outcome: "failed" } })),
        ).toBe(403);
        const viewerAttempt = await fetch(`${proxied.base}/api/v1${path}`, {
            method: "POST",
            headers: { cookie: viewer, origin: proxied.base, "content-type": "application/json" },
            body: JSON.stringify({ outcome: "failed" }),
        });
        expect(viewerAttempt.status).toBe(403);
        expect(
            (await api(owner, path, { method: "POST", body: { outcome: "maybe" } })).status,
        ).toBe(422);
        expect(
            (await api(owner, path, { method: "POST", body: { outcome: "failed" } })).status,
        ).toBe(200);
        const after = deploymentSchema.parse(
            await (
                await call(readKey, `/organizations/${orgId}/deployments/${deploymentId}`)
            ).json(),
        );
        expect(after.status).toBe("failed");
        // Already resolved.
        expect(
            (await api(owner, path, { method: "POST", body: { outcome: "failed" } })).status,
        ).toBe(409);
    });

    it("extends and deletes with scopes and project limits, and resolves with sessions only", async () => {
        const create = async (projectId: string, slug: string) =>
            previewSchema.parse(
                await (
                    await call(
                        deployKey,
                        `/organizations/${orgId}/projects/${projectId}/previews`,
                        { method: "POST", body: { slug, ttl: "1h" } },
                    )
                ).json(),
            );
        const own = await create(p1, "lifecycle");
        const other = await create(p2, "lifecycle-other");
        const ownPath = `/organizations/${orgId}/previews/${own.id}`;
        const otherPath = `/organizations/${orgId}/previews/${other.id}`;
        const deleteKey = await mintKey("delete-only", ["preview:delete"], [p1]);
        const limitedRead = await mintKey("read-one", ["preview:read"], [p1]);
        expect(
            await status(
                call(readKey, `${ownPath}/extend`, { method: "POST", body: { ttl: "1h" } }),
            ),
        ).toBe(403);
        expect(
            await status(
                call(deleteKey, `${ownPath}/extend`, { method: "POST", body: { ttl: "1h" } }),
            ),
        ).toBe(403);
        expect(
            await status(
                call(limitedKey, `${otherPath}/extend`, { method: "POST", body: { ttl: "1h" } }),
            ),
        ).toBe(404);
        expect(
            await status(
                call(deployKey, `/organizations/${otherOrgId}/previews/${own.id}/extend`, {
                    method: "POST",
                    body: { ttl: "1h" },
                }),
            ),
        ).toBe(404);
        for (const ttl of ["0h", "31d", "garbage", "none"]) {
            expect(
                await status(
                    call(limitedKey, `${ownPath}/extend`, { method: "POST", body: { ttl } }),
                ),
                ttl,
            ).toBe(422);
        }
        const extend = () =>
            call(limitedKey, `${ownPath}/extend`, {
                method: "POST",
                body: { ttl: "1h" },
                headers: { "idempotency-key": "extend-http-1" },
            });
        const extended = previewSchema.parse(await (await extend()).json());
        expect(Date.parse(extended.expiresAt!)).toBeGreaterThan(Date.parse(own.expiresAt!));
        expect(previewSchema.parse(await (await extend()).json()).expiresAt).toBe(
            extended.expiresAt,
        );
        const later = previewSchema.parse(
            await (
                await call(limitedKey, `${ownPath}/extend`, {
                    method: "POST",
                    body: { ttl: "1h" },
                    headers: { "idempotency-key": "extend-http-2" },
                })
            ).json(),
        );
        expect(Date.parse(later.expiresAt!)).toBeGreaterThan(Date.parse(extended.expiresAt!));
        // A replay does not extend again, but it returns today's row rather than a snapshot.
        expect(previewSchema.parse(await (await extend()).json()).expiresAt).toBe(later.expiresAt);
        expect(
            await status(
                call(limitedKey, `${ownPath}/extend`, {
                    method: "POST",
                    body: { ttl: "2h" },
                    headers: { "idempotency-key": "extend-http-1" },
                }),
            ),
        ).toBe(409);
        expect(await status(call(readKey, ownPath, { method: "DELETE" }))).toBe(403);
        expect(await status(call(deleteKey, otherPath, { method: "DELETE" }))).toBe(404);
        expect(
            await status(
                call(deleteKey, `/organizations/${otherOrgId}/previews/${own.id}`, {
                    method: "DELETE",
                }),
            ),
        ).toBe(404);
        expect((await api(viewer, ownPath, { method: "DELETE" })).status).toBe(403);
        const response = await call(deleteKey, ownPath, { method: "DELETE" });
        expect(response.status).toBe(202);
        const deletion = requestedDeletionSchema.parse(await response.json());
        expect(
            requestedDeletionSchema.parse(
                await (await call(deleteKey, ownPath, { method: "DELETE" })).json(),
            ),
        ).toEqual(deletion);
        expect(
            await status(
                call(limitedKey, `${ownPath}/extend`, { method: "POST", body: { ttl: "1h" } }),
            ),
        ).toBe(409);
        const opPath = `/organizations/${orgId}/deletions/${deletion.operationId}`;
        // The operation is also found from the preview, by whoever may read it.
        const byPreview = await call(limitedRead, `${ownPath}/deletion`);
        expect(deletionSchema.parse(await byPreview.json()).id).toBe(deletion.operationId);
        expect(await status(call(limitedRead, `${otherPath}/deletion`))).toBe(404);
        expect(await status(call(deleteKey, `${ownPath}/deletion`))).toBe(403);
        expect(
            await status(call(readKey, `/organizations/${otherOrgId}/previews/${own.id}/deletion`)),
        ).toBe(404);
        expect(
            await status(call(readKey, `/organizations/${orgId}/previews/not-a-uuid/deletion`)),
        ).toBe(404);
        expect((await api(viewer, `${ownPath}/deletion`)).status).toBe(200);
        const never = await create(p1, "never-deleted");
        expect(
            await status(
                call(limitedRead, `/organizations/${orgId}/previews/${never.id}/deletion`),
            ),
        ).toBe(404);
        expect(await status(call(deleteKey, opPath))).toBe(403);
        const operationResponse = await call(limitedRead, opPath);
        expect(operationResponse.status).toBe(200);
        const opBody = await operationResponse.json();
        expect(deletionSchema.parse(opBody)).toMatchObject({
            previewId: own.id,
            status: "queued",
            failure: null,
        });
        // No lease owner, fence or remote output leaks onto the read surface.
        expect(Object.keys(opBody).sort()).toEqual(
            ["id", "previewId", "status", "reason", "failure", "createdAt", "finishedAt"].sort(),
        );
        const otherDelete = requestedDeletionSchema.parse(
            await (await api(owner, otherPath, { method: "DELETE" })).json(),
        );
        expect(
            await status(
                call(limitedRead, `/organizations/${orgId}/deletions/${otherDelete.operationId}`),
            ),
        ).toBe(404);
        expect(
            await status(
                call(readKey, `/organizations/${otherOrgId}/deletions/${deletion.operationId}`),
            ),
        ).toBe(404);
        expect(await status(call(readKey, `/organizations/${orgId}/deletions/not-a-uuid`))).toBe(
            404,
        );
        const resolution = `${opPath}/resolution`;
        expect(
            await status(
                call(deleteKey, resolution, { method: "POST", body: { outcome: "deleted" } }),
            ),
        ).toBe(403);
        expect(
            (await api(viewer, resolution, { method: "POST", body: { outcome: "deleted" } }))
                .status,
        ).toBe(403);
        expect(
            (await api(owner, resolution, { method: "POST", body: { outcome: "deleted" } })).status,
        ).toBe(409);
        await testDb.db
            .updateTable("deletion_operation")
            .set({ status: "reconciliation-needed" })
            .where("id", "=", deletion.operationId)
            .execute();
        // A stale session or a cross-origin cookie cannot authorize reconciliation.
        const sessions = await testDb.db
            .selectFrom("session")
            .innerJoin("user", "user.id", "session.userId")
            .select("session.id")
            .where("user.email", "=", "user@example.com")
            .execute();
        const sessionIds = sessions.map((s) => s.id);
        await testDb.db
            .updateTable("session")
            .set({ createdAt: new Date(Date.now() - 3_600_000) })
            .where("id", "in", sessionIds)
            .execute();
        try {
            expect(
                (await api(owner, resolution, { method: "POST", body: { outcome: "deleted" } }))
                    .status,
            ).toBe(403);
            expect(
                deletionSchema.parse(await (await call(limitedRead, opPath)).json()).status,
            ).toBe("reconciliation-needed");
        } finally {
            await testDb.db
                .updateTable("session")
                .set({ createdAt: new Date() })
                .where("id", "in", sessionIds)
                .execute();
        }
        const crossOrigin = await fetch(`${proxied.base}/api/v1${resolution}`, {
            method: "POST",
            headers: {
                cookie: owner,
                origin: "https://evil.example.com",
                "content-type": "application/json",
            },
            body: JSON.stringify({ outcome: "deleted" }),
        });
        expect(crossOrigin.status).toBe(403);
        expect(
            (await api(owner, resolution, { method: "POST", body: { outcome: "maybe" } })).status,
        ).toBe(422);
        expect(
            (await api(owner, resolution, { method: "POST", body: { outcome: "retry" } })).status,
        ).toBe(200);
        expect(deletionSchema.parse(await (await call(limitedRead, opPath)).json()).status).toBe(
            "queued",
        );
        await testDb.db
            .updateTable("deletion_operation")
            .set({ status: "reconciliation-needed" })
            .where("id", "=", deletion.operationId)
            .execute();
        expect(
            (await api(owner, resolution, { method: "POST", body: { outcome: "deleted" } })).status,
        ).toBe(200);
        expect(deletionSchema.parse(await (await call(limitedRead, opPath)).json()).status).toBe(
            "succeeded",
        );
        expect(await status(call(deleteKey, ownPath, { method: "DELETE" }))).toBe(404);
    });

    it("is off unless deployments are on: reads work, creating and deploying are refused", async () => {
        const cookieOwner = await (async () => {
            const response = await signIn(direct, "user@example.com", USER_PASSWORD);
            expect(response.status).toBe(200);
            return response.headers
                .getSetCookie()
                .map((c) => c.split(";")[0])
                .join("; ");
        })();
        const request = (path: string, method = "GET", body?: unknown) =>
            fetch(`${direct.base}/api/v1${path}`, {
                method,
                headers: {
                    cookie: cookieOwner,
                    origin: direct.base,
                    "content-type": "application/json",
                },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
        expect((await request(`/organizations/${orgId}/previews`)).status).toBe(200);
        expect(
            (await request(`/organizations/${orgId}/previews/${previewId}`, "DELETE")).status,
        ).toBe(409);
        expect(
            (
                await request(`/organizations/${orgId}/projects/${p1}/previews`, "POST", {
                    slug: "off",
                })
            ).status,
        ).toBe(409);
        expect(
            (
                await request(`/organizations/${orgId}/previews/${previewId}/deployments`, "POST", {
                    artifactId,
                })
            ).status,
        ).toBe(409);
        // Stored archives are never deleted yet, so none are taken while it is off.
        expect(
            (
                await fetch(`${direct.base}/api/v1/organizations/${orgId}/artifacts`, {
                    method: "POST",
                    headers: {
                        cookie: cookieOwner,
                        origin: direct.base,
                        "content-type": "application/gzip",
                    },
                    body: tarGz(SITE) as BodyInit,
                })
            ).status,
        ).toBe(409);
    });
});

describe("server function bodies", () => {
    const fn = (headers: Record<string, string>, body?: string) =>
        fetch(`${proxied.base}/_serverFn/does-not-exist`, {
            method: "POST",
            headers: { origin: proxied.base, "content-type": "application/json", ...headers },
            body,
        });

    it("bounds a server function request body, as the API does", async () => {
        const big = await fn({}, JSON.stringify({ pad: "x".repeat(70 * 1024) }));
        expect(big.status).toBe(413);
        expect(errorSchema.parse(await big.json()).status).toBe(413);
        // Small bodies still reach TanStack (which rejects an unknown function itself).
        const small = await fn({}, JSON.stringify({ ok: true }));
        expect(small.status).not.toBe(413);
        expect(small.status).not.toBe(411);
        // A declared length that was never delivered is refused without waiting.
        const unframed = await rawUploadTo("/_serverFn/x", {
            "Transfer-Encoding": "chunked",
            Connection: "close",
        });
        expect(unframed.status).toBe(411);
    });
});

describe("OpenAPI reference", () => {
    it("describes extension replay as returning the current preview, not the original response", async () => {
        const response = await fetch(`${proxied.base}/api/openapi/json`);
        const spec = (await response.json()) as {
            paths: Record<
                string,
                {
                    post: {
                        description: string;
                    };
                }
            >;
        };
        const extend =
            spec.paths["/api/v1/organizations/{orgId}/previews/{previewId}/extend"]!.post;
        expect(extend.description).toContain("returns the current preview");
        expect(extend.description).toContain("does not extend again");
    });
    const operations = [
        "get /api/v1/me",
        "get /api/v1/organizations",
        "post /api/v1/organizations",
        "get /api/v1/organizations/{orgId}",
        "get /api/v1/organizations/{orgId}/members",
        "post /api/v1/organizations/{orgId}/members",
        "delete /api/v1/organizations/{orgId}/members/{userId}",
        "get /api/v1/organizations/{orgId}/invitations",
        "post /api/v1/organizations/{orgId}/invitations",
        "delete /api/v1/organizations/{orgId}/invitations/{invitationId}",
        "post /api/v1/invitations/preview",
        "post /api/v1/invitations/accept",
        "get /api/v1/organizations/{orgId}/projects",
        "post /api/v1/organizations/{orgId}/projects",
        "get /api/v1/key",
        "post /api/v1/organizations/{orgId}/artifacts",
        "get /api/v1/organizations/{orgId}/previews",
        "post /api/v1/organizations/{orgId}/projects/{projectId}/previews",
        "get /api/v1/organizations/{orgId}/previews/{previewId}",
        "delete /api/v1/organizations/{orgId}/previews/{previewId}",
        "post /api/v1/organizations/{orgId}/previews/{previewId}/extend",
        "get /api/v1/organizations/{orgId}/previews/{previewId}/deletion",
        "get /api/v1/organizations/{orgId}/deletions/{operationId}",
        "post /api/v1/organizations/{orgId}/deletions/{operationId}/resolution",
        "post /api/v1/organizations/{orgId}/previews/{previewId}/deployments",
        "get /api/v1/organizations/{orgId}/previews/{previewId}/deployments",
        "get /api/v1/organizations/{orgId}/deployments/{deploymentId}",
        "get /api/v1/organizations/{orgId}/deployments/{deploymentId}/events",
        "post /api/v1/organizations/{orgId}/deployments/{deploymentId}/resolution",
        "get /api/v1/organizations/{orgId}/api-keys",
        "post /api/v1/organizations/{orgId}/api-keys",
        "delete /api/v1/organizations/{orgId}/api-keys/{keyId}",
    ];

    it("documents exactly the public v1 operations, without internals", async () => {
        const response = await fetch(`${proxied.base}/api/openapi/json`);
        expect(response.status).toBe(200);
        const spec = (await response.json()) as {
            openapi: string;
            paths: Record<
                string,
                Record<string, { security?: unknown[]; responses: Record<string, unknown> }>
            >;
            components: { securitySchemes: Record<string, unknown> };
        };
        expect(spec.openapi).toMatch(/^3\./);
        const documented = Object.entries(spec.paths).flatMap(([path, methods]) =>
            Object.keys(methods).map((method) => `${method} ${path}`),
        );
        expect(documented.toSorted()).toEqual(operations.toSorted());
        expect(Object.keys(spec.components.securitySchemes)).toEqual([
            "sessionCookie",
            "bearerKey",
        ]);
        // Authentication requirements are accurate: only the token endpoints are public.
        expect(spec.paths["/api/v1/invitations/accept"]!.post!.security).toEqual([]);
        expect(spec.paths["/api/v1/invitations/preview"]!.post!.security).toEqual([]);
        expect(spec.paths["/api/v1/organizations"]!.post!.security).toEqual([
            { sessionCookie: [] },
        ]);
        expect(Object.keys(spec.paths["/api/v1/organizations"]!.post!.responses)).toEqual(
            expect.arrayContaining(["201", "401", "403", "409", "422"]),
        );
    });

    it("serves the Scalar reference from this origin only", async () => {
        const page = await fetch(`${proxied.base}/api/openapi`);
        expect(page.status).toBe(200);
        const html = await page.text();
        expect(html).toMatch(/\/_scalar\/[\d.]+\/standalone\.js/);
        expect(html).not.toMatch(/cdn\.jsdelivr|unpkg|cdnjs/);
        const scriptPath = /src="(\/_scalar\/[^"]+standalone\.js)"/.exec(html)![1]!;
        const script = await fetch(`${proxied.base}${scriptPath}`);
        expect(script.headers.get("x-content-type-options")).toBe("nosniff");
        expect(script.status).toBe(200);
        expect((await script.arrayBuffer()).byteLength).toBeGreaterThan(1_000_000);
    });

    it("can be switched off", async () => {
        for (const path of ["/api/openapi", "/api/openapi/json"]) {
            expect((await fetch(`${direct.base}${path}`)).status).toBe(404);
        }
    });
});

describe("SMTP mode over HTTP", () => {
    it("is invisible and unavailable without SMTP", async () => {
        expect(await (await fetch(`${proxied.base}/login`)).text()).not.toContain(
            "Forgot your password?",
        );
        const forgot = await fetch(`${proxied.base}/forgot-password`, { redirect: "manual" });
        expect([302, 307]).toContain(forgot.status);
        const reset = await post(
            proxied,
            "/api/auth/request-password-reset",
            { email: "user@example.com" },
            { "x-forwarded-for": "198.51.100.40" },
        );
        expect(reset.status).toBe(400);
        const invite = await post(proxied, "/api/v1/organizations/x/invitations", {});
        expect(invite.status).toBe(401);
    });

    it("never leaks page URLs through the Referer header", async () => {
        for (const path of [
            "/login",
            "/accept-invitation?token=abc",
            "/reset-password?token=abc",
        ]) {
            const response = await fetch(`${mailed.base}${path}`);
            expect(response.headers.get("referrer-policy"), path).toBe("no-referrer");
        }
    });

    it("invites a new person who accepts, signs in and can recover by email", async () => {
        const login = async (email: string, password: string, ip: string) => {
            const response = await post(
                mailed,
                "/api/auth/sign-in/email",
                { email, password },
                { "x-forwarded-for": ip },
            );
            expect(response.status).toBe(200);
            return response.headers
                .getSetCookie()
                .map((c) => c.split(";")[0])
                .join("; ");
        };
        expect(await (await fetch(`${mailed.base}/login`)).text()).toContain(
            "Forgot your password?",
        );
        const operator = await login("op@example.com", PASSWORD, "198.51.100.41");
        const owner = await login("user@example.com", USER_PASSWORD, "198.51.100.42");
        const created = await mailedApi(operator, "/organizations", {
            method: "POST",
            body: { name: "Mailco", slug: "mailco", ownerEmail: "user@example.com" },
        });
        const orgId = ((await created.json()) as { id: string }).id;

        const invited = await mailedApi(owner, `/organizations/${orgId}/invitations`, {
            method: "POST",
            body: { email: "new@example.com", role: "deployer" },
        });
        expect(invited.status).toBe(201);
        createdInvitationSchema.parse(await invited.json());
        expect(
            z
                .array(invitationSchema)
                .parse(
                    await (await mailedApi(owner, `/organizations/${orgId}/invitations`)).json(),
                ),
        ).toHaveLength(1);
        await expect.poll(() => smtp.messages.length, { timeout: 8000 }).toBe(1);
        const text = mailText(smtp.messages[0]!);
        expect(smtp.messages[0]!.to).toEqual(["new@example.com"]);
        const token = /token=([A-Za-z0-9_-]+)/.exec(text)![1]!;

        const page = await fetch(`${mailed.base}/accept-invitation?token=${token}`);
        expect(await page.text()).toContain("Join");
        const bad = await fetch(`${mailed.base}/accept-invitation?token=nope`);
        expect(await bad.text()).toContain("not valid");

        // A cross-origin DELETE with a session cookie is refused before any lookup.
        const pendingId = (
            (await (await mailedApi(owner, `/organizations/${orgId}/invitations`)).json()) as {
                id: string;
            }[]
        )[0]!.id;
        const crossDelete = await fetch(
            `${mailed.base}/api/v1/organizations/${orgId}/invitations/${pendingId}`,
            {
                method: "DELETE",
                headers: { cookie: owner, origin: "https://evil.example.net" },
            },
        );
        expect(crossDelete.status).toBe(403);

        const previewResponse = await post(mailed, "/api/v1/invitations/preview", { token });
        expect(invitationPreviewSchema.parse(await previewResponse.json())).toMatchObject({
            organizationName: "Mailco",
            accountExists: false,
        });

        const accepted = await post(mailed, "/api/v1/invitations/accept", {
            token,
            name: "New",
            password: "brand-new-password",
        });
        expect(accepted.status).toBe(200);
        expect(acceptedInvitationSchema.parse(await accepted.json()).createdAccount).toBe(true);
        const again = await post(mailed, "/api/v1/invitations/accept", {
            token,
            name: "New",
            password: "brand-new-password",
        });
        expect(again.status).toBe(404);

        const fresh = await login("new@example.com", "brand-new-password", "198.51.100.43");
        const orgs = (await (await mailedApi(fresh, "/organizations")).json()) as {
            slug: string;
            role: string;
        }[];
        expect(orgs).toMatchObject([{ slug: "mailco", role: "deployer" }]);

        // The invited account is verified, so email recovery works for it...
        const before = smtp.messages.length;
        const forgot = await post(
            mailed,
            "/api/auth/request-password-reset",
            { email: "new@example.com" },
            { "x-forwarded-for": "198.51.100.44" },
        );
        expect(forgot.status).toBe(200);
        await expect.poll(() => smtp.messages.length, { timeout: 8000 }).toBe(before + 1);
        const resetToken = /reset-password\?token=([^\s]+)/.exec(
            mailText(smtp.messages.at(-1)!),
        )![1]!;
        const resetPage = await fetch(`${mailed.base}/reset-password?token=${resetToken}`);
        expect(await resetPage.text()).toContain("Choose a new password");
        const reset = await post(
            mailed,
            "/api/auth/reset-password",
            { newPassword: "another-fresh-pass-2", token: resetToken },
            { "x-forwarded-for": "198.51.100.44" },
        );
        expect(reset.status).toBe(200);
        expect((await mailedApi(fresh, "/me")).status).toBe(401); // old session revoked
        await login("new@example.com", "another-fresh-pass-2", "198.51.100.45");

        // One mailbox cannot be flooded from rotating addresses.
        const flood: number[] = [];
        for (let i = 0; i < 4; i++) {
            flood.push(
                (
                    await post(
                        mailed,
                        "/api/auth/request-password-reset",
                        { email: "Flood@Example.com" },
                        { "x-forwarded-for": `198.51.100.${60 + i}` },
                    )
                ).status,
            );
        }
        expect(flood.slice(0, 3)).toEqual([200, 200, 200]);
        expect(flood[3]).toBe(429);

        // ...but an address that was only provisioned gets no mail.
        const count = smtp.messages.length;
        const quiet = await post(
            mailed,
            "/api/auth/request-password-reset",
            { email: "other@example.com" },
            { "x-forwarded-for": "198.51.100.46" },
        );
        expect(quiet.status).toBe(200);
        await new Promise((r) => setTimeout(r, 500));
        expect(smtp.messages).toHaveLength(count);
    });
});

describe("sign-in throttling", () => {
    it("limits without a trusted proxy even when X-Forwarded-For is rotated", async () => {
        const statuses: number[] = [];
        for (let i = 0; i < 8; i++) {
            statuses.push(
                (await signIn(direct, "op@example.com", "wrong-wrong-wrong", `192.0.2.${i + 1}`))
                    .status,
            );
        }
        expect(statuses[0]).toBe(401);
        expect(statuses).toContain(429);
    });

    it("does not share one bucket between different clients behind a trusted proxy", async () => {
        const statuses: number[] = [];
        for (let i = 0; i < 12; i++) {
            statuses.push(
                (
                    await signIn(
                        proxied,
                        `nobody${i}@example.com`,
                        "wrong-wrong-wrong",
                        `203.0.113.${i + 1}`,
                    )
                ).status,
            );
        }
        expect(statuses.every((s) => s === 401)).toBe(true);
    });

    it("limits one account attacked from many addresses", async () => {
        const statuses: number[] = [];
        for (let i = 0; i < 24; i++) {
            statuses.push(
                (
                    await signIn(
                        proxied,
                        "victim@example.com",
                        "wrong-wrong-wrong",
                        `100.64.0.${i + 1}`,
                    )
                ).status,
            );
        }
        expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
        expect(statuses.slice(20)).toContain(429);
    });
});
