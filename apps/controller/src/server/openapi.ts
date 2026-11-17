import { openapi } from "@elysia/openapi";
import type { DocumentDecoration } from "elysia/types";
import {
    acceptedInvitationSchema,
    acceptInvitationSchema,
    addedMemberSchema,
    addMemberSchema,
    apiKeySummarySchema,
    artifactSchema,
    createApiKeySchema,
    createdApiKeySchema,
    keyInfoSchema,
    createdInvitationSchema,
    createdOrganizationSchema,
    createdProjectSchema,
    createInvitationSchema,
    createOrganizationSchema,
    createPreviewSchema,
    extendPreviewSchema,
    requestedDeletionSchema,
    deletionSchema,
    statusSchema,
    resolveDeletionSchema,
    createProjectSchema,
    errorSchema,
    invitationPreviewSchema,
    invitationSchema,
    invitationTokenSchema,
    memberSchema,
    meSchema,
    okSchema,
    organizationSummarySchema,
    projectSchema,
    previewSchema,
    previewListSchema,
    createDeploymentSchema,
    createdDeploymentSchema,
    resolveDeploymentSchema,
    deploymentSchema,
    deploymentListSchema,
    deploymentEventsSchema,
} from "@launchpad/services";
import { z } from "zod";

const schema = (value: z.ZodType, io: "input" | "output" = "output") =>
    z.toJSONSchema(value, { io, target: "openapi-3.0", unrepresentable: "any" }) as Record<
        string,
        unknown
    >;
const content = (value: z.ZodType, io: "input" | "output" = "output") => ({
    "application/json": { schema: schema(value, io) },
});

const ERRORS = {
    401: "Not signed in.",
    403: "The caller's role or origin does not allow this.",
    404: "The resource does not exist, or the caller is not a member of its organization.",
    408: "The upload did not finish in time.",
    409: "The change conflicts with existing data.",
    413: "The upload is larger than the allowed size.",
    422: "The request body is invalid.",
} as const;

interface Operation {
    tags: string[];
    summary: string;
    description?: string;
    public?: boolean;
    keys?: boolean;
    keyOnly?: boolean;
    path?: string[];
    query?: { name: string; description: string }[];
    idempotent?: boolean;
    body?: z.ZodType;
    rawBody?: { contentType: string; description: string };
    ok: { status?: number; description: string; schema?: z.ZodType };
    errors?: (keyof typeof ERRORS | 502)[];
}

// Builds the `detail` of one route from the same zod schemas the services validate
// with. Request bodies are documented, not validated here: services stay the one
// place that validates.
export function operation(op: Operation): DocumentDecoration {
    const responses: Record<string, unknown> = {
        [String(op.ok.status ?? 200)]: {
            description: op.ok.description,
            ...(op.ok.schema ? { content: content(op.ok.schema) } : {}),
        },
    };
    for (const status of op.errors ?? []) {
        responses[String(status)] = {
            description: status === 502 ? "The email could not be delivered." : ERRORS[status],
            content: content(errorSchema),
        };
    }
    return {
        tags: op.tags,
        summary: op.summary,
        ...(op.description ? { description: op.description } : {}),
        parameters: [
            ...(op.path ?? []).map((name) => ({
                name,
                in: "path" as const,
                required: true,
                schema: { type: "string" },
            })),
            ...(op.query ?? []).map((q) => ({
                name: q.name,
                in: "query" as const,
                required: false,
                description: q.description,
                schema: { type: "string" },
            })),
            ...(op.idempotent
                ? [
                      {
                          name: "Idempotency-Key",
                          in: "header" as const,
                          required: false,
                          description:
                              "Up to 128 characters. A repeated request with the same key does not apply the mutation again; the same key with a different request is a conflict. Kept for 24 hours.",
                          schema: { type: "string" },
                      },
                  ]
                : []),
        ] as DocumentDecoration["parameters"],
        ...(op.rawBody
            ? {
                  requestBody: {
                      required: true,
                      description: op.rawBody.description,
                      content: {
                          [op.rawBody.contentType]: {
                              schema: { type: "string", format: "binary" },
                          },
                      },
                  },
              }
            : {}),
        ...(op.body ? { requestBody: { required: true, content: content(op.body, "input") } } : {}),
        responses: responses as DocumentDecoration["responses"],
        security: op.public
            ? []
            : op.keyOnly
              ? [{ bearerKey: [] }]
              : op.keys
                ? [{ sessionCookie: [] }, { bearerKey: [] }]
                : [{ sessionCookie: [] }],
    };
}

