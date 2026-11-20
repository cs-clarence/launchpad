import { openapi } from "@elysia/openapi";
import type { DocumentDecoration } from "elysia/types";
import {
    acceptedInvitationSchema,
    appSchema,
    artifactSchema,
    createAppSchema,
    createDeploymentSchema,
    deploymentEventSchema,
    deploymentSchema,
    acceptInvitationSchema,
    addedMemberSchema,
    addMemberSchema,
    apiKeySummarySchema,
    createApiKeySchema,
    createdApiKeySchema,
    keyInfoSchema,
    createdInvitationSchema,
    createdOrganizationSchema,
    createdProjectSchema,
    createInvitationSchema,
    createOrganizationSchema,
    statusSchema,
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
} from "@launchpad-kit/services";
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
    503: "Deployments are turned off, or not available on this instance.",
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
                { name: "Apps", description: "Stable app identities inside a project." },
                {
                    name: "Deployments",
                    description: "Queued, immutable deployments of an uploaded archive.",
                },
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
    getStatus: operation({
        tags: ["Operations"],
        summary: "How the instance is doing",
        description:
            "Needs the instance operator and a session (an API key cannot do this). Database readiness and artifact count/byte totals from database rows only; archive files are not checked. This version emits no warnings (warnings is empty). Counts only: no names or ids. Workers, queues and deployments return with the app model.",
        ok: { description: "The status.", schema: statusSchema },
        errors: [401, 403],
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
    uploadArtifact: operation({
        keys: true,
        tags: ["Artifacts"],
        summary: "Upload a static-site archive for a project",
        description:
            "Deployers and above; a key needs `app:deploy` and, if project-limited, the project in its list. The body is the archive itself: `.tar.gz` of regular files and directories with `index.html` at its root, sent with a `Content-Length` and `Content-Type: application/gzip`. It is validated while streaming; links, devices, absolute or `..` paths, secrets (`.env*`, `.git`, private keys), duplicates and oversized archives are refused. An identical archive already stored for the organization is reused (`reused: true`). The upload records the project it came through: a project-limited key may deploy only archives uploaded through the app's own project. Needs deployments to be on.",
        path: ["orgId", "projectId"],
        rawBody: { contentType: "application/gzip", description: "A gzip-compressed tar archive." },
        ok: { status: 201, description: "Stored (or reused).", schema: artifactSchema },
        errors: [401, 403, 404, 408, 409, 413, 422, 503],
    }),
    createApp: operation({
        keys: true,
        tags: ["Apps"],
        summary: "Create an app",
        description:
            "Deployers and above; a key needs `app:deploy` and, if project-limited, the project. An app is a stable identity inside a project; it has no deployment and no alias yet. Refused at the organization's app limit. Needs deployments to be on.",
        path: ["orgId", "projectId"],
        body: createAppSchema,
        ok: { status: 201, description: "Created.", schema: appSchema },
        errors: [401, 403, 404, 409, 422, 503],
    }),
    listApps: operation({
        keys: true,
        tags: ["Apps"],
        summary: "List apps",
        description:
            "A key needs `app:read`; a project-limited key sees only its own projects' apps.",
        path: ["orgId"],
        ok: { description: "Apps, oldest first.", schema: z.array(appSchema) },
        errors: [401, 403, 404],
    }),
    getApp: operation({
        keys: true,
        tags: ["Apps"],
        summary: "Read an app",
        description: "A key needs `app:read`.",
        path: ["orgId", "appId"],
        ok: { description: "The app.", schema: appSchema },
        errors: [401, 403, 404],
    }),
    createDeployment: operation({
        keys: true,
        tags: ["Deployments"],
        summary: "Queue a deployment",
        description:
            "Deployers and above; a key needs `app:deploy`. Queues one deployment of an uploaded archive and returns at once with status `queued`. An enabled worker processes it asynchronously. Each deployment gets its own permanent hostname and remote name, and is never redeployed in place. An app has at most one unfinished deployment, and quotas apply per app and per organization. A project-limited key may use only an archive uploaded through the app's project. `ttl` (such as `7d`) sets the retention deadline, within the instance maximum. Needs deployments to be on.",
        path: ["orgId", "appId"],
        body: createDeploymentSchema,
        ok: { status: 202, description: "Queued.", schema: deploymentSchema },
        errors: [401, 403, 404, 409, 422, 503],
    }),
    listDeployments: operation({
        keys: true,
        tags: ["Deployments"],
        summary: "List an app's deployments",
        description: "A key needs `app:read`. Newest first.",
        path: ["orgId", "appId"],
        ok: { description: "Deployments.", schema: z.array(deploymentSchema) },
        errors: [401, 403, 404],
    }),
    getDeployment: operation({
        keys: true,
        tags: ["Deployments"],
        summary: "Read a deployment",
        description: "A key needs `app:read`.",
        path: ["orgId", "deploymentId"],
        ok: { description: "The deployment.", schema: deploymentSchema },
        errors: [401, 403, 404],
    }),
    listDeploymentEvents: operation({
        keys: true,
        tags: ["Deployments"],
        summary: "List a deployment's events",
        description:
            "A key needs `app:read`. Progress in order. Sequence numbers are decimal strings. Page with `after` (the last `seq` you saw) and `limit` (1 to 500, default 100).",
        path: ["orgId", "deploymentId"],
        query: [
            { name: "after", description: "Only events after this sequence number." },
            { name: "limit", description: "At most this many events (1 to 500)." },
        ],
        ok: { description: "Events.", schema: z.array(deploymentEventSchema) },
        errors: [401, 403, 404, 422],
    }),
};
