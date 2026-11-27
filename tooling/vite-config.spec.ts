import { describe, expect, it } from "bun:test";
import { builtinModules } from "node:module";
import { isExternal } from "../packages/vite-config/src/library";
import cli from "../apps/cli/vite.config";
import mcp from "../apps/mcp/vite.config";
import cliPackage from "../apps/cli/package.json";
import mcpPackage from "../apps/mcp/package.json";

// What Node reports: no `bun`. Vite runs under Node in CI, under Bun locally.
const nodeBuiltins = builtinModules.filter((m) => m !== "bun" && !m.startsWith("bun:"));

describe("library build externals", () => {
    it("externalizes Bun's built-in modules even when Vite runs under Node", () => {
        expect(nodeBuiltins).not.toContain("bun");
        for (const id of ["bun", "bun:test", "bun:sqlite"]) {
            expect(isExternal(id, [], true, nodeBuiltins), id).toBe(true);
        }
    });

    it("externalizes Node built-ins and declared dependencies, and bundles the rest", () => {
        expect(isExternal("node:fs", [], true, nodeBuiltins)).toBe(true);
        expect(isExternal("fs", [], true, nodeBuiltins)).toBe(true);
        expect(isExternal("zod", ["zod"], true, nodeBuiltins)).toBe(true);
        expect(isExternal("zod/v4", ["zod"], true, nodeBuiltins)).toBe(true);
        expect(isExternal("zod", ["zod"], false, nodeBuiltins)).toBe(false);
        expect(isExternal("left-pad", ["zod"], true, nodeBuiltins)).toBe(false);
        expect(isExternal("./local", [], true, nodeBuiltins)).toBe(false);
    });
});

describe("the executables' build", () => {
    type Config = {
        build?: { rolldownOptions?: { external?: unknown }; lib?: unknown };
        plugins?: unknown[];
    };
    const cases = [
        { key: "cli", config: cli as Config, manifest: cliPackage, subpath: "@elastic/micro-jq" },
        {
            key: "mcp",
            config: mcp as Config,
            manifest: mcpPackage,
            subpath: "@modelcontextprotocol/sdk/server/mcp.js",
        },
    ];

    for (const { key, config, manifest, subpath } of cases) {
        it(`${key}: imports every dependency instead of bundling it`, () => {
            const external = config.build?.rolldownOptions?.external as (id: string) => boolean;
            expect(typeof external).toBe("function");
            for (const id of [
                "@launchpad-kit/client-core",
                "@launchpad-kit/sdk",
                subpath,
                "node:fs",
                ...Object.keys(manifest.dependencies),
            ]) {
                expect(external(id), id).toBe(true);
            }
            expect(external("left-pad")).toBe(false);
        });

        it(`${key}: emits one ${key}.mjs and no declarations`, () => {
            const lib = config.build?.lib as {
                entry: Record<string, string>;
                fileName: (format: string, entry: string) => string;
            };
            expect(lib.entry).toEqual({ [key]: "src/index.ts" });
            expect(lib.fileName("es", key)).toBe(`${key}.mjs`);
            expect(config.plugins ?? []).toEqual([]);
        });
    }
});
