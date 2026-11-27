import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    findNode,
    nodeShim,
    resolveNode,
    checkListing,
    checkManifest,
    externalsFor,
    thirdPartyDependencies,
    withExtensions,
} from "./package-clients";

describe("checkListing", () => {
    it("accepts what a published package holds", () => {
        expect(checkListing(["package.json", "README.md", "cli.mjs", "index.d.ts"])).toEqual([]);
    });

    it("refuses env files, sources, tests, source maps and nested modules", () => {
        const problems = checkListing([
            "package.json",
            ".env",
            ".env.local",
            "src/index.ts",
            "dist/__tests__/a.d.ts",
            "client.spec.d.ts",
            "index.mjs.map",
            "node_modules/x/index.js",
            "tsconfig.json",
        ]);
        expect(problems).toHaveLength(8);
        expect(
            checkListing(["package.json", ".npmrc", "key.pem", "stray.tgz", "x.ts", "dist/a.mjs"]),
        ).toHaveLength(5);
    });

    it("needs a package.json", () => {
        expect(checkListing(["index.mjs"])).toEqual(["package.json is missing"]);
    });
});

describe("checkManifest", () => {
    const good = { name: "@x/y", version: "1.0.0", dependencies: { zod: "^4.0.0" } };

    it("accepts a registry-installable manifest", () => {
        expect(checkManifest(good)).toEqual([]);
    });

    it("refuses specifiers that only work inside the repository, private, and dev dependencies", () => {
        expect(
            checkManifest({
                ...good,
                private: true,
                dependencies: { a: "workspace:^", b: "catalog:", c: "file:../c", e: "github:x/y" },
                devDependencies: { d: "^1.0.0" },
            }),
        ).toHaveLength(6);
    });
});

describe("withExtensions", () => {
    const files = new Map<string, "file" | "dir">([
        ["./client", "file"],
        ["./nested", "dir"],
    ]);
    const exists = (spec: string) => files.get(spec) ?? null;

    it("names the file the way nodenext resolves it", () => {
        const text = `export * from "./client";\nexport type { A } from './nested';\nimport("./client");`;
        expect(withExtensions(text, exists)).toBe(
            `export * from "./client.js";\nexport type { A } from './nested/index.js';\nimport("./client.js");`,
        );
    });

    it("leaves packages, existing extensions and unknown paths alone", () => {
        const text = `import z from "zod";\nexport * from "./client.js";\nexport * from "./missing";`;
        expect(withExtensions(text, exists)).toBe(text);
    });
});

describe("dependencies of a bundle", () => {
    it("lists the third-party dependencies of the app and of the workspace packages it bundles", () => {
        const found = thirdPartyDependencies("apps/cli", (name) => {
            const dependencies: Record<string, string> =
                name === "@launchpad-kit/client-core"
                    ? { tar: "catalog:", "@launchpad-kit/sdk": "workspace:^" }
                    : { zod: "catalog:" };
            return { name, version: "0.0.0", dependencies };
        });
        expect(Object.keys(found).toSorted()).toEqual(
            [
                "@commander-js/extra-typings",
                "@elastic/micro-jq",
                "commander",
                "tar",
                "zod",
            ].toSorted(),
        );
        expect(Object.values(found).every((v) => !v.includes(":"))).toBe(true);
    });

    it("keeps every one external, with its subpaths", () => {
        expect(externalsFor({ zod: "^4" })).toEqual(["zod", "zod/*"]);
    });
});

describe("resolveNode", () => {
    it("defaults to node on the PATH and keeps bare names as lookups", () => {
        expect(resolveNode(undefined, "/work")).toBe("node");
        expect(resolveNode("", "/work")).toBe("node");
        expect(resolveNode("node22", "/work")).toBe("node22");
    });

    it("makes a path absolute against the caller's directory", () => {
        expect(resolveNode("./node-tools/node", "/work")).toBe("/work/node-tools/node");
        expect(resolveNode("../bin/node", "/work/sub")).toBe("/work/bin/node");
        expect(resolveNode("/opt/node/bin/node", "/work")).toBe("/opt/node/bin/node");
    });
});

describe("the node link for the child PATH", () => {
    const dirs: string[] = [];
    afterEach(() => {
        for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });
    const temp = () => {
        const dir = mkdtempSync(path.join(tmpdir(), "node-shim-"));
        dirs.push(dir);
        return dir;
    };

    it("finds an executable by path or by bare name, and reports a missing one", () => {
        const dir = temp();
        const fake = path.join(dir, "node22");
        symlinkSync(process.execPath, fake);
        expect(findNode(fake, "")).toBe(fake);
        expect(findNode("node22", dir)).toBe(fake);
        expect(findNode("node22", "")).toBeNull();
        expect(findNode(path.join(dir, "missing"), dir)).toBeNull();
    });

    it("makes `node` resolve to an executable that is named something else", () => {
        const dir = temp();
        const fake = path.join(dir, "node22");
        symlinkSync(process.execPath, fake);
        const shim = nodeShim(fake, path.join(dir, "shim"));
        const out = Bun.spawnSync(["/bin/sh", "-c", "command -v node && node --version"], {
            env: { PATH: shim },
        });
        expect(out.stdout.toString()).toStartWith(`${path.join(shim, "node")}\n`);
    });
});
