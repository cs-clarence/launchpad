import { z } from "zod";
import {
    authenticationSchema,
    deploymentSchema,
    hostnameSchema,
    routeObservationSchema,
    routePageSchema,
    type RouteRecord,
    routeWriteSchema,
    type DeploymentTarget,
    type RouteWrite,
} from "./protocol";

export type RouterControlFailure = "not-sent" | "rejected" | "uncertain";
type Send = (input: URL, init: RequestInit) => Promise<Response>;

export class RouterControlError extends Error {
    constructor(readonly kind: RouterControlFailure) {
        // Never attach transport errors, response bodies, headers or URLs.
        super(
            {
                "not-sent": "The router request was not sent.",
                rejected: "The router refused this request.",
                uncertain: "The router outcome could not be confirmed.",
            }[kind],
        );
        this.name = "RouterControlError";
    }
}

const MAX_REPLY_BYTES = 8192;
// A page of the route inventory carries up to LIST_PAGE_ROUTES records.
const MAX_LIST_REPLY_BYTES = 1024 * 1024;
const LIST_PAGE_ROUTES = 500;
const MAX_LIST_PAGES = 2000;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const rejectionSchema = z.strictObject({ error: z.enum(["invalid", "unauthorized"]) });

function checked<T>(schema: z.ZodType<T>, input: unknown, kind: RouterControlFailure): T {
    const result = schema.safeParse(input);
    if (!result.success) throw new RouterControlError(kind);
    return result.data;
}

// A transport may ignore its signal, including after delivering response headers.
async function untilAbort<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    const { promise, reject } = Promise.withResolvers<never>();
    const abort = () => reject(new RouterControlError("uncertain"));
    signal.addEventListener("abort", abort, { once: true });
    try {
        return await Promise.race([promise, run()]);
    } finally {
        signal.removeEventListener("abort", abort);
    }
}

async function readJson(
    response: Response,
    signal: AbortSignal,
    maxBytes = MAX_REPLY_BYTES,
): Promise<unknown> {
    const reader = response.body?.getReader();
    if (!reader) throw new RouterControlError("uncertain");
    // Do not extend the deadline to wait for transport cleanup.
    const cancel = () => void reader.cancel().catch(() => {});
    signal.addEventListener("abort", cancel, { once: true });
    try {
        signal.throwIfAborted();
        if (
            response.redirected ||
            !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
                response.headers.get("content-type") ?? "",
            )
        ) {
            throw new RouterControlError("uncertain");
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > maxBytes) throw new RouterControlError("uncertain");
            chunks.push(chunk.value);
        }
        // Cancellation can complete a pending read as `done` with a partial body.
        signal.throwIfAborted();
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    } finally {
        signal.removeEventListener("abort", cancel);
        cancel();
        reader.releaseLock();
    }
}

/**
 * Private control-plane client. Only pass an operator-configured URL; plain HTTP
 * is for the private control network. A path prefix is allowed for a private proxy.
 * A rejection applies to this request only, never to an earlier ambiguous write.
 */
