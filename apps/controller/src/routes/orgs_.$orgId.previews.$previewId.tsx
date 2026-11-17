import { createFileRoute, Link, redirect, useRouter } from "@tanstack/react-router";
import type { z } from "zod";
import type { deploymentSchema } from "@launchpad/contracts";
import { useEffect, useState } from "react";
import { apiRequest } from "../lib/api";
import {
    deletionLabel,
    deletionNeedsPerson,
    describeExpiry,
    EXTEND_CHOICES,
    isDeletionInProgress,
    isInProgress,
    mergeEvents,
    statusLabel,
    type ProgressEvent,
} from "../lib/previews";
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

function Resolve(props: { orgId: string; deploymentId: string; onResolved(): void }) {
    const router = useRouter();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    async function resolve(outcome: "succeeded" | "failed") {
        const sure = window.confirm(
            outcome === "succeeded"
                ? "Record that the host is serving the NEW release? Check the host first."
                : "Record that the host is serving the PREVIOUS release? Check the host first.",
        );
        if (!sure) return;
        setBusy(true);
        setError(null);
        const result = await apiRequest(
            "POST",
            `/organizations/${props.orgId}/deployments/${props.deploymentId}/resolution`,
            { outcome },
        );
        if (!result.ok) setError(result.message);
        else {
            props.onResolved();
            await router.invalidate({ sync: true });
        }
        setBusy(false);
    }
    return (
        <div className="space-y-2">
            <p>After checking the host, record what it is serving:</p>
            <button
                type="button"
                className="btn preset-tonal"
                disabled={busy}
                onClick={() => resolve("succeeded")}
            >
                It is serving the new release
            </button>{" "}
            <button
                type="button"
                className="btn preset-tonal"
                disabled={busy}
                onClick={() => resolve("failed")}
            >
                It is serving the previous release
            </button>
            {error ? <p role="alert">{error}</p> : null}
        </div>
    );
}

function Progress(props: {
    orgId: string;
    deployment: Deployment;
    latest?: boolean;
    canResolve?: boolean;
}) {
    const [deployment, setDeployment] = useState(props.deployment);
    const [events, setEvents] = useState<ProgressEvent[]>([]);
    const [lost, setLost] = useState(false);
    const [stopped, setStopped] = useState(false);
    const [attempt, setAttempt] = useState(0);

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
                if (misses >= 5) return void setStopped(true);
            }
            timer = setTimeout(poll, 2000);
        };
        setStopped(false);
        void poll();
        return () => {
            stopped = true;
            clearTimeout(timer);
        };
    }, [props.orgId, props.deployment.id, attempt]);

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
            {stopped ? (
                <p role="status">
                    Progress stopped updating.{" "}
                    <button
                        type="button"
                        className="anchor"
                        onClick={() => setAttempt((n) => n + 1)}
                    >
                        Retry
                    </button>
                </p>
            ) : lost ? (
                <p role="status">Progress could not be refreshed; retrying.</p>
            ) : null}
            {props.latest && deployment.status === "reconciliation-needed" ? (
                <p role="alert">
                    This deployment needs an administrator to confirm what the preview is serving.
                    {props.canResolve ? "" : " Ask an organization administrator."}
                </p>
            ) : null}
            {props.latest && props.canResolve && deployment.status === "reconciliation-needed" ? (
                <Resolve
                    orgId={props.orgId}
                    deploymentId={deployment.id}
                    onResolved={() => setAttempt((n) => n + 1)}
                />
            ) : null}
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

type View = ReturnType<typeof Route.useLoaderData>;

