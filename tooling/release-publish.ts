// What the release workflow's credentialed jobs run: `stage` and `image-publish` (registry write,
// `stage` also the OIDC token) and `npm-publish` (the OIDC token). Those jobs install no
// dependencies, so this file and the modules it imports use only node: built-ins and relative
// dependency-free modules (asserted by tooling/release.spec.ts). Arguments are parsed by hand.
// The decisions are in release-core.ts.
//
//   bun tooling/release-publish.ts publish-npm <tarballDir> <version>
//   bun tooling/release-publish.ts retag <name> <version> <digest> <sha>
//   bun tooling/release-publish.ts image-digest <name> <tag>     (exit 3 when the tag is absent)
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
    checkTarballSet,
    checkPackageSet,
    classifyInspect,
    exactTagAction,
    existingVersion,
    floatingMoves,
    npmDistTag,
    npmPublishAction,
    parseDistTags,
    parseInspect,
    PUBLISH_ORDER,
    REGISTRY,
    sumsFiles,
} from "./release-core";
import { channelOf, imageTagsOf } from "./release-channels";

const root = path.resolve(import.meta.dirname, "..");

export interface Result {
    code: number | null;
    out: string;
    err: string;
}

export function run(command: string, args: string[]): Result {
    const done = spawnSync(command, args, { cwd: root, encoding: "utf8" });
    return {
        code: done.status,
        out: done.stdout ?? "",
        err: done.stderr ?? String(done.error ?? ""),
    };
}

export function must(command: string, args: string[]): string {
    const done = run(command, args);
    if (done.code !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${done.err}`);
    return done.out.trim();
}

export interface Inspected {
    digest: string;
    version: string | null;
}

export type Runner = (command: string, args: string[]) => Result;

// null when the tag does not exist; any other failure throws, so a registry error never reads as
// "absent" and never causes a rebuild or an overwrite. Existence is decided by `--raw` alone,
// which resolves and reads only the manifest of the requested tag. The full inspection then also
// fetches every child manifest and config; if that fails (even with a `: not found` for a child
// descriptor) the tag exists but the image is unreadable, so it is an error, never "absent".
export function inspect(ref: string, exec: Runner = run): Inspected | null {
    const raw = exec("docker", ["buildx", "imagetools", "inspect", ref, "--raw"]);
    const kind = classifyInspect(raw.code, raw.err);
    if (kind === "absent") return null;
    if (kind === "error") throw new Error(`could not inspect ${ref}:\n${raw.err}`);
    const full = exec("docker", ["buildx", "imagetools", "inspect", ref, "--format", "{{json .}}"]);
    if (full.code !== 0) throw new Error(`${ref} exists but cannot be read:\n${full.err}`);
    return parseInspect(full.out);
}

export const imageRef = (name: string, tag: string) => `${REGISTRY}${name}:${tag}`;

// The whole dist-tag map, not `dist-tags.<tag>`: npm resolves a bare package spec through
// `latest` first, so a package that has `next` but no `latest` (every package before its first
// stable release) would look as if it had no tag at all.
function npmDistTags(name: string): Record<string, string> {
    const done = run("npm", ["view", name, "dist-tags", "--json"]);
    if (done.code !== 0) throw new Error(`npm view ${name} failed:\n${done.err}`);
    try {
        return parseDistTags(done.out);
    } catch (error) {
        throw new Error(`npm view ${name} dist-tags: ${(error as Error).message}`);
    }
}

function tagOnNpm(name: string, tag: string): string | null {
    return npmDistTags(name)[tag] ?? null;
}

export function publishNpm(dir: string, version: string) {
    const present = readdirSync(dir).filter((f) => f.endsWith(".tgz"));
    const listed = sumsFiles(readFileSync(path.join(dir, "SHA256SUMS"), "utf8"));
    const mismatch = checkTarballSet(listed, present);
    if (mismatch.length > 0)
        throw new Error(`The tarballs differ from SHA256SUMS:\n${mismatch.join("\n")}`);
    const byName = new Map<string, string>();
    const names: string[] = [];
    for (const file of present) {
        const full = path.resolve(dir, file);
        const manifest = JSON.parse(must("tar", ["xzOf", full, "package/package.json"]));
        if (manifest.version !== version) {
            throw new Error(`${file} is version ${manifest.version}, not the tag's ${version}`);
        }
        names.push(manifest.name);
        byName.set(manifest.name, full);
    }
    const wrongSet = checkPackageSet(names);
    if (wrongSet.length > 0)
        throw new Error(`The tarballs are not the published set:\n${wrongSet.join("\n")}`);
    for (const name of PUBLISH_ORDER) {
        const tarball = byName.get(name)!;
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
        const channelTag = channelOf(version)?.npmTag;
        if (!channelTag) throw new Error(`${version} belongs to no registered channel`);
        const tag = npmDistTag(version, tagOnNpm(name, channelTag));
        must("npm", ["publish", tarball, "--tag", tag, "--provenance", "--access", "public"]);
        console.log(`${name}@${version}: published with --tag ${tag}`);
    }
}

// Adds the tags to a staged digest. `exec` is the runner of every docker call, so the wiring (which
// tags are created, and from what) is tested with a fake registry.
export function retag(
    name: string,
    version: string,
    digest: string,
    sha: string,
    exec: Runner = run,
) {
    const inspectRef = (ref: string) => inspect(ref, exec);
    const staged = inspectRef(imageRef(name, `sha-${sha}`));
    if (staged?.digest !== digest) {
        throw new Error(`${name}: sha-${sha} is ${staged?.digest ?? "missing"}, not ${digest}`);
    }
    const source = `${REGISTRY}${name}@${digest}`;
    const add = (tag: string) => {
        const done = exec("docker", [
            "buildx",
            "imagetools",
            "create",
            "-t",
            imageRef(name, tag),
            source,
        ]);
        if (done.code !== 0) throw new Error(`creating ${tag} failed:\n${done.err}`);
    };
    if (exactTagAction(digest, inspectRef(imageRef(name, version))?.digest ?? null) === "create") {
        add(version);
        console.log(`${name}: ${version} -> ${digest}`);
    }
    // A tag that exists with an unreadable label throws here instead of reading as missing.
    const versionOf = (tag: string) =>
        existingVersion(inspectRef(imageRef(name, tag)), imageRef(name, tag));
    const current: Record<string, string | null> = {};
    for (const tag of imageTagsOf(version)) current[tag] = versionOf(tag);
    for (const tag of floatingMoves(version, current)) {
        add(tag);
        console.log(`${name}: ${tag} -> ${digest}`);
    }
}

function main(argv: string[]) {
    const [command, ...args] = argv;
    const usage = (): never => {
        console.error(
            "usage: release-publish.ts publish-npm <dir> <version> | retag <name> <version> <digest> <sha> | image-digest <name> <tag>",
        );
        return process.exit(2);
    };
    try {
        if (command === "publish-npm" && args.length === 2) publishNpm(args[0]!, args[1]!);
        else if (command === "retag" && args.length === 4)
            retag(args[0]!, args[1]!, args[2]!, args[3]!);
        else if (command === "image-digest" && args.length === 2) {
            const found = inspect(imageRef(args[0]!, args[1]!));
            if (!found) process.exit(3);
            console.log(found.digest);
        } else usage();
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    }
}

if (import.meta.main) main(process.argv.slice(2));
