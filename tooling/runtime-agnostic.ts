// The npm packages run on Node as well as Bun, so their source may not use an API only Bun has.
// Code bundled into the Docker images (controller, worker, router, ...) is not covered.
// Which packages: the ones tooling/package-clients.ts packs, plus client-core, which is bundled
// into the CLI and the MCP server. See docs/releasing.md.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { TARGETS } from "./package-clients";

export const PUBLISHED_DIRS = [...TARGETS.map((target) => target.dir), "packages/client-core"];

// `import.meta.dirname` and `.filename` are fine: Node has them since 20.11.
export const BUN_ONLY: { pattern: RegExp; what: string }[] = [
    { pattern: /(?<![\w.])Bun\b(?!\w)(?!\s*:)/, what: "the Bun global" },
    { pattern: /\bglobalThis\.Bun\b/, what: "globalThis.Bun" },
    { pattern: /["'`]bun(?::[\w/.-]*)?["'`]/, what: 'a "bun" or "bun:*" module specifier' },
    { pattern: /\bprocess\.versions\.bun\b/, what: "process.versions.bun" },
    { pattern: /\bimport\.meta\.(?:dir|file|path)\b/, what: "a Bun-only import.meta property" },
];

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const TEST = /\.(?:spec|test)\.[cm]?[jt]sx?$/;

function* sources(dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name !== "__tests__" && entry.name !== "node_modules") yield* sources(file);
        } else if (SOURCE.test(entry.name) && !TEST.test(entry.name)) yield file;
    }
}

// Problems as "file:line: message" for one file's text.
export function scan(file: string, text: string): string[] {
    const problems: string[] = [];
    let inBlock = false;
    text.split("\n").forEach((line, index) => {
        const trimmed = line.trim();
        if (inBlock) {
            inBlock = !trimmed.includes("*/");
            return;
        }
        if (trimmed.startsWith("/*")) inBlock = !trimmed.includes("*/");
        if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) return;
        for (const { pattern, what } of BUN_ONLY) {
            if (pattern.test(line)) {
                problems.push(`${file}:${index + 1}: ${what}; the npm packages must run on Node`);
            }
        }
    });
    return problems;
}

export function checkRuntimeAgnostic(root: string, dirs = PUBLISHED_DIRS): string[] {
    const problems: string[] = [];
    for (const dir of dirs) {
        const src = path.join(root, dir, "src");
        if (!existsSync(src)) {
            problems.push(`${dir}/src does not exist`);
            continue;
        }
        for (const file of sources(src)) {
            problems.push(...scan(path.relative(root, file), readFileSync(file, "utf8")));
        }
    }
    return problems;
}

if (import.meta.main) {
    const problems = checkRuntimeAgnostic(path.resolve(import.meta.dirname, ".."));
    if (problems.length > 0) {
        console.error(problems.join("\n"));
        process.exit(1);
    }
    console.log(`The published packages use no Bun-only API (${PUBLISHED_DIRS.join(", ")}).`);
}
