import {
    type createApiKeySchema,
    type createProjectSchema,
    createdProjectSchema,
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

    async function request<T>(
        method: string,
        path: string,
        schema: z.ZodType<T>,
        body?: unknown,
    ): Promise<T> {
        let response: Response;
        let text: string;
        try {
            response = await doFetch(`${base}/api/v1${path}`, {
                method,
                headers: {
                    authorization: `Bearer ${apiKey}`,
                    accept: "application/json",
                    ...(body === undefined ? {} : { "content-type": "application/json" }),
                },
                body: body === undefined ? undefined : JSON.stringify(body),
                // Never ambient browser credentials, and never forward the key elsewhere.
                credentials: "omit",
                redirect: "error",
                cache: "no-store",
                signal: AbortSignal.timeout(timeoutMs),
            });
            // The timeout also covers the body: a stalled stream must not hang the caller.
            text = await readBounded(response);
        } catch (error) {
            if (error instanceof LaunchpadTransportError) throw error;
            const name = (error as { name?: string })?.name;
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
    };
}

export type LaunchpadClient = ReturnType<typeof createClient>;
