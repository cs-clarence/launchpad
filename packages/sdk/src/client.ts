import {
    type createApiKeySchema,
    type createProjectSchema,
    type createAppSchema,
    type createAliasSchema,
    type createDeploymentSchema,
    type promoteAliasSchema,
    type withdrawAliasSchema,
    aliasSchema,
    appSchema,
    appShutdownSchema,
    artifactSchema,
    deploymentDeletionSchema,
    deploymentEventSchema,
    deploymentSchema,
    promotionOperationSchema,
    createdProjectSchema,
    keyInfoSchema,
    memberSchema,
    organizationSummarySchema,
    projectSchema,
} from "@launchpad-kit/contracts";
import { z } from "zod";
import { LaunchpadApiError, LaunchpadConfigError, LaunchpadTransportError } from "./errors";

export type KeyInfo = z.infer<typeof keyInfoSchema>;
export type OrganizationSummary = z.infer<typeof organizationSummarySchema>;
export type Member = z.infer<typeof memberSchema>;
export type Project = z.infer<typeof projectSchema>;
export type CreatedProject = z.infer<typeof createdProjectSchema>;
export type CreateProjectInput = z.input<typeof createProjectSchema>;
export type CreateApiKeyInput = z.input<typeof createApiKeySchema>;
export type App = z.infer<typeof appSchema>;
export type Alias = z.infer<typeof aliasSchema>;
export type Deployment = z.infer<typeof deploymentSchema>;
export type PromotionOperation = z.infer<typeof promotionOperationSchema>;
export interface RequestOptions {
    // Repeating a request with the same key does not apply the mutation again.
    // The returned resource may reflect its current state, not the original response.
    idempotencyKey?: string;
    signal?: AbortSignal;
}

export interface PageOptions {
    // 1 to 100. Sending it is what turns paging on; without it a list is returned whole.
    limit: number;
    // `next.cursor` from the previous page. Opaque: never parse or build one.
    cursor?: string;
    signal?: AbortSignal;
}

// The SDK's page shape; the services package has its own, internal `Page` with a different `next`.
export interface Page<T> {
    items: T[];
    // Present only when more items exist.
    next?: { cursor: string };
}

export interface EventsPage<T> {
    items: T[];
    // The `after` of the next page, present only when more events exist.
    nextAfter?: string;
}

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

export interface ClientOptions {
    // The controller's origin, e.g. https://control.example.com. Plain http is accepted
    // only for loopback addresses, so a key never crosses a network in clear text.
    baseUrl: string;
    // An organization API key (`lp_…`).
    apiKey: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
}

const API_KEY_FORMAT = /^lp_[A-Za-z0-9_-]{20,200}$/;
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

// Loose: a newer controller may add fields without breaking an older client.
const loose = <S extends z.ZodObject>(schema: S) =>
    schema.loose() as unknown as z.ZodType<z.infer<S>>;

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

