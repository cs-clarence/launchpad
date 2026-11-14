import { constants as fsConstants, promises as fs } from "node:fs";
import type { DokkuConnection } from "./connection";
import { DokkuError } from "./errors";

// Trust is established before anything is sent, and failing it sends nothing.

const KEY_TYPES = new Set([
    "ssh-ed25519",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
    "ssh-rsa",
    "sk-ssh-ed25519@openssh.com",
]);

const distrust = (message: string) =>
    new DokkuError({ kind: "trust", operation: "connect", message });

export interface PinnedKey {
    host: string;
    type: string;
}

// The names ssh uses for this server in known_hosts: the bare host on port 22, and
// `[host]:port` otherwise.
export function knownHostsName(connection: Pick<DokkuConnection, "host" | "port">): string {
    return connection.port === 22 ? connection.host : `[${connection.host}]:${connection.port}`;
}

// A key blob starts with the length-prefixed key type; it must agree with the declared
// type, which catches a truncated or mislabelled entry.
function blobMatchesType(blob: Buffer, type: string): boolean {
    if (blob.length < 4) return false;
    const length = blob.readUInt32BE(0);
    return length === type.length && blob.subarray(4, 4 + length).toString("latin1") === type;
}

// Parses a known_hosts file and returns the keys pinned for exactly this server. It
// accepts only plain, explicit entries: no wildcards, negation, hashed names, markers
// (`@cert-authority` would trust a CA for any host it signs) or other servers' lines
// standing in for this one.
export function pinnedKeysFrom(text: string, connection: DokkuConnection): PinnedKey[] {
    const wanted = knownHostsName(connection).toLowerCase();
    const found: PinnedKey[] = [];
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (line === "" || line.startsWith("#")) continue;
        if (line.startsWith("@"))
            throw distrust("The known_hosts file uses a marker, which is not allowed.");
        const [names, type, key] = line.split(/\s+/);
        if (!names || !type || !key) throw distrust("The known_hosts file has a malformed line.");
        if (/[*?!]/.test(names) || names.startsWith("|")) {
            throw distrust("The known_hosts file has a wildcard, negated or hashed host.");
        }
        if (!KEY_TYPES.has(type))
            throw distrust("The known_hosts file has an unsupported key type.");
        if (
            !/^[A-Za-z0-9+/]+={0,2}$/.test(key) ||
            !blobMatchesType(Buffer.from(key, "base64"), type)
        ) {
            throw distrust("The known_hosts file has a corrupt key.");
        }
        if (names.split(",").some((name) => name.toLowerCase() === wanted)) {
            found.push({ host: wanted, type });
        }
    }
    return found;
}

export async function verifyHostKeys(connection: DokkuConnection): Promise<PinnedKey[]> {
    let text: string;
    try {
        const handle = await fs.open(
            connection.knownHostsPath,
            fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
        );
        try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.size > 256 * 1024) {
                throw distrust("The known_hosts path is not a reasonable regular file.");
            }
            text = await handle.readFile("utf8");
        } finally {
            await handle.close();
        }
    } catch (error) {
        if (error instanceof DokkuError) throw error;
        throw distrust("The known_hosts file cannot be read.");
    }
    const keys = pinnedKeysFrom(text, connection);
    if (keys.length === 0) {
        throw distrust("The known_hosts file has no key pinned for the Dokku host.");
    }
    return keys;
}

// The private key is never read here, only checked: a file that other users can read,
// that belongs to someone else, or that is a link is not used.
export async function verifyPrivateKey(connection: DokkuConnection): Promise<void> {
    try {
        const handle = await fs.open(
            connection.privateKeyPath,
            fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
        );
        try {
            const stat = await handle.stat();
            if (!stat.isFile()) throw distrust("The private key path is not a regular file.");
            if (process.platform !== "win32") {
                if ((stat.mode & 0o077) !== 0) {
                    throw distrust("The private key is readable by others (use mode 600).");
                }
                const owner = process.getuid?.();
                if (owner !== undefined && stat.uid !== owner) {
                    throw distrust("The private key belongs to another user.");
                }
            }
        } finally {
            await handle.close();
        }
    } catch (error) {
        if (error instanceof DokkuError) throw error;
        throw distrust("The private key cannot be used.");
    }
}

export function verifyConnectionShape(connection: DokkuConnection): void {
    const hostOk = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(connection.host);
    const userOk = /^[a-z_][a-z0-9_-]{0,31}$/.test(connection.username);
    const portOk =
        Number.isInteger(connection.port) && connection.port >= 1 && connection.port <= 65535;
    if (!hostOk || !userOk || !portOk) {
        throw distrust("The Dokku host, user or port is not a valid value.");
    }
    // These paths reach ssh options, which split on whitespace and expand `%` and `~`:
    // only plain absolute paths are accepted.
    const plainPath = /^\/[A-Za-z0-9._/@+-]{1,500}$/;
    if (!plainPath.test(connection.privateKeyPath) || !plainPath.test(connection.knownHostsPath)) {
        throw distrust("The key and known_hosts paths must be plain absolute paths.");
    }
}
