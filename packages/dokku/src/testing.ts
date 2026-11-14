import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DokkuConnection } from "./connection";
import { knownHostsName } from "./trust";

// Test support: never exported from the package.

// An OpenSSH public key blob for `type`: the length-prefixed type, then key bytes.
export function keyBlob(type = "ssh-ed25519"): string {
    const name = Buffer.from(type, "latin1");
    const head = Buffer.alloc(4);
    head.writeUInt32BE(name.length);
    const body = Buffer.alloc(36);
    body.writeUInt32BE(32);
    return Buffer.concat([head, name, body]).toString("base64");
}

export const knownHostsLine = (names: string, type = "ssh-ed25519") =>
    `${names} ${type} ${keyBlob(type)}`;

export interface Workspace {
    dir: string;
    connection: DokkuConnection;
    cleanup(): Promise<void>;
}

// A directory with a private key (mode 600) and a known_hosts that pins the host.
export async function workspace(overrides: Partial<DokkuConnection> = {}): Promise<Workspace> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "launchpad-dokku-"));
    const connection: DokkuConnection = {
        host: "dokku.example.com",
        port: 3022,
        username: "dokku",
        privateKeyPath: path.join(dir, "id_ed25519"),
        knownHostsPath: path.join(dir, "known_hosts"),
        ...overrides,
    };
    await fs.writeFile(connection.privateKeyPath, "-----BEGIN PRIVATE KEY-----\nx\n", {
        mode: 0o600,
    });
    await fs.writeFile(
        connection.knownHostsPath,
        knownHostsLine(knownHostsName(connection)) + "\n",
    );
    return { dir, connection, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

// An executable that stands in for ssh. `body` is shell script.
export async function fakeSsh(dir: string, body: string): Promise<string> {
    const file = path.join(dir, `ssh-${Math.random().toString(16).slice(2)}`);
    await fs.writeFile(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
}
