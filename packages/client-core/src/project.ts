import { ClientCoreError } from "./errors";
import { clientFor, type Context, resolve } from "./operations";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// A project id is used as it is; only a slug needs the project list (and so the
// `project:read` permission). An id the key cannot reach is refused by the controller
// when it is used.
export async function resolveProjectId(
    client: ReturnType<typeof clientFor>,
    organizationId: string,
    project: string,
): Promise<string> {
    if (UUID.test(project)) return project.toLowerCase();
    const projects = await client.projects.list(organizationId);
    const match = projects.find((p) => p.slug === project);
    if (!match) {
        throw new ClientCoreError("bad-input", `This key cannot see a project "${project}".`);
    }
    return match.id;
}

// The project a reference names, with the organization it was looked up in, for a caller
// that must decide what to do from the project's identity rather than the text it was given.
export async function resolveProject(ctx: Context, project: string, profile?: string) {
    const resolved = await resolve(ctx, profile);
    const client = clientFor(ctx, resolved);
    const organizationId = resolved.organizationId ?? (await client.key.get()).organizationId;
    return { organizationId, projectId: await resolveProjectId(client, organizationId, project) };
}
