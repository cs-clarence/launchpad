import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT, describe as describeError } from "./errors";
import { type Io, readPasswordFile, readSecretFrom } from "./io";
import { readPassword } from "./password";
import { trackProcessListeners } from "./session-harness";

const PASSWORD = "correct horse battery";
trackProcessListeners();
let dir = "";
beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "lp-password-"));
});
afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
});

const file = async (content: string | Buffer, mode = 0o600) => {
    const target = path.join(dir, `pw-${Math.random().toString(16).slice(2)}`);
    await fs.writeFile(target, content, { mode });
    await fs.chmod(target, mode);
    return target;
};

function fakeIo(overrides: Partial<Io> = {}) {
    const secret = vi.fn(async () => PASSWORD);
    const io = {
        interactive: true,
        readSecret: secret,
        readPasswordFile,
        ...overrides,
    } as unknown as Io;
    return { io, secret };
}
const ask = (io: Io, passwordFile?: string) =>
    readPassword(io, { passwordFile, prompt: "Password: " });
const failure = async (action: Promise<unknown>) => {
    const error = await action.then(
        () => undefined,
        (e: unknown) => e,
    );
    expect(error).toBeDefined();
    const described = describeError(error);
    expect(described.exitCode).toBe(EXIT.usage);
    expect(described.message).not.toContain(PASSWORD);
    return described.message;
};

describe("--password-file", () => {
    it("reads a private regular file and removes exactly one trailing newline", async () => {
        const { io } = fakeIo();
        expect(await ask(io, await file(PASSWORD))).toBe(PASSWORD);
        expect(await ask(io, await file(`${PASSWORD}\n`))).toBe(PASSWORD);
        expect(await ask(io, await file(`${PASSWORD}\r\n`))).toBe(PASSWORD);
        expect(await ask(io, await file(`${PASSWORD}\n\n`, 0o400))).toBe(`${PASSWORD}\n`);
        expect(await ask(io, await file(`${PASSWORD}\r`))).toBe(`${PASSWORD}\r`);
    });

    it("works without a terminal and never prompts", async () => {
        const { io, secret } = fakeIo({ interactive: false });
        expect(await ask(io, await file(PASSWORD))).toBe(PASSWORD);
        expect(secret).not.toHaveBeenCalled();
    });

    it("refuses a symbolic link, a FIFO and other non-regular files without hanging", async () => {
        const { io } = fakeIo();
        const target = await file(PASSWORD);
        const link = path.join(dir, "link");
        await fs.symlink(target, link);
        expect(await failure(ask(io, link))).toMatch(/symbolic link/);

        const fifo = path.join(dir, "fifo");
        execFileSync("mkfifo", [fifo]);
        expect(await failure(ask(io, fifo))).toMatch(/not a regular file/);
        expect(await failure(ask(io, dir))).toMatch(/not a regular file/);
        expect(await failure(ask(io, path.join(dir, "missing")))).toMatch(/not found/);
    });

    it("refuses a file owned by another user", async () => {
        const { io } = fakeIo();
        const target = await file(PASSWORD);
        const getuid = process.getuid!.bind(process);
        vi.spyOn(process, "getuid").mockReturnValue(getuid() + 1);
        expect(await failure(ask(io, target))).toMatch(/another user/);
    });

    it("refuses any group or other permission bit", async () => {
        const { io } = fakeIo();
        for (const mode of [0o640, 0o604, 0o644, 0o660, 0o666, 0o610]) {
            expect(await failure(ask(io, await file(PASSWORD, mode))), mode.toString(8)).toMatch(
                /readable by others/,
            );
        }
    });

    it("refuses a file over 4096 bytes and one that is not text", async () => {
        const { io } = fakeIo();
        expect(await failure(ask(io, await file("x".repeat(4097))))).toMatch(/too long/);
        expect(await failure(ask(io, await file(Buffer.from([0xff, 0xfe, 0x41]))))).toMatch(
            /UTF-8/,
        );
    });

    it("refuses an empty file and passwords of 11 and 129 characters, accepting 12 and 128", async () => {
        const { io } = fakeIo();
        expect(await failure(ask(io, await file("")))).toMatch(/empty/);
        expect(await failure(ask(io, await file("\n")))).toMatch(/empty/);
        expect(await failure(ask(io, await file("a".repeat(11))))).toMatch(/12 to 128/);
        expect(await failure(ask(io, await file("a".repeat(129))))).toMatch(/12 to 128/);
        expect(await ask(io, await file("a".repeat(12)))).toHaveLength(12);
        expect(await ask(io, await file("a".repeat(128)))).toHaveLength(128);
    });
});

