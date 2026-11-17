import { randomUUID } from "node:crypto";
import { checkLifetime, retrying } from "./deploy";
import { clientFor, type Context, resolve } from "./operations";
import { resolveProjectId } from "./project";

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
    if (options.project)
        projectId = await resolveProjectId(client, organizationId, options.project);
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

// Gives a preview more time (never less) and returns it with the resulting expiry. Only a
// request that got no answer is repeated, and with the one key, so a lost answer cannot
// extend it twice within this call. Running the command again is a new request and adds
// the time again.
export async function extendPreview(
    ctx: Context,
    previewId: string,
    options: {
        ttl: string;
        profile?: string;
        idempotencyKey?: string;
        sleep?: (ms: number) => Promise<void>;
    },
) {
    checkLifetime(options.ttl);
    const { client, organizationId } = await scoped(ctx, options.profile);
    const idempotencyKey = options.idempotencyKey ?? `extend-${randomUUID()}`;
    return retrying(
        () =>
            client.previews.extend(
                organizationId,
                previewId,
                { ttl: options.ttl },
                { idempotencyKey },
            ),
        options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    );
}

// Queues the deletion and returns at once; follow it with `previewDeletion`. Deleting
// cannot be undone.
export async function deletePreview(ctx: Context, previewId: string, profile?: string) {
    const { client, organizationId } = await scoped(ctx, profile);
    return client.previews.delete(organizationId, previewId);
}

// The latest deletion of a preview, whoever started it.
export async function previewDeletion(ctx: Context, previewId: string, profile?: string) {
    const { client, organizationId } = await scoped(ctx, profile);
    return client.deletions.forPreview(organizationId, previewId);
}

// The saved profile a command will use (the one named, else the environment's, else the
// current one), or undefined when credentials come from the environment. For printing a
// follow-up command that must reach the same controller later.
export async function effectiveProfile(ctx: Context, profile?: string) {
    return (await resolve(ctx, profile)).profile ?? undefined;
}
