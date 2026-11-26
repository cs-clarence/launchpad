import { problemResponse, problemOfFailure } from "./database-problem";
import type { GateFailure, SchemaGate } from "./schema-gate";

// Liveness must not depend on the database, so a hung check cannot fail it. Fixed, and well
// under the Compose healthcheck timeout (tooling/compose-production.spec.ts guards that).
export const HEALTH_DEADLINE_MS = 2000;

export type Probe = "health" | "ready";

export function probeOf(request: Request): Probe | null {
    if (request.method !== "GET" && request.method !== "HEAD") return null;
    const { pathname } = new URL(request.url);
    if (pathname === "/api/health") return "health";
    if (pathname === "/api/ready") return "ready";
    return null;
}

export type Admission<R> = { ok: true; runtime: R } | { ok: false; failure: GateFailure };

// Decides whether a request may reach the API. `/api/health` is liveness: it is served unless
// the gate itself proved a schema mismatch (today's behavior, kept for compatibility), so an
// outage never fails the healthcheck. `/api/ready` runs the gate itself, with its own outcome
// table, so it always reaches the route.
export async function admit<R>(
    request: Request,
    deps: { gate: Pick<SchemaGate, "check">; runtime: () => R },
): Promise<Admission<R>> {
    const probe = probeOf(request);
    if (probe === "ready") {
        return { ok: true, runtime: deps.runtime() };
    }
    const outcome = await deps.gate.check(
        probe === "health" ? { deadlineMs: HEALTH_DEADLINE_MS } : {},
    );
    if (outcome.kind === "ok") {
        return { ok: true, runtime: deps.runtime() };
    }
    if (probe === "health" && outcome.kind !== "schema-mismatch") {
        return { ok: true, runtime: deps.runtime() };
    }
    return { ok: false, failure: outcome };
}

// The response for a refused request; an unclassified failure is rethrown, as it always was.
export function refusal(failure: GateFailure): Response {
    const problem = problemOfFailure(failure);
    if (!problem) {
        throw failure.error;
    }
    return problemResponse(problem);
}
