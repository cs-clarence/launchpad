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

// A built file imports only Node, itself and what its package declares: anything else was
// inlined or is missing from the manifest (`files` maps a path in the package to its text).
export function checkBareImports(
    manifest: {
        name?: string;
        dependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
    },
    files: Record<string, string>,
): string[] {
    const declared = new Set(
        Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }),
    );
    const problems: string[] = [];
    for (const [file, text] of Object.entries(files)) {
        if (!file.endsWith(".mjs")) continue;
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
