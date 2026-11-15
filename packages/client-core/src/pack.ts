import { promises as fs } from "node:fs";
import path from "node:path";
import { create } from "tar";
import { ClientCoreError } from "./errors";

// Packs a directory into the `.tar.gz` the controller accepts. The controller validates
// the archive itself and is the authority; this checks what a developer should hear
// before uploading megabytes, and never follows a link out of the directory.

export interface PackLimits {
    maxArchiveBytes: number;
    maxEntries: number;
    maxDepth: number;
}

export const DEFAULT_PACK_LIMITS: PackLimits = {
    maxArchiveBytes: 50 * 1024 * 1024,
    maxEntries: 5000,
    maxDepth: 16,
};

const SECRET_DIRECTORIES = new Set([".git", ".svn", ".hg", ".ssh", ".aws", ".gnupg"]);
const SECRET_FILES = new Set([".npmrc", ".netrc", ".htpasswd", ".pgpass", ".dockercfg"]);
const SECRET_FILE_PATTERNS = [/^\.env(\..*)?$/, /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/];
const SECRET_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"]);

// A printable form of a local name for a message.
const show = (name: string) =>
    JSON.stringify(
        [...name]
            .slice(0, 80)
            .map((c) => (/[\p{Cc}\p{Cf}]/u.test(c) ? "?" : c))
            .join(""),
    );

function refuse(message: string): never {
    throw new ClientCoreError("bad-input", message);
}

function checkName(relative: string, segments: string[], limits: PackLimits) {
    if (segments.length > limits.maxDepth) {
        refuse(`${show(relative)} is nested deeper than ${limits.maxDepth} levels.`);
    }
    for (const segment of segments) {
        if (/[\p{Cc}\p{Cf}\\]/u.test(segment) || segment.length > 255) {
            refuse(`${show(relative)} has a name the controller will not accept.`);
        }
        const lower = segment.toLowerCase();
        if (
            SECRET_DIRECTORIES.has(lower) ||
            SECRET_FILES.has(lower) ||
            SECRET_FILE_PATTERNS.some((pattern) => pattern.test(lower)) ||
            SECRET_EXTENSIONS.has(path.extname(lower))
        ) {
            refuse(
                `${show(relative)} looks like a secret or version-control data and must not be deployed. Remove it from the directory.`,
            );
        }
    }
}

export interface Packed {
    archive: Buffer;
    files: number;
    bytes: number;
}

export async function packDirectory(
    directory: string,
    limits: PackLimits = DEFAULT_PACK_LIMITS,
): Promise<Packed> {
    const root = path.resolve(directory);
    const rootStat = await fs.lstat(root).catch(() => undefined);
    if (!rootStat) refuse(`${show(directory)} does not exist.`);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        refuse(`${show(directory)} is not a directory.`);
    }

    const files: string[] = [];
    let bytes = 0;
    const walk = async (relative: string): Promise<void> => {
        const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            const rel = relative === "" ? entry.name : `${relative}/${entry.name}`;
            const segments = rel.split("/");
            checkName(rel, segments, limits);
            if (entry.isDirectory()) {
                // Looked at again without following links: the listing may be stale, and a
                // directory swapped for a link since must not be descended into.
                const now = await fs.lstat(path.join(root, rel));
                if (!now.isDirectory()) {
                    refuse(`${show(rel)} changed while it was being read.`);
                }
                await walk(rel);
            } else if (entry.isFile()) {
                files.push(rel);
                if (files.length > limits.maxEntries) {
                    refuse(`The directory has more than ${limits.maxEntries} files.`);
                }
                const now = await fs.lstat(path.join(root, rel));
                if (!now.isFile()) refuse(`${show(rel)} changed while it was being read.`);
                bytes += now.size;
            } else {
                // Links, sockets, devices: nothing but plain files is deployed.
                refuse(`${show(rel)} is not a regular file (links and special files are refused).`);
            }
        }
    };
    await walk("");
    if (!files.includes("index.html")) {
        refuse("The directory has no index.html at its top level.");
    }

    const stream = create({ gzip: true, cwd: root, portable: true, noPax: false }, files);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > limits.maxArchiveBytes) {
            refuse(
                `The packed archive is larger than ${Math.floor(limits.maxArchiveBytes / (1024 * 1024))} MiB.`,
            );
        }
        chunks.push(chunk);
    }
    return { archive: Buffer.concat(chunks), files: files.length, bytes };
}

// An existing archive is sent as it is (the controller validates it); only its size is
// checked here, so a huge file is not read into memory.
export async function readArchive(
    file: string,
    limits: PackLimits = DEFAULT_PACK_LIMITS,
): Promise<Packed> {
    const stat = await fs.lstat(file).catch(() => undefined);
    if (!stat?.isFile()) refuse(`${show(file)} is not a file.`);
    const tooLarge = () =>
        refuse(
            `${show(file)} is larger than ${Math.floor(limits.maxArchiveBytes / (1024 * 1024))} MiB.`,
        );
    if (stat.size > limits.maxArchiveBytes) tooLarge();
    // Read with the limit enforced as the bytes arrive: a file that grows after the check
    // above cannot make this allocate more than the limit allows.
    const handle = await fs.open(file, "r");
    try {
        const chunks: Buffer[] = [];
        let total = 0;
        for (;;) {
            const chunk = Buffer.allocUnsafe(64 * 1024);
            const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
            if (bytesRead === 0) break;
            total += bytesRead;
            if (total > limits.maxArchiveBytes) tooLarge();
            chunks.push(chunk.subarray(0, bytesRead));
        }
        return { archive: Buffer.concat(chunks), files: 0, bytes: total };
    } finally {
        await handle.close();
    }
}
