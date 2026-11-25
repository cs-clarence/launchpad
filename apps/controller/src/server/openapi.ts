import { openapi } from "@elysia/openapi";
import type { DocumentDecoration } from "elysia/types";
import {
    acceptedInvitationSchema,
    appSchema,
    artifactSchema,
    aliasSchema,
    appShutdownSchema,
    createAliasSchema,
    createAppSchema,
    createDeploymentSchema,
    deploymentDeletionSchema,
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
    promoteAliasSchema,
    promotionOperationSchema,
    withdrawAliasSchema,
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
    422: "The request body, `limit` or `cursor` is invalid.",
    503: "Deployments or aliases are turned off, or not available on this instance.",
} as const;

const LINK_HEADER = {
    description:
        'Present when `limit` was sent and more items exist: a relative reference with `rel="next"` to request the next page. Follow it as given; do not build or parse cursors. Absent on the last page and on unpaginated calls.',
    schema: { type: "string" },
};

// Elysia replaces a route's documented parameters with the ones it derives from the route's
// schemas, so the query parameters are declared here and attached to a route as its `query`.
// Both accept anything: the services parse and reject bad values with the API's own 422.
export const pageQuery = z.object({
    limit: z
        .unknown()
        .meta({
            type: "integer",
            minimum: 1,
            maximum: 100,
            description:
                "Opt in to paging: at most this many items (1 to 100). Without it the whole list is returned, as an unpaginated call always did.",
        })
        .optional(),
    cursor: z
        .unknown()
        .meta({
            type: "string",
            description:
                "Opaque position from a previous `Link` header. Needs `limit`. Valid only for the same list and organization; otherwise 422.",
        })
        .optional(),
});

// Events page by `after` and `limit`; it needs the same replacement of derived parameters.
export const eventsQuery = z.object({
    after: z
        .unknown()
        .meta({
            type: "string",
            description: "Only events after this sequence number (a decimal integer).",
        })
        .optional(),
    limit: z
        .unknown()
        .meta({
            type: "integer",
            minimum: 1,
            maximum: 500,
            description:
                "At most this many events (1 to 500, default 100). A `Link` header is sent only when this is given and more events exist.",
        })
        .optional(),
});

