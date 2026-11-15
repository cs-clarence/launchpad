import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Test support: never exported.

export async function tempDir(): Promise<{ dir: string; cleanup(): Promise<void> }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "launchpad-worker-"));
    return { dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

// An executable that stands in for docker. `body` is shell script.
export async function fakeDocker(dir: string, body: string): Promise<string> {
    const file = path.join(dir, `docker-${Math.random().toString(16).slice(2)}`);
    await fs.writeFile(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
}

export const LIMITS = { maxExpandedBytes: 10 * 1024 * 1024, maxEntries: 100, maxDepth: 8 };
