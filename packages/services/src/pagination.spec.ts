// Unit tests: cursor encoding and query parsing. No database; the SQL is tested in __tests__/pagination.spec.ts.
import { describe, expect, it } from "vitest";
import { ServiceError } from "./errors";
import { decodeCursor, encodeCursor, parsePageQuery, type PageSpec } from "./pagination";

const spec: PageSpec = {
    route: "apps",
    organizationId: "org1",
    keys: [
        { ref: "app.created_at", type: "timestamptz" },
        { ref: "app.id", type: "uuid" },
    ],
};
const values = ["2026-01-01T00:00:00.123456Z", "6f1d2c3e-1111-4222-8333-444455556666"];
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const good = { v: 1, r: "apps", o: "org1", k: [values[0]], id: values[1] };

function invalid(run: () => unknown) {
    try {
        run();
    } catch (error) {
        expect(error).toBeInstanceOf(ServiceError);
        expect((error as ServiceError).code).toBe("invalid");
        return;
    }
    throw new Error("expected an invalid error");
}

describe("page query", () => {
    const parse = (query: string) => parsePageQuery(new URLSearchParams(query));

    it("is absent without a limit, so unpaginated calls are untouched", () => {
        expect(parse("")).toBeUndefined();
        expect(parse("other=1")).toBeUndefined();
    });

    it("accepts 1 to 100 and an optional cursor", () => {
        expect(parse("limit=1")).toEqual({ limit: 1 });
        expect(parse("limit=100&cursor=abc")).toEqual({ limit: 100, cursor: "abc" });
    });

    it("refuses anything else", () => {
        for (const query of [
            "limit=0",
            "limit=101",
            "limit=-1",
            "limit=abc",
            "limit=2.5",
            "limit=1e2",
            "limit=01",
            "limit=",
            "limit=1&limit=2",
            "limit=1&cursor=a&cursor=b",
            "cursor=abc",
            "limit=1&cursor=",
        ]) {
            invalid(() => parse(query));
        }
    });
});

describe("cursor", () => {
    it("round-trips", () => {
        expect(decodeCursor(spec, encodeCursor(spec, values)).values).toEqual(values);
    });

    it("refuses tampered, foreign and malformed cursors", () => {
        for (const bad of [
            "not*base64",
            Buffer.from("nope").toString("base64url"),
            encode([]),
            encode({ ...good, v: 2 }),
            encode({ ...good, extra: 1 }),
            encode({ ...good, r: "projects" }),
            encode({ ...good, o: "org2" }),
            encode({ ...good, id: "not-a-uuid" }),
            encode({ ...good, k: ["2026-01-01"] }),
            encode({ ...good, k: ["2026-13-45T00:00:00.123456Z"] }),
            encode({ ...good, k: ["2026-02-30T00:00:00.123456Z"] }),
            encode({ ...good, k: [] }),
            encode({ ...good, k: [1] }),
            "A".repeat(600),
        ]) {
            invalid(() => decodeCursor(spec, bad));
        }
    });
});