describe("the prompt", () => {
    it("is used only on a terminal, and its answer is length-checked", async () => {
        const { io, secret } = fakeIo();
        expect(await ask(io)).toBe(PASSWORD);
        expect(secret).toHaveBeenCalledWith("Password: ", { kind: "password", signal: undefined });
        secret.mockResolvedValueOnce("short");
        expect(await failure(ask(io))).toMatch(/12 to 128/);
    });

    it("is refused before readSecret when there is no terminal", async () => {
        const { io, secret } = fakeIo({ interactive: false });
        expect(await failure(ask(io))).toMatch(/--password-file/);
        expect(secret).not.toHaveBeenCalled();
    });

    it("reports a cancelled or oversized prompt as a usage error, not the password", async () => {
        const { io, secret } = fakeIo();
        secret.mockRejectedValueOnce(new Error("Cancelled."));
        const cancelled = await ask(io).then(
            () => undefined,
            (e: unknown) => e,
        );
        expect(describeError(cancelled)).toBeDefined();
        expect(cancelled).toMatchObject({ exitCode: EXIT.interrupted });
        secret.mockRejectedValueOnce(new Error("Input is too long to be a password."));
        expect(await failure(ask(io))).toMatch(/password/);
    });
});

describe("the hidden prompt itself", () => {
    function terminal() {
        const listeners: Array<(chunk: string) => void> = [];
        const events: string[] = [];
        const stdin = {
            setRawMode: (mode: boolean) => events.push(`raw:${mode}`),
            resume: () => events.push("resume"),
            pause: () => events.push("pause"),
            setEncoding: () => {},
            on: (_e: "data", l: (chunk: string) => void) => void listeners.push(l),
            off: (_e: "data", l: (chunk: string) => void) => {
                listeners.splice(listeners.indexOf(l), 1);
            },
        };
        const written: string[] = [];
        return {
            events,
            written,
            listeners,
            streams: { stdin, stderr: { write: (t: string) => void written.push(t) } },
            type: (text: string) => listeners.forEach((l) => l(text)),
        };
    }

    it("reads a line without echo and restores the terminal", async () => {
        const t = terminal();
        const result = readSecretFrom(t.streams, "Password: ", { kind: "password" });
        t.type("abc\u007fd\r");
        expect(await result).toBe("abd");
        expect(t.events).toEqual(["raw:true", "resume", "raw:false", "pause"]);
        expect(t.written).toEqual(["Password: ", "\n"]);
        expect(t.listeners).toHaveLength(0);
    });

    it("restores the terminal on Ctrl-C and on abort, and says password, not key", async () => {
        const ctrlC = terminal();
        const first = readSecretFrom(ctrlC.streams, "P: ", { kind: "password" });
        ctrlC.type("\u0003");
        await expect(first).rejects.toThrow("Cancelled.");
        expect(ctrlC.events.slice(-2)).toEqual(["raw:false", "pause"]);

        const aborted = terminal();
        const controller = new AbortController();
        const second = readSecretFrom(aborted.streams, "P: ", { signal: controller.signal });
        controller.abort();
        await expect(second).rejects.toThrow("Cancelled.");
        expect(aborted.events).toEqual(["raw:true", "resume", "raw:false", "pause"]);
        expect(aborted.written.at(-1)).toBe("\n");
        expect(aborted.listeners).toHaveLength(0);

        const never = terminal();
        const early = new AbortController();
        early.abort();
        await expect(
            readSecretFrom(never.streams, "P: ", { signal: early.signal }),
        ).rejects.toThrow();
        expect(never.events).toEqual([]);

        const long = terminal();
        const third = readSecretFrom(long.streams, "P: ", { kind: "password" });
        long.type("x".repeat(4097));
        await expect(third).rejects.toThrow("too long to be a password");
        const key = terminal();
        const fourth = readSecretFrom(key.streams, "K: ");
        key.type("x".repeat(4097));
        await expect(fourth).rejects.toThrow("too long to be a key");
    });
});
