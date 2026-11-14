import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArchiveError, checkEntryPath, checkNotSecret, validateArchive } from "./archive";
import { SITE, tarBuffer, tarGz, writeBombTarGz, type FixtureEntry } from "./testing/tar-fixtures";

const limits = { maxExpandedBytes: 1024 * 1024, maxEntries: 50, maxDepth: 6 };
let dir = "";
let n = 0;

beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "launchpad-archive-"));
});
afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
});

async function check(bytes: Buffer, overrides = {}) {
    const file = path.join(dir, `a${n++}.tar.gz`);
    await fs.writeFile(file, bytes);
    return validateArchive(file, { ...limits, ...overrides });
}
const rejects = (entries: FixtureEntry[], pattern: RegExp, overrides = {}) =>
    expect(check(tarGz(entries), overrides)).rejects.toThrow(pattern);
const INDEX: FixtureEntry = { name: "index.html", content: "x" };

describe("a valid archive", () => {
    it("is summarized without being extracted", async () => {
        expect(await check(tarGz(SITE))).toEqual({
            entryCount: 3,
            fileCount: 2,
            expandedBytes: "<!doctype html><title>x</title>".length + "console.log(1)".length,
        });
        const before = await fs.readdir(dir);
        await check(tarGz(SITE));
        // Validation writes nothing next to the archive.
        expect((await fs.readdir(dir)).length).toBe(before.length + 1);
    });

    it("accepts ./ prefixes, nested directories and empty files, and ignores the root entry", async () => {
        const summary = await check(
            tarGz([
                { name: "./", type: "dir" },
                { name: "./index.html", content: "x" },
                { name: "./a/b/c.txt", content: "" },
            ]),
        );
        expect(summary).toMatchObject({ entryCount: 2, fileCount: 2 });
    });
});

describe("hostile entries", () => {
    it.each([
        ["a traversal", "../evil.txt", /not a plain relative path/],
        ["a nested traversal", "a/../../evil.txt", /not a plain relative path/],
        ["an absolute path", "/etc/passwd", /absolute/],
        ["a drive path", "C:/windows/x", /absolute/],
        ["a backslash", "a\\b.txt", /backslash/],
        ["a doubled slash", "a//b.txt", /not a plain relative path/],
        ["a dot segment inside", "a/./b.txt", /not a plain relative path/],
        ["a control character", "a\u0007b.txt", /control/],
        ["a bidi override", "a\u202Eb.txt", /control/],
    ])("rejects %s", async (_label, name, pattern) => {
        await rejects([INDEX, { name, content: "x" }], pattern);
    });

    it.each(["symlink", "hardlink"] as const)("rejects a %s", async (type) => {
        await rejects(
            [INDEX, { name: "link", type, link: "/etc/passwd" }],
            /only files and directories are allowed/,
        );
    });

    // The strict parser refuses these as malformed before they become entries.
    it.each(["char", "block", "fifo"] as const)("rejects a %s device entry", async (type) => {
        await rejects([INDEX, { name: "dev", type }], /only files and directories|malformed/);
    });

    it("rejects secrets by name, directory and extension", async () => {
        for (const name of [
            ".env",
            ".env.production",
            "site/.env.local",
            ".git/config",
            "app/.git/HEAD",
            ".ssh/id_rsa",
            "id_ed25519",
            "certs/server.pem",
            "tls.key",
            "store.p12",
            ".npmrc",
            ".htpasswd",
        ]) {
            await rejects([INDEX, { name, content: "s" }], /looks like a secret/);
        }
        // Dotfiles in general are fine.
        await expect(
            check(tarGz([INDEX, { name: ".well-known/security.txt", content: "x" }])),
        ).resolves.toBeDefined();
        await expect(checkNotSecret("environment.js")).toBeUndefined();
    });

    it("rejects duplicates, case collisions and file/directory conflicts", async () => {
        await rejects([INDEX, INDEX], /more than once/);
        await rejects([INDEX, { name: "a.txt" }, { name: "A.TXT" }], /more than once/);
        await rejects(
            [INDEX, { name: "a", content: "x" }, { name: "a/b", content: "x" }],
            /inside a file/,
        );
        await rejects(
            [INDEX, { name: "a/b", content: "x" }, { name: "a", content: "x" }],
            /both a file and a directory/,
        );
        await rejects(
            [INDEX, { name: "d/", type: "dir" }, { name: "d", content: "x" }],
            /both|more than once/,
        );
    });

    it("requires index.html at the root, in exact case", async () => {
        await rejects([{ name: "other.html", content: "x" }], /index\.html/);
        await rejects([{ name: "site/index.html", content: "x" }], /index\.html/);
        await rejects([{ name: "Index.html", content: "x" }], /index\.html/);
        await rejects([{ name: "index.html", type: "dir" }], /index\.html/);
    });

    it("bounds entry count, depth and name length", async () => {
        const many = Array.from({ length: 60 }, (_, i) => ({ name: `f${i}.txt`, content: "x" }));
        await rejects([INDEX, ...many], /more than 50 entries/);
        await rejects([INDEX, { name: "a/b/c/d/e/f/g.txt", content: "x" }], /deeper than 6/);
        await rejects(
            [INDEX, { name: `${"x".repeat(256)}.txt`, content: "x", pax: true }],
            /name that is too long/,
        );
        await rejects(
            [INDEX, { name: `${"d/".repeat(300)}f.txt`, content: "x", pax: true }],
            /too long|deeper/,
        );
        await expect(
            check(tarGz([INDEX, { name: "a".repeat(255), content: "x", pax: true }])),
        ).resolves.toBeDefined();
    });

    it("never echoes control characters from a name into its error", async () => {
        const error = (await check(
            tarGz([INDEX, { name: "a\u001b[31mb/../c", content: "x" }]),
        ).catch((e) => e)) as Error;
        expect(error).toBeInstanceOf(ArchiveError);
        expect(error.message).not.toContain("\u001b");
    });
});

