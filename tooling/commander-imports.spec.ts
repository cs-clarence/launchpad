import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
];
const ALLOWED = [
    'import { Command } from "@commander-js/extra-typings";',
    'import type { Command } from "@commander-js/extra-typings";',
    'const m = await import("@commander-js/extra-typings");',
    'import x from "commander-other";',
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

    it("skips node_modules and build output but scans the source roots", () => {
        const dir = mkdtempSync(path.join(tmpdir(), "commander-imports-"));
        made.push(dir);
        const put = (name: string, text: string) => {
            mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
            writeFileSync(path.join(dir, name), text);
        };
        const bad = 'import { Command } from "commander";';
        put("apps/x/node_modules/y/index.js", bad);
        put("apps/x/dist/index.js", bad);
        put("apps/x/.data/a.ts", bad);
        put("packages/p/src/a.ts", bad);
        expect(checkCommanderImports(dir)).toHaveLength(1);
        expect(checkCommanderImports(dir)[0]).toStartWith("packages/p/src/a.ts:1");
    });

    it("finds none in the real sources", () => {
        expect(checkCommanderImports(root)).toEqual([]);
    });
});
