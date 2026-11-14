import { randomUUID } from "node:crypto";
import { type ChildProcess, spawn } from "node:child_process";
import { createAuth, loadAuthConfig, setupFirstOperator } from "@launchpad/auth";
import {
    acceptedInvitationSchema,
    addedMemberSchema,
    createdInvitationSchema,
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

// A random base so concurrent test runs on one machine rarely overlap.
let nextPort = 43100 + Math.floor(Math.random() * 600) * 3;

async function start(
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
    direct = await start(false, { LAUNCHPAD_API_DOCS: "false" });
    proxied = await start(true);
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
        expect(Object.keys(spec.components.securitySchemes)).toEqual(["sessionCookie"]);
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
