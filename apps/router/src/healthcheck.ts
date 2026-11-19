import type { Listen } from "@launchpad-kit/alias-router";

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
): Promise<boolean> {
    try {
        const response = await fetcher(healthUrl(control), {
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
