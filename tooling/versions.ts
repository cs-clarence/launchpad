// One version for everything that ships together, kept in step by Cocogitto's bump hook.
//
// `core` (see cog.toml) is every workspace package and the root manifest except the shared
// tooling packages, which cog.toml registers one by one and which are versioned on their own.
// Nothing here tags, commits, pushes or publishes: `sync` rewrites manifests and refreshes the
// lockfile for the commit `cog bump` is already making, and `check` reports disagreement.
//
//   bun tooling/versions.ts sync <package|core> <version>   (the cog hook)
//   bun tooling/versions.ts check                           (omni run check:versions)
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Command, CommanderError } from "@commander-js/extra-typings";

export const CORE = "core";
// Version strings written in source, which no manifest feeds: each is rewritten by `sync core`
// and compared by `check`. The pattern's first group is everything before the version.
export const SOURCE_VERSIONS: { file: string; pattern: RegExp }[] = [
    { file: "apps/cli/src/program.ts", pattern: /(\.version\()"[^"]*"/ },
    { file: "apps/mcp/src/server.ts", pattern: /(name: "launchpad-mcp", version: )"[^"]*"/ },
    { file: "apps/controller/src/server/openapi.ts", pattern: /(\n\s+version: )"[^"]*"/ },
];
// Strict SemVer 2.0.0: no leading zeros, no empty identifiers.
const NUMERIC = "(?:0|[1-9]\\d*)";
const PRERELEASE = `(?:${NUMERIC}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
const SEMVER = new RegExp(
    `^${NUMERIC}\\.${NUMERIC}\\.${NUMERIC}(?:-${PRERELEASE}(?:\\.${PRERELEASE})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
);
// Matches the first top-level "version" line without reformatting the file.
const VERSION_LINE = /^(\s*"version":\s*)"[^"]*"/m;

interface CogConfig {
    monorepo?: { packages?: Record<string, { path: string; include?: string[] }> };
}

export interface Workspace {
    name: string;
    // Relative to the repository root; "." for the root manifest.
    dir: string;
    version: string;
}

const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;

function cogConfig(root: string): CogConfig {
    return Bun.TOML.parse(readFileSync(path.join(root, "cog.toml"), "utf8")) as CogConfig;
}

// Packages cog.toml versions on their own: every registered package except `core`.
export function independentPackages(root: string): Map<string, string> {
    const found = new Map<string, string>();
    for (const [name, entry] of Object.entries(cogConfig(root).monorepo?.packages ?? {})) {
        if (name !== CORE) found.set(name, path.posix.normalize(entry.path));
    }
    return found;
}

export function coreIncludes(root: string): string[] {
    return cogConfig(root).monorepo?.packages?.[CORE]?.include ?? [];
}

// The root manifest and every workspace the root manifest's globs name (`dir/*` form).
export function workspaces(root: string): Workspace[] {
    const rootManifest = readJson(path.join(root, "package.json"));
    const found: Workspace[] = [
        { name: rootManifest.name, dir: ".", version: String(rootManifest.version ?? "") },
    ];
    for (const pattern of (rootManifest.workspaces ?? []) as string[]) {
        // Only `dir/*` is understood; anything else would be silently skipped, so refuse it.
        if (!/^[^*]+\/\*$/.test(pattern)) {
            throw new Error(`Unsupported workspace entry "${pattern}": use the dir/* form.`);
        }
        const parent = pattern.slice(0, -2);
        if (!existsSync(path.join(root, parent))) continue;
        for (const entry of readdirSync(path.join(root, parent), { withFileTypes: true })) {
            const manifest = path.join(root, parent, entry.name, "package.json");
            if (!entry.isDirectory() || !existsSync(manifest)) continue;
            const json = readJson(manifest);
            found.push({
                name: json.name,
                dir: path.posix.normalize(`${parent}/${entry.name}`),
                version: String(json.version ?? ""),
            });
        }
    }
    return found;
}

export function sharedWorkspaces(root: string): Workspace[] {
    const own = new Set(independentPackages(root).values());
    return workspaces(root).filter((w) => !own.has(w.dir));
}

// Whether a `dir/**` include of cog.toml covers a workspace directory.
export function covered(includes: string[], dir: string): boolean {
    return includes.some((include) => {
        const prefix = include.replace(/\/\*\*$/, "");
        return include.endsWith("/**") && (dir === prefix || dir.startsWith(`${prefix}/`));
    });
}

