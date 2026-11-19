import { hostnameSchema } from "../protocol";
import type { RouterStore } from "../store";
import { forwardableRequestHeaders } from "./headers";
import { text } from "./http";
import { UpstreamError, type Upstream } from "./upstream";

const METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const HOST = /^([a-z0-9.-]+)(?::([1-9][0-9]{0,4}))?$/;

// The single raw Host header, lowercased with its port removed. Anything unusual is "not a host we
// serve" and gets the same fixed 404 as an unknown one: duplicate or missing Host (a comma or
// whitespace), IPv6 or bracketed hosts, userinfo, percent-encoding or non-ASCII, a bad port, a
// trailing dot, or anything that is not a canonical hostname.
export function canonicalHost(request: Request): string | null {
    const raw = request.headers.get("host");
    // The pattern below also rejects whitespace and commas (a duplicate or list-valued Host).
    if (raw === null) return null;
    const match = HOST.exec(raw.toLowerCase());
    if (!match) return null;
    if (match[2] !== undefined) {
        const port = Number(match[2]);
        if (port < 1 || port > 65_535) return null;
    }
    return hostnameSchema.safeParse(match[1]).success ? match[1]! : null;
}

export interface DataHandlerOptions {
    upstream: Upstream;
}

const NOT_FOUND = () => text(404, "Not found\n");

/** The public data plane: a fetch-style handler over one open store. It binds nothing. */
export function createDataHandler(
    store: RouterStore,
    options: DataHandlerOptions,
): (request: Request) => Promise<Response> {
    return async (request) => {
        if (!METHODS.has(request.method)) {
            return text(405, "Method not allowed\n", { allow: "GET, HEAD, OPTIONS" });
        }
        // No request body is ever forwarded.
        const length = request.headers.get("content-length");
        if (request.headers.has("transfer-encoding") || (length !== null && length !== "0")) {
            return text(400, "Bad request\n");
        }
        const host = canonicalHost(request);
        if (host === null) return NOT_FOUND();
        let url: URL;
        try {
            url = new URL(request.url);
        } catch {
            return text(400, "Bad request\n");
        }
        // The path must be origin-form, and the URL must name the same host as the Host header.
        if (!url.pathname.startsWith("/") || url.hostname.toLowerCase() !== host) {
            return text(400, "Bad request\n");
        }
        let target: string | null;
        try {
            target = store.readRoute(host).route?.target?.hostname ?? null;
        } catch {
            // Any failure to read the registry is "unavailable", never a guess or a fallback.
            return text(503, "Routing unavailable\n");
        }
        // Unknown, unbound and withdrawn hosts are all this one response: there is no upstream
        // choice to make, so nothing can fall back to Dokku or another app.
        if (target === null) return NOT_FOUND();
        try {
            return await options.upstream({
                method: request.method as "GET" | "HEAD" | "OPTIONS",
                path: `${url.pathname}${url.search}`,
                headers: forwardableRequestHeaders(request.headers),
                hostname: target,
                signal: request.signal,
            });
        } catch (error) {
            if (error instanceof UpstreamError && error.failure === "timeout") {
                return text(504, "Gateway timeout\n");
            }
            return text(502, "Bad gateway\n");
        }
    };
}
