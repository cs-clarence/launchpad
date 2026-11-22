import type { Listen, RouterHostConfig } from "@launchpad-kit/alias-router";
import { readFileSync } from "node:fs";

// The container healthcheck: ask the router's own control listener whether its store answers. It
// reports liveness of the routing state only; it does not prove Dokku or the network work.

const WILDCARD: Record<string, string> = { "0.0.0.0": "127.0.0.1", "::": "::1" };

export function healthUrl(control: Listen): string {
    const host = WILDCARD[control.host] ?? control.host;
    return `http://${host.includes(":") ? `[${host}]` : host}:${control.port}/healthz`;
}

export async function checkHealth(
    control: Listen,
    fetcher: typeof fetch = fetch,
    timeoutMs = 3000,
    tls?: RouterHostConfig["controlTls"],
): Promise<boolean> {
    try {
        const ca = tls ? readFileSync(tls.caFile, "utf8") : undefined;
        if (tls && !ca?.includes("-----BEGIN CERTIFICATE-----")) return false;
        const target = tls
            ? `https://${tls.serverName}:${control.port}/healthz`
            : healthUrl(control);
        const response = await fetcher(target, {
            ...(ca ? { tls: { ca, rejectUnauthorized: true } } : {}),
            redirect: "manual",
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.status !== 200) return false;
        const body = (await response.json()) as { status?: unknown };
        return body.status === "ok";
    } catch {
        return false;
    }
}
