import { createFileRoute, Link, redirect, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { apiRequest } from "../lib/api";
import { getOrganizationViewFn } from "../server/data";
import { getCurrentUser } from "../server/session";

export const Route = createFileRoute("/orgs/$orgId")({
    beforeLoad: async () => {
        if (!(await getCurrentUser())) {
            throw redirect({ to: "/login" });
        }
    },
    loader: ({ params }) => getOrganizationViewFn({ data: { orgId: params.orgId } }),
    errorComponent: () => (
        <main className="mx-auto max-w-4xl px-6 py-12">
            <p role="alert">Organization not found.</p>
            <Link className="anchor" to="/">
                Back to organizations
            </Link>
        </main>
    ),
    component: Organization,
});

function useAction() {
    const router = useRouter();
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);
    async function run(call: () => ReturnType<typeof apiRequest>) {
        setPending(true);
        setError(null);
        try {
            const result = await call();
            if (!result.ok) {
                setError(result.message);
                return false;
            }
            // Still pending until the refreshed data is in: a second click during a
            // slow refresh would send a replacement invitation.
            await router.invalidate({ sync: true });
            return true;
        } finally {
            setPending(false);
        }
    }
    return { error, pending, run };
}

function Organization() {
    const view = Route.useLoaderData();
    const orgPath = `/organizations/${view.organization.id}`;
    const project = useAction();
    const member = useAction();
    const invite = useAction();

    return (
        <main className="mx-auto max-w-4xl space-y-10 px-6 py-12">
            <Link className="anchor" to="/">
                All organizations
            </Link>
            <h1 className="h2">
                {view.organization.name}{" "}
                <span className="badge preset-tonal">{view.organization.role}</span>
            </h1>

            <section className="space-y-4">
                <h2 className="h3">Projects</h2>
                {view.projects.length === 0 ? (
                    <p>No projects yet.</p>
                ) : (
                    <ul className="space-y-1">
                        {view.projects.map((p) => (
                            <li key={p.id}>
                                {p.name} <code>{p.slug}</code>
                            </li>
                        ))}
                    </ul>
                )}
                {view.can.createProject ? (
                    <form
                        className="space-y-4"
                        onSubmit={async (event) => {
                            event.preventDefault();
                            const form = event.currentTarget;
                            const data = new FormData(form);
                            const ok = await project.run(() =>
                                apiRequest("POST", `${orgPath}/projects`, {
                                    name: String(data.get("name") ?? ""),
                                    slug: String(data.get("slug") ?? ""),
                                }),
                            );
                            if (ok) form.reset();
                        }}
                    >
                        <label className="label">
                            <span className="label-text">Project name</span>
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
                        {project.error ? (
                            <p role="alert" className="text-error-500">
                                {project.error}
                            </p>
                        ) : null}
                        <button
                            className="btn preset-filled"
                            type="submit"
                            disabled={project.pending}
                        >
                            {project.pending ? "Creating…" : "Create project"}
                        </button>
                    </form>
                ) : (
                    <p>Your role cannot create projects.</p>
                )}
            </section>

            <section className="space-y-4">
                <h2 className="h3">Members</h2>
                <ul className="space-y-1">
                    {view.members.map((m) => (
                        <li key={m.userId} className="flex items-center gap-3">
                            <span>{m.email}</span>
                            <span className="badge preset-tonal">{m.role}</span>
                            {view.can.manageMembers || m.userId === view.you ? (
                                <button
                                    className="btn btn-sm preset-tonal"
                                    type="button"
                                    disabled={member.pending}
                                    onClick={() =>
                                        member.run(() =>
                                            apiRequest("DELETE", `${orgPath}/members/${m.userId}`),
                                        )
                                    }
                                >
                                    {m.userId === view.you ? "Leave" : "Remove"}
                                </button>
                            ) : null}
                        </li>
                    ))}
                </ul>
                {view.can.manageMembers ? (
                    <form
                        className="space-y-4"
                        onSubmit={async (event) => {
                            event.preventDefault();
                            const form = event.currentTarget;
                            const data = new FormData(form);
                            const ok = await member.run(() =>
                                apiRequest("POST", `${orgPath}/members`, {
                                    email: String(data.get("email") ?? ""),
                                    role: String(data.get("role") ?? ""),
                                }),
                            );
                            if (ok) form.reset();
                        }}
                    >
                        <label className="label">
                            <span className="label-text">Add existing user by email</span>
                            <input className="input" name="email" type="email" required />
                        </label>
                        <label className="label">
                            <span className="label-text">Role</span>
                            <select className="select" name="role" defaultValue="viewer">
                                <option value="viewer">viewer</option>
                                <option value="deployer">deployer</option>
                                <option value="admin">admin</option>
                                <option value="owner">owner</option>
                            </select>
                        </label>
                        <button
                            className="btn preset-filled"
                            type="submit"
                            disabled={member.pending}
                        >
                            {member.pending ? "Adding…" : "Add member"}
                        </button>
                    </form>
                ) : null}
                {view.invitations ? (
                    <div className="space-y-4">
                        <h3 className="h4">Invitations</h3>
                        {view.invitations.length === 0 ? (
                            <p>No pending invitations.</p>
                        ) : (
                            <ul className="space-y-1">
                                {view.invitations.map((i) => (
                                    <li key={i.id} className="flex items-center gap-3">
                                        <span>{i.email}</span>
                                        <span className="badge preset-tonal">{i.role}</span>
                                        <button
                                            className="btn btn-sm preset-tonal"
                                            type="button"
                                            disabled={invite.pending}
                                            onClick={() =>
                                                invite.run(() =>
                                                    apiRequest(
                                                        "DELETE",
                                                        `${orgPath}/invitations/${i.id}`,
                                                    ),
                                                )
                                            }
                                        >
                                            Revoke
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                        <form
                            className="space-y-4"
                            onSubmit={async (event) => {
                                event.preventDefault();
                                const form = event.currentTarget;
                                const data = new FormData(form);
                                const ok = await invite.run(() =>
                                    apiRequest("POST", `${orgPath}/invitations`, {
                                        email: String(data.get("email") ?? ""),
                                        role: String(data.get("role") ?? ""),
                                    }),
                                );
                                if (ok) form.reset();
                            }}
                        >
                            <label className="label">
                                <span className="label-text">Invite by email</span>
                                <input className="input" name="email" type="email" required />
                            </label>
                            <label className="label">
                                <span className="label-text">Role</span>
                                <select className="select" name="role" defaultValue="viewer">
                                    <option value="viewer">viewer</option>
                                    <option value="deployer">deployer</option>
                                    <option value="admin">admin</option>
                                    <option value="owner">owner</option>
                                </select>
                            </label>
                            {invite.error ? (
                                <p role="alert" className="text-error-500">
                                    {invite.error}
                                </p>
                            ) : null}
                            <button
                                className="btn preset-filled"
                                type="submit"
                                disabled={invite.pending}
                            >
                                {invite.pending ? "Sending…" : "Send invitation"}
                            </button>
                        </form>
                    </div>
                ) : null}
                {member.error ? (
                    <p role="alert" className="text-error-500">
                        {member.error}
                    </p>
                ) : null}
            </section>
        </main>
    );
}