export function createRouterControlClient(options: {
    baseUrl: URL;
    credentials: { instanceId: string; epoch: string; token: string };
    timeoutMs?: number;
    fetch?: Send;
}) {
    const url = new URL(options.baseUrl);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !Number.isInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > MAX_TIMEOUT_MS
    ) {
        throw new Error("Invalid router control URL or timeout.");
    }
    const credentials = authenticationSchema.safeParse(options.credentials);
    if (!credentials.success) throw new Error("Invalid router control credentials.");
    const authority = credentials.data;
    const send = options.fetch ?? globalThis.fetch;
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;

    async function call(
        path: string,
        body: unknown,
        signal?: AbortSignal,
        maxBytes = MAX_REPLY_BYTES,
    ): Promise<unknown> {
        if (signal?.aborted) throw new RouterControlError("not-sent");
        const deadline = AbortSignal.timeout(timeoutMs);
        const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
        try {
            const { status, data } = await untilAbort(requestSignal, async () => {
                const response = await send(new URL(path, url), {
                    method: body === undefined ? "GET" : "POST",
                    headers: {
                        authorization: `Bearer ${authority.token}`,
                        "x-launchpad-instance": authority.instanceId,
                        "x-launchpad-epoch": authority.epoch,
                        ...(body === undefined ? {} : { "content-type": "application/json" }),
                    },
                    body: body === undefined ? undefined : JSON.stringify(body),
                    redirect: "error",
                    cache: "no-store",
                    signal: requestSignal,
                });
                return {
                    status: response.status,
                    data: await readJson(response, requestSignal, maxBytes),
                };
            });
            requestSignal.throwIfAborted();
            if (status === 200) return data;
            const parsed = rejectionSchema.safeParse(data);
            if (
                parsed.success &&
                ((status === 400 && parsed.data.error === "invalid") ||
                    (status === 401 && parsed.data.error === "unauthorized"))
            ) {
                throw new RouterControlError("rejected");
            }
            // A conflict can describe a superseded write. Do not infer that the
            // old route is still live, or that the requested target was never live.
            throw new RouterControlError("uncertain");
        } catch (error) {
            if (error instanceof RouterControlError) throw error;
            throw new RouterControlError("uncertain");
        }
    }

    function observe(input: unknown, hostname: string) {
        const observed = checked(routeObservationSchema, input, "uncertain");
        if (
            observed.instanceId !== authority.instanceId ||
            observed.epoch !== authority.epoch ||
            (observed.route !== null && observed.route.hostname !== hostname)
        ) {
            throw new RouterControlError("uncertain");
        }
        return observed;
    }

    return {
        async registerDeployment(input: DeploymentTarget, signal?: AbortSignal) {
            const target = checked(deploymentSchema, input, "not-sent");
            const result = checked(
                deploymentSchema,
                await call("v1/deployments", target, signal),
                "uncertain",
            );
            if (
                result.deploymentId !== target.deploymentId ||
                result.hostname !== target.hostname
            ) {
                throw new RouterControlError("uncertain");
            }
            return result;
        },
        async replaceRoute(input: RouteWrite, signal?: AbortSignal) {
            const write = checked(routeWriteSchema, input, "not-sent");
            const result = observe(await call("v1/routes", write, signal), write.hostname);
            if (
                !result.route ||
                result.route.aliasId !== write.aliasId ||
                result.route.operationId !== write.operationId ||
                result.route.generation !== write.generation ||
                (result.route.target?.deploymentId ?? null) !== write.targetDeploymentId
            ) {
                throw new RouterControlError("uncertain");
            }
            return result;
        },
        // The router's active epoch, which is not a secret: one tiny authenticated read.
        async readEpoch(signal?: AbortSignal) {
            const reply = checked(
                routePageSchema,
                await call("v1/routes?limit=1", undefined, signal, MAX_LIST_REPLY_BYTES),
                "uncertain",
            );
            if (reply.instanceId !== authority.instanceId) {
                throw new RouterControlError("uncertain");
            }
            return reply.epoch;
        },
        // Every route the router holds, in hostname order. Each page is checked for this router's
        // instance and epoch, and the cursor must advance, so a faulty reply cannot loop forever.
        async listRoutes(signal?: AbortSignal) {
            const routes: RouteRecord[] = [];
            let after: string | undefined;
            for (let page = 0; page < MAX_LIST_PAGES; page++) {
                const query = new URLSearchParams({ limit: String(LIST_PAGE_ROUTES) });
                if (after !== undefined) query.set("after", after);
                const reply = checked(
                    routePageSchema,
                    await call(`v1/routes?${query}`, undefined, signal, MAX_LIST_REPLY_BYTES),
                    "uncertain",
                );
                if (reply.instanceId !== authority.instanceId || reply.epoch !== authority.epoch) {
                    throw new RouterControlError("uncertain");
                }
                routes.push(...reply.routes);
                if (reply.nextCursor === null) {
                    return { instanceId: reply.instanceId, epoch: reply.epoch, routes };
                }
                if (after !== undefined && reply.nextCursor <= after) {
                    throw new RouterControlError("uncertain");
                }
                after = reply.nextCursor;
            }
            throw new RouterControlError("uncertain");
        },
        async readRoute(hostname: string, signal?: AbortSignal) {
            const host = checked(hostnameSchema, hostname, "not-sent");
            return observe(await call(`v1/routes/${host}`, undefined, signal), host);
        },
    };
}
