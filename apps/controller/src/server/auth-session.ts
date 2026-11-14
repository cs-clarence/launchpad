import type { Auth } from "@launchpad/auth";
import { appendResponseHeader, getRequest } from "@tanstack/react-start/server";

// Reads the session for the current request and forwards any cookies Better Auth
// refreshed along the way. When a session passes its update age the database expiry
// moves forward and a new cookie is issued; dropping it would end the browser's
// session at the original cookie expiry even for an active user.
export async function readSession(auth: Auth) {
    const result = await auth.api.getSession({
        headers: getRequest().headers,
        returnHeaders: true,
    });
    for (const cookie of result.headers.getSetCookie()) {
        appendResponseHeader("set-cookie", cookie);
    }
    return result.response;
}
