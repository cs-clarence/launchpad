import { createFileRoute } from "@tanstack/react-router";
import { getRequestIP } from "@tanstack/react-start/server";
import { resolveClientIp, withClientIp } from "../server/client-ip";
import { getRuntime } from "../server/runtime";

const handle = ({ request }: { request: Request }) => {
    const runtime = getRuntime();
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
