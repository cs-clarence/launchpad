import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    checkTags,
    compareSemver,
    checkVersions,
    covered,
    independentPackages,
    SOURCE_VERSIONS,
    sharedWorkspaces,
    syncVersions,
    tagProblems,
} from "./versions";

const dirs: string[] = [];
// `sync` leaves bun.lock to `bun install --lockfile-only`, which the command line runs.
const withoutLock = (problems: string[]) => problems.filter((p) => !p.startsWith("bun.lock"));
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
    const lockWorkspaces = Object.fromEntries(
        ["packages/lib", "apps/app", "packages/tool"].map((dir) => [
            dir,
            {
                version:
                    dir === "apps/app"
                        ? (overrides.appVersion ?? "1.2.3")
                        : dir === "packages/tool"
                          ? "0.5.0"
                          : "1.2.3",
            },
        ]),
    );
    writeFileSync(
        path.join(root, "bun.lock"),
        `{\n  "lockfileVersion": 2,\n  "workspaces": ${JSON.stringify({ "": { name: "@t/root" }, ...lockWorkspaces })},\n}\n`,
    );
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
        expect(withoutLock(checkVersions(root))).toEqual([]);
        for (const source of SOURCE_VERSIONS) {
            expect(readFileSync(path.join(root, source.file), "utf8")).toContain('"2.0.0"');
        }
    });
});

describe("lockfile and strictness", () => {
    it("reports a workspace version bun.lock still records as old", () => {
        const root = repository();
        const lock = path.join(root, "bun.lock");
        writeFileSync(
            lock,
            readFileSync(lock, "utf8").replace(
                '"packages/lib":{"version":"1.2.3"',
                '"packages/lib":{"version":"0.0.0"',
            ),
        );
        expect(checkVersions(root).join("\n")).toContain("bun.lock records 0.0.0 for packages/lib");
    });

    it("accepts strict SemVer only", () => {
        for (const bad of ["01.2.3", "1.2.3-rc..1", "1.2", "1.2.3-", "v1.2.3"]) {
            expect(() => syncVersions(repository(), "core", bad), bad).toThrow("not a version");
        }
        for (const good of ["0.0.0", "1.2.3-rc.1", "1.2.3+build.7"]) {
            expect(() => syncVersions(repository(), "core", good), good).not.toThrow();
        }
    });

    it("normalizes a dotted workspace entry to the path the lockfile records", () => {
        const root = repository();
        writeFileSync(
            path.join(root, "package.json"),
            `{\n    "name": "@t/root",\n    "version": "1.2.3",\n    "workspaces": ["packages/./*", "apps/*"]\n}\n`,
        );
        expect(sharedWorkspaces(root).map((w) => w.dir)).toContain("packages/lib");
        expect(checkVersions(root)).toEqual([]);
    });

    it("normalizes a registered package path the same way", () => {
        const root = repository();
        writeFileSync(
            path.join(root, "cog.toml"),
            readFileSync(path.join(root, "cog.toml"), "utf8").replace(
                'path = "packages/tool"',
                'path = "packages/./tool"',
            ),
        );
        expect(independentPackages(root).get("@t/tool")).toBe("packages/tool");
        expect(sharedWorkspaces(root).map((w) => w.dir)).not.toContain("packages/tool");
    });

    it("refuses a workspace entry it cannot read", () => {
        const root = repository();
        writeFileSync(
            path.join(root, "package.json"),
            `{\n    "name": "@t/root",\n    "version": "1.2.3",\n    "workspaces": ["packages/extra/sdk"]\n}\n`,
        );
        expect(() => checkVersions(root)).toThrow("Unsupported workspace entry");
    });
});

describe("checkTags", () => {
    it("passes for equal, older or no tags and fails for a newer one", () => {
        const root = repository();
        const version = sharedWorkspaces(root)[0]!.version;
        expect(checkTags(root, ["", `v${version}`, "v0.0.0-old", "core-v9.0.0"])).toEqual([]);
        expect(checkTags(root, ["v99.0.0"])).toHaveLength(1);
    });
});

describe("compareSemver", () => {
    it("follows SemVer 2.0.0 precedence and ignores build metadata", () => {
        const ordered = [
            "1.0.0-alpha",
            "1.0.0-alpha.1",
            "1.0.0-alpha.beta",
            "1.0.0-beta",
            "1.0.0-beta.2",
            "1.0.0-beta.11",
            "1.0.0-rc.1",
            "1.0.0",
            "1.0.1",
            "1.2.0",
            "2.0.0",
            "10.0.0",
        ];
        for (let i = 1; i < ordered.length; i++) {
            expect(compareSemver(ordered[i - 1]!, ordered[i]!)).toBe(-1);
            expect(compareSemver(ordered[i]!, ordered[i - 1]!)).toBe(1);
        }
        expect(compareSemver("1.0.0-rc.9007199254740992", "1.0.0-rc.9007199254740993")).toBe(-1);
        expect(compareSemver("1.0.0-rc.9007199254740993", "1.0.0-rc.9007199254740992")).toBe(1);
        expect(compareSemver("1.0.0-rc.9007199254740993", "1.0.0-rc.9007199254740993")).toBe(0);
        expect(compareSemver("9007199254740993.0.0", "9007199254740992.0.0")).toBe(1);
        expect(compareSemver("1.9007199254740992.0", "1.9007199254740993.0")).toBe(-1);
        expect(compareSemver("1.0.9007199254740993", "1.0.9007199254740992")).toBe(1);
        expect(compareSemver("1.0.0+a", "1.0.0+b")).toBe(0);
        expect(compareSemver("1.0.0-rc.1+x", "1.0.0-rc.1")).toBe(0);
    });

    it("lets checkTags fail only a tag newer than the manifests", () => {
        const root = repository();
        const version = sharedWorkspaces(root)[0]!.version;
        expect(checkTags(root, [`v${version}+build.5`])).toEqual([]);
        expect(checkTags(root, [`v${version}-rc.1`])).toEqual([]);
        expect(checkTags(root, [`v${version}`])).toEqual([]);
        expect(checkTags(root, ["v99.0.0-rc.1"])).toHaveLength(1);
    });
});

describe("tagProblems", () => {
    const ok = { status: 0, stdout: "", stderr: "" };
    it("accepts a successful query with no tags", () => {
        expect(tagProblems(repository(), ok)).toEqual([]);
    });
    it("skips when git or the repository is absent", () => {
        const root = repository();
        expect(
            tagProblems(root, {
                ...ok,
                status: null,
                error: Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }),
            }),
        ).toEqual([]);
        expect(
            tagProblems(root, {
                ...ok,
                status: 128,
                stderr: "fatal: not a git repository (or any of the parent directories): .git",
            }),
        ).toEqual([]);
    });
    it("reports any other failure with its diagnostic", () => {
        const problems = tagProblems(repository(), {
            ...ok,
            status: 128,
            stderr: "fatal: bad object HEAD\n",
        });
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain("bad object HEAD");
    });
    it("still reports a newer tag from a successful query", () => {
        expect(tagProblems(repository(), { ...ok, stdout: "v99.0.0\n" })).toHaveLength(1);
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
        expect(withoutLock(checkVersions(root))).toEqual([]);
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
        expect(withoutLock(checkVersions(root))).toEqual([]);
    });

    it("refuses an unknown package and a bad version", () => {
        const root = repository();
        expect(() => syncVersions(root, "@t/nope", "1.0.0")).toThrow("not a package registered");
        expect(() => syncVersions(root, "core", "v2")).toThrow("not a version");
    });
});
