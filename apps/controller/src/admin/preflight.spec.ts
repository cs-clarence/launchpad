import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { countOrphanedArchives } from "./preflight";

const OWNER = "a".repeat(32);
const DIGEST = "b".repeat(64);
let dir: string;
beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "preflight-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const archive = (owner = OWNER, name = `${DIGEST}.tar.gz`) => {
    mkdirSync(path.join(dir, "artifacts", owner), { recursive: true });
    writeFileSync(path.join(dir, "artifacts", owner, name), "x");
};

describe("countOrphanedArchives", () => {
    it("counts 0 for a missing data directory and for an empty artifacts directory", async () => {
        expect(await countOrphanedArchives(path.join(dir, "nope"))).toBe(0);
        expect(await countOrphanedArchives(dir)).toBe(0);
        mkdirSync(path.join(dir, "artifacts"));
        expect(await countOrphanedArchives(dir)).toBe(0);
    });

    it("finds a stored archive and stops at the limit", async () => {
        archive();
        archive(OWNER, `${"c".repeat(64)}.tar.gz`);
        expect(await countOrphanedArchives(dir)).toBe(1);
        expect(await countOrphanedArchives(dir, 5)).toBe(2);
    });

    it("ignores files that are not stored archives", async () => {
        archive(OWNER, "notes.txt");
        archive("not-an-owner");
        writeFileSync(path.join(dir, "artifacts", "stray.tar.gz"), "x");
        expect(await countOrphanedArchives(dir)).toBe(0);
    });

    it("fails closed on a symbolic link for artifacts or an owner directory", async () => {
        const elsewhere = path.join(dir, "elsewhere");
        mkdirSync(elsewhere);
        const data = path.join(dir, "data");
        mkdirSync(data);
        symlinkSync(elsewhere, path.join(data, "artifacts"));
        await expect(countOrphanedArchives(data)).rejects.toThrow(/not a plain directory/);

        const data2 = path.join(dir, "data2");
        mkdirSync(path.join(data2, "artifacts"), { recursive: true });
        symlinkSync(elsewhere, path.join(data2, "artifacts", OWNER));
        await expect(countOrphanedArchives(data2)).rejects.toThrow(/symbolic link/);
    });

    it("fails closed when artifacts is a file", async () => {
        writeFileSync(path.join(dir, "artifacts"), "x");
        await expect(countOrphanedArchives(dir)).rejects.toThrow(/not a plain directory/);
    });
});
