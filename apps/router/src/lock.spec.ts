import { chmodSync, existsSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { acquireProcessLock, LockError, lockFileFor } from "./lock";
import { tempState, type TempState } from "./test-support";

let state: TempState;
afterEach(() => state?.cleanup());

function refused(reason: "held" | "unusable", action: () => unknown) {
    try {
        action();
    } catch (error) {
        expect(error).toBeInstanceOf(LockError);
        expect((error as LockError).reason).toBe(reason);
        return;
    }
    throw new Error("Expected a LockError.");
}

describe("process lock", () => {
    it("is exclusive, released explicitly, and leaves an empty private file", () => {
        state = tempState();
        const first = acquireProcessLock(state.stateFile);
        const file = lockFileFor(state.stateFile);
        expect(statSync(file).mode & 0o777).toBe(0o600);
        expect(statSync(file).size).toBe(0);
        refused("held", () => acquireProcessLock(state.stateFile));
        first.release();
        first.release(); // idempotent
        acquireProcessLock(state.stateFile).release();
        expect(readFileSync(file).length).toBe(0);
    });

    it("fails closed on a file with content, wrong mode, a symlink or a non-private directory", () => {
        state = tempState();
        const file = lockFileFor(state.stateFile);
        writeFileSync(file, "pid 1234 (someone wrote this)", { mode: 0o600 });
        refused("unusable", () => acquireProcessLock(state.stateFile));
        // The contents are never trusted, interpreted or "repaired".
        expect(readFileSync(file, "utf8")).toBe("pid 1234 (someone wrote this)");
        writeFileSync(file, "", { mode: 0o600 });
        chmodSync(file, 0o644);
        refused("unusable", () => acquireProcessLock(state.stateFile));
        chmodSync(file, 0o600);
        acquireProcessLock(state.stateFile).release();

        const other = tempState();
        try {
            symlinkSync(file, lockFileFor(other.stateFile));
            refused("unusable", () => acquireProcessLock(other.stateFile));
        } finally {
            other.cleanup();
        }
        chmodSync(state.directory, 0o755);
        refused("unusable", () => acquireProcessLock(state.stateFile));
        chmodSync(state.directory, 0o700);
        expect(existsSync(file)).toBe(true);
    });
});
