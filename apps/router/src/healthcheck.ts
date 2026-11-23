import type { Listen, RouterHostConfig } from "@launchpad-kit/alias-router";
import { readFileSync } from "node:fs";
import { get as httpsGet } from "node:https";

// The container healthcheck: ask the router's own control listener whether its store answers. It
// reports liveness of the routing state only; it does not prove Dokku or the network work.

const WILDCARD: Record<string, string> = { "0.0.0.0": "127.0.0.1", "::": "::1" };
const listenHost = (control: Listen) => WILDCARD[control.host] ?? control.host;

export function healthUrl(control: Listen): string {
    const host = listenHost(control);
    return `http://${host.includes(":") ? `[${host}]` : host}:${control.port}/healthz`;
}

function checkTlsHealth(control: Listen, serverName: string, ca: string, signal: AbortSignal) {
    return new Promise<boolean>((resolve) => {
        // Dial the actual listener; the configured name is for SNI and certificate identity.
        const req = httpsGet(
            {
                hostname: listenHost(control),
                port: control.port,
                path: "/healthz",
                servername: serverName,
                ca,
                rejectUnauthorized: true,
                signal,
                agent: false,
            },
            (response) => {
                if (response.statusCode !== 200) {
                    response.destroy();
                    return resolve(false);
                }
                let body = "";
                response.setEncoding("utf8");
                response.on("data", (chunk: string) => {
                    body += chunk;
                    if (body.length > 1024) {
                        response.destroy();
                        resolve(false);
                    }
                });
                response.once("error", () => resolve(false));
                response.once("close", () => resolve(false));
                response.once("end", () => {
                    try {
                        resolve(JSON.parse(body)?.status === "ok");
                    } catch {
                        resolve(false);
                    }
                });
            },
        );
        req.once("error", () => resolve(false));
        req.once("close", () => resolve(false));
    });
}

export async function checkHealth(
    control: Listen,
    fetcher: typeof fetch = fetch,
    timeoutMs = 3000,
    tls?: RouterHostConfig["controlTls"],
): Promise<boolean> {
    try {
        const signal = AbortSignal.timeout(timeoutMs);
        if (tls) {
            const ca = readFileSync(tls.caFile, "utf8");
            if (!ca.includes("-----BEGIN CERTIFICATE-----")) return false;
            return await checkTlsHealth(control, tls.serverName, ca, signal);
        }
        const response = await fetcher(healthUrl(control), {
            redirect: "manual",
            signal,
        });
        if (response.status !== 200) return false;
        const body = (await response.json()) as { status?: unknown };
        return body.status === "ok";
    } catch {
        return false;
    }
}
