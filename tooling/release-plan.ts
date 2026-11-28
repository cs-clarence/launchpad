// The decisions of the release workflow (.github/workflows/release.yaml), kept out of YAML so they
// are unit tested: the tag guard, the npm dist-tag, the floating image tags, the partial-release
// check and the CI Passed lookup. The pure functions decide; the commands at the bottom gather
// facts from git, npm and the registry and apply them. Nothing here runs unless the release
// workflow (or a maintainer) calls a command, and nothing publishes except `retag`, which only
// adds tags to a digest that is already in the registry.
//
//   bun tooling/release-plan.ts <command> ...   (see `usage` below)
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Command, CommanderError } from "@commander-js/extra-typings";
import { TARGETS } from "./package-clients";
import {
    ABANDONED_FILE,
    abandonedProblems,
    ciPassedProblem,
    TAG_PATTERN,
    type CheckRun,
    checkTag,
    consumerManifest,
    IMAGES,
    isStable,
    partialReleaseProblems,
    type PreviousRelease,
    previousStable,
    xyOf,
} from "./release-core";
import { listingProblems, regressionProblems } from "./release-channels";
import { imageRef, inspect, must, run } from "./release-publish";

export * from "./release-core";

const root = path.resolve(import.meta.dirname, "..");

// The tag must be v + the version of the root manifest and of every published manifest.
export function tagMismatches(repository: string, tag: string): string[] {
    const expected = tag.replace(/^v/, "");
    const problems: string[] = [];
    for (const dir of [".", ...TARGETS.map((t) => t.dir)]) {
        const version = JSON.parse(readFileSync(path.join(repository, dir, "package.json"), "utf8"))
            .version as string;
        if (version !== expected)
            problems.push(`${dir}/package.json is ${version}, not ${expected}`);
    }
    return problems;
}

// ---- commands: gather facts and apply the decisions above ----

// The abandoned versions, validated against the tags; a bad file stops the release.
export function readAbandoned(
    tags: string[],
    version: string,
    file = path.join(root, ABANDONED_FILE),
) {
    const entries: unknown = JSON.parse(readFileSync(file, "utf8"));
    const problems = abandonedProblems(entries, tags, version);
    if (problems.length > 0) throw new Error(`${ABANDONED_FILE}:\n${problems.join("\n")}`);
    return (entries as { version: string }[]).map((entry) => entry.version);
}

function gatherPrevious(version: string): PreviousRelease | null {
    const tags = must("git", ["tag", "--list", "v*"]).split("\n").filter(Boolean);
    const previous = previousStable(tags, version, readAbandoned(tags, version));
    if (!previous) return null;
    const commit = must("git", ["rev-list", "-n", "1", `v${previous}`]);
    const packages: PreviousRelease["packages"] = {};
    for (const target of TARGETS) {
        const name = JSON.parse(readFileSync(path.join(root, target.dir, "package.json"), "utf8"))
            .name as string;
        const integrity = run("npm", ["view", `${name}@${previous}`, "dist.integrity"]);
        const attestations = run("npm", [
            "view",
            `${name}@${previous}`,
            "dist.attestations",
            "--json",
        ]);
        packages[name] = {
            integrity: integrity.code === 0 ? integrity.out.trim() || null : null,
            attested: attestations.code === 0 && attestations.out.trim().length > 2,
        };
    }
    const images: PreviousRelease["images"] = {};
    for (const name of IMAGES) {
        const digest = (tag: string) => inspect(imageRef(name, tag))?.digest ?? null;
        images[name] = {
            staged: digest(`sha-${commit}`),
            exact: digest(previous),
            xy: digest(xyOf(previous)),
            latest: digest("latest"),
        };
    }
    const stableVersions = tags
        .filter((tag) => tag !== `v${version}` && TAG_PATTERN.test(tag) && isStable(tag.slice(1)))
        .map((tag) => tag.slice(1));
    return { version: previous, stableVersions, packages, images };
}

const usage = [
    "usage: bun tooling/release-plan.ts <command>",
    "  guard <tag>                    validate a release tag, print its version",
    "  verify-tag <tag>               the tag equals every published manifest version",
    "  ci-passed                      read check runs (one JSON object per line) from stdin",
    "  consumer <tarballDir> <outDir> write a consumer project pinned to the tarballs",
    "  no-regression <version> [--require-tag]  refuse a channel below one already released for the version",
    "  partial <version>              refuse when the previous stable release is partial",
].join("\n");

function main(argv: string[]) {
    const program = new Command("release-plan")
        .exitOverride()
        .helpOption(false)
        .helpCommand(false)
        .configureOutput({ writeOut: () => {}, writeErr: () => {}, outputError: () => {} });
    const fail = (problems: string[]) => {
        for (const problem of problems) console.error(problem);
        process.exit(1);
    };
    program
        .command("guard")
        .argument("<tag>")
        .action((tag) => {
            const problems = checkTag(tag);
            if (problems.length > 0) fail(problems);
            console.log(tag.slice(1));
        });
    program
        .command("verify-tag")
        .argument("<tag>")
        .action((tag) => {
            const problems = tagMismatches(root, tag);
            if (problems.length > 0) fail(problems);
            console.log(`${tag} matches every published manifest.`);
        });
    program.command("ci-passed").action(() => {
        const runs = readFileSync(0, "utf8")
            .split("\n")
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line) as CheckRun);
        const problem = ciPassedProblem(runs);
        if (problem) fail([problem]);
        console.log("CI Passed succeeded on this commit.");
    });
    program
        .command("consumer")
        .argument("<tarballDir>")
        .argument("<outDir>")
        .action((dir, out) => {
            const tarballs: Record<string, string> = {};
            for (const file of readdirSync(dir).filter((f) => f.endsWith(".tgz"))) {
                const full = path.resolve(dir, file);
                const manifest = JSON.parse(must("tar", ["xzOf", full, "package/package.json"]));
                tarballs[manifest.name] = full;
            }
            writeFileSync(
                path.join(out, "package.json"),
                JSON.stringify(consumerManifest(tarballs)),
            );
        });
    program
        .command("no-regression")
        .argument("<version>")
        .option("--require-tag")
        .action((version, options) => {
            const tags = must("git", ["tag", "--list", "v*"]).split("\n").filter(Boolean);
            const problems = [
                ...(options.requireTag ? listingProblems(version, tags) : []),
                ...regressionProblems(version, tags),
            ];
            if (problems.length > 0) fail(problems);
            console.log(`${version} does not go backwards across channels.`);
        });
    program
        .command("partial")
        .argument("<version>")
        .action((version) => {
            if (!isStable(version)) return console.log("A pre-release: no partial-release check.");
            const previous = gatherPrevious(version);
            if (!previous) return console.log("No previous stable release.");
            const problems = partialReleaseProblems(previous);
            if (problems.length > 0)
                fail([`v${previous.version} is a partial release:`, ...problems]);
            console.log(`v${previous.version} is complete.`);
        });
    try {
        program.parse(argv, { from: "user" });
    } catch (error) {
        if (!(error instanceof CommanderError)) {
            console.error(error instanceof Error ? error.message : error);
            process.exit(1);
        }
        console.error(usage);
        process.exit(2);
    }
}

if (import.meta.main) main(process.argv.slice(2));
