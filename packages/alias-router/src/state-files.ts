import {
    chmodSync,
    closeSync,
    constants,
    fstatSync,
    lstatSync,
    openSync,
    realpathSync,
    type Stats,
    unlinkSync,
} from "node:fs";
import path from "node:path";
import { RouterError } from "./protocol";

interface Identity {
    dev: number;
    ino: number;
    uid: number;
    mode: number;
}
function identity(stat: Stats): Identity {
    return { dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode };
}
function same(a: Identity, b: Identity): boolean {
    return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode;
}
function owned(stat: Stats, permissions: number, directory = false): void {
    if (
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o7777) !== permissions ||
        !(directory ? stat.isDirectory() : stat.isFile())
    )
        throw new RouterError("unavailable");
}
function optionalStat(file: string): Stats | null {
    try {
        return lstatSync(file);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
}

// R1 intentionally requires POSIX-owned private state. No automatic directory creation,
// permission repair or symlink following. Changes latch the owning store unavailable.
export class StateFiles {
    readonly file: string;
    #directory: string;
    #directoryIdentity: Identity;
    #fileIdentity: Identity;
    #sidecars = new Map<string, Identity>();

    constructor(file: string, create: boolean) {
        // Set only by a successful exclusive create, so a pre-existing file is never removed.
        let created = false;
        try {
            if (
                !path.isAbsolute(file) ||
                path.normalize(file) !== file ||
                realpathSync(path.dirname(file)) !== path.dirname(file)
            ) {
                throw new RouterError("unavailable");
            }
            this.file = file;
            this.#directory = path.dirname(file);
            const directory = lstatSync(this.#directory);
            owned(directory, 0o700, true);
            this.#directoryIdentity = identity(directory);
            // Refuse stale sidecars for a new file, rather than adopting another store's WAL.
            if (create && ["-wal", "-shm"].some((suffix) => optionalStat(`${file}${suffix}`))) {
                throw new RouterError("unavailable");
            }
            // A rollback journal could be replayed by SQLite before any of our checks run.
            if (optionalStat(`${file}-journal`)) throw new RouterError("unavailable");
            const fd = openSync(
                file,
                (create ? constants.O_CREAT | constants.O_EXCL : 0) |
                    constants.O_RDWR |
                    constants.O_NOFOLLOW |
                    constants.O_NONBLOCK,
                0o600,
            );
            created = create;
            try {
                const stat = fstatSync(fd);
                owned(stat, 0o600);
                this.#fileIdentity = identity(stat);
            } finally {
                closeSync(fd);
            }
            for (const suffix of ["-wal", "-shm"]) {
                const stat = optionalStat(`${file}${suffix}`);
                if (stat) {
                    owned(stat, 0o600);
                    this.#sidecars.set(suffix, identity(stat));
                }
            }
            this.check();
        } catch {
            // A bad umask or mode must not leave a file that makes `init` impossible to retry.
            if (created) this.discard();
            throw new RouterError("unavailable");
        }
    }

    check(): void {
        try {
            const directory = lstatSync(this.#directory);
            const file = lstatSync(this.file);
            owned(directory, 0o700, true);
            owned(file, 0o600);
            if (
                !same(identity(directory), this.#directoryIdentity) ||
                !same(identity(file), this.#fileIdentity)
            )
                throw new RouterError("unavailable");
            for (const suffix of ["-wal", "-shm"]) {
                const current = optionalStat(`${this.file}${suffix}`);
                const previous = this.#sidecars.get(suffix);
                if (previous && (!current || !same(identity(current), previous))) {
                    throw new RouterError("unavailable");
                }
                if (current) owned(current, 0o600);
            }
        } catch {
            throw new RouterError("unavailable");
        }
    }

    // Only for a failed initialization, which created exactly these paths: leave no half-made
    // store behind, so initialization can simply be retried.
    discard(): void {
        for (const suffix of ["", "-wal", "-shm", "-journal"]) {
            try {
                unlinkSync(`${this.file}${suffix}`);
            } catch {
                // Already absent.
            }
        }
    }

    // Call after SQLite has created sidecars, while the containing directory is private.
    captureSidecars(): void {
        try {
            for (const suffix of ["-wal", "-shm"]) {
                if (this.#sidecars.has(suffix)) continue;
                const file = `${this.file}${suffix}`;
                const stat = optionalStat(file);
                if (!stat) continue;
                if (!stat.isFile() || stat.uid !== process.getuid?.())
                    throw new RouterError("unavailable");
                chmodSync(file, 0o600);
                this.#sidecars.set(suffix, identity(lstatSync(file)));
            }
            this.check();
        } catch {
            throw new RouterError("unavailable");
        }
    }
}
