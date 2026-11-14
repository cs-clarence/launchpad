import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { check, importedPackages, omniDependencyNames, packageOf } from "./check-deps";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Spec {
    deps?: Record<string, string>;
    devDeps?: Record<string, string>;
    omniDeps?: string[];
    omniName?: string;
    source?: string;
}

// A throwaway workspace: a root with a catalog, plus projects under packages/.
function workspace(
    projects: Record<string, Spec>,
    catalog: Record<string, string> = {},
    extra: Record<string, string> = {},
) {
    const root = mkdtempSync(path.join(tmpdir(), "lp-deps-"));
    roots.push(root);
    writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ name: "root", workspaces: ["packages/*"], catalog }),
    );
    for (const [name, spec] of Object.entries(projects)) {
        const dir = path.join(root, "packages", name);
        mkdirSync(path.join(dir, "src"), { recursive: true });
        writeFileSync(
            path.join(dir, "package.json"),
            JSON.stringify({
                name: `@t/${name}`,
                dependencies: spec.deps,
                devDependencies: spec.devDeps,
            }),
        );
        writeFileSync(
            path.join(dir, "project.omni.yaml"),
            `name: "${spec.omniName ?? `@t/${name}`}"\ndependencies:\n  append: ${JSON.stringify(spec.omniDeps ?? [])}\n`,
        );
        writeFileSync(path.join(dir, "src", "index.ts"), spec.source ?? "export {};\n");
    }
    for (const [file, content] of Object.entries(extra)) {
        mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        writeFileSync(path.join(root, file), content);
    }
    return root;
}

describe("specifier parsing", () => {
    it("maps specifiers to package names and ignores non-packages", () => {
        expect(packageOf("zod")).toBe("zod");
        expect(packageOf("@scope/pkg/sub/path")).toBe("@scope/pkg");
        expect(packageOf("vitest/config")).toBe("vitest");
        expect(packageOf("x/y.js?raw")).toBe("x");
        for (const none of [
            "./a",
            "../b",
            "/abs",
            "node:fs",
            "fs",
            "bun",
            "bun:test",
            "virtual:x",
            "#internal",
            "~/x",
            "@/x",
        ]) {
            expect(packageOf(none), none).toBeNull();
        }
    });

    it("finds static, type, re-export, dynamic and require imports", () => {
        const found = importedPackages(`
            import a from "a";
            import type { B } from "@s/b";
            import "side-effect";
            export { c } from "c";
            const d = await import("d");
            const e = require("e");
            import f from "./local";
        `);
        expect([...found].toSorted()).toEqual(["@s/b", "a", "c", "d", "e", "side-effect"]);
    });

    it("ignores imports that appear only in comments", () => {
        const found = importedPackages(`
            // import "retired-package";
            /* import x from "block-comment"; */
            /**
             * require("doc-comment")
             */
            import real from "real"; // import "trailing-comment"
            const url = "https://example.com/not-a-comment";
        `);
        expect([...found]).toEqual(["real"]);
    });

    it("keeps imports that follow a string containing comment delimiters", () => {
        const found = importedPackages(`
            const route = "/api/*";
            const other = '//not-a-comment';
            const tpl = \`/* nor this */\`;
            await import("zod");
            /* a real block comment */
            import real from "real";
        `);
        expect([...found].toSorted()).toEqual(["real", "zod"]);
    });

    it("scans template interpolations as code and template text as text", () => {
        const found = importedPackages(
            [
                'const a = `result: ${ /* import("unused-package") */ 1 }`;',
                'const b = `text // import("in-template-text") stays text`;',
                'const c = `nested ${ `inner ${ 2 /* import("nested-unused") */ }` } done`;',
                'const d = `${ await import("used-in-interpolation") }`;',
                'import real from "real";',
            ].join("\n"),
        );
        expect([...found].toSorted()).toEqual([
            "in-template-text",
            "real",
            "used-in-interpolation",
        ]);
    });

    it("reads Omni dependency lists in both forms", () => {
        expect(omniDependencyNames(["a", "b"])).toEqual(["a", "b"]);
        expect(omniDependencyNames({ append: ["b"], prepend: ["a"] })).toEqual(["a", "b"]);
        expect(omniDependencyNames(undefined)).toEqual([]);
    });
});

describe("dependency check", () => {
    it("passes a consistent workspace", () => {
        const root = workspace(
            {
                core: { deps: { zod: "catalog:" }, source: 'import { z } from "zod";\n' },
                app: {
                    deps: { "@t/core": "workspace:^", zod: "catalog:" },
                    omniDeps: ["@t/core"],
                    source: 'import "@t/core";\nimport "zod";\n',
                },
            },
            { zod: "1.0.0" },
        );
        expect(check(root)).toEqual([]);
    });

    it("reports a workspace dependency missing from the Omni graph, and the reverse", () => {
        const root = workspace({
            core: {},
            app: { deps: { "@t/core": "workspace:^" }, source: 'import "@t/core";\n' },
            extra: { omniDeps: ["@t/core"] },
        });
        const errors = check(root);
        expect(
            errors.some((e) => e.includes("@t/app") && e.includes("not in project.omni.yaml")),
        ).toBe(true);
        expect(
            errors.some(
                (e) => e.includes("@t/extra") && e.includes("package.json does not depend"),
            ),
        ).toBe(true);
    });

    it("reports undeclared imports and dead runtime dependencies", () => {
        const root = workspace(
            { app: { deps: { zod: "catalog:" }, source: 'import "left-pad";\n' } },
            { zod: "1.0.0" },
        );
        const errors = check(root);
        expect(errors).toContain("@t/app: imports left-pad but does not declare it");
        expect(errors.some((e) => e.includes("lists zod but nothing imports it"))).toBe(true);
    });

    it("accepts a runtime dependency that another dependency needs as a peer", () => {
        const root = workspace(
            { app: { deps: { host: "catalog:", peer: "catalog:" }, source: 'import "host";\n' } },
            { host: "1.0.0", peer: "1.0.0" },
        );
        mkdirSync(path.join(root, "node_modules", "host"), { recursive: true });
        writeFileSync(
            path.join(root, "node_modules", "host", "package.json"),
            JSON.stringify({ name: "host", peerDependencies: { peer: "*" } }),
        );
        expect(check(root)).toEqual([]);
    });

    it("rejects pinned versions, unknown catalog entries and unused catalog entries", () => {
        const root = workspace(
            {
                app: {
                    devDeps: { pinned: "^1.2.3", ghost: "catalog:" },
                    source: "export {};\n",
                },
            },
            { unused: "1.0.0" },
        );
        const errors = check(root);
        expect(errors.some((e) => e.includes("pinned") && e.includes("use catalog:"))).toBe(true);
        expect(
            errors.some((e) => e.includes("ghost") && e.includes("missing from the root catalog")),
        ).toBe(true);
        expect(errors.some((e) => e.includes("unused is not used"))).toBe(true);
    });

    it("counts generator templates as users of the catalog", () => {
        const root = workspace(
            { app: {} },
            { templated: "1.0.0" },
            {
                "omni/generators/g/templates/package.json.tpl":
                    '{ "dependencies": { "templated": "catalog:" } }',
            },
        );
        expect(check(root)).toEqual([]);
    });

    it("reports a project whose Omni name differs or is missing", () => {
        const root = workspace({ app: { omniName: "@t/other" } });
        expect(check(root).some((e) => e.includes("names it @t/other"))).toBe(true);
        rmSync(path.join(root, "packages", "app", "project.omni.yaml"));
        expect(check(root).some((e) => e.includes("no project.omni.yaml"))).toBe(true);
    });
});
