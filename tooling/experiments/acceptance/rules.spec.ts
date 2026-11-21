import { describe, expect, it } from "bun:test";
import { matches, pickRule, summarize, type FaultRule } from "./rules";

const rule = (over: Partial<FaultRule> = {}): FaultRule => ({
    id: "r1",
    action: "hold",
    method: "POST",
    pathPrefix: "/v1/routes",
    body: { hostname: "a.example", generation: "3" },
    once: true,
    ...over,
});
const write = {
    method: "POST",
    path: "/v1/routes",
    body: { hostname: "a.example", generation: 3 },
};

describe("fault rules", () => {
    it("matches by method, path prefix and string-compared body fields", () => {
        expect(matches(rule(), write)).toBe(true);
        expect(matches(rule(), { ...write, method: "GET" })).toBe(false);
        expect(matches(rule(), { ...write, path: "/v1/deployments" })).toBe(false);
        expect(matches(rule(), { ...write, body: { hostname: "a.example", generation: 4 } })).toBe(
            false,
        );
        expect(matches(rule(), { ...write, body: { hostname: "a.example" } })).toBe(false);
        expect(matches(rule(), { ...write, body: null })).toBe(false);
        expect(matches(rule({ body: {} }), { ...write, body: null })).toBe(true);
    });

    it("spends a once rule on its first match only", () => {
        const rules = [rule()];
        expect(pickRule(rules, new Set(), write)?.id).toBe("r1");
        expect(pickRule(rules, new Set(["r1"]), write)).toBeUndefined();
        expect(pickRule([rule({ once: false })], new Set(["r1"]), write)?.id).toBe("r1");
    });

    it("records identifiers only", () => {
        expect(
            summarize({ hostname: "h", generation: 7, targetDeploymentId: null, token: "secret" }),
        ).toEqual({ hostname: "h", generation: "7", targetDeploymentId: null });
        expect(summarize("not an object")).toEqual({});
    });
});
