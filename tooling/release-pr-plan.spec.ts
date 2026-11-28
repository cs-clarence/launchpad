import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { type Channel, CHANNELS } from "./release-channels";
import {
    allowedPath,
    ALLOWED_PATHS,
    BODY_LIMIT,
    MAX_FILE_BYTES,
    changedFileProblems,
    changelogRange,
    channelNames,
    nextCounter,
    planRelease,
    prBody,
    versionOnlyProblems,
} from "./release-pr";
import { SOURCE_VERSIONS } from "./versions";

const rc = CHANNELS.find((c) => c.name === "rc")!;
const beta: Channel = {
    name: "beta",
    rank: 2,
    preRelease: "-beta.N",
    supports: ["major", "minor"],
    npmTag: "beta",
    imageTags: ["beta", "next"],
    trigger: "tag",
    versionScheme: "counter",
};

describe("the dispatch channels", () => {
    it("are the registered names", () => {
        expect(channelNames()).toEqual(["stable", "rc"]);
    });
});

describe("the next pre-release counter", () => {
    it("starts at 1 and follows the highest existing counter", () => {
        expect(nextCounter("1.2.0", rc, [])).toBe(1n);
        expect(nextCounter("1.2.0", rc, ["v1.2.0-rc.1"])).toBe(2n);
        expect(nextCounter("1.2.0", rc, ["v1.2.0-rc.1", "v1.2.0-rc.9", "v1.2.0-rc.10"])).toBe(11n);
    });

    it("ignores other versions, other channels and malformed tags", () => {
        const tags = [
            "v1.2.1-rc.7",
            "v1.2.0-beta.4",
            "v1.2.0-rc.x",
            "v1.2.0-rc.01",
            "v1.2.0",
            "core-v1.2.0-rc.5",
            "v1.2.0-rc",
        ];
        expect(nextCounter("1.2.0", rc, tags)).toBe(1n);
        expect(nextCounter("1.2.0", beta, tags)).toBe(5n);
    });

    it("compares counters as BigInt, so a huge counter does not lose precision", () => {
        const huge = "9007199254740993";
        expect(nextCounter("1.2.0", rc, [`v1.2.0-rc.${huge}`])).toBe(9007199254740994n);
        expect(nextCounter("1.2.0", rc, [`v1.2.0-rc.${huge}`, "v1.2.0-rc.9007199254740992"])).toBe(
            9007199254740994n,
        );
        expect(planRelease("1.2.0", "rc", [`v1.2.0-rc.${huge}`]).version).toBe(
            "1.2.0-rc.9007199254740994",
        );
    });

    it("refuses stable, which has no counter", () => {
        expect(() => nextCounter("1.2.0", CHANNELS[0]!, [])).toThrow();
    });
});

describe("planning a release", () => {
    it("plans a stable release as the base", () => {
        expect(planRelease("0.1.0", "stable", [])).toEqual({
            version: "0.1.0",
            channel: "stable",
            range: "..v0.1.0",
        });
    });

    it("computes the pre-release number itself", () => {
        expect(planRelease("0.1.0", "rc", []).version).toBe("0.1.0-rc.1");
        expect(planRelease("0.1.0", "rc", ["v0.1.0-rc.1", "v0.1.0-rc.2"]).version).toBe(
            "0.1.0-rc.3",
        );
    });

    it("refuses a bad base and an unregistered channel", () => {
        for (const base of [
            "",
            "1.2",
            "1.2.3-rc.1",
            "v1.2.3",
            "01.2.3",
            "1.2.3+b",
            "1.2.3 ",
            "1.2.3\n--x",
            "$(id)",
        ]) {
            expect(() => planRelease(base, "stable", []), JSON.stringify(base)).toThrow(
                /is not X.Y.Z/,
            );
        }
        for (const channel of ["alpha", "beta", "nightly", "", "RC", "stable ", "rc.1"]) {
            expect(() => planRelease("1.2.3", channel, []), channel).toThrow(
                /not a registered channel/,
            );
        }
    });

    it("refuses a channel that does not support the kind (a fake registry with beta)", () => {
        const fake = [beta, rc, CHANNELS[0]!];
        expect(() => planRelease("0.2.1", "beta", [], fake)).toThrow(/does not support a patch/);
        expect(planRelease("0.2.0", "beta", [], fake).version).toBe("0.2.0-beta.1");
    });

    it("refuses a version that already exists and any pre-release once the stable exists", () => {
        expect(() => planRelease("0.1.0", "stable", ["v0.1.0"])).toThrow(/already exists/);
        expect(() => planRelease("0.1.0", "rc", ["v0.1.0"])).toThrow(/go backwards/);
        expect(() => planRelease("0.1.0", "rc", ["v0.1.0", "v0.1.0-rc.1"])).toThrow(/go backwards/);
    });

    it("applies the no-regression rule across channels", () => {
        const fake = [beta, rc, CHANNELS[0]!];
        expect(() => planRelease("1.0.0", "beta", ["v1.0.0-rc.1"], fake)).toThrow(/go backwards/);
        expect(planRelease("1.0.0", "rc", ["v1.0.0-beta.2"], fake).version).toBe("1.0.0-rc.1");
        expect(planRelease("1.0.0", "stable", ["v1.0.0-rc.4"], fake).version).toBe("1.0.0");
    });
});

