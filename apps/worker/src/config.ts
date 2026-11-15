import os from "node:os";
import path from "node:path";
import {
    artifactLimitsFromEnv,
    deploymentsEnabled,
    resolveLimits,
    type ArchiveLimits,
} from "@launchpad/services";
import { DEFAULT_BASE_IMAGE, checkBaseImage } from "./template";
import { parseProxyUrl } from "./verify";

export interface WorkerConfig {
    databaseUrl: string;
    dataDir: string;
    workerId: string;
    dokku: {
        host: string;
        port: number;
        username: string;
        privateKeyPath: string;
        knownHostsPath: string;
    };
    proxyUrl: URL;
    baseImage: string;
    dockerBinary: string;
    pollMs: number;
    leaseMs: number;
    // The same limits the controller enforces at upload, from the same settings.
    archiveLimits: ArchiveLimits;
}

// Each step's deadline is 80% of the lease and the image load alone may take 10 minutes
// (plus the call's own overhead), so a shorter lease would abort every load and end
// every deployment held for reconciliation.
export const MIN_LEASE_MS = 14 * 60_000;
// A rollback may run for 1.6 times the lease; keeping that under the hour after which
// abandoned scratch directories are swept means a live build is never swept.
export const MAX_LEASE_MS = 30 * 60_000;

// docker is only handed plain absolute paths.
const PLAIN_DIR = /^\/[A-Za-z0-9._/@+-]{1,400}$/;

function required(env: Record<string, string | undefined>, name: string): string {
    const value = env[name];
    if (!value) throw new Error(`${name} is required when deployments are on.`);
    return value;
}

function integer(
    value: string | undefined,
    name: string,
    fallback: number,
    min: number,
    max = Number.MAX_SAFE_INTEGER,
): number {
    if (value === undefined || value === "") return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
        throw new Error(`${name} must be an integer from ${min} to ${max}.`);
    }
    return parsed;
}

// Off unless explicitly on; when off nothing else is read, so a half-configured
// environment cannot start work by accident.
export function loadConfig(
    env: Record<string, string | undefined>,
): { enabled: false } | { enabled: true; config: WorkerConfig } {
    if (!deploymentsEnabled(env.LAUNCHPAD_DEPLOYMENTS)) return { enabled: false };
    return {
        enabled: true,
        config: {
            databaseUrl: required(env, "DATABASE_URL"),
            dataDir: plainDataDir(required(env, "LAUNCHPAD_DATA_DIR")),
            workerId: env.LAUNCHPAD_WORKER_ID || `${os.hostname()}-${process.pid}`,
            dokku: {
                host: required(env, "DOKKU_SSH_HOST"),
                port: integer(env.DOKKU_SSH_PORT, "DOKKU_SSH_PORT", 22, 1, 65535),
                username: env.DOKKU_SSH_USER || "dokku",
                privateKeyPath: required(env, "DOKKU_SSH_KEY_PATH"),
                knownHostsPath: required(env, "DOKKU_SSH_KNOWN_HOSTS_PATH"),
            },
            proxyUrl: parseProxyUrl(required(env, "LAUNCHPAD_PREVIEW_PROXY_URL")),
            baseImage: checkBaseImage(env.LAUNCHPAD_BASE_IMAGE || DEFAULT_BASE_IMAGE),
            dockerBinary: env.LAUNCHPAD_DOCKER_BIN || "docker",
            pollMs: integer(env.LAUNCHPAD_WORKER_POLL_MS, "LAUNCHPAD_WORKER_POLL_MS", 2000, 100),
            leaseMs: integer(
                env.LAUNCHPAD_WORKER_LEASE_MS,
                "LAUNCHPAD_WORKER_LEASE_MS",
                15 * 60_000,
                MIN_LEASE_MS,
                MAX_LEASE_MS,
            ),
            archiveLimits: archiveLimits(env),
        },
    };
}

function plainDataDir(value: string): string {
    const resolved = path.resolve(value);
    if (!PLAIN_DIR.test(resolved)) {
        throw new Error(
            "LAUNCHPAD_DATA_DIR must resolve to a plain absolute path (letters, digits and . _ / @ + -).",
        );
    }
    return resolved;
}

function archiveLimits(env: Record<string, string | undefined>): ArchiveLimits {
    const limits = resolveLimits(artifactLimitsFromEnv(env));
    return {
        maxExpandedBytes: limits.maxExpandedBytes,
        maxEntries: limits.maxEntries,
        maxDepth: limits.maxDepth,
    };
}
