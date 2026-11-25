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
    readSecret(prompt: string): Promise<string>;
    readStdin(): Promise<string>;
    readFile(path: string): Promise<{ text: string; mode: number; regular?: boolean }>;
    // Request data for `api`: a file, or standard input for "-". At most 1 MiB, as bytes.
    readData(source: string): Promise<Uint8Array>;
    // Where `jq` is, if anywhere; tests replace it. Defaults to a search of PATH.
    findExecutable?(name: string): string | null;
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
function readSecret(prompt: string): Promise<string> {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    return new Promise((resolve, reject) => {
        let buffer = "";
        const finish = (settle: () => void) => {
            stdin.off("data", onData);
            stdin.setRawMode(false);
            stdin.pause();
            process.stderr.write("\n");
            settle();
        };
        const onData = (chunk: string) => {
            for (const ch of chunk) {
                if (ch === "\r" || ch === "\n") return finish(() => resolve(buffer));
                if (ch === "\u0003") return finish(() => reject(new Error("Cancelled.")));
                if (ch === "\u007f" || ch === "\b") buffer = buffer.slice(0, -1);
                else buffer += ch;
                if (Buffer.byteLength(buffer, "utf8") > MAX_SECRET_BYTES) {
                    return finish(() => reject(new Error("Input is too long to be a key.")));
                }
            }
        };
        stdin.on("data", onData);
    });
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
        workingDir: process.cwd(),
        out: (text) => void process.stdout.write(text + "\n"),
        err: (text) => void process.stderr.write(text + "\n"),
        interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
        stdinIsTTY: Boolean(process.stdin.isTTY),
        readSecret,
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