describe("the changelog range", () => {
    const tags = ["v0.1.0-rc.1", "v0.1.0-rc.2", "v0.1.0", "v0.2.0-rc.1", "v0.1.1"];

    it("starts a stable release at the last stable tag, pre-releases in between included", () => {
        expect(changelogRange("0.2.0", tags)).toBe("v0.1.1..v0.2.0");
        expect(changelogRange("0.1.0", ["v0.1.0-rc.1", "v0.1.0-rc.2"])).toBe("..v0.1.0");
        expect(changelogRange("0.1.0", ["v0.0.9", "v0.1.0-rc.2"])).toBe("v0.0.9..v0.1.0");
    });

    it("starts a pre-release at the previous tag of any kind", () => {
        expect(changelogRange("0.1.0-rc.3", ["v0.1.0-rc.1", "v0.1.0-rc.2"])).toBe(
            "v0.1.0-rc.2..v0.1.0-rc.3",
        );
        expect(changelogRange("0.2.0-rc.2", tags)).toBe("v0.2.0-rc.1..v0.2.0-rc.2");
        expect(changelogRange("0.2.0-rc.1", ["v0.1.1"])).toBe("v0.1.1..v0.2.0-rc.1");
        expect(changelogRange("0.1.0-rc.1", [])).toBe("..v0.1.0-rc.1");
    });

    it("ignores tags that are not releases and versions above it", () => {
        expect(changelogRange("0.1.0-rc.1", ["core-v0.0.9", "", "v0.3.0", "x"])).toBe(
            "..v0.1.0-rc.1",
        );
    });
});

describe("the PR body", () => {
    it("says merging does not publish, names the tag and holds the changelog", () => {
        const body = prBody("0.1.0-rc.1", "rc", "\n## v0.1.0-rc.1\n- a change\n");
        expect(body).toContain("**v0.1.0-rc.1** (rc channel)");
        expect(body).toContain("does **not** publish");
        expect(body).toContain("`v0.1.0-rc.1`");
        expect(body.endsWith("- a change\n")).toBe(true);
    });
});

