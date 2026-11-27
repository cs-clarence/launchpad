import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { TARGETS } from "./package-clients";
import { PUBLISHED_DIRS, checkRuntimeAgnostic, scan } from "./runtime-agnostic";

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

// [snippet, file name]: each must be reported, whatever the shape.
const DETECTED: [string, string?][] = [
    ["Bun.file('x')"],
    ["const r = await Bun.spawn(['ls']);"],
    ["if (typeof Bun !== 'undefined') {}"],
    ["new Bun.Glob('*')"],
    ["globalThis.Bun?.version"],
    ['import { x } from "bun";'],
    ['import { Database } from "bun:sqlite";'],
    ['export { x } from "bun";'],
    ['import "bun:test";'],
    ['const m = await import("bun:sqlite");'],
    ['const m = require("bun");'],
    ["const v = process.versions.bun;"],
    ["const d = import.meta.dir;"],
    ["const f = import.meta.path;"],
    ["const m = import.meta.main;"],
    ["const m = import.meta.require;"],
    ["const m = import.meta;"],
    ["const a = { ...Bun };"],
    ["const a = [...Bun.x];"],
    ["f(...Bun.x);"],
    ["a++ / 2; Bun.x; y = 3 / 1"],
    ["a-- / 2; Bun.x; y = 3 / 1"],
    ["const e = <b>x</b>; Bun.x; const f = <i>y</i>;", "x.tsx"],
    ["Bu\\u006e.file();"],
    ['const a = globalThis["Bun"];'],
    ['const a = window["Bun"];'],
    ["const a = self.Bun;"],
    ["const a = global.Bun;"],
    ['const a = Reflect.get(globalThis, "Bun");'],
    ['eval("Bun.x");'],
    ['new Function("return Bun")();'],
    ["const m = await import(`bun`);"],
    ['const m = await import("bu" + "n");'],
    ["const m = await import(name);"],
    ["switch (a) { case Bun: break; }"],
    ["const x = a / b / Bun.x;"],
    ["let x = y\n/Bun.file/g"],
    ["const { file } = Bun;"],
    ["Bun?.x;"],
    ["const t: typeof Bun = a;"],
    ["const size = 100 / Bun.file('x').size;"],
    ["const of = 100;\nof / Bun.file('x').size;"],
    ["const a = x.return / Bun.size;"],
    ["const a = f() / Bun.size;"],
    ["const a = `${1}` / Bun.size;"],
    ["const a = cond ? Bun : other;"],
    ["const a = { k: cond ? Bun : 1 };"],
    ["const a = `${Bun.version}`;"],
    ["const re = /x/; Bun.file(re);"],
    ["if (a) Bun.file(x);"],
    ["Bun: for (;;) {}"],
];

const BENIGN: [string, string?][] = [
    ["// Bun.file()"],
    ["/* Bun.file() */ const b = 2;"],
    ["/**\n * Bun.x\n */\nconst a = 1;"],
    ['const c = "Bun.file() and bun:sqlite";'],
    ["const d = `Bun.file() ${a} Bun`;"],
    ["const re = /Bun.x[/]/g;"],
    ["if (ready) /Bun/.test(label);"],
    ["for (const x of /Bun/.exec(s)) {}"],
    ["const f = () => /Bun.x/.test(a);"],
    ["const a = { Bun: 1, bun: 2 };"],
    ["const a = c ? { Bun: 1 } : 2;"],
    ["const h = x.Bun;"],
    ["const h = x?.Bun;"],
    ["interface Shape { Bun: string }"],
    ["const Bunny = 1; const bun = 2; Bunny.x;"],
    ["const a = import.meta.dirname;"],
    ["const a = import.meta.filename;"],
    ["const a = import.meta.url;"],
    ["const a = import.meta.resolve('x');"],
    ['const a = import.meta.dirname + "import.meta.dir";'],
    ["const a = process.env.BUN_INSTALL;"],
    ['import { x } from "bunyan";'],
    ["const a = await import('node:fs');"],
    ["const a = require('node:fs');"],
    ["const a = <b>x</b>;\nconst c = 1 / 2 / 3;", "x.tsx"],
    ["const a = i++ / 2; const b = 3 / 1;"],
    ["const i = `${`Bun x`} ${a ? 1 : 2}`;"],
];

