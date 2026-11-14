import { z } from "zod";

// The versioned shapes of the controller's public HTTP API: roles, key scopes, input
// schemas a client may build and every response. Zod only, no Node, database or
// framework imports, so the SDK can use it in a browser. The controller documents and
// tests against these same schemas, so the documentation cannot drift from behaviour.

export const ORGANIZATION_ROLES = ["owner", "admin", "deployer", "viewer"] as const;
export type OrganizationRoleName = (typeof ORGANIZATION_ROLES)[number];

// What an API key may be granted. Deliberately excludes managing members, keys and
// the organization itself: a key can never mint or widen credentials.
export const API_KEY_SCOPES = [
    "organization:read",
    "member:read",
    "project:read",
    "project:create",
    "project:delete",
] as const;
export type ApiKeyScopeName = (typeof API_KEY_SCOPES)[number];

export const MAX_KEY_LIFETIME_DAYS = 365;

export const slugSchema = z
    .string()
    .regex(/^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/, "use lowercase letters, digits and hyphens");
// No control or formatting characters (including bidi overrides) in display names.
export const nameSchema = z
    .string()
    .trim()
    .min(1)
    .max(80)
    .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), "contains control characters");

export const createProjectSchema = z.object({ name: nameSchema, slug: slugSchema });

export const createApiKeySchema = z
    .object({
        name: nameSchema,
        scopes: z.array(z.enum(API_KEY_SCOPES)).min(1).max(API_KEY_SCOPES.length),
        projectIds: z.array(z.uuid()).min(1).max(50).optional().meta({
            description:
                "Restrict this key to these projects. Cannot be combined with project:create.",
        }),
        expiresInDays: z.number().int().min(1).max(MAX_KEY_LIFETIME_DAYS),
    })
    .refine((input) => !input.projectIds || !input.scopes.includes("project:create"), {
        path: ["scopes"],
        message: "A project-limited API key cannot create projects.",
    });

export const createPreviewSchema = z.object({ slug: slugSchema });
export const previewStateSchema = z.enum(["active", "deleting", "deleted"]);

const role = z.enum(ORGANIZATION_ROLES);
const timestamp = z.string().meta({ format: "date-time" });

export const errorSchema = z.strictObject({
    code: z.enum([
        "unauthenticated",
        "forbidden-origin",
        "too-many-requests",
        "client-address-unavailable",
        "not-found",
        "forbidden",
        "conflict",
        "invalid",
        "delivery-failed",
        "internal",
    ]),
    status: z.number().int(),
    title: z.string(),
});

export const meSchema = z.strictObject({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    role: z
        .enum(["user", "operator"])
        .meta({ description: "Instance role; grants no organization access." }),
});

export const organizationSummarySchema = z.strictObject({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    role: role.meta({ description: "The caller's role in the organization." }),
});

export const createdOrganizationSchema = z.strictObject({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
});

export const memberSchema = z.strictObject({
    userId: z.string(),
    email: z.string(),
    name: z.string(),
    role,
});

export const addedMemberSchema = z.strictObject({ userId: z.string(), role });

export const projectSchema = z.strictObject({
    id: z.uuid(),
    slug: z.string(),
    name: z.string(),
    createdAt: timestamp,
});

export const createdProjectSchema = z.strictObject({
    id: z.uuid(),
    slug: z.string(),
    name: z.string(),
});

export const previewSchema = z.strictObject({
    id: z.uuid(),
    projectId: z.uuid(),
    slug: z.string(),
    hostname: z.string(),
    state: previewStateSchema,
    activeDeploymentId: z.uuid().nullable(),
    createdAt: timestamp,
});

export const invitationSchema = z.strictObject({
    id: z.uuid(),
    email: z.string(),
    role,
    createdAt: timestamp,
    expiresAt: timestamp,
});

export const createdInvitationSchema = z.strictObject({ id: z.uuid(), email: z.string(), role });

export const invitationPreviewSchema = z.strictObject({
    email: z.string(),
    role,
    organizationName: z.string(),
    accountExists: z.boolean(),
});

export const invitationTokenSchema = z.strictObject({ token: z.string().min(20).max(200) });

export const acceptedInvitationSchema = z.strictObject({
    organizationId: z.string(),
    userId: z.string(),
    createdAccount: z.boolean(),
});

const apiKeyScope = z.enum(API_KEY_SCOPES);

export const createdApiKeySchema = z.strictObject({
    id: z.uuid(),
    name: z.string(),
    secret: z.string().meta({ description: "Shown once; it cannot be retrieved later." }),
    scopes: z.array(apiKeyScope),
    projectIds: z.array(z.uuid()).nullable(),
    expiresAt: timestamp,
});

export const apiKeyStatusSchema = z.enum(["active", "expired", "revoked", "inactive"]);
export type ApiKeyStatus = z.infer<typeof apiKeyStatusSchema>;

export const apiKeySummarySchema = z.strictObject({
    id: z.uuid(),
    name: z.string(),
    prefix: z.string(),
    scopes: z.array(apiKeyScope),
    projectIds: z.array(z.uuid()).nullable(),
    createdBy: z.string(),
    createdAt: timestamp,
    expiresAt: timestamp,
    revokedAt: timestamp.nullable(),
    lastUsedAt: timestamp.nullable(),
    status: apiKeyStatusSchema.meta({
        description:
            "Revoked takes precedence over expired, then inactive (creator's original membership removed). Active describes credential lifecycle, not permission to perform every granted action.",
    }),
});

export const keyInfoSchema = z.strictObject({
    id: z.uuid(),
    name: z.string(),
    organizationId: z.string(),
    scopes: z.array(apiKeyScope),
    projectIds: z.array(z.uuid()).nullable(),
    expiresAt: timestamp,
});

export const okSchema = z.strictObject({ ok: z.literal(true) });
