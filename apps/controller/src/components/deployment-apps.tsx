import type {
    appSchema,
    appShutdownSchema,
    artifactSchema,
    promotionOperationSchema,
} from "@launchpad-kit/contracts";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { z } from "zod";
import { apiCall, type ApiResult } from "../lib/api";
import { eligibleTargets, routeIntent, type Alias, type Deployment } from "../lib/deployment-apps";

type App = z.infer<typeof appSchema>;
type Operation = z.infer<typeof promotionOperationSchema>;
type Project = { id: string; name: string };

function Form(props: {
    label: string;
    children: React.ReactNode;
    submit: (data: FormData) => Promise<boolean>;
}) {
    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const form = event.currentTarget;
        if (await props.submit(new FormData(form))) form.reset();
    }
    return (
        <form className="space-y-2" onSubmit={submit}>
            {props.children}
            <button className="btn preset-tonal" type="submit">
                {props.label}
            </button>
        </form>
    );
}

const value = (form: FormData, key: string) => String(form.get(key) ?? "");

export function DeploymentApps(props: {
    organizationId: string;
    projects: Project[];
    role: "viewer" | "deployer" | "admin" | "owner";
}) {
    const base = `/organizations/${encodeURIComponent(props.organizationId)}`;
    const canChange = props.role !== "viewer";
    const isAdmin = props.role === "owner" || props.role === "admin";
    const [selected, select] = useState("");
    const [selectedAlias, selectAlias] = useState("");
    const [apps, setApps] = useState<App[]>([]);
    const [appData, setAppData] = useState<{
        id: string;
        deployments: Deployment[];
        aliases: Alias[];
    }>();
    const [history, setHistory] = useState<{ id: string; operations: Operation[] }>();
    const [artifact, setArtifact] = useState<{ projectId: string; id: string }>();
    const [refresh, setRefresh] = useState(0);
    const [readError, setReadError] = useState("");
    const [message, setMessage] = useState<{ error?: boolean; text: string }>();
    const [pending, setPending] = useState(false);
    const lock = useRef(false);
    const routeKeys = useRef(new Map<string, string>());
    const app = apps.find((item) => item.id === selected);
    const appUrl = `${base}/apps/${app?.id ?? ""}`;
    const details = appData?.id === app?.id ? appData : undefined;
    const alias = details?.aliases.find((item) => item.id === selectedAlias);
    const operations = alias && history?.id === alias.id ? history.operations : undefined;

    useEffect(() => {
        const signal = new AbortController();
        async function load() {
            const result = await apiCall<App[]>("GET", `${base}/apps`, { signal: signal.signal });
            if (signal.signal.aborted) return;
            if (result.ok) {
                setApps(result.data);
                setReadError("");
            } else {
                setApps([]);
                setReadError(result.message);
            }
        }
        void load();
        return () => signal.abort();
    }, [base, refresh]);

    useEffect(() => {
        if (!selected) return;
        const signal = new AbortController();
        async function load() {
            const [deployments, aliases] = await Promise.all([
                apiCall<Deployment[]>("GET", `${appUrl}/deployments`, { signal: signal.signal }),
                apiCall<Alias[]>("GET", `${appUrl}/aliases`, { signal: signal.signal }),
            ]);
            if (signal.signal.aborted) return;
            if (deployments.ok && aliases.ok) {
                setAppData({ id: selected, deployments: deployments.data, aliases: aliases.data });
            } else {
                setAppData(undefined);
                setMessage({
                    error: true,
                    text: !deployments.ok
                        ? deployments.message
                        : !aliases.ok
                          ? aliases.message
                          : "Could not load app.",
                });
            }
        }
        if (app) void load();
        return () => signal.abort();
    }, [app?.id, appUrl, selected, refresh]);

    useEffect(() => {
        if (!selectedAlias) return;
        const signal = new AbortController();
        async function load() {
            const result = await apiCall<Operation[]>(
                "GET",
                `${base}/aliases/${selectedAlias}/operations`,
                { signal: signal.signal },
            );
            if (signal.signal.aborted) return;
            if (result.ok) setHistory({ id: selectedAlias, operations: result.data });
            else setMessage({ error: true, text: result.message });
        }
        void load();
        return () => signal.abort();
    }, [base, selectedAlias, refresh]);

    async function run<T>(
        work: () => Promise<ApiResult<T>>,
        success: (data: T) => string,
        update = true,
    ) {
        if (lock.current) return false;
        lock.current = true;
        setPending(true);
        setMessage(undefined);
        try {
            const result = await work();
            if (!result.ok) {
                setMessage({ error: true, text: result.message });
                return false;
            }
            setMessage({ text: success(result.data) });
            if (update) {
                setAppData(undefined);
                setHistory(undefined);
                setRefresh((n) => n + 1);
            }
            return true;
        } finally {
            lock.current = false;
            setPending(false);
        }
    }

    function routeChange(action: "promote" | "withdraw", target?: string) {
        if (!alias || (action === "promote" && !target)) return Promise.resolve(false);
        const { method, path, json, fingerprint } = routeIntent(base, alias, target);
        const idempotencyKey = routeKeys.current.get(fingerprint) ?? crypto.randomUUID();
        routeKeys.current.set(fingerprint, idempotencyKey);
        return run(
            () =>
                apiCall<Operation>(method, path, {
                    json,
                    headers: { "idempotency-key": idempotencyKey },
                }),
            (operation) => {
                routeKeys.current.delete(fingerprint);
                return `Routing operation ${operation.id}: ${operation.status}.`;
            },
        );
    }

    const requestReview = (path: string) =>
        run(
            () => apiCall("POST", path),
            () =>
                "Request recorded for the instance operator. No routing or deployment state changed.",
            false,
        );

    return (
        <section className="space-y-4" aria-label="Apps and deployments">
            <h2 className="h3">Apps and deployments</h2>
            {readError && <p role="alert">{readError}</p>}
            {message && <p role={message.error ? "alert" : "status"}>{message.text}</p>}
            <fieldset className="space-y-4" disabled={pending}>
                <button
                    type="button"
                    className="btn preset-tonal"
                    onClick={() => setRefresh((n) => n + 1)}
                >
                    Refresh deployments and aliases
                </button>
                <label className="label">
                    App
                    <select
                        className="select"
                        value={selected}
                        onChange={(event) => {
                            select(event.target.value);
                            selectAlias("");
                            setMessage(undefined);
                        }}
                    >
                        <option value="">Choose an app</option>
                        {apps.map((item) => (
                            <option key={item.id} value={item.id}>
                                {item.slug} —{" "}
                                {props.projects.find((p) => p.id === item.projectId)?.name ??
                                    item.projectId}{" "}
                                ({item.state})
                            </option>
                        ))}
                    </select>
                </label>
                {canChange && props.projects.length > 0 && (
                    <Form
                        label="Create app"
                        submit={(data) =>
                            run(
                                () =>
                                    apiCall<App>(
                                        "POST",
                                        `${base}/projects/${value(data, "project")}/apps`,
                                        {
                                            json: { slug: value(data, "slug") },
                                        },
                                    ),
                                (created) => {
                                    select(created.id);
                                    selectAlias("");
                                    return `App ${created.slug} created.`;
                                },
                            )
                        }
                    >
                        <label className="label">
                            Project
                            <select className="select" name="project">
                                {props.projects.map((project) => (
                                    <option key={project.id} value={project.id}>
                                        {project.name}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <label className="label">
                            New app slug{" "}
                            <input className="input" name="slug" maxLength={40} required />
                        </label>
                    </Form>
                )}
                {app && details && (
                    <>
                        <p>
                            App ID: <code>{app.id}</code> · {app.state}
                        </p>
                        {canChange && app.state === "active" && (
                            <>
                                <Form
                                    label="Upload archive"
                                    submit={(data) => {
                                        const file = data.get("archive");
                                        if (!(file instanceof File) || file.size === 0)
                                            return Promise.resolve(false);
                                        return run(
                                            () =>
                                                apiCall<z.infer<typeof artifactSchema>>(
                                                    "POST",
                                                    `${base}/projects/${app.projectId}/artifacts`,
                                                    {
                                                        raw: {
                                                            body: file,
                                                            contentType: "application/gzip",
                                                        },
                                                    },
                                                ),
                                            (uploaded) => {
                                                setArtifact({
                                                    projectId: app.projectId,
                                                    id: uploaded.id,
                                                });
                                                return `Archive ${uploaded.id} ready to deploy.`;
                                            },
                                            false,
                                        );
                                    }}
                                >
                                    <label className="label">
                                        Site archive (.tar.gz){" "}
                                        <input
                                            className="input"
                                            type="file"
                                            name="archive"
                                            accept=".tar.gz,.tgz,application/gzip"
                                            required
                                        />
                                    </label>
                                </Form>
                                <Form
                                    key={artifact?.id ?? app.id}
                                    label="Deploy to a new preview URL"
                                    submit={(data) =>
                                        run(
                                            () =>
                                                apiCall<Deployment>(
                                                    "POST",
                                                    `${appUrl}/deployments`,
                                                    {
                                                        json: {
                                                            artifactId: value(data, "artifact"),
                                                            spa: data.has("spa"),
                                                        },
                                                    },
                                                ),
                                            (created) =>
                                                `Deployment ${created.id}: ${created.status}. No alias was moved.`,
                                        )
                                    }
                                >
                                    <label className="label">
                                        Artifact ID{" "}
                                        <input
                                            className="input"
                                            name="artifact"
                                            defaultValue={
                                                artifact?.projectId === app.projectId
                                                    ? artifact.id
                                                    : ""
                                            }
                                            required
                                        />
                                    </label>
                                    <label>
                                        <input type="checkbox" name="spa" /> Single-page application
                                        fallback
                                    </label>
                                </Form>
                            </>
                        )}
                        <h3 className="h4">Deployment history</h3>
                        <ul className="space-y-2">
                            {details.deployments.map((deployment) => (
                                <li key={deployment.id}>
                                    <code>{deployment.id}</code> · {deployment.status} ·{" "}
                                    {deployment.desiredState}
                                    {deployment.status === "succeeded" &&
                                        deployment.desiredState === "active" && (
                                            <>
                                                {" "}
                                                ·{" "}
                                                <a
                                                    className="anchor"
                                                    href={`https://${deployment.hostname}`}
                                                >
                                                    Open preview
                                                </a>
                                            </>
                                        )}
                                    {deployment.failureCode && <> · {deployment.failureCode}</>}
                                    {canChange &&
                                        deployment.desiredState === "active" &&
                                        ["succeeded", "failed", "cancelled"].includes(
                                            deployment.status,
                                        ) && (
                                            <button
                                                className="btn preset-tonal"
                                                type="button"
                                                onClick={() => {
                                                    if (
                                                        window.confirm(
                                                            `Delete deployment ${deployment.id}? Pinned deployments cannot be deleted.`,
                                                        )
                                                    ) {
                                                        void run(
                                                            () =>
                                                                apiCall(
                                                                    "DELETE",
                                                                    `${base}/deployments/${deployment.id}`,
                                                                ),
                                                            () => "Deletion queued.",
                                                        );
                                                    }
                                                }}
                                            >
                                                Delete deployment
                                            </button>
                                        )}
                                    {isAdmin &&
                                        (deployment.status === "reconciliation-needed" ||
                                            deployment.desiredState === "deleting") && (
                                            <button
                                                className="btn preset-tonal"
                                                type="button"
                                                onClick={() =>
                                                    void requestReview(
                                                        `${base}/deployments/${deployment.id}/reconciliation-requests`,
                                                    )
                                                }
                                            >
                                                Request operator review
                                            </button>
                                        )}
                                </li>
                            ))}
                        </ul>
                        <h3 className="h4">Stable aliases</h3>
                        <ul className="space-y-2">
                            {details.aliases.map((item) => (
                                <li key={item.id}>
                                    <button
                                        className="btn preset-tonal"
                                        type="button"
                                        onClick={() => selectAlias(item.id)}
                                    >
                                        {item.slug}: {item.state}
                                    </button>{" "}
                                    {item.hostname} · generation {item.reservedGeneration} ·{" "}
                                    {item.targetDeploymentId ?? "no committed target"}
                                </li>
                            ))}
                        </ul>
                        {canChange && app.state === "active" && (
                            <Form
                                label="Create unbound alias"
                                submit={(data) =>
                                    run(
                                        () =>
                                            apiCall<Alias>("POST", `${appUrl}/aliases`, {
                                                json: { slug: value(data, "slug") },
                                            }),
                                        (created) =>
                                            `Reserved ${created.hostname}. It has no target.`,
                                    )
                                }
                            >
                                <label className="label">
                                    New alias slug{" "}
                                    <input className="input" name="slug" maxLength={40} required />
                                </label>
                            </Form>
                        )}
                        {alias && (
                            <section
                                className="space-y-2"
                                aria-label={`Operations for ${alias.slug}`}
                            >
                                <h4>{alias.slug} routing history</h4>
                                <ul>
                                    {operations?.map((operation) => (
                                        <li key={operation.id}>
                                            {operation.generation}: {operation.action} ·{" "}
                                            {operation.status} ·{" "}
                                            {operation.desiredTargetDeploymentId ?? "no target"} ·{" "}
                                            <code>{operation.id}</code>
                                            {isAdmin &&
                                                operation.status === "reconciliation-needed" && (
                                                    <button
                                                        className="btn preset-tonal"
                                                        type="button"
                                                        onClick={() =>
                                                            void requestReview(
                                                                `${base}/promotion-operations/${operation.id}/reconciliation-requests`,
                                                            )
                                                        }
                                                    >
                                                        Request operator review
                                                    </button>
                                                )}
                                        </li>
                                    ))}
                                </ul>
                                {canChange &&
                                    app.state === "active" &&
                                    (alias.state === "bound" || alias.state === "unbound") && (
                                        <>
                                            <Form
                                                label={`Promote to ${alias.slug}`}
                                                submit={(data) => {
                                                    const id = value(data, "deployment");
                                                    return window.confirm(
                                                        `Point ${alias.hostname} at deployment ${id}?`,
                                                    )
                                                        ? routeChange("promote", id)
                                                        : Promise.resolve(false);
                                                }}
                                            >
                                                <label className="label">
                                                    Target deployment (choose a retained release to
                                                    roll back)
                                                    <select
                                                        className="select"
                                                        name="deployment"
                                                        required
                                                        defaultValue=""
                                                    >
                                                        <option value="">
                                                            Choose a deployment
                                                        </option>
                                                        {eligibleTargets(
                                                            alias,
                                                            details.deployments,
                                                        ).map((d) => (
                                                            <option value={d.id} key={d.id}>
                                                                {d.hostname} — {d.createdAt}
                                                            </option>
                                                        ))}
                                                    </select>
                                                </label>
                                            </Form>
                                            <button
                                                className="btn preset-tonal"
                                                type="button"
                                                onClick={() => {
                                                    if (
                                                        window.confirm(
                                                            `Permanently withdraw ${alias.hostname}? Its hostname cannot be reused.`,
                                                        )
                                                    )
                                                        void routeChange("withdraw");
                                                }}
                                            >
                                                Withdraw alias permanently
                                            </button>
                                        </>
                                    )}
                            </section>
                        )}
                        {isAdmin && app.state !== "deleted" && (
                            <button
                                className="btn preset-tonal"
                                type="button"
                                onClick={() => {
                                    if (
                                        window.confirm(
                                            `Shut down ${app.slug}? All live aliases must be withdrawn before deployments are deleted.`,
                                        )
                                    ) {
                                        void run(
                                            () =>
                                                apiCall<z.infer<typeof appShutdownSchema>>(
                                                    "DELETE",
                                                    appUrl,
                                                ),
                                            (result) =>
                                                `App ${result.state}. ${result.withdrawalsQueued} withdrawals and ${result.deletionsQueued} deletions queued.${result.blockedBy.length ? ` Blocked by: ${result.blockedBy.join(", ")}.` : ""}`,
                                        );
                                    }
                                }}
                            >
                                {app.state === "shutting-down"
                                    ? "Continue shutdown"
                                    : "Shut down app"}
                            </button>
                        )}
                    </>
                )}
            </fieldset>
        </section>
    );
}
