// The pure decisions of the release workflow. Dependency-free on purpose: the publishing jobs hold
// the OIDC token or write access to the registry, so what they run imports only node: built-ins
// and relative modules like this one (asserted by tooling/release.spec.ts).
import { compareSemver } from "./semver-compare";

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
    // Every other stable release (from the v<semver> tags), the one being published excluded.
    stableVersions: string[];
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
// X.Y is required only when no other stable release of that X.Y is higher, and latest only when
// no other stable release is higher at all: a backport (1.1.5 after 1.2.0) never held latest, and
// a retry after a newer patch does not hold X.Y.
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
        const higher = previous.stableVersions.filter((other) => compareSemver(other, v) > 0);
        const tags: Record<string, string | null> = { [v]: found.exact };
        if (!higher.some((other) => xyOf(other) === xyOf(v))) tags[xyOf(v)] = found.xy;
        if (higher.length === 0) tags.latest = found.latest;
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

// `docker buildx imagetools inspect` of a missing tag. Only the registry's own signals count as
// absent: `manifest unknown`, `MANIFEST_UNKNOWN`, `NAME_UNKNOWN` (a repository never pushed to), or
// a line ending in `: not found` once the image reference is removed from it. Anything else (a
// timeout, DNS, a credential helper that is `not found in $PATH`, a number such as 404 inside a
// reference) is an error, never "absent": absent lets a floating tag move or a tag be rebuilt.
export function classifyInspect(code: number | null, stderr: string): "ok" | "absent" | "error" {
    if (code === 0) return "ok";
    if (/\b(manifest unknown|MANIFEST_UNKNOWN|NAME_UNKNOWN|name unknown)\b/.test(stderr))
        return "absent";
    for (const line of stderr.split("\n")) {
        // Image references and paths hold a `/`; drop those words before reading the line.
        const text = line
            .split(/\s+/)
            .filter((word) => !word.includes("/"))
            .join(" ")
            .trim();
        if (/(^|:\s*)not found$/.test(text)) return "absent";
    }
    return "error";
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

// The version label of an image that exists. A tag that exists but whose label is missing or not
// a version must not read as "no such tag": a floating tag would then move backwards.
export function existingVersion(
    found: { version: string | null } | null,
    ref: string,
): string | null {
    if (found === null) return null;
    if (!found.version || !TAG_PATTERN.test(`v${found.version}`)) {
        throw new Error(`${ref} exists but has no readable ${VERSION_LABEL} label`);
    }
    return found.version;
}

// `sha256sum` format: digest, two spaces, file name. Only the file names are needed here.
export function sumsFiles(sums: string): string[] {
    return sums
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => {
            const match = /^[0-9a-f]{64} [ *](.+)$/.exec(line);
            if (!match) throw new Error(`not a SHA256SUMS line: ${line}`);
            return match[1]!;
        });
}

// The tarballs present must be exactly the files the checksums list.
export function checkTarballSet(listed: string[], present: string[]): string[] {
    const problems: string[] = [];
    for (const name of listed)
        if (!present.includes(name)) problems.push(`${name} is listed but missing`);
    for (const name of present)
        if (!listed.includes(name)) problems.push(`${name} is not in SHA256SUMS`);
    return problems;
}

// The packages published, in dependency order.
export const PUBLISH_ORDER = ["contracts", "sdk", "client-core", "cli", "mcp"].map(
    (short) => `@launchpad-kit/${short}`,
);

// The tarballs must be exactly the five packages: none missing, none extra, none twice.
export function checkPackageSet(names: string[]): string[] {
    const problems: string[] = [];
    for (const name of PUBLISH_ORDER) {
        const count = names.filter((n) => n === name).length;
        if (count === 0) problems.push(`no tarball for ${name}`);
        else if (count > 1) problems.push(`${count} tarballs for ${name}`);
    }
    for (const name of names)
        if (!PUBLISH_ORDER.includes(name)) problems.push(`unexpected package ${name}`);
    return problems;
}
