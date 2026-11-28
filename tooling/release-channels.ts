// The release channel registry: the one source of truth for which version forms can be released,
// where each is published, and in what order they promote. A channel is a row of DATA; the rules
// below read the rows, so adding `alpha` or `beta` is one more row (see docs/releasing.md).
//
// Dependency-free on purpose: the credentialed release jobs import this module, so it imports
// nothing at all (asserted by tooling/release.spec.ts, which also keeps the guard step of
// .github/workflows/release.yaml, a shell script that cannot import it, in step with the rows).

export type Kind = "major" | "minor" | "patch";

export interface Channel {
    name: string;
    // Promotion order: alpha 1 < beta 2 < rc 3 < stable 4. Unique.
    rank: number;
    // The pre-release part of a version, `N` standing for the counter (no leading zeros); null for
    // stable, which has none. `-rc.N` means versions such as 1.2.3-rc.1.
    preRelease: string | null;
    // The release kinds that may use the channel, from the base version (see releaseKind).
    supports: Kind[];
    // The npm dist-tag a version of the channel is published under.
    npmTag: string;
    // Image tags the channel moves forward-only; `X.Y` stands for the version's major.minor.
    imageTags: string[];
    // What starts a release of the channel. Only `tag` is implemented; `schedule` is reserved for a
    // future nightly channel.
    trigger: "tag" | "schedule";
    // How its versions are numbered. Only `counter` (`<channel>.<N>`) is implemented; `snapshot` is
    // reserved for a future nightly channel.
    versionScheme: "counter" | "snapshot";
}

export const ALL_KINDS: Kind[] = ["major", "minor", "patch"];

export const CHANNELS: Channel[] = [
    {
        name: "stable",
        rank: 4,
        preRelease: null,
        supports: ALL_KINDS,
        npmTag: "latest",
        imageTags: ["X.Y", "latest"],
        trigger: "tag",
        versionScheme: "counter",
    },
    {
        name: "rc",
        rank: 3,
        preRelease: "-rc.N",
        supports: ALL_KINDS,
        npmTag: "next",
        imageTags: ["rc", "next"],
        trigger: "tag",
        versionScheme: "counter",
    },
];

export const COUNTER = "(?:0|[1-9][0-9]*)";

// Patch if Z > 0; minor if Z is 0 and Y > 0; major if the version is X.0.0.
export function releaseKind(version: string): Kind {
    const [, y, z] = version.split("-")[0]!.split(".");
    if (z !== "0") return "patch";
    return y !== "0" ? "minor" : "major";
}

// The expression a pre-release part must match, from a row's form: `-rc.N` gives /^rc\.COUNTER$/.
export function preReleasePattern(form: string): RegExp {
    const body = form
        .replace(/^-/, "")
        .replace(/N$/, "\u0000")
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^${body.replace("\u0000", COUNTER)}$`);
}

// The channel a version belongs to: stable without a pre-release part, else the row whose form the
// part matches. Null for an unregistered name, a bare name such as `rc`, or a leading-zero counter.
export function channelOf(version: string, channels: Channel[] = CHANNELS): Channel | null {
    const dash = version.indexOf("-");
    if (dash === -1) return channels.find((c) => c.preRelease === null) ?? null;
    const part = version.slice(dash + 1);
    return (
        channels.find((c) => c.preRelease !== null && preReleasePattern(c.preRelease).test(part)) ??
        null
    );
}

// Why a version may not be released at all, whatever else exists: an unregistered pre-release, or
// a channel that does not support the kind of release.
export function channelProblems(version: string, channels: Channel[] = CHANNELS): string[] {
    const channel = channelOf(version, channels);
    if (!channel) {
        const forms = channels
            .filter((c) => c.preRelease !== null)
            .map((c) => c.preRelease)
            .join(", ");
        return [`${version} is not stable or a registered pre-release (${forms})`];
    }
    const kind = releaseKind(version);
    if (!channel.supports.includes(kind)) {
        return [`the ${channel.name} channel does not support a ${kind} release (${version})`];
    }
    return [];
}

// No regression: for one X.Y.Z a lower-ranked channel cannot follow a higher-ranked one that exists
// (rc.1 exists, so beta.3 is refused), and nothing is released as a pre-release once the stable
// X.Y.Z exists. `tags` are the existing `v<version>` tags; the version itself is ignored, so a
// re-run of a release passes. Tags that belong to no registered channel are ignored.
export function regressionProblems(
    version: string,
    tags: string[],
    channels: Channel[] = CHANNELS,
): string[] {
    const channel = channelOf(version, channels);
    if (!channel) return [];
    const core = version.split("-")[0];
    const problems: string[] = [];
    for (const tag of tags) {
        if (!tag.startsWith("v")) continue;
        const other = tag.slice(1);
        if (other === version || other.split("-")[0] !== core) continue;
        const existing = channelOf(other, channels);
        if (existing && existing.rank > channel.rank) {
            problems.push(
                `${tag} (${existing.name}) exists, so ${version} (${channel.name}) would go backwards`,
            );
        }
    }
    return problems;
}

// The image tags a version moves, in registry order, with `X.Y` resolved.
export function imageTagsOf(version: string, channels: Channel[] = CHANNELS): string[] {
    const channel = channelOf(version, channels);
    if (!channel) return [];
    const xy = version.split("-")[0]!.split(".").slice(0, 2).join(".");
    return channel.imageTags.map((tag) => (tag === "X.Y" ? xy : tag));
}

// The registry as the Markdown table of docs/releasing.md; the spec compares the two.
export function channelsTable(channels: Channel[] = CHANNELS): string {
    const rows = channels
        .toSorted((a, b) => a.rank - b.rank)
        .map((c) =>
            [
                c.name,
                String(c.rank),
                c.preRelease === null ? "none" : `\`${c.preRelease}\``,
                c.supports.join(", "),
                `\`${c.npmTag}\``,
                c.imageTags.map((t) => `\`${t}\``).join(", "),
                c.trigger,
                c.versionScheme,
            ].join(" | "),
        );
    return [
        "| Channel | Rank | Pre-release form | Supports | npm tag | Image tags | Trigger | Scheme |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        ...rows.map((row) => `| ${row} |`),
    ].join("\n");
}

