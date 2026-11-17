import {
    artifactSchema,
    createdDeploymentSchema,
    type createApiKeySchema,
    type createDeploymentSchema,
    type createPreviewSchema,
    type extendPreviewSchema,
    requestedDeletionSchema,
    deletionSchema,
    type createProjectSchema,
    createdProjectSchema,
    deploymentEventSchema,
    deploymentEventsSchema,
    deploymentListSchema,
    deploymentSchema,
    previewListSchema,
    previewSchema,
    keyInfoSchema,
    memberSchema,
    organizationSummarySchema,
    projectSchema,
} from "@launchpad/contracts";
import { z } from "zod";
import { LaunchpadApiError, LaunchpadConfigError, LaunchpadTransportError } from "./errors";

export type KeyInfo = z.infer<typeof keyInfoSchema>;
export type OrganizationSummary = z.infer<typeof organizationSummarySchema>;
export type Member = z.infer<typeof memberSchema>;
export type Project = z.infer<typeof projectSchema>;
export type CreatedProject = z.infer<typeof createdProjectSchema>;
export type CreateProjectInput = z.input<typeof createProjectSchema>;
export type CreateApiKeyInput = z.input<typeof createApiKeySchema>;
export type Preview = z.infer<typeof previewSchema>;
export type PreviewList = z.infer<typeof previewListSchema>;
export type CreatePreviewInput = z.input<typeof createPreviewSchema>;
export type ExtendPreviewInput = z.input<typeof extendPreviewSchema>;
export type RequestedDeletion = z.infer<typeof requestedDeletionSchema>;
export type Deletion = z.infer<typeof deletionSchema>;
export type CreateDeploymentInput = z.input<typeof createDeploymentSchema>;
export type QueuedDeployment = z.infer<typeof createdDeploymentSchema>;
export type Deployment = z.infer<typeof deploymentSchema>;
export type DeploymentEvents = z.infer<typeof deploymentEventsSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
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
    // Uploading an archive takes longer than any other call.
    uploadTimeoutMs?: number;
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

// Pages whose items are tolerant too, so a newer controller's extra fields on a preview or
// a deployment do not break an older client.
const previewPage = z
    .object({ items: z.array(loose(previewSchema)), nextCursor: z.uuid().nullable() })
    .loose() as unknown as z.ZodType<PreviewList>;
const deploymentPage = z
    .object({ items: z.array(loose(deploymentSchema)) })
    .loose() as unknown as z.ZodType<z.infer<typeof deploymentListSchema>>;
