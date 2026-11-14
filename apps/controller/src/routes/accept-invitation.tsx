import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { apiRequest } from "../lib/api";
import { getInvitationPreviewFn } from "../server/data";

export const Route = createFileRoute("/accept-invitation")({
    validateSearch: (search: Record<string, unknown>) => ({
        token: typeof search.token === "string" ? search.token : "",
    }),
    loaderDeps: ({ search }) => ({ token: search.token }),
    loader: ({ deps }) => getInvitationPreviewFn({ data: { token: deps.token } }),
    component: AcceptInvitation,
});

function AcceptInvitation() {
    const { token } = Route.useSearch();
    const invitation = Route.useLoaderData();
    const router = useRouter();
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);
    const [done, setDone] = useState<"joined" | "created" | null>(null);

    if (!invitation) {
        return (
            <main className="mx-auto max-w-md px-6 py-12">
                <p role="alert">
                    This invitation is not valid. It may have expired or been revoked.
                </p>
            </main>
        );
    }

    async function accept(extra: Record<string, string> = {}) {
        setPending(true);
        setError(null);
        const result = await apiRequest("POST", "/invitations/accept", { token, ...extra });
        setPending(false);
        if (!result.ok) {
            setError(result.message);
            return;
        }
        setDone(invitation?.accountExists ? "joined" : "created");
        await router.invalidate();
    }

    return (
        <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 px-6">
            <h1 className="h2">Join {invitation.organizationName}</h1>
            <p>
                You were invited as <strong>{invitation.role}</strong> ({invitation.email}).
            </p>
            {done ? (
                <p role="status">
                    {done === "joined" ? "You joined the organization." : "Your account is ready."}{" "}
                    <Link className="anchor" to="/login" search={{ next: "/" }}>
                        Continue to Launchpad
                    </Link>
                </p>
            ) : invitation.accountExists ? (
                invitation.signedInAsInvitee ? (
                    <button
                        className="btn preset-filled"
                        type="button"
                        disabled={pending}
                        onClick={() => accept()}
                    >
                        {pending ? "Joining…" : "Accept invitation"}
                    </button>
                ) : (
                    <p>
                        Sign in as {invitation.email} to accept.{" "}
                        <Link
                            className="anchor"
                            to="/login"
                            search={{
                                next: `/accept-invitation?token=${encodeURIComponent(token)}`,
                            }}
                        >
                            Sign in
                        </Link>
                    </p>
                )
            ) : (
                <form
                    className="space-y-4"
                    onSubmit={(event) => {
                        event.preventDefault();
                        const data = new FormData(event.currentTarget);
                        void accept({
                            name: String(data.get("name") ?? ""),
                            password: String(data.get("password") ?? ""),
                        });
                    }}
                >
                    <label className="label">
                        <span className="label-text">Your name</span>
                        <input className="input" name="name" required maxLength={80} />
                    </label>
                    <label className="label">
                        <span className="label-text">Password (12-128 characters)</span>
                        <input
                            className="input"
                            name="password"
                            type="password"
                            autoComplete="new-password"
                            minLength={12}
                            maxLength={128}
                            required
                        />
                    </label>
                    <button className="btn preset-filled w-full" type="submit" disabled={pending}>
                        {pending ? "Creating account…" : "Create account and join"}
                    </button>
                </form>
            )}
            {error ? (
                <p role="alert" className="text-error-500">
                    {error}
                </p>
            ) : null}
        </main>
    );
}
