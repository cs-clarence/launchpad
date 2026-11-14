// Verifies that dependency declarations agree everywhere they are written down:
// each project's `package.json`, its `project.omni.yaml` dependency graph, the
// imports in its sources, and the root catalog. Run by `omni run check:deps`.
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";

export interface PackageJson {
    name: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    catalog?: Record<string, string>;
    workspaces?: string[];
}

export interface Project {
    dir: string;
    pkg: PackageJson;
    omniName: string | undefined;
    omniDependencies: string[];
}

const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const SKIP_DIRS = new Set(["node_modules", "dist", ".output", ".tanstack", "coverage", ".omni"]);
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;

// The package name an import specifier points at, or null for specifiers that are
// not packages (relative paths, built-ins, Bun and Vite virtual modules).
export function packageOf(specifier: string): string | null {
    if (/^[./#~]/.test(specifier) || specifier.startsWith("@/")) return null;
    if (BUILTINS.has(specifier) || specifier === "bun" || /^(bun|node|virtual):/.test(specifier)) {
        return null;
    }
    const bare = specifier.split("?")[0]!;
    const parts = bare.split("/");
    return bare.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

// Removes comments without touching comment-like text inside string or template
// literals (`"/api/*"` is a string, not the start of a block comment). Strings are
// kept whole: an import specifier is itself a string, and the scan that follows only
// matches the import syntax around it. Regular expression literals are not parsed; a
// quote inside one can mislead the scanner, which is acceptable for dependency checks.
export function stripComments(source: string): string {
    let out = "";
    let i = 0;
    while (i < source.length) {
        const c = source[i]!;
        const next = source[i + 1];
        if (c === '"' || c === "'" || c === "`") {
            let j = i + 1;
            while (j < source.length && source[j] !== c) {
                j += source[j] === "\\" ? 2 : 1;
            }
            out += source.slice(i, j + 1);
            i = j + 1;
        } else if (c === "/" && next === "/") {
            while (i < source.length && source[i] !== "\n") i++;
        } else if (c === "/" && next === "*") {
            const end = source.indexOf("*/", i + 2);
            i = end === -1 ? source.length : end + 2;
            out += " ";
        } else {
            out += c;
            i++;
        }
    }
    return out;
}

export function importedPackages(source: string): Set<string> {
    const found = new Set<string>();
    for (const match of stripComments(source).matchAll(IMPORT)) {
        const name = packageOf(match[1]!);
        if (name) found.add(name);
    }
    return found;
}

function* sourceFiles(dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) yield* sourceFiles(path.join(dir, entry.name));
        } else if (SOURCE.test(entry.name) && !entry.name.endsWith(".d.ts")) {
            yield path.join(dir, entry.name);
        }
    }
}

// Omni accepts a plain list or the `{ append, prepend }` form.
export function omniDependencyNames(value: unknown): string[] {
    if (Array.isArray(value)) return value.map(String);
    if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        return [
            ...(Array.isArray(record.prepend) ? record.prepend : []),
            ...(Array.isArray(record.append) ? record.append : []),
        ].map(String);
    }
    return [];
}

export function loadProjects(root: string): Project[] {
    const rootPkg = JSON.parse(
        readFileSync(path.join(root, "package.json"), "utf8"),
    ) as PackageJson;
    const projects: Project[] = [];
    for (const pattern of rootPkg.workspaces ?? []) {
        const base = path.join(root, pattern.replace(/\/\*$/, ""));
        if (!existsSync(base)) continue;
        for (const entry of readdirSync(base)) {
            const dir = path.join(base, entry);
            if (!statSync(dir).isDirectory() || !existsSync(path.join(dir, "package.json")))
                continue;
            const pkg = JSON.parse(
                readFileSync(path.join(dir, "package.json"), "utf8"),
            ) as PackageJson;
            const omniFile = path.join(dir, "project.omni.yaml");
            const omni = existsSync(omniFile)
                ? (Bun.YAML.parse(readFileSync(omniFile, "utf8")) as Record<string, unknown> | null)
                : null;
            projects.push({
                dir,
                pkg,
                omniName: typeof omni?.name === "string" ? omni.name : undefined,
                omniDependencies: omniDependencyNames(omni?.dependencies),
            });
        }
    }
    return projects;
}

function peerNames(root: string, from: string, dependency: string): string[] {
    for (const base of [from, root]) {
        const file = path.join(base, "node_modules", dependency, "package.json");
        if (existsSync(file)) {
            const meta = JSON.parse(readFileSync(file, "utf8")) as PackageJson;
            return Object.keys(meta.peerDependencies ?? {});
        }
    }
    return [];
}

