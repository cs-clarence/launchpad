import { spawn } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireProcessLock, LockError } from "../lock";
import { tempState, type TempState } from "../test-support";

// A second *process* is the only real test of the kernel lock: within one process SQLite shares its
// own bookkeeping, which is exactly what hid a defect where a refused in-process attempt dropped
// the lock a first attempt was holding.

let state: TempState;
afterEach(() => state?.cleanup());

const LOCK = path.resolve(__dirname, "../lock.ts");
function otherProcess(stateFile: string): Promise<string> {
    return new Promise((resolve) => {
        const child = spawn(
            "bun",
            [
                "-e",
                `import { acquireProcessLock } from ${JSON.stringify(LOCK)};
                 try { acquireProcessLock(${JSON.stringify(stateFile)}).release(); console.log("ACQUIRED"); }
                 catch (e) { console.log(e.reason ?? "error"); }`,
            ],
            { env: { PATH: process.env.PATH, HOME: process.env.HOME } as NodeJS.ProcessEnv },
        );
        let out = "";
        child.stdout.on("data", (c) => (out += c));
        child.on("close", () => resolve(out.trim()));
    });
}

describe("kernel lock across processes", () => {
    it("excludes another process, and still does after a refused attempt in this process", async () => {
        state = tempState();
        const held = acquireProcessLock(state.stateFile);
        expect(await otherProcess(state.stateFile)).toBe("held");
        // The regression: this refused attempt used to close a descriptor and drop the real lock.
        expect(() => acquireProcessLock(state.stateFile)).toThrow(LockError);
        expect(() => acquireProcessLock(state.stateFile)).toThrow(LockError);
        expect(await otherProcess(state.stateFile)).toBe("held");
        held.release();
        expect(await otherProcess(state.stateFile)).toBe("ACQUIRED");
    });
});
