import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

// Reads a router epoch or control token from a file an operator controls. The reader never echoes
// content or paths: every failure is the same fixed message. A secret must be owned by the
// reading user and unreadable to others; the epoch is not a secret and only needs to be a file.
const MAX_BYTES = 256;

export function readRouterCredential(file: string, secret: boolean): string {
    try {
        const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
            const stat = fstatSync(fd);
            if (
                !stat.isFile() ||
                stat.size > MAX_BYTES ||
                (secret && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))
            ) {
                throw new Error("unsuitable");
            }
            const bytes = Buffer.alloc(MAX_BYTES + 1);
            const size = readSync(fd, bytes, 0, bytes.length, 0);
            if (size > MAX_BYTES) throw new Error("unsuitable");
            return new TextDecoder("utf-8", { fatal: true })
                .decode(bytes.subarray(0, size))
                .replace(/\r?\n$/, "");
        } finally {
            closeSync(fd);
        }
    } catch {
        throw new Error("Could not read the configured router credential file.");
    }
}

// The control token travels in a header: only HTTPS, or HTTP to a loopback address. `localhost`
// is not accepted, because a hosts file or container DNS can point it elsewhere.
export function assertPrivateControlUrl(url: URL, name: string): URL {
    const loopback = ["127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
        throw new Error(`${name} must be https, or http to 127.0.0.1 or [::1].`);
    }
    return url;
}