// Names the generator templates take from the catalog; they are used by packages
// that do not exist yet, so they must stay in the catalog.
function generatorCatalogNames(root: string): Set<string> {
    const names = new Set<string>();
    const dir = path.join(root, "omni", "generators");
    if (!existsSync(dir)) return names;
    const walk = (d: string) => {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.startsWith("package.json")) {
                for (const m of readFileSync(full, "utf8").matchAll(/"([^"]+)":\s*"catalog:"/g)) {
                    names.add(m[1]!);
                }
            }
        }
    };
    walk(dir);
    return names;
}

export function check(root: string): string[] {
    const errors: string[] = [];
    const rootPkg = JSON.parse(
        readFileSync(path.join(root, "package.json"), "utf8"),
    ) as PackageJson;
    const catalog = rootPkg.catalog ?? {};
    const projects = loadProjects(root);
    const workspaceNames = new Set(projects.map((p) => p.pkg.name));
    const catalogUsed = new Set<string>([
        ...Object.keys(rootPkg.dependencies ?? {}),
        ...Object.keys(rootPkg.devDependencies ?? {}),
        ...generatorCatalogNames(root),
    ]);

    for (const project of projects) {
        const label = project.pkg.name;
        const { pkg } = project;
        const declared = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };

        if (project.omniName === undefined) {
            errors.push(`${label}: no project.omni.yaml with a name, so Omni cannot run it`);
        } else if (project.omniName !== pkg.name) {
            errors.push(`${label}: project.omni.yaml names it ${project.omniName}`);
        }

        // 1. The Omni dependency graph must match the workspace dependencies.
        const workspaceDeps = Object.entries(declared)
            .filter(([, v]) => v.startsWith("workspace:"))
            .map(([k]) => k);
        for (const dep of workspaceDeps) {
            if (!workspaceNames.has(dep))
                errors.push(`${label}: workspace dependency ${dep} is not a workspace package`);
            if (!project.omniDependencies.includes(dep)) {
                errors.push(
                    `${label}: depends on ${dep} in package.json but not in project.omni.yaml (Omni would not order its tasks after ${dep})`,
                );
            }
        }
        for (const dep of project.omniDependencies) {
            if (!workspaceDeps.includes(dep)) {
                errors.push(
                    `${label}: project.omni.yaml lists ${dep} but package.json does not depend on it`,
                );
            }
        }

        // 2. Versions come from the catalog or the workspace, nowhere else.
        for (const [dep, spec] of Object.entries(declared)) {
            if (spec === "catalog:") {
                catalogUsed.add(dep);
                if (!(dep in catalog))
                    errors.push(
                        `${label}: ${dep} uses catalog: but is missing from the root catalog`,
                    );
            } else if (!spec.startsWith("workspace:")) {
                errors.push(`${label}: ${dep} is pinned to "${spec}"; use catalog: or workspace:^`);
            }
        }

        // 3. Every imported package is declared; no runtime dependency is dead.
        const imported = new Set<string>();
        for (const file of sourceFiles(project.dir)) {
            for (const name of importedPackages(readFileSync(file, "utf8"))) imported.add(name);
        }
        for (const name of imported) {
            if (name === pkg.name) continue;
            if (!(name in declared))
                errors.push(`${label}: imports ${name} but does not declare it`);
        }
        const peers = new Set(
            Object.keys(pkg.dependencies ?? {}).flatMap((d) => peerNames(root, project.dir, d)),
        );
        for (const dep of Object.keys(pkg.dependencies ?? {})) {
            if (!imported.has(dep) && !peers.has(dep)) {
                errors.push(
                    `${label}: dependencies lists ${dep} but nothing imports it (move it to devDependencies or remove it)`,
                );
            }
        }
    }

    for (const name of Object.keys(catalog)) {
        if (!catalogUsed.has(name))
            errors.push(`root catalog: ${name} is not used by any package or generator template`);
    }
    return errors;
}

if (import.meta.main) {
    const root = path.resolve(import.meta.dirname, "..");
    const errors = check(root);
    if (errors.length > 0) {
        console.error(
            `Dependency check failed (${errors.length}):\n${errors.map((e) => `  - ${e}`).join("\n")}`,
        );
        process.exit(1);
    }
    console.log("Dependencies are consistent.");
}
