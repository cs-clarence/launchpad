import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkOutput, checksumLines, IMAGE_TAG } from "./release-dry-run";

describe("checksumLines", () => {
    it("writes sha256sum format, sorted by name", () => {
        expect(
            checksumLines([
                { name: "b.tgz", digest: "bb" },
                { name: "a.tgz", digest: "aa" },
            ]),
        ).toBe("aa  a.tgz\nbb  b.tgz\n");
    });
});

describe("IMAGE_TAG", () => {
    it("is a valid, short Docker tag whatever the release version", () => {
        expect(IMAGE_TAG).toMatch(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/);
    });
});

describe("checkOutput", () => {
    const base = mkdtempSync(path.join(tmpdir(), "launchpad-dryrun-"));
    const repo = path.join(base, "repo");
    const outside = path.join(base, "outside");
    mkdirSync(repo);
    mkdirSync(outside);
    symlinkSync(outside, path.join(repo, "link"));

    it("accepts a release-dry-run folder inside the repository", () => {
        expect(checkOutput(path.join(repo, ".release-dry-run"), repo)).toBeNull();
        expect(checkOutput(path.join(repo, "x", "my-release-dry-run"), repo)).toBeNull();
    });

    it("refuses the repository, other names and paths outside it", () => {
        expect(checkOutput(repo, repo)).not.toBeNull();
        expect(checkOutput(path.join(repo, "dist"), repo)).not.toBeNull();
        expect(checkOutput(path.join(outside, "release-dry-run"), repo)).not.toBeNull();
    });

    it("refuses a path that reaches outside through a symbolic link", () => {
        expect(checkOutput(path.join(repo, "link", "release-dry-run"), repo)).toContain("symbolic");
        rmSync(base, { recursive: true, force: true });
    });
});
