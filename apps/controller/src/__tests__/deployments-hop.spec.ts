import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createTestDatabase } from "@launchpad-kit/database/testing";
import {
    appSchema,
    artifactSchema,
    createApiKey,
    createOrganization,
    createProject,
    deploymentSchema,
    type Principal,
} from "@launchpad-kit/services";
import { SITE, tarGz } from "@launchpad-kit/services/testing";
import { sql } from "kysely";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The real built server (Nitro, Elysia, PostgreSQL) over HTTP: a streamed archive upload, an
// app, a queued deployment, and the off switch, with a bearer key as automation sends it.
let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
let dataDir = "";
let org = "";
let project = "";
let key = "";
const children: ChildProcess[] = [];

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address() as net.AddressInfo;
            server.close(() => resolve(port));
        });
    });
}

async function startServer(extra: Record<string, string>) {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const proc = spawn("bun", [".output/server/index.mjs"], {
        env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            NODE_ENV: "production",
            DATABASE_URL: testDb.url,
            LAUNCHPAD_AUTH_SECRET: "integration-secret-".repeat(3),
            LAUNCHPAD_BASE_URL: "https://control.example.com",
            LAUNCHPAD_DATA_DIR: dataDir,
            HOST: "127.0.0.1",
            PORT: String(port),
            ...extra,
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(proc);
    let logs = "";
    proc.stdout?.on("data", (d) => (logs += d));
    proc.stderr?.on("data", (d) => (logs += d));
    for (let i = 0; i < 100; i++) {
        if (proc.exitCode !== null) break;
        try {
            const response = await fetch(`${base}/api/health`, {
                signal: AbortSignal.timeout(1000),
            });
            if (response.status === 200) return base;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    proc.kill("SIGTERM");
    throw new Error(`the controller did not start\n${logs}`);
}

beforeAll(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "launchpad-deploy-hop-"));
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
    const owner: Principal = { userId: ann, instanceRole: "user" };
    org = (
        await createOrganization(
            testDb.db,
            { userId: root, instanceRole: "operator" },
            { name: "Acme", slug: "acme", ownerEmail: "ann@example.com" },
        )
    ).id;
    project = (await createProject(testDb.db, owner, org, { name: "Site", slug: "site" })).id;
    const sessionId = randomUUID();
    await sql`insert into "session" ("id", "token", "userId", "expiresAt", "updatedAt")
        values (${sessionId}, ${randomUUID()}, ${ann}, now() + interval '1 hour', now())`.execute(
        testDb.db,
    );
    key = (
        await createApiKey(
            testDb.db,
            owner,
            org,
            {
                name: "ci",
                scopes: ["app:read", "app:deploy", "app:delete", "app:alias:manage", "app:promote"],
                expiresInDays: 1,
            },
            sessionId,
        )
    ).secret;
});
afterAll(async () => {
    for (const child of children) child.kill("SIGTERM");
    await testDb?.destroy();
    if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
});

const call = (base: string, method: string, route: string, body?: unknown, raw?: Uint8Array) => {
    const headers: Record<string, string> = { authorization: `Bearer ${key}` };
    let payload: BodyInit | undefined;
    if (raw) {
        payload = raw as unknown as BodyInit;
        headers["content-type"] = "application/gzip";
    } else if (body !== undefined) {
        payload = JSON.stringify(body);
        headers["content-type"] = "application/json";
    }
    return fetch(`${base}/api/v1/organizations/${org}${route}`, {
        method,
        headers,
        body: payload,
    });
};

describe("deployments through the built server", () => {
    it(
        "uses the built CLI to upload and deploy and the built MCP to promote separately",
        { timeout: 60_000 },
        async () => {
            const base = await startServer({
                LAUNCHPAD_DEPLOYMENTS: "on",
                LAUNCHPAD_ALIASES: "on",
                LAUNCHPAD_APPS_DOMAIN: "sites.example.net",
            });
            const env = {
                PATH: process.env.PATH ?? "",
                HOME: dataDir,
                LAUNCHPAD_CONTROLLER: base,
                LAUNCHPAD_API_KEY: key,
                LAUNCHPAD_ORG: org,
            };
            const cli = async (...args: string[]) => {
                const proc = Bun.spawn(
                    ["bun", path.resolve("../cli/dist/cli.mjs"), "--json", ...args],
                    {
                        cwd: dataDir,
                        env,
                        stdout: "pipe",
                        stderr: "pipe",
                    },
                );
                const [code, stdout, stderr] = await Promise.all([
                    proc.exited,
                    new Response(proc.stdout).text(),
                    new Response(proc.stderr).text(),
                ]);
                expect(code, stderr).toBe(0);
                return JSON.parse(stdout) as unknown;
            };
            const fixture = path.join(dataDir, "client.tgz");
            await fs.writeFile(
                fixture,
                tarGz([...SITE, { name: "client.txt", content: "client" }]),
            );
            const artifact = artifactSchema.parse(
                await cli("artifact", "upload", project, fixture),
            );
            const app = appSchema.parse(await cli("app", "create", project, "client"));
            const result = (await cli("alias", "create", app.id, "prod")) as { id: string };
            const deployment = deploymentSchema.parse(
                await cli("app", "deploy", app.id, "--artifact", artifact.id),
            );
            expect(deployment.status).toBe("queued");
            const aliasRow = () =>
                testDb.db
                    .selectFrom("app_alias")
                    .select(["state", "target_deployment_id"])
                    .where("id", "=", result.id)
                    .executeTakeFirstOrThrow();
            expect(await aliasRow()).toEqual({ state: "unbound", target_deployment_id: null });
            // Only stand in for the worker's completed build, not for the promotion API.
            await sql`update deployment set status = 'succeeded', image_tag = 'fixture:built',
            image_id = 'sha256:' || repeat('a', 64), finished_at = now()
            where id = ${deployment.id}`.execute(testDb.db);
            const mcp = new Client({ name: "launchpad-integration", version: "1.0.0" });
            const transport = new StdioClientTransport({
                command: "bun",
                args: [
                    path.resolve("../mcp/dist/mcp.mjs"),
                    "--allow-promote",
                    "--allowed-projects",
                    project,
                ],
                cwd: dataDir,
                env,
            });
            try {
                await mcp.connect(transport);
                const intent = {
                    app_id: app.id,
                    alias_id: result.id,
                    deployment_id: deployment.id,
                    expected_generation: "0",
                    idempotency_key: "client-release",
                };
                expect(
                    (await mcp.callTool({ name: "promote_alias", arguments: intent })).isError,
                ).toBe(true);
                expect(await aliasRow()).toEqual({ state: "unbound", target_deployment_id: null });
                const accepted = await mcp.callTool({
                    name: "promote_alias",
                    arguments: { ...intent, confirm: true },
                });
                expect(accepted.isError, JSON.stringify(accepted)).toBe(false);
                expect(accepted.structuredContent).toMatchObject({
                    data: {
                        status: "queued",
                        generation: "1",
                        previousTargetDeploymentId: null,
                        desiredTargetDeploymentId: deployment.id,
                    },
                });
                expect(await aliasRow()).toEqual({ state: "binding", target_deployment_id: null });
            } finally {
                await mcp.close();
            }
        },
    );
    it(
        "streams an upload, creates an app and queues a deployment",
        { timeout: 60_000 },
        async () => {
            const base = await startServer({
                LAUNCHPAD_DEPLOYMENTS: "on",
                LAUNCHPAD_APPS_DOMAIN: "sites.example.net",
            });
            const archive = tarGz([...SITE, { name: "hop.txt", content: "hop" }]);
            const uploaded = await call(
                base,
                "POST",
                `/projects/${project}/artifacts`,
                undefined,
                archive,
            );
            expect(uploaded.status).toBe(201);
            const artifact = artifactSchema.parse(await uploaded.json());
            const created = await call(base, "POST", `/projects/${project}/apps`, {
                slug: "website",
            });
            expect(created.status).toBe(201);
            const app = appSchema.parse(await created.json());
            const queued = await call(base, "POST", `/apps/${app.id}/deployments`, {
                artifactId: artifact.id,
            });
            expect(queued.status).toBe(202);
            const deployment = deploymentSchema.parse(await queued.json());
            expect(deployment.status).toBe("queued");
            const read = await call(base, "GET", `/deployments/${deployment.id}`);
            expect(deploymentSchema.parse(await read.json()).hostname).toBe(deployment.hostname);
            // A second one while the first is unfinished: refused.
            const second = await call(base, "POST", `/apps/${app.id}/deployments`, {
                artifactId: artifact.id,
            });
            expect(second.status).toBe(409);
            // Finish it by hand (no worker runs here), then delete it and read its events.
            await sql`update deployment set status = 'failed', finished_at = now()
                where id = ${deployment.id}`.execute(testDb.db);
            const deletion = await call(base, "DELETE", `/deployments/${deployment.id}`);
            expect(deletion.status).toBe(202);
            const events = await call(base, "GET", `/deployments/${deployment.id}/events`);
            const phases = ((await events.json()) as { phase: string }[]).map((e) => e.phase);
            expect(phases).toEqual(["queued", "deleting"]);
            // An unauthenticated call is refused before anything is read.
            const anonymous = await fetch(`${base}/api/v1/organizations/${org}/apps`);
            expect(anonymous.status).toBe(401);
        },
    );

    it(
        "answers 503 to deployment writes by default, and still reads",
        { timeout: 60_000 },
        async () => {
            const base = await startServer({});
            const refused = await call(base, "POST", `/projects/${project}/apps`, { slug: "off" });
            expect(refused.status).toBe(503);
            const archive = tarGz([...SITE, { name: "off.txt", content: "off" }]);
            expect(
                (await call(base, "POST", `/projects/${project}/artifacts`, undefined, archive))
                    .status,
            ).toBe(503);
            expect((await call(base, "GET", "/apps")).status).toBe(200);
        },
    );
});
