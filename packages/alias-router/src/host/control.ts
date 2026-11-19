import { RouterError, hostnameSchema } from "../protocol";
import type { RouterStore } from "../store";
import { errorName, errorStatus, json } from "./http";

export const MAX_CONTROL_BODY_BYTES = 8192;

const BEARER = /^Bearer ([0-9a-f]{64})$/;
const CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;
const LIMIT = /^[0-9]{1,4}$/;

async function readBody(request: Request): Promise<unknown> {
    if (!CONTENT_TYPE.test(request.headers.get("content-type") ?? "")) {
        throw new RouterError("invalid");
    }
    const declared = request.headers.get("content-length");
    if (
        declared !== null &&
        (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_CONTROL_BODY_BYTES)
    ) {
        throw new BodyTooLarge();
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = request.body?.getReader();
    if (!reader) throw new RouterError("invalid");
    // Bounded while streaming: a lying or missing Content-Length cannot grow memory.
    for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
            chunk = await reader.read();
        } catch {
            // The client went away mid-body: an invalid request, not a server error.
            throw new RouterError("invalid");
        }
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_CONTROL_BODY_BYTES) {
            await reader.cancel();
            throw new BodyTooLarge();
        }
        chunks.push(chunk.value);
    }
    try {
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    } catch {
        throw new RouterError("invalid");
    }
}

class BodyTooLarge extends Error {}

function authenticate(store: RouterStore, request: Request) {
    const bearer = BEARER.exec(request.headers.get("authorization") ?? "");
    const instanceId = request.headers.get("x-launchpad-instance");
    const epoch = request.headers.get("x-launchpad-epoch");
    // One fixed failure for every cause: nothing tells a caller which part was wrong.
    if (!bearer || instanceId === null || epoch === null) throw new RouterError("unauthorized");
    return store.authenticate({ instanceId, epoch, token: bearer[1] });
}

const NOT_FOUND = () => json(404, { error: "not-found" });
const NOT_ALLOWED = (allow: string) => json(405, { error: "method-not-allowed" }, { allow });

/** The private control plane: a fetch-style handler over one open store. It binds nothing. */
export function createControlHandler(store: RouterStore): (request: Request) => Promise<Response> {
    return async (request) => {
        try {
            const url = new URL(request.url);
            const path = url.pathname;
            if (path === "/healthz") {
                if (request.method !== "GET") return NOT_ALLOWED("GET");
                try {
                    store.listRoutes({ limit: 1 });
                    return json(200, { status: "ok" });
                } catch {
                    return json(503, { status: "unavailable" });
                }
            }
            if (path !== "/v1" && !path.startsWith("/v1/")) return NOT_FOUND();
            // Authenticate before matching anything under /v1, so unknown paths and wrong methods
            // reveal nothing to a caller without credentials.
            const writer = authenticate(store, request);

            if (path === "/v1/deployments") {
                if (request.method !== "POST") return NOT_ALLOWED("POST");
                return json(200, store.registerDeployment(writer, await readBody(request)));
            }
            if (path === "/v1/routes") {
                if (request.method === "POST") {
                    return json(200, store.replaceRoute(writer, await readBody(request)));
                }
                if (request.method !== "GET") return NOT_ALLOWED("GET, POST");
                for (const key of url.searchParams.keys()) {
                    if (key !== "after" && key !== "limit") throw new RouterError("invalid");
                }
                const limit = url.searchParams.get("limit");
                if (limit !== null && !LIMIT.test(limit)) throw new RouterError("invalid");
                const after = url.searchParams.get("after");
                return json(
                    200,
                    store.listRoutes({
                        ...(after === null ? {} : { after }),
                        ...(limit === null ? {} : { limit: Number(limit) }),
                    }),
                );
            }
            const single = /^\/v1\/routes\/([^/]+)$/.exec(path);
            if (single) {
                if (request.method !== "GET") return NOT_ALLOWED("GET");
                // Plain canonical hostnames only: no percent-encoding to decode or smuggle.
                if (!hostnameSchema.safeParse(single[1]).success) throw new RouterError("invalid");
                return json(200, store.readRoute(single[1]));
            }
            return NOT_FOUND();
        } catch (error) {
            if (error instanceof BodyTooLarge) return json(413, { error: "too-large" });
            return json(errorStatus(error), { error: errorName(error) });
        }
    };
}
