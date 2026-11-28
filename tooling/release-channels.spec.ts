import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
    type Channel,
    CHANNELS,
    channelOf,
    channelProblems,
    channelsTable,
    imageTagsOf,
    registryProblems,
    regressionProblems,
    releaseKind,
} from "./release-channels";
import { checkTag } from "./release-core";
import { compareSemver } from "./semver-compare";

const root = path.resolve(import.meta.dirname, "..");
const rc = CHANNELS.find((c) => c.name === "rc")!;
const stable = CHANNELS.find((c) => c.name === "stable")!;

// The example rows of docs/releasing.md: not registered, used here to prove a row is all it takes.
const alpha: Channel = {
    name: "alpha",
    rank: 1,
    preRelease: "-alpha.N",
    supports: ["major", "minor"],
    npmTag: "alpha",
    imageTags: ["alpha", "next"],
    trigger: "tag",
    versionScheme: "counter",
};
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
const fake = [alpha, beta, rc, stable];

describe("the channel registry", () => {
    it("is valid", () => {
        expect(registryProblems()).toEqual([]);
        expect(registryProblems(fake)).toEqual([]);
    });

    it("has the rows the maintainer decided", () => {
        expect(CHANNELS.map((c) => [c.name, c.rank, c.preRelease, c.npmTag, c.imageTags])).toEqual([
            ["stable", 4, null, "latest", ["X.Y", "latest"]],
            ["rc", 3, "-rc.N", "next", ["rc", "next"]],
        ]);
        for (const c of CHANNELS) {
            expect(c.supports).toEqual(["major", "minor", "patch"]);
            expect([c.trigger, c.versionScheme]).toEqual(["tag", "counter"]);
        }
    });

    it("rejects a tampered registry", () => {
        const bad = (change: (rows: Channel[]) => Channel[]) =>
            registryProblems(change(structuredClone(fake)));
        const cases: Record<string, (rows: Channel[]) => Channel[]> = {
            "an upper-case name": (r) => [...r, { ...beta, name: "Gamma", rank: 9 }],
            "a name that is a range": (r) => [
                { ...alpha, name: "x", preRelease: "-x.N" },
                ...r.slice(1),
            ],
            "a reserved name": (r) => [
                { ...alpha, name: "next", preRelease: "-next.N" },
                ...r.slice(1),
            ],
            "a duplicate name": (r) => [...r, { ...rc, rank: 9 }],
            "a duplicate rank": (r) => r.map((c) => (c.name === "beta" ? { ...c, rank: 1 } : c)),
            "ranks against the name order": (r) =>
                r
                    .map((c) => (c.name === "alpha" ? { ...c, rank: 2.5 } : c))
                    .map((c) => (c.name === "beta" ? { ...c, rank: 1 } : c)),
            "stable not the highest": (r) =>
                r.map((c) => (c.name === "stable" ? { ...c, rank: 0 } : c)),
            "stable with a pre-release form": (r) =>
                r.map((c) => (c.name === "stable" ? { ...c, preRelease: "-s.N" } : c)),
            "stable not supporting patch": (r) =>
                r.map((c) => (c.name === "stable" ? { ...c, supports: ["major", "minor"] } : c)),
            "empty supports": (r) => r.map((c) => (c.name === "rc" ? { ...c, supports: [] } : c)),
            "an unknown kind": (r) =>
                r.map((c) => (c.name === "rc" ? { ...c, supports: ["huge" as never] } : c)),
            "a form that does not match the name": (r) =>
                r.map((c) => (c.name === "rc" ? { ...c, preRelease: "-pre.N" } : c)),
            "a pre-release under latest": (r) =>
                r.map((c) => (c.name === "rc" ? { ...c, npmTag: "latest" } : c)),
            "the retry npm tag": (r) =>
                r.map((c) => (c.name === "rc" ? { ...c, npmTag: "retry" } : c)),
            "the bootstrap npm tag": (r) =>
                r.map((c) => (c.name === "rc" ? { ...c, npmTag: "bootstrap" } : c)),
            "a version-like npm tag": (r) =>
                r.map((c) => (c.name === "rc" ? { ...c, npmTag: "v1" } : c)),
            "a shared npm tag": (r) =>
                r.map((c) => (c.name === "beta" ? { ...c, npmTag: "alpha" } : c)),
            "latest as a pre-release image tag": (r) =>
                r.map((c) => (c.name === "rc" ? { ...c, imageTags: ["latest"] } : c)),
            "an invalid image tag": (r) =>
                r.map((c) => (c.name === "rc" ? { ...c, imageTags: ["Bad Tag"] } : c)),
            "no image tags": (r) => r.map((c) => (c.name === "rc" ? { ...c, imageTags: [] } : c)),
            "a nightly trigger": (r) =>
                r.map((c) => (c.name === "rc" ? { ...c, trigger: "schedule" as const } : c)),
            "a snapshot scheme": (r) =>
                r.map((c) => (c.name === "rc" ? { ...c, versionScheme: "snapshot" as const } : c)),
            "a second stable row": (r) => [...r, { ...stable, name: "final", rank: 5 }],
        };
        for (const [what, change] of Object.entries(cases)) {
            expect(bad(change), what).not.toEqual([]);
        }
    });

    it("has precedence that follows the ranks", () => {
        const ordered = fake.toSorted((a, b) => a.rank - b.rank);
        for (let i = 1; i < ordered.length; i++) {
            const version = (c: Channel) => (c.preRelease === null ? "1.0.0" : `1.0.0-${c.name}.1`);
            expect(compareSemver(version(ordered[i - 1]!), version(ordered[i]!))).toBeLessThan(0);
        }
    });
});

