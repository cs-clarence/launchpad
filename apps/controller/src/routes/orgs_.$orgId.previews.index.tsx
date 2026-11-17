import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { DeployPanel } from "../components/deploy-panel";
import { describeExpiry, statusLabel } from "../lib/previews";
import { useNow } from "../lib/use-now";
import { getPreviewsViewFn } from "../server/data";
import { getCurrentUser } from "../server/session";

export const Route = createFileRoute("/orgs_/$orgId/previews/")({
    beforeLoad: async () => {
        if (!(await getCurrentUser())) {
            throw redirect({ to: "/login" });
        }
    },
    loader: ({ params }) => getPreviewsViewFn({ data: { orgId: params.orgId } }),
    errorComponent: () => (
        <main className="mx-auto max-w-4xl px-6 py-12">
            <p role="alert">Previews are not available to you here.</p>
            <Link className="anchor" to="/">
                Back to organizations
            </Link>
        </main>
    ),
    component: Previews,
});

function Previews() {
    const view = Route.useLoaderData();
    const now = useNow(view.now);
    return (
        <main className="mx-auto max-w-4xl space-y-6 px-6 py-12">
            <Link className="anchor" to="/orgs/$orgId" params={{ orgId: view.organization.id }}>
                {view.organization.name}
            </Link>
            <h1 className="h2">Previews</h1>
            {view.canDeploy && view.deploymentsEnabled ? (
                view.projects.length > 0 ? (
                    <DeployPanel
                        organizationId={view.organization.id}
                        projects={view.projects}
                        maxUploadBytes={view.maxUploadBytes}
                        maxTtlSeconds={view.maxTtlSeconds}
                        lifecycleEnabled={view.lifecycleEnabled}
                    />
                ) : (
                    <p>Create a project first; previews belong to a project.</p>
                )
            ) : !view.deploymentsEnabled ? (
                <p>Deploying is not turned on for this server.</p>
            ) : null}
            <p>
                You can also deploy from a terminal: <code>launchpad deploy</code>.
            </p>
            {view.previews.length === 0 ? (
                <p>No previews yet.</p>
            ) : (
                <ul className="space-y-3">
                    {view.previews.map((preview) => (
                        <li key={preview.id} className="space-y-1">
                            <Link
                                className="anchor"
                                to="/orgs/$orgId/previews/$previewId"
                                params={{ orgId: view.organization.id, previewId: preview.id }}
                            >
                                {preview.hostname}
                            </Link>{" "}
                            <span className="badge preset-tonal">
                                {preview.latest
                                    ? statusLabel(preview.latest.status)
                                    : "Not deployed"}
                            </span>
                            <div className="text-sm">
                                {preview.projectName ?? "Unknown project"} ·{" "}
                                <code>{preview.slug}</code>
                                {view.lifecycleEnabled || preview.state !== "active" ? (
                                    <span suppressHydrationWarning>
                                        {" · "}
                                        {describeExpiry(preview, now)}
                                    </span>
                                ) : null}
                            </div>
                        </li>
                    ))}
                </ul>
            )}
            {view.more ? (
                <p>Only the first previews are shown. Use the CLI to list them all.</p>
            ) : null}
        </main>
    );
}
