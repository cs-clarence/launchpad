// Stages and packs the client packages that users install: contracts, the SDK and client-core as
// libraries, and the CLI and the MCP server as executables (one built file each). No package
// bundles another or any dependency: every dependency is declared and installed from the
// registry. Nothing here publishes or registers anything: the output is tarballs in a directory
// the caller names.
//
// The workspace packages stay private, with `exports` that point at source for development.
// What is packed is a separate, generated manifest that points at built files, so the source
// tree never has to be shaped for the registry. See docs/releasing.md.
import { builtinModules } from "node:module";
import { createHash } from "node:crypto";
import {
    chmodSync,
    cpSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import path from "node:path";
import ts from "@typescript/typescript6";
import { scriptKind, syntaxProblems } from "./ts-scan";

export interface Target {
    dir: string;
    // An executable: the command name and the built file (in `dist`) it runs. Without it, a library.
    bin?: { name: string; file: string };
}

// Order matters: a package's tarball is needed by the ones that depend on it.
export const TARGETS: Target[] = [
    { dir: "packages/contracts" },
    { dir: "packages/sdk" },
    { dir: "packages/client-core" },
    { dir: "apps/cli", bin: { name: "launchpad", file: "cli.mjs" } },
    { dir: "apps/mcp", bin: { name: "launchpad-mcp", file: "mcp.mjs" } },
];

export const SHEBANG = "#!/usr/bin/env node";

const root = path.resolve(import.meta.dirname, "..");

// An absolute path to the Node named by `selected` (a path, or a bare name looked up on `searchPath`),
// or null when there is none.
export function findNode(selected: string, searchPath: string | undefined): string | null {
    return selected.includes("/")
        ? existsSync(selected)
            ? selected
            : null
        : Bun.which(selected, { PATH: searchPath });
}

// A directory holding a `node` link to `executable`, for the front of a child's PATH: a bin's
// `#!/usr/bin/env node` finds the selected Node even when it is not called `node`.
export function nodeShim(executable: string, dir: string): string {
    mkdirSync(dir, { recursive: true });
    symlinkSync(executable, path.join(dir, "node"));
    return dir;
}

// The Node the smoke runs under: LAUNCHPAD_NODE, else `node` looked up on the PATH. A value with a
// slash is a path and is made absolute against `cwd` (the caller's directory, not a temporary
// one); a bare name stays a PATH lookup.
export function resolveNode(value: string | undefined, cwd: string): string {
    if (!value) return "node";
    return value.includes("/") ? path.resolve(cwd, value) : value;
}

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

const byName = (name: string): Manifest => {
    for (const target of TARGETS) {
        const manifest = readJson(path.join(root, target.dir, "package.json"));
        if (manifest.name === name) return manifest;
    }
    throw new Error(`${name} is not one of the packed packages.`);
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
    // `--bun` makes the build scripts' `#!/usr/bin/env node` tools (vite, tsc) run on Bun, so a
    // build never depends on the Node on the PATH (22.12 cannot load the TypeScript vite config).
    // Only the runs of the packed files use the selected Node.
    await run(["bun", "--bun", "run", "build"], path.join(root, target.dir));
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

// Copies the built executable byte for byte, after checking it starts with the Node shebang (the
// build keeps the one in the source), and makes it executable: the build writes mode 644.
export function stageExecutable(from: string, to: string) {
    const text = readFileSync(from, "utf8");
    if (text.split("\n", 1)[0] !== SHEBANG) {
        throw new Error(`${from} must start with "${SHEBANG}" on its first line.`);
    }
    mkdirSync(path.dirname(to), { recursive: true });
    cpSync(from, to);
    chmodSync(to, 0o755);
}

// What a package needs at run time: its own dependencies, with a workspace package as a caret
// range of the version it is packed at and the rest from the root catalog.
export function packedDependencies(
    manifest: Manifest,
    packed: (name: string) => Manifest | undefined,
    versions: Record<string, string>,
): Record<string, string> {
    const dependencies: Record<string, string> = {};
    for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
        if (WORKSPACE.test(name)) {
            const other = packed(name);
            if (!other)
                throw new Error(`${manifest.name} depends on ${name}, which is not packed.`);
            dependencies[name] = `^${other.version}`;
            continue;
        }
        const version = spec === "catalog:" ? versions[name] : spec;
        if (!version) throw new Error(`${name} has no version in the root catalog.`);
        dependencies[name] = version;
    }
    return dependencies;
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
        // commander 15 (the CLI and the MCP server) and tar (client-core) need Node 22.12 or newer.
        engines: { node: ">=22.12" },
    };
    const readme = path.join(source, "README.md");
    if (existsSync(readme)) cpSync(readme, path.join(stageDir, "README.md"));

    const dependencies = packedDependencies(
        manifest,
        (name) => {
            try {
                return byName(name);
            } catch {
                return undefined;
            }
        },
        catalog(),
    );
    if (target.bin) {
        const bin = target.bin;
        stageExecutable(path.join(source, "dist", bin.file), path.join(stageDir, bin.file));
        // No `main`, `types` or `exports`: an executable is run, not imported.
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
    } else {
        copyLibraryDist(path.join(source, "dist"), stageDir);
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
const FORBIDDEN_PATH = [/\.spec\./, /(^|\/)__tests__\//, /\.map$/, /(^|\/)node_modules\//];

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

// A library tarball (no `bin`) holds its manifest, README and built files, and its entry points.
// Anything else (sources, tests, tsconfig*, vite or vitest configs, project files) is a leak.
export function checkLibrary(manifest: Record<string, unknown>, files: string[]): string[] {
    if (manifest.bin) return [];
    const problems: string[] = [];
    for (const required of ["README.md", "index.mjs", "index.d.ts"]) {
        if (!files.includes(required)) problems.push(`${required} is missing`);
    }
    for (const file of files) {
        if (/\.(spec|test)\./.test(file) || /(^|\/)node_modules\//.test(file)) {
            problems.push(`${file}: tests and dependencies are not packed`);
        }
        if (file !== "package.json" && file !== "README.md" && !/\.(mjs|d\.ts)$/.test(file)) {
            problems.push(`${file}: a library package holds only built files and its README`);
        }
        if (
            /(^|\/)(src|tsconfig[^/]*|vite[^/]*|vitest[^/]*|project\.omni\.yaml)(\/|$)/.test(file)
        ) {
            problems.push(`${file}: development file`);
        }
    }
    return problems;
}

// Problems with a packed manifest.
export function checkManifest(manifest: Record<string, unknown>): string[] {
    const problems: string[] = [];
    if (manifest.private === true) problems.push("the manifest is private");
    if (!manifest.name || !manifest.version) problems.push("name or version is missing");
    for (const key of DEPENDENCY_KEYS) {
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
    // Source-manifest fields that would change resolution or install behaviour, or bundle code.
    for (const key of [
        "bundledDependencies",
        "bundleDependencies",
        "publishConfig",
        "scripts",
        "workspaces",
        "overrides",
    ]) {
        if (key in manifest) problems.push(`${key} must not be packed`);
    }
    return problems;
}

const DEPENDENCY_KEYS = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
];

// What the published set must look like as a whole: one version, every internal reference the
// caret range of it (so a 0.x install allows patch drift only), every third-party package at one
// range, and nothing but the five packages under our scope.
export function checkClosure(manifests: Record<string, unknown>[]): string[] {
    const problems: string[] = [];
    const names = new Set(manifests.map((m) => String(m.name)));
    const versions = new Set(manifests.map((m) => String(m.version)));
    if (versions.size > 1) {
        problems.push(`the packages carry different versions: ${[...versions].join(", ")}`);
    }
    const lockstep = [...versions][0];
    const ranges = new Map<string, Map<string, string[]>>();
    for (const manifest of manifests) {
        for (const key of DEPENDENCY_KEYS) {
            const deps = (manifest[key] ?? {}) as Record<string, string>;
            for (const [name, spec] of Object.entries(deps)) {
                if (WORKSPACE.test(name)) {
                    if (!names.has(name)) {
                        problems.push(
                            `${manifest.name}: ${key}.${name} is not a published package`,
                        );
                    } else if (spec !== `^${lockstep}`) {
                        problems.push(
                            `${manifest.name}: ${key}.${name} is "${spec}", not "^${lockstep}"`,
                        );
                    }
                } else {
                    const bySpec = ranges.get(name) ?? new Map<string, string[]>();
                    bySpec.set(spec, [...(bySpec.get(spec) ?? []), String(manifest.name)]);
                    ranges.set(name, bySpec);
                }
            }
        }
    }
    for (const [name, bySpec] of ranges) {
        if (bySpec.size > 1) {
            const shown = [...bySpec].map(([spec, who]) => `${spec} (${who.join(", ")})`);
            problems.push(
                `${name} has different ranges in the published packages: ${shown.join("; ")}`,
            );
        }
    }
    return problems;
}

// A string only the implementation of each dependency holds: if one turns up in a package that is
// not that dependency, the dependency was bundled into it. A spec checks each is still in the
// dependency, so a stale marker fails loudly.
export const MARKERS: Record<string, string> = {
    "@launchpad-kit/client-core": "A field is nested too deeply.",
    "@launchpad-kit/contracts": "contains control characters",
    "@launchpad-kit/sdk": "it has an encoded separator",
    "@elastic/micro-jq": "PeggySyntaxError",
    "@modelcontextprotocol/sdk": "already registered",
    commander: "commander.invalidArgument",
    picomatch: "Expected pattern to be a non-empty string",
    tar: "Unrecognized archive format",
    zod: "$ZodStringFormat",
};

// What each executable's `.mjs` measured when the budgets were set (bytes).
export const MEASURED_SIZES: Record<string, number> = {
    "@launchpad-kit/cli": 62_972,
    "@launchpad-kit/mcp": 8_406,
};

// The rule: the measured size plus 25 %, rounded up to the next kB. An inlined dependency is far
// larger than the headroom; real growth raises the measured size (and so the budget) in review.
export const budgetFor = (measured: number) => Math.ceil((measured * 1.25) / 1000) * 1000;

export const SIZE_BUDGETS: Record<string, number> = Object.fromEntries(
    Object.entries(MEASURED_SIZES).map(([name, size]) => [name, budgetFor(size)]),
);

// Everything that shows a package bundles what it should import: an import of a package it does
// not declare (`.mjs` and `.d.ts`), a size over its budget, or a dependency's marker in its files.
export function checkUnbundled(
    manifest: { name?: string; dependencies?: Record<string, string> },
    files: Record<string, string>,
    markers: Record<string, string> = MARKERS,
): string[] {
    const problems = checkBareImports(manifest, files);
    const budget = manifest.name ? SIZE_BUDGETS[manifest.name] : undefined;
    if (budget !== undefined) {
        const size = Object.entries(files)
            .filter(([file]) => file.endsWith(".mjs"))
            .reduce((sum, [, text]) => sum + Buffer.byteLength(text), 0);
        if (size > budget) {
            problems.push(
                `${size} bytes of .mjs is over the budget of ${budget}: is a dependency bundled?`,
            );
        }
    }
    for (const [file, text] of Object.entries(files)) {
        if (!/\.(mjs|d\.ts)$/.test(file)) continue;
        for (const [name, marker] of Object.entries(markers)) {
            if (name !== manifest.name && text.includes(marker)) {
                problems.push(`${file} contains code of ${name}: it must be imported, not bundled`);
            }
        }
    }
    return problems;
}

// The package a bare specifier names: `@scope/name` or `name`, without a subpath.
const packageOf = (specifier: string) =>
    specifier.startsWith("@")
        ? specifier.split("/").slice(0, 2).join("/")
        : specifier.split("/", 1)[0]!;

// Every module specifier a built file refers to: `import ... from`, `import "x"`, `import("x")`,
// `export ... from`, `import x = require("x")`, `require("x")` and `/// <reference types>`.
export function specifiers(
    file: string,
    text: string,
): { specifiers: string[]; problems: string[] } {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
    const found: string[] = source.typeReferenceDirectives.map((d) => d.fileName);
    const add = (node: ts.Node | undefined) => {
        if (node && ts.isStringLiteralLike(node)) found.push(node.text);
    };
    const visit = (node: ts.Node) => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
        else if (ts.isImportEqualsDeclaration(node)) {
            if (ts.isExternalModuleReference(node.moduleReference))
                add(node.moduleReference.expression);
        } else if (ts.isImportTypeNode(node)) {
            if (ts.isLiteralTypeNode(node.argument)) add(node.argument.literal);
        } else if (
            ts.isCallExpression(node) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                (ts.isIdentifier(node.expression) && node.expression.text === "require"))
        ) {
            add(node.arguments[0]);
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return { specifiers: found, problems: syntaxProblems(source, file) };
}

const BUILTINS = new Set(builtinModules.filter((name) => !name.startsWith("bun")));

// A built file (`.mjs` or `.d.ts`) imports only Node, itself and what its package declares:
// anything else was inlined or is missing from the manifest (`files` maps a path in the package to its text).
export function checkBareImports(
    manifest: {
        name?: string;
        dependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
    },
    files: Record<string, string>,
): string[] {
    const declared = new Set(
        Object.keys({
            ...manifest.dependencies,
            ...manifest.peerDependencies,
            ...manifest.optionalDependencies,
        }),
    );
    const problems: string[] = [];
    for (const [file, text] of Object.entries(files)) {
        if (!/\.(mjs|d\.ts)$/.test(file)) continue;
        const scanned = specifiers(file, text);
        problems.push(...scanned.problems);
        for (const specifier of new Set(scanned.specifiers)) {
            if (/^(\.{0,2}\/|\.{1,2}$)/.test(specifier)) continue;
            if (specifier.startsWith("node:")) continue;
            const name = packageOf(specifier);
            if (BUILTINS.has(specifier) || BUILTINS.has(name)) continue;
            if (!declared.has(name)) {
                problems.push(
                    `${file} imports "${specifier}", which ${manifest.name ?? "the package"} does not declare`,
                );
            }
        }
    }
    return problems;
}

// What a tarball holds: its files (relative to the package root), its manifest and the text of
// every built `.mjs` and `.d.ts` file.
export async function readPacked(tarball: string) {
    const listing = (await run(["tar", "tzf", tarball], path.dirname(tarball)))
        .split("\n")
        .filter(Boolean)
        .map((line) => line.replace(/^package\//, ""));
    const text: Record<string, string> = {};
    for (const file of listing) {
        if (/\.(mjs|d\.ts)$/.test(file) || file === "package.json") {
            text[file] = await run(
                ["tar", "xzOf", tarball, `package/${file}`],
                path.dirname(tarball),
            );
        }
    }
    return { listing, manifest: JSON.parse(text["package.json"] ?? "{}") as Manifest, text };
}

// An executable's manifest names its commands as an object that points at packed files, and it
// is not importable: no `main`, `types` or `exports`. A library has no `bin`.
export function checkBin(manifest: Record<string, unknown>, files: string[]): string[] {
    const problems: string[] = [];
    const bin = manifest.bin;
    if (bin === undefined) return problems;
    if (typeof bin !== "object" || bin === null || Array.isArray(bin)) {
        return ["bin must be an object of command names"];
    }
    for (const [name, file] of Object.entries(bin)) {
        if (typeof file !== "string" || !files.includes(file.replace(/^\.\//, ""))) {
            problems.push(`bin.${name} is not a packed file`);
        }
    }
    for (const key of ["main", "types", "exports"]) {
        if (key in manifest) problems.push(`an executable has no "${key}"`);
    }
    return problems;
}

// The npm side of an install of the packed tarballs. `lock` is the package-lock.json npm wrote,
// `expected` what was packed: each owned package must be recorded as the local tarball (a
// `file:` path) with the SHA-512 of that exact file, never a name resolved from a registry.
export function checkLock(
    lock: {
        packages?: Record<string, { version?: string; resolved?: string; integrity?: string }>;
    },
    expected: { name: string; version: string; file: string; bytes: Uint8Array }[],
): string[] {
    const problems: string[] = [];
    for (const { name, version, file, bytes } of expected) {
        const entry = lock.packages?.[`node_modules/${name}`];
        if (!entry) {
            problems.push(`${name}: not in the lockfile`);
            continue;
        }
        if (entry.version !== version) {
            problems.push(`${name}: locked at ${entry.version}, packed at ${version}`);
        }
        if (!entry.resolved?.startsWith("file:") || !entry.resolved.endsWith(path.basename(file))) {
            problems.push(`${name}: resolved to ${entry.resolved}, not the local tarball`);
        }
        const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
        if (entry.integrity !== integrity) {
            problems.push(`${name}: integrity ${entry.integrity} is not that of the tarball`);
        }
    }
    return problems;
}

interface LsNode {
    invalid?: unknown;
    missing?: unknown;
    problems?: string[];
    dependencies?: Record<string, LsNode>;
}

// Problems `npm ls --all --json` reports (it is parsed even when npm exits non-zero).
export function checkLs(tree: LsNode): string[] {
    const problems: string[] = [];
    const visit = (node: LsNode, trail: string) => {
        if (node.invalid) problems.push(`${trail} is invalid`);
        if (node.missing) problems.push(`${trail} is missing`);
        for (const p of node.problems ?? []) problems.push(`${trail}: ${p}`);
        for (const [name, child] of Object.entries(node.dependencies ?? {})) {
            visit(child, `${trail} > ${name}`);
        }
    };
    visit(tree, "consumer");
    return problems;
}

// Every place under `nodeModules` where a package of our scope is installed, by name: more than
// one for a name is two copies in one tree.
export function installedCopies(nodeModules: string): Record<string, string[]> {
    const found: Record<string, string[]> = {};
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const full = path.join(dir, entry.name);
            if (entry.name === "@launchpad-kit") {
                for (const own of readdirSync(full, { withFileTypes: true })) {
                    const name = `@launchpad-kit/${own.name}`;
                    (found[name] ??= []).push(path.join(full, own.name));
                    const nested = path.join(full, own.name, "node_modules");
                    if (existsSync(nested)) walk(nested);
                }
            } else if (entry.name.startsWith("@") || entry.name === "node_modules") {
                walk(full);
            } else if (existsSync(path.join(full, "node_modules"))) {
                walk(path.join(full, "node_modules"));
            }
        }
    };
    walk(nodeModules);
    return found;
}

// An absolute path to npm: the one beside the selected Node (a Node and its npm are one
// release), else the first on the PATH, else null.
export function findNpm(
    nodeExecutable: string | null,
    searchPath: string | undefined,
): string | null {
    if (nodeExecutable) {
        const beside = path.join(path.dirname(nodeExecutable), "npm");
        if (existsSync(beside)) return beside;
    }
    return Bun.which("npm", { PATH: searchPath });
}
