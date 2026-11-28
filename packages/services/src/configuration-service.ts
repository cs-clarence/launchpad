import type { Database } from "@launchpad-kit/database";
import type { Kysely } from "kysely";

type Env = Record<string, string | undefined>;

// Settings an operator may change without editing a process environment. Resolution order is the
// `app_setting` row, then the environment variable, then the default; a database override therefore
// wins over what a deployment sets, and a missing row changes nothing.
export interface Configuration {
    // A development controller may mark seeded addresses verified so email flows that production
    // restricts to verified addresses can be exercised. See verifyEmailForDevelopment.
    development: boolean;
}

interface Setting<T> {
    readonly env: string;
    readonly fallback: T;
    readonly parse: (value: string, source: string) => T;
}

const strictBoolean = (value: string, source: string): boolean => {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
    throw new Error(`${source} must be true or false.`);
};

// The single registry of known settings: a key here is a key in `Configuration`, one row in
// `app_setting`, one environment variable and one default. Unknown rows are ignored, so a newer
// deployment that writes a setting an older binary does not know cannot stop it.
const SETTINGS: { [K in keyof Configuration]: Setting<Configuration[K]> } = {
    development: { env: "LAUNCHPAD_DEVELOPMENT", fallback: false, parse: strictBoolean },
};

function resolve<T>(
    key: keyof Configuration,
    setting: Setting<T>,
    stored: ReadonlyMap<string, string>,
    env: Env,
): T {
    const row = stored.get(key);
    if (row !== undefined) return setting.parse(row, `app_setting "${key}"`);
    const value = env[setting.env]?.trim();
    if (value !== undefined && value !== "") return setting.parse(value, setting.env);
    return setting.fallback;
}

// Reads configuration for one process. It is not cached: a caller that needs a setting reads it
// where it uses it, so a database change takes effect on the next command rather than a restart.
export class ConfigurationService {
    constructor(
        private readonly db: Kysely<Database>,
        private readonly env: Env = process.env,
    ) {}

    async read(): Promise<Configuration> {
        const keys = Object.keys(SETTINGS) as (keyof Configuration)[];
        const rows = await this.db
            .selectFrom("app_setting")
            .select(["key", "value"])
            .where("key", "in", keys)
            .execute();
        const stored = new Map(rows.map((row) => [row.key, row.value]));
        return {
            development: resolve("development", SETTINGS.development, stored, this.env),
        };
    }
}