const eventPage = z
    .object({
        items: z.array(loose(deploymentEventSchema)),
        nextAfter: z.number().int().nullable(),
    })
    .loose() as unknown as z.ZodType<DeploymentEvents>;

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
    const uploadTimeoutMs = options.uploadTimeoutMs ?? 5 * 60_000;
    const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;

    async function request<T>(
        method: string,
        path: string,
        schema: z.ZodType<T>,
        body?: unknown,
        extra: {
            idempotencyKey?: string;
            signal?: AbortSignal;
            raw?: { body: Blob | Uint8Array; contentType: string };
            timeoutMs?: number;
        } = {},
    ): Promise<T> {
        if (extra.idempotencyKey !== undefined && !IDEMPOTENCY_KEY.test(extra.idempotencyKey)) {
            throw new LaunchpadConfigError(
                "An idempotency key is 1 to 128 letters, digits and . _ : -.",
            );
        }
        const signals = [AbortSignal.timeout(extra.timeoutMs ?? timeoutMs)];
        if (extra.signal) signals.push(extra.signal);
        let response: Response;
        let text: string;
        try {
            response = await doFetch(`${base}/api/v1${path}`, {
                method,
                headers: {
                    authorization: `Bearer ${apiKey}`,
                    accept: "application/json",
                    ...(body === undefined ? {} : { "content-type": "application/json" }),
                    ...(extra.raw ? { "content-type": extra.raw.contentType } : {}),
                    ...(extra.idempotencyKey ? { "idempotency-key": extra.idempotencyKey } : {}),
                },
                body: extra.raw
                    ? (extra.raw.body as BodyInit)
                    : body === undefined
                      ? undefined
                      : JSON.stringify(body),
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

    const seg = encodeURIComponent;
    const query = (params: Record<string, string | number | undefined>) => {
        const entries = Object.entries(params).filter(([, v]) => v !== undefined);
        return entries.length === 0
            ? ""
            : `?${entries.map(([k, v]) => `${seg(k)}=${seg(String(v))}`).join("&")}`;
    };
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
        artifacts: {
            // Uploads a `.tar.gz` of a built static site (index.html at its root). An
            // identical archive already stored for the organization is reused.
            upload: (
                organizationId: string,
                archive: Blob | Uint8Array,
                opts: RequestOptions = {},
            ) =>
                request(
                    "POST",
                    `/organizations/${seg(organizationId)}/artifacts`,
                    loose(artifactSchema),
                    undefined,
                    {
                        signal: opts.signal,
                        raw: { body: archive, contentType: "application/gzip" },
                        timeoutMs: uploadTimeoutMs,
                    },
                ),
        },
        previews: {
            extend: (
                organizationId: string,
                previewId: string,
                input: ExtendPreviewInput,
                opts: RequestOptions = {},
            ) =>
                request(
                    "POST",
                    `/organizations/${seg(organizationId)}/previews/${seg(previewId)}/extend`,
                    loose(previewSchema),
                    input,
                    opts,
                ),
            delete: (
                organizationId: string,
                previewId: string,
                opts: { signal?: AbortSignal } = {},
            ) =>
                request(
                    "DELETE",
                    `/organizations/${seg(organizationId)}/previews/${seg(previewId)}`,
                    loose(requestedDeletionSchema),
                    undefined,
                    { signal: opts.signal },
                ),
            list: (organizationId: string, filter: { projectId?: string; cursor?: string } = {}) =>
                request(
                    "GET",
                    `/organizations/${seg(organizationId)}/previews${query(filter)}`,
                    previewPage,
                ),
            get: (organizationId: string, previewId: string) =>
                request(
                    "GET",
                    `/organizations/${seg(organizationId)}/previews/${seg(previewId)}`,
                    loose(previewSchema),
                ),
            create: (
                organizationId: string,
                projectId: string,
                input: CreatePreviewInput,
                opts: RequestOptions = {},
            ) =>
                request(
                    "POST",
                    `/organizations/${seg(organizationId)}/projects/${seg(projectId)}/previews`,
                    loose(previewSchema),
                    input,
                    opts,
                ),
        },
        deletions: {
            // The latest deletion of a preview, whoever started it.
            forPreview: (
                organizationId: string,
                previewId: string,
                opts: { signal?: AbortSignal } = {},
            ) =>
                request(
                    "GET",
                    `/organizations/${seg(organizationId)}/previews/${seg(previewId)}/deletion`,
                    loose(deletionSchema),
                    undefined,
                    { signal: opts.signal },
                ),
            get: (
                organizationId: string,
                operationId: string,
                opts: { signal?: AbortSignal } = {},
            ) =>
                request(
                    "GET",
                    `/organizations/${seg(organizationId)}/deletions/${seg(operationId)}`,
                    loose(deletionSchema),
                    undefined,
                    { signal: opts.signal },
                ),
        },
        deployments: {
            // Queues the deployment and returns at once; poll `get` for progress.
            create: (
                organizationId: string,
                previewId: string,
                input: CreateDeploymentInput,
                opts: RequestOptions = {},
            ) =>
                request(
                    "POST",
                    `/organizations/${seg(organizationId)}/previews/${seg(previewId)}/deployments`,
                    loose(createdDeploymentSchema),
                    input,
                    opts,
                ),
            list: (organizationId: string, previewId: string) =>
                request(
                    "GET",
                    `/organizations/${seg(organizationId)}/previews/${seg(previewId)}/deployments`,
                    deploymentPage,
                ),
            get: (organizationId: string, deploymentId: string, opts: RequestOptions = {}) =>
                request(
                    "GET",
                    `/organizations/${seg(organizationId)}/deployments/${seg(deploymentId)}`,
                    loose(deploymentSchema),
                    undefined,
                    { signal: opts.signal },
                ),
            // Events after the last sequence number already seen.
            events: (
                organizationId: string,
                deploymentId: string,
                after?: number,
                opts: RequestOptions = {},
            ) =>
                request(
                    "GET",
                    `/organizations/${seg(organizationId)}/deployments/${seg(deploymentId)}/events${query({ after })}`,
                    eventPage,
                    undefined,
                    { signal: opts.signal },
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
    };
}

export type LaunchpadClient = ReturnType<typeof createClient>;
