import { promises as fs } from "node:fs";
import { createContext, type Context } from "@launchpad/client-core";

// Everything the commands need from the outside world, so tests can replace it.
export interface Io {
    context: Context;
    out(text: string): void;
    err(text: string): void;
    interactive: boolean;
    readSecret(prompt: string): Promise<string>;
    readStdin(): Promise<string>;
    readFile(path: string): Promise<{ text: string; mode: number }>;
}

const MAX_SECRET_BYTES = 4096;

async function readStdin(): Promise<string> {
    let text = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) {
        text += chunk;
        if (text.length > MAX_SECRET_BYTES) throw new Error("Input is too long to be a key.");
    }
    return text;
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
            }
        };
        stdin.on("data", onData);
    });
}

export function realIo(env: Record<string, string | undefined> = process.env): Io {
    return {
        context: createContext(env),
        out: (text) => void process.stdout.write(text + "\n"),
        err: (text) => void process.stderr.write(text + "\n"),
        interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
        readSecret,
        readStdin,
        readFile: async (path) => {
            const handle = await fs.open(path, "r");
            try {
                const stat = await handle.stat();
                if (stat.size > MAX_SECRET_BYTES) throw new Error("File is too large to be a key.");
                return { text: await handle.readFile("utf8"), mode: stat.mode };
            } finally {
                await handle.close();
            }
        },
    };
}
