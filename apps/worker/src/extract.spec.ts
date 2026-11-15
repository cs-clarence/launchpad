import { promises as fs } from "node:fs";
import path from "node:path";
import { SITE, tarGz, type FixtureEntry } from "@launchpad/services/testing";
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
