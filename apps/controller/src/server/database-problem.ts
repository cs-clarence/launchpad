import { classifyDatabaseError } from "@launchpad-kit/database";
import { ServiceError } from "@launchpad-kit/services";
import { PROBLEM_MESSAGES } from "../lib/problem";
import { GateRejectedError, SchemaCheckTimeoutError, type GateFailure } from "./schema-gate";

// A database or data-directory problem as the API and the dashboard describe it. Never carries
// an error message, an address or a count.
export interface Problem {
    code: "schema-mismatch" | "database-unavailable" | "unavailable";
    status: 503;
    title: string;
    retryAfter?: number;
}

const TITLES = {
    "schema-mismatch": "Service Unavailable",
    "database-unavailable": "The database is unavailable.",
    unavailable: "The data directory is unavailable.",
} as const;
const NOT_READY = "The service is not ready.";
const RETRY_AFTER_SECONDS = 5;

function problem(code: Problem["code"], title: string = TITLES[code]): Problem {
    return {
        code,
        status: 503,
        title,
        ...(code === "database-unavailable" ? { retryAfter: RETRY_AFTER_SECONDS } : {}),
    };
}

// The gate's outcome as a problem. An unclassified failure has none on the request path (it
// stays an error); readiness never answers 500, so it reports one as not ready.
export function problemOfFailure(failure: GateFailure, readiness = false): Problem | null {
    if (failure.kind === "failed") {
        return readiness ? problem("unavailable", NOT_READY) : null;
    }
    return problem(failure.kind);
}

// A thrown error as a problem, or null when it is not one of the known database problems
// (it then stays an internal error).
export function databaseProblem(error: unknown): Problem | null {
    if (error instanceof GateRejectedError) {
        return problemOfFailure(error.failure);
    }
    if (error instanceof SchemaCheckTimeoutError) {
        return problem("database-unavailable");
    }
    const kind = classifyDatabaseError(error);
    if (kind === "schema") return problem("schema-mismatch");
    if (kind === "unreachable") return problem("database-unavailable");
    return null;
}

export function problemBody({ code, status, title }: Problem) {
    return { code, status, title };
}

export function problemHeaders(found: Problem): Record<string, string> {
    return found.retryAfter === undefined ? {} : { "retry-after": String(found.retryAfter) };
}

export function problemResponse(found: Problem): Response {
    return Response.json(problemBody(found), {
        status: found.status,
        headers: problemHeaders(found),
    });
}

// Runs a server function's body. A database or data-directory problem becomes an error whose
// message is a fixed code (the only thing that crosses to the browser, see lib/problem.ts), and
// the response carries 503 with Retry-After where the framework lets it; a missing or forbidden
// organization becomes the not-found code; anything else is rethrown unchanged.
export async function withDatabaseProblems<T>(run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (error) {
        const problem = databaseProblem(error);
        if (problem) {
            console.error("Database problem", error instanceof Error ? error.message : error);
            try {
                const { setResponseHeader, setResponseStatus } =
                    await import("@tanstack/react-start/server");
                setResponseStatus(problem.status);
                if (problem.retryAfter !== undefined) {
                    setResponseHeader("retry-after", String(problem.retryAfter));
                }
            } catch {
                // No request context (a unit test): the error below is what matters.
            }
            throw new Error(PROBLEM_MESSAGES[problem.code]);
        }
        if (error instanceof ServiceError && ["not-found", "forbidden"].includes(error.code)) {
            throw new Error(PROBLEM_MESSAGES["not-found"]);
        }
        throw error;
    }
}