describe("hostile archives", () => {
    it("rejects input that is not gzip, an empty file and truncated data", async () => {
        const plain = tarBuffer(SITE);
        await expect(check(plain)).rejects.toThrow(/valid gzip/);
        await expect(check(Buffer.alloc(0))).rejects.toThrow(/empty|valid gzip/);
        await expect(check(Buffer.from("hello"))).rejects.toThrow(/valid gzip/);
        const whole = tarGz(SITE);
        await expect(check(whole.subarray(0, Math.floor(whole.length / 2)))).rejects.toThrow(
            ArchiveError,
        );
    });

    it("rejects a tar that ends in the middle of a file or with a bad checksum", async () => {
        const cut = tarBuffer(SITE, { terminate: false }).subarray(0, 512 + 100);
        await expect(check(gzipSync(cut))).rejects.toThrow(ArchiveError);
        const bad = tarBuffer(SITE);
        bad[148] = 0x39; // corrupt the first header's checksum
        await expect(check(gzipSync(bad))).rejects.toThrow(ArchiveError);
    });

    it("refuses a compressed layer inside the gzip layer", async () => {
        await expect(check(gzipSync(tarGz(SITE)))).rejects.toThrow(/nested compressed/);
    });

    it("stops an archive that expands far beyond its size, without storing it", async () => {
        const file = path.join(dir, "bomb.tar.gz");
        await writeBombTarGz(file, 64 * 1024 * 1024);
        const compressed = (await fs.stat(file)).size;
        expect(compressed).toBeLessThan(200 * 1024);
        const started = Date.now();
        await expect(validateArchive(file, limits)).rejects.toThrow(/expands beyond/);
        expect(Date.now() - started).toBeLessThan(5000);
    });

    it("counts the declared size of every file toward the total", async () => {
        const half = "a".repeat(600 * 1024);
        await rejects(
            [INDEX, { name: "a.bin", content: half }, { name: "b.bin", content: half }],
            /expands beyond/,
        );
    });
});

describe("checkEntryPath", () => {
    it("normalizes and bounds names", () => {
        const limit = { maxDepth: 3 };
        expect(checkEntryPath("./a/b.txt", limit)).toBe("a/b.txt");
        expect(checkEntryPath("a/b/", limit)).toBe("a/b");
        expect(checkEntryPath("./", limit)).toBe("");
        expect(checkEntryPath(".", limit)).toBe("");
        expect(() => checkEntryPath("a/b/c/d", limit)).toThrow(/deeper/);
        expect(() => checkEntryPath("", limit)).toThrow(ArchiveError);
        expect(() => checkEntryPath("x".repeat(1025), limit)).toThrow(ArchiveError);
    });
});
