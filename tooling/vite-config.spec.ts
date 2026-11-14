import { describe, expect, it } from "bun:test";
import { builtinModules } from "node:module";
import { isExternal } from "../packages/vite-config/src/library";

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
