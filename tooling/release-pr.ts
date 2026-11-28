// The decisions of the release-PR workflow (.github/workflows/release-pr.yaml), kept out of YAML so
// they are unit tested: validating the dispatch inputs, choosing the version (the pre-release
// counter is computed here, never typed), the changelog range and the PR body. The workflow runs
// `plan` and `body`; nothing here pushes, tags, publishes or talks to GitHub.
//
//   bun tooling/release-pr.ts plan --base <X.Y.Z> --channel <name>   (prints key=value lines)
//   bun tooling/release-pr.ts body --version <v> --changelog <file> --out <file>
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Command, CommanderError } from "@commander-js/extra-typings";
import {
    CHANNELS,
    type Channel,
    channelOf,
    channelProblems,
    preReleasePattern,
    regressionProblems,
} from "./release-channels";
import { checkTag, isStable, previousStable, TAG_PATTERN } from "./release-core";
import { compareSemver } from "./semver-compare";
import { SOURCE_VERSIONS } from "./versions";

const root = path.resolve(import.meta.dirname, "..");

export const BASE_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

// The channel names a dispatch may choose: every registered channel (stable included). The
// workflow's static `options` list is asserted to equal this.
export const channelNames = (channels: Channel[] = CHANNELS) => channels.map((c) => c.name);

// The highest counter of `v<base>-<channel>.N` tags plus one, or 1. Counters have no length limit
// in SemVer, so they are compared as BigInt, not as numbers that lose precision.
export function nextCounter(base: string, channel: Channel, tags: string[]): bigint {
    if (channel.preRelease === null) throw new Error("stable has no counter");
    const pattern = preReleasePattern(channel.preRelease);
    let highest = 0n;
    for (const tag of tags) {
        if (!tag.startsWith(`v${base}-`)) continue;
        const part = tag.slice(`v${base}-`.length);
        if (!pattern.test(part)) continue;
        const counter = BigInt(part.slice(part.lastIndexOf(".") + 1));
        if (counter > highest) highest = counter;
    }
    return highest + 1n;
}

// The changelog range. A stable release covers everything since the last stable tag (the
// pre-releases in between included); a pre-release covers everything since the previous tag of any
// kind. With nothing earlier the range starts at the root. Ranges end at the new tag, which cog has
// created locally by the time the changelog is generated.
export function changelogRange(version: string, tags: string[]): string {
    const valid = tags.filter((tag) => TAG_PATTERN.test(tag)).map((tag) => tag.slice(1));
    const previous = isStable(version)
        ? previousStable(tags, version)
        : (valid
              .filter((v) => compareSemver(v, version) < 0)
              .toSorted(compareSemver)
              .at(-1) ?? null);
    return `${previous ? `v${previous}` : ""}..v${version}`;
}

export interface Plan {
    version: string;
    channel: string;
    range: string;
}

// Validates the inputs and decides the version, or throws every reason it cannot.
export function planRelease(
    base: string,
    channelName: string,
    tags: string[],
    channels: Channel[] = CHANNELS,
): Plan {
    if (!BASE_PATTERN.test(base)) throw new Error(`${JSON.stringify(base)} is not X.Y.Z`);
    const channel = channels.find((c) => c.name === channelName);
    if (!channel) throw new Error(`${JSON.stringify(channelName)} is not a registered channel`);
    const version =
        channel.preRelease === null
            ? base
            : `${base}-${channel.name}.${nextCounter(base, channel, tags)}`;
    const problems = [
        ...checkTag(`v${version}`, channels),
        ...channelProblems(version, channels),
        ...regressionProblems(version, tags, channels),
    ];
    if (tags.includes(`v${version}`)) problems.push(`v${version} already exists`);
    if (problems.length > 0) throw new Error([...new Set(problems)].join("\n"));
    return { version, channel: channel.name, range: changelogRange(version, tags) };
}

// GitHub refuses a PR body of more than 65536 characters; the changelog of a first release can be
// long, so it is cut, with a note, well below that.
export const BODY_LIMIT = 60000;

