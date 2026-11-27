import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    findNode,
    nodeShim,
    resolveNode,
    checkListing,
    checkManifest,
    checkBareImports,
    checkBin,
    packedDependencies,
    SHEBANG,
    stageExecutable,
    TARGETS,
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

describe("TARGETS", () => {
    it("packs the three libraries and the two executables, dependencies first", () => {
        expect(TARGETS.map((t) => t.dir)).toEqual([
            "packages/contracts",
            "packages/sdk",
            "packages/client-core",
            "apps/cli",
            "apps/mcp",
        ]);
        expect(TARGETS.filter((t) => t.bin).map((t) => t.bin)).toEqual([
            { name: "launchpad", file: "cli.mjs" },
            { name: "launchpad-mcp", file: "mcp.mjs" },
        ]);
    });

    it("builds under Bun whatever Node is on the PATH (the vite config is TypeScript)", () => {
        const source = readFileSync(path.join(import.meta.dirname, "package-clients.ts"), "utf8");
        expect(source).toContain('["bun", "--bun", "run", "build"]');
    });
});

describe("packedDependencies", () => {
    const packed = (name: string) =>
        name === "@launchpad-kit/sdk" ? { name, version: "0.1.0" } : undefined;

    it("turns a workspace package into a caret range and takes the rest from the catalog", () => {
        expect(
            packedDependencies(
                {
                    name: "@launchpad-kit/cli",
                    version: "0.1.0",
                    dependencies: {
                        "@launchpad-kit/sdk": "workspace:^",
                        zod: "catalog:",
                        tar: "^7.0.0",
                    },
                },
                packed,
                { zod: "^4.0.0" },
            ),
        ).toEqual({ "@launchpad-kit/sdk": "^0.1.0", zod: "^4.0.0", tar: "^7.0.0" });
    });

    it("refuses a workspace package that is not packed and a name missing from the catalog", () => {
        const manifest = (dependencies: Record<string, string>) => ({
            name: "x",
            version: "0.1.0",
            dependencies,
        });
        expect(() =>
            packedDependencies(manifest({ "@launchpad-kit/other": "workspace:^" }), packed, {}),
        ).toThrow("not packed");
        expect(() => packedDependencies(manifest({ zod: "catalog:" }), packed, {})).toThrow(
            "catalog",
        );
    });
});

describe("stageExecutable", () => {
    const dirs: string[] = [];
    afterEach(() => {
        for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });
    const temp = () => {
        const dir = mkdtempSync(path.join(tmpdir(), "stage-exe-"));
        dirs.push(dir);
        return dir;
    };

    it("copies the file byte for byte, executable, with the node shebang on line 1", () => {
        const dir = temp();
        const from = path.join(dir, "cli.mjs");
        writeFileSync(from, `${SHEBANG}\nconsole.log("x");\n`, { mode: 0o644 });
        const to = path.join(dir, "stage", "cli.mjs");
        stageExecutable(from, to);
        expect(readFileSync(to, "utf8")).toBe(readFileSync(from, "utf8"));
        expect(statSync(to).mode & 0o777).toBe(0o755);
    });

    it("refuses a missing or another shebang", () => {
        const dir = temp();
        for (const first of ["", "#!/usr/bin/env bun\n", "\n#!/usr/bin/env node\n"]) {
            const from = path.join(dir, "x.mjs");
            writeFileSync(from, `${first}console.log(1);\n`);
            expect(
                () => stageExecutable(from, path.join(dir, "out.mjs")),
                JSON.stringify(first),
            ).toThrow("must start with");
        }
    });
});

describe("checkBareImports", () => {
    const manifest = {
        name: "@x/app",
        dependencies: { "@x/lib": "^1.0.0", zod: "^4.0.0" },
        peerDependencies: { commander: "^15.0.0" },
    };

    it("accepts Node, relative, declared and subpath imports", () => {
        const text = [
            'import { a } from "node:fs";',
            'import path from "path";',
            'import b from "fs/promises";',
            'import { c } from "@x/lib";',
            'import { d } from "zod/v4";',
            'export * from "./local.mjs";',
            'const e = await import("commander");',
        ].join("\n");
        expect(checkBareImports(manifest, { "app.mjs": text })).toEqual([]);
    });

    it("reports an undeclared package in every import form", () => {
        const text = [
            'import "left-pad";',
            'import x from "tar";',
            'export { y } from "@y/other/sub";',
            'const z = await import("picomatch");',
            'import w = require("micro");',
        ].join("\n");
        const problems = checkBareImports(manifest, { "app.mjs": text });
        expect(problems).toHaveLength(5);
        expect(problems.join("\n")).toContain('"@y/other/sub"');
    });

    it("fails closed on a file that does not parse and ignores non-module files", () => {
        expect(checkBareImports(manifest, { "app.mjs": "import {{{" }).length).toBeGreaterThan(0);
        expect(checkBareImports(manifest, { "README.md": 'import "left-pad"' })).toEqual([]);
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

describe("checkBin", () => {
    const files = ["package.json", "cli.mjs"];

    it("accepts an object that points at a packed file, and a library without bin", () => {
        expect(checkBin({ bin: { launchpad: "./cli.mjs" } }, files)).toEqual([]);
        expect(checkBin({ main: "./index.mjs", exports: {} }, files)).toEqual([]);
    });

    it("refuses a string, a missing file and an importable executable", () => {
        expect(checkBin({ bin: "./cli.mjs" }, files)).toHaveLength(1);
        expect(checkBin({ bin: { launchpad: "./gone.mjs" } }, files)).toHaveLength(1);
        expect(
            checkBin(
                { bin: { launchpad: "./cli.mjs" }, main: "x", types: "y", exports: {} },
                files,
            ),
        ).toHaveLength(3);
    });
});
