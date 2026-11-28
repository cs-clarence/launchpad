import { describe, expect, it } from "bun:test";
import {
    abandonedFormatProblems,
    abandonedProblems,
    ABANDONED_FILE,
    readAbandoned,
    checkPackageSet,
    checkTag,
    checkTarballSet,
    existingVersion,
    sumsFiles,
    ciPassedProblem,
    classifyInspect,
    consumerManifest,
    exactTagAction,
    floatingTags,
    IMAGES,
    labelVersion,
    npmDistTag,
    npmPublishAction,
    parseInspect,
    partialReleaseProblems,
    previousStable,
    type PreviousRelease,
    tagMismatches,
} from "./release-plan";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
        stableVersions: [],
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

    // A release is complete when the tags it should hold resolve to its staged digest.
    const other = "sha256:" + "d".repeat(64);

    it("does not require latest for a backport made after a newer minor", () => {
        const release = complete();
        release.version = "1.1.5";
        release.stableVersions = ["1.1.4", "1.2.0"];
        release.images.worker!.latest = other;
        expect(partialReleaseProblems(release)).toEqual([]);
        release.images.worker!.xy = other;
        expect(partialReleaseProblems(release)).toEqual([expect.stringContaining("worker:1.1")]);
    });

    it("does not require X.Y or latest on a retry after a newer patch", () => {
        const release = complete();
        release.version = "1.2.2";
        release.stableVersions = ["1.2.1", "1.2.4", "1.1.9"];
        release.images.worker!.latest = other;
        release.images.worker!.xy = other;
        expect(partialReleaseProblems(release)).toEqual([]);
        release.images.worker!.exact = other;
        expect(partialReleaseProblems(release)).toEqual([expect.stringContaining("worker:1.2.2")]);
    });

    it("requires X.Y and latest when no stable release is higher", () => {
        const release = complete();
        release.version = "1.2.3";
        release.stableVersions = ["1.2.2", "1.1.9"];
        release.images.worker!.latest = other;
        expect(partialReleaseProblems(release)).toEqual([expect.stringContaining("worker:latest")]);
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
    it("reads only the registry's not-found signals as absent", () => {
        expect(classifyInspect(0, "")).toBe("ok");
        for (const stderr of [
            "ERROR: ghcr.io/launchpad-kit/launchpad-worker:1.2.3: not found",
            "ghcr.io/launchpad-kit/launchpad-worker:sha-abc: not found\n",
            "ERROR: failed to resolve: ghcr.io/x/y:1.2: not found",
            "manifest unknown",
            "MANIFEST_UNKNOWN: manifest unknown",
            "NAME_UNKNOWN: repository name not known to registry",
        ]) {
            expect(classifyInspect(1, stderr), stderr).toBe("absent");
        }
    });

    it("reads every other failure as an error", () => {
        for (const stderr of [
            "ERROR: ghcr.io/launchpad-kit/launchpad-worker:sha-a404b: dial tcp: i/o timeout",
            "ERROR: ghcr.io/x/y:404: unauthorized",
            'error getting credentials - err: exec: "docker-credential-x": executable file not found in $PATH',
            "dial tcp: lookup ghcr.io on 127.0.0.53:53: no such host",
            "net/http: request canceled (Client.Timeout exceeded)",
            "denied: permission_denied",
            "Error 404 from the proxy",
            "",
        ]) {
            expect(classifyInspect(1, stderr), stderr).toBe("error");
        }
        expect(classifyInspect(null, "manifest unknown")).toBe("absent");
        expect(classifyInspect(null, "")).toBe("error");
    });

    it("requires exactly the five packages", () => {
        const five = ["contracts", "sdk", "client-core", "cli", "mcp"].map(
            (n) => `@launchpad-kit/${n}`,
        );
        expect(checkPackageSet(five)).toEqual([]);
        expect(checkPackageSet(five.slice(1))).toEqual(["no tarball for @launchpad-kit/contracts"]);
        expect(checkPackageSet([...five, "@launchpad-kit/extra"])).toEqual([
            "unexpected package @launchpad-kit/extra",
        ]);
        expect(checkPackageSet([...five, five[0]!])).toEqual([
            "2 tarballs for @launchpad-kit/contracts",
        ]);
    });

    it("reads the version label of a single image or an index", () => {
        const label = { config: { Labels: { "org.opencontainers.image.version": "0.1.0" } } };
        expect(labelVersion({ Image: label })).toBe("0.1.0");
        expect(labelVersion({ Image: { "linux/amd64": label } })).toBe("0.1.0");
        expect(labelVersion({ Image: { "linux/amd64": { config: {} } } })).toBeNull();
        expect(labelVersion({})).toBeNull();
    });

    it("reads the label from other plausible shapes", () => {
        const labelled = (v: string) => ({
            config: { Labels: { "org.opencontainers.image.version": v } },
        });
        expect(
            labelVersion({
                Image: { "unknown/unknown": { config: {} }, "linux/arm64": labelled("1.0.0") },
            }),
        ).toBe("1.0.0");
        expect(labelVersion({ Image: { config: { Labels: null } } })).toBeNull();
        expect(labelVersion({ Image: { config: { Labels: {} } } })).toBeNull();
        expect(labelVersion({ Image: labelled("") })).toBeNull();
        expect(labelVersion({ Image: {} })).toBeNull();
        expect(labelVersion({ Image: null })).toBeNull();
    });

    it("fails closed when a tag exists but its version is unreadable", () => {
        expect(existingVersion(null, "r")).toBeNull();
        expect(existingVersion({ version: "1.2.3" }, "r")).toBe("1.2.3");
        expect(() => existingVersion({ version: null }, "r")).toThrow(/no readable/);
        expect(() => existingVersion({ version: "unknown" }, "r")).toThrow(/no readable/);
        expect(() => existingVersion({ version: "v1.2.3" }, "r")).toThrow(/no readable/);
    });

    it("compares the tarballs with SHA256SUMS", () => {
        const sums = `${"a".repeat(64)}  a.tgz\n${"b".repeat(64)}  b.tgz\n`;
        expect(sumsFiles(sums)).toEqual(["a.tgz", "b.tgz"]);
        expect(() => sumsFiles("nonsense")).toThrow();
        expect(checkTarballSet(["a.tgz", "b.tgz"], ["b.tgz", "a.tgz"])).toEqual([]);
        expect(checkTarballSet(["a.tgz"], ["a.tgz", "x.tgz"])).toEqual([
            expect.stringContaining("x.tgz"),
        ]);
        expect(checkTarballSet(["a.tgz", "b.tgz"], ["a.tgz"])).toEqual([
            expect.stringContaining("b.tgz"),
        ]);
    });

    it("pins every package to its tarball", () => {
        const manifest = consumerManifest({ "@a/b": "/t/b.tgz" });
        expect(manifest.dependencies).toEqual({ "@a/b": "file:/t/b.tgz" });
        expect(manifest.overrides).toEqual(manifest.dependencies);
    });
});

