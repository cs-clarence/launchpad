import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { PUBLISHED_DIRS, checkRuntimeAgnostic, scan } from "./runtime-agnostic";
import { TARGETS } from "./package-clients";

const root = path.resolve(import.meta.dirname, "..");
const made: string[] = [];
afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(files: Record<string, string>) {
    const dir = mkdtempSync(path.join(tmpdir(), "runtime-agnostic-"));
    made.push(dir);
    for (const [name, text] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        writeFileSync(path.join(dir, name), text);
    }
    return dir;
}

describe("runtime-agnostic guard", () => {
    it("covers the packed packages and client-core", () => {
        for (const target of TARGETS) expect(PUBLISHED_DIRS).toContain(target.dir);
        expect(PUBLISHED_DIRS).toContain("packages/client-core");
    });

    it("passes the real published sources", () => {
        expect(checkRuntimeAgnostic(root)).toEqual([]);
    });

    it("accepts Node-compatible code, including import.meta.dirname and comments", () => {
        const dir = fixture({
            "p/src/a.ts": [
                "// Bun.file is not used here",
                "/*",
                " Bun.serve()",
                "*/",
                'import { readFileSync } from "node:fs";',
                "export const here = import.meta.dirname;",
                'export const label = { Bun: "x" };',
            ].join("\n"),
        });
        expect(checkRuntimeAgnostic(dir, ["p"])).toEqual([]);
    });

    it("ignores mentions in comments, strings, templates and regular expressions", () => {
        const text = [
            "const a = 1; // Bun.file()",
            "/* Bun.file() */ const b = 2;",
            "/**",
            " * Bun.x",
            " */",
            'const c = "Bun.file() and bun:sqlite";',
            "const d = `Bun.file() ${a} Bun`;",
            "const e = /Bun\\.x[/]/.test(c);",
            "const f = { Bun: 1, bun: 2 };",
            "const g = a ? { Bun: 1 } : 2;",
            'const h = x.Bun + "bun";',
            "const i = `${`Bun`} ${a ? 1 : 2}`;",
            'const j = import.meta.dirname + "import.meta.dir";',
        ].join("\n");
        expect(scan("x.ts", text)).toEqual([]);
    });

    it("finds uses the old line scanner missed", () => {
        expect(scan("x.ts", "/* c */ Bun.file('x');")).toHaveLength(1);
        expect(scan("x.ts", "/*\n * ok\n */ const a = 1;\n * Bun.x\n")).toHaveLength(1);
        expect(scan("x.ts", "const a = cond ? Bun : other;")).toHaveLength(1);
        expect(scan("x.ts", "const a = { k: cond ? Bun : 1 };")).toHaveLength(1);
        expect(scan("x.ts", "const a = `${Bun.version}`;")).toHaveLength(1);
        expect(scan("x.ts", 'const m = await import("bun:sqlite");')).toHaveLength(1);
        expect(scan("x.ts", 'const m = require("bun");')).toHaveLength(1);
        expect(scan("x.ts", 'import "bun:test";')).toHaveLength(1);
        expect(scan("x.ts", 'export { x } from "bun";')).toHaveLength(1);
    });

    it("keeps the line number across comments and templates", () => {
        const text = "/*\n\n*/\nconst a = `\n\n`;\nBun.x;\n";
        expect(scan("x.ts", text)).toEqual([expect.stringContaining("x.ts:7:")]);
    });

    // [name, source, number of problems]: division versus regular expression contexts.
    it.each([
        ["division after a number", 'const size = 100 / Bun.file("x").size;', 1],
        ["division after a float", "const s = 1.5 / Bun.size;", 1],
        ["identifier named of", 'const of = 100;\nof / Bun.file("x").size;', 1],
        ["property named return", "const a = x.return / Bun.size;", 1],
        ["optional property named in", "const a = x?.in / Bun.size;", 1],
        ["object key named of", "const a = { of: 1 }; const b = a.of / Bun.size;", 1],
        ["division after call", "const a = f() / Bun.size;", 1],
        ["division after index", "const a = xs[0] / Bun.size;", 1],
        ["division after postfix", "const a = i++ / Bun.size;", 1],
        ["division after a string", 'const a = "4" / Bun.size;', 1],
        ["ASI makes this division", "const a = b\n/Bun/g.test(x);", 1],
        ["division after }", "const a = {}\n/ Bun.size;", 1],
        ["regex after =", "const re = /Bun.x/g;", 0],
        ["regex after (", "x(/Bun.x/);", 0],
        ["regex after return", "function f() { return /Bun.x/.test(a); }", 0],
        ["regex after else", "if (a) b(); else /Bun.x/.test(c);", 0],
        ["regex after if header", "if (ready) /Bun/.test(label);", 0],
        ["regex after while header", "while (a) /Bun/.test(label);", 0],
        ["regex after for header", "for (;;) /Bun/.test(label);", 0],
        ["regex after for-of", "for (const x of /Bun/.exec(s)) {}", 0],
        ["regex after typeof", "const a = typeof /Bun/;", 0],
        ["regex after arrow", "const f = () => /Bun.x/.test(a);", 0],
        ["regex with a slash in a class", "const re = /[/]Bun.x/;", 0],
        ["regex with an escaped slash", "const re = /\\/Bun.x/;", 0],
        ["division after a template", "const a = `${1}` / Bun.size;", 1],
        ["real use after a regex", "const re = /x/; Bun.file(re);", 1],
        ["real use after an if header", "if (a) Bun.file(x);", 1],
    ])("%s", (_name, text, count) => {
        expect(scan("x.ts", `${text}\n`)).toHaveLength(count);
    });

    it.each([
        ["an unterminated block comment", "const a = 1; /* Bun.file()"],
        ["an unterminated string literal", "const a = 'Bun.file();\nconst b = 1;"],
        ["an unterminated template literal", "const a = `Bun.file()"],
        ["an unterminated regular expression", "const a = /Bun.file();\nconst b = 1;"],
    ])("fails closed on %s", (what, text) => {
        const problems = scan("x.ts", text);
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain(what);
    });

    it("ignores tests", () => {
        const dir = fixture({
            "p/src/a.spec.ts": 'import { test } from "bun:test";',
            "p/src/__tests__/b.ts": "Bun.sleep(1);",
            "p/src/ok.ts": "export {};",
        });
        expect(checkRuntimeAgnostic(dir, ["p"])).toEqual([]);
    });

    it.each([
        ["Bun.file('x')", "the Bun global"],
        ["const r = await Bun.spawn(['ls']);", "the Bun global"],
        ["if (typeof Bun !== 'undefined') {}", "the Bun global"],
        ["new Bun.Glob('*')", "the Bun global"],
        ["globalThis.Bun?.version", "globalThis.Bun"],
        ['import { x } from "bun";', 'a "bun" or "bun:*" module specifier'],
        ['import { Database } from "bun:sqlite";', 'a "bun" or "bun:*" module specifier'],
        ["const v = process.versions.bun;", "process.versions.bun"],
        ["const d = import.meta.dir;", "a Bun-only import.meta property"],
        ["const f = import.meta.path;", "a Bun-only import.meta property"],
    ])("rejects %s", (line, what) => {
        const problems = scan("x.ts", `export {};\n${line}\n`);
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain(`x.ts:2: ${what}`);
    });

    it("reports file:line for a failing package", () => {
        const dir = fixture({ "p/src/deep/a.ts": "export {};\nexport const x = Bun.version;\n" });
        expect(checkRuntimeAgnostic(dir, ["p"])).toEqual([
            expect.stringContaining("p/src/deep/a.ts:2:"),
        ]);
    });
});
