import { afterEach, describe, expect, it, vi } from "vitest";
import { issueKey, keyInput, readKeys, recentAttempt, type KeySummary } from "./api-keys";

const input = {
    name: "ci",
    scopes: ["organization:read", "project:read"] as const,
    expiresInDays: 30,
};
const payload = () => ({ ...input, scopes: [...input.scopes] });
const revealed = {
    id: crypto.randomUUID(),
    name: "ci",
    secret: `lp_${"a".repeat(43)}`,
    expiresAt: "2027-01-01T00:00:00.000Z",
};
const summary: KeySummary = {
    id: revealed.id,
    name: "ci",
    prefix: "lp_aaaaaa",
    scopes: ["project:read"],
    projectIds: null,
    createdBy: "user-1",
    createdAt: "2026-11-15T00:00:00.000Z",
    expiresAt: revealed.expiresAt,
    revokedAt: null,
    lastUsedAt: null,
    status: "active" as const,
};
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status });
const fetcher = (response: Response) => vi.fn(async () => response);
afterEach(() => vi.restoreAllMocks());

describe("dashboard key issuance", () => {
    it("reveals a validated 201 response, tolerates extra fields and never retries", async () => {
        const fn = fetcher(json({ ...revealed, future: true }, 201));
        const result = await issueKey("org/1", payload(), fn as unknown as typeof fetch);
        expect(result).toMatchObject({ kind: "issued", key: revealed });
        expect(fn).toHaveBeenCalledTimes(1);
        expect(fn).toHaveBeenCalledWith(
            "/api/v1/organizations/org%2F1/api-keys",
            expect.objectContaining({
                method: "POST",
                credentials: "same-origin",
                redirect: "error",
                cache: "no-store",
                signal: expect.any(AbortSignal),
            }),
        );
    });

    it.each([401, 403, 422, 429])(
        "keeps a %s rejection distinct from an uncertain issue",
        async (status) => {
            const fn = fetcher(json({ title: "Rejected" }, status));
            expect(await issueKey("org", payload(), fn as unknown as typeof fetch)).toEqual({
                kind: "rejected",
                status,
                message: "Rejected",
            });
            expect(fn).toHaveBeenCalledTimes(1);
        },
    );

    it("treats network, timeout, server errors and malformed successes as uncertain, with no retry", async () => {
        for (const response of [
            json({ title: "Upstream error" }, 502),
            json({ title: "Unavailable" }, 503),
            json({ ...revealed, secret: "bad-key" }, 201),
            json({ ...revealed, id: "not-a-uuid" }, 201),
            json(revealed, 200),
            new Response("not JSON", { status: 201 }),
        ]) {
            const fn = fetcher(response);
            expect(await issueKey("org", payload(), fn as unknown as typeof fetch)).toEqual({
                kind: "uncertain",
            });
            expect(fn).toHaveBeenCalledTimes(1);
        }
        for (const error of [
            new TypeError("network"),
            new DOMException("timeout", "TimeoutError"),
        ]) {
            const fn = vi.fn(async () => {
                throw error;
            });
            expect(await issueKey("org", payload(), fn as unknown as typeof fetch)).toEqual({
                kind: "uncertain",
            });
            expect(fn).toHaveBeenCalledTimes(1);
        }
    });

    it("builds read-only or restricted inputs and rejects empty or conflicting selections", () => {
        const form = new FormData();
        form.set("name", "ci");
        form.append("scopes", "organization:read");
        form.append("scopes", "project:read");
        form.set("expiresInDays", "30");
        expect(keyInput(form)).toEqual(payload());
        form.set("limit", "on");
        expect(() => keyInput(form)).toThrow();
        const project = crypto.randomUUID();
        form.append("projectIds", project);
        expect(keyInput(form).projectIds).toEqual([project]);
        form.append("scopes", "project:create");
        expect(() => keyInput(form)).toThrow();
        form.delete("scopes");
        expect(() => keyInput(form)).toThrow();
    });

    it("identifies only recent same-name candidates after an uncertain request", () => {
        const attempt = { name: "ci", since: Date.parse(summary.createdAt) };
        expect(recentAttempt(summary, attempt)).toBe(true);
        expect(recentAttempt({ ...summary, name: "other" }, attempt)).toBe(false);
        expect(recentAttempt({ ...summary, createdAt: "2020-01-01T00:00:00.000Z" }, attempt)).toBe(
            false,
        );
    });

    it("refreshes metadata with GET, validates it and never requests a secret", async () => {
        const mock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json([summary], 200));
        expect(await readKeys("org")).toEqual([summary]);
        expect(mock).toHaveBeenCalledWith(
            "/api/v1/organizations/org/api-keys",
            expect.objectContaining({
                cache: "no-store",
                credentials: "same-origin",
            }),
        );
        mock.mockResolvedValueOnce(json({ title: "Denied" }, 403));
        await expect(readKeys("org")).rejects.toThrow();
    });
});
