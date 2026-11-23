import { promises as fs } from "node:fs";
import path from "node:path";
import { SITE, tarGz, type FixtureEntry } from "@launchpad-kit/services/testing";
import { afterEach, describe, expect, it } from "vitest";
import { extractSite } from "./extract";
import { LIMITS, tempDir } from "./testing";

let tmp: Awaited<ReturnType<typeof tempDir>> | undefined;
afterEach(async () => {
    await tmp?.cleanup();
    tmp = undefined;
});

async function archive(entries: FixtureEntry[]) {
    tmp = await tempDir();
    const file = path.join(tmp.dir, "a.tar.gz");
    await fs.writeFile(file, tarGz(entries));
    return { file, out: path.join(tmp.dir, "site") };
}

describe("extracting a site", () => {
    it("writes the files and nothing else", async () => {
        const { file, out } = await archive(SITE);
        expect((await extractSite(file, out, LIMITS)).fileCount).toBe(2);
        expect(await fs.readFile(path.join(out, "assets/app.js"), "utf8")).toBe("console.log(1)");
        expect(await fs.readdir(tmp!.dir)).toEqual(expect.arrayContaining(["site", "a.tar.gz"]));
    });

    it("validates again at extraction, so a tampered file never reaches the disk", async () => {
        for (const bad of [
            [...SITE, { name: "../escape.txt", content: "x" }],
            [...SITE, { name: "/abs.txt", content: "x" }],
            [...SITE, { name: "link", type: "symlink", link: "/etc/passwd" } as FixtureEntry],
            [...SITE, { name: "hard", type: "hardlink", link: "index.html" } as FixtureEntry],
            [...SITE, { name: ".env", content: "SECRET=1" }],
            [...SITE, { name: ".git/config", content: "x" }],
            [{ name: "page.html", content: "no index" }],
        ] as FixtureEntry[][]) {
            const { file, out } = await archive(bad);
            await expect(extractSite(file, out, LIMITS)).rejects.toThrow();
            await expect(fs.stat(path.join(tmp!.dir, "escape.txt"))).rejects.toThrow();
            await tmp!.cleanup();
        }
    });

    it("takes permissions from this process, never from the archive", async () => {
        const { file, out } = await archive([
            { name: "index.html", content: "<p>x</p>", mode: 0o000 },
            { name: "dir/", type: "dir", mode: 0o700 },
            { name: "dir/setuid.js", content: "x", mode: 0o6755 },
            { name: "dir/open.js", content: "x", mode: 0o777 },
            { name: "exec.sh", content: "x", mode: 0o700 },
        ]);
        await extractSite(file, out, LIMITS);
        const modeOf = async (rel: string) => (await fs.stat(path.join(out, rel))).mode & 0o7777;
        expect(await modeOf(".")).toBe(0o755);
        expect(await modeOf("dir")).toBe(0o755);
        for (const rel of ["index.html", "dir/setuid.js", "dir/open.js", "exec.sh"]) {
            expect(await modeOf(rel), rel).toBe(0o644);
        }
    });

    it("extracts an archive within the limits however well it compresses", async () => {
        // 8 MiB of zeros compresses to a few KiB: far beyond tar's default 1000:1 guard.
        const { file, out } = await archive([
            { name: "index.html", content: "<!doctype html>" },
            { name: "zeros.bin", content: "\0".repeat(8 * 1024 * 1024) },
        ]);
        expect((await fs.stat(file)).size * 1000).toBeLessThan(8 * 1024 * 1024);
        expect((await extractSite(file, out, LIMITS)).fileCount).toBe(2);
        expect((await fs.stat(path.join(out, "zeros.bin"))).size).toBe(8 * 1024 * 1024);
    });

    it("still refuses what exceeds the expanded-size limit, however well it compresses", async () => {
        const { file, out } = await archive([
            { name: "index.html", content: "<!doctype html>" },
            { name: "zeros.bin", content: "\0".repeat(8 * 1024 * 1024) },
        ]);
        await expect(
            extractSite(file, out, { ...LIMITS, maxExpandedBytes: 4 * 1024 * 1024 }),
        ).rejects.toThrow(/expands beyond/);
    });

    it("applies the size limits it is given", async () => {
        const { file, out } = await archive(SITE);
        await expect(extractSite(file, out, { ...LIMITS, maxEntries: 1 })).rejects.toThrow(
            /entries/,
        );
        await expect(extractSite(file, out, { ...LIMITS, maxExpandedBytes: 5 })).rejects.toThrow(
            /size/,
        );
    });
});
