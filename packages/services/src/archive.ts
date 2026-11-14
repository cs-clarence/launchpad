import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { Parser, type ReadEntry } from "tar";

// Validates an uploaded `.tar.gz` without extracting it. Nothing here writes to disk
// and nothing from the archive is trusted: names, types, sizes and counts are all
// checked while streaming, and the decompressed size is bounded as it is produced.

export interface ArchiveLimits {
    maxExpandedBytes: number;
    maxEntries: number;
    maxDepth: number;
}

export interface ArchiveSummary {
    entryCount: number;
    fileCount: number;
    expandedBytes: number;
}

export class ArchiveError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ArchiveError";
    }
}

const MAX_PATH_CHARS = 1024;
const MAX_SEGMENT_CHARS = 255;
const SECRET_DIRECTORIES = new Set([".git", ".svn", ".hg", ".ssh", ".aws", ".gnupg"]);
const SECRET_FILES = new Set([".npmrc", ".netrc", ".htpasswd", ".pgpass", ".dockercfg"]);
const SECRET_FILE_PATTERNS = [/^\.env(\..*)?$/, /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/];
const SECRET_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"]);

// A printable form of an untrusted name for an error message.
function show(name: string): string {
    const safe = [...name]
        .slice(0, 80)
        .map((c) => (/[\p{Cc}\p{Cf}]/u.test(c) ? "?" : c))
        .join("");
    return JSON.stringify(safe);
}

// Returns the normalized relative path, "" for the archive root, or throws.
export function checkEntryPath(raw: string, limits: Pick<ArchiveLimits, "maxDepth">): string {
    if (raw.length === 0 || raw.length > MAX_PATH_CHARS) {
        throw new ArchiveError("An entry has an empty or too long name.");
    }
    if (/[\p{Cc}\p{Cf}\\]/u.test(raw)) {
        throw new ArchiveError(`${show(raw)} contains control characters or a backslash.`);
    }
    if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) {
        throw new ArchiveError(`${show(raw)} is an absolute path.`);
    }
    const segments = raw.split("/");
    // "./index.html" and "dir/" are normal; "a//b" and anything with "." inside is not.
    while (segments[0] === ".") segments.shift();
    if (segments.at(-1) === "") segments.pop();
    if (segments.length === 0) return "";
    for (const segment of segments) {
        if (segment === "" || segment === "." || segment === "..") {
            throw new ArchiveError(`${show(raw)} is not a plain relative path.`);
        }
        if (segment.length > MAX_SEGMENT_CHARS) {
            throw new ArchiveError(`${show(raw)} has a name that is too long.`);
        }
    }
    if (segments.length > limits.maxDepth) {
        throw new ArchiveError(`${show(raw)} is nested deeper than ${limits.maxDepth} levels.`);
    }
    return segments.join("/");
}

// Secrets are refused rather than silently dropped, so a deploy never differs from
// what its author intended. The CLI leaves these out before uploading.
export function checkNotSecret(path: string): void {
    const segments = path.split("/");
    const base = segments.at(-1)!;
    const extension = base.includes(".") ? base.slice(base.lastIndexOf(".")).toLowerCase() : "";
    const looksSecret =
        segments.some((segment) => SECRET_DIRECTORIES.has(segment)) ||
        SECRET_FILES.has(base) ||
        SECRET_FILE_PATTERNS.some((pattern) => pattern.test(base)) ||
        SECRET_EXTENSIONS.has(extension);
    if (looksSecret) {
        throw new ArchiveError(`${show(path)} looks like a secret and cannot be deployed.`);
    }
}

const FILE_TYPES = new Set(["File", "OldFile"]);

// Tracks names case-insensitively, so two entries that would collide on a
// case-insensitive file system are refused, as is a file used as a directory.
class Tree {
    private explicit = new Set<string>();
    private files = new Set<string>();
    private exact = new Set<string>();
    private directories = new Set<string>();

