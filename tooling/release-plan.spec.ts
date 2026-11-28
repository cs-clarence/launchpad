import { describe, expect, it } from "bun:test";
import {
    checkTag,
    ciPassedProblem,
    classifyInspect,
    consumerManifest,
    exactTagAction,
    floatingTags,
    IMAGES,
    labelVersion,
    npmDistTag,
    npmPublishAction,
    partialReleaseProblems,
    previousStable,
    type PreviousRelease,
    tagMismatches,
} from "./release-plan";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

describe("tag guard", () => {
    it("accepts release tags", () => {
        for (const tag of ["v0.1.0", "v0.1.0-rc.1", "v1.2.3-rc-1", "v10.20.30"]) {
            expect(checkTag(tag), tag).toEqual([]);
        }
    });

    it("rejects build metadata, leading zeros, trailing text and package tags", () => {
        for (const tag of [
            "v1.2.3+build.5",
            "v01.2.3",
            "v1.2.3garbage",
            "v1.2",
            "1.2.3",
            "core-v0.1.0",
            "@launchpad-kit/sdk-v0.1.0",
            "v1.2.3-",
            "v1.2.3-01",
        ]) {
            expect(checkTag(tag), tag).not.toEqual([]);
        }
    });

    it("limits the version to 128 characters, the longest image tag", () => {
        const base = "1.2.3-";
        expect(checkTag(`v${base}${"a".repeat(128 - base.length)}`)).toEqual([]);
        expect(checkTag(`v${base}${"a".repeat(129 - base.length)}`)[0]).toContain("128");
    });
});

describe("npm dist-tag", () => {
    it("never gives a pre-release latest", () => {
        expect(npmDistTag("0.1.0-rc.1", null)).toBe("next");
        expect(npmDistTag("0.1.0-rc.1", "0.0.1")).toBe("next");
        expect(npmDistTag("2.0.0-rc.1", "1.0.0")).toBe("next");
    });

    it("takes latest when the package has none yet (the first stable release)", () => {
        expect(npmDistTag("0.1.0", null)).toBe("latest");
        expect(npmDistTag("0.1.0", undefined)).toBe("latest");
        expect(npmDistTag("0.1.0", "")).toBe("latest");
    });

    it("retries a version lower than latest under retry", () => {
        expect(npmDistTag("1.2.3", "1.2.4")).toBe("retry");
        expect(npmDistTag("1.9.0", "2.0.0")).toBe("retry");
        expect(npmDistTag("0.1.0", "0.1.0-rc.1")).toBe("latest");
    });

    it("takes latest for a higher or equal version", () => {
        expect(npmDistTag("1.2.4", "1.2.3")).toBe("latest");
        expect(npmDistTag("1.2.3", "1.2.3")).toBe("latest");
    });
});

describe("floating image tags", () => {
    it("moves X.Y and latest to a newer stable version", () => {
        expect(
            floatingTags({ version: "1.2.4", xyVersion: "1.2.3", latestVersion: "1.2.3" }),
        ).toEqual({
            xy: true,
            latest: true,
        });
    });

    it("creates a floating tag that does not exist", () => {
        expect(floatingTags({ version: "0.1.0", xyVersion: null, latestVersion: null })).toEqual({
            xy: true,
            latest: true,
        });
    });

    it("moves X.Y forward only", () => {
        const plan = floatingTags({ version: "1.2.3", xyVersion: "1.2.4", latestVersion: "1.3.0" });
        expect(plan).toEqual({ xy: false, latest: false });
        expect(
            floatingTags({ version: "1.2.5", xyVersion: "1.2.5", latestVersion: "1.2.5" }),
        ).toEqual({ xy: false, latest: false });
    });

    it("moves X.Y but not latest when a newer minor holds latest", () => {
        expect(
            floatingTags({ version: "1.2.4", xyVersion: "1.2.3", latestVersion: "1.3.0" }),
        ).toEqual({
            xy: true,
            latest: false,
        });
    });

    it("never moves a floating tag for a pre-release", () => {
        expect(
            floatingTags({ version: "0.1.0-rc.1", xyVersion: null, latestVersion: null }),
        ).toEqual({
            xy: false,
            latest: false,
        });
    });
});

describe("immutable version tag", () => {
    it("creates a missing tag, skips one on the staged digest and refuses another", () => {
        expect(exactTagAction("sha256:a", null)).toBe("create");
        expect(exactTagAction("sha256:a", "sha256:a")).toBe("skip");
        expect(() => exactTagAction("sha256:a", "sha256:b")).toThrow();
    });
});

describe("npm re-run", () => {
    it("publishes a missing version", () => {
        expect(npmPublishAction("sha512-a", null)).toBe("publish");
    });

    it("skips only a version with the same integrity and provenance", () => {
        expect(npmPublishAction("sha512-a", { integrity: "sha512-a", attested: true })).toBe(
            "skip",
        );
        expect(() =>
            npmPublishAction("sha512-a", { integrity: "sha512-b", attested: true }),
        ).toThrow();
        expect(() =>
            npmPublishAction("sha512-a", { integrity: "sha512-a", attested: false }),
        ).toThrow(/provenance/);
    });
});