describe("release kind", () => {
    it("is patch for Z > 0, minor for X.Y.0, major for X.0.0, with no special 0.x case", () => {
        for (const [version, kind] of [
            ["1.2.3", "patch"],
            ["0.1.1", "patch"],
            ["0.0.1", "patch"],
            ["1.2.0", "minor"],
            ["0.1.0", "minor"],
            ["1.0.0", "major"],
            ["0.0.0", "major"],
            ["2.0.0-rc.1", "major"],
            ["0.2.0-rc.3", "minor"],
            ["0.2.1-rc.1", "patch"],
        ] as const) {
            expect(releaseKind(version), version).toBe(kind);
        }
    });
});

describe("channel membership", () => {
    it("reads stable and <channel>.<N> only", () => {
        expect(channelOf("1.2.3")?.name).toBe("stable");
        expect(channelOf("1.2.3-rc.1")?.name).toBe("rc");
        expect(channelOf("1.2.3-rc.0")?.name).toBe("rc");
        for (const v of [
            "1.2.3-rc",
            "1.2.3-rc.01",
            "1.2.3-rc.1.1",
            "1.2.3-rc-1",
            "1.2.3-foo.1",
            "1.2.3-RC.1",
            "1.2.3-rc.a",
            "1.2.3-.1",
        ]) {
            expect(channelOf(v), v).toBeNull();
            expect(channelProblems(v), v).not.toEqual([]);
        }
    });

    it("refuses a kind the channel does not support (a fake registry with beta)", () => {
        expect(channelProblems("0.2.1-beta.1", fake)).toEqual([
            expect.stringContaining("does not support a patch release"),
        ]);
        expect(channelProblems("0.2.0-beta.1", fake)).toEqual([]);
        expect(channelProblems("1.0.0-alpha.2", fake)).toEqual([]);
        expect(channelProblems("1.2.3-alpha.1", fake)).not.toEqual([]);
        expect(checkTag("v0.2.1-beta.1", fake)).not.toEqual([]);
        expect(checkTag("v0.2.0-beta.1", fake)).toEqual([]);
        // Only rc is registered today.
        expect(checkTag("v0.2.0-beta.1")).not.toEqual([]);
    });
});

describe("no regression across channels", () => {
    it("refuses a lower channel after a higher one for the same X.Y.Z", () => {
        expect(regressionProblems("1.2.0-beta.3", ["v1.2.0-rc.1"], fake)).toEqual([
            expect.stringContaining("would go backwards"),
        ]);
        expect(regressionProblems("1.2.0-alpha.1", ["v1.2.0-beta.1"], fake)).not.toEqual([]);
    });

    it("refuses any pre-release once the stable X.Y.Z exists", () => {
        expect(regressionProblems("1.2.0-rc.2", ["v1.2.0", "v1.2.0-rc.1"])).not.toEqual([]);
        expect(regressionProblems("1.2.0-beta.1", ["v1.2.0"], fake)).not.toEqual([]);
    });

    it("allows the same or a higher channel, and other versions", () => {
        expect(regressionProblems("1.2.0-rc.2", ["v1.2.0-rc.1"])).toEqual([]);
        expect(regressionProblems("1.2.0-rc.1", ["v1.2.0-rc.2"])).toEqual([]);
        expect(regressionProblems("1.2.0", ["v1.2.0-rc.1", "v1.2.0-beta.1"], fake)).toEqual([]);
        expect(regressionProblems("1.2.0-rc.1", ["v1.2.0-beta.1"], fake)).toEqual([]);
        expect(regressionProblems("1.2.0-rc.1", ["v1.3.0", "v1.1.0", "v2.0.0-rc.1"])).toEqual([]);
    });

    it("ignores the version itself (a re-run), other tags and unregistered channels", () => {
        expect(regressionProblems("1.2.0", ["v1.2.0"])).toEqual([]);
        expect(regressionProblems("1.2.0-rc.1", ["v1.2.0-rc.1"])).toEqual([]);
        expect(
            regressionProblems("1.2.0-rc.1", ["core-v1.2.0", "1.2.0", "v1.2.0-foo.1", ""]),
        ).toEqual([]);
        expect(regressionProblems("1.2.0-foo.1", ["v1.2.0"])).toEqual([]);
    });
});

describe("image tags of a version", () => {
    it("resolves X.Y for stable and gives rc its own tags", () => {
        expect(imageTagsOf("1.2.3")).toEqual(["1.2", "latest"]);
        expect(imageTagsOf("1.2.3-rc.1")).toEqual(["rc", "next"]);
        expect(imageTagsOf("1.0.0-alpha.1", fake)).toEqual(["alpha", "next"]);
        expect(imageTagsOf("1.2.3-foo.1")).toEqual([]);
    });
});

describe("docs/releasing.md", () => {
    it("holds the channels table generated from the registry", () => {
        const text = readFileSync(path.join(root, "docs/releasing.md"), "utf8");
        const block = /<!-- channels:start -->\s*([\s\S]*?)\s*<!-- channels:end -->/.exec(
            text,
        )?.[1];
        expect(block, "the channels table markers").toBeDefined();
        // The formatter pads the cells; only the content counts.
        const plain = (table: string) =>
            table
                .split("\n")
                .map((line) => line.replace(/-{3,}/g, "---").replace(/\s+/g, " ").trim());
        expect(plain(block!)).toEqual(plain(channelsTable()));
    });
});
