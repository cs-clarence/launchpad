import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import type { z } from "zod";
import type { deploymentSchema } from "@launchpad/contracts";
import { useEffect, useState } from "react";
import { isInProgress, mergeEvents, statusLabel, type ProgressEvent } from "../lib/previews";
import { getDeploymentProgressFn, getPreviewDetailFn } from "../server/data";
import { getCurrentUser } from "../server/session";

export const Route = createFileRoute("/orgs_/$orgId/previews/$previewId")({
    beforeLoad: async () => {
        if (!(await getCurrentUser())) {
            throw redirect({ to: "/login" });
        }
    },
    loader: ({ params }) =>
        getPreviewDetailFn({ data: { orgId: params.orgId, previewId: params.previewId } }),
    errorComponent: () => (
        <main className="mx-auto max-w-4xl px-6 py-12">
            <p role="alert">Preview not found.</p>
            <Link className="anchor" to="/">
                Back to organizations
            </Link>
        </main>
    ),
    component: PreviewDetail,
});

type Deployment = z.infer<typeof deploymentSchema>;

function Progress(props: { orgId: string; deployment: Deployment }) {
    const [deployment, setDeployment] = useState(props.deployment);
    const [events, setEvents] = useState<ProgressEvent[]>([]);
    const [lost, setLost] = useState(false);

    useEffect(() => {
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let after = 0;
        let known: ProgressEvent[] = [];
        let misses = 0;
        const poll = async () => {
            try {
                const result = await getDeploymentProgressFn({
                    data: { orgId: props.orgId, deploymentId: props.deployment.id, after },
                });
                if (stopped) return;
                misses = 0;
                setLost(false);
                const merged = mergeEvents(known, result.events.items);
                known = merged.events;
                after = merged.after;
                setEvents(known);
                setDeployment((old) => ({ ...old, ...result.deployment }));
                // More events waiting: ask again at once; otherwise stop once finished.
                if (result.events.nextAfter !== null) return void (timer = setTimeout(poll, 0));
                if (!isInProgress(result.deployment.status)) return;
            } catch {
                if (stopped) return;
                misses++;
                setLost(true);
                if (misses >= 5) return;
            }
            timer = setTimeout(poll, 2000);
        };
        void poll();
        return () => {
            stopped = true;
            clearTimeout(timer);
        };
    }, [props.orgId, props.deployment.id]);

    return (
        <article className="space-y-2">
            <h3 className="h5">
                {new Date(deployment.createdAt).toLocaleString()}{" "}
                <span className="badge preset-tonal">{statusLabel(deployment.status)}</span>
            </h3>
            {deployment.failure ? (
                <p role="alert">
                    {deployment.failure.message} <code>{deployment.failure.code}</code>
                </p>
            ) : null}
            {lost ? <p role="status">Progress could not be refreshed; retrying.</p> : null}
            {events.length > 0 ? (
                <ol className="space-y-1 text-sm">
                    {events.map((event) => (
                        <li key={event.seq}>
                            <code>{event.phase}</code>{" "}
                            {event.level !== "info" ? `(${event.level}) ` : ""}
                            {event.message}
                        </li>
                    ))}
                </ol>
            ) : null}
        </article>
    );
}

function PreviewDetail() {
    const view = Route.useLoaderData();
    const [latest, ...older] = view.deployments;
    return (
        <main className="mx-auto max-w-4xl space-y-6 px-6 py-12">
            <Link
                className="anchor"
                to="/orgs/$orgId/previews"
                params={{ orgId: view.organization.id }}
            >
                Previews
            </Link>
            <h1 className="h2">{view.preview.hostname}</h1>
            {latest?.status === "reconciliation-needed" ? (
                <p role="alert">
                    This deployment needs an administrator to confirm what the preview is serving.
                    {view.canResolve
                        ? " Resolve it with the administrator tools; it is not offered here."
                        : " Ask an organization administrator."}
                </p>
            ) : null}
            {latest ? (
                <section className="space-y-3">
                    <h2 className="h4">Latest deployment</h2>
                    <Progress key={latest.id} orgId={view.organization.id} deployment={latest} />
                </section>
            ) : (
                <p>This preview has not been deployed yet.</p>
            )}
            {older.length > 0 ? (
                <section className="space-y-3">
                    <h2 className="h4">Earlier deployments</h2>
                    {older.map((deployment) => (
                        <Progress
                            key={deployment.id}
                            orgId={view.organization.id}
                            deployment={deployment}
                        />
                    ))}
                </section>
            ) : null}
        </main>
    );
}
