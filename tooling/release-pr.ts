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

const root = path.resolve(import.meta.dirname, "..");

export const BASE_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

// The channel names a dispatch may choose: every registered channel (stable included). The
// workflow's static `options` list is asserted to equal this.
export const channelNames = (channels: Channel[] = CHANNELS) => channels.map((c) => c.name);

// The highest counter of `v<base>-<channel>.N` tags plus one, or 1.
export function nextCounter(base: string, channel: Channel, tags: string[]): number {
    if (channel.preRelease === null) throw new Error("stable has no counter");
    const pattern = preReleasePattern(channel.preRelease);
    let highest = 0;
    for (const tag of tags) {
        if (!tag.startsWith(`v${base}-`)) continue;
        const part = tag.slice(`v${base}-`.length);
        if (!pattern.test(part)) continue;
        highest = Math.max(highest, Number(part.slice(part.lastIndexOf(".") + 1)));
    }
    return highest + 1;
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

// The PR description: what the PR is, what merging does not do, and the changelog.
export function prBody(version: string, channel: string, changelog: string): string {
    return [
        `Release **v${version}** (${channel} channel), opened by the release PR workflow.`,
        "",
        "Merging this pull request does **not** publish anything. After it is merged and `CI Passed` is",
        `green on the merge commit, the maintainer creates and pushes the single tag \`v${version}\` on that`,
        "commit by hand (docs/releasing.md), which starts the release workflow.",
        "",
        "## Changelog",
        "",
        changelog.trim(),
        "",
    ].join("\n");
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
