// Stages and packs the client packages that users install: the SDK (with its contracts) as
// libraries, and the CLI and the MCP server as one bundled file each. Nothing here publishes
// or registers anything: the output is tarballs in a directory the caller names.
//
// The workspace packages stay private, with `exports` that point at source for development.
// What is packed is a separate, generated manifest that points at built files, so the source
// tree never has to be shaped for the registry. See docs/releasing.md.
import {
    chmodSync,
    cpSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import path from "node:path";

export interface Target {
    dir: string;
    kind: "library" | "bundle";
    // bundle only: the command name and the file it runs
    bin?: { name: string; file: string };
}

// Order matters: a library's tarball is needed by the ones that depend on it.
export const TARGETS: Target[] = [
    { dir: "packages/contracts", kind: "library" },
    { dir: "packages/sdk", kind: "library" },
    { dir: "apps/cli", kind: "bundle", bin: { name: "launchpad", file: "cli.mjs" } },
    { dir: "apps/mcp", kind: "bundle", bin: { name: "launchpad-mcp", file: "mcp.mjs" } },
];

const root = path.resolve(import.meta.dirname, "..");

interface Manifest {
    name: string;
    version: string;
    description?: string;
    dependencies?: Record<string, string>;
    [key: string]: unknown;
}

const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Manifest;
const catalog = () =>
    (readJson(path.join(root, "package.json")) as unknown as { catalog: Record<string, string> })
        .catalog;
const WORKSPACE = /^@launchpad-kit\//;

// What a package needs at run time from outside this repository, following workspace packages
// that get bundled into it. Versions come from the root catalog.
export function thirdPartyDependencies(
    dir: string,
    resolveWorkspace: (name: string) => Manifest,
): Record<string, string> {
    const versions = catalog();
    const found: Record<string, string> = {};
    const seen = new Set<string>();
    const visit = (manifest: Manifest) => {
        for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
            if (WORKSPACE.test(name)) {
                if (!seen.has(name)) {
                    seen.add(name);
                    visit(resolveWorkspace(name));
                }
            } else {
                const version = spec === "catalog:" ? versions[name] : spec;
                if (!version) throw new Error(`${name} has no version in the root catalog.`);
                found[name] = version;
            }
        }
    };
    visit(readJson(path.join(root, dir, "package.json")));
    return found;
}

const byName = (name: string): Manifest => {
    for (const target of TARGETS) {
        const manifest = readJson(path.join(root, target.dir, "package.json"));
        if (manifest.name === name) return manifest;
    }
    // A workspace package that is bundled into an app but not published itself (client-core).
    const dir = path.join(root, "packages", name.replace(WORKSPACE, ""));
    return readJson(path.join(dir, "package.json"));
};

async function run(command: string[], cwd: string) {
    const proc = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    if (code !== 0) {
        throw new Error(`${command.join(" ")} failed (${code}) in ${cwd}:\n${out}\n${err}`);
    }
    return out;
}

export async function build(target: Target) {
    await run(["bun", "run", "build"], path.join(root, target.dir));
}

// The declarations are emitted with extensionless relative imports (`from "./client"`), which
// TypeScript's node16 and nodenext resolution refuses: a published declaration must name the
// file the way it will be resolved, as `./client.js` (or `./dir/index.js`).
export function withExtensions(text: string, exists: (relative: string) => "file" | "dir" | null) {
    return text.replace(
        /(\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"']+)\2/g,
        (match, lead, quote, spec) => {
            if (/\.[cm]?[jt]s$/.test(spec) || spec.endsWith(".json")) return match;
            const kind = exists(spec);
            if (kind === "file") return `${lead}${quote}${spec}.js${quote}`;
            if (kind === "dir") return `${lead}${quote}${spec}/index.js${quote}`;
            return match;
        },
    );
}

// Copies the built library, leaving out the declaration files of tests.
function copyLibraryDist(from: string, to: string) {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from, { withFileTypes: true })) {
        if (entry.name === "__tests__" || entry.name.endsWith(".spec.d.ts")) continue;
        if (entry.isDirectory())
            copyLibraryDist(path.join(from, entry.name), path.join(to, entry.name));
        else if (entry.name.endsWith(".d.ts")) {
            const text = readFileSync(path.join(from, entry.name), "utf8");
            writeFileSync(
                path.join(to, entry.name),
                withExtensions(text, (spec) => {
                    const resolved = path.join(from, spec);
                    if (existsSync(`${resolved}.d.ts`)) return "file";
                    if (existsSync(path.join(resolved, "index.d.ts"))) return "dir";
                    return null;
                }),
            );
        } else cpSync(path.join(from, entry.name), path.join(to, entry.name));
    }
}

// Everything that must stay out of a bundle because it is installed from the registry instead.
export function externalsFor(dependencies: Record<string, string>): string[] {
    return Object.keys(dependencies).flatMap((name) => [name, `${name}/*`]);
}

