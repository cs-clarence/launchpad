import { randomUUID } from "node:crypto";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createAuth, loadAuthConfig, setupFirstOperator } from "@launchpad-kit/auth";
import { createContext } from "@launchpad-kit/client-core";
import {
    acceptedInvitationSchema,
    addedMemberSchema,
    artifactSchema,
    createdApiKeySchema,
    statusSchema,
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
} from "@launchpad-kit/services";
import { z } from "zod";
import { type FakeSmtp, mailText, startFakeSmtp } from "@launchpad-kit/auth/testing";
import { migrateToLatest } from "@launchpad-kit/database";
import { createTestDatabase } from "@launchpad-kit/database/testing";
import { SITE, tarGz } from "@launchpad-kit/services/testing";
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

describe("operator status over HTTP", () => {
    it("shows the operator how the instance is doing, and nobody else", async () => {
        const operatorCookie = await login("op@example.com", PASSWORD, "198.51.100.64");
        const ownerCookie = await login("user@example.com", USER_PASSWORD, "198.51.100.65");
        const read = await api(operatorCookie, "/status");
        expect(read.status).toBe(200);
        const report = statusSchema.parse(await read.json());
        expect(report.dependencies).toEqual({ database: "ok" });
        expect(report.artifacts.stored).toBeGreaterThanOrEqual(0);
        // An ordinary member, even an owner, is refused, and so is no one at all.
        expect((await api(ownerCookie, "/status")).status).toBe(403);
        expect((await fetch(`${proxied.base}/api/v1/status`)).status).toBe(401);
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
        "get /api/v1/status",
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

describe("a controller on a schema it was not built for", () => {
    it("answers 503 instead of serving", async () => {
        const behind = await createTestDatabase();
        let proc: ChildProcess | undefined;
        let folder = "";
        try {
            await behind.migrate();
            // A folder with one migration this database has not seen: names only for the
            // applied ones (the status check never loads them), one real pending file.
            const source = path.resolve(
                import.meta.dirname,
                "../../../../packages/database/src/migrations",
            );
            folder = await fs.mkdtemp(path.join(os.tmpdir(), "lp-behind-"));
            for (const file of await fs.readdir(source)) {
                await fs.writeFile(path.join(folder, file), "export async function up() {}");
            }
            await fs.writeFile(
                path.join(folder, "20991231_900_pending_check.mjs"),
                "export async function up() {}",
            );
            const port = nextPort++;
            proc = spawn("bun", [".output/server/index.mjs"], {
                env: {
                    PATH: process.env.PATH,
                    HOME: process.env.HOME,
                    NODE_ENV: "production",
                    DATABASE_URL: behind.url,
                    LAUNCHPAD_MIGRATIONS_DIR: folder,
                    LAUNCHPAD_AUTH_SECRET: "integration-secret-".repeat(3),
                    LAUNCHPAD_BASE_URL: `http://127.0.0.1:${port}`,
                    HOST: "127.0.0.1",
                    PORT: String(port),
                },
                stdio: ["ignore", "pipe", "pipe"],
            });
            let logs = "";
            proc.stdout?.on("data", (d) => (logs += d));
            proc.stderr?.on("data", (d) => (logs += d));
            let response: Response | undefined;
            for (let i = 0; i < 100 && !response; i++) {
                response = await fetch(`http://127.0.0.1:${port}/api/health`).catch(
                    () => undefined,
                );
                if (!response) await new Promise((r) => setTimeout(r, 200));
            }
            expect(response?.status).toBe(503);
            expect(await response?.json()).toMatchObject({ code: "schema-mismatch" });
            // The cause is the pending migration, not a missing folder or broken settings.
            expect(logs).toContain("schema is behind");
            expect(logs).toContain("20991231_900_pending_check");

            // Migrating while it runs recovers it without a restart.
            await migrateToLatest(behind.db, folder);
            let recovered = 503;
            for (let i = 0; i < 30 && recovered === 503; i++) {
                await new Promise((r) => setTimeout(r, 500));
                recovered = (await fetch(`http://127.0.0.1:${port}/api/health`)).status;
            }
            expect(recovered).toBe(200);
        } finally {
            proc?.kill("SIGTERM");
            await behind.destroy();
            if (folder) await fs.rm(folder, { recursive: true, force: true });
        }
    });
});
