// The decisions of the release workflow (.github/workflows/release.yaml), kept out of YAML so they
// are unit tested: the tag guard, the npm dist-tag, the floating image tags, the partial-release
// check and the CI Passed lookup. The pure functions decide; the commands at the bottom gather
// facts from git, npm and the registry and apply them. Nothing here runs unless the release
// workflow (or a maintainer) calls a command, and nothing publishes except `retag`, which only
// adds tags to a digest that is already in the registry.
//
//   bun tooling/release-plan.ts <command> ...   (see `usage` below)
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Command, CommanderError } from "@commander-js/extra-typings";
import { TARGETS } from "./package-clients";
import { compareSemver } from "./versions";

const root = path.resolve(import.meta.dirname, "..");

// The five images, built as launchpad/<name> and pushed to ghcr.io/launchpad-kit/launchpad-<name>.
export const IMAGES = ["controller", "worker", "router", "admin", "dokku"];
export const REGISTRY = "ghcr.io/launchpad-kit/launchpad-";
export const VERSION_LABEL = "org.opencontainers.image.version";
// An OCI tag is at most 128 characters; the version becomes an image tag.
export const MAX_VERSION_LENGTH = 128;

// SemVer 2.0.0 without build metadata, prefixed by `v`. The workflow's guard job repeats this
// pattern in shell (it runs before a checkout), and the workflow spec asserts the two agree.
export const TAG_PATTERN =
    /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*)|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.((0|[1-9][0-9]*)|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?$/;

export function checkTag(tag: string): string[] {
    if (!TAG_PATTERN.test(tag)) return [`${tag} is not v<semver> without build metadata`];
    if (tag.length - 1 > MAX_VERSION_LENGTH) {
        return [`the version is longer than ${MAX_VERSION_LENGTH} characters (an image tag limit)`];
    }
    return [];
}

export const isStable = (version: string) => !version.includes("-");
export const xyOf = (version: string) => version.split(".").slice(0, 2).join(".");

export type DistTag = "latest" | "next" | "retry";

// A pre-release never takes `latest`. A stable version takes it when the package has none yet
// (only pre-releases or the bootstrap placeholder were published) or when it is not lower than the
// current one; a lower one is a retry of an older release and must not move `latest` backwards.
export function npmDistTag(version: string, currentLatest: string | null | undefined): DistTag {
    if (!isStable(version)) return "next";
    if (!currentLatest) return "latest";
    return compareSemver(version, currentLatest) < 0 ? "retry" : "latest";
}

// What to do with one package version given what the registry holds. A version is skipped only
// when its integrity equals the local tarball's and a provenance attestation is present; a
// version published by hand, or with other content, fails instead of being skipped silently.
export function npmPublishAction(
    localIntegrity: string,
    remote: { integrity: string; attested: boolean } | null,
): "publish" | "skip" {
    if (!remote) return "publish";
    if (remote.integrity !== localIntegrity) {
        throw new Error(
            `the published integrity ${remote.integrity} differs from ${localIntegrity}`,
        );
    }
    if (!remote.attested) throw new Error("the published version has no provenance attestation");
    return "skip";
}

export interface FloatingInput {
    version: string;
    // The version label of the image now tagged X.Y, or null when that tag does not exist.
    xyVersion: string | null;
    // The same for `latest`.
    latestVersion: string | null;
}

// Floating tags move forward only, and only for stable versions.
export function floatingTags(input: FloatingInput): { xy: boolean; latest: boolean } {
    if (!isStable(input.version)) return { xy: false, latest: false };
    const ahead = (current: string | null) =>
        !current || !isStable(current) || compareSemver(input.version, current) > 0;
    return { xy: ahead(input.xyVersion), latest: ahead(input.latestVersion) };
}

// What to do with the immutable X.Y.Z tag given what it points to now.
export function exactTagAction(staged: string, existing: string | null): "create" | "skip" {
    if (existing === null) return "create";
    if (existing === staged) return "skip";
    throw new Error(`the version tag already points to ${existing}, not the staged ${staged}`);
}

// The highest stable release strictly below `version`, from the `v<semver>` tags.
export function previousStable(tags: string[], version: string): string | null {
    const found = tags
        .filter((tag) => TAG_PATTERN.test(tag) && isStable(tag.slice(1)))
        .map((tag) => tag.slice(1))
        .filter((v) => compareSemver(v, version) < 0)
        .toSorted(compareSemver);
    return found.at(-1) ?? null;
}

export interface PreviousRelease {
    version: string;
    packages: Record<string, { integrity: string | null; attested: boolean }>;
    // Digests of the image tags; `staged` is sha-<commit of the release tag>.
    images: Record<
        string,
        {
            staged: string | null;
            exact: string | null;
            xy: string | null;
            latest: string | null;
        }
    >;
}

// A release is complete on content: every package has the version with provenance, and the
// version, X.Y and latest tags of every image resolve to the staged digest, not merely exist.
// The previous stable release is by construction the highest stable one, so it is the highest
// patch of its X.Y and the latest stable.
export function partialReleaseProblems(previous: PreviousRelease): string[] {
    const problems: string[] = [];
    const v = previous.version;
    for (const [name, found] of Object.entries(previous.packages)) {
        if (!found.integrity) problems.push(`${name}@${v} is not published`);
        else if (!found.attested) problems.push(`${name}@${v} has no provenance attestation`);
    }
    for (const [name, found] of Object.entries(previous.images)) {
        if (!found.staged) {
            problems.push(`${name}: the staged image sha-<commit of v${v}> does not exist`);
            continue;
        }
        const tags = { [v]: found.exact, [xyOf(v)]: found.xy, latest: found.latest };
        for (const [tag, digest] of Object.entries(tags)) {
            if (digest !== found.staged) {
                problems.push(
                    `${name}:${tag} is ${digest ?? "missing"}, not the staged ${found.staged}`,
                );
            }
        }
    }
    return problems;
}

export interface CheckRun {
    name?: string;
    app?: { slug?: string } | null;
    status?: string;
    conclusion?: string | null;
    completed_at?: string | null;
}

// The latest completed `CI Passed` run created by GitHub Actions must have succeeded. The `app`
// field and its `slug` are the check-runs JSON as documented (unverified against a live response).
export function ciPassedProblem(runs: CheckRun[]): string | null {
    const found = runs
        .filter(
            (run) =>
                run.name === "CI Passed" &&
                run.app?.slug === "github-actions" &&
                run.status === "completed",
        )
        .toSorted((a, b) => (a.completed_at ?? "").localeCompare(b.completed_at ?? ""));
    const latest = found.at(-1);
    if (!latest) return "no completed `CI Passed` check from GitHub Actions on this commit";
    return latest.conclusion === "success"
        ? null
        : `the latest \`CI Passed\` run concluded ${latest.conclusion}`;
}

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

// `docker buildx imagetools inspect` of a missing tag: exit status and wording are the only signal.
export function classifyInspect(code: number | null, stderr: string): "ok" | "absent" | "error" {
    if (code === 0) return "ok";
    return /not found|manifest unknown|no such manifest|404/i.test(stderr) ? "absent" : "error";
}

// The version label of an image from `imagetools inspect --format '{{json .}}'`: `.Image` is the
// config of a single image or a map of platform to config for an index (unverified shape).
export function labelVersion(inspected: { Image?: unknown }): string | null {
    const image = inspected.Image as Record<string, unknown> | undefined;
    if (!image) return null;
    const configs = "config" in image ? [image] : Object.values(image);
    for (const config of configs) {
        const labels = (config as { config?: { Labels?: Record<string, string> } }).config?.Labels;
        if (labels?.[VERSION_LABEL]) return labels[VERSION_LABEL];
    }
    return null;
}

// A consumer project that pins every package to its tarball, as check-packages.ts does.
export function consumerManifest(tarballs: Record<string, string>) {
    const files = Object.fromEntries(
        Object.entries(tarballs).map(([name, file]) => [name, `file:${file}`]),
    );
    return {
        name: "consumer",
        private: true,
        type: "module",
        dependencies: files,
        overrides: files,
    };
}

// ---- commands: gather facts and apply the decisions above ----

interface Result {
    code: number | null;
    out: string;
    err: string;
}

function run(command: string, args: string[]): Result {
    const done = spawnSync(command, args, { cwd: root, encoding: "utf8" });
    return {
        code: done.status,
        out: done.stdout ?? "",
        err: done.stderr ?? String(done.error ?? ""),
    };
}

function must(command: string, args: string[]): string {
    const done = run(command, args);
    if (done.code !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${done.err}`);
    return done.out.trim();
}

interface Inspected {
    digest: string;
    version: string | null;
}

// null when the tag does not exist; any other failure throws, so a registry error never reads as
// "absent" and never causes a rebuild or an overwrite.
function inspect(ref: string): Inspected | null {
    const done = run("docker", ["buildx", "imagetools", "inspect", ref, "--format", "{{json .}}"]);
    const kind = classifyInspect(done.code, done.err);
    if (kind === "absent") return null;
    if (kind === "error") throw new Error(`could not inspect ${ref}:\n${done.err}`);
    const json = JSON.parse(done.out) as { Manifest?: { digest?: string }; Image?: unknown };
    const digest = json.Manifest?.digest;
    if (!digest) throw new Error(`no digest in the inspection of ${ref}`);
    return { digest, version: labelVersion(json) };
}

const imageRef = (name: string, tag: string) => `${REGISTRY}${name}:${tag}`;

function latestOnNpm(name: string): string | null {
    const done = run("npm", ["view", name, "dist-tags.latest"]);
    if (done.code !== 0) throw new Error(`npm view ${name} failed:\n${done.err}`);
    return done.out.trim() || null;
}

function gatherPrevious(version: string): PreviousRelease | null {
    const tags = must("git", ["tag", "--list", "v*"]).split("\n").filter(Boolean);
    const previous = previousStable(tags, version);
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
    return { version: previous, packages, images };
}

// The publish order: dependencies first.
const PUBLISH_ORDER = ["contracts", "sdk", "client-core", "cli", "mcp"];

function publishNpm(dir: string, version: string) {
    const byName = new Map<string, string>();
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".tgz"))) {
        const full = path.resolve(dir, file);
        byName.set(JSON.parse(must("tar", ["xzOf", full, "package/package.json"])).name, full);
    }
    for (const short of PUBLISH_ORDER) {
        const name = `@launchpad-kit/${short}`;
        const tarball = byName.get(name);
        if (!tarball) throw new Error(`no tarball for ${name} in ${dir}`);
        const local = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
        const view = run("npm", ["view", `${name}@${version}`, "dist.integrity"]);
        if (view.code !== 0 && !/E404/.test(view.err))
            throw new Error(`npm view ${name}: ${view.err}`);
        const integrity = view.code === 0 ? view.out.trim() : "";
        let remote = null;
        if (integrity) {
            const attestations = run("npm", [
                "view",
                `${name}@${version}`,
                "dist.attestations",
                "--json",
            ]);
            remote = {
                integrity,
                attested: attestations.code === 0 && attestations.out.trim().length > 2,
            };
        }
        if (npmPublishAction(local, remote) === "skip") {
            console.log(`${name}@${version}: already published, integrity and provenance match`);
            continue;
        }
        const tag = npmDistTag(version, latestOnNpm(name));
        must("npm", ["publish", tarball, "--tag", tag, "--provenance", "--access", "public"]);
        console.log(`${name}@${version}: published with --tag ${tag}`);
    }
}

const usage = [
    "usage: bun tooling/release-plan.ts <command>",
    "  guard <tag>                    validate a release tag, print its version",
    "  verify-tag <tag>               the tag equals every published manifest version",
    "  ci-passed                      read check runs (one JSON object per line) from stdin",
    "  npm-tag <package> <version>    print the npm dist-tag to publish with",
    "  publish-npm <tarballDir> <version>  npm publish each tarball, skipping verified versions",
    "  consumer <tarballDir> <outDir> write a consumer project pinned to the tarballs",
    "  image-digest <name> <tag>      print the digest of an image tag; exit 3 when absent",
    "  partial <version>              refuse when the previous stable release is partial",
    "  retag <name> <version> <digest> <sha>  add X.Y.Z (and X.Y, latest) to a staged digest",
].join("\n");

function retag(name: string, version: string, digest: string, sha: string) {
    const staged = inspect(imageRef(name, `sha-${sha}`));
    if (staged?.digest !== digest) {
        throw new Error(`${name}: sha-${sha} is ${staged?.digest ?? "missing"}, not ${digest}`);
    }
    const source = `${REGISTRY}${name}@${digest}`;
    const add = (tag: string) =>
        must("docker", ["buildx", "imagetools", "create", "-t", imageRef(name, tag), source]);
    if (exactTagAction(digest, inspect(imageRef(name, version))?.digest ?? null) === "create") {
        add(version);
        console.log(`${name}: ${version} -> ${digest}`);
    }
    const plan = floatingTags({
        version,
        xyVersion: inspect(imageRef(name, xyOf(version)))?.version ?? null,
        latestVersion: inspect(imageRef(name, "latest"))?.version ?? null,
    });
    for (const [tag, move] of [
        [xyOf(version), plan.xy],
        ["latest", plan.latest],
    ] as const) {
        if (!move) continue;
        add(tag);
        console.log(`${name}: ${tag} -> ${digest}`);
    }
}

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
        .command("npm-tag")
        .argument("<package>")
        .argument("<version>")
        .action((name, version) => {
            console.log(npmDistTag(version, latestOnNpm(name)));
        });
    program
        .command("publish-npm")
        .argument("<tarballDir>")
        .argument("<version>")
        .action(publishNpm);
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
        .command("image-digest")
        .argument("<name>")
        .argument("<tag>")
        .action((name, tag) => {
            const found = inspect(imageRef(name, tag));
            if (!found) process.exit(3);
            console.log(found.digest);
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
    program
        .command("retag")
        .argument("<name>")
        .argument("<version>")
        .argument("<digest>")
        .argument("<sha>")
        .action(retag);
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
