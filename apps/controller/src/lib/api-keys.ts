import {
    apiKeySummarySchema,
    createApiKeySchema,
    createdApiKeySchema,
} from "@launchpad-kit/contracts";
import { z } from "zod";

const revealSchema = createdApiKeySchema
    .pick({
        id: true,
        name: true,
        secret: true,
        expiresAt: true,
    })
    .extend({ secret: z.string().regex(/^lp_[A-Za-z0-9_-]{20,200}$/) })
    .loose();
export type RevealedKey = z.infer<typeof revealSchema>;
export type KeySummary = z.infer<typeof apiKeySummarySchema>;
export interface KeyAttempt {
    name: string;
    knownIds: string[];
    keyId?: string;
    prefix?: string;
}

// Both values come from the server. The browser schedules a duration; it never
// compares its own wall clock with a server/database timestamp.
export function keySessionFreshness(createdAt: number, serverNow: number) {
    const remainingMs = Math.max(0, createdAt + 15 * 60 * 1000 - serverNow);
    return { fresh: remainingMs > 0, remainingMs };
}

export function snapshotAttempt(name: string, keys: KeySummary[]): KeyAttempt {
    return { name, knownIds: keys.map((key) => key.id) };
}

export function revealNotice(attempt: KeyAttempt, key: RevealedKey): KeyAttempt {
    return { ...attempt, keyId: key.id, prefix: key.secret.slice(0, 9) };
}

// Avoid AbortSignal.any/timeout: older supported browsers have AbortController
// but not these static helpers. Always release the timer and parent listener.
export function requestSignal(parent?: AbortSignal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (parent?.aborted) abort();
    else parent?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 30_000);
    return {
        signal: controller.signal,
        dispose() {
            clearTimeout(timer);
            parent?.removeEventListener("abort", abort);
        },
    };
}
export type IssueOutcome =
    | { kind: "issued"; key: RevealedKey }
    | { kind: "rejected"; status: number; message: string }
    | { kind: "uncertain" };

export function keyInput(form: FormData) {
    return createApiKeySchema.parse({
        name: form.get("name"),
        scopes: form.getAll("scopes"),
        expiresInDays: Number(form.get("expiresInDays")),
        projectIds: form.get("limit") === "on" ? form.getAll("projectIds") : undefined,
    });
}

// Never retry issuance. Failure to receive a valid reveal does not establish
// failure to create the key; the caller must inspect the list and revoke it.
export async function issueKey(
    organizationId: string,
    input: z.input<typeof createApiKeySchema>,
    doFetch: typeof fetch = fetch,
    signal?: AbortSignal,
): Promise<IssueOutcome> {
    if (signal?.aborted) {
        return { kind: "rejected", status: 0, message: "Issuance was cancelled before sending." };
    }
    const lifetime = requestSignal(signal);
    try {
        const response = await doFetch(
            `/api/v1/organizations/${encodeURIComponent(organizationId)}/api-keys`,
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                credentials: "same-origin",
                cache: "no-store",
                redirect: "error",
                signal: lifetime.signal,
                body: JSON.stringify(input),
            },
        );
        const body: unknown = await response.json().catch(() => null);
        if (response.status === 201) {
            const result = revealSchema.safeParse(body);
            return result.success ? { kind: "issued", key: result.data } : { kind: "uncertain" };
        }
        if (response.status >= 400 && response.status < 500) {
            const problem = z.object({ title: z.string() }).safeParse(body);
            return {
                kind: "rejected",
                status: response.status,
                message: problem.success ? problem.data.title : "The request was rejected.",
            };
        }
        return { kind: "uncertain" };
    } catch {
        return { kind: "uncertain" };
    } finally {
        lifetime.dispose();
    }
}

export async function readKeys(organizationId: string): Promise<KeySummary[]> {
    const lifetime = requestSignal();
    try {
        const response = await fetch(
            `/api/v1/organizations/${encodeURIComponent(organizationId)}/api-keys`,
            {
                credentials: "same-origin",
                cache: "no-store",
                redirect: "error",
                signal: lifetime.signal,
            },
        );
        if (!response.ok) throw new Error("Could not refresh the key list.");
        return z.array(apiKeySummarySchema.loose()).parse(await response.json());
    } finally {
        lifetime.dispose();
    }
}

export function attemptCandidate(key: KeySummary, attempt: KeyAttempt) {
    if (attempt.keyId) return key.id === attempt.keyId;
    return key.name === attempt.name && !attempt.knownIds.includes(key.id);
}
