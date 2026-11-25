import { spawnSync } from "node:child_process";
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

const hasMkfifo =
    process.platform !== "win32" &&
    spawnSync("mkfifo", ["--version"]).error === undefined &&
    (() => {
        const probe = path.join(os.tmpdir(), `lp-mkfifo-${process.pid}`);
        const made = spawnSync("mkfifo", [probe]).status === 0;
        spawnSync("rm", ["-f", probe]);
        return made;
    })();

describe.skipIf(process.platform === "win32")("api data input", () => {
    it.skipIf(!hasMkfifo)("refuses a FIFO without blocking, and reads a regular file", async () => {
        const fifo = path.join(dir, "pipe");
        expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
        await expect(
            realIo({ LAUNCHPAD_CONFIG_DIR: path.join(dir, "cfg") }).readData(fifo),
        ).rejects.toThrow("not a regular file");
        const file = path.join(dir, "body.json");
        await fs.writeFile(file, "{}");
        expect(
            Buffer.from(
                await realIo({ LAUNCHPAD_CONFIG_DIR: path.join(dir, "cfg") }).readData(file),
            ).toString(),
        ).toBe("{}");
    });

    it("refuses a file inside the credential store", async () => {
        const store = path.join(dir, "cfg");
        await fs.mkdir(store);
        await fs.writeFile(path.join(store, "credentials.json"), "{}");
        await expect(
            realIo({ LAUNCHPAD_CONFIG_DIR: store }).readData(path.join(store, "credentials.json")),
        ).rejects.toThrow("credential store");
    });

    it.skipIf(process.platform !== "linux")("refuses /proc and /sys paths", async () => {
        const io = realIo({ LAUNCHPAD_CONFIG_DIR: path.join(dir, "cfg") });
        await expect(io.readData("/proc/self/environ")).rejects.toThrow("/proc");
        await expect(io.readData("/proc/self/../self/environ")).rejects.toThrow("/proc");
        await expect(io.readData("/sys/kernel/ostype")).rejects.toThrow("/sys");
    });
});
