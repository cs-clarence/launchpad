import { hostname as osHostname } from "node:os";
import { WORKER_NAME_PATTERN } from "@launchpad-kit/services";

export interface WorkerName {
    name: string;
    // Set through the deprecated `LAUNCHPAD_WORKER_ID`.
    deprecatedAlias: boolean;
}

// The hostname as a worker name: lower case, anything outside the allowed characters replaced,
// at most 64 characters, starting with a letter or digit; `worker` if nothing is left.
export function nameFromHostname(hostname: string): string {
    const cleaned = hostname
        .toLowerCase()
        .replace(/[^a-z0-9._-]/g, "-")
        .slice(0, 64)
        .replace(/^[^a-z0-9]+/, "");
    return cleaned || "worker";
}

// A worker's stable name: the key of its heartbeat row and the lease owner recorded on claimed
// work and in logs. `LAUNCHPAD_WORKER_NAME`, else the deprecated `LAUNCHPAD_WORKER_ID` (same
// rules, so installs that set it keep their name), else the hostname. Under Compose the hostname
// is fixed (`launchpad-worker`), so the name survives recreating the container.
//
// Claims are fenced by an attempt and a fence counter that every claim advances, not by this
// name, so a stable name cannot let a stale process write. It identifies a worker; it does not
// change recovery: work is reclaimed only after its lease expires, whatever the name.
export function workerNameFromEnv(
    env: Record<string, string | undefined>,
    hostname: () => string = osHostname,
): WorkerName {
    for (const [variable, deprecatedAlias] of [
        ["LAUNCHPAD_WORKER_NAME", false],
        ["LAUNCHPAD_WORKER_ID", true],
    ] as const) {
        const value = env[variable]?.trim();
        if (!value) continue;
        if (!WORKER_NAME_PATTERN.test(value)) {
            throw new Error(
                `${variable} must be 1 to 64 characters: letters, digits, '.', '_' or '-', starting with a letter or digit.`,
            );
        }
        return { name: value, deprecatedAlias };
    }
    return { name: nameFromHostname(hostname()), deprecatedAlias: false };
}
