import {
    allowLoginAttempt,
    allowResetRequest,
    CLIENT_IP_HEADER,
    type Auth,
} from "@launchpad-kit/auth";
import type { Database } from "@launchpad-kit/database";
import type { Kysely } from "kysely";
import {
    acceptInvitation,
    addMember,
    getStatus,
    type ApiKeyPrincipal,
    type ApiKeyScope,
    authenticateApiKey,
    createAlias,
    createApp,
    createDeployment,
    getAlias,
    getApp,
    listAliases,
    getDeployment,
    requestDeploymentDeletion,
    listApps,
    listDeploymentEvents,
    listDeployments,
    resolveLimits,
    uploadArtifact,
    type AliasDeps,
    type AliasSettings,
    type AppDeps,
    type ArtifactDeps,
    createApiKey,
    listApiKeys,
    requireDeploymentsOn,
    requireKeyAccess,
    revokeApiKey,
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
    DeploymentRecoveryError,
    ServiceError,
} from "@launchpad-kit/services";
import { Elysia } from "elysia";
import { framingProblem, framingResponse, SAFE_METHODS } from "./body-framing";
import { MAX_BODY_BYTES } from "./limits";
import { docs, openApiPlugin } from "./openapi";

// Anything larger than the limit is refused before it is read.
export { MAX_BODY_BYTES } from "./limits";

// The only request that may carry a large body: a project's archive upload.
// Exact, like the router: anything else keeps the small limit, which fails safe.
const ARTIFACT_UPLOAD = /^\/api\/v1\/organizations\/[^/]+\/projects\/[^/]+\/artifacts$/;
function isArtifactUpload(method: string, path: string) {
    return method === "POST" && ARTIFACT_UPLOAD.test(path);
}