// Must match the versioned copy made in vite.config.ts.
// The version is injected at build time; unit tests have no built asset.
declare const __SCALAR_VERSION__: string | undefined;
export const SCALAR_BUNDLE_PATH = `/_scalar/${
    typeof __SCALAR_VERSION__ === "string" ? __SCALAR_VERSION__ : "dev"
}/standalone.js`;

// Scalar's script is served from this origin (see vite.config.ts), pinned by the
// lockfile: no third-party JavaScript ever runs on the controller's origin.
export function openApiPlugin(enabled: boolean) {
    return openapi({
        enabled,
        path: "/openapi",
        specPath: "/openapi/json",
        provider: "scalar",
        scalar: { cdn: SCALAR_BUNDLE_PATH, withDefaultFonts: false },
        documentation: {
            info: {
                title: "Launchpad API",
                version: "0.0.0",
                description:
                    "Launchpad controller API. Requests are authenticated by the browser session " +
                    "cookie; mutating requests from a browser must come from the controller's own " +
                    "origin. Sign-in, sign-out and password reset are Better Auth endpoints under " +
                    "`/api/auth` and are not documented here. Automation clients send an " +
                    "organization API key as `Authorization: Bearer <key>`; operations marked with " +
                    "the bearer scheme accept one, limited to the key's organization, scopes and " +
                    "projects. Keys cannot manage keys, members, invitations or organizations.",
            },
            tags: [
                { name: "Session", description: "The signed-in user." },
                { name: "Organizations", description: "Organizations and membership." },
                { name: "Projects", description: "Organization-owned projects." },
                { name: "Artifacts", description: "Uploaded static-site archives." },
                { name: "Previews", description: "Previews and their deployments." },
                { name: "API keys", description: "Organization-owned automation keys." },
                { name: "Operations", description: "Instance health, for the operator." },
                {
                    name: "Invitations",
                    description: "Email invitations (invitation enrollment only).",
                },
            ],
            components: {
                securitySchemes: {
                    sessionCookie: {
                        type: "apiKey",
                        in: "cookie",
                        name: "better-auth.session_token",
                        description:
                            "Set by sign-in. Over HTTPS the cookie name carries a `__Secure-` prefix.",
                    },
                    bearerKey: {
                        type: "http",
                        scheme: "bearer",
                        description: "An organization API key (`lp_…`).",
                    },
                },
            },
        },
    });
}

