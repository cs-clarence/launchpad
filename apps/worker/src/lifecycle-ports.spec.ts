import { promises as fs } from "node:fs";
import path from "node:path";
import type { DokkuClient } from "@launchpad-kit/dokku";
import { describe, expect, it } from "vitest";
import type { Docker } from "./docker";
import { createLifecyclePorts } from "./lifecycle-ports";

function fakes() {
    const calls: string[] = [];
    const dokku = {
        apps: {
            exists: async (app: string) => (calls.push(`exists:${app}`), true),
            destroy: async (app: string) => void calls.push(`destroy:${app}`),
            create: async () => void calls.push("create"),
        },
        domains: { set: async () => void calls.push("domains") },
    } as unknown as DokkuClient;
    const docker = {
        removeImage: async (tag: string) => void calls.push(`rmi:${tag}`),
        remove: async () => void calls.push("remove"),
        build: async () => void calls.push("build"),
    } as unknown as Docker;
    return { calls, ports: createLifecyclePorts({ dokku, docker }) };
}

describe("the lifecycle ports", () => {
    it("offer exactly: does an app exist, destroy an app, remove an image by tag", () => {
        const { ports } = fakes();
        expect(Object.keys(ports).sort()).toEqual(["destroy", "exists", "removeImage"]);
    });

    it("pass the app name and each image tag straight through, and nothing else", async () => {
        const { ports, calls } = fakes();
        const signal = new AbortController().signal;
        await ports.exists("lp-abcdefghij", signal);
        await ports.destroy("lp-abcdefghij", signal);
        await ports.removeImage("launchpad/site:a", signal);
        expect(calls).toEqual([
            "exists:lp-abcdefghij",
            "destroy:lp-abcdefghij",
            "rmi:launchpad/site:a",
        ]);
    });
});

describe("what the worker and the Dokku adapter can do", () => {
    const sources = async (dir: string) =>
        (await fs.readdir(dir))
            .filter((f) => f.endsWith(".ts") && !f.endsWith(".spec.ts") && f !== "testing.ts")
            .map((f) => path.join(dir, f));
    const text = async (files: string[]) =>
        (await Promise.all(files.map((f) => fs.readFile(f, "utf8")))).join("\n");

    it("sends Dokku only the operations on a short allowlist, none of which prunes or removes data", async () => {
        const client = await fs.readFile(
            path.resolve(import.meta.dirname, "../../../packages/dokku/src/client.ts"),
            "utf8",
        );
        const operations = [
            ...new Set([...client.matchAll(/"([a-z-]+:[a-z-]+)"/g)].map((m) => m[1])),
        ].sort();
        expect(operations).toEqual([
            "apps:create",
            "apps:destroy",
            "apps:exists",
            "domains:set",
            "git:load-image",
            "ports:set",
            "ps:report",
        ]);
    });

    it("runs docker with only build, image inspect, save and rmi of one tag", async () => {
        const docker = await fs.readFile(path.resolve(import.meta.dirname, "docker.ts"), "utf8");
        const verbs = [
            ...new Set([...docker.matchAll(/start\(\s*\[\s*"([a-z]+)"/g)].map((m) => m[1])),
        ].sort();
        expect(verbs).toEqual(["build", "image", "rmi", "save"]);
    });

    it("has no prune, volume, network, database or system command anywhere", async () => {
        const files = [
            ...(await sources(import.meta.dirname)),
            ...(await sources(path.resolve(import.meta.dirname, "../../../packages/dokku/src"))),
        ];
        const code = (await text(files))
            .split("\n")
            .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
            .join("\n");
        for (const forbidden of [
            /\bprune\b/i,
            /\bvolumes?\b/i,
            /["']system["']/,
            /["']network["']\s*,\s*["'](rm|prune)/,
            /postgres:/i,
            /\bdocker\s+rm\b/,
            /["']rm["']\s*,\s*["']-/,
            /apps:clone|apps:rename|apps:unlock|storage:|volumes:|redis:|mysql:/,
        ]) {
            expect(code, String(forbidden)).not.toMatch(forbidden);
        }
    });
});
