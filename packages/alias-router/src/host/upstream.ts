import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { connectionNames, isResponseHeaderForwarded } from "./headers";

export interface UpstreamRequest {
    method: "GET" | "HEAD" | "OPTIONS";
    // Origin-form only, starting with "/". Never an absolute URL.
    path: string;
    headers: Record<string, string>;
    // The immutable deployment hostname: it becomes `Host`, and (for https) the TLS server name
    // and the name the certificate must match. It comes only from the router's registry.
    hostname: string;
    signal: AbortSignal;
}

export type UpstreamFailure = "timeout" | "bad-gateway";
export class UpstreamError extends Error {
    constructor(readonly failure: UpstreamFailure) {
        super(failure);
        this.name = "UpstreamError";
    }
}

export type Upstream = (request: UpstreamRequest) => Promise<Response>;

export interface HttpUpstreamOptions {
    origin: URL;
    // PEM of a private CA to trust in addition to nothing else; verification is never disabled.
    caFile?: string;
    headersTimeoutMs?: number;
    idleTimeoutMs?: number;
    totalTimeoutMs?: number;
}

// 1xx never reaches here (rejected above); these statuses carry no body.
const NO_BODY = new Set([204, 205, 304]);

export function createHttpUpstream(options: HttpUpstreamOptions): Upstream {
    const { origin } = options;
    if (!["http:", "https:"].includes(origin.protocol) || origin.pathname !== "/") {
        throw new Error("The upstream must be an http(s) origin with no path.");
    }
    const secure = origin.protocol === "https:";
    const ca = options.caFile ? readFileSync(options.caFile, "utf8") : undefined;
    const headersTimeout = options.headersTimeoutMs ?? 10_000;
    const idleTimeout = options.idleTimeoutMs ?? 30_000;
    const totalTimeout = options.totalTimeoutMs ?? 300_000;
    const host = origin.hostname.replace(/^\[|\]$/g, "");

    return (request) =>
        new Promise<Response>((resolve, reject) => {
            if (request.signal.aborted) return reject(new UpstreamError("bad-gateway"));
            let settled = false;
            const upstream = (secure ? https : http).request({
                hostname: host,
                port: origin.port || (secure ? 443 : 80),
                method: request.method,
                path: request.path,
                headers: { ...request.headers, host: request.hostname },
                // SNI and certificate verification use the same trusted hostname as `Host`.
                ...(secure
                    ? {
                          servername: request.hostname,
                          rejectUnauthorized: true,
                          ...(ca ? { ca } : {}),
                      }
                    : {}),
                agent: false,
            });
            const abort = () => upstream.destroy();
            const headerTimer = setTimeout(() => fail("timeout"), headersTimeout);
            // Every path that ends without a streamed body releases the timer and the listener.
            const cleanup = () => {
                clearTimeout(headerTimer);
                request.signal.removeEventListener("abort", abort);
            };
            const fail = (failure: UpstreamFailure) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(new UpstreamError(failure));
                upstream.destroy();
            };
            request.signal.addEventListener("abort", abort, { once: true });
            upstream.on("error", () => fail("bad-gateway"));
            upstream.on("response", (incoming) => {
                clearTimeout(headerTimer);
                if (settled) return incoming.destroy();
                settled = true;
                const status = incoming.statusCode ?? 0;
                if (status < 200 || status > 599) {
                    cleanup();
                    incoming.destroy();
                    return reject(new UpstreamError("bad-gateway"));
                }
                const connection = connectionNames(
                    incoming.headers.connection as string | undefined,
                );
                const headers = new Headers();
                for (let i = 0; i + 1 < incoming.rawHeaders.length; i += 2) {
                    const name = incoming.rawHeaders[i]!;
                    if (isResponseHeaderForwarded(name, connection)) {
                        headers.append(name, incoming.rawHeaders[i + 1]!);
                    }
                }
                // After the headers a failure can only abort the stream, not change the status.
                incoming.setTimeout(idleTimeout, () => incoming.destroy(new Error("idle")));
                const deadline = setTimeout(
                    () => incoming.destroy(new Error("deadline")),
                    totalTimeout,
                );
                incoming.on("close", () => {
                    clearTimeout(deadline);
                    request.signal.removeEventListener("abort", abort);
                });
                if (request.method === "HEAD" || NO_BODY.has(status)) {
                    incoming.resume();
                    return resolve(new Response(null, { status, headers }));
                }
                resolve(
                    new Response(Readable.toWeb(incoming) as unknown as ReadableStream, {
                        status,
                        headers,
                    }),
                );
            });
            upstream.end();
        });
}