describe("runtime-agnostic guard", () => {
    it("covers the packed packages and client-core", () => {
        for (const target of TARGETS) expect(PUBLISHED_DIRS).toContain(target.dir);
        expect(PUBLISHED_DIRS).toContain("packages/client-core");
    });

    it("passes the real published sources", () => {
        expect(checkRuntimeAgnostic(root)).toEqual([]);
    });

    it.each(DETECTED)("detects %s", (text, file = "x.ts") => {
        expect(scan(file, `export {};\n${text}\n`).length).toBeGreaterThan(0);
    });

    it.each(BENIGN)("accepts %s", (text, file = "x.ts") => {
        expect(scan(file, `export {};\n${text}\n`)).toEqual([]);
    });

    it("reports file:line, past comments and templates", () => {
        const text = "/*\n\n*/\nconst a = `\n\n`;\nBun.x;\n";
        expect(scan("x.ts", text)).toEqual([expect.stringContaining("x.ts:7: the Bun global")]);
    });

    it("names the property in import.meta and process.versions findings", () => {
        expect(scan("x.ts", "import.meta.main;")[0]).toContain("import.meta.main");
        expect(scan("x.ts", "globalThis.Bun;")[0]).toContain("globalThis.Bun");
    });

    it.each([
        ["an unterminated block comment", "const a = 1; /* Bun.file()"],
        ["an unterminated string literal", "const a = 'Bun.file();\nconst b = 1;"],
        ["an unterminated template literal", "const a = `Bun.file()"],
        ["an unterminated regular expression", "const a = /Bun.file();\nconst b = 1;"],
        ["a syntax error", "const = ;"],
    ])("fails closed on %s", (_what, text) => {
        const problems = scan("x.ts", text);
        expect(problems.some((p) => p.includes("cannot be scanned"))).toBe(true);
    });

    it("scans every source file, not tests, and finds the line", () => {
        const dir = fixture({
            "p/src/deep/a.ts": "export {};\nexport const x = Bun.version;\n",
            "p/src/a.spec.ts": 'import { test } from "bun:test";',
            "p/src/__tests__/b.ts": "Bun.sleep(1);",
            "p/src/ok.ts": "export {};",
        });
        expect(checkRuntimeAgnostic(dir, ["p"])).toEqual([
            expect.stringContaining("p/src/deep/a.ts:2:"),
        ]);
    });

    it("follows symbolic links instead of skipping them, and fails on a broken one", () => {
        const dir = fixture({
            "elsewhere/linked.ts": "export const x = Bun.version;\n",
            "elsewhere/dir/inner.ts": "export const y = Bun.version;\n",
            "p/src/ok.ts": "export {};",
        });
        symlinkSync(path.join(dir, "elsewhere/linked.ts"), path.join(dir, "p/src/link.ts"));
        symlinkSync(path.join(dir, "elsewhere/dir"), path.join(dir, "p/src/linkdir"));
        const problems = checkRuntimeAgnostic(dir, ["p"]);
        expect(problems.some((p) => p.includes("link.ts:1:"))).toBe(true);
        expect(problems.some((p) => p.includes("linkdir/inner.ts:1:"))).toBe(true);

        symlinkSync(path.join(dir, "missing.ts"), path.join(dir, "p/src/broken.ts"));
        expect(
            checkRuntimeAgnostic(dir, ["p"]).some((p) => p.includes("broken.ts: cannot be read")),
        ).toBe(true);
    });

    it("does not loop on a symbolic link cycle", () => {
        const dir = fixture({ "p/src/ok.ts": "export {};" });
        symlinkSync(path.join(dir, "p/src"), path.join(dir, "p/src/self"));
        expect(checkRuntimeAgnostic(dir, ["p"])).toEqual([]);
    });
});
