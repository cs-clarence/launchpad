import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createContext } from "@launchpad/client-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { list } from "tar";
import { startupOptions } from "./program";
import { createMcpServer, type ServerOptions } from "./server";

const KEY = "lp_" + "a".repeat(43);
const ORG = "org-one";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const PREVIEW = "22222222-2222-4222-8222-222222222222";
const ARTIFACT = "33333333-3333-4333-8333-333333333333";
const DEPLOYMENT = "44444444-4444-4444-8444-444444444444";
const NOW = "2026-11-16T00:00:00.000Z";
const POLICY = {
    include: ["dist/**"],
    exclude: ["**/*.map", "dist/private/**"],
    allowProjects: [],
};

let dir = "";
const cleanups: (() => Promise<void>)[] = [];
beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "launchpad-mcp-deploy-"));
    await fs.mkdir(path.join(dir, "dist", "private"), { recursive: true });
    await fs.writeFile(path.join(dir, "dist", "index.html"), "<p>hi</p>");
    await fs.writeFile(path.join(dir, "dist", "app.js"), "1");
    await fs.writeFile(path.join(dir, "dist", "app.js.map"), "map");
    await fs.writeFile(path.join(dir, "dist", "private", "notes.txt"), "x");
    await fs.writeFile(path.join(dir, "outside.txt"), "x");
});
afterEach(async () => {
    for (const close of cleanups.splice(0)) await close();
    await fs.rm(dir, { recursive: true, force: true });
});

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function controller(final = "succeeded", failure: unknown = null) {
    const calls: { method: string; path: string }[] = [];
    const uploads: Buffer[] = [];
    const preview = {
        id: PREVIEW,
        projectId: PROJECT,
        slug: "review",
        hostname: "review.example.com",
        state: "active",
        activeDeploymentId: null,
        createdAt: NOW,
    };
    const deployment = (status: string) => ({
        id: DEPLOYMENT,
        previewId: PREVIEW,
        artifactId: ARTIFACT,
        spa: false,
        status,
        failure: status === "failed" ? failure : null,
        createdAt: NOW,
        updatedAt: NOW,
        finishedAt: null,
    });
    const fetchImpl = (async (url: string, init: RequestInit) => {
        const u = new URL(url);
        const p = u.pathname.replace("/api/v1", "");
        const method = init.method ?? "GET";
        calls.push({ method, path: p });
        if (p === "/organizations")
            return json([{ id: ORG, slug: "one", name: "One", role: "deployer" }]);
        if (p === "/key")
            return json({
                id: PROJECT,
                name: "k",
                organizationId: ORG,
                scopes: [],
                projectIds: null,
                expiresAt: NOW,
            });
        if (p === `/organizations/${ORG}/projects`)
            return json([{ id: PROJECT, slug: "site", name: "Site", createdAt: NOW }]);
        if (p === `/organizations/${ORG}/artifacts`) {
            uploads.push(Buffer.from(init.body as Buffer));
            return json(
                {
                    id: ARTIFACT,
                    digest: "a".repeat(64),
                    sizeBytes: 9,
                    expandedBytes: 9,
                    entryCount: 2,
                    createdAt: NOW,
                    reused: false,
                },
                201,
            );
        }
        if (p === `/organizations/${ORG}/previews` && method === "GET")
            return json({ items: [preview], nextCursor: null });
        if (p === `/organizations/${ORG}/previews/${PREVIEW}/deployments`) {
            return json({ id: DEPLOYMENT, status: "queued", createdAt: NOW }, 202);
        }
        if (p === `/organizations/${ORG}/deployments/${DEPLOYMENT}/events`)
            return json({ items: [], nextAfter: null });
        if (p === `/organizations/${ORG}/deployments/${DEPLOYMENT}`) return json(deployment(final));
        return json({ code: "not-found", status: 404, title: "Not Found" }, 404);
    }) as unknown as typeof fetch;
    const ctx = createContext(
        {
            LAUNCHPAD_CONTROLLER: "https://control.example.com",
            LAUNCHPAD_API_KEY: KEY,
            LAUNCHPAD_CONFIG_DIR: path.join(dir, "cfg"),
        },
        { fetch: fetchImpl },
    );
    return { ctx, calls, uploads };
}

