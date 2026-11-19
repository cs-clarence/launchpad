import { parseDuration } from "@launchpad-kit/contracts";
import { getDomain } from "tldts";
import { parseHostnameTemplate, type HostnameTemplate } from "./hostname-template";
import { APPS_DOMAIN_PATTERN } from "./ids";

// Settings of the immutable-deployment and alias model (docs/design/deployment-modes.md,
// "Canonical configuration"). Pure: it reads only the object it is given, touches no file and no
// service, and is not wired into the controller or the worker yet. Unset `LAUNCHPAD_APPS_DOMAIN`
// means the feature is off; once it is set every required setting must be valid, and the
// preview-era names are refused with an actionable message rather than silently honoured.

const DAY = 86_400;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OLD_SETTINGS: Record<string, string> = {
    LAUNCHPAD_PREVIEW_DOMAIN: "LAUNCHPAD_APPS_DOMAIN",
    LAUNCHPAD_PREVIEW_PROXY_URL: "LAUNCHPAD_APPS_PROXY_URL",
    LAUNCHPAD_MAX_PREVIEWS: "LAUNCHPAD_MAX_APPS",
    LAUNCHPAD_ALLOW_NO_EXPIRY: "(removed: expiry is a retention policy, not a deployment type)",
};

export const DEFAULT_DEPLOYMENT_TEMPLATE = "{slug}-{id}-preview";
export const DEFAULT_ALIAS_TEMPLATE = "view-{slug}-{id}";

export interface AppRoutingConfig {
    enabled: true;
    appsDomain: string;
    appsProxyUrl: URL;
    aliasControlUrl: URL;
    aliasProbeUrl: URL;
    aliasInstanceId: string;
    // Paths only: the secret and the epoch are read by the code that uses them, never here.
    aliasControlTokenFile: string;
    aliasRouterEpochFile: string;
    deploymentTemplate: HostnameTemplate;
    aliasTemplate: HostnameTemplate;
    rollbackRetentionSeconds: number;
    maxApps: number;
    maxDeploymentsPerApp: number;
    maxDeployments: number;
    maxAliasesPerApp: number;
    maxAliases: number;
}

export type AppRoutingSettings = AppRoutingConfig | { enabled: false };

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
    const value = env[name];
    if (value === undefined || value === "") {
        throw new Error(`${name} is required when LAUNCHPAD_APPS_DOMAIN is set.`);
    }
    return value;
}

function url(name: string, value: string): URL {
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        throw new Error(`${name} must be an http or https URL.`);
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new Error(`${name} must be an http or https URL.`);
    }
    // A credential or a query in a settings URL would end up in logs and diagnostics.
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Error(`${name} must not carry credentials, a query or a fragment.`);
    }
    return parsed;
}

// The management origin is an exact HTTPS origin: the plain `url()` helper also accepts http and
// `.origin` would silently drop a path, so both are checked here.
function managementOrigin(value: string): string {
    const parsed = url("LAUNCHPAD_BASE_URL", value);
    if (parsed.protocol !== "https:" || parsed.pathname !== "/") {
        throw new Error("LAUNCHPAD_BASE_URL must be an https origin with no path.");
    }
    return parsed.origin;
}

// The Dokku proxy address is an origin: the router refuses a path, so both must.
function proxyOrigin(name: string, value: string): URL {
    const parsed = url(name, value);
    if (parsed.pathname !== "/") throw new Error(`${name} must be an origin with no path.`);
    return parsed;
}

function absolutePath(name: string, value: string): string {
    if (!value.startsWith("/") || value.includes("\0") || value.split("/").includes("..")) {
        throw new Error(`${name} must be an absolute path without "..".`);
    }
    return value;
}

// Uploaded sites are untrusted, and hosts of one registrable domain share a site: cookies and
// same-site requests cross between them. The apps domain must therefore be a different
// registrable domain from the management origin's, by the public suffix list, not merely a
// different name. A host with no registrable domain (localhost, an address) falls back to a
// plain overlap check.
export function assertSeparateDomains(appsDomain: string, managementOrigin: string): void {
    const host = new URL(managementOrigin).hostname.toLowerCase();
    const registrable = (name: string) => getDomain(name, { allowPrivateDomains: true });
    const site = registrable(host);
    const sameSite = site !== null && site === registrable(appsDomain);
    if (
        sameSite ||
        host === appsDomain ||
        host.endsWith(`.${appsDomain}`) ||
        appsDomain.endsWith(`.${host}`)
    ) {
        throw new Error(
            "LAUNCHPAD_APPS_DOMAIN must be a different registrable domain from LAUNCHPAD_BASE_URL.",
        );
    }
}

function integer(env: Env, name: string, fallback: number, max: number): number {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    if (!/^[1-9]\d{0,8}$/.test(raw)) throw new Error(`${name} must be a positive integer.`);
    const value = Number(raw);
    if (value > max) throw new Error(`${name} must be at most ${max}.`);
    return value;
}

