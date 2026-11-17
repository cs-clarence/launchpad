import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createContext } from "@launchpad/client-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startupOptions } from "./program";
import { createMcpServer, type ServerOptions } from "./server";

const KEY = "lp_" + "a".repeat(43);
const ORG = "org-one";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "55555555-5555-4555-8555-555555555555";
const PREVIEW = "22222222-2222-4222-8222-222222222222";
const ELSEWHERE = "66666666-6666-4666-8666-666666666666";
const OPERATION = "77777777-7777-4777-8777-777777777777";
const NOW = "2026-11-16T00:00:00.000Z";

let dir = "";
const cleanups: (() => Promise<void>)[] = [];
beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "launchpad-mcp-delete-"));
});
afterEach(async () => {
    for (const close of cleanups.splice(0)) await close();
    await fs.rm(dir, { recursive: true, force: true });
});

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function controller(options: { env?: boolean; afterPreviewRead?: () => Promise<void> } = {}) {
    const calls: { method: string; path: string; host: string }[] = [];
    const preview = (id: string, projectId: string) => ({
        id,
        projectId,
        slug: "review",
        hostname: "review.example.com",
        state: "active",
        activeDeploymentId: null,
        expiresAt: null,
        createdAt: NOW,
    });
    const fetchImpl = (async (url: string, init: RequestInit) => {
        const u = new URL(url);
        const p = u.pathname.replace("/api/v1", "");
        const method = init.method ?? "GET";
        calls.push({ method, path: p, host: u.host });
        if (p === "/organizations")
            return json([{ id: ORG, slug: "one", name: "One", role: "deployer" }]);
        if (p === "/key") {
            return json({
                id: PROJECT,
                name: "k",
                organizationId: ORG,
                scopes: [],
                projectIds: null,
                expiresAt: NOW,
            });
        }
        if (p === `/organizations/${ORG}/previews/${PREVIEW}` && method === "GET") {
            await options.afterPreviewRead?.();
            // The same preview id names a preview of another project under another profile.
            return json(preview(PREVIEW, u.host.startsWith("prod") ? OTHER_PROJECT : PROJECT));
        }
        if (p === `/organizations/${ORG}/previews/${ELSEWHERE}` && method === "GET") {
            return json(preview(ELSEWHERE, OTHER_PROJECT));
        }
        if (p.startsWith(`/organizations/${ORG}/previews/`) && p.endsWith("/deletion")) {
            return json({
                id: OPERATION,
                previewId: PREVIEW,
                status: "reconciliation-needed",
                reason: "expired",
                failure: {
                    code: "destroy-uncertain",
                    message: "Destroying the app did not finish clearly.",
                },
                createdAt: NOW,
                finishedAt: null,
            });
        }
        if (method === "DELETE" && p.startsWith(`/organizations/${ORG}/previews/`)) {
            return json({ operationId: OPERATION, state: "deleting" }, 202);
        }
        return json({ code: "not-found", status: 404, title: "Not Found" }, 404);
    }) as unknown as typeof fetch;
    const ctx = createContext(
        {
            // Saved profiles only, when the test needs a current profile to switch.
            ...(options.env === false
                ? {}
                : {
                      LAUNCHPAD_CONTROLLER: "https://control.example.com",
                      LAUNCHPAD_API_KEY: KEY,
                  }),
            LAUNCHPAD_CONFIG_DIR: path.join(dir, "cfg"),
        },
        { fetch: fetchImpl },
    );
    return { ctx, calls };
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

const remove = (client: Client, args: Record<string, unknown> = {}) =>
    client.callTool({
        name: "delete_preview",
        arguments: { working_dir: dir, preview_id: PREVIEW, confirm: true, ...args },
    });
const text = (result: unknown) => JSON.stringify(result);
const deletes = (calls: { method: string; host: string }[]) =>
    calls.filter((c) => c.method === "DELETE");
const POLICY = { allowProjects: [PROJECT] };

describe("startup policy for deletion", () => {
    const parse = (...argv: string[]) => startupOptions(argv, () => {});
    it("offers deletion only with --allow-delete and at least one project id", () => {
        expect(parse("--shared").deletion).toBeUndefined();
        expect(parse("--allow-delete", "--allow-project", PROJECT.toUpperCase()).deletion).toEqual({
            allowProjects: [PROJECT],
        });
        expect(parse("--allow-delete", "--allow-project", PROJECT).deploy).toBeUndefined();
        expect(() => parse("--allow-delete")).toThrow(/at least one --allow-project/);
        expect(() => parse("--allow-delete", "--allow-project", "site")).toThrow(/project id/);
        expect(() => parse("--allow-project", PROJECT)).toThrow(
            /needs --allow-deploy or --allow-delete/,
        );
        // Deleting does not switch deployment on, and the include/exclude lists stay deploy's.
        expect(() => parse("--allow-delete", "--allow-project", PROJECT, "--include", "a")).toThrow(
            /need --allow-deploy/,
        );
        const both = parse(
            "--allow-deploy",
            "--include",
            "a",
            "--exclude",
            "b",
            "--allow-delete",
            "--allow-project",
            PROJECT,
        );
        expect(both.deploy?.allowProjects).toEqual([PROJECT]);
        expect(both.deletion?.allowProjects).toEqual([PROJECT]);
    });
});

describe("the delete_preview tool", () => {
    it("exists only when deletion was enabled, destructive, and says it cannot be undone", async () => {
        const off = await connect({ workingDir: dir });
        expect((await off.client.listTools()).tools.map((t) => t.name)).not.toContain(
            "delete_preview",
        );
        expect(text(await remove(off.client))).toContain("delete_preview");
        expect(deletes(off.calls)).toEqual([]);
        const on = await connect({ workingDir: dir, deletion: POLICY });
        const tool = (await on.client.listTools()).tools.find((t) => t.name === "delete_preview")!;
        expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
        expect(tool.description).toContain("cannot be undone");
        expect(on.client.getInstructions()).toContain("permanently deletes");
        // Not deployment: that tool stays absent.
        expect((await on.client.listTools()).tools.map((t) => t.name)).not.toContain("deploy");
    });

    it("queues the deletion of a preview in an allowed project and names what it deleted", async () => {
        const { client, calls } = await connect({ workingDir: dir, deletion: POLICY });
        const result = await remove(client);
        expect(result.isError, text(result)).toBe(false);
        expect(result.structuredContent).toMatchObject({
            data: {
                outcome: "queued",
                preview: { id: PREVIEW, slug: "review", projectId: PROJECT },
                deletion: { operationId: OPERATION, state: "deleting" },
            },
        });
        // Read first (to learn the project), then the one DELETE.
        expect(calls.filter((c) => c.path.includes(PREVIEW)).map((c) => c.method)).toEqual([
            "GET",
            "DELETE",
        ]);
    });

    it("refuses a preview of any other project before sending anything to delete", async () => {
        const { client, calls } = await connect({ workingDir: dir, deletion: POLICY });
        const refused = await remove(client, { preview_id: ELSEWHERE });
        expect(refused.isError).toBe(true);
        expect(text(refused)).toContain("not allowed");
        expect(deletes(calls)).toEqual([]);
    });

    it("judges the project by the preview's own id under the credentials of this call", async () => {
        const { client, ctx, calls } = await connect({
            workingDir: dir,
            profile: "staging",
            deletion: POLICY,
        });
        for (const name of ["staging", "prod"]) {
            await ctx.store.update((saved) => {
                saved.profiles[name] = {
                    controller: `https://${name}.example.com`,
                    apiKey: KEY,
                    organizationId: ORG,
                    savedAt: NOW,
                };
            });
        }
        // The same preview id is a preview of another project on the other controller.
        const refused = await remove(client, { profile: "prod" });
        expect(refused.isError).toBe(true);
        expect(text(refused)).toContain("not allowed");
        expect(deletes(calls)).toEqual([]);
        expect((await remove(client)).isError).toBe(false);
        expect(deletes(calls)).toHaveLength(1);
        expect(deletes(calls)[0]!.host).toBe("staging.example.com");
    });

    it("keeps the check and the deletion on one credential even if the current profile changes between", async () => {
        // The profile is switched while the preview is being read, as another process might.
        const hold: { ctx?: ReturnType<typeof controller>["ctx"] } = {};
        const fake = controller({
            env: false,
            afterPreviewRead: async () => {
                await hold.ctx!.store.update((saved) => {
                    saved.currentProfile = "two";
                });
            },
        });
        hold.ctx = fake.ctx;
        const { client, ctx } = await connect({ workingDir: dir, deletion: POLICY }, fake);
        await ctx.store.update((saved) => {
            for (const name of ["one", "two"]) {
                saved.profiles[name] = {
                    controller: `https://${name === "two" ? "prod" : "staging"}.example.com`,
                    apiKey: KEY,
                    organizationId: ORG,
                    savedAt: NOW,
                };
            }
            saved.currentProfile = "one";
        });
        const result = await remove(client);
        expect(result.isError, text(result)).toBe(false);
        expect(deletes(fake.calls).map((c) => c.host)).toEqual(["staging.example.com"]);
    });

    it("needs confirm: true and a preview id, and sends nothing otherwise", async () => {
        const { client, calls } = await connect({ workingDir: dir, deletion: POLICY });
        for (const args of [
            { confirm: false },
            { confirm: undefined },
            { preview_id: undefined },
            { preview_id: "review" },
        ]) {
            const result = await remove(client, args);
            expect(result.isError, JSON.stringify(args)).toBe(true);
        }
        expect(calls).toEqual([]);
    });

    it("returns a controller refusal as an error, not as success", async () => {
        const { client } = await connect(
            { workingDir: dir, deletion: POLICY },
            (() => {
                const fake = controller();
                return fake;
            })(),
        );
        // An unknown preview: the controller says not found.
        const missing = await remove(client, {
            preview_id: "88888888-8888-4888-8888-888888888888",
        });
        expect(missing.isError).toBe(true);
    });
});

describe("the preview_deletion tool", () => {
    it("is a read tool, always offered, and shows a held deletion and its note", async () => {
        const { client, calls } = await connect({ workingDir: dir });
        const tool = (await client.listTools()).tools.find((t) => t.name === "preview_deletion")!;
        expect(tool.annotations).toMatchObject({ readOnlyHint: true });
        const result = await client.callTool({
            name: "preview_deletion",
            arguments: { working_dir: dir, preview_id: PREVIEW },
        });
        expect(result.structuredContent).toMatchObject({
            data: { status: "reconciliation-needed", failure: { code: "destroy-uncertain" } },
        });
        expect(deletes(calls)).toEqual([]);
    });
});