export function createClient(options: ClientOptions) {
    const base = normalizeBaseUrl(options.baseUrl);
    const apiKey = options.apiKey;
    if (!API_KEY_FORMAT.test(apiKey)) {
        // The value is never echoed: it may be a secret typed into the wrong field.
        throw new LaunchpadConfigError("The API key is not in the expected format (lp_…).");
    }
    const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    const timeoutMs = options.timeoutMs ?? 30_000;
    const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,128}$/;

    interface Extra {
        idempotencyKey?: string;
        signal?: AbortSignal;
        archive?: Blob;
        // Already-serialized body for `raw`, with its own content type.
        rawBody?: { data: string | Uint8Array; contentType: string };
        headers?: Record<string, string>;
    }

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
            response = await doFetch(`${base}/api/v1${path}`, {
                method,
                headers: {
                    accept: "application/json",
                    ...extra.headers,
                    authorization: `Bearer ${apiKey}`,
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
            };
            const retry = Number(response.headers.get("retry-after"));
            throw new LaunchpadApiError({
                status: response.status,
                code: typeof known.code === "string" ? known.code : "unknown",
                title: typeof known.title === "string" ? known.title : `HTTP ${response.status}`,
                retryAfterSeconds: Number.isFinite(retry) && retry > 0 ? retry : undefined,
            });
        }
        return { response, text };
    }

    async function send<T>(
        method: string,
        path: string,
        schema: z.ZodType<T>,
        body?: unknown,
        extra: Extra = {},
    ): Promise<{ data: T; headers: Headers }> {
        const { response, text } = await exchange(method, path, body, extra);
        let json: unknown;
        try {
            json = text.length > 0 ? JSON.parse(text) : undefined;
        } catch {
            json = undefined;
        }
        const parsed = schema.safeParse(json);
        if (!parsed.success) {
            throw new LaunchpadTransportError(
                "invalid-response",
                "The controller's answer is not what this version of the SDK expects.",
            );
        }
        return { data: parsed.data, headers: response.headers };
    }

    async function request<T>(
        method: string,
        path: string,
        schema: z.ZodType<T>,
        body?: unknown,
        extra: Extra = {},
    ): Promise<T> {
        return (await send(method, path, schema, body, extra)).data;
    }

    // The query of a `rel="next"` link, or null. The controller sends only relative links; a
    // link is followed here only if it is relative or on the controller's own origin, lies
    // under `/api/v1`, and names the list that was requested. Anything else is ignored, so a
    // key is never sent to another host or another route.
    function nextLink(headers: Headers, path: string): URLSearchParams | null {
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

    const CURSOR = /^[A-Za-z0-9_-]{1,1024}$/;
    function checkLimit(limit: number, max: number) {
        if (!Number.isInteger(limit) || limit < 1 || limit > max) {
            throw new LaunchpadConfigError(`limit must be an integer from 1 to ${max}.`);
        }
    }

    async function requestPage<T>(
        path: string,
        schema: z.ZodType<T[]>,
        page: PageOptions,
    ): Promise<Page<T>> {
        checkLimit(page.limit, 100);
        const withQuery = `${path}${query({ limit: page.limit, cursor: page.cursor })}`;
        const { data, headers } = await send("GET", withQuery, schema, undefined, {
            signal: page.signal,
        });
        const cursor = nextLink(headers, path)?.get("cursor");
        return cursor && CURSOR.test(cursor) ? { items: data, next: { cursor } } : { items: data };
    }

    const seg = (id: string) => {
        if (!id || id === "." || id === "..") {
            throw new LaunchpadConfigError("A resource ID is required.");
        }
        return encodeURIComponent(id);
    };
    const query = (params: Record<string, string | number | undefined>) => {
        const entries = Object.entries(params).filter(([, v]) => v !== undefined);
        return entries.length === 0
            ? ""
            : `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString()}`;
    };
    const org = (id: string) => `/organizations/${seg(id)}`;
    const app = (o: string, id: string) => `${org(o)}/apps/${seg(id)}`;
    const alias = (o: string, id: string) => `${org(o)}/aliases/${seg(id)}`;
    const deployment = (o: string, id: string) => `${org(o)}/deployments/${seg(id)}`;
    // Any `/api/v1` endpoint, for scripts and the CLI's `api` command. The response body is
    // returned as text; failures are the same SDK errors as every other call.
    async function raw(method: string, rawPath: string, options: RawOptions = {}) {
        const verb = method.toUpperCase();
        if (!RAW_METHODS.has(verb)) {
            throw new LaunchpadConfigError(
                "The method must be GET, HEAD, POST, PUT, PATCH or DELETE.",
            );
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
            const contentType =
                headers["content-type"] ?? options.contentType ?? "application/json";
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
        const { response, text } = await exchange(verb, withQuery, undefined, {
            idempotencyKey: options.idempotencyKey,
            signal: options.signal,
            headers,
            rawBody,
        });
        const link = verb === "GET" ? nextLink(response.headers, path) : null;
        return {
            status: response.status,
            headers: response.headers,
            body: text,
            next: link ? [...link.entries()] : null,
        } satisfies RawResponse;
    }

    return {
        raw,
        // What this key is: its organization, scopes, project limits and expiry.
        key: { get: () => request("GET", "/key", loose(keyInfoSchema)) },
        organizations: {
            list: () => request("GET", "/organizations", z.array(loose(organizationSummarySchema))),
            listPage: (page: PageOptions) =>
                requestPage("/organizations", z.array(loose(organizationSummarySchema)), page),
            get: (organizationId: string) =>
                request(
                    "GET",
                    `/organizations/${seg(organizationId)}`,
                    loose(organizationSummarySchema),
                ),
        },
        members: {
            list: (organizationId: string) =>
                request(
                    "GET",
                    `/organizations/${seg(organizationId)}/members`,
                    z.array(loose(memberSchema)),
                ),
            listPage: (o: string, page: PageOptions) =>
                requestPage(`${org(o)}/members`, z.array(loose(memberSchema)), page),
        },
        projects: {
            list: (organizationId: string) =>
                request(
                    "GET",
                    `/organizations/${seg(organizationId)}/projects`,
                    z.array(loose(projectSchema)),
                ),
            listPage: (o: string, page: PageOptions) =>
                requestPage(`${org(o)}/projects`, z.array(loose(projectSchema)), page),
            create: (organizationId: string, input: CreateProjectInput) =>
                request(
                    "POST",
                    `/organizations/${seg(organizationId)}/projects`,
                    loose(createdProjectSchema),
                    input,
                ),
        },
        artifacts: {
            upload: (
                o: string,
                projectId: string,
                archive: Blob,
                options?: Pick<RequestOptions, "signal">,
            ) =>
                request(
                    "POST",
                    `${org(o)}/projects/${seg(projectId)}/artifacts`,
                    loose(artifactSchema),
                    undefined,
                    {
                        signal: options?.signal,
                        archive,
                    },
                ),
        },
        apps: {
            list: (o: string) => request("GET", `${org(o)}/apps`, z.array(loose(appSchema))),
            listPage: (o: string, page: PageOptions) =>
                requestPage(`${org(o)}/apps`, z.array(loose(appSchema)), page),
            get: (o: string, id: string) => request("GET", app(o, id), loose(appSchema)),
            create: (o: string, projectId: string, input: z.input<typeof createAppSchema>) =>
                request(
                    "POST",
                    `${org(o)}/projects/${seg(projectId)}/apps`,
                    loose(appSchema),
                    input,
                ),
            shutdown: (o: string, id: string) =>
                request("DELETE", app(o, id), loose(appShutdownSchema)),
        },
        deployments: {
            list: (o: string, appId: string) =>
                request("GET", `${app(o, appId)}/deployments`, z.array(loose(deploymentSchema))),
            listPage: (o: string, appId: string, page: PageOptions) =>
                requestPage(`${app(o, appId)}/deployments`, z.array(loose(deploymentSchema)), page),
            create: (
                o: string,
                appId: string,
                input: z.input<typeof createDeploymentSchema>,
                options?: Pick<RequestOptions, "signal">,
            ) =>
                request("POST", `${app(o, appId)}/deployments`, loose(deploymentSchema), input, {
                    signal: options?.signal,
                }),
            get: (o: string, id: string) =>
                request("GET", deployment(o, id), loose(deploymentSchema)),
            events: (o: string, id: string, cursor?: { after?: string; limit?: number }) =>
                request(
                    "GET",
                    `${deployment(o, id)}/events${query(cursor ?? {})}`,
                    z.array(loose(deploymentEventSchema)),
                ),
            // One page of events by `after`/`limit` (limit 1 to 500), with `nextAfter` taken from the
            // `Link` header, which is sent only when `limit` is given and more events exist.
            eventsPage: async (
                o: string,
                id: string,
                options: { after?: string; limit: number; signal?: AbortSignal },
            ): Promise<EventsPage<z.infer<typeof deploymentEventSchema>>> => {
                checkLimit(options.limit, 500);
                const path = `${deployment(o, id)}/events`;
                const { data, headers } = await send(
                    "GET",
                    `${path}${query({ after: options.after, limit: options.limit })}`,
                    z.array(loose(deploymentEventSchema)),
                    undefined,
                    { signal: options.signal },
                );
                // 10 digits is the controller's own bound on `after`.
                const after = nextLink(headers, path)?.get("after");
                return after && /^\d{1,10}$/.test(after)
                    ? { items: data, nextAfter: after }
                    : { items: data };
            },
            delete: (o: string, id: string) =>
                request("DELETE", deployment(o, id), loose(deploymentDeletionSchema)),
        },
        aliases: {
            list: (o: string, appId: string) =>
                request("GET", `${app(o, appId)}/aliases`, z.array(loose(aliasSchema))),
            listPage: (o: string, appId: string, page: PageOptions) =>
                requestPage(`${app(o, appId)}/aliases`, z.array(loose(aliasSchema)), page),
            get: (o: string, id: string) => request("GET", alias(o, id), loose(aliasSchema)),
            create: (o: string, appId: string, input: z.input<typeof createAliasSchema>) =>
                request("POST", `${app(o, appId)}/aliases`, loose(aliasSchema), input),
            promote: (
                o: string,
                id: string,
                input: z.input<typeof promoteAliasSchema>,
                options: RequestOptions & { idempotencyKey: string },
            ) =>
                request(
                    "POST",
                    `${alias(o, id)}/promotions`,
                    loose(promotionOperationSchema),
                    input,
                    options,
                ),
            withdraw: (
                o: string,
                id: string,
                input: z.input<typeof withdrawAliasSchema>,
                options: RequestOptions & { idempotencyKey: string },
            ) => request("DELETE", alias(o, id), loose(promotionOperationSchema), input, options),
            operations: (o: string, id: string) =>
                request(
                    "GET",
                    `${alias(o, id)}/operations`,
                    z.array(loose(promotionOperationSchema)),
                ),
            operationsPage: (o: string, id: string, page: PageOptions) =>
                requestPage(
                    `${alias(o, id)}/operations`,
                    z.array(loose(promotionOperationSchema)),
                    page,
                ),
        },
    };
}

export type LaunchpadClient = ReturnType<typeof createClient>;
