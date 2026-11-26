import { afterEach, describe, expect, it, vi } from "vitest";
import { apiCall, apiRequest } from "./api";

const respond = (body: unknown, status = 200) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

afterEach(() => vi.unstubAllGlobals());

describe("apiCall", () => {
    it("sends JSON, or a raw body with its own content type, and merges headers", async () => {
        const fetchMock = vi.fn(async () => respond({ id: "x" }));
        vi.stubGlobal("fetch", fetchMock);
        await apiCall("POST", "/a", { json: { n: 1 }, headers: { "idempotency-key": "k" } });
        const blob = new Blob(["abc"]);
        await apiCall("POST", "/b", { raw: { body: blob, contentType: "application/gzip" } });
        const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
        const first = calls[0]!;
        const second = calls[1]!;
        expect(first[0]).toBe("/api/v1/a");
        expect(first[1]).toMatchObject({
            method: "POST",
            body: '{"n":1}',
            headers: { "content-type": "application/json", "idempotency-key": "k" },
        });
        expect(second[1]).toMatchObject({
            body: blob,
            headers: { "content-type": "application/gzip" },
        });
    });

    it("says the database is unreachable in the page's words", async () => {
        vi.stubGlobal("fetch", async () =>
            respond(
                {
                    code: "database-unavailable",
                    status: 503,
                    title: "The database is unavailable.",
                },
                503,
            ),
        );
        expect(await apiCall("POST", "/a")).toEqual({
            ok: false,
            status: 503,
            message: "Launchpad can't reach its database. Try again in a moment.",
        });
        expect(await apiRequest("POST", "/a")).toEqual({
            ok: false,
            message: "Launchpad can't reach its database. Try again in a moment.",
        });
    });

    it("returns the answer, and the server's title with its status when refused", async () => {
        vi.stubGlobal("fetch", async () => respond({ id: "x" }, 201));
        expect(await apiCall("POST", "/a")).toEqual({ ok: true, data: { id: "x" } });
        vi.stubGlobal("fetch", async () => respond({ title: "Too big." }, 413));
        expect(await apiCall("POST", "/a")).toEqual({
            ok: false,
            status: 413,
            message: "Too big.",
        });
        vi.stubGlobal("fetch", async () => respond("not json", 502));
        expect(await apiCall("POST", "/a")).toEqual({
            ok: false,
            status: 502,
            message: "The request failed.",
        });
    });

    it("says so when an answer is not understood, and when none came", async () => {
        vi.stubGlobal("fetch", async () => respond("<html>", 200));
        expect(await apiCall("POST", "/a")).toMatchObject({ ok: false, status: 200 });
        vi.stubGlobal("fetch", async () => {
            throw new TypeError("failed");
        });
        const none = await apiCall("POST", "/a");
        expect(none).toMatchObject({ ok: false, status: null });
        expect(none.ok === false && none.message).toContain("could not be completed");
    });
});
