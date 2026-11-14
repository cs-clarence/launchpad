import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

// Server functions read through the same authorized services as the HTTP API.
// Imports are dynamic so server-only code stays out of the client bundle.
async function principal() {
    const { getRuntime } = await import("./runtime");
    const runtime = getRuntime();
    const { readSession } = await import("./auth-session");
    const session = await readSession(runtime.auth);
    if (!session) {
        throw new Error("unauthenticated");
    }
    const role = (session.user as { role?: string }).role;
    return {
        runtime,
        who: {
            userId: session.user.id,
            instanceRole: role === "operator" ? ("operator" as const) : ("user" as const),
        },
    };
}

export const listOrganizationsFn = createServerFn({ method: "GET" }).handler(async () => {
    const { listMyOrganizations } = await import("@launchpad/services");
    const { runtime, who } = await principal();
    return listMyOrganizations(runtime.db, who);
});

export const getOrganizationViewFn = createServerFn({ method: "GET" })
    .validator((input: unknown) => z.object({ orgId: z.string().min(1).max(64) }).parse(input))
    .handler(async ({ data }) => {
        const services = await import("@launchpad/services");
        const { runtime, who } = await principal();
        const organization = await services.getOrganization(runtime.db, who, data.orgId);
        const projects = await services.listProjects(runtime.db, who, data.orgId);
        const members = await services.listMembers(runtime.db, who, data.orgId);
        const canManage = services.can(organization.role, "member:manage");
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
    const { getRuntime } = await import("./runtime");
    return getRuntime().features;
});

// POST so the token travels in the body, never in a URL that could be logged.
export const getInvitationPreviewFn = createServerFn({ method: "POST" })
    .validator((input: unknown) => z.object({ token: z.string().max(200) }).parse(input))
    .handler(async ({ data }) => {
        const { previewInvitation } = await import("@launchpad/services");
        const { getRuntime } = await import("./runtime");
        const runtime = getRuntime();
        const preview = await previewInvitation(runtime.db, data.token).catch(() => null);
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
