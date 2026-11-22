import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const ADDRESS = "127.0.0.1";
const PORT = 9080;
export const INGRESS_MARKER_HEADER = "x-launchpad-acceptance-ingress";

/** Smoke-test transport only: exact fixture hosts, GET /, and no forwarded client headers. */
export async function withIngress<T>(
    origins: ReadonlyMap<string, URL>,
    test: (marker: string) => Promise<T>,
): Promise<T> {
    const marker = randomUUID();
    const notFound = () => new Response("Not found\n", { status: 404 });
    const server = Bun.serve({
        hostname: ADDRESS,
        port: PORT,
        async fetch(request) {
            const hostname = request.headers.get("host");
            if (hostname === null) return notFound();
            const upstream = origins.get(hostname);
            if (!upstream || request.method !== "GET" || new URL(request.url).pathname !== "/")
                return notFound();

            try {
                const result = await fetch(upstream, {
                    headers: { host: hostname },
                    redirect: "error",
                    signal: AbortSignal.timeout(5000),
                });
                const headers = new Headers({
                    "cache-control": "no-store",
                    [INGRESS_MARKER_HEADER]: marker,
                });
                for (const name of ["content-type", "x-launchpad-deployment"]) {
                    const value = result.headers.get(name);
                    if (value) headers.set(name, value);
                }
                return new Response(result.body, { status: result.status, headers });
            } catch {
                return new Response("Fixture upstream unavailable\n", { status: 502 });
            }
        },
    });
    try {
        const unknown = await fetch(`http://${ADDRESS}:${PORT}/`, {
            signal: AbortSignal.timeout(3000),
        });
        await unknown.body?.cancel();
        assert.equal(unknown.status, 404);
        assert.equal(unknown.headers.get(INGRESS_MARKER_HEADER), null);
        return await test(marker);
    } finally {
        await server.stop(true);
    }
}
