import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { apiRequest } from "../lib/api";
import {
    issueKey,
    keyInput,
    readKeys,
    recentAttempt,
    type KeySummary,
    type RevealedKey,
} from "../lib/api-keys";
import { authClient } from "../lib/auth-client";

const SCOPES = [
    ["organization:read", "Read this organization (needed for CLI org commands)"],
    ["project:read", "List projects"],
    ["project:create", "Create projects (unrestricted keys only)"],
    ["member:read", "Read all organization members, including their email addresses"],
] as const;

export function ApiKeys(props: {
    organizationId: string;
    keys: KeySummary[];
    projects: { id: string; name: string }[];
    fresh: boolean;
    freshUntil: number;
    paused: boolean;
    onSensitiveChange(locked: boolean): void;
}) {
    const navigate = useNavigate();
    const [keys, setKeys] = useState(props.keys);
    const [fresh, setFresh] = useState(props.fresh);
    const [revealed, setRevealed] = useState<RevealedKey | null>(null);
    const [uncertain, setUncertain] = useState<{ name: string; since: number } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [limited, setLimited] = useState(false);
    const [projects, setProjects] = useState<string[]>([]);
    const [confirm, setConfirm] = useState<KeySummary | null>(null);
    const [copied, setCopied] = useState(false);
    const working = useRef(false);
    const epoch = useRef(0);
    const request = useRef<AbortController | null>(null);
    const attempt = useRef<{ name: string; since: number } | null>(null);
    const secretField = useRef<HTMLInputElement>(null);

    useEffect(() => {
        props.onSensitiveChange(busy || revealed !== null);
        return () => props.onSensitiveChange(false);
    }, [busy, revealed, props.onSensitiveChange]);
    useEffect(() => {
        setFresh(Date.now() < props.freshUntil);
        const timer = setTimeout(() => setFresh(false), Math.max(0, props.freshUntil - Date.now()));
        return () => clearTimeout(timer);
    }, [props.freshUntil]);
    useEffect(() => {
        function clear() {
            epoch.current++;
            request.current?.abort();
            // Clear the DOM synchronously before bfcache can snapshot the page.
            if (secretField.current) secretField.current.value = "";
            setRevealed(null);
            setCopied(false);
            if (attempt.current) setUncertain(attempt.current);
        }
        const show = (event: PageTransitionEvent) => {
            if (event.persisted) clear();
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

    async function refresh() {
        try {
            setKeys(await readKeys(props.organizationId));
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
    const locked = busy || revealed !== null || props.paused;
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
                    Created: {key.createdAt}. Expires: {key.expiresAt}.
                </p>
                {uncertain && recentAttempt(key, uncertain) ? (
                    <p>
                        Possible result of the unconfirmed attempt. Revoke it if you did not save
                        its key.
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
                            setRevealed(null);
                            setCopied(false);
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
                                        const result = await authClient.signOut();
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
                                Issuance of “{uncertain.name}” could not be confirmed. It may have
                                succeeded. Check recent keys below and revoke any key you did not
                                save before trying again. No automatic retry was made.
                            </p>
                            <button
                                type="button"
                                className="btn preset-tonal"
                                disabled={busy}
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
                            if (working.current || props.paused || uncertain || !fresh) return;
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
                            const pending = { name: input.name, since: Date.now() };
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
                                    setRevealed(result.key);
                                    setConfirm(null);
                                } else if (result.kind === "rejected") {
                                    setError(result.message);
                                    if (result.status === 401 || result.status === 403)
                                        setFresh(false);
                                } else {
                                    setUncertain(pending);
                                    await refresh();
                                }
                            });
                            attempt.current = null;
                            request.current = null;
                        }}
                    >
                        <fieldset
                            className="space-y-3"
                            disabled={busy || props.paused || !fresh || uncertain !== null}
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
                                            defaultChecked={
                                                scope === "organization:read" ||
                                                scope === "project:read"
                                            }
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
                                    onChange={(event) => setLimited(event.target.checked)}
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
                                                onChange={(event) =>
                                                    setProjects((old) =>
                                                        event.target.checked
                                                            ? [...old, project.id]
                                                            : old.filter((id) => id !== project.id),
                                                    )
                                                }
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
                                const result = await apiRequest(
                                    "DELETE",
                                    `/organizations/${encodeURIComponent(props.organizationId)}/api-keys/${encodeURIComponent(confirm.id)}`,
                                );
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
