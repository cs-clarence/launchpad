import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { authClient } from "../lib/auth-client";

export const Route = createFileRoute("/reset-password")({
    validateSearch: (search: Record<string, unknown>) => ({
        token: typeof search.token === "string" ? search.token : "",
    }),
    component: ResetPassword,
});

function ResetPassword() {
    const { token } = Route.useSearch();
    const navigate = useNavigate();
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);

    async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        setPending(true);
        setError(null);
        let result: Awaited<ReturnType<typeof authClient.resetPassword>>;
        try {
            result = await authClient.resetPassword({
                newPassword: String(data.get("password") ?? ""),
                token,
            });
        } catch {
            setError("Could not reach the server. Check your connection and retry.");
            return;
        } finally {
            setPending(false);
        }
        if (result.error) {
            setError(
                "This reset link is invalid or has expired, or the password is not acceptable.",
            );
            return;
        }
        await navigate({ to: "/login", search: { next: "/" } });
    }

    return (
        <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 px-6">
            <h1 className="h2">Choose a new password</h1>
            {token ? (
                <form className="space-y-4" onSubmit={onSubmit}>
                    <label className="label">
                        <span className="label-text">New password (12-128 characters)</span>
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
                    {error ? (
                        <p role="alert" className="text-error-500">
                            {error}
                        </p>
                    ) : null}
                    <button className="btn preset-filled w-full" type="submit" disabled={pending}>
                        {pending ? "Saving…" : "Set password"}
                    </button>
                </form>
            ) : (
                <p role="alert">This reset link is incomplete.</p>
            )}
            <Link className="anchor" to="/login" search={{ next: "/" }}>
                Back to sign in
            </Link>
        </main>
    );
}
