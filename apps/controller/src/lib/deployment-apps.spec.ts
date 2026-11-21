import { describe, expect, it } from "vitest";
import { eligibleTargets, routeIntent, type Alias, type Deployment } from "./deployment-apps";

const alias: Alias = {
    id: "alias",
    appId: "app",
    slug: "production",
    hostname: "production.example.net",
    state: "bound",
    targetDeploymentId: "current",
    reservedGeneration: "9007199254740993",
    committedGeneration: "5",
    createdAt: "2026-11-21T00:00:00Z",
};
const deployment: Deployment = {
    id: "older",
    appId: "app",
    status: "succeeded",
    desiredState: "active",
    hostname: "release.example.net",
    spa: false,
    createdAt: alias.createdAt,
    finishedAt: alias.createdAt,
    expiresAt: alias.createdAt,
    failureCode: null,
    failureMessage: null,
};

describe("dashboard routing intent", () => {
    it("offers retained succeeded targets, including an older rollback target", () => {
        expect(
            eligibleTargets(alias, [
                deployment,
                { ...deployment, id: "current" },
                { ...deployment, id: "failed", status: "failed" },
                { ...deployment, id: "deleting", desiredState: "deleting" },
                { ...deployment, id: "unrelated", appId: "other" },
            ]),
        ).toEqual([deployment]);
    });

    it("uses the exact reserved generation and separates withdrawal and promotion retries", () => {
        const promotion = routeIntent("/organizations/org", alias, "older");
        const withdrawal = routeIntent("/organizations/org", alias);
        expect(promotion).toMatchObject({
            method: "POST",
            path: "/organizations/org/aliases/alias/promotions",
            json: { expectedGeneration: "9007199254740993", targetDeploymentId: "older" },
        });
        expect(withdrawal).toMatchObject({
            method: "DELETE",
            json: { expectedGeneration: "9007199254740993" },
        });
        expect(promotion.fingerprint).not.toBe(withdrawal.fingerprint);
        expect(routeIntent("/organizations/org", alias, "older").fingerprint).toBe(
            promotion.fingerprint,
        );
        expect(
            routeIntent(
                "/organizations/org",
                { ...alias, reservedGeneration: "9007199254740994" },
                "older",
            ).fingerprint,
        ).not.toBe(promotion.fingerprint);
    });
});
