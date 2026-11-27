import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { checkCommanderImports, scan } from "./commander-imports";

const root = path.resolve(import.meta.dirname, "..");
const made: string[] = [];
afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const DETECTED = [
    'import { Command } from "commander";',
    "import { Command } from 'commander';",
    'import type { Command } from "commander";',
    'import { type Command } from "commander";',
    'import "commander";',
    'export { Command } from "commander";',
    'export * from "commander";',
    'const m = await import("commander");',
    'const m = require("commander");',
    'import c = require("commander");',
    'type C = import("commander").Command;',
    'import { x } from "commander/esm.mjs";',
    'import type { y } from "commander/typings";',
    'const m = module.require("commander");',
    'const r = createRequire(import.meta.url); r("commander");',
    'const r = module.createRequire(import.meta.url); const c = r("commander/esm.mjs");',
    'require.resolve("commander");',
];
const ALLOWED = [
    'import { Command } from "@commander-js/extra-typings";',
    'import type { Command } from "@commander-js/extra-typings";',
    'const m = await import("@commander-js/extra-typings");',
    'import x from "commander-other";',
    'import x from "commanderx/a";',
    'const m = require("@commander-js/extra-typings");',
    'const r = createRequire(import.meta.url); r("zod");',
    'const r = other(); r("commander");',
    'const s = "from commander"; // import "commander"',
];

describe("commander imports", () => {
    for (const snippet of DETECTED) {
        it(`reports ${snippet}`, () => {
            expect(scan("a.ts", snippet)).toHaveLength(1);
        });
    }
    for (const snippet of ALLOWED) {
        it(`allows ${snippet}`, () => {
            expect(scan("a.ts", snippet)).toEqual([]);
        });
    }

    it("scans a .tsx, .mjs and .cts file by its own kind", () => {
        expect(scan("a.tsx", 'const e = <a/>; import "commander";')).toHaveLength(1);
        expect(scan("a.mjs", 'import "commander";')).toHaveLength(1);
        expect(scan("a.cts", 'const m = require("commander");')).toHaveLength(1);
    });

    it("fails closed on a file that does not parse", () => {
        expect(scan("a.ts", "const = ;").length).toBeGreaterThan(0);
    });

    function fixture(files: Record<string, string>) {
        const dir = mkdtempSync(path.join(tmpdir(), "commander-imports-"));
        made.push(dir);
        for (const [name, text] of Object.entries(files)) {
            mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
            writeFileSync(path.join(dir, name), text);
        }
        return dir;
    }
    const bad = 'import { Command } from "commander";';

    it("outside a git checkout skips node_modules and build output", () => {
        const dir = fixture({
            "apps/x/node_modules/y/index.js": bad,
            "apps/x/dist/index.js": bad,
            "apps/x/.data/a.ts": bad,
            "packages/p/src/a.ts": bad,
        });
        const { problems, scanned } = checkCommanderImports(dir);
        expect(scanned).toBe(1);
        expect(problems).toHaveLength(1);
        expect(problems[0]).toStartWith("packages/p/src/a.ts:1");
    });

    it("in a git checkout scans a source directory named build", () => {
        const dir = fixture({ "packages/p/src/build/a.ts": bad, "apps/x/ok.ts": "export {};" });
        Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
        Bun.spawnSync(["git", "add", "-A"], { cwd: dir });
        const { problems, scanned } = checkCommanderImports(dir);
        expect(scanned).toBe(2);
        expect(problems).toHaveLength(1);
        expect(problems[0]).toStartWith("packages/p/src/build/a.ts:1");
    });

    it("fails when nothing was scanned", () => {
        const { problems, scanned } = checkCommanderImports(fixture({ "README.md": "x" }));
        expect(scanned).toBe(0);
        expect(problems).toHaveLength(1);
    });

    it("follows links, fails on a broken one and survives a cycle", () => {
        const dir = fixture({ "apps/a/real.ts": bad, "tooling/t.ts": "export {};" });
        symlinkSync(path.join(dir, "apps/a/real.ts"), path.join(dir, "tooling/link.ts"));
        symlinkSync(path.join(dir, "tooling"), path.join(dir, "tooling/loop"));
        expect(checkCommanderImports(dir).problems).toHaveLength(2);
        symlinkSync(path.join(dir, "nowhere.ts"), path.join(dir, "tooling/broken.ts"));
        expect(checkCommanderImports(dir).problems.some((p) => p.includes("broken"))).toBe(true);
    });

    it("finds none in the real sources", () => {
        const { problems, scanned } = checkCommanderImports(root);
        expect(problems).toEqual([]);
        expect(scanned).toBeGreaterThanOrEqual(1);
    });

    it("is a dependency of check, next to check:runtime", () => {
        const omni = Bun.YAML.parse(
            readFileSync(path.join(root, "tooling/project.omni.yaml"), "utf8"),
        ) as { tasks?: Record<string, { dependencies?: string[] }> } & Record<string, unknown>;
        const tasks = (omni.tasks ?? omni) as Record<string, { dependencies?: string[] }>;
        expect(tasks.check?.dependencies).toContain("check:imports");
        expect(tasks.check?.dependencies).toContain("check:runtime");
    });
});
