import { randomBytes } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { ClientCoreError } from "./errors";

const profileSchema = z.object({
    controller: z.string(),
    apiKey: z.string(),
    organizationId: z.string().nullable(),
    savedAt: z.string(),
});
const configSchema = z.object({
    version: z.literal(1),
    currentProfile: z.string().nullable(),
    profiles: z.record(z.string(), profileSchema),
});

export type Profile = z.infer<typeof profileSchema>;
export type Config = z.infer<typeof configSchema>;

export const emptyConfig = (): Config => ({ version: 1, currentProfile: null, profiles: {} });

export function configDirectory(env: Record<string, string | undefined>): string {
    if (env.LAUNCHPAD_CONFIG_DIR) return env.LAUNCHPAD_CONFIG_DIR;
    if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, "launchpad");
    return path.join(os.homedir(), ".config", "launchpad");
}

const FILE = "credentials.json";

// The credential file: a directory only its owner can enter, a file only its owner can
// read, replaced atomically. It never reads a file it should not trust, and never
// overwrites one it cannot understand: that would silently lose credentials.
export class CredentialStore {
    readonly directory: string;
    readonly file: string;

    constructor(directory: string) {
        this.directory = directory;
        this.file = path.join(directory, FILE);
    }

    // The directory is the trust anchor: it must be a real directory (not a link), ours,
    // and closed to others. Its ancestors are not inspected: they are the user's own, and
    // links in them (a symlinked home, /tmp) are legitimate.
    private async checkDirectory(create: boolean): Promise<boolean> {
        let stat;
        try {
            stat = await fs.lstat(this.directory);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            if (!create) return false;
            await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
            stat = await fs.lstat(this.directory);
        }
        if (!stat.isDirectory()) {
            throw new ClientCoreError(
                "insecure-store",
                `${this.directory} is not a real directory (a link or a file).`,
            );
        }
        if (process.platform !== "win32") {
            const owner = process.getuid?.();
            if (owner !== undefined && stat.uid !== owner) {
                throw new ClientCoreError(
                    "insecure-store",
                    `${this.directory} is owned by another user.`,
                );
            }
            if ((stat.mode & 0o077) !== 0) {
                if (!create) {
                    throw new ClientCoreError(
                        "insecure-store",
                        `${this.directory} is open to others. Run: chmod 700 ${this.directory}`,
                    );
                }
                await fs.chmod(this.directory, 0o700);
            }
        }
        return true;
    }

    // Filesystem failures (permissions, a directory where the file should be, ...) are
    // reported as one typed error, so callers can tell "your credentials are unusable"
    // from a bug.
    private async guard<T>(action: () => Promise<T>): Promise<T> {
        try {
            return await action();
        } catch (error) {
            const code = (error as NodeJS.ErrnoException)?.code;
            if (error instanceof ClientCoreError || typeof code !== "string") throw error;
            throw new ClientCoreError(
                "store-unavailable",
                `Cannot use the credential store at ${this.directory} (${code}).`,
            );
        }
    }

    load(): Promise<Config> {
        return this.guard(() => this.read());
    }

    private async read(): Promise<Config> {
        if (!(await this.checkDirectory(false))) return emptyConfig();
        // Open without following a link, then judge the file that was actually opened, so
        // nothing can be swapped in between the check and the read.
        let handle;
        try {
            // O_NONBLOCK: opening a FIFO with no writer would otherwise hang until the
            // regular-file check below can refuse it.
            handle = await fs.open(
                this.file,
                fsConstants.O_RDONLY |
                    (fsConstants.O_NOFOLLOW ?? 0) |
                    (fsConstants.O_NONBLOCK ?? 0),
            );
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ENOENT") return emptyConfig();
            if (code === "ELOOP") {
                throw new ClientCoreError("insecure-store", `${this.file} is a symbolic link.`);
            }
            throw error;
        }
        let text: string;
        try {
            const stat = await handle.stat();
            if (!stat.isFile()) {
                throw new ClientCoreError("insecure-store", `${this.file} is not a regular file.`);
            }
            if (process.platform !== "win32") {
                const owner = process.getuid?.();
                if (owner !== undefined && stat.uid !== owner) {
                    throw new ClientCoreError(
                        "insecure-store",
                        `${this.file} is owned by another user.`,
                    );
                }
                if ((stat.mode & 0o077) !== 0) {
                    throw new ClientCoreError(
                        "insecure-store",
                        `${this.file} is readable by others. Run: chmod 600 ${this.file}`,
                    );
                }
            }
            text = await handle.readFile("utf8");
        } finally {
            await handle.close();
        }
        let raw: unknown;
        try {
            raw = JSON.parse(text);
        } catch {
            throw new ClientCoreError(
                "corrupt-store",
                `${this.file} is not valid JSON. Fix or remove it; it was not changed.`,
            );
        }
        const version = (raw as { version?: unknown } | null)?.version;
        if (typeof version === "number" && version !== 1) {
            throw new ClientCoreError(
                "unsupported-store",
                `${this.file} was written by a different version of Launchpad (format ${version}); it was not changed.`,
            );
        }
        const parsed = configSchema.safeParse(raw);
        if (!parsed.success) {
            throw new ClientCoreError(
                "corrupt-store",
                `${this.file} does not have the expected shape. Fix or remove it; it was not changed.`,
            );
        }
        return parsed.data;
    }

    // Read-modify-write under a lock, so two commands cannot lose each other's change.
    update<T>(change: (config: Config) => T): Promise<T> {
        return this.guard(() => this.write(change));
    }

    private async write<T>(change: (config: Config) => T): Promise<T> {
        await this.checkDirectory(true);
        const release = await this.lock();
        try {
            const config = await this.read();
            const result = change(config);
            const temp = path.join(this.directory, `.${FILE}.${randomBytes(6).toString("hex")}`);
            const handle = await fs.open(temp, "wx", 0o600);
            try {
                try {
                    await handle.writeFile(JSON.stringify(config, null, 2) + "\n");
                    await handle.sync();
                } finally {
                    await handle.close();
                }
                await fs.rename(temp, this.file);
                return result;
            } finally {
                await fs.rm(temp, { force: true });
            }
        } finally {
            await release();
        }
    }

    private async lock(): Promise<() => Promise<void>> {
        const lockPath = `${this.file}.lock`;
        const token = randomBytes(24).toString("hex");
        for (let attempt = 0; attempt < 50; attempt++) {
            let handle;
            try {
                handle = await fs.open(lockPath, "wx", 0o600);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
                // Never infer that a writer is dead from its lock's age. A slow or
                // suspended writer can still resume, and unlinking a stale path races
                // with another waiter acquiring that same path.
                await new Promise((resolve) => setTimeout(resolve, 20));
                continue;
            }
            try {
                await handle.writeFile(token);
            } catch (error) {
                await fs.rm(lockPath, { force: true });
                throw error;
            } finally {
                await handle.close();
            }
            return async () => {
                const current = await fs.readFile(lockPath, "utf8").catch((error) => {
                    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
                    throw error;
                });
                if (current === token) await fs.rm(lockPath, { force: true });
            };
        }
        throw new ClientCoreError(
            "store-busy",
            `The credential store is busy. Retry after other commands finish. If a command crashed, remove ${lockPath} only after confirming no client is writing.`,
        );
    }
}