// The PR description: what the PR is, what merging does not do, and the changelog.
export function prBody(version: string, channel: string, changelog: string): string {
    const log =
        changelog.length > BODY_LIMIT
            ? `${changelog.slice(0, BODY_LIMIT)}\n\n(The changelog is cut here; see CHANGELOG.md in this PR.)`
            : changelog;
    return [
        `Release **v${version}** (${channel} channel), opened by the release PR workflow.`,
        "",
        "Merging this pull request does **not** publish anything. After it is merged and `CI Passed` is",
        `green on the merge commit, the maintainer creates and pushes the single tag \`v${version}\` on that`,
        "commit by hand (docs/releasing.md), which starts the release workflow.",
        "",
        "## Changelog",
        "",
        log.trim(),
        "",
    ].join("\n");
}

// What the bump commit may touch. The push job of the workflow (which cannot run repository code)
// repeats these patterns in shell and `tooling/release-pr.spec.ts` asserts the two are the same:
// the manifests, the lockfile, the changelogs and the three source files that hold a version
// string (SOURCE_VERSIONS). Nothing else: no workflow, no script, no other source.
export const ALLOWED_PATHS: RegExp[] = [
    /^package\.json$/,
    /^(apps|packages)\/[^/]+\/package\.json$/,
    /^bun\.lock$/,
    /^CHANGELOG\.md$/,
    /^(apps|packages)\/[^/]+\/CHANGELOG\.md$/,
    ...SOURCE_VERSIONS.map(
        (source) => new RegExp(`^${source.file.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`),
    ),
];

export const allowedPath = (file: string) => ALLOWED_PATHS.some((pattern) => pattern.test(file));

// A manifest or a source version file may change only on the lines that hold the version.
export const versionLine = (line: string) =>
    /^[+-].*\bversion\b/.test(line) && !/^(\+\+\+|---) /.test(line);

export interface ChangedFile {
    // The raw `git diff` fields: modes and the status letter.
    oldMode: string;
    newMode: string;
    status: string;
    path: string;
}

// Why a bump commit's changes are refused: a path outside the allowlist, a deletion or a rename, a
// symlink or an executable file, or nothing changed at all.
export function changedFileProblems(files: ChangedFile[]): string[] {
    if (files.length === 0) return ["the commit changes nothing"];
    const problems: string[] = [];
    for (const file of files) {
        if (!allowedPath(file.path)) problems.push(`${file.path} is not an allowed path`);
        if (file.status !== "A" && file.status !== "M") {
            problems.push(
                `${file.path}: status ${file.status} is not an addition or a modification`,
            );
        }
        if (file.newMode !== "100644" || !["100644", "000000"].includes(file.oldMode)) {
            problems.push(
                `${file.path}: mode ${file.oldMode} to ${file.newMode} is not a plain file`,
            );
        }
    }
    return problems;
}

function tagsInGit(): string[] {
    const done = spawnSync("git", ["tag", "--list", "v*"], { cwd: root, encoding: "utf8" });
    if (done.status !== 0) throw new Error(`git tag failed: ${done.stderr}`);
    return done.stdout.split("\n").filter(Boolean);
}

function main(argv: string[]) {
    const program = new Command("release-pr")
        .exitOverride()
        .helpOption(false)
        .helpCommand(false)
        .configureOutput({ writeOut: () => {}, writeErr: () => {}, outputError: () => {} });
    program
        .command("plan")
        .requiredOption("--base <base>")
        .requiredOption("--channel <channel>")
        .action((options) => {
            const plan = planRelease(options.base, options.channel, tagsInGit());
            console.log(`version=${plan.version}`);
            console.log(`channel=${plan.channel}`);
            console.log(`range=${plan.range}`);
        });
    program
        .command("body")
        .requiredOption("--version <version>")
        .requiredOption("--changelog <file>")
        .requiredOption("--out <file>")
        .action((options) => {
            const version = options.version;
            if (checkTag(`v${version}`).length > 0)
                throw new Error(`${version} is not a release version`);
            writeFileSync(
                options.out,
                prBody(
                    version,
                    channelOf(version)?.name ?? "unknown",
                    readFileSync(options.changelog, "utf8"),
                ),
            );
        });
    try {
        program.parse(argv, { from: "user" });
    } catch (error) {
        if (error instanceof CommanderError) {
            console.error(
                "usage: bun tooling/release-pr.ts plan --base <X.Y.Z> --channel <name> | body ...",
            );
            process.exit(2);
        }
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    }
}

if (import.meta.main) main(process.argv.slice(2));
