import { randomUUID } from "node:crypto";

const WORKER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// The name recorded as the lease owner on claimed work and in the worker's logs. Unset or empty
// means a new random identity for every process.
//
// Claims are fenced by an attempt and a fence counter that every claim advances, not by this
// name, so a stable name cannot let a stale process write. It identifies a worker; it does not
// change recovery: work is reclaimed only after its lease expires, whatever the name.
export function workerIdFromEnv(env: Record<string, string | undefined>): string {
    const value = env.LAUNCHPAD_WORKER_ID?.trim();
    if (!value) return randomUUID();
    if (!WORKER_ID.test(value)) {
        throw new Error(
            "LAUNCHPAD_WORKER_ID must be 1 to 64 characters: letters, digits, '.', '_' or '-', starting with a letter or digit.",
        );
    }
    return value;
}
