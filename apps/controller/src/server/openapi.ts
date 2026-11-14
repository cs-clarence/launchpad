import { openapi } from "@elysia/openapi";
import type { DocumentDecoration } from "elysia/types";
import {
    acceptedInvitationSchema,
    acceptInvitationSchema,
    addedMemberSchema,
    addMemberSchema,
    createdInvitationSchema,
    createdOrganizationSchema,
    createdProjectSchema,
    createInvitationSchema,
    createOrganizationSchema,
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
    409: "The change conflicts with existing data.",
    422: "The request body is invalid.",
} as const;

interface Operation {
    tags: string[];
    summary: string;
    description?: string;
    public?: boolean;
    path?: string[];
    body?: z.ZodType;
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
        parameters: (op.path ?? []).map((name) => ({
            name,
            in: "path",
            required: true,
            schema: { type: "string" },
        })),
        ...(op.body ? { requestBody: { required: true, content: content(op.body, "input") } } : {}),
        responses: responses as DocumentDecoration["responses"],
        security: op.public ? [] : [{ sessionCookie: [] }],
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
                    "`/api/auth` and are not documented here. API-key authentication arrives with " +
                    "the automation client.",
            },
            tags: [
                { name: "Session", description: "The signed-in user." },
                { name: "Organizations", description: "Organizations and membership." },
                { name: "Projects", description: "Organization-owned projects." },
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
                },
            },
        },
    });
}

export const docs = {
    me: operation({
        tags: ["Session"],
        summary: "Current user",
        ok: { description: "The signed-in user.", schema: meSchema },
        errors: [401],
    }),
    listOrganizations: operation({
        tags: ["Organizations"],
        summary: "List the caller's organizations",
        ok: {
            description: "Organizations the caller belongs to.",
            schema: z.array(organizationSummarySchema),
        },
        errors: [401],
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
        tags: ["Organizations"],
        summary: "Get an organization",
        path: ["orgId"],
        ok: {
            description: "The organization and the caller's role.",
            schema: organizationSummarySchema,
        },
        errors: [401, 404],
    }),
    listMembers: operation({
        tags: ["Organizations"],
        summary: "List members",
        path: ["orgId"],
        ok: { description: "Members.", schema: z.array(memberSchema) },
        errors: [401, 404],
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
        tags: ["Projects"],
        summary: "List projects",
        path: ["orgId"],
        ok: { description: "Projects.", schema: z.array(projectSchema) },
        errors: [401, 404],
    }),
    createProject: operation({
        tags: ["Projects"],
        summary: "Create a project",
        description: "Needs deployer or higher.",
        path: ["orgId"],
        body: createProjectSchema,
        ok: { status: 201, description: "Created.", schema: createdProjectSchema },
        errors: [401, 403, 404, 409, 422],
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
