import { createFileRoute, Link, redirect, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { apiRequest } from "../lib/api";
import { authClient } from "../lib/auth-client";
import { listOrganizationsFn } from "../server/data";
import { getCurrentUser } from "../server/session";

export const Route = createFileRoute("/")({
    beforeLoad: async () => {
        const user = await getCurrentUser();
        if (!user) {
            throw redirect({ to: "/login" });
        }
        return { user };
    },
    loader: () => listOrganizationsFn(),
    component: Home,
});

function Home() {
    const { user } = Route.useRouteContext();
    const organizations = Route.useLoaderData();
    const router = useRouter();

    async function signOut() {
        await authClient.signOut();
        await router.navigate({ to: "/login" });
    }

    return (
        <div className="min-h-screen">
            <header className="flex items-center justify-between border-b border-surface-200-800 px-6 py-4">
                <span className="text-xl font-bold">Launchpad</span>
                <span className="flex items-center gap-4">
                    <span>{user.email}</span>
                    <button className="btn preset-tonal" type="button" onClick={signOut}>
                        Sign out
                    </button>
                </span>
            </header>
            <main className="mx-auto max-w-4xl space-y-8 px-6 py-12">
                <section className="space-y-4">
                    <h1 className="h2">Organizations</h1>
                    {organizations.length === 0 ? (
                        <p>
                            You are not a member of any organization.
                            {user.role === "operator"
                                ? " Create one below and name its first owner."
                                : " Ask the operator to add you to one."}
                        </p>
                    ) : (
                        <ul className="space-y-2">
                            {organizations.map((org) => (
                                <li key={org.id}>
                                    <Link
                                        className="anchor"
                                        to="/orgs/$orgId"
                                        params={{ orgId: org.id }}
                                    >
                                        {org.name}
                                    </Link>{" "}
                                    <span className="badge preset-tonal">{org.role}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
                {user.role === "operator" ? <CreateOrganization /> : null}
            </main>
        </div>
    );
}

function CreateOrganization() {
    const router = useRouter();
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);

    async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const form = event.currentTarget;
        const data = new FormData(form);
        setPending(true);
        setError(null);
        const result = await apiRequest("POST", "/organizations", {
            name: String(data.get("name") ?? ""),
            slug: String(data.get("slug") ?? ""),
            ownerEmail: String(data.get("ownerEmail") ?? ""),
        });
        setPending(false);
        if (!result.ok) {
            setError(result.message);
            return;
        }
        form.reset();
        await router.invalidate();
    }

    return (
        <section className="space-y-4">
            <h2 className="h3">Create organization</h2>
            <form className="space-y-4" onSubmit={onSubmit}>
                <label className="label">
                    <span className="label-text">Name</span>
                    <input className="input" name="name" required maxLength={80} />
                </label>
                <label className="label">
                    <span className="label-text">Slug</span>
                    <input
                        className="input"
                        name="slug"
                        required
                        pattern="[a-z0-9]([a-z0-9\-]{0,38}[a-z0-9])?"
                    />
                </label>
                <label className="label">
                    <span className="label-text">Owner email (existing user)</span>
                    <input className="input" name="ownerEmail" type="email" required />
                </label>
                {error ? (
                    <p role="alert" className="text-error-500">
                        {error}
                    </p>
                ) : null}
                <button className="btn preset-filled" type="submit" disabled={pending}>
                    {pending ? "Creating…" : "Create organization"}
                </button>
            </form>
        </section>
    );
}
