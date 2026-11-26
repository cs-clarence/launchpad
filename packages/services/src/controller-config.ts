import { parseDuration } from "@launchpad-kit/contracts";

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
