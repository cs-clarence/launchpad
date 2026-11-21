// Fault rules of the acceptance rehearsal's control-plane proxy. Pure, so the matching is unit
// tested without a container: the proxy itself only applies them.
export type FaultAction = "hold" | "drop-response";

export interface FaultRule {
    id: string;
    action: FaultAction;
    method: string;
    pathPrefix: string;
    // Every key must equal the same-named string field of the JSON request body.
    body: Record<string, string>;
    // A rule fires on its first matching request and is then spent.
    once: boolean;
}

export interface RequestShape {
    method: string;
    path: string;
    body: unknown;
}

export function matches(rule: FaultRule, request: RequestShape): boolean {
    if (rule.method !== request.method || !request.path.startsWith(rule.pathPrefix)) return false;
    const entries = Object.entries(rule.body);
    if (entries.length === 0) return true;
    if (typeof request.body !== "object" || request.body === null) return false;
    const record = request.body as Record<string, unknown>;
    return entries.every(([key, value]) => String(record[key]) === value && key in record);
}

// The first live rule that matches wins; a spent `once` rule is skipped.
export function pickRule(
    rules: FaultRule[],
    spent: ReadonlySet<string>,
    request: RequestShape,
): FaultRule | undefined {
    return rules.find((rule) => !(rule.once && spent.has(rule.id)) && matches(rule, request));
}

// The only request fields the proxy ever records: identifiers, never headers or tokens.
const RECORDED = [
    "hostname",
    "generation",
    "operationId",
    "aliasId",
    "targetDeploymentId",
] as const;

export function summarize(body: unknown): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    if (typeof body !== "object" || body === null) return out;
    const record = body as Record<string, unknown>;
    for (const key of RECORDED) {
        if (key in record) out[key] = record[key] === null ? null : String(record[key]);
    }
    return out;
}
