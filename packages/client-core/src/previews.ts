import { ClientCoreError } from "./errors";
import { clientFor, type Context, resolve } from "./operations";

async function scoped(ctx: Context, profile?: string) {
    const resolved = await resolve(ctx, profile);
    const client = clientFor(ctx, resolved);
    const organizationId = resolved.organizationId ?? (await client.key.get()).organizationId;
    return { client, organizationId };
}

// Previews of the selected organization, optionally of one project (slug or id).
export async function listPreviews(
    ctx: Context,
    options: { project?: string; profile?: string } = {},
) {
    const { client, organizationId } = await scoped(ctx, options.profile);
    let projectId: string | undefined;
    if (options.project) {
        const projects = await client.projects.list(organizationId);
        const match = projects.find((p) => p.id === options.project || p.slug === options.project);
        if (!match) {
            throw new ClientCoreError(
                "bad-input",
                `This key cannot see a project "${options.project}".`,
            );
        }
        projectId = match.id;
    }
    const items = [];
    let cursor: string | undefined;
    // Bounded: a very large organization is paged through, not pulled whole.
    for (let page = 0; page < 20; page++) {
        const result = await client.previews.list(organizationId, { projectId, cursor });
        items.push(...result.items);
        if (!result.nextCursor) return { items, truncated: false };
        cursor = result.nextCursor;
    }
    return { items, truncated: true };
}

export async function getPreview(ctx: Context, previewId: string, profile?: string) {
    const { client, organizationId } = await scoped(ctx, profile);
    return client.previews.get(organizationId, previewId);
}

export async function listDeployments(ctx: Context, previewId: string, profile?: string) {
    const { client, organizationId } = await scoped(ctx, profile);
    return client.deployments.list(organizationId, previewId);
}

export async function getDeployment(ctx: Context, deploymentId: string, profile?: string) {
    const { client, organizationId } = await scoped(ctx, profile);
    return client.deployments.get(organizationId, deploymentId);
}

export async function deploymentEvents(
    ctx: Context,
    deploymentId: string,
    options: { after?: number; profile?: string } = {},
) {
    const { client, organizationId } = await scoped(ctx, options.profile);
    return client.deployments.events(organizationId, deploymentId, options.after);
}
