import { afterEach, describe, expect, it, vi } from "vitest";
import {
    issueKey,
    keyInput,
    readKeys,
    attemptCandidate,
    snapshotAttempt,
    revealNotice,
    keySessionFreshness,
    type KeySummary,
    requestSignal,
} from "./api-keys";

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
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("dashboard key issuance", () => {
    it("composes cancellation and timeouts without AbortSignal static helpers and cleans up", () => {
        vi.useFakeTimers();
        vi.spyOn(AbortSignal, "any").mockImplementation(() => {
            throw new Error("Unavailable");
        });
        vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
            throw new Error("Unavailable");
        });
        const parent = new AbortController();
        const linked = requestSignal(parent.signal);
        parent.abort();
        expect(linked.signal.aborted).toBe(true);
        linked.dispose();
        expect(vi.getTimerCount()).toBe(0);

        const detachedParent = new AbortController();
        const detached = requestSignal(detachedParent.signal);
        detached.dispose();
        detachedParent.abort();
        expect(detached.signal.aborted).toBe(false);
        const timed = requestSignal();
        vi.advanceTimersByTime(30_000);
        expect(timed.signal.aborted).toBe(true);
        timed.dispose();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("does not send an issuance request already cancelled before submission", async () => {
        const parent = new AbortController();
        parent.abort();
        const fn = fetcher(json(revealed, 201));
        expect(
            await issueKey("org", payload(), fn as unknown as typeof fetch, parent.signal),
        ).toMatchObject({ kind: "rejected", status: 0 });
        expect(fn).not.toHaveBeenCalled();
    });

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

    it("uses a server-relative freshness duration, independent of the browser wall clock", () => {
        vi.spyOn(Date, "now").mockReturnValue(100 * 365 * 86_400_000);
        expect(keySessionFreshness(0, 10 * 60_000)).toEqual({
            fresh: true,
            remainingMs: 5 * 60_000,
        });
        expect(keySessionFreshness(0, 15 * 60_000)).toEqual({ fresh: false, remainingMs: 0 });
        expect(keySessionFreshness(0, 16 * 60_000)).toEqual({ fresh: false, remainingMs: 0 });
        expect(keySessionFreshness(16 * 60_000, 16 * 60_000)).toEqual({
            fresh: true,
            remainingMs: 15 * 60_000,
        });
    });

    it("uses the pre-submit ID snapshot instead of clocks to identify candidates", () => {
        const attempt = snapshotAttempt("ci", [summary]);
        const unseen = {
            ...summary,
            id: crypto.randomUUID(),
            createdAt: "1900-01-01T00:00:00.000Z",
        };
        expect(attemptCandidate(summary, attempt)).toBe(false);
        expect(
            attemptCandidate({ ...summary, createdAt: "2999-01-01T00:00:00.000Z" }, attempt),
        ).toBe(false);
        expect(attemptCandidate(unseen, attempt)).toBe(true);
        expect(attemptCandidate({ ...unseen, name: "other" }, attempt)).toBe(false);
        expect(attempt.knownIds).toEqual([summary.id]);
    });

    it("retains only non-secret identity for an abandoned reveal and marks its exact ID", () => {
        const notice = revealNotice(snapshotAttempt("ci", []), revealed);
        expect(notice).toMatchObject({
            name: "ci",
            keyId: revealed.id,
            prefix: revealed.secret.slice(0, 9),
        });
        expect(JSON.stringify(notice)).not.toContain(revealed.secret);
        expect(attemptCandidate(summary, notice)).toBe(true);
        expect(attemptCandidate({ ...summary, id: crypto.randomUUID() }, notice)).toBe(false);
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
