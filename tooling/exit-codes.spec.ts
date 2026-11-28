import { afterEach, describe, expect, it } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkVersions, workspaces } from "./versions";

const root = path.resolve(import.meta.dirname, "..");

function run(script: string, ...args: string[]) {
    const proc = Bun.spawnSync(["bun", path.join(root, "tooling", script), ...args], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
    });
    return {
        code: proc.exitCode,
        out: proc.stdout.toString(),
        err: proc.stderr.toString(),
    };
}

describe("test-db.ts", () => {
    for (const args of [[], ["restart"]]) {
        it(`exits 2 with the usage text for ${JSON.stringify(args)}`, () => {
            const result = run("test-db.ts", ...args);
            expect(result.code).toBe(2);
            expect(result.err.trim()).toBe("Usage: bun tooling/test-db.ts up|down");
            expect(result.out).toBe("");
        });
    }
});

describe("versions.ts", () => {
    const usage = "usage: bun tooling/versions.ts sync <package|core> <version> | check";
    for (const args of [["sync"], ["sync", "a"], ["bump"], []]) {
        it(`exits 2 with the usage line for ${JSON.stringify(args)}`, () => {
            const result = run("versions.ts", ...args);
            expect(result.code).toBe(2);
            expect(result.err.trim()).toBe(usage);
        });
    }

    // Stricter than the hand parser, which ignored extra options after `check` and took
    // `--foo` as the version of `sync a`.
    for (const args of [
        ["check", "--foo"],
        ["check", "-x"],
        ["sync", "a", "--foo"],
    ]) {
        it(`exits 2 with the usage line for ${JSON.stringify(args)}`, () => {
            const result = run("versions.ts", ...args);
            expect(result.code).toBe(2);
            expect(result.err.trim()).toBe(usage);
        });
    }

    it("exits 0 for check on the repository", () => {
        const result = run("versions.ts", "check");
        expect(result.code).toBe(0);
        expect(result.out.trim()).toBe("Versions agree.");
    });

    describe("checkVersions", () => {
        const copies: string[] = [];
        afterEach(() => {
            for (const copy of copies.splice(0)) rmSync(copy, { recursive: true, force: true });
        });

        it("reports a problem when one version differs", () => {
            const copy = mkdtempSync(path.join(tmpdir(), "launchpad-exit-versions-"));
            copies.push(copy);
            const files = [
                "package.json",
                "cog.toml",
                "bun.lock",
                ...workspaces(root)
                    .filter((w) => w.dir !== ".")
                    .map((w) => path.posix.join(w.dir, "package.json")),
            ];
            for (const file of files) {
                mkdirSync(path.dirname(path.join(copy, file)), { recursive: true });
                cpSync(path.join(root, file), path.join(copy, file));
            }
            expect(checkVersions(copy)).toEqual([]);
            const manifest = path.join(copy, "package.json");
            writeFileSync(
                manifest,
                readFileSync(manifest, "utf8").replace(/"version": "[^"]*"/, '"version": "9.9.9"'),
            );
            expect(checkVersions(copy).length).toBeGreaterThan(0);
        });
    });
});

// Every case below is refused while the arguments are parsed or checked, before any package is
// built or any folder is written. An unknown option is always paired with an output name the
// script refuses, so even if the rejection regressed the run would still stop at that refusal
// instead of starting a rehearsal; the assertion on the message tells the two apart.
describe("release-dry-run.ts", () => {
    it("refuses an output folder with the wrong name and exits 1", () => {
        const result = run("release-dry-run.ts", "not-the-right-name");
        expect(result.code).toBe(1);
        expect(result.err).toContain("its name must contain release-dry-run");
        expect(result.out).toBe("");
    });

    it("rejects an unknown option and exits 1", () => {
        for (const flag of ["--bogus", "-x", "-h"]) {
            const result = run("release-dry-run.ts", "not-the-right-name", flag);
            expect(result.code).toBe(1);
            expect(result.err).toContain(`Unknown option ${flag}.`);
            expect(result.out).toBe("");
        }
    });

    it("prints the usage and exits 0 for --help", () => {
        const result = run("release-dry-run.ts", "--help");
        expect(result.code).toBe(0);
        expect(result.out).toContain(
            "Usage: bun tooling/release-dry-run.ts [outDir] [--skip-images]",
        );
        expect(result.err).toBe("");
    });
});
