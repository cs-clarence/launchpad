import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The worker has no deploy loop while deployments are off; it must stay running until it is told to stop. A process that
// exits at once looks like a crash to a supervisor, which then restarts it in a loop.
describe("the idle worker", () => {
    it("idles until it is stopped, then exits cleanly", { timeout: 30_000 }, async () => {
        // A directory with no .env files (Bun would load the package's own): nothing here may
        // reach a database, Dokku or Docker on a developer's machine.
        const cwd = mkdtempSync(path.join(tmpdir(), "launchpad-idle-"));
        const child = spawn("bun", [path.join(import.meta.dirname, "index.ts")], {
            cwd,
            env: {
                PATH: process.env.PATH,
                HOME: cwd,
                LAUNCHPAD_WORKER_HEALTH_FILE: path.join(cwd, "healthy"),
            },
            stdio: ["ignore", "pipe", "pipe"],
        });
        try {
            await check(child, path.join(cwd, "healthy"));
        } finally {
            child.kill("SIGKILL");
            rmSync(cwd, { recursive: true, force: true });
        }
    });
});

describe("the idle worker's configuration check", () => {
    it("requires connection settings only when enabled", { timeout: 30_000 }, () => {
        const cwd = mkdtempSync(path.join(tmpdir(), "launchpad-enabled-config-"));
        try {
            const run = spawnSync("bun", [path.join(import.meta.dirname, "index.ts")], {
                cwd,
                env: {
                    PATH: process.env.PATH,
                    HOME: cwd,
                    LAUNCHPAD_DEPLOYMENTS: "on",
                    LAUNCHPAD_APPS_DOMAIN: "sites.example.net",
                    LAUNCHPAD_BASE_URL: "https://manage.example.org",
                },
                encoding: "utf8",
                timeout: 20_000,
            });
            expect(run.status).toBe(1);
            expect(run.stderr).toContain("DATABASE_URL is required when deployments are on");
        } finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
});

async function check(child: ChildProcess, healthFile: string) {
    let output = "";
    child.stdout?.on("data", (chunk) => (output += chunk));
    let exited: number | null | undefined;
    child.once("exit", (code) => (exited = code));
    for (let i = 0; i < 50 && !output.includes('"event":"deployment-worker-idle"'); i++) {
        await new Promise((r) => setTimeout(r, 100));
    }
    expect(output).toContain('"event":"deployment-worker-idle"');
    // Idle counts as healthy: the file the container healthcheck reads exists.
    expect(existsSync(healthFile)).toBe(true);
    await new Promise((r) => setTimeout(r, 1500));
    expect(exited).toBeUndefined();
    child.kill("SIGTERM");
    for (let i = 0; i < 50 && exited === undefined; i++) {
        await new Promise((r) => setTimeout(r, 100));
    }
    expect(exited).toBe(0);
}