export function checkVersions(root: string): string[] {
    const problems: string[] = [];
    const shared = sharedWorkspaces(root);
    const includes = coreIncludes(root);
    const expected = shared[0]?.version;
    for (const w of shared) {
        if (!SEMVER.test(w.version)) {
            problems.push(`${w.name} (${w.dir}): "${w.version}" is not a version`);
        } else if (w.version !== expected) {
            problems.push(`${w.name} (${w.dir}) is ${w.version}; the root is ${expected}`);
        }
        // A package whose changes cog.toml does not watch would never cause a bump.
        if (w.dir !== "." && !covered(includes, w.dir)) {
            problems.push(`${w.dir} is not in the core include list of cog.toml`);
        }
    }
    // The lockfile records each workspace's version; a stale one passes `--frozen-lockfile`.
    const lockFile = path.join(root, "bun.lock");
    if (!existsSync(lockFile)) {
        problems.push("bun.lock is missing");
    } else {
        const lock = Bun.JSONC.parse(readFileSync(lockFile, "utf8")) as {
            workspaces?: Record<string, { version?: string }>;
        };
        for (const w of shared) {
            if (w.dir === ".") continue;
            const recorded = lock.workspaces?.[w.dir]?.version;
            if (recorded !== w.version) {
                problems.push(
                    `bun.lock records ${recorded} for ${w.dir}; the manifest says ${w.version}`,
                );
            }
        }
    }
    for (const source of SOURCE_VERSIONS) {
        const found = readFileSync(path.join(root, source.file), "utf8").match(
            new RegExp(source.pattern.source.replace('"[^"]*"', '"([^"]*)"')),
        );
        if (!found) problems.push(`${source.file}: the version string was not found`);
        else if (found[2] !== expected) {
            problems.push(`${source.file} says ${found[2]}; the root is ${expected}`);
        }
    }
    return problems;
}

function setVersion(file: string, version: string) {
    const text = readFileSync(file, "utf8");
    if (!VERSION_LINE.test(text)) throw new Error(`${file} has no "version" line`);
    const next = text.replace(VERSION_LINE, `$1"${version}"`);
    // The first "version" line is the top-level one by convention; make sure it was.
    if (JSON.parse(next).version !== version) throw new Error(`${file}: not the top-level version`);
    writeFileSync(file, next);
}

// Rewrites the manifests of one cog package: all of `core`, or a single independent one.
// Returns the directories it changed.
export function syncVersions(root: string, pkg: string, version: string): string[] {
    if (!SEMVER.test(version)) throw new Error(`"${version}" is not a version`);
    let dirs: string[];
    if (pkg === CORE) {
        dirs = sharedWorkspaces(root).map((w) => w.dir);
    } else {
        const dir = independentPackages(root).get(pkg);
        if (!dir) throw new Error(`${pkg} is not a package registered in cog.toml`);
        dirs = [dir];
    }
    for (const dir of dirs) setVersion(path.join(root, dir, "package.json"), version);
    if (pkg === CORE) {
        for (const source of SOURCE_VERSIONS) {
            const file = path.join(root, source.file);
            const text = readFileSync(file, "utf8");
            if (!source.pattern.test(text)) throw new Error(`${source.file}: no version string`);
            writeFileSync(file, text.replace(source.pattern, `$1"${version}"`));
        }
    }
    return dirs;
}

if (import.meta.main) {
    const root = path.resolve(import.meta.dirname, "..");
    const program = new Command("versions")
        .exitOverride()
        .helpOption(false)
        .helpCommand(false)
        .configureOutput({ writeOut: () => {}, writeErr: () => {}, outputError: () => {} });
    program
        .command("check")
        .allowExcessArguments()
        .action(() => {
            const problems = checkVersions(root);
            for (const problem of problems) console.error(problem);
            if (problems.length > 0) process.exit(1);
            console.log("Versions agree.");
        });
    program
        .command("sync")
        .argument("<package>")
        .argument("<version>")
        .allowExcessArguments()
        .action((pkg: string, version: string) => {
            const dirs = syncVersions(root, pkg, version);
            console.log(`${pkg} ${version}: ${dirs.join(", ")}`);
            // Workspace versions are recorded in the lockfile; the bump commit must hold both.
            const lock = spawnSync("bun", ["install", "--lockfile-only"], {
                cwd: root,
                stdio: "inherit",
            });
            if (lock.status !== 0) process.exit(lock.status ?? 1);
        });
    try {
        program.parse(process.argv.slice(2), { from: "user" });
    } catch (error) {
        if (!(error instanceof CommanderError)) throw error;
        console.error("usage: bun tooling/versions.ts sync <package|core> <version> | check");
        process.exit(2);
    }
}
