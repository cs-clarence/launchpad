import { promises as fs } from "node:fs";
import { gunzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { packDirectory } from "./index";

let dir = "";
beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "launchpad-pack-"));
    await fs.writeFile(path.join(dir, "index.html"), "<p>hi</p>");
});
afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
});

describe("packDirectory", () => {
    it.each([
        "vault.kdbx",
        "service-account-prod.json",
        "data.sqlite",
        "secrets.yaml",
        "secret.json",
        ".env.local",
    ])("refuses %s", async (name) => {
        await fs.writeFile(path.join(dir, name), "x");
        await expect(packDirectory(dir)).rejects.toThrow(/secret/);
    });

    it("refuses a .terraform directory", async () => {
        await fs.mkdir(path.join(dir, ".terraform"));
        await fs.writeFile(path.join(dir, ".terraform", "a.txt"), "x");
        await expect(packDirectory(dir)).rejects.toThrow(/secret/);
    });

    it("refuses a symlink and never packs what it points at", async () => {
        const outside = await fs.mkdtemp(path.join(os.tmpdir(), "launchpad-outside-"));
        try {
            await fs.writeFile(path.join(outside, "target.txt"), "OUTSIDE-CONTENT");
            await fs.symlink(path.join(outside, "target.txt"), path.join(dir, "link.txt"));
            await expect(packDirectory(dir)).rejects.toThrow(/not a regular file/);
            // With the link left out of a selection, the archive holds the plain file only.
            const packed = await packDirectory(dir, undefined, {
                include: ["index.html"],
                exclude: ["nothing.none"],
                prefix: "",
            });
            const tar = gunzipSync(packed.archive).toString("latin1");
            expect(packed.files).toBe(1);
            expect(tar).toContain("index.html");
            expect(tar).not.toContain("link.txt");
            expect(tar).not.toContain("OUTSIDE-CONTENT");
        } finally {
            await fs.rm(outside, { recursive: true, force: true });
        }
    });

    it("packs a plain directory", async () => {
        expect((await packDirectory(dir)).files).toBe(1);
    });
});
