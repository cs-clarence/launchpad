import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { createContext, type Context } from "@launchpad-kit/client-core";

// Everything the commands need from the outside world, so tests can replace it.
export interface Io {
    context: Context;
    workingDir?: string;
    out(text: string): void;
    err(text: string): void;
    interactive: boolean;
    stdinIsTTY?: boolean;
    // A hidden line from the terminal. Aborting `signal` restores the terminal and rejects.
    readSecret(prompt: string, options?: SecretOptions): Promise<string>;
    // The password for `--password-file`: a regular file of ours that only we can read, read
    // without following a link or blocking. One trailing newline is removed. Messages never
    // contain the file's contents.
    readPasswordFile(path: string): Promise<string>;
    readStdin(): Promise<string>;
    readFile(path: string): Promise<{ text: string; mode: number; regular?: boolean }>;
    // Request data for `api`: a file, or standard input for "-". At most 1 MiB, as bytes.
    readData(source: string): Promise<Uint8Array>;
    // Where `jq` is, if anywhere; tests replace it. Defaults to a search of PATH.
    findExecutable?(name: string): string | null;
    // Creates `path` exclusively with mode 0600 (it must not exist); nothing is written yet.
    createSecretFile(path: string): Promise<SecretFile>;
    // Where `--session` listens for SIGINT, SIGTERM and SIGHUP; without it no handler is installed.
    signals?: SignalHooks;
}

// A file created for a secret the controller shows once, such as a new API key.
export interface SecretFile {
    // Writes the secret and closes the file; afterwards `remove` does nothing.
    write(text: string): Promise<void>;
    // Deletes the file unless a secret was written to it.
    remove(): Promise<void>;
}

export interface SecretOptions {
    kind?: "key" | "password";
    signal?: AbortSignal;
}

// Process-level hooks for a signed-in session, so tests can send signals without any real ones.
export interface SignalHooks {
    on(signal: NodeJS.Signals, listener: () => void): void;
    off(signal: NodeJS.Signals, listener: () => void): void;
    // Leaves at once, without cleanup; a second signal uses it.
    exit(code: number): void;
}

// What the hidden prompt reads from and writes to; replaced in tests.
export interface PromptStreams {
    stdin: {
        setRawMode(mode: boolean): unknown;
        resume(): unknown;
        pause(): unknown;
        setEncoding(encoding: BufferEncoding): unknown;
        on(event: "data", listener: (chunk: string) => void): unknown;
        off(event: "data", listener: (chunk: string) => void): unknown;
    };
    stderr: { write(text: string): unknown };
}

const MAX_SECRET_BYTES = 4096;
const MAX_DATA_BYTES = 1024 * 1024;

async function readBounded(
    chunks: AsyncIterable<Uint8Array>,
    limit = MAX_SECRET_BYTES,
    tooLong = "Input is too long to be a key.",
): Promise<string> {
    return Buffer.from(await readBytes(chunks, limit, tooLong)).toString("utf8");
}

async function readBytes(
    chunks: AsyncIterable<Uint8Array>,
    limit: number,
    tooLong: string,
): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of chunks) {
        bytes += chunk.byteLength;
        if (bytes > limit) throw new Error(tooLong);
        parts.push(chunk);
    }
    return Buffer.concat(parts);
}

async function readStdin(): Promise<string> {
    return readBounded(process.stdin);
}

// Reads a line from the terminal without echoing it.
export function readSecretFrom(
    { stdin, stderr }: PromptStreams,
    prompt: string,
    options: SecretOptions = {},
): Promise<string> {
    const tooLong = `Input is too long to be a ${options.kind ?? "key"}.`;
    if (options.signal?.aborted) return Promise.reject(new Error("Cancelled."));
    stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    return new Promise((resolve, reject) => {
        let buffer = "";
        let done = false;
        const finish = (settle: () => void) => {
            if (done) return;
            done = true;
            options.signal?.removeEventListener("abort", onAbort);
            stdin.off("data", onData);
            stdin.setRawMode(false);
            stdin.pause();
            stderr.write("\n");
            settle();
        };
        const onAbort = () => finish(() => reject(new Error("Cancelled.")));
        const onData = (chunk: string) => {
            for (const ch of chunk) {
                if (ch === "\r" || ch === "\n") return finish(() => resolve(buffer));
                if (ch === "\u0003") return finish(() => reject(new Error("Cancelled.")));
                if (ch === "\u007f" || ch === "\b") buffer = buffer.slice(0, -1);
                else buffer += ch;
                if (Buffer.byteLength(buffer, "utf8") > MAX_SECRET_BYTES) {
                    return finish(() => reject(new Error(tooLong)));
                }
            }
        };
        options.signal?.addEventListener("abort", onAbort, { once: true });
        stdin.on("data", onData);
    });
}

const readSecret = (prompt: string, options?: SecretOptions) =>
    readSecretFrom({ stdin: process.stdin as never, stderr: process.stderr }, prompt, options);

