import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useNavigate } from "@tanstack/react-router";
import { apiRequest } from "../lib/api";
import {
    issueKey,
    keyInput,
    readKeys,
    attemptCandidate,
    snapshotAttempt,
    revealNotice,
    requestSignal,
    type KeyAttempt,
    type KeySummary,
    type RevealedKey,
} from "../lib/api-keys";
import { authClient } from "../lib/auth-client";

const SCOPES = [
    ["organization:read", "Read this organization (needed for CLI org commands)"],
    ["project:read", "List projects"],
    ["project:create", "Create projects (unrestricted keys only)"],
    ["member:read", "Read all organization members, including their email addresses"],
    ["app:read", "Read apps, deployments, aliases and operation history"],
    ["app:deploy", "Create apps, upload archives and deploy without promoting"],
    ["app:promote", "Point aliases at deployments, including rollbacks"],
    ["app:alias:manage", "Create and permanently withdraw alias hostnames"],
    ["app:delete", "Delete unpinned deployments"],
] as const;
const DEFAULT_SCOPES = ["organization:read", "project:read"];

export function ApiKeys(props: {
    organizationId: string;
    keys: KeySummary[];
    projects: { id: string; name: string }[];
    fresh: boolean;
    freshForMs: number;
    paused: boolean;
    onSensitiveChange(locked: boolean): void;
}) {
    const navigate = useNavigate();
    const [keys, setKeys] = useState(props.keys);
    const [fresh, setFresh] = useState(props.fresh);
    const [revealed, setRevealed] = useState<RevealedKey | null>(null);
    const [uncertain, setUncertain] = useState<KeyAttempt | null>(null);
    const [restoreRefresh, setRestoreRefresh] = useState(false);
    const [reviewReady, setReviewReady] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [limited, setLimited] = useState(false);
    const [scopes, setScopes] = useState(DEFAULT_SCOPES);
    const [projects, setProjects] = useState<string[]>([]);
    const [confirm, setConfirm] = useState<KeySummary | null>(null);
    const [copied, setCopied] = useState(false);
    const working = useRef(false);
    const epoch = useRef(0);
    const request = useRef<AbortController | null>(null);
    const attempt = useRef<KeyAttempt | null>(null);
    const shown = useRef<KeyAttempt | null>(null);
    const secretField = useRef<HTMLInputElement>(null);

    useEffect(() => {
        props.onSensitiveChange(busy || revealed !== null || restoreRefresh);
        return () => props.onSensitiveChange(false);
    }, [busy, revealed, restoreRefresh, props.onSensitiveChange]);
    useEffect(() => setKeys(props.keys), [props.keys]);
    useEffect(() => {
        setFresh(props.fresh);
        const timer = setTimeout(() => setFresh(false), props.freshForMs);
        return () => clearTimeout(timer);
    }, [props.fresh, props.freshForMs]);
    useEffect(() => {
        function clear() {
            epoch.current++;
            request.current?.abort();
            const abandoned = shown.current ?? attempt.current;
            shown.current = null;
            // Remove the controlled element (including its value attribute)
            // synchronously before bfcache can snapshot the page.
            flushSync(() => {
                setRevealed(null);
                setCopied(false);
                if (abandoned) {
                    setUncertain(abandoned);
                    setReviewReady(false);
                }
            });
        }
        const show = (event: PageTransitionEvent) => {
            if (event.persisted) {
                clear();
                setRestoreRefresh(true);
            }
        };
        window.addEventListener("pagehide", clear);
        window.addEventListener("pageshow", show);
        return () => {
            epoch.current++;
            request.current?.abort();
            window.removeEventListener("pagehide", clear);
            window.removeEventListener("pageshow", show);
        };
    }, []);
    useEffect(() => {
        if (!restoreRefresh || busy || props.paused) return;
        setRestoreRefresh(false);
        void act(refresh);
    }, [restoreRefresh, busy, props.paused]);

    async function refresh() {
        setReviewReady(false);
        try {
            setKeys(await readKeys(props.organizationId));
            setReviewReady(true);
        } catch {
            setError("Could not refresh the key list. Use Refresh keys to try again.");
        }
    }
    async function act(call: () => Promise<void>) {
        if (working.current || props.paused) return;
        working.current = true;
        setBusy(true);
        setError(null);
        try {
            await call();
        } catch {
            setError("The action failed. Refresh to check the current state.");
        } finally {
            working.current = false;
            setBusy(false);
        }
    }
    const active = keys.filter((key) => key.status === "active");
    const other = keys.filter((key) => key.status !== "active");
    const locked = busy || revealed !== null || props.paused || restoreRefresh;
    function row(key: KeySummary) {
        return (
            <li key={key.id} className="space-y-2 rounded border p-3">
                <p>
                    <strong>{key.name}</strong> <code>{key.prefix}…</code> — {key.status}
                </p>
                <p>
                    Scopes: {key.scopes.join(", ")}. Projects: {key.projectIds?.join(", ") ?? "all"}
                    .
                </p>
                <p>
                    Creator: {key.createdBy}. Created: {key.createdAt}. Expires: {key.expiresAt}.
                </p>
                {uncertain && attemptCandidate(key, uncertain) ? (
                    <p>
                        Candidate for the interrupted reveal. Check the prefix, creator and creation
                        time before revoking; a matching name alone is not proof.
                    </p>
                ) : null}
                <button
                    type="button"
                    className="btn btn-sm preset-tonal"
                    disabled={locked || key.status === "revoked"}
                    onClick={() => setConfirm(key)}
                >
                    Revoke
                </button>
            </li>
        );
    }
    return (
        <section className="space-y-4" aria-labelledby="api-keys-heading">
            <h2 id="api-keys-heading" className="h3">
                API keys
            </h2>
            <p>
                Keys never exceed their creator's current role. Removing the creator or resetting
                their password disables their keys.
            </p>
            {error ? (
                <p role="alert" className="text-error-500">
                    {error}
                </p>
            ) : null}
            {revealed ? (
                <div
                    className="space-y-3 rounded border p-4"
                    role="region"
                    aria-label="New API key"
                >
                    <p role="status">
                        Save this key now. It cannot be retrieved again. Do not leave until you have
                        saved it.
                    </p>
                    <label className="label">
                        <span className="label-text">One-time API key</span>
                        <input
                            ref={secretField}
                            className="input font-mono"
                            value={revealed.secret}
                            readOnly
                            autoComplete="off"
                            spellCheck={false}
                        />
                    </label>
                    <button
                        type="button"
                        className="btn preset-tonal"
                        onClick={async () => {
                            try {
                                await navigator.clipboard.writeText(revealed.secret);
                                setCopied(true);
                            } catch {
                                setError("Could not copy the key. Select and copy it manually.");
                            }
                        }}
                    >
                        {copied ? "Copied" : "Copy key"}
                    </button>
                    <button
                        type="button"
                        className="btn preset-filled"
                        onClick={() => {
                            if (secretField.current) secretField.current.value = "";
                            shown.current = null;
                            setRevealed(null);
                            setCopied(false);
                            setLimited(false);
                            setScopes(DEFAULT_SCOPES);
                            setProjects([]);
                            void act(refresh);
                        }}
                    >
                        I saved it — dismiss
                    </button>
                </div>
            ) : (
                <>
                    {!fresh ? (
                        <div className="space-y-2">
                            <p>
                                Issuing a key needs a sign-in from the last 15 minutes. Sign out and
                                sign in again before filling in the form.
                            </p>
                            <button
                                type="button"
                                className="btn preset-tonal"
                                disabled={busy || props.paused}
                                onClick={() =>
                                    void act(async () => {
                                        const lifetime = requestSignal();
                                        let result: Awaited<ReturnType<typeof authClient.signOut>>;
                                        try {
                                            result = await authClient.signOut({
                                                fetchOptions: { signal: lifetime.signal },
                                            });
                                        } finally {
                                            lifetime.dispose();
                                        }
                                        if (result.error) {
                                            setError("Could not sign out. Try again.");
                                            return;
                                        }
                                        await navigate({
                                            to: "/login",
                                            search: {
                                                next: `/orgs/${encodeURIComponent(props.organizationId)}`,
                                            },
                                        });
                                    })
                                }
                            >
                                Sign out and sign in again
                            </button>
                        </div>
                    ) : null}
                    {uncertain ? (
                        <div className="space-y-2" role="alert">
                            <p>
                                {uncertain.keyId
                                    ? `The reveal for “${uncertain.name}” (${uncertain.prefix}…) was cleared when you left.`
                                    : `Issuance of “${uncertain.name}” could not be confirmed. It may have succeeded.`}{" "}
                                Inspect the candidate keys below and revoke your unsaved key before
                                trying again. No automatic retry was made.
                            </p>
                            {!reviewReady ? (
                                <p>
                                    Refresh the key list successfully before allowing another
                                    attempt.
                                </p>
                            ) : null}
                            <button
                                type="button"
                                className="btn preset-tonal"
                                disabled={busy || props.paused || restoreRefresh || !reviewReady}
                                onClick={() => setUncertain(null)}
                            >
                                I checked the list — allow another attempt
                            </button>
                        </div>
                    ) : null}
                    <form
                        className="space-y-3"
                        onSubmit={async (event) => {
                            event.preventDefault();
                            if (
                                working.current ||
                                props.paused ||
                                restoreRefresh ||
                                uncertain ||
                                !fresh
                            )
                                return;
                            let input: ReturnType<typeof keyInput>;
                            try {
                                input = keyInput(new FormData(event.currentTarget));
                            } catch {
                                setError(
                                    "Choose a name, at least one scope, an expiry and (if restricted) 1–50 projects.",
                                );
                                return;
                            }
                            const current = epoch.current;
                            const pending = snapshotAttempt(input.name, keys);
                            attempt.current = pending;
                            request.current = new AbortController();
                            await act(async () => {
                                const result = await issueKey(
                                    props.organizationId,
                                    input,
                                    fetch,
                                    request.current!.signal,
                                );
                                if (current !== epoch.current) return;
                                if (result.kind === "issued") {
                                    // No loader invalidation or GET before this reveal is dismissed.
                                    shown.current = revealNotice(pending, result.key);
                                    setRevealed(result.key);
                                    setConfirm(null);
                                } else if (result.kind === "rejected") {
                                    setError(result.message);
                                    if (result.status === 401 || result.status === 403)
                                        setFresh(false);
                                } else {
                                    setUncertain(pending);
                                    setReviewReady(false);
                                    await refresh();
                                }
                            });
                            attempt.current = null;
                            request.current = null;
                        }}
                    >
                        <fieldset
                            className="space-y-3"
                            disabled={
                                busy ||
                                props.paused ||
                                restoreRefresh ||
                                !fresh ||
                                uncertain !== null
                            }
                        >
                            <legend className="h4">Issue an API key</legend>
                            <p>
                                If you leave while issuing, check the list and revoke any key whose
                                value you did not save.
                            </p>
                            <label className="label">
                                <span className="label-text">Key name</span>
                                <input className="input" name="name" required maxLength={80} />
                            </label>
                            <fieldset className="space-y-2">
                                <legend>Permissions</legend>
                                {SCOPES.map(([scope, label]) => (
                                    <label key={scope} className="flex gap-2">
                                        <input
                                            type="checkbox"
                                            name="scopes"
                                            value={scope}
                                            checked={scopes.includes(scope)}
                                            onChange={(event) => {
                                                const checked = event.target.checked;
                                                setScopes((old) =>
                                                    checked
                                                        ? [...old, scope]
                                                        : old.filter((value) => value !== scope),
                                                );
                                            }}
                                            disabled={limited && scope === "project:create"}
                                        />
                                        {label}
                                    </label>
                                ))}
                            </fieldset>
                            <label className="label">
                                <span className="label-text">Expires in</span>
                                <select className="select" name="expiresInDays" defaultValue="30">
                                    {[1, 7, 30, 90, 365].map((days) => (
                                        <option key={days} value={days}>
                                            {days} days
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <label className="flex gap-2">
                                <input
                                    type="checkbox"
                                    name="limit"
                                    checked={limited}
                                    onChange={(event) => {
                                        const checked = event.target.checked;
                                        setLimited(checked);
                                        if (checked)
                                            setScopes((old) =>
                                                old.filter((scope) => scope !== "project:create"),
                                            );
                                    }}
                                />
                                Restrict to selected projects (up to 50)
                            </label>
                            {limited ? (
                                <fieldset className="space-y-2">
                                    <legend>Allowed projects</legend>
                                    {props.projects.length === 0 ? (
                                        <p>
                                            No projects available. Create a project first or use an
                                            unrestricted key.
                                        </p>
                                    ) : null}
                                    {props.projects.map((project) => (
                                        <label key={project.id} className="flex gap-2">
                                            <input
                                                type="checkbox"
                                                name="projectIds"
                                                value={project.id}
                                                checked={projects.includes(project.id)}
                                                disabled={
                                                    projects.length >= 50 &&
                                                    !projects.includes(project.id)
                                                }
                                                onChange={(event) => {
                                                    const checked = event.target.checked;
                                                    setProjects((old) =>
                                                        checked
                                                            ? [...old, project.id]
                                                            : old.filter((id) => id !== project.id),
                                                    );
                                                }}
                                            />
                                            {project.name}
                                        </label>
                                    ))}
                                </fieldset>
                            ) : null}
                            <button className="btn preset-filled" type="submit">
                                {busy ? "Issuing…" : "Issue key"}
                            </button>
                        </fieldset>
                    </form>
                </>
            )}
            <button
                className="btn preset-tonal"
                type="button"
                disabled={locked}
                onClick={() => void act(refresh)}
            >
                Refresh keys
            </button>
            {keys.length === 0 ? <p>No API keys yet.</p> : null}
            <ul className="space-y-3">{active.map(row)}</ul>
            {other.length > 0 ? (
                <details>
                    <summary>Other keys ({other.length})</summary>
                    <ul className="space-y-3">{other.map(row)}</ul>
                </details>
            ) : null}
            {confirm ? (
                <div className="space-y-2" role="group" aria-label="Confirm key revocation">
                    <p>
                        Revoke “{confirm.name}” ({confirm.prefix}…)? This cannot be undone.
                    </p>
                    <button
                        type="button"
                        className="btn preset-filled"
                        disabled={locked}
                        onClick={() =>
                            void act(async () => {
                                const lifetime = requestSignal();
                                let result: Awaited<ReturnType<typeof apiRequest>>;
                                try {
                                    result = await apiRequest(
                                        "DELETE",
                                        `/organizations/${encodeURIComponent(props.organizationId)}/api-keys/${encodeURIComponent(confirm.id)}`,
                                        undefined,
                                        lifetime.signal,
                                    );
                                } finally {
                                    lifetime.dispose();
                                }
                                if (!result.ok) {
                                    setError(result.message);
                                    return;
                                }
                                setKeys((old) =>
                                    old.map((key) =>
                                        key.id === confirm.id ? { ...key, status: "revoked" } : key,
                                    ),
                                );
                                setConfirm(null);
                                await refresh();
                            })
                        }
                    >
                        Confirm revoke
                    </button>
                    <button
                        type="button"
                        className="btn preset-tonal"
                        disabled={locked}
                        onClick={() => setConfirm(null)}
                    >
                        Cancel
                    </button>
                </div>
            ) : null}
        </section>
    );
}