// A fetch handler only: the parent TanStack Start server owns the listener.
// The path from the same `request.url` string Elysia routes on, so the guard and
// the router can never disagree about which path a request targets.
function rawPath(request: Request): string {
    return /^[a-z]+:\/\/[^/?#]+([^?#]*)/i.exec(request.url)?.[1] ?? "";
}

// Normalizes encoding, repeated slashes and case before matching, so no spelling
// of the path reaches Better Auth's organization routes.
// The auth namespace path after decoding, collapsing repeated slashes and lowering
// the case, or null when it is not under /api/auth. Throttles that read a request
// body match here, never by searching the whole path: a substring search would also
// match an unrelated route whose name contains it, such as an upload.
function authPath(path: string): string | null {
    let decoded = path;
    try {
        decoded = decodeURIComponent(path);
    } catch {
        return path.toLowerCase().startsWith("/api/auth/") ? path.toLowerCase() : null;
    }
    const normalized = decoded.replace(/\/{2,}/g, "/").toLowerCase();
    return normalized.startsWith("/api/auth/") ? normalized : null;
}

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
    // Uploaded archives and deployments. Absent (as in the adapter's unit tests) the routes
    // refuse with 503, exactly as when deployments are off.
    artifacts?: ArtifactDeps;
    deployments?: AppDeps;
    aliases?: AliasSettings;
}) {
    const { auth, db, origin, invitations } = deps;
    const artifacts = deps.artifacts ?? { dataDir: "", limits: {} };
    const deployments: AppDeps = deps.deployments ?? { dataDir: "", settings: { enabled: false } };
    const aliasDeps: AliasDeps = { ...deployments, aliases: deps.aliases ?? { enabled: false } };
    // Resolved once, so a bad limit fails at startup, not on the first upload.
    const uploadLimit = resolveLimits(artifacts.limits).maxUploadBytes;
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

    // Issuing a credential needs recent proof of identity: a session older than this
    // must sign in again first.
    const FRESH_SESSION_MS = 15 * 60 * 1000;

    async function sessionPrincipal(
        request: Request,
    ): Promise<(Principal & { sessionCreatedAt: Date; sessionId: string }) | null> {
        if (!request.headers.has("cookie")) {
            return null;
        }
        const session = await auth.api.getSession({ headers: request.headers });
        if (!session) {
            return null;
        }
        const role = (session.user as { role?: string }).role;
        return {
            userId: session.user.id,
            instanceRole: role === "operator" ? "operator" : "user",
            sessionCreatedAt: new Date(session.session.createdAt),
            sessionId: session.session.id,
        };
    }

    // A request is authenticated by a bearer key or by a session cookie, never both: if
    // an Authorization header is present it alone decides, so a bad key is a 401 and
    // cannot fall back to ambient browser credentials.
    type Caller = {
        principal: Principal;
        key: ApiKeyPrincipal | null;
        sessionCreatedAt?: Date;
        sessionId?: string;
    };
    async function callerOf(request: Request): Promise<Caller | null> {
        const header = request.headers.get("authorization");
        if (header !== null) {
            const match = /^Bearer (\S+)$/i.exec(header);
            const key = match ? await authenticateApiKey(db, match[1]!) : null;
            return key ? { principal: key.principal, key } : null;
        }
        const session = await sessionPrincipal(request);
        if (!session) return null;
        const { sessionCreatedAt, sessionId, ...principal } = session;
        return { principal, key: null, sessionCreatedAt, sessionId };
    }

    const STATUS = {
        "not-found": 404,
        forbidden: 403,
        conflict: 409,
        invalid: 422,
        "delivery-failed": 502,
        "too-large": 413,
        timeout: 408,
        unavailable: 503,
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
            if (error instanceof DeploymentRecoveryError) {
                // Writes are refused on purpose while a restore is being reconciled.
                set.status = STATUS.unavailable;
                return {
                    code: "unavailable",
                    status: STATUS.unavailable,
                    title: "Deployments are unavailable while recovery is in progress.",
                };
            }
            console.error("Unexpected API failure", error);
            set.status = 500;
            return { code: "internal", status: 500, title: "Internal Server Error" };
        }
    }

    // Authenticates, runs one service call, and maps expected failures to stable
    // machine-readable errors. Unexpected failures are never described to clients.
    // `access` names what an API key needs for this route; without it the route is
    // session-only and any key is refused.
    interface Access {
        organizationId?: string; // omitted: the key's own organization
        scope: ApiKeyScope;
    }
    async function respond(
        request: Request,
        set: { status?: number | string },
        access: Access | null,
        run: (
            principal: Principal,
            key: ApiKeyPrincipal | null,
            sessionId?: string,
        ) => Promise<unknown>,
        successStatus = 200,
        options: { fresh?: boolean } = {},
    ) {
        const caller = await callerOf(request);
        if (!caller) {
            set.status = 401;
            return { code: "unauthenticated", status: 401, title: "Unauthorized" };
        }
        const { principal, key } = caller;
        return execute(
            set,
            async () => {
                if (key) {
                    if (!access) {
                        throw new ServiceError("forbidden", "API keys cannot use this endpoint.");
                    }
                    requireKeyAccess(
                        key,
                        access.organizationId ?? key.organizationId,
                        access.scope,
                    );
                }
                // After the key check: a key is told what it cannot do, not to sign in again.
                if (
                    options.fresh &&
                    Date.now() - (caller.sessionCreatedAt?.getTime() ?? 0) > FRESH_SESSION_MS
                ) {
                    throw new ServiceError("forbidden", "Sign in again to do this.");
                }
                return run(principal, key, caller.sessionId);
            },
            successStatus,
        );
    }

    // For endpoints a token holder may call without an account.
    async function respondPublic(
        request: Request,
        set: { status?: number | string },
        run: (principal: Principal | null) => Promise<unknown>,
        successStatus = 200,
    ) {
        // No Authorization header here: it would otherwise be silently ignored in favour
        // of the cookie, against the rule that a header alone decides.
        if (request.headers.has("authorization")) {
            set.status = 401;
            return { code: "unauthenticated", status: 401, title: "Unauthorized" };
        }
        const session = await sessionPrincipal(request);
        const principal = session
            ? { userId: session.userId, instanceRole: session.instanceRole }
            : null;
        return execute(set, () => run(principal), successStatus);
    }

    const body = (request: Request) => request.json().catch(() => undefined);

    return (
        new Elysia({ prefix: "/api" })
            // Cookie-authenticated mutations must come from the controller's own
            // origin: SameSite alone does not stop a sibling host of the same site.
            .onRequest(async ({ request }) => {
                const path = rawPath(request);
                // Only the archive upload may be large; every other body is small JSON.
                const problem = framingProblem(
                    request,
                    isArtifactUpload(request.method, path) ? uploadLimit : MAX_BODY_BYTES,
                );
                if (problem) return framingResponse(problem);
                const auth = authPath(path);
                if (
                    request.method === "POST" &&
                    auth !== null &&
                    auth.includes("request-password-reset")
                ) {
                    const email = await emailOf(request);
                    if (!(await allowResetRequest(db, email))) {
                        return Response.json(
                            { code: "too-many-requests", status: 429, title: "Too Many Requests" },
                            { status: 429, headers: { "retry-after": "3600" } },
                        );
                    }
                }
                if (request.method === "POST" && auth !== null && auth.includes("sign-in/email")) {
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
                const caller = await callerOf(request);
                if (!caller) {
                    set.status = 401;
                    return { code: "unauthenticated", status: 401, title: "Unauthorized" };
                }
                if (caller.key) {
                    // A key learns about itself from /v1/key, not about its creator.
                    set.status = 403;
                    return {
                        code: "forbidden",
                        status: 403,
                        title: "API keys cannot use this endpoint.",
                    };
                }
                const user = await db
                    .selectFrom("user")
                    .select(["id", "email", "name", "role"])
                    .where("id", "=", caller.principal.userId)
                    .executeTakeFirstOrThrow();
                return user;
            })
            .get("/v1/key", { detail: docs.keyInfo }, async ({ request, set }) => {
                const caller = await callerOf(request);
                if (!caller) {
                    set.status = 401;
                    return { code: "unauthenticated", status: 401, title: "Unauthorized" };
                }
                if (!caller.key) {
                    set.status = 403;
                    return { code: "forbidden", status: 403, title: "Not an API key request." };
                }
                const {
                    keyId: id,
                    name,
                    organizationId,
                    scopes,
                    projectIds,
                    expiresAt,
                } = caller.key;
                return { id, name, organizationId, scopes, projectIds, expiresAt };
            })
            .get("/v1/organizations", { detail: docs.listOrganizations }, ({ request, set }) =>
                respond(request, set, { scope: "organization:read" }, async (p, key) => {
                    const all = await listMyOrganizations(db, p);
                    return key ? all.filter((o) => o.id === key.organizationId) : all;
                }),
            )
            .post(
                "/v1/organizations",
                { detail: docs.createOrganization },
                async ({ request, set }) => {
                    const input = await body(request);
                    return respond(
                        request,
                        set,
                        null,
                        (p) => createOrganization(db, p, input),
                        201,
                    );
                },
            )
            .get(
                "/v1/organizations/:orgId",
                { detail: docs.getOrganization },
                ({ request, set, params }) =>
                    respond(
                        request,
                        set,
                        { organizationId: params.orgId, scope: "organization:read" },
                        (p) => getOrganization(db, p, params.orgId),
                    ),
            )
            .get(
                "/v1/organizations/:orgId/members",
                { detail: docs.listMembers },
                ({ request, set, params }) =>
                    respond(
                        request,
                        set,
                        { organizationId: params.orgId, scope: "member:read" },
                        (p) => listMembers(db, p, params.orgId),
                    ),
            )
            .post(
                "/v1/organizations/:orgId/members",
                { detail: docs.addMember },
                async ({ request, set, params }) => {
                    const input = await body(request);
                    return respond(
                        request,
                        set,
                        null,
                        (p) => addMember(db, p, params.orgId, input),
                        201,
                    );
                },
            )
            .delete(
                "/v1/organizations/:orgId/members/:userId",
                { detail: docs.removeMember },
                ({ request, set, params }) =>
                    respond(request, set, null, (p) =>
                        removeMember(db, p, params.orgId, params.userId),
                    ),
            )
            .get(
                "/v1/organizations/:orgId/invitations",
                { detail: docs.listInvitations },
                ({ request, set, params }) =>
                    respond(request, set, null, (p) => listInvitations(db, p, params.orgId)),
            )
            .post(
                "/v1/organizations/:orgId/invitations",
                { detail: docs.createInvitation },
                async ({ request, set, params }) => {
                    const input = await body(request);
                    return respond(
                        request,
                        set,
                        null,
                        (p) => createInvitation(db, p, params.orgId, input, invitations),
                        201,
                    );
                },
            )
            .delete(
                "/v1/organizations/:orgId/invitations/:invitationId",
                { detail: docs.revokeInvitation },
                ({ request, set, params }) =>
                    respond(request, set, null, (p) =>
                        revokeInvitation(db, p, params.orgId, params.invitationId),
                    ),
            )
            .post(
                "/v1/invitations/preview",
                { detail: docs.previewInvitation },
                async ({ request, set }) => {
                    const input = (await body(request)) as { token?: unknown } | undefined;
                    const token = typeof input?.token === "string" ? input.token : "";
                    return respondPublic(request, set, () =>
                        previewInvitation(db, token, invitations),
                    );
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
                    respond(
                        request,
                        set,
                        { organizationId: params.orgId, scope: "project:read" },
                        (p, key) => listProjects(db, p, params.orgId, key?.projectIds),
                    ),
            )
            .post(
                "/v1/organizations/:orgId/projects",
                { detail: docs.createProject },
                async ({ request, set, params }) => {
                    const input = await body(request);
                    return respond(
                        request,
                        set,
                        { organizationId: params.orgId, scope: "project:create" },
                        (p, key) => {
                            // A project-limited key cannot widen its own reach by creating one.
                            if (key?.projectIds) {
                                throw new ServiceError(
                                    "forbidden",
                                    "A project-limited API key cannot create projects.",
                                );
                            }
                            return createProject(db, p, params.orgId, input);
                        },
                        201,
                    );
                },
            )
            .get(
                "/v1/organizations/:orgId/api-keys",
                { detail: docs.listApiKeys },
                ({ request, set, params }) =>
                    respond(request, set, null, (p) => listApiKeys(db, p, params.orgId)),
            )
            .post(
                "/v1/organizations/:orgId/api-keys",
                { detail: docs.createApiKey },
                async ({ request, set, params }) => {
                    const input = await body(request);
                    return respond(
                        request,
                        set,
                        null,
                        (p, _key, sessionId) =>
                            createApiKey(db, p, params.orgId, input, sessionId ?? ""),
                        201,
                        { fresh: true },
                    );
                },
            )
            .delete(
                "/v1/organizations/:orgId/api-keys/:keyId",
                { detail: docs.revokeApiKey },
                ({ request, set, params }) =>
                    respond(request, set, null, (p) =>
                        revokeApiKey(db, p, params.orgId, params.keyId),
                    ),
            )
            .post(
                "/v1/organizations/:orgId/projects/:projectId/artifacts",
                { detail: docs.uploadArtifact },
                ({ request, set, params }) =>
                    respond(
                        request,
                        set,
                        { organizationId: params.orgId, scope: "app:deploy" },
                        async (p, key) => {
                            // A project-limited key reaches only its own projects, even to upload.
                            if (key) {
                                requireKeyAccess(key, params.orgId, "app:deploy", params.projectId);
                            }
                            const type = (request.headers.get("content-type") ?? "")
                                .split(";")[0]!
                                .trim()
                                .toLowerCase();
                            if (
                                ![
                                    "application/gzip",
                                    "application/x-gzip",
                                    "application/octet-stream",
                                ].includes(type)
                            ) {
                                throw new ServiceError(
                                    "invalid",
                                    "Send the archive as application/gzip.",
                                );
                            }
                            // An archive is only for a deployment and counts toward the
                            // organization's ceiling: none are taken while deployments are off.
                            // (The switch answers before the project is looked up, unlike createApp.)
                            requireDeploymentsOn(deployments.settings);
                            const length = request.headers.get("content-length");
                            return uploadArtifact(
                                db,
                                p,
                                params.orgId,
                                request.body,
                                {
                                    contentLength: length === null ? null : Number(length),
                                    projectId: params.projectId,
                                    restrictTo: key?.projectIds,
                                },
                                artifacts,
                                request.signal,
                            );
                        },
                        201,
                    ),
            )
            .post(
                "/v1/organizations/:orgId/projects/:projectId/apps",
                { detail: docs.createApp },
                async ({ request, set, params }) => {
                    const input = await body(request);
                    return respond(
                        request,
                        set,
                        { organizationId: params.orgId, scope: "app:deploy" },
                        (p, key) =>
                            createApp(
                                db,
                                p,
                                params.orgId,
                                params.projectId,
                                input,
                                deployments,
                                key?.projectIds,
                            ),
                        201,
                    );
                },
            )
            .get(
                "/v1/organizations/:orgId/apps",
                { detail: docs.listApps },
                ({ request, set, params }) =>
                    respond(
                        request,
                        set,
                        { organizationId: params.orgId, scope: "app:read" },
                        (p, key) => listApps(db, p, params.orgId, key?.projectIds),
                    ),
            )
            .get(
                "/v1/organizations/:orgId/apps/:appId",
                { detail: docs.getApp },
                ({ request, set, params }) =>
                    respond(
                        request,
                        set,
                        { organizationId: params.orgId, scope: "app:read" },
                        (p, key) => getApp(db, p, params.orgId, params.appId, key?.projectIds),
                    ),
            )
            .post(
                "/v1/organizations/:orgId/apps/:appId/aliases",
                { detail: docs.createAlias },
                async ({ request, set, params }) => {
                    const input = await body(request);
                    return respond(
                        request,
                        set,
                        { organizationId: params.orgId, scope: "app:alias:manage" },
                        (p, key) =>
                            createAlias(
                                db,
                                p,
                                params.orgId,
                                params.appId,
                                input,
                                aliasDeps,
                                key?.projectIds,
                            ),
                        201,
                    );
                },
            )
            .get(
                "/v1/organizations/:orgId/apps/:appId/aliases",
                { detail: docs.listAliases },
                ({ request, set, params }) =>
                    respond(
                        request,
                        set,
                        { organizationId: params.orgId, scope: "app:read" },
                        (p, key) => listAliases(db, p, params.orgId, params.appId, key?.projectIds),
                    ),
            )
            .get(
                "/v1/organizations/:orgId/aliases/:aliasId",
                { detail: docs.getAlias },
                ({ request, set, params }) =>
                    respond(
                        request,
                        set,
                        { organizationId: params.orgId, scope: "app:read" },
                        (p, key) => getAlias(db, p, params.orgId, params.aliasId, key?.projectIds),
                    ),
            )
            .post(
                "/v1/organizations/:orgId/apps/:appId/deployments",
                { detail: docs.createDeployment },
                async ({ request, set, params }) => {
                    const input = await body(request);
                    return respond(
                        request,
                        set,
                        { organizationId: params.orgId, scope: "app:deploy" },
                        (p, key) =>
                            createDeployment(
                                db,
                                p,
                                params.orgId,
                                params.appId,
                                input,
                                deployments,
                                key?.projectIds,
                            ),
                        202,
                    );
                },
            )
            .get(
                "/v1/organizations/:orgId/apps/:appId/deployments",
                { detail: docs.listDeployments },
                ({ request, set, params }) =>
                    respond(
                        request,
                        set,
                        { organizationId: params.orgId, scope: "app:read" },
                        (p, key) =>
                            listDeployments(db, p, params.orgId, params.appId, key?.projectIds),
                    ),
            )
            .get(
                "/v1/organizations/:orgId/deployments/:deploymentId",
                { detail: docs.getDeployment },
                ({ request, set, params }) =>
                    respond(
                        request,
                        set,
                        { organizationId: params.orgId, scope: "app:read" },
                        (p, key) =>
                            getDeployment(
                                db,
                                p,
                                params.orgId,
                                params.deploymentId,
                                key?.projectIds,
                            ),
                    ),
            )
            .delete(
                "/v1/organizations/:orgId/deployments/:deploymentId",
                { detail: docs.deleteDeployment },
                ({ request, set, params }) =>
                    respond(
                        request,
                        set,
                        { organizationId: params.orgId, scope: "app:delete" },
                        (p, key) =>
                            requestDeploymentDeletion(
                                db,
                                p,
                                params.orgId,
                                params.deploymentId,
                                deployments,
                                key?.projectIds,
                            ),
                        202,
                    ),
            )
            .get(
                "/v1/organizations/:orgId/deployments/:deploymentId/events",
                { detail: docs.listDeploymentEvents },
                ({ request, set, params, query }) =>
                    respond(
                        request,
                        set,
                        { organizationId: params.orgId, scope: "app:read" },
                        async (p, key) => {
                            const number = (value: unknown, name: string) => {
                                if (value === undefined) return undefined;
                                if (
                                    typeof value !== "string" ||
                                    !/^\d{1,10}$/.test(value) ||
                                    Number(value) > 2_147_483_647
                                ) {
                                    throw new ServiceError(
                                        "invalid",
                                        `${name} must be an integer from 0 to 2147483647.`,
                                    );
                                }
                                return Number(value);
                            };
                            const limit = number(query.limit, "limit");
                            if (limit !== undefined && (limit < 1 || limit > 500)) {
                                throw new ServiceError("invalid", "limit must be 1 to 500.");
                            }
                            const events = await listDeploymentEvents(
                                db,
                                p,
                                params.orgId,
                                params.deploymentId,
                                {
                                    afterSeq: number(query.after, "after"),
                                    limit,
                                },
                                key?.projectIds,
                            );
                            return events.map((event) => ({ ...event, seq: String(event.seq) }));
                        },
                    ),
            )
            .get("/v1/status", { detail: docs.getStatus }, ({ request, set }) =>
                respond(request, set, null, (p) => getStatus(db, p)),
            )

            .use(openApiPlugin(withDocs))
    );
}

export type Api = ReturnType<typeof createApi>;
