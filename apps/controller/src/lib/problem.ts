// How a problem on the server reaches a page. A server function error crosses to the browser as
// its message only (TanStack Start serializes the class, not its fields), so the server throws an
// error whose message is one of these fixed codes and the page reads them back. Never the
// original error's text.
export const PROBLEM_MESSAGES = {
    "database-unavailable": "launchpad:database-unavailable",
    "schema-mismatch": "launchpad:schema-mismatch",
    unavailable: "launchpad:unavailable",
    "not-found": "launchpad:not-found",
} as const;

export type ProblemCode = keyof typeof PROBLEM_MESSAGES;

export interface ProblemView {
    code: ProblemCode;
    title: string;
    text: string;
}

const VIEWS: Record<ProblemCode, Omit<ProblemView, "code">> = {
    "database-unavailable": {
        title: "Launchpad is unavailable",
        text: "Launchpad can't reach its database right now. Try again in a moment.",
    },
    "schema-mismatch": {
        title: "Launchpad needs attention",
        text: "Launchpad's database needs attention. The instance operator needs to run the upgrade or restore procedure.",
    },
    unavailable: {
        title: "Launchpad is unavailable",
        text: "Launchpad's storage is not available right now. Try again in a moment.",
    },
    "not-found": {
        title: "Not found",
        text: "Organization not found.",
    },
};

// The problem an error stands for, or null for anything else.
export function describeProblem(error: unknown): ProblemView | null {
    const message =
        typeof error === "object" && error !== null
            ? (error as { message?: unknown }).message
            : null;
    if (typeof message !== "string") return null;
    for (const code of Object.keys(PROBLEM_MESSAGES) as ProblemCode[]) {
        if (message === PROBLEM_MESSAGES[code]) return { code, ...VIEWS[code] };
    }
    return null;
}

// The sentence for a failed action, from the API's answer.
export function messageForProblem(problem: { code?: string; title?: string } | null): string {
    if (problem?.code === "database-unavailable") {
        return "Launchpad can't reach its database. Try again in a moment.";
    }
    return problem?.title ?? "The request failed.";
}
