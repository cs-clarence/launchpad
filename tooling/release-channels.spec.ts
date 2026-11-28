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
    listingProblems,
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

    // Each case changes one thing of a valid registry and must produce the named problem, so
    // deleting any single rule from registryProblems fails exactly the case that covers it.
    const row = (rows: Channel[], name: string, change: Partial<Channel>) =>
        rows.map((c) => (c.name === name ? { ...c, ...change } : c));
    const cases: [string, (rows: Channel[]) => Channel[], string][] = [
        [
            "an upper-case name",
            (r) => row(r, "rc", { name: "Rc", preRelease: "-Rc.N" }),
            "the name must be lowercase letters",
        ],
        [
            "a name with a digit",
            (r) => row(r, "rc", { name: "rc2", preRelease: "-rc2.N" }),
            "the name must be lowercase letters",
        ],
        [
            "a name that is a range",
            (r) => row(r, "rc", { name: "x", preRelease: "-x.N" }),
            "not a range or a reserved tag",
        ],
        [
            "the reserved name next",
            (r) => row(r, "rc", { name: "next", preRelease: "-next.N" }),
            "next: the name must be",
        ],
        [
            "the reserved name latest",
            (r) => row(r, "rc", { name: "latest", preRelease: "-latest.N" }),
            "latest: the name must be",
        ],
        [
            "the reserved name bootstrap",
            (r) => row(r, "rc", { name: "bootstrap", preRelease: "-bootstrap.N" }),
            "bootstrap: the name must be",
        ],
        [
            "the reserved name retry",
            (r) => row(r, "rc", { name: "retry", preRelease: "-retry.N" }),
            "retry: the name must be",
        ],
        ["a duplicate name", (r) => [...r, { ...rc, rank: 9 }], "channel names must be unique"],
        ["a duplicate rank", (r) => row(r, "beta", { rank: 1 }), "ranks must be unique"],
        [
            "a non-integer rank",
            (r) => row(r, "rc", { rank: 3.5 }),
            "the rank must be a positive integer",
        ],
        ["a zero rank", (r) => row(r, "alpha", { rank: 0 }), "the rank must be a positive integer"],
        [
            "stable that is not the highest rank",
            (r) => row(r, "rc", { rank: 5 }),
            "stable must have the highest rank",
        ],
        [
            "ranks against the name order",
            (r) => row(row(r, "beta", { rank: 3 }), "rc", { rank: 2 }),
            "ranks must follow the SemVer order",
        ],
        [
            "a stable row with a pre-release form",
            (r) => row(r, "stable", { preRelease: "-s.N" }),
            "exactly one stable row",
        ],
        [
            "a second stable row",
            (r) => [...r, { ...stable, name: "final", rank: 5, npmTag: "final" }],
            "exactly one stable row",
        ],
        [
            "stable not supporting patch",
            (r) => row(r, "stable", { supports: ["major", "minor"] }),
            "stable must support major, minor and patch",
        ],
        [
            "stable under another npm tag",
            (r) => row(r, "stable", { npmTag: "stable" }),
            "stable publishes under latest",
        ],
        [
            "empty supports",
            (r) => row(r, "rc", { supports: [] }),
            "supports must be a non-empty subset",
        ],
        [
            "an unknown kind",
            (r) => row(r, "rc", { supports: ["huge" as never] }),
            "supports must be a non-empty subset",
        ],
        [
            "a duplicate kind",
            (r) => row(r, "rc", { supports: ["major", "major"] }),
            "supports has a duplicate",
        ],
        [
            "a form that does not match the name",
            (r) => row(r, "rc", { preRelease: "-pre.N" }),
            "the pre-release form must be -rc.N",
        ],
        [
            "a pre-release under latest",
            (r) => row(r, "rc", { npmTag: "latest" }),
            "only stable may publish under latest",
        ],
        [
            "the retry npm tag",
            (r) => row(r, "rc", { npmTag: "retry" }),
            "not a range, retry or bootstrap",
        ],
        [
            "the bootstrap npm tag",
            (r) => row(r, "rc", { npmTag: "bootstrap" }),
            "not a range, retry or bootstrap",
        ],
        [
            "a version-like npm tag",
            (r) => row(r, "rc", { npmTag: "v1" }),
            "not a range, retry or bootstrap",
        ],
        [
            "the range npm tag x",
            (r) => row(r, "rc", { npmTag: "x" }),
            "not a range, retry or bootstrap",
        ],
        [
            "an upper-case npm tag",
            (r) => row(r, "rc", { npmTag: "Next" }),
            "not a range, retry or bootstrap",
        ],
        ["a shared npm tag", (r) => row(r, "beta", { npmTag: "alpha" }), "npm tags must be unique"],
        ["no image tags", (r) => row(r, "rc", { imageTags: [] }), "needs at least one image tag"],
        [
            "a duplicate image tag",
            (r) => row(r, "rc", { imageTags: ["rc", "rc"] }),
            "rc image tags must be unique",
        ],
        [
            "latest as a pre-release image tag",
            (r) => row(r, "rc", { imageTags: ["latest"] }),
            "latest belongs to stable",
        ],
        [
            "X.Y as a pre-release image tag",
            (r) => row(r, "rc", { imageTags: ["X.Y"] }),
            "X.Y belongs to stable",
        ],
        [
            "an invalid image tag",
            (r) => row(r, "rc", { imageTags: ["Bad Tag"] }),
            '"Bad Tag" is not a valid image tag',
        ],
        [
            "an image tag of a staged build",
            (r) => row(r, "rc", { imageTags: ["sha-abc"] }),
            '"sha-abc" is not a valid image tag',
        ],
        [
            "a version-like image tag",
            (r) => row(r, "rc", { imageTags: ["v1"] }),
            '"v1" is not a valid image tag',
        ],
        [
            "a nightly trigger",
            (r) => row(r, "rc", { trigger: "schedule" }),
            "the schedule trigger is reserved",
        ],
        [
            "a snapshot scheme",
            (r) => row(r, "rc", { versionScheme: "snapshot" }),
            "the snapshot version scheme is reserved",
        ],
    ];

    it.each(cases)("rejects %s", (_what, change, expected) => {
        expect(registryProblems(change(structuredClone(fake))).join("\n")).toContain(expected);
    });

    it("accepts the unchanged registry, so each case above is its own change", () => {
        expect(registryProblems(structuredClone(fake))).toEqual([]);
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

describe("the tag listing", () => {
    it("must hold the tag being released, so an empty or shallow fetch fails closed", () => {
        expect(listingProblems("1.2.0", ["v1.2.0", "v1.1.0"])).toEqual([]);
        expect(listingProblems("1.2.0", [])).toEqual([expect.stringContaining("v1.2.0")]);
        expect(listingProblems("1.2.0", ["v1.1.0"])).not.toEqual([]);
        expect(listingProblems("1.2.0-rc.1", ["v1.2.0"])).not.toEqual([]);
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
