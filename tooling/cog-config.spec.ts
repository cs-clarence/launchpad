import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const cog = Bun.TOML.parse(
    readFileSync(path.resolve(import.meta.dirname, "..", "cog.toml"), "utf8"),
) as Record<string, unknown>;

describe("cog.toml release settings", () => {
    it("creates one global v<semver> tag and no package tags", () => {
        expect(cog.tag_prefix).toBe("v");
        expect(cog.generate_mono_repository_global_tag).toBe(true);
        expect(cog.generate_mono_repository_package_tags).toBe(false);
    });

    it("does not mark the bump commit [skip ci]", () => {
        expect(cog.skip_ci).toBe("");
    });
});
