import { promises as fs } from "node:fs";
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

    it("packs a plain directory", async () => {
        expect((await packDirectory(dir)).files).toBe(1);
    });
});
