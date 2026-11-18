import { createFileRoute } from "@tanstack/react-router";
import { getRequestIP } from "@tanstack/react-start/server";
import { resolveClientIp, withClientIp } from "../server/client-ip";
import { SchemaMismatchError } from "@launchpad/database";
import { getReadyRuntime } from "../server/runtime";

const handle = async ({ request }: { request: Request }) => {
    let runtime: Awaited<ReturnType<typeof getReadyRuntime>>;
    try {
        runtime = await getReadyRuntime();
    } catch (error) {
        // Only a real mismatch is a 503; a configuration or database failure stays an error.
        if (error instanceof SchemaMismatchError) {
            return Response.json(
                { code: "schema-mismatch", status: 503, title: "Service Unavailable" },
                { status: 503 },
            );
        }
        throw error;
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
