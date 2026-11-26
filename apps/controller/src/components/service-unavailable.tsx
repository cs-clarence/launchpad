import { useRouter } from "@tanstack/react-router";
import { describeProblem } from "../lib/problem";

// What a page shows when loading it failed: a plain statement of what is wrong and a retry,
// never the error's own text (it can carry addresses or other internals).
export function ErrorPage({ error }: { error: unknown }) {
    const router = useRouter();
    const problem = describeProblem(error);
    return (
        <main className="mx-auto max-w-4xl space-y-4 px-6 py-12">
            <div role="alert" className="space-y-2">
                <h1 className="h2">{problem?.title ?? "Something went wrong"}</h1>
                <p>
                    {problem?.text ??
                        "Launchpad could not load this page. Try again, and if it keeps happening, tell the instance operator."}
                </p>
            </div>
            <button className="btn preset-tonal" type="button" onClick={() => router.invalidate()}>
                Retry
            </button>
        </main>
    );
}
