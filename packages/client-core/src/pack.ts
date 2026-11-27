import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import { Pack } from "tar";
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

const SECRET_DIRECTORIES = new Set([
    ".git",
    ".svn",
    ".hg",
    ".ssh",
    ".aws",
    ".gnupg",
    ".kube",
    ".docker",
]);
const SECRET_FILES = new Set([
    ".npmrc",
    ".netrc",
    ".htpasswd",
    ".pgpass",
    ".dockercfg",
    ".git-credentials",
    ".pypirc",
]);
const SECRET_FILE_PATTERNS = [/^\.env(\..*)?$/, /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/];
const SECRET_EXTENSIONS = new Set([
    ".pem",
    ".key",
    ".p12",
    ".pfx",
    ".jks",
    ".keystore",
    ".tfstate",
]);
// Every name looked at while walking, selected or not: a very large tree is refused
// rather than walked for as long as it takes.
const MAX_VISITED = 100_000;

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

// Which files of a directory may be published, chosen by the operator's patterns and
// matched against each file's path relative to `base` (the directory the patterns are
// relative to, which may be above the packed directory). Exclusion always wins.
export interface FileSelection {
    include: string[];
    exclude: string[];
    // The packed directory's path relative to the directory the patterns are relative to.
    prefix: string;
    // Real paths (such as this client's credential store) that no selected file may be in,
    // even when it sits below the packed directory and a pattern matches it.
    protectedPaths?: string[];
}

const MAX_PATTERNS = 100;
const MAX_PATTERN_LENGTH = 256;

// Patterns are checked as input: a pattern that could reach outside the directory, or
// that means something other than "this path", is refused instead of repaired.
export function compileSelection(include: string[], exclude: string[]) {
    for (const [kind, list] of [
        ["include", include],
        ["exclude", exclude],
    ] as const) {
        if (list.length === 0 || list.length > MAX_PATTERNS) {
            refuse(`Give 1 to ${MAX_PATTERNS} ${kind} patterns.`);
        }
        for (const pattern of list) {
            if (
                pattern.length === 0 ||
                pattern.length > MAX_PATTERN_LENGTH ||
                /[\\\u0000-\u001f\u007f]/.test(pattern) ||
                pattern.startsWith("/") ||
                pattern.startsWith("!") ||
                pattern.startsWith("#") ||
                pattern.split("/").includes("..")
            ) {
                refuse(
                    `The ${kind} pattern ${show(pattern)} must be a relative glob without "..", "!", backslashes or control characters.`,
                );
            }
        }
    }
    // picomatch reads "[!a]" as a set containing "!" and "a", which silently never matches
    // what a shell user means ("not a"), so an exclusion written that way would fail open.
    // It is rewritten to "[^a]", which picomatch does read as "not a".
    const posix = (patterns: string[]) => patterns.map((pattern) => pattern.replaceAll("[!", "[^"));
    include = posix(include);
    exclude = posix(exclude);
    // Exclusions ignore case (a file system may), and apply to every directory above a
    // file too, so "dist/private" excludes what is inside it.
    const base = { dot: true, nocomment: true, posixSlashes: true } as const;
    const included = picomatch(include, base);
    const excluded = picomatch(exclude, { ...base, nocase: true });
    const bases = include.map((pattern) => picomatch.scan(pattern).base.replace(/\/+$/, ""));
    const excludes = (relative: string) => {
        const parts = relative.split("/");
        for (let end = 1; end <= parts.length; end++) {
            const part = parts.slice(0, end).join("/");
            if (excluded(part) || excluded(`${part}/`)) return true;
        }
        return false;
    };
    return {
        // Whether a file may be published.
        selects: (relative: string) => included(relative) && !excludes(relative),
        // Whether a directory could hold anything an include reaches and no exclude covers.
        mayContain: (directory: string) =>
            !excludes(directory) &&
            bases.some(
                (b) =>
                    b === "" ||
                    directory === b ||
                    directory.startsWith(`${b}/`) ||
                    b.startsWith(`${directory}/`),
            ),
    };
}

export interface Packed {
    archive: Uint8Array;
    files: number;
    bytes: number;
}

