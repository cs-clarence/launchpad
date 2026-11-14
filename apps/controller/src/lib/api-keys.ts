import { apiKeySummarySchema, createApiKeySchema, createdApiKeySchema } from "@launchpad/contracts";
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
    try {
        const response = await doFetch(
            `/api/v1/organizations/${encodeURIComponent(organizationId)}/api-keys`,
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                credentials: "same-origin",
                cache: "no-store",
                redirect: "error",
                signal: signal
                    ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
                    : AbortSignal.timeout(30_000),
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
    }
}

export async function readKeys(organizationId: string): Promise<KeySummary[]> {
    const response = await fetch(
        `/api/v1/organizations/${encodeURIComponent(organizationId)}/api-keys`,
        {
            credentials: "same-origin",
            cache: "no-store",
            redirect: "error",
            signal: AbortSignal.timeout(30_000),
        },
    );
    if (!response.ok) throw new Error("Could not refresh the key list.");
    return z.array(apiKeySummarySchema.loose()).parse(await response.json());
}

export function recentAttempt(key: KeySummary, attempt: { name: string; since: number }) {
    return key.name === attempt.name && Date.parse(key.createdAt) >= attempt.since - 60_000;
}