// Shaped like buildx v0.39.1's `imagetools inspect --format '{{json .}}'` (util/imagetools/printers.go):
// lowercase `name`, `manifest` and `image`; the index is printed with a `digest` of its own, and
// attestation manifests are index entries, not platforms, so a single-platform image has one `image`.
describe("buildx inspect output", () => {
    const digest = (c: string) => `sha256:${c.repeat(64)}`;
    const image = (version?: string) => ({
        created: "2026-11-28T10:00:00Z",
        architecture: "amd64",
        os: "linux",
        config: {
            User: "10001",
            Env: ["PATH=/usr/bin"],
            ...(version ? { Labels: { "org.opencontainers.image.version": version } } : {}),
        },
        rootfs: { type: "layers", diff_ids: [digest("1")] },
    });
    const index = {
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.index.v1+json",
        digest: digest("a"),
        size: 856,
        manifests: [
            {
                mediaType: "application/vnd.oci.image.manifest.v1+json",
                digest: digest("b"),
                size: 1234,
                platform: { architecture: "amd64", os: "linux" },
            },
            {
                mediaType: "application/vnd.oci.image.manifest.v1+json",
                digest: digest("c"),
                size: 567,
                annotations: {
                    "vnd.docker.reference.digest": digest("b"),
                    "vnd.docker.reference.type": "attestation-manifest",
                },
                platform: { architecture: "unknown", os: "unknown" },
            },
        ],
    };

    it("reads an index with attestation manifests and one platform", () => {
        const text = JSON.stringify(
            { name: "ghcr.io/x/y:sha-1", manifest: index, image: image("0.1.0") },
            null,
            2,
        );
        expect(parseInspect(text)).toEqual({ digest: digest("a"), version: "0.1.0" });
    });

    it("reads a single manifest", () => {
        const manifest = {
            mediaType: "application/vnd.oci.image.manifest.v1+json",
            digest: digest("d"),
            size: 700,
        };
        expect(
            parseInspect(JSON.stringify({ name: "n", manifest, image: image("1.2.3") })),
        ).toEqual({
            digest: digest("d"),
            version: "1.2.3",
        });
    });

    it("reads an index of several platforms, one image per platform", () => {
        const text = JSON.stringify({
            name: "n",
            manifest: index,
            image: { "linux/amd64": image("0.1.0"), "linux/arm64": image("0.1.0") },
        });
        expect(parseInspect(text).version).toBe("0.1.0");
        const disagree = JSON.stringify({
            manifest: index,
            image: { "linux/amd64": image("0.1.0"), "linux/arm64": image("0.2.0") },
        });
        expect(parseInspect(disagree).version).toBeNull();
    });

    it("gives no version for an image without the label, and accepts capitalised keys", () => {
        expect(
            parseInspect(JSON.stringify({ manifest: index, image: image() })).version,
        ).toBeNull();
        expect(parseInspect(JSON.stringify({ manifest: index })).version).toBeNull();
        expect(parseInspect(JSON.stringify({ Manifest: index, Image: image("2.0.0") }))).toEqual({
            digest: digest("a"),
            version: "2.0.0",
        });
    });

    it("refuses output without a manifest digest", () => {
        for (const text of [
            "{}",
            JSON.stringify({ manifest: {} }),
            JSON.stringify({ manifest: { digest: "x" } }),
        ]) {
            expect(() => parseInspect(text), text).toThrow(/no manifest digest/);
        }
        expect(() => parseInspect("not json")).toThrow();
    });
});

