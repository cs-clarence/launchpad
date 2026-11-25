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
import { LaunchpadConfigError, LaunchpadTransportError } from "./errors";
import { loose } from "./loose";
import {
    createTransport,
    type Extra,
    nextLink as nextLinkOf,
    normalizeBaseUrl,
    type RawOptions,
    rawRequest,
} from "./transport";

export { FORBIDDEN_RAW_HEADERS, normalizeBaseUrl, RAW_METHODS } from "./transport";
export type { RawOptions, RawResponse } from "./transport";

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

export function createClient(options: ClientOptions) {
    const base = normalizeBaseUrl(options.baseUrl);
    const apiKey = options.apiKey;
    if (!API_KEY_FORMAT.test(apiKey)) {
        // The value is never echoed: it may be a secret typed into the wrong field.
        throw new LaunchpadConfigError("The API key is not in the expected format (lp_…).");
    }
    const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    const timeoutMs = options.timeoutMs ?? 30_000;
    const transport = createTransport({
        base,
        doFetch,
        timeoutMs,
        prefix: "/api/v1",
        credentialHeaders: () => ({ authorization: `Bearer ${apiKey}` }),
    });
    const { exchange } = transport;
    const nextLink = (headers: Headers, path: string) => nextLinkOf(base, headers, path);

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
    const raw = (method: string, rawPath: string, options?: RawOptions) =>
        rawRequest(transport, base, method, rawPath, options);

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
