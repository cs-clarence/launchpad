import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

// The router's control token is read from an owner-only file or from standard input: never from an
// argument or the environment, which other processes can read. Nothing here echoes the value.

const MAX_BYTES = 256;
const TOKEN = /^[0-9a-f]{64}$/;

export class SecretError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SecretError";
    }
}

function finish(bytes: Buffer): string {
    const value = bytes.toString("utf8").replace(/\r?\n$/, "");
    if (!TOKEN.test(value)) {
        throw new SecretError("The secret must be 64 lowercase hexadecimal characters.");
    }
    return value;
}

export function readSecretFile(file: string): string {
    return finish(readOwnerFile(file, MAX_BYTES));
}

export function readOwnerFile(file: string, maxBytes: number): Buffer {
    if (!/^\/[A-Za-z0-9._/@+-]{1,500}$/.test(file) || file.split("/").includes("..")) {
        throw new SecretError("The secret file must be a plain absolute path.");
    }
    let fd: number;
    try {
        fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch {
        throw new SecretError("The secret file cannot be read.");
    }
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
            throw new SecretError(
                "The secret file must be a regular file owned by you and readable only by you (for example mode 0600).",
            );
        }
        if (stat.size > maxBytes) throw new SecretError("The secret file is too large.");
        const buffer = Buffer.alloc(maxBytes + 1);
        const read = readSync(fd, buffer, 0, buffer.length, 0);
        if (read > maxBytes) throw new SecretError("The secret file is too large.");
        return buffer.subarray(0, read);
    } finally {
        closeSync(fd);
    }
}

export async function readSecretStdin(
    stream: { isTTY?: boolean } & AsyncIterable<Uint8Array>,
): Promise<string> {
    if (stream.isTTY) {
        // A terminal would echo it, and a prompt is not an operator workflow here.
        throw new SecretError(
            "Refusing to read a secret from a terminal; pipe it or use --token-file.",
        );
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
        size += chunk.byteLength;
        if (size > MAX_BYTES) throw new SecretError("The secret is too large.");
        chunks.push(Buffer.from(chunk));
    }
    return finish(Buffer.concat(chunks));
}