describe("abandoned releases", () => {
    const tags = ["v0.1.0", "v0.1.1", "v0.1.2", "v0.2.0-rc.1", "v0.2.0"];
    const entry = (version: string, reason = "stopped before the images") => ({ version, reason });

    it("are skipped when choosing the previous stable release, walking down", () => {
        expect(previousStable(tags, "0.3.0")).toBe("0.2.0");
        expect(previousStable(tags, "0.3.0", ["0.2.0"])).toBe("0.1.2");
        expect(previousStable(tags, "0.3.0", ["0.2.0", "0.1.2"])).toBe("0.1.1");
        expect(previousStable(tags, "0.3.0", ["0.2.0", "0.1.2", "0.1.1", "0.1.0"])).toBeNull();
        expect(previousStable(tags, "0.3.0", [])).toBe("0.2.0");
    });

    it("accept an empty list and valid entries", () => {
        expect(abandonedProblems([], tags, "0.3.0")).toEqual([]);
        expect(abandonedProblems([entry("0.2.0"), entry("0.1.1")], tags, "0.3.0")).toEqual([]);
    });

    it("reject a bad shape", () => {
        for (const bad of [
            {},
            "0.1.0",
            [null],
            [["0.1.0"]],
            [{ version: "0.1.0" }],
            [{ version: "0.1.0", reason: " " }],
            [{ reason: "x" }],
            [entry("v0.1.0")],
            [entry("0.1.0-rc.1")],
            [entry("01.1.0")],
            [entry("0.1.0+build")],
            [entry("0.1.0"), entry("0.1.0")],
        ]) {
            expect(abandonedFormatProblems(bad), JSON.stringify(bad)).not.toEqual([]);
        }
    });

    it("reject a version with no tag, or the version being released", () => {
        expect(abandonedProblems([entry("0.0.9")], tags, "0.3.0")).toEqual([
            expect.stringContaining("no v0.0.9 tag"),
        ]);
        expect(abandonedProblems([entry("0.2.0")], tags, "0.2.0")).toEqual([
            expect.stringContaining("cannot also be abandoned"),
        ]);
        expect(abandonedProblems([entry("0.2.0"), entry("0.1.1")], tags, "0.1.1")).toEqual([
            expect.stringContaining("cannot also be abandoned"),
        ]);
    });

    it("accept a higher abandoned version, so a backport still releases", () => {
        const all = ["v1.1.4", "v1.1.5", "v1.2.0"];
        // 1.2.0 is abandoned; 1.1.5 is a backport released after it.
        expect(abandonedProblems([entry("1.2.0")], all, "1.1.5")).toEqual([]);
        expect(previousStable(all, "1.1.5", ["1.2.0"])).toBe("1.1.4");
        // 1.3.0 after the abandoned 1.2.0 walks down to 1.1.x.
        const withNew = [...all, "v1.3.0"];
        expect(abandonedProblems([entry("1.2.0")], withNew, "1.3.0")).toEqual([]);
        expect(previousStable(withNew, "1.3.0", ["1.2.0"])).toBe("1.1.5");
    });

    it("are read from a file that is validated against the tags", () => {
        const dir = mkdtempSync(path.join(tmpdir(), "abandoned-"));
        const write = (text: string) => {
            const file = path.join(dir, "abandoned.json");
            writeFileSync(file, text);
            return file;
        };
        expect(readAbandoned(tags, "0.3.0", write("[]"))).toEqual([]);
        expect(readAbandoned(tags, "0.3.0", write(JSON.stringify([entry("0.1.1")])))).toEqual([
            "0.1.1",
        ]);
        expect(() => readAbandoned(tags, "0.3.0", write("{"))).toThrow();
        expect(() =>
            readAbandoned([...tags, "v0.3.0"], "0.3.0", write(JSON.stringify([entry("0.3.0")]))),
        ).toThrow(/cannot also be abandoned/);
        expect(() => readAbandoned(tags, "0.3.0", write(JSON.stringify([entry("9.0.0")])))).toThrow(
            /no v9.0.0 tag/,
        );
        // A higher abandoned version is fine: a backport releases while 0.2.0 is abandoned.
        expect(readAbandoned(tags, "0.1.2", write(JSON.stringify([entry("0.2.0")])))).toEqual([
            "0.2.0",
        ]);
    });

    it("has a committed file of the right shape", () => {
        const entries = JSON.parse(readFileSync(path.join(root, ABANDONED_FILE), "utf8"));
        expect(abandonedFormatProblems(entries)).toEqual([]);
    });
});
