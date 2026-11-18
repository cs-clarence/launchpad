import { createFileRoute } from "@tanstack/react-router";
import { getRequestIP } from "@tanstack/react-start/server";
import { resolveClientIp, withClientIp } from "../server/client-ip";
import { getReadyRuntime } from "../server/runtime";

const handle = async ({ request }: { request: Request }) => {
    const runtime = await getReadyRuntime().catch(() => null);
    if (!runtime) {
        return Response.json(
            { code: "schema-mismatch", status: 503, title: "Service Unavailable" },
            { status: 503 },
        );
    }
    const clientIp = resolveClientIp({
        forwardedFor: request.headers.get("x-forwarded-for"),
        socketIp: getRequestIP() ?? null,
        trustedProxy: runtime.config.trustedProxy,
    });
    if (!clientIp) {
        return Response.json(
            { code: "client-address-unavailable", status: 400, title: "Bad Request" },
            { status: 400 },
        );
    }
    return runtime.api.fetch(withClientIp(request, clientIp));
};

export const Route = createFileRoute("/api/$")({
    server: {
        handlers: {
            GET: handle,
            POST: handle,
            PUT: handle,
            PATCH: handle,
            DELETE: handle,
            OPTIONS: handle,
            HEAD: handle,
        },
    },
});
