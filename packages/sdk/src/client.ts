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

    async function request<T>(
        method: string,
        path: string,
        schema: z.ZodType<T>,
        body?: unknown,
        extra: {
            idempotencyKey?: string;
            signal?: AbortSignal;
            archive?: Blob;
        } = {},
    ): Promise<T> {
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
                    authorization: `Bearer ${apiKey}`,
                    accept: "application/json",
                    ...(extra.archive
                        ? { "content-type": "application/gzip" }
                        : body === undefined
                          ? {}
                          : { "content-type": "application/json" }),
                    ...(extra.idempotencyKey ? { "idempotency-key": extra.idempotencyKey } : {}),
                },
                body: extra.archive ?? (body === undefined ? undefined : JSON.stringify(body)),
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

        let json: unknown;
        try {
            json = text.length > 0 ? JSON.parse(text) : undefined;
        } catch {
            json = undefined;
        }

        if (!response.ok) {
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
        const parsed = schema.safeParse(json);
        if (!parsed.success) {
            throw new LaunchpadTransportError(
                "invalid-response",
                "The controller's answer is not what this version of the SDK expects.",
            );
        }
        return parsed.data;
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
    return {
        // What this key is: its organization, scopes, project limits and expiry.
        key: { get: () => request("GET", "/key", loose(keyInfoSchema)) },
        organizations: {
            list: () => request("GET", "/organizations", z.array(loose(organizationSummarySchema))),
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
        },
        projects: {
            list: (organizationId: string) =>
                request(
                    "GET",
                    `/organizations/${seg(organizationId)}/projects`,
                    z.array(loose(projectSchema)),
                ),
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
            delete: (o: string, id: string) =>
                request("DELETE", deployment(o, id), loose(deploymentDeletionSchema)),
        },
        aliases: {
            list: (o: string, appId: string) =>
                request("GET", `${app(o, appId)}/aliases`, z.array(loose(aliasSchema))),
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
        },
    };
}

export type LaunchpadClient = ReturnType<typeof createClient>;
