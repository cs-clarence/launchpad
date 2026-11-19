import { Database } from "bun:sqlite";
import { closeSync, constants, lstatSync, openSync } from "node:fs";
import path from "node:path";

// One router process owns the routing state. The lock is held by the kernel, not inferred from a
// PID: a dedicated SQLite file opened with an exclusive lock for the life of the process. A crash
// releases it (there is no stale lock to detect), and a PID cannot be reused or misjudged across
// containers sharing a volume. The file is empty by construction; a file with any content is
// refused rather than interpreted.

export class LockError extends Error {
    constructor(readonly reason: "held" | "unusable") {
        super(
            reason === "held"
                ? "Another router process holds the state lock."
                : "The state lock file is unusable (wrong owner or mode, not empty, or not private).",
        );
        this.name = "LockError";
    }
}

export interface ProcessLock {
    release(): void;
}

export function lockFileFor(stateFile: string): string {
    return `${stateFile}.lock`;
}

interface Identity {
    dev: number;
    ino: number;
}

function inspect(file: string, uid: number | undefined): Identity {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o777) !== 0o600 || stat.size !== 0) {
        throw new LockError("unusable");
    }
    return { dev: stat.dev, ino: stat.ino };
}

// Never open the lock file with a Node descriptor once SQLite may hold a lock on it: POSIX locks
// belong to the process, and closing *any* descriptor for the file releases *all* of them, so a
// refused second attempt in this process would silently drop the first attempt's real lock. The
// file is therefore only created here (exclusively, where no lock can exist) and otherwise checked
// by path; SQLite alone opens it, and the same path is checked again once the lock is held.
export function acquireProcessLock(stateFile: string): ProcessLock {
    const file = lockFileFor(stateFile);
    const uid = process.getuid?.();
    let before: Identity;
    try {
        const directory = lstatSync(path.dirname(file));
        if (
            !directory.isDirectory() ||
            directory.uid !== uid ||
            (directory.mode & 0o777) !== 0o700
        ) {
            throw new LockError("unusable");
        }
        try {
            closeSync(
                openSync(
                    file,
                    constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
                    0o600,
                ),
            );
        } catch (error) {
            // An existing file is the normal case; anything else is not usable.
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new LockError("unusable");
        }
        before = inspect(file, uid);
    } catch (error) {
        throw error instanceof LockError ? error : new LockError("unusable");
    }
    const db = new Database(file, { create: false });
    try {
        db.exec("PRAGMA locking_mode=EXCLUSIVE");
        db.exec("BEGIN EXCLUSIVE");
    } catch (error) {
        db.close();
        const code = (error as { code?: unknown }).code;
        throw new LockError(
            code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" ? "held" : "unusable",
        );
    }
    try {
        // The path must still name the file we inspected, so a swap between the check and SQLite's
        // own open cannot leave us holding a lock on something else.
        const after = inspect(file, uid);
        if (after.dev !== before.dev || after.ino !== before.ino) throw new LockError("unusable");
    } catch (error) {
        db.close();
        throw error instanceof LockError ? error : new LockError("unusable");
    }
    let released = false;
    return {
        release() {
            if (released) return;
            released = true;
            db.close();
        },
    };
}
