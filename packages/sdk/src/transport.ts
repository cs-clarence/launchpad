import { LaunchpadApiError, LaunchpadConfigError, LaunchpadTransportError } from "./errors";

export interface RawOptions {
    // Appended to the path; keys and values are encoded. Repeated keys are kept.
    query?: ReadonlyArray<readonly [string, string]>;
    // A request body already serialized, as text or bytes (1 MiB at most). Not allowed with
    // GET or HEAD. Bytes are sent as they are.
    body?: string | Uint8Array;
    // Defaults to application/json when a body is given.
    contentType?: string;
    // Extra request headers. Credential and framing headers are refused.
    headers?: Record<string, string>;
    idempotencyKey?: string;
    signal?: AbortSignal;
}

export interface RawResponse {
    status: number;
    headers: Headers;
    body: string;
    // The query of a validated `rel="next"` link of a GET (same origin, same path), else null.
    next: Array<[string, string]> | null;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_BODY_BYTES = 1024 * 1024;

export const RAW_METHODS: ReadonlySet<string> = new Set([
    "GET",
    "HEAD",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
]);
// Credential, framing, method-override and forwarding headers `raw` refuses; the CLI help and docs name the same list.
export const FORBIDDEN_RAW_HEADERS: ReadonlySet<string> = new Set([
    "authorization",
    "proxy-authorization",
    "cookie",
    "host",
    "content-length",
    "origin",
    "transfer-encoding",
    "connection",
    "upgrade",
    "idempotency-key",
    "x-http-method-override",
    "x-method-override",
    "x-http-method",
    "x-forwarded-host",
    "x-forwarded-for",
    "x-forwarded-proto",
    "forwarded",
    "proxy-connection",
    "te",
    "trailer",
    "keep-alive",
    "expect",
]);
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const HEADER_VALUE = /^[\x20-\x7e]{0,1024}$/;
const MAX_REQUEST_BYTES = 1024 * 1024;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,128}$/;