    add(path: string, kind: "file" | "directory") {
        const key = path.toLowerCase();
        if (this.explicit.has(key)) {
            throw new ArchiveError(`${show(path)} appears more than once.`);
        }
        this.explicit.add(key);
        const parts = key.split("/");
        for (let i = 1; i < parts.length; i++) {
            const parent = parts.slice(0, i).join("/");
            if (this.files.has(parent)) {
                throw new ArchiveError(`${show(path)} is inside a file.`);
            }
            this.directories.add(parent);
        }
        if (kind === "file") {
            if (this.directories.has(key)) {
                throw new ArchiveError(`${show(path)} is both a file and a directory.`);
            }
            this.files.add(key);
            this.exact.add(path);
        } else {
            if (this.files.has(key)) {
                throw new ArchiveError(`${show(path)} is both a file and a directory.`);
            }
            this.directories.add(key);
        }
    }

    // Exact case: `Index.html` is not the index.
    hasFile(path: string) {
        return this.exact.has(path);
    }
}

// gzip or zstd directly inside the gzip layer would be decompressed by the tar
// parser itself, outside the byte limit above, so it is refused.
function startsCompressed(chunk: Buffer): boolean {
    return (
        (chunk[0] === 0x1f && chunk[1] === 0x8b) ||
        (chunk[0] === 0x28 && chunk[1] === 0xb5 && chunk[2] === 0x2f && chunk[3] === 0xfd)
    );
}

export async function validateArchive(
    filePath: string,
    limits: ArchiveLimits,
): Promise<ArchiveSummary> {
    const tree = new Tree();
    const summary: ArchiveSummary = { entryCount: 0, fileCount: 0, expandedBytes: 0 };
    let violation: Error | undefined;
    const fail = (error: Error) => {
        violation ??= error;
    };

    const parser = new Parser({ strict: true, maxMetaEntrySize: 64 * 1024 });
    parser.on("entry", (entry: ReadEntry) => {
        // Every entry is drained, so a rejected one cannot stall the stream.
        entry.resume();
        if (violation) return;
        try {
            const type = entry.type;
            const isFile = FILE_TYPES.has(type);
            if (!isFile && type !== "Directory") {
                throw new ArchiveError(
                    `${show(entry.path)} is a ${type}; only files and directories are allowed.`,
                );
            }
            const path = checkEntryPath(entry.path, limits);
            if (path === "") {
                if (isFile) throw new ArchiveError("The archive root cannot be a file.");
                return;
            }
            checkNotSecret(path);
            summary.entryCount++;
            if (summary.entryCount > limits.maxEntries) {
                throw new ArchiveError(`The archive has more than ${limits.maxEntries} entries.`);
            }
            tree.add(path, isFile ? "file" : "directory");
            if (isFile) {
                summary.fileCount++;
                summary.expandedBytes += entry.size;
                if (summary.expandedBytes > limits.maxExpandedBytes) {
                    throw new ArchiveError("The archive expands beyond the allowed size.");
                }
            }
        } catch (error) {
            fail(error instanceof Error ? error : new ArchiveError("Invalid archive."));
        }
    });
    parser.on("warn", (_code: string, message: string | Error) => {
        fail(new ArchiveError(`The archive is malformed: ${String(message).slice(0, 120)}`));
    });
    parser.on("error", (error: Error) => {
        fail(new ArchiveError(`The archive is malformed: ${error.message.slice(0, 120)}`));
    });

    const source = createReadStream(filePath);
    const gunzip = createGunzip();
    source.on("error", (error) => gunzip.destroy(error));
    source.pipe(gunzip);
    let decompressed = 0;
    let first = true;
    try {
        for await (const chunk of gunzip as AsyncIterable<Buffer>) {
            if (first) {
                first = false;
                if (startsCompressed(chunk)) {
                    throw new ArchiveError("The archive contains a nested compressed layer.");
                }
            }
            decompressed += chunk.length;
            // Headers and padding count too: the whole decompressed stream is bounded.
            if (decompressed > limits.maxExpandedBytes + limits.maxEntries * 1024 + 4096) {
                throw new ArchiveError("The archive expands beyond the allowed size.");
            }
            if (!parser.write(chunk)) {
                await new Promise<void>((resolve) => parser.once("drain", resolve));
            }
            if (violation) throw violation;
        }
        parser.end();
        if (violation) throw violation;
    } catch (error) {
        source.destroy();
        gunzip.destroy();
        if (error instanceof ArchiveError) throw error;
        throw new ArchiveError("The file is not a valid gzip-compressed tar archive.");
    }
    if (first) throw new ArchiveError("The archive is empty.");
    if (!tree.hasFile("index.html")) {
        throw new ArchiveError("The archive must contain index.html at its root.");
    }
    return summary;
}
