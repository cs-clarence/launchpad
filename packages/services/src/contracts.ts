import { z } from "zod";
import { ORGANIZATION_ROLES } from "./authorization";

// The shapes of the public HTTP API's responses. They are the single description
// used for the OpenAPI document, and integration tests parse real responses with
// them, so the documentation cannot drift from behaviour. Input schemas live next
// to the services that validate them and are re-exported here.
export { addMemberSchema, createOrganizationSchema } from "./organizations";
export { createProjectSchema } from "./projects";
export { acceptInvitationSchema, createInvitationSchema } from "./invitations";

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

export const okSchema = z.strictObject({ ok: z.literal(true) });