// A path under /api/v1 that cannot name another host, scheme or directory. Whatever is
// refused here is refused before anything is sent.
function checkRawPath(input: string): string {
    const bad = (why: string) => new LaunchpadConfigError(`The API path is not allowed: ${why}.`);
    const path = input.startsWith("/") ? input : `/${input}`;
    if (path === "/") throw bad("it is empty");
    if (path.length > 2048) throw bad("it is too long");
    if (/[^\x21-\x7e]/.test(path)) throw bad("it has spaces, control or non-ASCII characters");
    if (/[?#\\]/.test(path)) throw bad("it has a query, fragment or backslash");
    if (path.includes("//")) throw bad("it has an empty segment");
    if (/^\/[A-Za-z][A-Za-z0-9+.-]*:/.test(path)) throw bad("it looks like a URL");
    if (/%(?:2f|5c|00)/i.test(path)) throw bad("it has an encoded separator");
    for (const segment of path.slice(1).split("/")) {
        let decoded: string;
        try {
            decoded = decodeURIComponent(segment);
        } catch {
            throw bad("it has invalid percent-encoding");
        }
        if (decoded === "." || decoded === "..") throw bad("it has a dot segment");
    }
    return path;
}

export function normalizeBaseUrl(input: string): string {
    let url: URL;
    try {
        url = new URL(input);
    } catch {
        throw new LaunchpadConfigError("The controller URL is not a valid URL.");
    }
    if (url.username || url.password) {
        throw new LaunchpadConfigError("The controller URL must not contain credentials.");
    }
    if (url.search || url.hash) {
        throw new LaunchpadConfigError("The controller URL must not contain a query or fragment.");
    }
    const secure = url.protocol === "https:";
    if (!secure && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
        throw new LaunchpadConfigError(
            "The controller URL must use https (http is allowed only for localhost).",
        );
    }
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

// Reads at most MAX_BODY_BYTES, stopping (and cancelling the stream) as soon as the limit
// is passed, so an oversized or endless answer is never buffered whole.
async function readBounded(response: Response): Promise<string> {
    const tooLarge = () =>
        new LaunchpadTransportError(
            "invalid-response",
            "The controller's answer is larger than this SDK accepts.",
        );
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        await response.body?.cancel().catch(() => {});
        throw tooLarge();
    }
    if (!response.body) return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let received = 0;
    let text = "";
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > MAX_BODY_BYTES) {
            await reader.cancel().catch(() => {});
            throw tooLarge();
        }
        text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
}

export interface Extra {
    idempotencyKey?: string;
    signal?: AbortSignal;
    archive?: Blob;
    // Already-serialized body for `raw`, with its own content type.
    rawBody?: { data: string | Uint8Array; contentType: string };
    headers?: Record<string, string>;
    // Called with the answer as soon as its headers arrive, before the body is read, so a
    // caller can keep what the headers carry even if reading the body then fails.
    onHeaders?: (response: Response) => void;
}

export interface TransportConfig {
    base: string;
    doFetch: typeof fetch;
    timeoutMs: number;
    // The API's path under the controller, e.g. "/api/v1".
    prefix: string;
    // Sent on every request, after the caller's own headers, so they cannot be overridden.
    credentialHeaders: () => Record<string, string>;
    // Secrets that must not appear in anything that leaves the transport.
    secrets?: () => readonly string[];
    // Reads Better Auth's `message` when the body has no `title`, and lets a caller add a hint.
    session?: { hint(status: number, code: string): string | undefined };
}

export function scrub(text: string, secrets: readonly string[]): string {
    let out = text;
    for (const secret of secrets) {
        if (secret.length >= 8) {
            out = out.replace(
                new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
                "[redacted]",
            );
        }
    }
    return out;
}

export function createTransport(config: TransportConfig) {
    const { base, doFetch, timeoutMs } = config;
    const hide = (text: string) => scrub(text, config.secrets?.() ?? []);

    // Sends one request and returns the bounded body of a successful answer. Every failure
    // is mapped to an SDK error, so no caller sees a raw error body.
    async function exchange(
        method: string,
        path: string,
        body: unknown,
        extra: Extra,
    ): Promise<{ response: Response; text: string }> {
        if (extra.idempotencyKey !== undefined && !IDEMPOTENCY_KEY.test(extra.idempotencyKey)) {
            throw new LaunchpadConfigError(
                "An idempotency key is 1 to 128 printable ASCII characters without spaces.",
            );
        }
        const signals = [AbortSignal.timeout(timeoutMs)];
        if (extra.signal) signals.push(extra.signal);
        let response: Response;
        let text: string;
        try {
            response = await doFetch(`${base}${config.prefix}${path}`, {
                method,
                headers: {
                    accept: "application/json",
                    ...extra.headers,
                    ...config.credentialHeaders(),
                    ...(extra.archive
                        ? { "content-type": "application/gzip" }
                        : extra.rawBody
                          ? { "content-type": extra.rawBody.contentType }
                          : body === undefined
                            ? {}
                            : { "content-type": "application/json" }),
                    ...(extra.idempotencyKey ? { "idempotency-key": extra.idempotencyKey } : {}),
                },
                body:
                    extra.archive ??
                    (extra.rawBody?.data as BodyInit | undefined) ??
                    (body === undefined ? undefined : JSON.stringify(body)),
                // Never ambient browser credentials, and never forward the key elsewhere.
                credentials: "omit",
                redirect: "error",
                cache: "no-store",
                signal: AbortSignal.any(signals),
            });
            extra.onHeaders?.(response);
            // The timeout also covers the body: a stalled stream must not hang the caller.
            text = await readBounded(response);
        } catch (error) {
            if (error instanceof LaunchpadTransportError) throw error;
            const name = (error as { name?: string })?.name;
            // The caller's own cancellation is theirs to see, not a timeout.
            if (extra.signal?.aborted) throw error;
            if (name === "TimeoutError" || name === "AbortError") {
                throw new LaunchpadTransportError(
                    "timeout",
                    "The controller did not answer in time.",
                );
            }
            if (error instanceof TypeError && /redirect/i.test(error.message)) {
                throw new LaunchpadTransportError(
                    "redirect",
                    "The controller redirected the request; it was not followed.",
                );
            }
            throw new LaunchpadTransportError("unreachable", "Could not reach the controller.");
        }

        if (!response.ok) {
            let json: unknown;
            try {
                json = text.length > 0 ? JSON.parse(text) : undefined;
            } catch {
                json = undefined;
            }
            // Read by hand, not with errorSchema: its code list is closed, and a newer
            // controller may add codes this version has not heard of.
            const known = (typeof json === "object" && json !== null ? json : {}) as {
                code?: unknown;
                title?: unknown;
                message?: unknown;
            };
            // The controller sends `retry-after`; Better Auth's own limiter sends `x-retry-after`.
            const retry = [
                Number(response.headers.get("retry-after")),
                Number(response.headers.get("x-retry-after")),
            ].find((n) => Number.isFinite(n) && n > 0);
            const code = typeof known.code === "string" ? known.code : "unknown";
            const title =
                typeof known.title === "string"
                    ? known.title
                    : config.session && typeof known.message === "string"
                      ? known.message
                      : `HTTP ${response.status}`;
            const hint = config.session?.hint(response.status, code);
            throw new LaunchpadApiError({
                status: response.status,
                code: hide(code),
                title: hide(hint ? `${title} ${hint}` : title),
                retryAfterSeconds: retry,
            });
        }
        return { response, text };
    }

    return { exchange };
}

// The query of a `rel="next"` link, or null. The controller sends only relative links; a
// link is followed here only if it is relative or on the controller's own origin, lies
// under `/api/v1`, and names the list that was requested. Anything else is ignored, so a
// credential is never sent to another host or another route.
export function nextLink(base: string, headers: Headers, path: string): URLSearchParams | null {
    const header = headers.get("link");
    if (!header) return null;
    const requested = new URL(`${base}/api/v1${path}`);
    for (const match of header.matchAll(/<([^>]*)>\s*((?:;\s*[^;,]+)*)/g)) {
        if (!/;\s*rel="?next"?\s*(;|$)/i.test(match[2]!)) continue;
        let target: URL;
        try {
            target = new URL(match[1]!, requested);
        } catch {
            continue;
        }
        if (target.origin !== requested.origin) continue;
        // Only the query is used, never the link's path, so both the controller's own form
        // (`/api/v1/...`) and the form behind a path prefix on `baseUrl` are the same list.
        if (target.pathname !== `/api/v1${path}` && target.pathname !== requested.pathname) {
            continue;
        }
        return target.searchParams;
    }
    return null;
}

// Any `/api/v1` endpoint, for scripts and the CLI's `api` command. The response body is
// returned as text; failures are the same SDK errors as every other call. The path, method,
// headers and body are checked here, once, for every kind of credential.
export async function rawRequest(
    transport: ReturnType<typeof createTransport>,
    base: string,
    method: string,
    rawPath: string,
    options: RawOptions = {},
): Promise<RawResponse> {
    const verb = method.toUpperCase();
    if (!RAW_METHODS.has(verb)) {
        throw new LaunchpadConfigError("The method must be GET, HEAD, POST, PUT, PATCH or DELETE.");
    }
    const path = checkRawPath(rawPath);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(options.headers ?? {})) {
        const key = name.toLowerCase();
        if (!HEADER_NAME.test(name) || FORBIDDEN_RAW_HEADERS.has(key)) {
            throw new LaunchpadConfigError(`The header "${key.slice(0, 64)}" is not allowed.`);
        }
        if (!HEADER_VALUE.test(value)) {
            throw new LaunchpadConfigError(`The value of header "${key}" is not allowed.`);
        }
        headers[key] = value;
    }
    let rawBody: { data: string | Uint8Array; contentType: string } | undefined;
    if (options.body !== undefined) {
        if (verb === "GET" || verb === "HEAD") {
            throw new LaunchpadConfigError("GET and HEAD requests cannot have a body.");
        }
        const size =
            typeof options.body === "string"
                ? new TextEncoder().encode(options.body).byteLength
                : options.body.byteLength;
        if (size > MAX_REQUEST_BYTES) {
            throw new LaunchpadConfigError("The request body is larger than 1 MiB.");
        }
        const contentType = headers["content-type"] ?? options.contentType ?? "application/json";
        delete headers["content-type"];
        rawBody = { data: options.body, contentType };
    }
    const withQuery = `${path}${
        options.query && options.query.length > 0
            ? `?${new URLSearchParams(options.query.map(([k, v]) => [k, v])).toString()}`
            : ""
    }`;
    // The same check as for every call: origin and prefix must survive URL parsing.
    const url = new URL(`${base}/api/v1${withQuery}`);
    if (
        url.origin !== new URL(base).origin ||
        !url.pathname.startsWith(`${new URL(base).pathname.replace(/\/$/, "")}/api/v1/`)
    ) {
        throw new LaunchpadConfigError("The API path is not allowed: it leaves /api/v1.");
    }
    const { response, text } = await transport.exchange(verb, withQuery, undefined, {
        idempotencyKey: options.idempotencyKey,
        signal: options.signal,
        headers,
        rawBody,
    });
    const link = verb === "GET" ? nextLink(base, response.headers, path) : null;
    return {
        status: response.status,
        headers: response.headers,
        body: text,
        next: link ? [...link.entries()] : null,
    } satisfies RawResponse;
}
