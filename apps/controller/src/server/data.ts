import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { apiKeySummarySchema } from "@launchpad-kit/contracts";
import { keySessionFreshness } from "../lib/api-keys";

// Server functions read through the same authorized services as the HTTP API.
// Imports are dynamic so server-only code stays out of the client bundle.
async function principal() {
    const { getReadyRuntime } = await import("./runtime");
    const runtime = await getReadyRuntime();
    const { readSession } = await import("./auth-session");
    const session = await readSession(runtime.auth);
    if (!session) {
        throw new Error("unauthenticated");
    }
    const role = (session.user as { role?: string }).role;
    return {
        runtime,
        sessionCreatedAt: session.session.createdAt,
        who: {
            userId: session.user.id,
            instanceRole: role === "operator" ? ("operator" as const) : ("user" as const),
        },
    };
}

export const listOrganizationsFn = createServerFn({ method: "GET" }).handler(async () => {
    const { listMyOrganizations } = await import("@launchpad-kit/services");
    const { runtime, who } = await principal();
    return listMyOrganizations(runtime.db, who);
});

export const getOrganizationViewFn = createServerFn({ method: "GET" })
    .validator((input: unknown) => z.object({ orgId: z.string().min(1).max(64) }).parse(input))
    .handler(async ({ data }) => {
        const services = await import("@launchpad-kit/services");
        const { runtime, who, sessionCreatedAt } = await principal();
        const organization = await services.getOrganization(runtime.db, who, data.orgId);
        const projects = await services.listProjects(runtime.db, who, data.orgId);
        const members = await services.listMembers(runtime.db, who, data.orgId);
        const canManage = services.can(organization.role, "member:manage");
        const apiKeys = services.can(organization.role, "apikey:manage")
            ? (await services.listApiKeys(runtime.db, who, data.orgId)).map((key) =>
                  apiKeySummarySchema.parse({
                      id: key.id,
                      name: key.name,
                      prefix: key.prefix,
                      scopes: key.scopes,
                      projectIds: key.projectIds,
                      createdBy: key.createdBy,
                      createdAt: key.createdAt.toISOString(),
                      expiresAt: key.expiresAt.toISOString(),
                      revokedAt: key.revokedAt?.toISOString() ?? null,
                      lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
                      status: key.status,
                  }),
              )
            : null;
        const freshness = keySessionFreshness(new Date(sessionCreatedAt).getTime(), Date.now());
        const invitations =
            canManage && runtime.features.invitations
                ? (await services.listInvitations(runtime.db, who, data.orgId)).map((i) => ({
                      id: i.id,
                      email: i.email,
                      role: i.role,
                      expiresAt: i.expiresAt.toISOString(),
                  }))
                : null;
        return {
            apiKeys,
            keySessionFreshForMs: freshness.remainingMs,
            keySessionFresh: freshness.fresh,
            invitations,
            organization,
            projects: projects.map((p) => ({ ...p, createdAt: p.createdAt.toISOString() })),
            members,
            can: {
                createProject: services.can(organization.role, "project:create"),
                manageMembers: services.can(organization.role, "member:manage"),
            },
            you: who.userId,
        };
    });

// Safe to show before sign-in: whether optional email flows exist at all.
export const getFeaturesFn = createServerFn({ method: "GET" }).handler(async () => {
    const { getReadyRuntime } = await import("./runtime");
    return (await getReadyRuntime()).features;
});

// POST so the token travels in the body, never in a URL that could be logged.
export const getInvitationPreviewFn = createServerFn({ method: "POST" })
    .validator((input: unknown) => z.object({ token: z.string().max(200) }).parse(input))
    .handler(async ({ data }) => {
        const { previewInvitation } = await import("@launchpad-kit/services");
        const { getReadyRuntime } = await import("./runtime");
        const runtime = await getReadyRuntime();
        const preview = await previewInvitation(runtime.db, data.token, runtime.invitations).catch(
            () => null,
        );
        if (!preview) {
            return null;
        }
        const { readSession } = await import("./auth-session");
        const session = await readSession(runtime.auth);
        return {
            signedIn: Boolean(session),
            organizationName: preview.organizationName,
            role: preview.role,
            email: preview.email,
            accountExists: preview.accountExists,
            signedInAsInvitee: session?.user.email.toLowerCase() === preview.email,
        };
    });