export async function packDirectory(
    directory: string,
    limits: PackLimits = DEFAULT_PACK_LIMITS,
    selection?: FileSelection,
    signal?: AbortSignal,
): Promise<Packed> {
    const root = path.resolve(directory);
    const choice = selection && compileSelection(selection.include, selection.exclude);
    const within = (rel: string) => (selection!.prefix ? `${selection!.prefix}/${rel}` : rel);
    // Everything packed sits below the prefix, so a secret-named directory in it taints
    // every selected file, although the walk only sees names below the packed directory.
    if (selection?.prefix) {
        checkName(selection.prefix, selection.prefix.split("/"), { ...limits, maxDepth: 1e9 });
    }
    const rootStat = await fs.lstat(root).catch(() => undefined);
    if (!rootStat) refuse(`${show(directory)} does not exist.`);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        refuse(`${show(directory)} is not a directory.`);
    }

    const files: string[] = [];
    let bytes = 0;
    let visited = 0;
    const walk = async (relative: string): Promise<void> => {
        signal?.throwIfAborted();
        const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            if (++visited > MAX_VISITED) {
                refuse(
                    `The directory holds more than ${MAX_VISITED} entries to look through. Deploy a smaller directory.`,
                );
            }
            const rel = relative === "" ? entry.name : `${relative}/${entry.name}`;
            const segments = rel.split("/");
            if (entry.isDirectory()) {
                // With a selection, only a directory that could hold something selected is
                // entered; the rest is neither walked nor judged.
                if (choice && !choice.mayContain(within(rel))) continue;
                if (!choice) checkName(rel, segments, limits);
                // Looked at again without following links: the listing may be stale, and a
                // directory swapped for a link since must not be descended into.
                const now = await fs.lstat(path.join(root, rel));
                if (!now.isDirectory()) {
                    refuse(`${show(rel)} changed while it was being read.`);
                }
                await walk(rel);
                continue;
            }
            // What is not selected is not published and so is not judged.
            if (choice && !choice.selects(within(rel))) continue;
            checkName(rel, segments, limits);
            const here = path.join(root, rel);
            for (const guarded of selection?.protectedPaths ?? []) {
                const inside = path.relative(guarded, here);
                if (
                    inside !== ".." &&
                    !inside.startsWith(`..${path.sep}`) &&
                    !path.isAbsolute(inside)
                ) {
                    refuse(
                        `${show(rel)} is in this client's credential store and must not be deployed.`,
                    );
                }
            }
            if (entry.isFile()) {
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
        refuse(
            choice
                ? "The selected files have no index.html at the top level of the directory."
                : "The directory has no index.html at its top level.",
        );
    }

    // Entries are added one by one: `create` would read a list entry that starts with "@"
    // as an archive to merge in, adding files that were never checked.
    const stream = new Pack({ gzip: true, cwd: root, portable: true, noPax: false });
    for (const file of files) stream.add(file);
    stream.end();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream as AsyncIterable<Buffer>) {
        signal?.throwIfAborted();
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

// The directory being published, as an absolute real path, must not itself sit inside
// credential or version-control data, nor inside any directory in `protectedDirectories`
// (such as the credential store of this client).
export function checkLocation(directory: string, protectedDirectories: string[] = []) {
    const lower = path.resolve(directory).split(path.sep);
    if (lower.some((segment) => SECRET_DIRECTORIES.has(segment.toLowerCase()))) {
        refuse(
            "That directory is inside credential or version-control data and cannot be deployed.",
        );
    }
    for (const guarded of protectedDirectories) {
        const relative = path.relative(guarded, directory);
        // A parent is the segment "..", not any name that merely starts with two dots.
        const outside = relative === ".." || relative.startsWith(`..${path.sep}`);
        if (!outside && !path.isAbsolute(relative)) {
            refuse("That directory holds this client's credentials and cannot be deployed.");
        }
    }
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
    // Opened without following a link that replaced the file since the check above, and
    // the opened file itself is checked: what is read is what was validated.
    const handle = await fs
        .open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
        .catch(() => refuse(`${show(file)} cannot be read as a plain file.`));
    try {
        const opened = await handle.stat();
        if (!opened.isFile()) refuse(`${show(file)} is not a file.`);
        if (opened.size > limits.maxArchiveBytes) tooLarge();
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
