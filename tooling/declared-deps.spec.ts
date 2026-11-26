import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PACKAGES = ["commander", "@commander-js/extra-typings"];
const IMPORT =
    /(?:from\s+|import\s*\(\s*|import\s+|require\(\s*)["'](commander|@commander-js\/extra-typings)["']/g;

// Tracked sources only: node_modules and generated output are never in the index.
function sourceFiles(): string[] {
    const listed = Bun.spawnSync(["git", "ls-files", "-z", "--", "*.ts", "*.tsx", "*.mjs"], {
        cwd: ROOT,
        stdout: "pipe",
    }).stdout.toString();
    return listed
        .split("\0")
        .filter(
            (file) =>
                file !== "" && !file.startsWith(".agents/") && existsSync(path.join(ROOT, file)),
        );
}

function nearestManifest(file: string): string {
    let dir = path.dirname(path.join(ROOT, file));
    while (!existsSync(path.join(dir, "package.json"))) dir = path.dirname(dir);
    return path.join(dir, "package.json");
}

function declared(manifest: string): Set<string> {
    const json = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>;
    const names = new Set<string>();
    for (const key of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
    ]) {
        for (const name of Object.keys((json[key] as Record<string, string> | undefined) ?? {})) {
            names.add(name);
        }
    }
    return names;
}

describe("commander declaration", () => {
    it("is declared by the manifest of every file that imports it", () => {
        const missing: string[] = [];
        for (const file of sourceFiles()) {
            const text = readFileSync(path.join(ROOT, file), "utf8");
            const names = new Set([...text.matchAll(IMPORT)].map((match) => match[1]!));
            if (names.size === 0) continue;
            const manifest = nearestManifest(file);
            const have = declared(manifest);
            for (const name of names) {
                if (!have.has(name))
                    missing.push(
                        `${file} imports ${name}; ${path.relative(ROOT, manifest)} does not declare it`,
                    );
            }
        }
        expect(missing).toEqual([]);
    });

    it("is declared at the root for the tooling scripts", () => {
        const have = declared(path.join(ROOT, "package.json"));
        for (const name of PACKAGES) expect(have.has(name)).toBe(true);
    });
});
