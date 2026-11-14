import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
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
const LOCK_STALE_MS = 30_000;

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

    async load(): Promise<Config> {
        let stat;
        try {
            stat = await fs.lstat(this.file);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyConfig();
            throw error;
        }
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
        let raw: unknown;
        try {
            raw = JSON.parse(await fs.readFile(this.file, "utf8"));
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
    async update<T>(change: (config: Config) => T): Promise<T> {
        await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
        if (process.platform !== "win32") await fs.chmod(this.directory, 0o700);
        const release = await this.lock();
        try {
            const config = await this.load();
            const result = change(config);
            const temp = path.join(this.directory, `.${FILE}.${randomBytes(6).toString("hex")}`);
            const handle = await fs.open(temp, "wx", 0o600);
            try {
                await handle.writeFile(JSON.stringify(config, null, 2) + "\n");
                await handle.sync();
            } finally {
                await handle.close();
            }
            await fs.rename(temp, this.file);
            return result;
        } finally {
            await release();
        }
    }

    private async lock(): Promise<() => Promise<void>> {
        const lockPath = `${this.file}.lock`;
        for (let attempt = 0; attempt < 50; attempt++) {
            try {
                const handle = await fs.open(lockPath, "wx", 0o600);
                await handle.close();
                return () => fs.rm(lockPath, { force: true });
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
                const age = await fs
                    .stat(lockPath)
                    .then((s) => Date.now() - s.mtimeMs)
                    .catch(() => 0);
                if (age > LOCK_STALE_MS) await fs.rm(lockPath, { force: true });
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
        }
        throw new ClientCoreError(
            "corrupt-store",
            `Could not lock ${this.file}; another command may be stuck.`,
        );
    }
}
