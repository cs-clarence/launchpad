import http from "node:http";
import https from "node:https";
import { compactId } from "./template";

export interface ProbeConfig {
    // The Dokku proxy, as the worker reaches it. The preview's own name is sent as the
    // Host header, so this needs no DNS and exercises the proxy's routing.
    proxyUrl: URL;
    timeoutMs: number;
    intervalMs: number;
}

export function parseProxyUrl(value: string): URL {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("The preview proxy URL must be http or https.");
    }
    return url;
}

function once(
    config: ProbeConfig,
    hostname: string,
    deploymentId: string,
    signal: AbortSignal,
): Promise<boolean> {
    return new Promise((resolve) => {
        const client = config.proxyUrl.protocol === "https:" ? https : http;
        const request = client.request(
            {
                hostname: config.proxyUrl.hostname,
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
                resolve(response.statusCode === 200 && header === compactId(deploymentId));
            },
        );
        request.on("timeout", () => request.destroy());
        request.on("error", () => resolve(false));
        request.end();
    });
}

// Succeeds only when the proxy answers 200 for the preview's hostname from *this*
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
            throw new Error("The preview did not become ready in time.");
        }
        await new Promise((resolve) => setTimeout(resolve, config.intervalMs));
    }
}