export const docs = {
    me: operation({
        tags: ["Session"],
        summary: "Current user",
        description: "Session only; an API key gets 403 and reads /v1/key instead.",
        ok: { description: "The signed-in user.", schema: meSchema },
        errors: [401, 403],
    }),
    listOrganizations: operation({
        keys: true,
        tags: ["Organizations"],
        summary: "List the caller's organizations",
        ok: {
            description: "Organizations the caller belongs to.",
            schema: z.array(organizationSummarySchema),
        },
        errors: [401, 403],
    }),
    createOrganization: operation({
        tags: ["Organizations"],
        summary: "Create an organization",
        description:
            "Only the instance operator. The owner must be an existing user; the operator gets no membership.",
        body: createOrganizationSchema,
        ok: { status: 201, description: "Created.", schema: createdOrganizationSchema },
        errors: [401, 403, 409, 422],
    }),
    getOrganization: operation({
        keys: true,
        tags: ["Organizations"],
        summary: "Get an organization",
        path: ["orgId"],
        ok: {
            description: "The organization and the caller's role.",
            schema: organizationSummarySchema,
        },
        errors: [401, 403, 404],
    }),
    listMembers: operation({
        keys: true,
        tags: ["Organizations"],
        summary: "List members",
        path: ["orgId"],
        ok: { description: "Members.", schema: z.array(memberSchema) },
        errors: [401, 403, 404],
    }),
    addMember: operation({
        tags: ["Organizations"],
        summary: "Add an existing user as a member",
        description: "Needs member management. Admins may assign only deployer and viewer.",
        path: ["orgId"],
        body: addMemberSchema,
        ok: { status: 201, description: "Added.", schema: addedMemberSchema },
        errors: [401, 403, 404, 409, 422],
    }),
    removeMember: operation({
        tags: ["Organizations"],
        summary: "Remove a member, or leave",
        description: "A member may remove themselves. The last owner cannot be removed.",
        path: ["orgId", "userId"],
        ok: { description: "Removed.", schema: okSchema },
        errors: [401, 403, 404, 409],
    }),
    listProjects: operation({
        keys: true,
        tags: ["Projects"],
        summary: "List projects",
        path: ["orgId"],
        ok: { description: "Projects.", schema: z.array(projectSchema) },
        errors: [401, 403, 404],
    }),
    createProject: operation({
        keys: true,
        tags: ["Projects"],
        summary: "Create a project",
        description: "Needs deployer or higher.",
        path: ["orgId"],
        body: createProjectSchema,
        ok: { status: 201, description: "Created.", schema: createdProjectSchema },
        errors: [401, 403, 404, 409, 422],
    }),
    uploadArtifact: operation({
        keys: true,
        tags: ["Artifacts"],
        summary: "Upload a static-site archive",
        description:
            "Deployers and above; a key needs `preview:deploy` (a project-limited key may upload, since an archive belongs to no project until it is deployed). The body is the archive itself: `.tar.gz` of regular files and directories with `index.html` at its root, sent with a `Content-Length` and `Content-Type: application/gzip`. It is validated while streaming; links, devices, absolute or `..` paths, secrets (`.env*`, `.git`, private keys), duplicates and oversized archives are refused. An identical archive already stored for the organization is reused (`reused: true`).",
        path: ["orgId"],
        rawBody: { contentType: "application/gzip", description: "A gzip-compressed tar archive." },
        ok: { status: 201, description: "Stored (or reused).", schema: artifactSchema },
        errors: [401, 403, 404, 408, 409, 413, 422],
    }),
    listPreviews: operation({
        keys: true,
        tags: ["Previews"],
        summary: "List previews",
        description:
            "Newest last, in pages. A project-limited key sees only its own projects' previews.",
        path: ["orgId"],
        query: [
            { name: "projectId", description: "Only this project's previews." },
            { name: "cursor", description: "The `nextCursor` of the previous page." },
        ],
        ok: { description: "A page of previews.", schema: previewListSchema },
        errors: [401, 403, 404, 422],
    }),
    createPreview: operation({
        keys: true,
        tags: ["Previews"],
        summary: "Create a preview",
        description:
            "Needs deployer or higher. Creates the record and its generated hostname only; nothing is deployed. Needs deployments to be enabled.",
        path: ["orgId", "projectId"],
        idempotent: true,
        body: createPreviewSchema,
        ok: { status: 201, description: "Created.", schema: previewSchema },
        errors: [401, 403, 404, 409, 422],
    }),
    getPreview: operation({
        keys: true,
        tags: ["Previews"],
        summary: "Get a preview",
        path: ["orgId", "previewId"],
        ok: { description: "The preview and its active deployment.", schema: previewSchema },
        errors: [401, 403, 404],
    }),
    extendPreview: operation({
        keys: true,
        tags: ["Previews"],
        summary: "Extend a preview's lifetime",
        description:
            "Needs deployer or higher and preview:deploy for keys. Never shortens an expiry; capped at the instance maximum from now. Extending a never-expiring preview with a duration gives it an expiry; `none` removes the expiry where the instance allows it. A deleted preview is 404. Replaying an idempotency key does not extend again and returns the current preview, which may differ from the original response. A deleting preview cannot be extended.",
        path: ["orgId", "previewId"],
        idempotent: true,
        body: extendPreviewSchema,
        ok: { description: "The preview with its resulting expiry.", schema: previewSchema },
        errors: [401, 403, 404, 409, 422],
    }),
    deletePreview: operation({
        keys: true,
        tags: ["Previews"],
        summary: "Queue a preview's deletion",
        description:
            "Needs deployer or higher, preview:delete for keys, and deployments and lifecycle enabled in the controller and worker (409 otherwise, for a new deletion). Returns at once; poll the deletion operation. Repeating DELETE while deleting returns the same operation; once deleted it returns 404. No idempotency key is needed. Cannot be undone.",
        path: ["orgId", "previewId"],
        ok: { status: 202, description: "Deletion queued.", schema: requestedDeletionSchema },
        errors: [401, 403, 404, 409],
    }),
    getStatus: operation({
        tags: ["Operations"],
        summary: "How the instance is doing",
        description:
            "Needs the instance operator and a session (an API key cannot do this). Database and data-directory readiness, the controller's settings, each worker's age and lifecycle setting, the work waiting (deployments, overdue expiries, deletions), stored artifacts, and warnings in plain words. Counts and ages, and the workers' ids and versions; no preview ids or names.",
        ok: { description: "The status.", schema: statusSchema },
        errors: [401, 403],
    }),
    getPreviewDeletion: operation({
        keys: true,
        tags: ["Previews"],
        summary: "Get a preview's deletion",
        description:
            "The latest deletion of the preview, whoever started it (a person or expiry). Needs preview:read for keys and access to the project. 404 if the preview has none. Use it to follow a deletion or find the operation an administrator must resolve.",
        path: ["orgId", "previewId"],
        ok: { description: "Deletion status.", schema: deletionSchema },
        errors: [401, 403, 404],
    }),
    getDeletion: operation({
        keys: true,
        tags: ["Previews"],
        summary: "Get a deletion operation",
        description:
            "Needs preview:read for keys and access to the owning project. Only fixed failure text is returned. A held operation needs administrator reconciliation.",
        path: ["orgId", "operationId"],
        ok: { description: "Deletion status.", schema: deletionSchema },
        errors: [401, 403, 404],
    }),
    resolveDeletion: operation({
        tags: ["Previews"],
        summary: "Resolve a held deletion",
        description:
            "Needs admin or owner with a fresh session, never an API key. After checking the host, choose retry or deleted. Choosing deleted trusts the administrator and removes no images. Retry queues another attempt; the worker must have lifecycle enabled to run it.",
        path: ["orgId", "operationId"],
        body: resolveDeletionSchema,
        ok: { description: "Resolved.", schema: okSchema },
        errors: [401, 403, 404, 409, 422],
    }),
    createDeployment: operation({
        keys: true,
        tags: ["Previews"],
        summary: "Deploy an uploaded archive to a preview",
        description:
            "Needs deployer or higher and deployments to be enabled. Queues the deployment and returns at once; poll the deployment for progress. A preview takes one deployment at a time: a second while one is unfinished (or awaiting an administrator's reconciliation) is a conflict.",
        path: ["orgId", "previewId"],
        idempotent: true,
        body: createDeploymentSchema,
        ok: { status: 202, description: "Queued.", schema: createdDeploymentSchema },
        errors: [401, 403, 404, 409, 422],
    }),
    listDeployments: operation({
        keys: true,
        tags: ["Previews"],
        summary: "List a preview's recent deployments",
        description: "The latest 20, newest first.",
        path: ["orgId", "previewId"],
        ok: { description: "Deployments.", schema: deploymentListSchema },
        errors: [401, 403, 404],
    }),
    getDeployment: operation({
        keys: true,
        tags: ["Previews"],
        summary: "Get a deployment",
        description:
            "Failure text is fixed and safe to show; remote output is never included. `reconciliation-needed` means an administrator must check the host before the preview can be deployed again.",
        path: ["orgId", "deploymentId"],
        ok: { description: "The deployment's status.", schema: deploymentSchema },
        errors: [401, 403, 404],
    }),
    resolveDeployment: operation({
        tags: ["Previews"],
        summary: "Resolve a deployment that needs an administrator",
        description:
            "Needs admin or owner and a session (an API key cannot do this). Only for a deployment in `reconciliation-needed`: record whether the host was found serving the new release (`succeeded`) or the previous one (`failed`), after checking the host. This frees the preview for new deployments.",
        path: ["orgId", "deploymentId"],
        body: resolveDeploymentSchema,
        ok: { description: "Resolved.", schema: okSchema },
        errors: [401, 403, 404, 409, 422],
    }),
    listDeploymentEvents: operation({
        keys: true,
        tags: ["Previews"],
        summary: "A deployment's progress events",
        description: "In order; pass the last `seq` seen as `after` to continue.",
        path: ["orgId", "deploymentId"],
        query: [{ name: "after", description: "Only events after this sequence number." }],
        ok: { description: "Events.", schema: deploymentEventsSchema },
        errors: [401, 403, 404],
    }),
    keyInfo: operation({
        keyOnly: true,
        tags: ["Session"],
        summary: "Current API key",
        description: "Only for a request authenticated with an API key.",
        ok: {
            description: "The key's organization, scopes and project limits.",
            schema: keyInfoSchema,
        },
        errors: [401, 403],
    }),
    createApiKey: operation({
        tags: ["API keys"],
        summary: "Issue an API key",
        description:
            "Needs admin or owner and a session created in the last 15 minutes (sign in again otherwise); a key cannot issue keys. The secret is returned once. Project restrictions cannot be combined with project:create.",
        path: ["orgId"],
        body: createApiKeySchema,
        ok: { status: 201, description: "Issued.", schema: createdApiKeySchema },
        errors: [401, 403, 404, 409, 422],
    }),
    listApiKeys: operation({
        tags: ["API keys"],
        summary: "List API keys",
        description:
            "Never includes secrets. Status is active, expired, revoked or inactive (creator's original membership removed). Revoked takes precedence over expired, then inactive. Active keys remain limited by their creator's current role.",
        path: ["orgId"],
        ok: {
            description: "Keys, including revoked and expired.",
            schema: z.array(apiKeySummarySchema),
        },
        errors: [401, 403, 404],
    }),
    revokeApiKey: operation({
        tags: ["API keys"],
        summary: "Revoke an API key",
        path: ["orgId", "keyId"],
        ok: { description: "Revoked (idempotent).", schema: okSchema },
        errors: [401, 403, 404],
    }),
    listInvitations: operation({
        tags: ["Invitations"],
        summary: "List pending invitations",
        path: ["orgId"],
        ok: { description: "Pending invitations.", schema: z.array(invitationSchema) },
        errors: [401, 403, 404],
    }),
    createInvitation: operation({
        tags: ["Invitations"],
        summary: "Invite someone by email",
        description:
            "Only with invitation enrollment and SMTP configured; otherwise 404. A newer invitation to the same address replaces the older one. Returns 502 and revokes the invitation if the email cannot be sent.",
        path: ["orgId"],
        body: createInvitationSchema,
        ok: { status: 201, description: "Created and emailed.", schema: createdInvitationSchema },
        errors: [401, 403, 404, 409, 422, 502],
    }),
    revokeInvitation: operation({
        tags: ["Invitations"],
        summary: "Revoke a pending invitation",
        path: ["orgId", "invitationId"],
        ok: { description: "Revoked.", schema: okSchema },
        errors: [401, 403, 404],
    }),
    previewInvitation: operation({
        tags: ["Invitations"],
        summary: "Preview an invitation",
        description:
            "Public: the 256-bit emailed token is the credential. The token travels in the body, never the URL.",
        public: true,
        body: invitationTokenSchema,
        ok: { description: "What the token holder may learn.", schema: invitationPreviewSchema },
        errors: [404],
    }),
    acceptInvitation: operation({
        tags: ["Invitations"],
        summary: "Accept an invitation",
        description:
            "Public for a new person (creates a verified account; name and password required). An existing account must be signed in as the invited address.",
        public: true,
        body: acceptInvitationSchema,
        ok: { description: "Accepted.", schema: acceptedInvitationSchema },
        errors: [403, 404, 409, 422],
    }),
};