describe("previous stable release", () => {
    it("is the highest stable tag below the version", () => {
        const tags = ["v0.1.0", "v0.1.1", "v0.2.0-rc.1", "v0.2.0", "v1.0.0", "core-v9.9.9"];
        expect(previousStable(tags, "0.2.1")).toBe("0.2.0");
        expect(previousStable(tags, "0.2.0")).toBe("0.1.1");
        expect(previousStable(tags, "0.1.0")).toBeNull();
        expect(previousStable([], "0.1.0")).toBeNull();
    });
});

describe("partial release check", () => {
    const staged = "sha256:" + "a".repeat(64);
    const image = { staged, exact: staged, xy: staged, latest: staged };
    const complete = (): PreviousRelease => ({
        version: "0.1.0",
        packages: Object.fromEntries(
            ["contracts", "sdk", "client-core", "cli", "mcp"].map((n) => [
                `@launchpad-kit/${n}`,
                { integrity: "sha512-x", attested: true },
            ]),
        ),
        images: Object.fromEntries(IMAGES.map((n) => [n, { ...image }])),
    });

    it("passes a complete release", () => {
        expect(partialReleaseProblems(complete())).toEqual([]);
    });

    it("fails a package that is missing or has no provenance", () => {
        const release = complete();
        release.packages["@launchpad-kit/cli"] = { integrity: null, attested: false };
        release.packages["@launchpad-kit/mcp"] = { integrity: "sha512-x", attested: false };
        expect(partialReleaseProblems(release)).toEqual([
            expect.stringContaining("cli@0.1.0 is not published"),
            expect.stringContaining("mcp@0.1.0 has no provenance"),
        ]);
    });

    it("fails floating tags that exist but resolve to another digest", () => {
        const release = complete();
        release.images.worker!.latest = "sha256:" + "b".repeat(64);
        release.images.router!.xy = null;
        release.images.admin!.exact = "sha256:" + "c".repeat(64);
        const problems = partialReleaseProblems(release);
        expect(problems).toHaveLength(3);
        expect(problems.join("\n")).toContain("worker:latest");
        expect(problems.join("\n")).toContain("router:0.1 is missing");
        expect(problems.join("\n")).toContain("admin:0.1.0");
    });

    it("fails an image whose staged tag is missing", () => {
        const release = complete();
        release.images.dokku = { staged: null, exact: null, xy: null, latest: null };
        expect(partialReleaseProblems(release)).toEqual([expect.stringContaining("dokku")]);
    });
});

describe("CI Passed lookup", () => {
    const run = (extra: object) => ({
        name: "CI Passed",
        app: { slug: "github-actions" },
        status: "completed",
        conclusion: "success",
        completed_at: "2026-11-27T10:00:00Z",
        ...extra,
    });

    it("passes on a successful run", () => {
        expect(ciPassedProblem([run({})])).toBeNull();
    });

    it("lets the latest completed run decide", () => {
        const failed = run({ conclusion: "failure", completed_at: "2026-11-27T09:00:00Z" });
        expect(ciPassedProblem([failed, run({})])).toBeNull();
        expect(
            ciPassedProblem([
                run({}),
                run({ conclusion: "failure", completed_at: "2026-11-27T11:00:00Z" }),
            ]),
        ).toContain("failure");
    });

    it("ignores other checks, other apps and runs not completed", () => {
        expect(ciPassedProblem([])).not.toBeNull();
        expect(ciPassedProblem([run({ name: "Check" })])).not.toBeNull();
        expect(ciPassedProblem([run({ app: { slug: "someone-else" } })])).not.toBeNull();
        expect(ciPassedProblem([run({ status: "in_progress", conclusion: null })])).not.toBeNull();
    });
});

describe("tag against manifests", () => {
    it("matches the repository's own version and rejects another", () => {
        const version = JSON.parse(
            require("node:fs").readFileSync(path.join(root, "package.json"), "utf8"),
        ).version;
        expect(tagMismatches(root, `v${version}`)).toEqual([]);
        expect(tagMismatches(root, "v99.0.0").length).toBeGreaterThan(5);
    });
});

describe("registry output", () => {
    it("tells a missing tag from a failure", () => {
        expect(classifyInspect(0, "")).toBe("ok");
        expect(classifyInspect(1, "ghcr.io/x:y: not found")).toBe("absent");
        expect(classifyInspect(1, "manifest unknown")).toBe("absent");
        expect(classifyInspect(1, "dial tcp: i/o timeout")).toBe("error");
        expect(classifyInspect(null, "")).toBe("error");
    });

    it("reads the version label of a single image or an index", () => {
        const label = { config: { Labels: { "org.opencontainers.image.version": "0.1.0" } } };
        expect(labelVersion({ Image: label })).toBe("0.1.0");
        expect(labelVersion({ Image: { "linux/amd64": label } })).toBe("0.1.0");
        expect(labelVersion({ Image: { "linux/amd64": { config: {} } } })).toBeNull();
        expect(labelVersion({})).toBeNull();
    });

    it("pins every package to its tarball", () => {
        const manifest = consumerManifest({ "@a/b": "/t/b.tgz" });
        expect(manifest.dependencies).toEqual({ "@a/b": "file:/t/b.tgz" });
        expect(manifest.overrides).toEqual(manifest.dependencies);
    });
});
