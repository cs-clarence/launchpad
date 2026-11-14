import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realIo } from "./io";

let dir: string;
beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "launchpad-key-input-"));
});
afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
});

describe("real key-file input", () => {
    it("reads a regular file, preserving mode metadata", async () => {
        const file = path.join(dir, "key");
        await fs.writeFile(file, "lp_example\n", { mode: 0o600 });
        expect(await realIo().readFile(file)).toMatchObject({
            text: "lp_example\n",
            regular: true,
        });
    });

    it("refuses an oversized regular file", async () => {
        const file = path.join(dir, "key");
        await fs.writeFile(file, "x".repeat(4097), { mode: 0o600 });
        await expect(realIo().readFile(file)).rejects.toThrow(/too large/);
    });

    it.skipIf(process.platform !== "linux")(
        "bounds a device whose reported size is zero",
        async () => {
            await expect(realIo().readFile("/dev/zero")).rejects.toThrow(/too long/);
        },
    );

    it.skipIf(process.platform !== "linux")("recognizes non-regular input", async () => {
        expect(await realIo().readFile("/dev/null")).toMatchObject({ text: "", regular: false });
    });
});
