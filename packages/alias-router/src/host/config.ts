import { hostnameSchema } from "../protocol";

// Pure: reads only the object it is given. No secret is ever a setting value.

export interface Listen {
    // IPv6 without brackets, ready for `Bun.serve({ hostname })`.
    host: string;
    port: number;
}

export interface ControlTls {
    certFile: string;
    keyFile: string;
    // Public CA and DNS name used by the router's own verified health client.
    caFile: string;
    serverName: string;
}

export interface RouterHostConfig {
    stateFile: string;
    instanceId: string;
    appsDomain: string;
    control: Listen;
    data: Listen;
    controlPrivateNetwork: boolean;
    controlTls?: ControlTls | null;
    upstreamOrigin: URL;
    upstreamCaFile: string | null;
}

type Env = Record<string, string | undefined>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function required(env: Env, name: string): string {
    const value = env[name];
    if (value === undefined || value === "") throw new Error(`${name} is required.`);
    return value;
}

function absolutePath(name: string, value: string): string {
    if (!value.startsWith("/") || value.includes("\0") || value.split("/").includes("..")) {
        throw new Error(`${name} must be an absolute path without "..".`);
    }
    return value;
}

const IPV4 =
    /^(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])(?:\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])){3}$/;

function listen(env: Env, name: string): Listen {
    const value = required(env, name);
    const split = value.lastIndexOf(":");
    const host = value.slice(0, split);
    const port = /^[0-9]{1,5}$/.test(value.slice(split + 1)) ? Number(value.slice(split + 1)) : 0;
    const known = IPV4.test(host) || host === "localhost" || host === "[::1]" || host === "[::]";
    if (split < 1 || !known || port < 1 || port > 65_535) {
        throw new Error(`${name} must be <IPv4 | localhost | [::1] | [::]>:<port>.`);
    }
    // Bracketed in the setting (as in a URL), bare for the socket APIs that bind it.
    return { host: host.replace(/^\[|\]$/g, ""), port };
}

const WILDCARD = new Set(["0.0.0.0", "::"]);
export const isLoopback = (host: string) =>
    host === "localhost" || host === "::1" || host.startsWith("127.");

export function parseRouterHostConfig(env: Env): RouterHostConfig {
    const instanceId = required(env, "LAUNCHPAD_ROUTER_INSTANCE_ID");
    if (!UUID.test(instanceId)) {
        throw new Error("LAUNCHPAD_ROUTER_INSTANCE_ID must be a lowercase UUID.");
    }
    const appsDomain = required(env, "LAUNCHPAD_APPS_DOMAIN");
    if (!hostnameSchema.safeParse(appsDomain).success) {
        throw new Error("LAUNCHPAD_APPS_DOMAIN is not a valid lowercase domain name.");
    }
    const control = listen(env, "LAUNCHPAD_ROUTER_CONTROL_LISTEN");
    const data = listen(env, "LAUNCHPAD_ROUTER_DATA_LISTEN");
    const controlPrivateNetwork = env.LAUNCHPAD_ROUTER_CONTROL_PRIVATE_NETWORK === "1";
    // The bearer token travels over plain HTTP: leaving loopback is an explicit decision.
    if (!isLoopback(control.host) && !controlPrivateNetwork) {
        throw new Error(
            "LAUNCHPAD_ROUTER_CONTROL_LISTEN must be loopback unless " +
                "LAUNCHPAD_ROUTER_CONTROL_PRIVATE_NETWORK=1 confirms a private network.",
        );
    }
    // Textual comparison: `localhost` and `127.0.0.1` on one port are not recognised as the same
    // address here, but the second bind would then fail with EADDRINUSE rather than share it.
    if (
        control.port === data.port &&
        (control.host === data.host || WILDCARD.has(control.host) || WILDCARD.has(data.host))
    ) {
        throw new Error("The control and data listeners must not share an address.");
    }
    let origin: URL;
    try {
        origin = new URL(required(env, "LAUNCHPAD_APPS_PROXY_URL"));
    } catch {
        throw new Error("LAUNCHPAD_APPS_PROXY_URL must be an http or https URL.");
    }
    if (
        !["http:", "https:"].includes(origin.protocol) ||
        origin.username ||
        origin.password ||
        origin.search ||
        origin.hash ||
        origin.pathname !== "/"
    ) {
        throw new Error(
            "LAUNCHPAD_APPS_PROXY_URL must be an http(s) origin with no path, credentials, query or fragment.",
        );
    }
    const ca = env.LAUNCHPAD_ROUTER_UPSTREAM_CA_FILE;
    if (ca !== undefined && ca !== "" && origin.protocol !== "https:") {
        throw new Error("LAUNCHPAD_ROUTER_UPSTREAM_CA_FILE only applies to an https upstream.");
    }
    const tlsNames = [
        "LAUNCHPAD_ROUTER_CONTROL_TLS_CERT_FILE",
        "LAUNCHPAD_ROUTER_CONTROL_TLS_KEY_FILE",
        "LAUNCHPAD_ROUTER_CONTROL_TLS_CA_FILE",
        "LAUNCHPAD_ROUTER_CONTROL_TLS_SERVER_NAME",
    ];
    let controlTls: ControlTls | null = null;
    if (tlsNames.some((name) => env[name] !== undefined && env[name] !== "")) {
        for (const name of tlsNames) required(env, name);
        const serverName = env.LAUNCHPAD_ROUTER_CONTROL_TLS_SERVER_NAME!;
        // Compose service names such as `router` are single-label DNS names,
        // unlike public app hostnames. Keep their labels canonical too.
        if (
            !hostnameSchema.safeParse(serverName).success &&
            !/^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(serverName)
        ) {
            throw new Error(
                "LAUNCHPAD_ROUTER_CONTROL_TLS_SERVER_NAME must be a lowercase DNS name.",
            );
        }
        controlTls = {
            certFile: absolutePath(tlsNames[0]!, env[tlsNames[0]!]!),
            keyFile: absolutePath(tlsNames[1]!, env[tlsNames[1]!]!),
            caFile: absolutePath(tlsNames[2]!, env[tlsNames[2]!]!),
            serverName,
        };
    }
    return {
        stateFile: absolutePath(
            "LAUNCHPAD_ROUTER_STATE_FILE",
            required(env, "LAUNCHPAD_ROUTER_STATE_FILE"),
        ),
        instanceId,
        appsDomain,
        control,
        data,
        controlPrivateNetwork,
        controlTls,
        upstreamOrigin: origin,
        upstreamCaFile: ca ? absolutePath("LAUNCHPAD_ROUTER_UPSTREAM_CA_FILE", ca) : null,
    };
}
