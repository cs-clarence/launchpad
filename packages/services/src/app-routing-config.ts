import { parseDuration } from "@launchpad-kit/contracts";
import { getDomain } from "tldts";
import { parseHostnameTemplate, type HostnameTemplate } from "./hostname-template";
import { APPS_DOMAIN_PATTERN } from "./ids";

// Settings of the immutable-deployment and alias model (docs/design/deployment-modes.md,
// "Canonical configuration"). Pure: it reads only the object it is given, touches no file and no
// service. An unset `LAUNCHPAD_APPS_DOMAIN` disables app routing.

const DAY = 86_400;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const DEFAULT_DEPLOYMENT_TEMPLATE = "{slug}-{id}-preview";
export const DEFAULT_ALIAS_TEMPLATE = "view-{slug}-{id}";

export interface AppRoutingConfig {
    enabled: true;
    appsDomain: string;
    appsProxyUrl: URL;
    aliasControlUrl: URL;
    aliasControlCaFile?: string;
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

// Validate the apps domain, if configured, without requiring enabled routing.
export function assertCurrentSettings(env: Env): void {
    const appsDomain = env.LAUNCHPAD_APPS_DOMAIN;
    if (appsDomain === undefined || appsDomain === "") return;
    if (!APPS_DOMAIN_PATTERN.test(appsDomain)) {
        throw new Error("LAUNCHPAD_APPS_DOMAIN is not a valid lowercase domain name.");
    }
    assertSeparateDomains(appsDomain, managementOrigin(required(env, "LAUNCHPAD_BASE_URL")));
}

export interface DeploymentConfig {
    enabled: true;
    appsDomain: string;
    deploymentTemplate: HostnameTemplate;
    defaultTtlSeconds: number;
    maxTtlSeconds: number;
    maxApps: number;
    maxDeploymentsPerApp: number;
    maxDeployments: number;
}

export type DeploymentSettings = DeploymentConfig | { enabled: false };

// What creating a deployment needs, and no more: the router, proxy and alias settings belong to
// aliases and the worker. `LAUNCHPAD_DEPLOYMENTS` is the off switch: anything but `on` is off,
// and while off nothing else is read, so an unconfigured installation starts as before. Once it
// is `on` every setting must be valid, and the removed names stay refused.
export function parseDeploymentConfig(env: Env): DeploymentSettings {
    assertCurrentSettings(env);
    const switchValue = env.LAUNCHPAD_DEPLOYMENTS;
    if (switchValue === undefined || switchValue === "" || switchValue === "off") {
        return { enabled: false };
    }
    if (switchValue !== "on") {
        throw new Error('LAUNCHPAD_DEPLOYMENTS must be "on" or "off".');
    }
    const appsDomain = required(env, "LAUNCHPAD_APPS_DOMAIN");
    const duration = (name: string, fallback: number, max: number) => {
        const raw = env[name];
        if (raw === undefined || raw === "") return fallback;
        const seconds = parseDuration(raw);
        if (seconds === null || seconds <= 0 || seconds > max) {
            throw new Error(`${name} must be a positive duration of at most ${max / DAY}d.`);
        }
        return seconds;
    };
    const maxTtlSeconds = duration("LAUNCHPAD_MAX_TTL", 30 * DAY, 365 * DAY);
    const defaultTtlSeconds = duration(
        "LAUNCHPAD_DEFAULT_TTL",
        Math.min(7 * DAY, maxTtlSeconds),
        maxTtlSeconds,
    );
    const maxApps = integer(env, "LAUNCHPAD_MAX_APPS", 10, 100_000);
    const maxDeploymentsPerApp = integer(env, "LAUNCHPAD_MAX_DEPLOYMENTS_PER_APP", 20, 1000);
    const maxDeployments = integer(env, "LAUNCHPAD_MAX_DEPLOYMENTS", 100, 100_000);
    if (maxDeploymentsPerApp > maxDeployments) {
        throw new Error(
            "LAUNCHPAD_MAX_DEPLOYMENTS_PER_APP cannot exceed LAUNCHPAD_MAX_DEPLOYMENTS.",
        );
    }
    let deploymentTemplate: HostnameTemplate;
    try {
        deploymentTemplate = parseHostnameTemplate(
            env.LAUNCHPAD_DEPLOYMENT_HOSTNAME_TEMPLATE || DEFAULT_DEPLOYMENT_TEMPLATE,
            appsDomain,
        );
    } catch (error) {
        throw new Error(`LAUNCHPAD_DEPLOYMENT_HOSTNAME_TEMPLATE: ${(error as Error).message}`);
    }
    return {
        enabled: true,
        appsDomain,
        deploymentTemplate,
        defaultTtlSeconds,
        maxTtlSeconds,
        maxApps,
        maxDeploymentsPerApp,
        maxDeployments,
    };
}

export interface AliasConfig {
    enabled: true;
    aliasTemplate: HostnameTemplate;
    maxAliasesPerApp: number;
    maxAliases: number;
}

export type AliasSettings = AliasConfig | { enabled: false };

// What creating an alias needs. `LAUNCHPAD_ALIASES` is off unless set to `on`, and while off
// nothing else is read. It needs deployments to be on: aliases point at deployments. The router
// settings (proxy, control and probe URLs, instance ID, credentials) belong to the worker that
// dispatches promotions and are validated there, not by this narrow parser.
export function parseAliasConfig(env: Env): AliasSettings {
    const deployments = parseDeploymentConfig(env);
    const switchValue = env.LAUNCHPAD_ALIASES;
    if (switchValue === undefined || switchValue === "" || switchValue === "off") {
        return { enabled: false };
    }
    if (switchValue !== "on") throw new Error('LAUNCHPAD_ALIASES must be "on" or "off".');
    if (!deployments.enabled) {
        throw new Error("LAUNCHPAD_ALIASES=on needs LAUNCHPAD_DEPLOYMENTS=on.");
    }
    const maxAliasesPerApp = integer(env, "LAUNCHPAD_MAX_ALIASES_PER_APP", 5, 1000);
    const maxAliases = integer(env, "LAUNCHPAD_MAX_ALIASES", 50, 100_000);
    if (maxAliasesPerApp > maxAliases) {
        throw new Error("LAUNCHPAD_MAX_ALIASES_PER_APP cannot exceed LAUNCHPAD_MAX_ALIASES.");
    }
    let aliasTemplate: HostnameTemplate;
    try {
        aliasTemplate = parseHostnameTemplate(
            env.LAUNCHPAD_ALIAS_HOSTNAME_TEMPLATE || DEFAULT_ALIAS_TEMPLATE,
            deployments.appsDomain,
        );
    } catch (error) {
        throw new Error(`LAUNCHPAD_ALIAS_HOSTNAME_TEMPLATE: ${(error as Error).message}`);
    }
    return { enabled: true, aliasTemplate, maxAliasesPerApp, maxAliases };
}

export function parseAppRoutingConfig(env: Env): AppRoutingSettings {
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
    const maxAliasesPerApp = integer(env, "LAUNCHPAD_MAX_ALIASES_PER_APP", 5, 1000);
    const maxAliases = integer(env, "LAUNCHPAD_MAX_ALIASES", 50, 100_000);
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
    const controlUrl = url(
        "LAUNCHPAD_ALIAS_CONTROL_URL",
        required(env, "LAUNCHPAD_ALIAS_CONTROL_URL"),
    );
    const controlCa = env.LAUNCHPAD_ALIAS_CONTROL_CA_FILE;
    if (controlCa && controlUrl.protocol !== "https:") {
        throw new Error("LAUNCHPAD_ALIAS_CONTROL_CA_FILE only applies to an https control URL.");
    }
    return {
        enabled: true,
        appsDomain,
        ...(controlCa
            ? { aliasControlCaFile: absolutePath("LAUNCHPAD_ALIAS_CONTROL_CA_FILE", controlCa) }
            : {}),
        appsProxyUrl: proxyOrigin(
            "LAUNCHPAD_APPS_PROXY_URL",
            required(env, "LAUNCHPAD_APPS_PROXY_URL"),
        ),
        aliasControlUrl: controlUrl,
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
        maxApps: integer(env, "LAUNCHPAD_MAX_APPS", 10, 100_000),
        maxDeploymentsPerApp,
        maxDeployments,
        maxAliasesPerApp,
        maxAliases,
    };
}
