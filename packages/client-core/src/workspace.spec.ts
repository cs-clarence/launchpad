import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    createContext,
    MAX_WORKSPACE_CONFIG_BYTES,
    readWorkspace,
    workspaceContext,
} from "./index";

let dir = "";
beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "launchpad-workspace-"));
});
afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
});
const config = { organization: "one", project: "site", name: "review" };
const save = (where: string, value: unknown) =>
    fs.writeFile(path.join(where, "launchpad.json"), JSON.stringify(value));

describe("workspace context", () => {
    it("finds the nearest config, without changing cwd or requiring one", async () => {
        const cwd = process.cwd();
        const child = path.join(dir, "child");
        await fs.mkdir(child);
        expect((await readWorkspace(child)).config).toBeNull();
        await save(dir, config);
        expect((await readWorkspace(child)).config).toEqual(config);
        await save(child, { ...config, project: "nearer" });
        expect((await readWorkspace(child)).config?.project).toBe("nearer");
        expect(process.cwd()).toBe(cwd);
    });

    it("refuses relative paths, missing paths and files", async () => {
        await fs.writeFile(path.join(dir, "file"), "x");
        for (const input of [".", path.join(dir, "nope"), path.join(dir, "file")]) {
            await expect(readWorkspace(input)).rejects.toThrow(/absolute existing directory/);
        }
    });

    it("rejects malformed, oversized, non-regular, symlink and secret-bearing config without echoing it", async () => {
        const file = path.join(dir, "launchpad.json");
        for (const raw of [
            "not-json SECRET",
            JSON.stringify({ ...config, apiKey: "SECRET" }),
            JSON.stringify({ ...config, project: 3 }),
            " ".repeat(MAX_WORKSPACE_CONFIG_BYTES + 1),
        ]) {
            await fs.writeFile(file, raw);
            await expect(readWorkspace(dir)).rejects.toThrow(/launchpad.json must/);
        }
        await fs.unlink(file);
        await fs.mkdir(file);
        await expect(readWorkspace(dir)).rejects.toThrow(/launchpad.json must/);
        await fs.rmdir(file);
        const target = path.join(dir, "target.json");
        await fs.writeFile(target, JSON.stringify(config));
        await fs.symlink(target, file);
        await expect(readWorkspace(dir)).rejects.toThrow(/launchpad.json must/);
    });

    it("builds independent contexts and validates organization overrides without persisting anything", async () => {
        await save(dir, config);
        const env = {
            LAUNCHPAD_CONTROLLER: "https://control.example.com",
            LAUNCHPAD_API_KEY: "lp_" + "a".repeat(43),
        };
        const ctx = createContext(env, {
            fetch: (async (_url: string, _init: RequestInit) =>
                Response.json([
                    { id: "org-one", slug: "one", name: "One", role: "owner" },
                    { id: "org-two", slug: "two", name: "Two", role: "owner" },
                ])) as typeof fetch,
        });
        const [one, two] = await Promise.all([
            workspaceContext(ctx, { workingDir: dir }),
            workspaceContext(ctx, { workingDir: dir, organization: "two", project: "other" }),
        ]);
        expect(one.context.env.LAUNCHPAD_ORG).toBe("org-one");
        expect(two.context.env.LAUNCHPAD_ORG).toBe("org-two");
        expect(two.project).toBe("other");
        expect(one.name).toBe("review");
        expect(ctx.env).toEqual(env);
        await expect(
            workspaceContext(ctx, { workingDir: dir, organization: "hidden" }),
        ).rejects.toThrow(/cannot see the selected organization/);
    });
});
