import { spawn } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

// With deployments off the worker must stay running until it is told to stop. A process that
// exits at once looks like a crash to a supervisor, which then restarts it in a loop.
describe("the worker with deployments off", () => {
    it("idles until it is stopped, then exits cleanly", async () => {
        const child = spawn("bun", [path.join(import.meta.dirname, "index.ts")], {
            env: { PATH: process.env.PATH, HOME: process.env.HOME },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.on("data", (chunk) => (output += chunk));
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
    });
});