export async function createSecretFile(file: string): Promise<SecretFile> {
    let handle;
    try {
        handle = await fs.open(file, "wx", 0o600);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        throw new Error(
            code === "EEXIST"
                ? "The secret file already exists; choose a path that does not exist."
                : code === "ENOENT"
                  ? "The secret file's directory does not exist."
                  : "The secret file cannot be created.",
        );
    }
    let written = false;
    let closed = false;
    // Identifies the file we made, so a different file later put at the path is never deleted.
    const made = await handle.stat();
    return {
        async write(text) {
            try {
                await handle.writeFile(text);
                await handle.sync();
            } finally {
                closed = true;
                await handle.close();
            }
            written = true;
        },
        async remove() {
            if (written) return;
            if (!closed) await handle.close().catch(() => {});
            closed = true;
            const now = await fs.lstat(file).catch(() => null);
            if (now && now.dev === made.dev && now.ino === made.ino) {
                await fs.rm(file, { force: true });
            }
        },
    };
}

const refusal = (why: string) => new Error(`The password file ${why}.`);

// The file must be ours and closed to others, like the credential store; a link or a FIFO is
// refused without waiting for a writer.
export async function readPasswordFile(file: string): Promise<string> {
    let handle;
    try {
        handle = await fs.open(
            file,
            constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
        );
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ELOOP") throw refusal("is a symbolic link; it is not read");
        if (code === "ENOENT") throw refusal("was not found");
        if (code === "EACCES") throw refusal("is not readable by you");
        throw refusal("cannot be opened");
    }
    try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw refusal("is not a regular file");
        if (process.platform !== "win32") {
            const owner = process.getuid?.();
            if (owner !== undefined && stat.uid !== owner)
                throw refusal("is owned by another user");
            if ((stat.mode & 0o077) !== 0) {
                throw refusal("is readable by others; restrict it with chmod 600");
            }
        }
        if (stat.size > MAX_SECRET_BYTES) throw refusal("is too long to be a password");
        let text: string;
        try {
            const bytes = await readBytes(
                handle.createReadStream({ autoClose: false, highWaterMark: MAX_SECRET_BYTES + 1 }),
                MAX_SECRET_BYTES,
                "The password file is too long to be a password.",
            );
            text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch (error) {
            if (error instanceof Error && /too long/.test(error.message)) throw error;
            if (error instanceof TypeError) throw refusal("is not valid UTF-8 text");
            throw refusal("cannot be read");
        }
        return text.endsWith("\r\n")
            ? text.slice(0, -2)
            : text.endsWith("\n")
              ? text.slice(0, -1)
              : text;
    } finally {
        await handle.close();
    }
}

async function readData(source: string, store: string): Promise<Uint8Array> {
    const tooLong = "The data is larger than 1 MiB.";
    if (source === "-") return readBytes(process.stdin, MAX_DATA_BYTES, tooLong);
    const location = await fs.realpath(source);
    // The process environment (and so a key) is readable here on Linux.
    if (process.platform === "linux" && /^\/(?:proc|sys)(?:\/|$)/.test(location)) {
        throw new Error("Files under /proc and /sys are not sent.");
    }
    const guarded = await fs.realpath(store).catch(() => path.resolve(store));
    const relative = path.relative(guarded, location);
    if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
        throw new Error("That file is inside this client's credential store and is not sent.");
    }
    // Checked before opening: opening a FIFO with no writer would block.
    if (!(await fs.stat(location)).isFile()) {
        throw new Error("The data source is not a regular file.");
    }
    const handle = await fs.open(location, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error("The data source is not a regular file.");
        if (stat.size > MAX_DATA_BYTES) throw new Error(tooLong);
        return await readBytes(
            handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 }),
            MAX_DATA_BYTES,
            tooLong,
        );
    } finally {
        await handle.close();
    }
}

export function realIo(env: Record<string, string | undefined> = process.env): Io {
    const context = createContext(env);
    return {
        context,
        readData: (source) => readData(source, context.store.directory),
        signals: {
            on: (signal, listener) => void process.on(signal, listener),
            off: (signal, listener) => void process.off(signal, listener),
            exit: (code) => process.exit(code),
        },
        workingDir: process.cwd(),
        out: (text) => void process.stdout.write(text + "\n"),
        err: (text) => void process.stderr.write(text + "\n"),
        interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
        stdinIsTTY: Boolean(process.stdin.isTTY),
        readSecret,
        readPasswordFile,
        createSecretFile,
        readStdin,
        readFile: async (path) => {
            const handle = await fs.open(path, "r");
            try {
                const stat = await handle.stat();
                if (stat.size > MAX_SECRET_BYTES) throw new Error("File is too large to be a key.");
                return {
                    text: await readBounded(
                        handle.createReadStream({
                            autoClose: false,
                            highWaterMark: MAX_SECRET_BYTES + 1,
                        }),
                    ),
                    mode: stat.mode,
                    regular: stat.isFile(),
                };
            } finally {
                await handle.close();
            }
        },
    };
}
