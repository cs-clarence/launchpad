import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSecretFile, realIo } from "./io";

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

describe("real signal hooks", () => {
    it("adds and removes exactly their own listeners", () => {
        const names = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
        const before = names.map((n) => process.listenerCount(n));
        const hooks = realIo().signals!;
        const listener = () => {};
        for (const n of names) hooks.on(n, listener);
        expect(names.map((n) => process.listenerCount(n))).toEqual(before.map((c) => c + 1));
        for (const n of names) hooks.off(n, listener);
        expect(names.map((n) => process.listenerCount(n))).toEqual(before);
    });
});

describe("secret file removal", () => {
    it("removes the file it made, but never a different file put at the path", async () => {
        const mine = path.join(dir, "mine");
        const file = await createSecretFile(mine);
        await file.remove();
        await expect(fs.stat(mine)).rejects.toMatchObject({ code: "ENOENT" });

        const swapped = path.join(dir, "swapped");
        const second = await createSecretFile(swapped);
        await fs.rm(swapped);
        await fs.writeFile(swapped, "someone else's data");
        await second.remove();
        expect(await fs.readFile(swapped, "utf8")).toBe("someone else's data");
    });
});
