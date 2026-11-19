import { describe, expect, it } from "vitest";
import { parseAppRoutingConfig } from "./app-routing-config";

const valid = {
    LAUNCHPAD_APPS_DOMAIN: "sites.example.net",
    LAUNCHPAD_APPS_PROXY_URL: "http://dokku:80",
    LAUNCHPAD_ALIAS_CONTROL_URL: "https://router.internal:8443/control",
    LAUNCHPAD_ALIAS_PROBE_URL: "http://router.internal:8080",
    LAUNCHPAD_ALIAS_INSTANCE_ID: "0b0e5d2e-6a3f-4c2b-9d8a-1f2e3d4c5b6a",
    LAUNCHPAD_ALIAS_CONTROL_TOKEN_FILE: "/run/secrets/alias_token",
    LAUNCHPAD_ALIAS_ROUTER_EPOCH_FILE: "/var/lib/launchpad/router-epoch",
};

describe("parseAppRoutingConfig", () => {
    it("is off, and reads nothing else, while the apps domain is unset", () => {
        expect(parseAppRoutingConfig({})).toEqual({ enabled: false });
        expect(parseAppRoutingConfig({ LAUNCHPAD_APPS_DOMAIN: "" })).toEqual({ enabled: false });
        // A preview-era name is the migration case: refused even before the new domain is set.
        expect(() =>
            parseAppRoutingConfig({ LAUNCHPAD_PREVIEW_DOMAIN: "previews.example.com" }),
        ).toThrow("LAUNCHPAD_APPS_DOMAIN");
    });

    it("applies the documented defaults", () => {
        const config = parseAppRoutingConfig(valid);
        if (!config.enabled) throw new Error("expected enabled");
        expect(config.rollbackRetentionSeconds).toBe(7 * 86_400);
        expect([config.maxApps, config.maxDeployments, config.maxDeploymentsPerApp]).toEqual([
            10, 100, 20,
        ]);
        expect([config.maxAliases, config.maxAliasesPerApp]).toEqual([100, 10]);
        expect(config.deploymentTemplate.source).toBe("{slug}-{id}-preview");
        expect(config.aliasTemplate.source).toBe("view-{slug}-{id}");
        expect(config.aliasControlTokenFile).toBe("/run/secrets/alias_token");
    });

    it("accepts rearranged templates", () => {
        const config = parseAppRoutingConfig({
            ...valid,
            LAUNCHPAD_ALIAS_HOSTNAME_TEMPLATE: "{slug}-{id}-view",
        });
        expect(config.enabled && config.aliasTemplate.source).toBe("{slug}-{id}-view");
    });

    it.each(Object.keys(valid).slice(1))("requires %s once the domain is set", (name) => {
        expect(() => parseAppRoutingConfig({ ...valid, [name]: undefined })).toThrow(name);
        expect(() => parseAppRoutingConfig({ ...valid, [name]: "" })).toThrow(name);
    });

    it("refuses the preview-era settings with a pointer to the new one", () => {
        expect(() =>
            parseAppRoutingConfig({ ...valid, LAUNCHPAD_PREVIEW_DOMAIN: "x.example.com" }),
        ).toThrow("LAUNCHPAD_APPS_DOMAIN");
        expect(() =>
            parseAppRoutingConfig({ ...valid, LAUNCHPAD_PREVIEW_PROXY_URL: "http://d" }),
        ).toThrow("LAUNCHPAD_APPS_PROXY_URL");
        expect(() => parseAppRoutingConfig({ ...valid, LAUNCHPAD_MAX_PREVIEWS: "5" })).toThrow(
            "LAUNCHPAD_MAX_APPS",
        );
        expect(() => parseAppRoutingConfig({ ...valid, LAUNCHPAD_ALLOW_NO_EXPIRY: "on" })).toThrow(
            "no longer used",
        );
    });

    it("refuses URLs that carry credentials, queries or the wrong scheme", () => {
        for (const bad of [
            "ftp://r",
            "http://user:pass@r",
            "http://r/?token=1",
            "http://r/#x",
            "not a url",
        ]) {
            expect(
                () => parseAppRoutingConfig({ ...valid, LAUNCHPAD_ALIAS_CONTROL_URL: bad }),
                bad,
            ).toThrow("LAUNCHPAD_ALIAS_CONTROL_URL");
        }
    });

    it("refuses relative or traversing secret and epoch paths, and a non-UUID instance id", () => {
        for (const bad of ["relative/token", "/run/../etc/token"]) {
            expect(() =>
                parseAppRoutingConfig({ ...valid, LAUNCHPAD_ALIAS_CONTROL_TOKEN_FILE: bad }),
            ).toThrow("absolute");
        }
        expect(() =>
            parseAppRoutingConfig({ ...valid, LAUNCHPAD_ALIAS_INSTANCE_ID: "not-a-uuid" }),
        ).toThrow("UUID");
    });

    it("does not echo a secret-bearing value into its error", () => {
        try {
            parseAppRoutingConfig({
                ...valid,
                LAUNCHPAD_ALIAS_CONTROL_URL: "http://user:hunter2@router",
            });
        } catch (error) {
            expect((error as Error).message).not.toContain("hunter2");
        }
    });

    it("bounds retention and the quotas, and keeps per-app limits within the totals", () => {
        expect(() =>
            parseAppRoutingConfig({ ...valid, LAUNCHPAD_ROLLBACK_RETENTION: "31d" }),
        ).toThrow("30d");
        expect(() =>
            parseAppRoutingConfig({ ...valid, LAUNCHPAD_ROLLBACK_RETENTION: "0d" }),
        ).toThrow();
        expect(() => parseAppRoutingConfig({ ...valid, LAUNCHPAD_MAX_APPS: "0" })).toThrow(
            "positive",
        );
        expect(() => parseAppRoutingConfig({ ...valid, LAUNCHPAD_MAX_APPS: "abc" })).toThrow(
            "positive",
        );
        expect(() =>
            parseAppRoutingConfig({
                ...valid,
                LAUNCHPAD_MAX_ALIASES_PER_APP: "200",
                LAUNCHPAD_MAX_ALIASES: "100",
            }),
        ).toThrow("cannot exceed");
        expect(() =>
            parseAppRoutingConfig({
                ...valid,
                LAUNCHPAD_MAX_DEPLOYMENTS_PER_APP: "200",
                LAUNCHPAD_MAX_DEPLOYMENTS: "100",
            }),
        ).toThrow("cannot exceed");
    });

    it("does not rewrite a length error as a domain error", () => {
        const long = `${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(10)}.com`;
        try {
            parseAppRoutingConfig({ ...valid, LAUNCHPAD_APPS_DOMAIN: long });
            throw new Error("expected a refusal");
        } catch (error) {
            expect((error as Error).message).toContain("LAUNCHPAD_DEPLOYMENT_HOSTNAME_TEMPLATE");
            expect((error as Error).message).toContain("253");
        }
    });

    it("names the setting whose template is invalid, and a bad domain", () => {
        expect(() =>
            parseAppRoutingConfig({ ...valid, LAUNCHPAD_ALIAS_HOSTNAME_TEMPLATE: "{slug}" }),
        ).toThrow("LAUNCHPAD_ALIAS_HOSTNAME_TEMPLATE");
        expect(() =>
            parseAppRoutingConfig({ ...valid, LAUNCHPAD_APPS_DOMAIN: "Bad Domain" }),
        ).toThrow("LAUNCHPAD_APPS_DOMAIN");
    });
});