async function connect(options: ServerOptions, fake = controller()) {
    const server = createMcpServer(fake.ctx, options);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    cleanups.push(async () => {
        await client.close();
        await server.close();
    });
    return { client, ...fake };
}

const entries = async (archive: Buffer) => {
    const file = path.join(dir, "uploaded.tar.gz");
    await fs.writeFile(file, archive);
    const out: string[] = [];
    await list({ file, onReadEntry: (e) => out.push(e.path) });
    return out.toSorted();
};
const call = (client: Client, args: Record<string, unknown>) =>
    client.callTool({
        name: "deploy",
        arguments: {
            working_dir: dir,
            project: "site",
            name: "review",
            path: "dist",
            confirm: true,
            ...args,
        },
    });
const text = (result: unknown) => JSON.stringify(result);

describe("startup policy", () => {
    const parse = (...argv: string[]) => startupOptions(argv, () => {});
    it("offers deployment only with explicit include and exclude lists", () => {
        expect(parse("--shared").deploy).toBeUndefined();
        expect(
            parse(
                "--allow-deploy",
                "--include",
                "dist/**",
                "--exclude",
                "**/*.map",
                "--allow-project",
                "site",
            ).deploy,
        ).toEqual({
            include: ["dist/**"],
            exclude: ["**/*.map"],
            allowProjects: ["site"],
        });
        expect(() => parse("--allow-deploy")).toThrow(/--include and one --exclude/);
        expect(() => parse("--allow-deploy", "--include", "dist/**")).toThrow(/--exclude/);
        expect(() => parse("--allow-deploy", "--exclude", "x")).toThrow(/--include/);
        expect(() => parse("--include", "dist/**")).toThrow(/need --allow-deploy/);
        expect(() => parse("--allow-project", "site")).toThrow(/need --allow-deploy/);
    });

    it("refuses an unusable pattern at startup, not at the first call", () => {
        const { ctx } = controller();
        expect(() =>
            createMcpServer(ctx, { workingDir: dir, deploy: { ...POLICY, include: ["/etc/**"] } }),
        ).toThrow(/pattern/);
    });
});

