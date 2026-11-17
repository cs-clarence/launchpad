import { parseDuration } from "@launchpad/contracts";

// The audit actions of the preview lifecycle. Expiry and cleanup act as the system, so
// their events carry no user.
export const LIFECYCLE_AUDIT = {
    previewExpiryChanged: "preview.expiry-changed",
    previewDeletionRequested: "preview.deletion-requested",
    previewExpired: "preview.expired",
    previewDeleted: "preview.deleted",
    deletionResolved: "preview.deletion-resolved",
    artifactCollected: "artifact.collected",
    lifecycleEnabled: "lifecycle.enabled",
} as const;

const DAY = 86_400;
export const MAX_LIFETIME_SECONDS = 365 * DAY;

export interface LifecycleConfig {
    // Scheduled expiry, deletion and cleanup. Off by default: nothing is destroyed.
    enabled: boolean;
    defaultTtlSeconds: number;
    maxTtlSeconds: number;
    // Whether a preview may be created or extended without a lifetime.
    allowNoExpiry: boolean;
    artifactRetentionSeconds: number;
}

export const DEFAULT_LIFECYCLE: LifecycleConfig = {
    enabled: false,
    defaultTtlSeconds: 7 * DAY,
    maxTtlSeconds: 30 * DAY,
    allowNoExpiry: false,
    artifactRetentionSeconds: 7 * DAY,
};

function flag(name: string, value: string | undefined): boolean | undefined {
    if (value === undefined || value === "") return undefined;
    if (value === "on") return true;
    if (value === "off") return false;
    throw new Error(`${name} must be "on" or "off".`);
}

function duration(name: string, value: string | undefined): number | undefined {
    if (value === undefined || value === "") return undefined;
    const seconds = parseDuration(value);
    if (seconds === null) {
        throw new Error(`${name} must be a whole number and s, m, h or d, for example 7d.`);
    }
    if (seconds > MAX_LIFETIME_SECONDS) throw new Error(`${name} must be at most 365d.`);
    return seconds;
}

// Lifecycle settings from the environment. Unset means the documented default; a set but
// invalid value is an error at startup, never a silent fallback.
// Whether the controller may accept a new deletion: the worker does nothing without
// deployments, and nothing without the lifecycle, so both must be on.
export function deletionsEnabled(previews: {
    enabled: boolean;
    lifecycle?: { enabled: boolean };
}): boolean {
    return previews.enabled && (previews.lifecycle?.enabled ?? false);
}

export function lifecycleConfigFromEnv(env: Record<string, string | undefined>): LifecycleConfig {
    const config: LifecycleConfig = {
        enabled: flag("LAUNCHPAD_LIFECYCLE", env.LAUNCHPAD_LIFECYCLE) ?? DEFAULT_LIFECYCLE.enabled,
        defaultTtlSeconds:
            duration("LAUNCHPAD_DEFAULT_TTL", env.LAUNCHPAD_DEFAULT_TTL) ??
            DEFAULT_LIFECYCLE.defaultTtlSeconds,
        maxTtlSeconds:
            duration("LAUNCHPAD_MAX_TTL", env.LAUNCHPAD_MAX_TTL) ?? DEFAULT_LIFECYCLE.maxTtlSeconds,
        allowNoExpiry:
            flag("LAUNCHPAD_ALLOW_NO_EXPIRY", env.LAUNCHPAD_ALLOW_NO_EXPIRY) ??
            DEFAULT_LIFECYCLE.allowNoExpiry,
        artifactRetentionSeconds:
            duration("LAUNCHPAD_ARTIFACT_RETENTION", env.LAUNCHPAD_ARTIFACT_RETENTION) ??
            DEFAULT_LIFECYCLE.artifactRetentionSeconds,
    };
    // A shorter retention leaves no time between an upload and the deployment that uses it,
    // and none to recover what was just deleted.
    if (config.artifactRetentionSeconds < 3600) {
        throw new Error("LAUNCHPAD_ARTIFACT_RETENTION must be at least 1h.");
    }
    if (config.defaultTtlSeconds > config.maxTtlSeconds) {
        throw new Error("LAUNCHPAD_DEFAULT_TTL must not be longer than LAUNCHPAD_MAX_TTL.");
    }
    return config;
}
