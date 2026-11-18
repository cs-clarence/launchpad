import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    checkVersions,
    covered,
    independentPackages,
    SOURCE_VERSIONS,
    sharedWorkspaces,
    syncVersions,
} from "./versions";

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function manifest(root: string, dir: string, name: string, version: string) {
    mkdirSync(path.join(root, dir), { recursive: true });
    writeFileSync(
        path.join(root, dir, "package.json"),
        `{\n    "name": "${name}",\n    "version": "${version}",\n    "dependencies": { "x": "1.0.0" }\n}\n`,
    );
}

// A small repository: a root, two shipped packages, and one tooling package of its own.
function repository(overrides: { appVersion?: string; include?: string[] } = {}) {
    const root = mkdtempSync(path.join(tmpdir(), "launchpad-versions-"));
    dirs.push(root);
    writeFileSync(
        path.join(root, "package.json"),
        `{\n    "name": "@t/root",\n    "private": true,\n    "version": "1.2.3",\n    "workspaces": ["packages/*", "apps/*"]\n}\n`,
    );
    manifest(root, "packages/lib", "@t/lib", "1.2.3");
    manifest(root, "apps/app", "@t/app", overrides.appVersion ?? "1.2.3");
    manifest(root, "packages/tool", "@t/tool", "0.5.0");
    for (const source of SOURCE_VERSIONS) {
        mkdirSync(path.dirname(path.join(root, source.file)), { recursive: true });
        const line = source.file.includes("cli")
            ? `program.version("1.2.3");`
            : source.file.includes("mcp")
              ? `const info = { name: "launchpad-mcp", version: "1.2.3" };`
              : `const info = {\n    version: "1.2.3",\n};`;
        writeFileSync(path.join(root, source.file), `${line}\n`);
    }
    const include = overrides.include ?? ["packages/lib/**", "apps/**"];
    writeFileSync(
        path.join(root, "cog.toml"),
        `[monorepo.packages.core]\npath = "."\ninclude = [${include.map((i) => `"${i}"`).join(", ")}]\n\n[monorepo.packages."@t/tool"]\npath = "packages/tool"\ninclude = ["packages/tool/**"]\n`,
    );
    return root;
}

describe("shared version set", () => {
    it("is every workspace and the root except the packages cog.toml versions on their own", () => {
        const root = repository();
        expect([...independentPackages(root).keys()]).toEqual(["@t/tool"]);
        expect(
            sharedWorkspaces(root)
                .map((w) => w.dir)
                .toSorted(),
        ).toEqual([".", "apps/app", "packages/lib"]);
    });
});

describe("checkVersions", () => {
    it("accepts agreement", () => {
        expect(checkVersions(repository())).toEqual([]);
    });

    it("names a package whose version differs", () => {
        expect(checkVersions(repository({ appVersion: "1.2.4" })).join("\n")).toContain(
            "@t/app (apps/app) is 1.2.4",
        );
    });

    it("refuses a version that is not a version", () => {
        expect(checkVersions(repository({ appVersion: "latest" })).join("\n")).toContain(
            "is not a version",
        );
    });

    it("finds a package cog.toml would never bump for", () => {
        expect(checkVersions(repository({ include: ["apps/**"] })).join("\n")).toContain(
            "packages/lib is not in the core include list",
        );
    });
});

describe("version strings in source", () => {
    it("are compared by check and rewritten by sync", () => {
        const root = repository();
        const file = path.join(root, SOURCE_VERSIONS[0]!.file);
        writeFileSync(file, `program.version("0.0.1");\n`);
        expect(checkVersions(root).join("\n")).toContain("says 0.0.1; the root is 1.2.3");
        syncVersions(root, "core", "2.0.0");
        expect(checkVersions(root)).toEqual([]);
        for (const source of SOURCE_VERSIONS) {
            expect(readFileSync(path.join(root, source.file), "utf8")).toContain('"2.0.0"');
        }
    });
});

describe("covered", () => {
    it("matches a directory by a dir/** include and nothing wider", () => {
        expect(covered(["apps/**"], "apps/cli")).toBe(true);
        expect(covered(["packages/sdk/**"], "packages/sdk")).toBe(true);
        expect(covered(["packages/sdk/**"], "packages/sdk-extra")).toBe(false);
        expect(covered(["apps/*"], "apps/cli")).toBe(false);
    });
});

describe("syncVersions", () => {
    it("rewrites only the version line of every shared manifest", () => {
        const root = repository();
        const before = readFileSync(path.join(root, "apps/app/package.json"), "utf8");
        syncVersions(root, "core", "2.0.0");
        expect(checkVersions(root)).toEqual([]);
        expect(readFileSync(path.join(root, "apps/app/package.json"), "utf8")).toBe(
            before.replace('"1.2.3"', '"2.0.0"'),
        );
        expect(readFileSync(path.join(root, "package.json"), "utf8")).toContain(
            '"version": "2.0.0"',
        );
        // The independently versioned package is untouched.
        expect(readFileSync(path.join(root, "packages/tool/package.json"), "utf8")).toContain(
            '"version": "0.5.0"',
        );
    });

    it("versions an independent package on its own", () => {
        const root = repository();
        syncVersions(root, "@t/tool", "0.6.0");
        expect(readFileSync(path.join(root, "packages/tool/package.json"), "utf8")).toContain(
            '"version": "0.6.0"',
        );
        expect(checkVersions(root)).toEqual([]);
    });

    it("refuses an unknown package and a bad version", () => {
        const root = repository();
        expect(() => syncVersions(root, "@t/nope", "1.0.0")).toThrow("not a package registered");
        expect(() => syncVersions(root, "core", "v2")).toThrow("not a version");
    });
});