describe("the deploy tool", () => {
    it("exists only when deployment was enabled, and says it changes live content", async () => {
        const off = await connect({ workingDir: dir });
        expect((await off.client.listTools()).tools.map((t) => t.name)).not.toContain("deploy");
        expect(text(await call(off.client, {}))).toContain("deploy");
        const on = await connect({ workingDir: dir, deploy: POLICY });
        const tool = (await on.client.listTools()).tools.find((t) => t.name === "deploy")!;
        expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    });

    it("packs only what the policy allows, exclusion winning, and follows the deployment", async () => {
        const { client, uploads } = await connect({ workingDir: dir, deploy: POLICY });
        const result = await call(client, {});
        expect(result.isError).toBe(false);
        expect(result.structuredContent).toMatchObject({
            truncated: false,
            data: {
                outcome: "succeeded",
                preview: { slug: "review" },
                deployment: { id: DEPLOYMENT },
            },
        });
        expect(await entries(uploads[0]!)).toEqual(["app.js", "index.html"]);
    });

    it("takes project and name from launchpad.json, and resolves patterns from each working_dir", async () => {
        const other = path.join(dir, "other");
        await fs.mkdir(path.join(other, "dist"), { recursive: true });
        await fs.writeFile(path.join(other, "dist", "index.html"), "x");
        await fs.writeFile(
            path.join(other, "launchpad.json"),
            JSON.stringify({ organization: "one", project: "site", name: "review" }),
        );
        const { client, uploads } = await connect({ shared: true, deploy: POLICY });
        const result = await client.callTool({
            name: "deploy",
            arguments: { working_dir: other, path: "dist", confirm: true },
        });
        expect(result.isError, text(result)).toBe(false);
        expect(await entries(uploads[0]!)).toEqual(["index.html"]);
    });

    it("needs confirm: true, a path and a directory, and sends nothing otherwise", async () => {
        const { client, calls } = await connect({ workingDir: dir, deploy: POLICY });
        for (const args of [{ confirm: false }, { confirm: undefined }, { path: undefined }]) {
            const result = await client.callTool({
                name: "deploy",
                arguments: {
                    working_dir: dir,
                    project: "site",
                    name: "review",
                    path: "dist",
                    confirm: true,
                    ...args,
                },
            });
            expect(result.isError, text(args)).toBe(true);
        }
        expect(calls.filter((c) => c.path.endsWith("/artifacts"))).toEqual([]);
    });

    it("refuses a path that leaves working_dir, however it is spelled", async () => {
        await fs.symlink(os.tmpdir(), path.join(dir, "escape"));
        await fs.symlink(path.join(dir, "outside.txt"), path.join(dir, "filelink"));
        const { client, calls } = await connect({ workingDir: dir, deploy: POLICY });
        for (const bad of [
            "..",
            "../x",
            "dist/../..",
            path.dirname(dir),
            "escape",
            "outside.txt",
            "filelink",
            "missing",
            "dist\\..\\..",
        ]) {
            const result = await call(client, { path: bad });
            expect(result.isError, bad).toBe(true);
            expect(text(result), bad).toMatch(/path must be/);
        }
        expect(calls.filter((c) => c.path.endsWith("/artifacts"))).toEqual([]);
    });

    it("keeps a secret that the patterns would publish from ever being sent", async () => {
        await fs.writeFile(path.join(dir, "dist", ".env"), "SECRET=1");
        const { client, uploads } = await connect({ workingDir: dir, deploy: POLICY });
        const result = await call(client, {});
        expect(result.isError).toBe(true);
        expect(text(result)).toContain("secret");
        expect(uploads).toEqual([]);
    });

    it("tells the client that deployment exists only when it does", async () => {
        const off = await connect({ workingDir: dir });
        expect(off.client.getInstructions()).toContain("read-only tools");
        const on = await connect({ workingDir: dir, deploy: POLICY });
        expect(on.client.getInstructions()).toContain("replaces a preview's live content");
        expect(on.client.getInstructions()).toContain("untrusted data");
    });

    it("refuses an index.html the exclusions removed", async () => {
        const { client, uploads } = await connect({
            workingDir: dir,
            deploy: { ...POLICY, exclude: ["dist/index.html"] },
        });
        const result = await call(client, {});
        expect(result.isError).toBe(true);
        expect(uploads).toEqual([]);
    });

    it("honors the project allow-list, naming the project as listed", async () => {
        const { client, uploads } = await connect({
            workingDir: dir,
            deploy: { ...POLICY, allowProjects: ["docs"] },
        });
        const refused = await call(client, {});
        expect(refused.isError).toBe(true);
        expect(text(refused)).toContain("not allowed");
        expect(uploads).toEqual([]);
        const allowed = await connect({
            workingDir: dir,
            deploy: { ...POLICY, allowProjects: ["site"] },
        });
        expect((await call(allowed.client, {})).isError).toBe(false);
    });

    it("reports a failed deployment as an error with only safe, cleaned text", async () => {
        const failing = controller("failed", {
            code: "build-failed",
            message: `The build failed \u001b[31m${KEY}`,
        });
        const { client } = await connect({ workingDir: dir, deploy: POLICY }, failing);
        const result = await call(client, {});
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({ data: { outcome: "failed" } });
        expect(text(result)).not.toContain(KEY);
        expect(text(result)).not.toContain("\\u001b");
    });

    it("returns at once when asked not to wait, and the deployment id to follow", async () => {
        const { client } = await connect({ workingDir: dir, deploy: POLICY }, controller("queued"));
        const result = await call(client, { wait_seconds: 0 });
        expect(result.isError).toBe(false);
        expect(result.structuredContent).toMatchObject({
            data: { outcome: "queued", deployment: { id: DEPLOYMENT } },
        });
    });

    it("needs a working directory in shared mode, like every tool", async () => {
        const { client } = await connect({ shared: true, deploy: POLICY });
        const result = await client.callTool({
            name: "deploy",
            arguments: { path: "dist", project: "site", name: "review", confirm: true },
        });
        expect(result.isError).toBe(true);
        expect(text(result)).toContain("working_dir");
    });
});