describe("the bump commit's paths", () => {
    const file = (path: string, status = "M", oldMode = "100644", newMode = "100644") => ({
        path,
        status,
        oldMode,
        newMode,
    });

    it("allow the manifests, lockfile, changelogs and the three source version files", () => {
        for (const path of [
            "package.json",
            "apps/cli/package.json",
            "packages/tsconfig/package.json",
            "bun.lock",
            "CHANGELOG.md",
            "packages/vite-config/CHANGELOG.md",
            ...SOURCE_VERSIONS.map((source) => source.file),
        ]) {
            expect(allowedPath(path), path).toBe(true);
        }
        expect(SOURCE_VERSIONS.map((s) => s.file).toSorted()).toEqual([
            "apps/cli/src/program.ts",
            "apps/controller/src/server/openapi.ts",
            "apps/mcp/src/server.ts",
        ]);
        expect(ALLOWED_PATHS).toHaveLength(5 + SOURCE_VERSIONS.length);
    });

    it("refuse workflows, scripts, other sources and path tricks", () => {
        for (const path of [
            ".github/workflows/release.yaml",
            ".github/actions/setup-workspace/action.yaml",
            "tooling/versions.ts",
            "cog.toml",
            "apps/cli/src/index.ts",
            "apps/cli/package.json.bak",
            "apps/cli/sub/package.json",
            "node_modules/x/package.json",
            "../package.json",
            "package.json/x",
            "packages/../package.json",
            "apps/../apps/cli/package.json",
            "apps/./cli/package.json",
            "apps/.git/package.json",
            "packages/.git/CHANGELOG.md",
            "apps/CLI/package.json",
            "apps/cli.x/package.json",
            "apps/cli_x/package.json",
            "apps/ cli/package.json",
            "Package.json",
            "apps/cli/src/programxts",
            "bun.lockb",
            "packages/x/CHANGELOG.md/y",
            "",
        ]) {
            expect(allowedPath(path), path).toBe(false);
        }
    });

    it("refuse deletions, renames, symlinks, executables and an empty commit", () => {
        expect(
            changedFileProblems([file("package.json"), file("CHANGELOG.md", "A", "000000")]),
        ).toEqual([]);
        expect(changedFileProblems([])).toEqual(["the commit changes nothing"]);
        expect(changedFileProblems([file("package.json", "D")])).not.toEqual([]);
        expect(changedFileProblems([file("package.json", "R100")])).not.toEqual([]);
        expect(changedFileProblems([file("package.json", "M", "100644", "120000")])).not.toEqual(
            [],
        );
        expect(changedFileProblems([file("package.json", "M", "100644", "100755")])).not.toEqual(
            [],
        );
        expect(changedFileProblems([file("package.json", "M", "100755", "100644")])).not.toEqual(
            [],
        );
        expect(
            changedFileProblems(
                [file("CHANGELOG.md", "M")].map((f) => ({ ...f, size: MAX_FILE_BYTES })),
            ),
        ).toEqual([]);
        expect(
            changedFileProblems([{ ...file("CHANGELOG.md"), size: MAX_FILE_BYTES + 1 }]),
        ).toEqual([expect.stringContaining("is larger than")]);
        // A manifest or the lockfile is only ever modified in a release bump, never added.
        expect(changedFileProblems([file("packages/x/package.json", "A", "000000")])).toEqual([
            expect.stringContaining("must be modified, not added"),
        ]);
        expect(changedFileProblems([file("bun.lock", "A", "000000")])).not.toEqual([]);
        expect(changedFileProblems([file("packages/x/CHANGELOG.md", "A", "000000")])).toEqual([]);
        expect(changedFileProblems([file(".github/workflows/x.yaml")])).toEqual([
            expect.stringContaining("not an allowed path"),
        ]);
    });

    it("let a manifest or source file change only on its version line", () => {
        expect(versionOnlyProblems("package.json", ['    "version": "0.1.0",'])).toEqual([]);
        expect(versionOnlyProblems("apps/cli/package.json", ['    "version": "0.0.0",'])).toEqual(
            [],
        );
        expect(
            versionOnlyProblems("apps/cli/src/program.ts", ['        .version("0.1.0")']),
        ).toEqual([]);
        expect(
            versionOnlyProblems("apps/mcp/src/server.ts", [
                '        { name: "launchpad-mcp", version: "0.1.0" },',
            ]),
        ).toEqual([]);
        expect(
            versionOnlyProblems("apps/controller/src/server/openapi.ts", [
                '                version: "0.1.0",',
            ]),
        ).toEqual([]);
        for (const [file, line] of [
            ["package.json", '    "postinstall": "curl x | sh",'],
            ["package.json", '    "version": "0.1.0", "x": 1,'],
            ["package.json", '    "scripts": { "a": "version" },'],
            ["apps/cli/src/program.ts", '        .version("0.1.0"); exec("x")'],
            ["apps/mcp/src/server.ts", "        evil(version)"],
            ["apps/controller/src/server/openapi.ts", '                version: "0.1.0", x'],
            ["package.json", "++ not a header"],
        ] as const) {
            expect(versionOnlyProblems(file, [line]), `${file} ${line}`).not.toEqual([]);
        }
        // Changelogs and the lockfile change freely; the reviewer reads them.
        expect(versionOnlyProblems("CHANGELOG.md", ["anything"])).toEqual([]);
        expect(versionOnlyProblems("bun.lock", ['      "version": "0.1.0",'])).toEqual([]);
        // The lockfile is held to the same rule: a replaced dependency graph is refused.
        expect(versionOnlyProblems("bun.lock", ['      "evil": "1.0.0",'])).not.toEqual([]);
        expect(
            versionOnlyProblems("bun.lock", [
                '    "packages": { "x": ["x@1.0.0", "https://evil/x.tgz"] },',
            ]),
        ).not.toEqual([]);
    });
});

describe("the PR body limit", () => {
    it("cuts a long changelog below GitHub's limit and says so", () => {
        const body = prBody("0.1.0", "stable", "x".repeat(BODY_LIMIT + 5000));
        expect(body.length).toBeLessThan(65536);
        expect(body).toContain("The changelog is cut here");
        expect(prBody("0.1.0", "stable", "short")).not.toContain("cut here");
    });
});

describe("the command line", () => {
    const run = (args: string[]) =>
        spawnSync("bun", ["tooling/release-pr.ts", ...args], {
            cwd: path.resolve(import.meta.dirname, ".."),
            encoding: "utf8",
        });

    it("refuses a bad base without touching anything", () => {
        const done = run(["plan", "--base", "1.2", "--channel", "stable"]);
        expect(done.status).toBe(1);
        expect(done.stderr).toContain("is not X.Y.Z");
    });

    it("writes a body file", () => {
        const dir = mkdtempSync(path.join(tmpdir(), "prbody-"));
        writeFileSync(path.join(dir, "c.md"), "- change\n");
        const done = run([
            "body",
            "--version",
            "0.1.0",
            "--changelog",
            path.join(dir, "c.md"),
            "--out",
            path.join(dir, "b.md"),
        ]);
        expect(done.status).toBe(0);
        expect(readFileSync(path.join(dir, "b.md"), "utf8")).toContain("(stable channel)");
        expect(run(["body", "--version", "nope", "--changelog", "x", "--out", "y"]).status).toBe(1);
    });
});
