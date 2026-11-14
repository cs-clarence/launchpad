import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
    return (
        <div className="min-h-screen">
            <header className="border-b border-surface-200-800 px-6 py-4">
                <span className="text-xl font-bold">Launchpad</span>
            </header>
            <main className="mx-auto max-w-4xl space-y-4 px-6 py-12">
                <h1 className="h1">Controller scaffold</h1>
                <p>TanStack Start, React, Skeleton 5, and Elysia are wired up.</p>
                <p>Deployments, authentication, and Dokku connectivity are not implemented.</p>
            </main>
        </div>
    );
}
