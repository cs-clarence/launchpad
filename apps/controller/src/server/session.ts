import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

export interface CurrentUser {
    id: string;
    email: string;
    name: string;
    role: string;
}

// The runtime is imported inside the handler so server-only code stays out of
// the client bundle.
export const getCurrentUser = createServerFn({ method: "GET" }).handler(
    async (): Promise<CurrentUser | null> => {
        const { getRuntime } = await import("./runtime");
        const session = await getRuntime().auth.api.getSession({
            headers: getRequest().headers,
        });
        if (!session) {
            return null;
        }
        const { id, email, name } = session.user;
        return { id, email, name, role: (session.user as { role?: string }).role ?? "user" };
    },
);
