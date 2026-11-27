// The inferred declaration of `AppClient` names the contracts' schemas, so a user of the
// published package needs them installed: this keeps them a declared dependency.
import type {} from "@launchpad-kit/contracts";
import { ClientCoreError } from "./errors";
import { clientFor, resolve, type Context } from "./operations";

export async function appClient(context: Context, profile?: string) {
    const credentials = await resolve(context, profile);
    const client = clientFor(context, credentials);
    const organizationId = credentials.organizationId ?? (await client.key.get()).organizationId;
    return { client, organizationId };
}

export type AppClient = Awaited<ReturnType<typeof appClient>>;

export function requireConfirmation(confirmed: boolean | undefined) {
    if (confirmed !== true) {
        throw new ClientCoreError("bad-input", "Confirm this change explicitly before proceeding.");
    }
}

// Project identity on the app is authoritative; a call or a local workspace file
// cannot select a different project to get past a startup restriction.
export async function checkedApp(
    { client, organizationId }: AppClient,
    appId: string,
    allowedProjects: readonly string[],
) {
    const app = await client.apps.get(organizationId, appId);
    if (app.id !== appId || !allowedProjects.includes(app.projectId)) {
        throw new ClientCoreError("bad-input", "The app is outside the configured projects.");
    }
    return app;
}
