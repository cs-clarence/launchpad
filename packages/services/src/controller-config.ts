import { parseDuration } from "@launchpad-kit/contracts";
import { DEPLOYMENT_LEASE_MS } from "./deployment-claims";

// Controller settings that are not part of the deployment model. Pure: reads only the object it
// is given. Each error names the variable, so a bad value stops the process at startup with a
// message the operator can act on.

type Env = Record<string, string | undefined>;

export const DEFAULT_SCHEMA_CHECK_INTERVAL_SECONDS = 10;
export const MAX_SCHEMA_CHECK_INTERVAL_SECONDS = 300;
export const DEFAULT_SCHEMA_CHECK_TIMEOUT_SECONDS = 4;
export const MIN_SCHEMA_CHECK_TIMEOUT_SECONDS = 1;
export const MAX_SCHEMA_CHECK_TIMEOUT_SECONDS = 30;

export interface SchemaCheckConfig {
    // How long a passed database check stays valid; null (`off`) means a pass is final.
    intervalMs: number | null;
    // The hard deadline of one check.
    timeoutMs: number;
}

function text(env: Env, name: string): string | undefined {
    const value = env[name]?.trim();
    return value === undefined || value === "" ? undefined : value;
}

export function parseSchemaCheckConfig(env: Env): SchemaCheckConfig {
    const intervalText = text(env, "LAUNCHPAD_SCHEMA_CHECK_INTERVAL");
    let intervalSeconds: number | null = DEFAULT_SCHEMA_CHECK_INTERVAL_SECONDS;
    if (intervalText !== undefined) {
        if (intervalText.toLowerCase() === "off" || intervalText === "0") {
            intervalSeconds = null;
        } else {
            const seconds = parseDuration(intervalText);
            if (seconds === null || seconds < 1 || seconds > MAX_SCHEMA_CHECK_INTERVAL_SECONDS) {
                throw new Error(
                    'LAUNCHPAD_SCHEMA_CHECK_INTERVAL must be a duration from 1s to 5m, or "off".',
                );
            }
            intervalSeconds = seconds;
        }
    }

    const timeoutText = text(env, "LAUNCHPAD_SCHEMA_CHECK_TIMEOUT");
    let timeoutSeconds = DEFAULT_SCHEMA_CHECK_TIMEOUT_SECONDS;
    if (timeoutText !== undefined) {
        const seconds = parseDuration(timeoutText);
        if (
            seconds === null ||
            seconds < MIN_SCHEMA_CHECK_TIMEOUT_SECONDS ||
            seconds > MAX_SCHEMA_CHECK_TIMEOUT_SECONDS
        ) {
            throw new Error("LAUNCHPAD_SCHEMA_CHECK_TIMEOUT must be a duration from 1s to 30s.");
        }
        timeoutSeconds = seconds;
    }
    if (intervalSeconds !== null && timeoutSeconds >= intervalSeconds) {
        throw new Error(
            `LAUNCHPAD_SCHEMA_CHECK_TIMEOUT (${timeoutSeconds}s) must be shorter than ` +
                `LAUNCHPAD_SCHEMA_CHECK_INTERVAL (${intervalSeconds}s).`,
        );
    }
    return {
        intervalMs: intervalSeconds === null ? null : intervalSeconds * 1000,
        timeoutMs: timeoutSeconds * 1000,
    };
}

export const WORKER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// Worker liveness settings (docs/plans/rehearsal-defects-fixes-2.md). A lease is renewed every
// 2 s while a run is in flight and lasts DEPLOYMENT_LEASE_MS; every bound below is derived from
// it so a worker that stopped is reported at least a minute before its lease can expire.
const LEASE_SECONDS = DEPLOYMENT_LEASE_MS / 1000;
export const HEARTBEAT_MARGIN_SECONDS = 60;
export const MIN_BEAT_SECONDS = 5;
export const MAX_BEAT_SECONDS = 60;
export const MIN_STALE_SECONDS = 15;
export const MAX_STALE_SECONDS = LEASE_SECONDS - HEARTBEAT_MARGIN_SECONDS;
export const MIN_WARN_SECONDS = 30;
export const MAX_WARN_SECONDS = LEASE_SECONDS - HEARTBEAT_MARGIN_SECONDS;
export const MIN_PRUNE_SECONDS = 3600;
export const MAX_PRUNE_SECONDS = 90 * 86_400;

export interface HeartbeatConfig {
    beatSeconds: number;
    staleAfterSeconds: number;
    warnBeforeSeconds: number;
    pruneAfterSeconds: number;
}

export const DEFAULT_HEARTBEAT: HeartbeatConfig = {
    beatSeconds: 15,
    staleAfterSeconds: 60,
    warnBeforeSeconds: 90,
    pruneAfterSeconds: 7 * 86_400,
};

function describe(seconds: number): string {
    if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
    if (seconds % 3600 === 0) return `${seconds / 3600}h`;
    if (seconds % 60 === 0) return `${seconds / 60}m`;
    return `${seconds}s`;
}

function bounded(env: Env, name: string, fallback: number, min: number, max: number): number {
    const raw = text(env, name);
    if (raw === undefined) return fallback;
    const seconds = parseDuration(raw);
    if (seconds === null || seconds < min || seconds > max) {
        throw new Error(`${name} must be a duration from ${describe(min)} to ${describe(max)}.`);
    }
    return seconds;
}

// The worker validates the beat, the stale limit and the prune age; the controller validates
// the stale limit and the lease warning. A setting a process does not read is not required (or
// parsed) there: it keeps its default in the result.
export function parseHeartbeatConfig(env: Env, role: "worker" | "controller"): HeartbeatConfig {
    const config = { ...DEFAULT_HEARTBEAT };
    config.staleAfterSeconds = bounded(
        env,
        "LAUNCHPAD_WORKER_STALE_AFTER",
        config.staleAfterSeconds,
        MIN_STALE_SECONDS,
        MAX_STALE_SECONDS,
    );
    if (role === "worker") {
        config.beatSeconds = bounded(
            env,
            "LAUNCHPAD_WORKER_HEARTBEAT_INTERVAL",
            config.beatSeconds,
            MIN_BEAT_SECONDS,
            MAX_BEAT_SECONDS,
        );
        config.pruneAfterSeconds = bounded(
            env,
            "LAUNCHPAD_WORKER_PRUNE_AFTER",
            config.pruneAfterSeconds,
            MIN_PRUNE_SECONDS,
            MAX_PRUNE_SECONDS,
        );
        if (config.staleAfterSeconds < 3 * config.beatSeconds) {
            throw new Error(
                "LAUNCHPAD_WORKER_STALE_AFTER must be at least 3 times " +
                    `LAUNCHPAD_WORKER_HEARTBEAT_INTERVAL (${describe(3 * config.beatSeconds)}).`,
            );
        }
    } else {
        config.warnBeforeSeconds = bounded(
            env,
            "LAUNCHPAD_LEASE_WARN_BEFORE",
            config.warnBeforeSeconds,
            MIN_WARN_SECONDS,
            MAX_WARN_SECONDS,
        );
    }
    return config;
}
