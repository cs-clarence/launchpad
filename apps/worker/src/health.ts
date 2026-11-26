import { closeSync, openSync, utimesSync } from "node:fs";

// The worker has no HTTP surface, so its container healthcheck reads a file: it is touched each
// time a queue check or lease renewal succeeds, and by a timer while deployments are off.
// A stale file means the worker's queries are failing: the database is down, or recovery is blocking
// claims after a restore (observed in the 2026-11-26 rehearsal: `unhealthy` after one to two minutes in
// both cases). A fresh one does not prove Docker or Dokku readiness.

export const DEFAULT_HEALTH_TOUCH_MS = 10_000;

// Returns a function that marks the worker healthy now. With no file it does nothing; a failure to
// write is swallowed, because reporting health must never stop the work it reports on.
export function createHealthMarker(file: string | undefined): () => void {
    return () => {
        if (!file) return;
        try {
            const now = new Date();
            try {
                utimesSync(file, now, now);
            } catch {
                closeSync(openSync(file, "w", 0o600));
            }
        } catch {
            // The file system is unwritable: the container will report unhealthy, which is right.
        }
    };
}

export function healthFileFromEnv(env: Record<string, string | undefined>): string | undefined {
    const value = env.LAUNCHPAD_WORKER_HEALTH_FILE;
    if (value === undefined || value === "") return undefined;
    if (!value.startsWith("/") || value.includes("\0") || value.split("/").includes("..")) {
        throw new Error("LAUNCHPAD_WORKER_HEALTH_FILE must be an absolute path without '..'.");
    }
    return value;
}
