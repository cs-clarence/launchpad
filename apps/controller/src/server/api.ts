import { allowLoginAttempt, allowResetRequest, CLIENT_IP_HEADER, type Auth } from "@launchpad/auth";
import type { Database } from "@launchpad/database";
import type { Kysely } from "kysely";
import {
    acceptInvitation,
    addMember,
    createInvitation,
    createOrganization,
    createProject,
    getControllerInfo,
    getOrganization,
    type InvitationDeps,
    listInvitations,
    listMembers,
    listMyOrganizations,
    listProjects,
    previewInvitation,
    type Principal,
    removeMember,
    revokeInvitation,
    ServiceError,
} from "@launchpad/services";
import { Elysia } from "elysia";
import { docs, openApiPlugin } from "./openapi";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
// Every request body is small JSON; anything larger is refused before it is read.
export const MAX_BODY_BYTES = 64 * 1024;

// A fetch handler only: the parent TanStack Start server owns the listener.
// The path from the same `request.url` string Elysia routes on, so the guard and
// the router can never disagree about which path a request targets.
function rawPath(request: Request): string {
    return /^[a-z]+:\/\/[^/?#]+([^?#]*)/i.exec(request.url)?.[1] ?? "";
}

// Normalizes encoding, repeated slashes and case before matching, so no spelling
// of the path reaches Better Auth's organization routes.
function isOrganizationPath(path: string): boolean {
    let decoded = path;
    try {
        decoded = decodeURIComponent(path);
    } catch {
        return true; // Undecodable paths to the auth namespace are refused.
    }
    return decoded
        .replace(/\/{2,}/g, "/")
        .toLowerCase()
        .startsWith("/api/auth/organization");
}

export function createApi(deps: {
    docs?: boolean;
    auth: Auth;
    db: Kysely<Database>;
    origin: string;
    invitations: InvitationDeps;
}) {
    const { auth, db, origin, invitations } = deps;
    const withDocs = deps.docs ?? false;
    const emailOf = (request: Request) =>
        request
            .clone()
            .json()
            .then((body: { email?: unknown }) =>
                typeof body?.email === "string" ? body.email : "",
            )
            .catch(() => "");

    async function throttleSignIn(request: Request): Promise<Response | undefined> {
        const email = await emailOf(request);
        const clientIp = request.headers.get(CLIENT_IP_HEADER);
        if (!clientIp) {
            return Response.json(
                { code: "client-address-unavailable", status: 400, title: "Bad Request" },
                { status: 400 },
            );
        }
        if (await allowLoginAttempt(db, { clientIp, email })) {
            return;
        }
        return Response.json(
            { code: "too-many-requests", status: 429, title: "Too Many Requests" },
            { status: 429, headers: { "retry-after": "60" } },
        );
    }

    async function principalOf(request: Request): Promise<Principal | null> {
        if (!request.headers.has("cookie")) {
            return null;
        }
        const session = await auth.api.getSession({ headers: request.headers });
        if (!session) {
            return null;
        }
        const role = (session.user as { role?: string }).role;
        return { userId: session.user.id, instanceRole: role === "operator" ? "operator" : "user" };
    }

    const STATUS = {
        "not-found": 404,
        forbidden: 403,
        conflict: 409,
        invalid: 422,
        "delivery-failed": 502,
    } as const;

    async function execute(
        set: { status?: number | string },
        run: () => Promise<unknown>,
        successStatus: number,
    ) {
        try {
            const result = await run();
            set.status = successStatus;
            return result ?? { ok: true };
        } catch (error) {
            if (error instanceof ServiceError) {
                set.status = STATUS[error.code];
                return { code: error.code, status: STATUS[error.code], title: error.message };
            }
            console.error("Unexpected API failure", error);
            set.status = 500;
            return { code: "internal", status: 500, title: "Internal Server Error" };
        }
    }

    // Authenticates, runs one service call, and maps expected failures to stable
    // machine-readable errors. Unexpected failures are never described to clients.
    async function respond(
        request: Request,
        set: { status?: number | string },
        run: (principal: Principal) => Promise<unknown>,
        successStatus = 200,
    ) {
        const principal = await principalOf(request);
        if (!principal) {
            set.status = 401;
            return { code: "unauthenticated", status: 401, title: "Unauthorized" };
        }
        return execute(set, () => run(principal), successStatus);
    }

    // For endpoints a token holder may call without an account.
    async function respondPublic(
        request: Request,
        set: { status?: number | string },
        run: (principal: Principal | null) => Promise<unknown>,
        successStatus = 200,
    ) {
        const principal = await principalOf(request);
        return execute(set, () => run(principal), successStatus);
    }

    const body = (request: Request) => request.json().catch(() => undefined);

    return (
        new Elysia({ prefix: "/api" })
            // Cookie-authenticated mutations must come from the controller's own
            // origin. Sibling preview hosts share a site, so SameSite is not enough.
            .onRequest(async ({ request }) => {
                const path = rawPath(request);
                if (!SAFE_METHODS.has(request.method)) {
                    const declared = request.headers.get("content-length");
                    // Any transfer coding means an undeclared length; the limit cannot be
                    // enforced before reading, and legitimate clients send a length.
                    const encoded = request.headers.has("transfer-encoding");
                    if (encoded || (declared !== null && !/^\d+$/.test(declared))) {
                        return Response.json(
                            { code: "invalid", status: 411, title: "Length Required" },
                            { status: 411 },
                        );
                    }
                    if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
                        return Response.json(
                            { code: "invalid", status: 413, title: "Payload Too Large" },
                            { status: 413 },
                        );
                    }
                }
                if (
                    request.method === "POST" &&
                    path.toLowerCase().includes("request-password-reset")
                ) {
                    const email = await emailOf(request);
                    if (!(await allowResetRequest(db, email))) {
                        return Response.json(
                            { code: "too-many-requests", status: 429, title: "Too Many Requests" },
                            { status: 429, headers: { "retry-after": "3600" } },
                        );
                    }
                }
                if (request.method === "POST" && path.toLowerCase().includes("sign-in/email")) {
                    const throttled = await throttleSignIn(request);
                    if (throttled) {
                        return throttled;
                    }
                }
                // Better Auth's organization endpoints use its own role model. All
                // organization changes go through Launchpad's authorized services.
                if (isOrganizationPath(path)) {
                    return Response.json(
                        { code: "not-found", status: 404, title: "Not Found" },
                        { status: 404 },
                    );
                }
                if (path.startsWith("/api/auth/")) {
                    return; // Better Auth enforces trusted origins itself.
                }
                if (SAFE_METHODS.has(request.method) || !request.headers.has("cookie")) {
                    return;
                }
                if (request.headers.get("origin") !== origin) {
                    return Response.json(
                        { code: "forbidden-origin", status: 403, title: "Forbidden" },
                        { status: 403 },
                    );
                }
            })
            .get("/health", { detail: { hide: true } }, getControllerInfo)
            .all("/auth/*", { detail: { hide: true } }, ({ request }) => auth.handler(request))
            .get("/v1/me", { detail: docs.me }, async ({ request, set }) => {
                if (!request.headers.has("cookie")) {
                    set.status = 401;
                    return { code: "unauthenticated", status: 401, title: "Unauthorized" };
                }
                const session = await auth.api.getSession({ headers: request.headers });
                if (!session) {
                    set.status = 401;
                    return { code: "unauthenticated", status: 401, title: "Unauthorized" };
                }
                const { id, email, name } = session.user;
                const role = (session.user as { role?: string }).role ?? "user";
                return { id, email, name, role };
            })
            .get("/v1/organizations", { detail: docs.listOrganizations }, ({ request, set }) =>
                respond(request, set, (p) => listMyOrganizations(db, p)),
            )
            .post(
                "/v1/organizations",
                { detail: docs.createOrganization },
                async ({ request, set }) => {
                    const input = await body(request);
                    return respond(request, set, (p) => createOrganization(db, p, input), 201);
                },
            )
            .get(
                "/v1/organizations/:orgId",
                { detail: docs.getOrganization },
                ({ request, set, params }) =>
                    respond(request, set, (p) => getOrganization(db, p, params.orgId)),
            )
            .get(
                "/v1/organizations/:orgId/members",
                { detail: docs.listMembers },
                ({ request, set, params }) =>
                    respond(request, set, (p) => listMembers(db, p, params.orgId)),
            )
            .post(
                "/v1/organizations/:orgId/members",
                { detail: docs.addMember },
                async ({ request, set, params }) => {
                    const input = await body(request);
                    return respond(request, set, (p) => addMember(db, p, params.orgId, input), 201);
                },
            )
            .delete(
                "/v1/organizations/:orgId/members/:userId",
                { detail: docs.removeMember },
                ({ request, set, params }) =>
                    respond(request, set, (p) => removeMember(db, p, params.orgId, params.userId)),
            )
            .get(
                "/v1/organizations/:orgId/invitations",
                { detail: docs.listInvitations },
                ({ request, set, params }) =>
                    respond(request, set, (p) => listInvitations(db, p, params.orgId)),
            )
            .post(
                "/v1/organizations/:orgId/invitations",
                { detail: docs.createInvitation },
                async ({ request, set, params }) => {
                    const input = await body(request);
                    return respond(
                        request,
                        set,
                        (p) => createInvitation(db, p, params.orgId, input, invitations),
                        201,
                    );
                },
            )
            .delete(
                "/v1/organizations/:orgId/invitations/:invitationId",
                { detail: docs.revokeInvitation },
                ({ request, set, params }) =>
                    respond(request, set, (p) =>
                        revokeInvitation(db, p, params.orgId, params.invitationId),
                    ),
            )
            .post(
                "/v1/invitations/preview",
                { detail: docs.previewInvitation },
                async ({ request, set }) => {
                    const input = (await body(request)) as { token?: unknown } | undefined;
                    const token = typeof input?.token === "string" ? input.token : "";
                    return respondPublic(request, set, () => previewInvitation(db, token));
                },
            )
            .post(
                "/v1/invitations/accept",
                { detail: docs.acceptInvitation },
                async ({ request, set }) => {
                    const input = await body(request);
                    return respondPublic(request, set, (p) =>
                        acceptInvitation(db, p, input, invitations),
                    );
                },
            )
            .get(
                "/v1/organizations/:orgId/projects",
                { detail: docs.listProjects },
                ({ request, set, params }) =>
                    respond(request, set, (p) => listProjects(db, p, params.orgId)),
            )
            .post(
                "/v1/organizations/:orgId/projects",
                { detail: docs.createProject },
                async ({ request, set, params }) => {
                    const input = await body(request);
                    return respond(
                        request,
                        set,
                        (p) => createProject(db, p, params.orgId, input),
                        201,
                    );
                },
            )
            // Last: the plugin's types would otherwise hide the handler context above.
            .use(openApiPlugin(withDocs))
    );
}

export type Api = ReturnType<typeof createApi>;