const RESERVED = ["latest", "retry", "next", "bootstrap"];
const NAME = /^[a-z]+$/;
// npm tags and image tags that read as a version or a range (`x`, `1.2`, `v1`) are refused.
const VERSION_LIKE = /^(x|v?\d)/i;

// What makes a registry valid; the spec requires none (so a tampered registry fails it) and the
// rules are written once here so a new row is checked the same way.
export function registryProblems(channels: Channel[] = CHANNELS): string[] {
    const problems: string[] = [];
    const stable = channels.filter((c) => c.preRelease === null);
    if (stable.length !== 1 || stable[0]!.name !== "stable") {
        problems.push(
            "there must be exactly one stable row, named stable, without a pre-release form",
        );
    }
    const unique = (values: (string | number)[], what: string) => {
        if (new Set(values).size !== values.length) problems.push(`${what} must be unique`);
    };
    unique(
        channels.map((c) => c.name),
        "channel names",
    );
    unique(
        channels.map((c) => c.rank),
        "ranks",
    );
    unique(
        channels.map((c) => c.npmTag),
        "npm tags",
    );
    for (const c of channels) {
        const at = `${c.name}:`;
        if (!NAME.test(c.name) || c.name === "x" || RESERVED.includes(c.name)) {
            problems.push(
                `${at} the name must be lowercase letters, not a range or a reserved tag`,
            );
        }
        if (!Number.isInteger(c.rank) || c.rank < 1)
            problems.push(`${at} the rank must be a positive integer`);
        if (c.preRelease === null) {
            if (ALL_KINDS.some((kind) => !c.supports.includes(kind))) {
                problems.push(`${at} stable must support major, minor and patch`);
            }
            if (c.npmTag !== "latest") problems.push(`${at} stable publishes under latest`);
        } else if (c.preRelease !== `-${c.name}.N`) {
            problems.push(`${at} the pre-release form must be -${c.name}.N`);
        }
        if (c.supports.length === 0 || c.supports.some((k) => !ALL_KINDS.includes(k))) {
            problems.push(`${at} supports must be a non-empty subset of major, minor and patch`);
        }
        if (new Set(c.supports).size !== c.supports.length)
            problems.push(`${at} supports has a duplicate`);
        if (
            !NAME.test(c.npmTag) ||
            VERSION_LIKE.test(c.npmTag) ||
            c.npmTag === "retry" ||
            c.npmTag === "bootstrap"
        ) {
            problems.push(
                `${at} the npm tag must be lowercase letters, not a range, retry or bootstrap`,
            );
        }
        if (c.npmTag === "latest" && c.preRelease !== null) {
            problems.push(`${at} only stable may publish under latest`);
        }
        if (c.imageTags.length === 0) problems.push(`${at} needs at least one image tag`);
        unique(c.imageTags, `${c.name} image tags`);
        for (const tag of c.imageTags) {
            const stableOnly = tag === "X.Y" || tag === "latest";
            if (stableOnly && c.preRelease !== null)
                problems.push(`${at} ${tag} belongs to stable`);
            if (
                !stableOnly &&
                (!/^[a-z][a-z0-9._-]{0,127}$/.test(tag) ||
                    tag.startsWith("sha-") ||
                    VERSION_LIKE.test(tag))
            ) {
                problems.push(`${at} "${tag}" is not a valid image tag`);
            }
        }
        if (c.trigger !== "tag")
            problems.push(`${at} the ${c.trigger} trigger is reserved, not implemented`);
        if (c.versionScheme !== "counter") {
            problems.push(
                `${at} the ${c.versionScheme} version scheme is reserved, not implemented`,
            );
        }
    }
    // Promotion order: by rank, stable last, and the pre-release names ascend, because SemVer
    // compares them as text (alpha < beta < rc), so a higher rank is also a higher version.
    const byRank = channels.toSorted((a, b) => a.rank - b.rank);
    if (stable[0] && byRank.at(-1) !== stable[0])
        problems.push("stable must have the highest rank");
    const names = byRank.filter((c) => c.preRelease !== null).map((c) => c.name);
    if (names.some((name, i) => i > 0 && !(names[i - 1]! < name))) {
        problems.push("ranks must follow the SemVer order of the names (alpha < beta < rc)");
    }
    return problems;
}
