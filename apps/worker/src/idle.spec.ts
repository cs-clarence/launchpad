import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// With deployments off the worker must stay running until it is told to stop. A process that
// exits at once looks like a crash to a supervisor, which then restarts it in a loop.
describe("the worker with deployments off", () => {
    it("idles until it is stopped, then exits cleanly", { timeout: 30_000 }, async () => {
        // A directory with no .env files (Bun would load the package's own) and deployments off
        // stated outright: this must never start a real worker on a developer's machine.
        const cwd = mkdtempSync(path.join(tmpdir(), "launchpad-idle-"));
        const child = spawn("bun", [path.join(import.meta.dirname, "index.ts")], {
            cwd,
            env: { PATH: process.env.PATH, HOME: cwd, LAUNCHPAD_DEPLOYMENTS: "off" },
            stdio: ["ignore", "pipe", "pipe"],
        });
        try {
            await check(child);
        } finally {
            child.kill("SIGKILL");
            rmSync(cwd, { recursive: true, force: true });
        }
    });
});

async function check(child: ChildProcess) {
    let output = "";
    child.stdout?.on("data", (chunk) => (output += chunk));
    let exited: number | null | undefined;
    child.once("exit", (code) => (exited = code));
    for (let i = 0; i < 50 && !output.includes('"event":"disabled"'); i++) {
        await new Promise((r) => setTimeout(r, 100));
    }
    expect(output).toContain('"event":"disabled"');
    await new Promise((r) => setTimeout(r, 1500));
    expect(exited).toBeUndefined();
    child.kill("SIGTERM");
    for (let i = 0; i < 50 && exited === undefined; i++) {
        await new Promise((r) => setTimeout(r, 100));
    }
    expect(exited).toBe(0);
}
