import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { authClient } from "../lib/auth-client";
import { getFeaturesFn } from "../server/data";

export const Route = createFileRoute("/forgot-password")({
    beforeLoad: async () => {
        if (!(await getFeaturesFn()).emailRecovery) {
            throw redirect({ to: "/login", search: { next: "/" } });
        }
    },
    component: ForgotPassword,
});

function ForgotPassword() {
    const [sent, setSent] = useState(false);
    const [pending, setPending] = useState(false);

    async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        setPending(true);
        await authClient.requestPasswordReset({ email: String(data.get("email") ?? "") });
        setPending(false);
        // Identical whether or not the address exists or can receive mail.
        setSent(true);
    }

    return (
        <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 px-6">
            <h1 className="h2">Reset your password</h1>
            {sent ? (
                <p role="status">If that address can receive a reset email, one is on its way.</p>
            ) : (
                <form className="space-y-4" onSubmit={onSubmit}>
                    <label className="label">
                        <span className="label-text">Email</span>
                        <input className="input" name="email" type="email" required />
                    </label>
                    <button className="btn preset-filled w-full" type="submit" disabled={pending}>
                        {pending ? "Sending…" : "Send reset link"}
                    </button>
                </form>
            )}
            <Link className="anchor" to="/login" search={{ next: "/" }}>
                Back to sign in
            </Link>
        </main>
    );
}
