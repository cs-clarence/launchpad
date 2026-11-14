import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { authClient } from "../lib/auth-client";
import { safeNext } from "../lib/safe-next";
import { getFeaturesFn } from "../server/data";
import { getCurrentUser } from "../server/session";

export const Route = createFileRoute("/login")({
    validateSearch: (search: Record<string, unknown>): { next?: string } => {
        const next = safeNext(search.next);
        return next ? { next } : {};
    },
    beforeLoad: async ({ search }) => {
        if (await getCurrentUser()) {
            throw redirect({ href: search.next ?? "/" });
        }
    },
    loader: () => getFeaturesFn(),
    component: Login,
});

function Login() {
    const navigate = useNavigate();
    const features = Route.useLoaderData();
    const { next } = Route.useSearch();
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);

    async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        setPending(true);
        setError(null);
        const result = await authClient.signIn.email({
            email: String(form.get("email") ?? ""),
            password: String(form.get("password") ?? ""),
        });
        setPending(false);
        if (result.error) {
            // Generic on purpose: do not reveal whether the account exists.
            setError(
                result.error.status === 429
                    ? "Too many attempts. Wait a minute and try again."
                    : "Invalid email or password.",
            );
            return;
        }
        await navigate({ href: next ?? "/" });
    }

    return (
        <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 px-6">
            <h1 className="h2">Sign in to Launchpad</h1>
            <form className="space-y-4" onSubmit={onSubmit}>
                <label className="label">
                    <span className="label-text">Email</span>
                    <input
                        className="input"
                        name="email"
                        type="email"
                        autoComplete="username"
                        required
                    />
                </label>
                <label className="label">
                    <span className="label-text">Password</span>
                    <input
                        className="input"
                        name="password"
                        type="password"
                        autoComplete="current-password"
                        required
                    />
                </label>
                {error ? (
                    <p role="alert" className="text-error-500">
                        {error}
                    </p>
                ) : null}
                <button className="btn preset-filled w-full" type="submit" disabled={pending}>
                    {pending ? "Signing in…" : "Sign in"}
                </button>
            </form>
            {features.emailRecovery ? (
                <Link className="anchor" to="/forgot-password">
                    Forgot your password?
                </Link>
            ) : null}
        </main>
    );
}