export function parseAppRoutingConfig(env: Env): AppRoutingSettings {
    // Refused whether or not the new model is configured: an environment that still carries
    // a preview-era name is the migration case this error is for.
    for (const [old, replacement] of Object.entries(OLD_SETTINGS)) {
        if (env[old] !== undefined && env[old] !== "") {
            throw new Error(`${old} is no longer used; use ${replacement}.`);
        }
    }
    if (env.LAUNCHPAD_APPS_DOMAIN === undefined || env.LAUNCHPAD_APPS_DOMAIN === "") {
        return { enabled: false };
    }
    const appsDomain = env.LAUNCHPAD_APPS_DOMAIN;
    if (!APPS_DOMAIN_PATTERN.test(appsDomain)) {
        throw new Error("LAUNCHPAD_APPS_DOMAIN is not a valid lowercase domain name.");
    }
    assertSeparateDomains(appsDomain, managementOrigin(required(env, "LAUNCHPAD_BASE_URL")));
    const instanceId = required(env, "LAUNCHPAD_ALIAS_INSTANCE_ID");
    if (!UUID.test(instanceId))
        throw new Error("LAUNCHPAD_ALIAS_INSTANCE_ID must be a lowercase UUID.");
    const retention = env.LAUNCHPAD_ROLLBACK_RETENTION;
    let rollbackRetentionSeconds = 7 * DAY;
    if (retention !== undefined && retention !== "") {
        const seconds = parseDuration(retention);
        if (seconds === null || seconds <= 0 || seconds > 30 * DAY) {
            throw new Error(
                "LAUNCHPAD_ROLLBACK_RETENTION must be a positive duration of at most 30d.",
            );
        }
        rollbackRetentionSeconds = seconds;
    }
    const maxAliasesPerApp = integer(env, "LAUNCHPAD_MAX_ALIASES_PER_APP", 10, 1000);
    const maxAliases = integer(env, "LAUNCHPAD_MAX_ALIASES", 100, 100_000);
    const maxDeploymentsPerApp = integer(env, "LAUNCHPAD_MAX_DEPLOYMENTS_PER_APP", 20, 1000);
    const maxDeployments = integer(env, "LAUNCHPAD_MAX_DEPLOYMENTS", 100, 100_000);
    if (maxAliasesPerApp > maxAliases) {
        throw new Error("LAUNCHPAD_MAX_ALIASES_PER_APP cannot exceed LAUNCHPAD_MAX_ALIASES.");
    }
    if (maxDeploymentsPerApp > maxDeployments) {
        throw new Error(
            "LAUNCHPAD_MAX_DEPLOYMENTS_PER_APP cannot exceed LAUNCHPAD_MAX_DEPLOYMENTS.",
        );
    }
    const template = (name: string, fallback: string) => {
        try {
            return parseHostnameTemplate(env[name] || fallback, appsDomain);
        } catch (error) {
            throw new Error(`${name}: ${(error as Error).message}`);
        }
    };
    return {
        enabled: true,
        appsDomain,
        appsProxyUrl: proxyOrigin(
            "LAUNCHPAD_APPS_PROXY_URL",
            required(env, "LAUNCHPAD_APPS_PROXY_URL"),
        ),
        aliasControlUrl: url(
            "LAUNCHPAD_ALIAS_CONTROL_URL",
            required(env, "LAUNCHPAD_ALIAS_CONTROL_URL"),
        ),
        aliasProbeUrl: url("LAUNCHPAD_ALIAS_PROBE_URL", required(env, "LAUNCHPAD_ALIAS_PROBE_URL")),
        aliasInstanceId: instanceId,
        aliasControlTokenFile: absolutePath(
            "LAUNCHPAD_ALIAS_CONTROL_TOKEN_FILE",
            required(env, "LAUNCHPAD_ALIAS_CONTROL_TOKEN_FILE"),
        ),
        aliasRouterEpochFile: absolutePath(
            "LAUNCHPAD_ALIAS_ROUTER_EPOCH_FILE",
            required(env, "LAUNCHPAD_ALIAS_ROUTER_EPOCH_FILE"),
        ),
        deploymentTemplate: template(
            "LAUNCHPAD_DEPLOYMENT_HOSTNAME_TEMPLATE",
            DEFAULT_DEPLOYMENT_TEMPLATE,
        ),
        aliasTemplate: template("LAUNCHPAD_ALIAS_HOSTNAME_TEMPLATE", DEFAULT_ALIAS_TEMPLATE),
        rollbackRetentionSeconds,
        maxApps: integer(env, "LAUNCHPAD_MAX_APPS", 10, 10_000),
        maxDeploymentsPerApp,
        maxDeployments,
        maxAliasesPerApp,
        maxAliases,
    };
}
