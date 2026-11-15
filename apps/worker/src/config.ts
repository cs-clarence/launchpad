import os from "node:os";
import { deploymentsEnabled } from "@launchpad/services";
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
}

function required(env: Record<string, string | undefined>, name: string): string {
    const value = env[name];
    if (!value) throw new Error(`${name} is required when deployments are on.`);
    return value;
}

function integer(value: string | undefined, name: string, fallback: number, min: number): number {
    if (value === undefined || value === "") return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < min) {
        throw new Error(`${name} must be an integer of at least ${min}.`);
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
            dataDir: required(env, "LAUNCHPAD_DATA_DIR"),
            workerId: env.LAUNCHPAD_WORKER_ID || `${os.hostname()}-${process.pid}`,
            dokku: {
                host: required(env, "DOKKU_SSH_HOST"),
                port: integer(env.DOKKU_SSH_PORT, "DOKKU_SSH_PORT", 22, 1),
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
                60_000,
            ),
        },
    };
}
