// No imports on purpose: the idle worker loads this through a sub-path export and must not
// bundle the rest of the services package.
type Env = Record<string, string | undefined>;

const REMOVED = [
    "LAUNCHPAD_PREVIEW_DOMAIN",
    "LAUNCHPAD_PREVIEW_PROXY_URL",
    "LAUNCHPAD_MAX_PREVIEWS",
    "LAUNCHPAD_ALLOW_NO_EXPIRY",
];

// Refused whether or not the new model is configured: an environment that still carries a
// preview-era name is the migration case this error is for. The lifecycle settings belonged to
// the removed preview lifecycle; any name with that prefix is refused. An empty value is unset.
export function assertNoRemovedSettings(env: Env): void {
    const set = (name: string) => env[name] !== undefined && env[name] !== "";
    const found =
        REMOVED.find(set) ??
        Object.keys(env).find((name) => name.startsWith("LAUNCHPAD_LIFECYCLE") && set(name));
    if (found) {
        throw new Error(
            `${found} is no longer used: the preview feature was removed. Remove it from the environment. ` +
                "Its replacement settings arrive with deployments and are not read yet.",
        );
    }
}