interface Operation {
    tags: string[];
    summary: string;
    description?: string;
    public?: boolean;
    keys?: boolean;
    keyOnly?: boolean;
    path?: string[];
    query?: { name: string; description: string }[];
    // Opt-in `limit`/`cursor` paging with a `Link: rel="next"` response header.
    paginated?: boolean;
    // A `Link: rel="next"` header without `limit`/`cursor` paging (the events route pages by `after`).
    link?: boolean;
    idempotent?: boolean;
    // A required key with no expiry: the retry guard of a state-changing alias request.
    idempotencyRequired?: boolean;
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
            ...(op.paginated || op.link ? { headers: { Link: LINK_HEADER } } : {}),
            ...(op.ok.schema ? { content: content(op.ok.schema) } : {}),
        },
    };
    const errors: Operation["errors"] =
        op.paginated && !op.errors?.includes(422) ? [...(op.errors ?? []), 422] : op.errors;
    for (const status of errors ?? []) {
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
            ...(op.idempotencyRequired
                ? [
                      {
                          name: "Idempotency-Key",
                          in: "header" as const,
                          required: true,
                          description:
                              "1 to 128 printable characters, scoped to you and the alias. The same key with the same request returns the same operation; the same key with a different request is a conflict. A key is never forgotten.",
                          schema: { type: "string" },
                      },
                  ]
                : []),
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
                {
                    name: "Aliases",
                    description:
                        "Stable hostnames an app can point at a deployment (not routed yet).",
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
        paginated: true,
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
        paginated: true,
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
        paginated: true,
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
        paginated: true,
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
        paginated: true,
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
        paginated: true,
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
    createAlias: operation({
        keys: true,
        tags: ["Aliases"],
        summary: "Create an alias",
        description:
            "Deployers and above; a key needs `app:alias:manage` and, if project-limited, the app's project. An alias is a stable hostname of its own for an app, created unbound (it points at no deployment, and routes nowhere until the router lands). Its hostname is permanent and never reused. Refused at the per-app and per-organization alias limits. Needs deployments and aliases to be on. Routing a deployment to it comes later.",
        path: ["orgId", "appId"],
        body: createAliasSchema,
        ok: { status: 201, description: "Created.", schema: aliasSchema },
        errors: [401, 403, 404, 409, 422, 503],
    }),
    listAliases: operation({
        keys: true,
        tags: ["Aliases"],
        summary: "List an app's aliases",
        description:
            "A key needs `app:read`. Oldest first, including withdrawn aliases. Generations are decimal strings.",
        path: ["orgId", "appId"],
        paginated: true,
        ok: { description: "Aliases.", schema: z.array(aliasSchema) },
        errors: [401, 403, 404],
    }),
    getAlias: operation({
        keys: true,
        tags: ["Aliases"],
        summary: "Read an alias",
        description: "A key needs `app:read`.",
        path: ["orgId", "aliasId"],
        ok: { description: "The alias.", schema: aliasSchema },
        errors: [401, 403, 404],
    }),
    promoteAlias: operation({
        keys: true,
        tags: ["Aliases"],
        summary: "Point an alias at a deployment",
        description:
            "Deployers and above; a key needs `app:promote` and, if project-limited, the app's project. Requires an `Idempotency-Key`. `expectedGeneration` is the alias's `reservedGeneration` you last read; the request fails with 409 if it moved (compare-and-swap). The target must be a succeeded, undeleted deployment of the same app. Returns 202 at once with the operation; a worker sends the route to the router, reads it back, probes the hostname for that deployment, and only then commits (`GET .../operations` shows `status`). A lost reply leaves the operation `reconciliation-needed`: the alias is uncertain and refuses new requests until an operator reconciles it. Rolling back is another promotion to an older deployment. Needs deployments and aliases to be on.",
        path: ["orgId", "aliasId"],
        idempotencyRequired: true,
        body: promoteAliasSchema,
        ok: { status: 202, description: "Queued.", schema: promotionOperationSchema },
        errors: [401, 403, 404, 409, 422, 503],
    }),
    withdrawAlias: operation({
        keys: true,
        tags: ["Aliases"],
        summary: "Withdraw an alias",
        description:
            "Deployers and above; a key needs `app:alias:manage`. Requires an `Idempotency-Key` and a JSON body with `expectedGeneration`. Queues the withdrawal of the alias's route: afterwards its hostname answers a fixed 404. The hostname stays reserved permanently and cannot be bound again. Returns 202 with the operation. Needs deployments and aliases to be on.",
        path: ["orgId", "aliasId"],
        idempotencyRequired: true,
        body: withdrawAliasSchema,
        ok: { status: 202, description: "Queued.", schema: promotionOperationSchema },
        errors: [401, 403, 404, 409, 422, 503],
    }),
    listAliasOperations: operation({
        keys: true,
        tags: ["Aliases"],
        summary: "List an alias's operations",
        description:
            "A key needs `app:read`. Newest generation first: each promotion, withdrawal and correction, with its status. Generations are decimal strings.",
        path: ["orgId", "aliasId"],
        paginated: true,
        ok: { description: "Operations.", schema: z.array(promotionOperationSchema) },
        errors: [401, 403, 404],
    }),
    requestPromotionReconciliation: operation({
        tags: ["Aliases"],
        summary: "Request operator review of a held promotion operation",
        description:
            "Admin or owner session signed in within 15 minutes; no bearer keys. Records a request without updating routes, clearing pins or accepting evidence.",
        path: ["orgId", "operationId"],
        ok: { status: 202, description: "Request recorded.", schema: okSchema },
        errors: [401, 403, 404, 409, 422, 503],
    }),
    requestDeploymentReconciliation: operation({
        tags: ["Deployments"],
        summary: "Request operator review of a held deployment or deletion",
        description:
            "Admin or owner session signed in within 15 minutes; no bearer keys. Records a request without accepting any claim about Dokku or changing operation state.",
        path: ["orgId", "deploymentId"],
        ok: { status: 202, description: "Request recorded.", schema: okSchema },
        errors: [401, 403, 404, 409, 422, 503],
    }),
    shutdownApp: operation({
        keys: true,
        tags: ["Apps"],
        summary: "Shut down an app",
        description:
            "Admins and owners; a key needs all of `app:delete`, `app:alias:manage` and `app:promote`. Destructive and resumable: the app stops accepting deployments and promotions, every alias route is withdrawn and verified, and only then is each deployment deleted. Returns 202 with what was queued and what still blocks it (`blockedBy`); repeat the request to continue; once the app is deleted the same request answers 404, which is how a caller sees that it finished. Nothing is destroyed while a route is live or uncertain. Identity, hostnames and names stay reserved permanently. A deployment queued but never started is cancelled. Refused with 503 if a route still needs withdrawing while aliases are off. Needs deployments to be on.",
        path: ["orgId", "appId"],
        ok: { status: 202, description: "Accepted.", schema: appShutdownSchema },
        errors: [401, 403, 404, 409, 503],
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
        paginated: true,
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
    deleteDeployment: operation({
        keys: true,
        tags: ["Deployments"],
        summary: "Delete a deployment",
        description:
            "Deployers and above; a key needs `app:delete` and, when limited to projects, must include the deployment's project (otherwise 404). Queues the deletion of one finished deployment and returns at once. A worker destroys the deployment's own remote app and local image; reads then show `desiredState` `deleting`, then `deleted`. Its hostname and remote name stay reserved permanently. An unfinished, reconciliation-needed or already-deleting deployment is refused. Needs deployments to be on.",
        path: ["orgId", "deploymentId"],
        ok: { status: 202, description: "Queued.", schema: deploymentDeletionSchema },
        errors: [401, 403, 404, 409, 503],
    }),
    listDeploymentEvents: operation({
        keys: true,
        tags: ["Deployments"],
        summary: "List a deployment's events",
        description:
            'A key needs `app:read`. Progress in order. Sequence numbers are decimal strings. Page with `after` (the last `seq` you saw) and `limit` (1 to 500, default 100). When `limit` is given and more events exist, a relative `Link` header with `rel="next"` names the next `after`.',
        path: ["orgId", "deploymentId"],
        link: true,
        ok: { description: "Events.", schema: z.array(deploymentEventSchema) },
        errors: [401, 403, 404, 422],
    }),
};