function Lifecycle(props: { view: View }) {
    const { view } = props;
    const router = useRouter();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [ttl, setTtl] = useState<string>(EXTEND_CHOICES[2]);
    const orgId = view.organization.id;
    const previewId = view.preview.id;
    const deletion = view.deletion;

    // A deletion moves on its own: look again until it is done or needs a person.
    const waiting = deletion !== null && isDeletionInProgress(deletion.status);
    useEffect(() => {
        if (!waiting) return;
        const timer = setInterval(() => void router.invalidate({ sync: true }), 4000);
        return () => clearInterval(timer);
    }, [waiting, router]);

    async function act(run: () => Promise<{ ok: true } | { ok: false; message: string }>) {
        setBusy(true);
        setError(null);
        const result = await run();
        if (!result.ok) setError(result.message);
        else await router.invalidate({ sync: true });
        setBusy(false);
    }
    const extend = () =>
        act(() =>
            apiRequest("POST", `/organizations/${orgId}/previews/${previewId}/extend`, { ttl }),
        );
    const remove = () => {
        const sure = window.confirm(
            `Delete ${view.preview.hostname}? The site is taken down and this cannot be undone.`,
        );
        if (!sure) return;
        void act(() => apiRequest("DELETE", `/organizations/${orgId}/previews/${previewId}`));
    };
    const resolve = (outcome: "retry" | "deleted") => {
        const sure = window.confirm(
            outcome === "retry"
                ? "Try the deletion again? Check the host first."
                : "Record that the app is already gone from the host? Check the host first; images are not removed.",
        );
        if (!sure || !deletion) return;
        void act(() =>
            apiRequest("POST", `/organizations/${orgId}/deletions/${deletion.id}/resolution`, {
                outcome,
            }),
        );
    };

    return (
        <section className="space-y-3">
            <h2 className="h4">Lifetime</h2>
            <p>{describeExpiry(view.preview, Date.now())}</p>
            {view.preview.state === "active" && view.canExtend ? (
                <p className="space-x-2">
                    <label>
                        Extend by{" "}
                        <select
                            className="select inline-block w-auto"
                            value={ttl}
                            disabled={busy}
                            onChange={(event) => setTtl(event.target.value)}
                        >
                            {EXTEND_CHOICES.map((choice) => (
                                <option key={choice} value={choice}>
                                    {choice}
                                </option>
                            ))}
                        </select>
                    </label>
                    <button
                        type="button"
                        className="btn preset-tonal"
                        disabled={busy}
                        onClick={extend}
                    >
                        Extend
                    </button>
                    <span className="text-sm">
                        Never shortens it; a preview that never expired gets an expiry.
                    </span>
                </p>
            ) : null}
            {view.preview.state === "active" && view.canDelete ? (
                view.deletionsAvailable ? (
                    <button
                        type="button"
                        className="btn preset-filled-error-500"
                        disabled={busy}
                        onClick={remove}
                    >
                        Delete this preview
                    </button>
                ) : (
                    <p className="text-sm">
                        Deleting is not turned on for this server (deployments and the lifecycle
                        must both be on).
                    </p>
                )
            ) : null}
            {deletion ? (
                <div className="space-y-2">
                    <p>
                        Deletion:{" "}
                        <span className="badge preset-tonal">{deletionLabel(deletion.status)}</span>
                        {deletion.reason === "expired" ? " (it expired)" : ""}
                    </p>
                    {deletion.failure ? (
                        <p role={deletionNeedsPerson(deletion.status) ? "alert" : "status"}>
                            {deletion.failure.message} <code>{deletion.failure.code}</code>
                        </p>
                    ) : null}
                    {deletionNeedsPerson(deletion.status) ? (
                        view.canResolve ? (
                            <div className="space-y-2">
                                <p>After checking the host, choose what to do:</p>
                                <button
                                    type="button"
                                    className="btn preset-tonal"
                                    disabled={busy}
                                    onClick={() => resolve("retry")}
                                >
                                    Try the deletion again
                                </button>{" "}
                                <button
                                    type="button"
                                    className="btn preset-tonal"
                                    disabled={busy}
                                    onClick={() => resolve("deleted")}
                                >
                                    The app is already gone
                                </button>
                            </div>
                        ) : (
                            <p role="alert">Ask an organization administrator to resolve this.</p>
                        )
                    ) : null}
                </div>
            ) : null}
            {error ? <p role="alert">{error}</p> : null}
        </section>
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
            <Lifecycle view={view} />
            {latest ? (
                <section className="space-y-3">
                    <h2 className="h4">Latest deployment</h2>
                    <Progress
                        key={latest.id}
                        orgId={view.organization.id}
                        deployment={latest}
                        latest
                        canResolve={view.canResolve}
                    />
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
