import http from "node:http";
import https from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import { compactId } from "./template";

export interface ProbeConfig {
    // The Dokku proxy, as the worker reaches it. The deployment's name is sent as the
    // Host header, so this needs no DNS and exercises the proxy's routing.
    proxyUrl: URL;
    timeoutMs: number;
    intervalMs: number;
}

export function parseProxyUrl(value: string, name = "LAUNCHPAD_APPS_PROXY_URL"): URL {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(`${name} must be http or https.`);
    }
    // Only scheme, host and port are used; anything else would be silently ignored.
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
        throw new Error(`${name} must be only a scheme, host and optional port.`);
    }
    return url;
}

export interface ServedIdentity {
    status: number;
    // The compact deployment id the response was stamped with, if any.
    deployment: string | null;
}

// One bounded GET of "/" with `hostname` as Host. Null means no HTTP answer at all.
export function fetchIdentity(
    config: ProbeConfig,
    hostname: string,
    signal: AbortSignal,
): Promise<ServedIdentity | null> {
    return new Promise((resolve) => {
        const client = config.proxyUrl.protocol === "https:" ? https : http;
        const request = client.request(
            {
                // An IPv6 literal is bracketed in a URL and bare in a connection.
                hostname: config.proxyUrl.hostname.replace(/^\[|\]$/g, ""),
                port: config.proxyUrl.port || undefined,
                path: "/",
                method: "GET",
                headers: { Host: hostname, Connection: "close" },
                timeout: 5000,
                signal,
                ...(config.proxyUrl.protocol === "https:" ? { servername: hostname } : {}),
            },
            (response) => {
                // Only the status and the identity header matter; the body is dropped.
                response.resume();
                const header = response.headers["x-launchpad-deployment"];
                resolve({
                    status: response.statusCode ?? 0,
                    deployment: typeof header === "string" ? header : null,
                });
            },
        );
        request.on("timeout", () => request.destroy());
        request.on("error", () => resolve(null));
        request.end();
    });
}

async function once(
    config: ProbeConfig,
    hostname: string,
    deploymentId: string,
    signal: AbortSignal,
): Promise<boolean> {
    const served = await fetchIdentity(config, hostname, signal);
    return served?.status === 200 && served.deployment === compactId(deploymentId);
}

// Succeeds only when the proxy answers 200 for the hostname from *this*
// deployment's image (the fixed template stamps its id on every response), so an
// older container that is still serving does not count.
export async function probe(
    target: { hostname: string; deploymentId: string },
    config: ProbeConfig,
    signal: AbortSignal,
): Promise<void> {
    const deadline = Date.now() + config.timeoutMs;
    for (;;) {
        if (signal.aborted) throw new Error("The readiness probe was cancelled.");
        if (await once(config, target.hostname, target.deploymentId, signal)) return;
        if (Date.now() + config.intervalMs >= deadline) {
            throw new Error("The deployment did not become ready in time.");
        }
        await delay(config.intervalMs, undefined, { signal });
    }
}