export async function stage(target: Target, outDir: string): Promise<string> {
    const source = path.join(root, target.dir);
    const manifest = readJson(path.join(source, "package.json"));
    const stageDir = path.join(outDir, "stage", manifest.name.replace("@", "").replace("/", "-"));
    rmSync(stageDir, { recursive: true, force: true });
    mkdirSync(stageDir, { recursive: true });
    const common = {
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        type: "module",
        // The bundles depend on commander 15, which needs Node 22.12 or newer.
        engines: { node: ">=22.12" },
    };
    const readme = path.join(source, "README.md");
    if (existsSync(readme)) cpSync(readme, path.join(stageDir, "README.md"));

    if (target.kind === "library") {
        copyLibraryDist(path.join(source, "dist"), stageDir);
        // The workspace dependency is the other published library; the rest is from the registry.
        const dependencies: Record<string, string> = {};
        for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
            if (WORKSPACE.test(name)) {
                if (
                    !TARGETS.some(
                        (t) => readJson(path.join(root, t.dir, "package.json")).name === name,
                    )
                ) {
                    throw new Error(`${manifest.name} depends on ${name}, which is not packed.`);
                }
                dependencies[name] = `^${byName(name).version}`;
                continue;
            }
            const version = spec === "catalog:" ? catalog()[name] : spec;
            if (!version) throw new Error(`${name} has no version in the root catalog.`);
            dependencies[name] = version;
        }
        writeFileSync(
            path.join(stageDir, "package.json"),
            `${JSON.stringify(
                {
                    ...common,
                    main: "./index.mjs",
                    types: "./index.d.ts",
                    exports: {
                        ".": {
                            types: "./index.d.ts",
                            import: "./index.mjs",
                            default: "./index.mjs",
                        },
                    },
                    sideEffects: false,
                    files: ["*.mjs", "*.d.ts", "**/*.d.ts", "README.md"],
                    dependencies,
                },
                null,
                2,
            )}\n`,
        );
    } else {
        const bin = target.bin!;
        const dependencies = thirdPartyDependencies(target.dir, byName);
        const args = [
            "bun",
            "build",
            "src/index.ts",
            "--target=node",
            "--format=esm",
            "--env=disable",
            `--outfile=${path.join(stageDir, bin.file)}`,
            ...externalsFor(dependencies).flatMap((name) => ["--external", name]),
        ];
        await run(args, source);
        const file = path.join(stageDir, bin.file);
        const text = readFileSync(file, "utf8").replace(/^#!.*\n/, "");
        writeFileSync(file, `#!/usr/bin/env node\n${text}`);
        chmodSync(file, 0o755);
        writeFileSync(
            path.join(stageDir, "package.json"),
            `${JSON.stringify(
                {
                    ...common,
                    bin: { [bin.name]: `./${bin.file}` },
                    files: [bin.file, "README.md"],
                    dependencies,
                },
                null,
                2,
            )}\n`,
        );
    }
    return stageDir;
}

// Writes the tarball and returns its path.
export async function pack(stageDir: string, destination: string): Promise<string> {
    mkdirSync(destination, { recursive: true });
    const name = (
        await run(["bun", "pm", "pack", "--quiet", "--destination", destination], stageDir)
    ).trim();
    return path.join(destination, path.basename(name));
}

// A package holds its manifest, its README and built files, nothing else: an allowlist, so a file
// nobody thought of (a key, an npmrc, a stray archive) is refused rather than shipped.
const ALLOWED_PATH = [
    /^package\.json$/,
    /^README\.md$/,
    /^[A-Za-z0-9_-]+\.mjs$/,
    /^([A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.d\.ts$/,
];
const FORBIDDEN_PATH = [/\.spec\./, /(^|\/)__tests__\//];

// Problems with what a tarball contains (file paths relative to the package root).
export function checkListing(files: string[]): string[] {
    const problems: string[] = [];
    for (const file of files) {
        if (
            FORBIDDEN_PATH.some((pattern) => pattern.test(file)) ||
            !ALLOWED_PATH.some((p) => p.test(file))
        ) {
            problems.push(`${file}: must not be packed`);
        }
    }
    if (!files.includes("package.json")) problems.push("package.json is missing");
    return problems;
}

// Problems with a packed manifest.
export function checkManifest(manifest: Record<string, unknown>): string[] {
    const problems: string[] = [];
    if (manifest.private === true) problems.push("the manifest is private");
    if (!manifest.name || !manifest.version) problems.push("name or version is missing");
    for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
        const deps = (manifest[key] ?? {}) as Record<string, string>;
        for (const [name, spec] of Object.entries(deps)) {
            if (/^(workspace|catalog|link|file|git|github|http|https|npm):|^git\+/.test(spec)) {
                problems.push(
                    `${key}.${name} is "${spec}", which only works inside the repository`,
                );
            }
        }
    }
    if (manifest.devDependencies) problems.push("devDependencies must not be packed");
    return problems;
}
