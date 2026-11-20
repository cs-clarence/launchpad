import { describe, expect, it } from "vitest";
import {
    assertCurrentSettings,
    parseAliasConfig,
    parseAppRoutingConfig,
} from "./app-routing-config";
import { assertNoRemovedSettings } from "./removed-settings";

const valid = {
    LAUNCHPAD_BASE_URL: "https://control.example.com",
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
        ).toThrow("LAUNCHPAD_PREVIEW_DOMAIN is no longer used");
    });

    it("applies the documented defaults", () => {
        const config = parseAppRoutingConfig(valid);
        if (!config.enabled) throw new Error("expected enabled");
        expect(config.rollbackRetentionSeconds).toBe(7 * 86_400);
        expect([config.maxApps, config.maxDeployments, config.maxDeploymentsPerApp]).toEqual([
            10, 100, 20,
        ]);
        expect([config.maxAliases, config.maxAliasesPerApp]).toEqual([50, 5]);
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

    it.each(Object.keys(valid).filter((name) => name !== "LAUNCHPAD_APPS_DOMAIN"))(
        "requires %s once the domain is set",
        (name) => {
            expect(() => parseAppRoutingConfig({ ...valid, [name]: undefined })).toThrow(name);
            expect(() => parseAppRoutingConfig({ ...valid, [name]: "" })).toThrow(name);
        },
    );

    it("requires the apps domain to be a different registrable domain from the management origin", () => {
        const base = (LAUNCHPAD_BASE_URL: string, LAUNCHPAD_APPS_DOMAIN: string) =>
            parseAppRoutingConfig({ ...valid, LAUNCHPAD_BASE_URL, LAUNCHPAD_APPS_DOMAIN });
        // Same registrable domain: a sibling subdomain is not enough.
        expect(() => base("https://control.example.com", "sites.example.com")).toThrow(
            "registrable",
        );
        expect(() => base("https://control.example.com", "example.com")).toThrow("registrable");
        expect(() => base("https://example.com", "sites.example.com")).toThrow("registrable");
        // The public suffix list is honoured: two names under co.uk are different sites.
        expect(base("https://control.alpha.co.uk", "sites.beta.co.uk").enabled).toBe(true);
        expect(() => base("https://control.alpha.co.uk", "sites.alpha.co.uk")).toThrow(
            "registrable",
        );
        expect(base("https://control.example.com", "sites.example.net").enabled).toBe(true);
        expect(() => parseAppRoutingConfig({ ...valid, LAUNCHPAD_BASE_URL: undefined })).toThrow(
            "LAUNCHPAD_BASE_URL",
        );
    });

    it("requires the management origin to be an https origin with no path", () => {
        const base = (LAUNCHPAD_BASE_URL: string) =>
            parseAppRoutingConfig({ ...valid, LAUNCHPAD_BASE_URL });
        expect(base("https://control.example.com").enabled).toBe(true);
        expect(base("https://control.example.com/").enabled).toBe(true);
        for (const bad of [
            "http://control.example.com",
            "https://control.example.com/admin",
            "https://control.example.com/?x=1",
            "https://user:pw@control.example.com",
        ]) {
            expect(() => base(bad), bad).toThrow("LAUNCHPAD_BASE_URL");
        }
    });

    it("gives the Dokku proxy address the same origin-only contract as the router", () => {
        const proxy = (LAUNCHPAD_APPS_PROXY_URL: string) =>
            parseAppRoutingConfig({ ...valid, LAUNCHPAD_APPS_PROXY_URL });
        expect(proxy("http://dokku:80").enabled).toBe(true);
        expect(proxy("https://dokku.internal").enabled).toBe(true);
        expect(() => proxy("https://dokku.internal/proxy")).toThrow("no path");
    });

    it("refuses the preview-era settings with a pointer to the new one", () => {
        expect(() =>
            parseAppRoutingConfig({ ...valid, LAUNCHPAD_PREVIEW_DOMAIN: "x.example.com" }),
        ).toThrow("LAUNCHPAD_PREVIEW_DOMAIN is no longer used");
        expect(() =>
            parseAppRoutingConfig({ ...valid, LAUNCHPAD_PREVIEW_PROXY_URL: "http://d" }),
        ).toThrow("LAUNCHPAD_PREVIEW_PROXY_URL is no longer used");
        expect(() => parseAppRoutingConfig({ ...valid, LAUNCHPAD_MAX_PREVIEWS: "5" })).toThrow(
            "LAUNCHPAD_MAX_PREVIEWS is no longer used",
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

describe("assertCurrentSettings", () => {
    it("accepts an environment with no app settings and requires no router settings", () => {
        expect(() => assertCurrentSettings({})).not.toThrow();
        expect(() => assertCurrentSettings({ LAUNCHPAD_APPS_DOMAIN: "" })).not.toThrow();
        // The apps domain alone is enough: nothing uses the router settings until P3.
        expect(() =>
            assertCurrentSettings({
                LAUNCHPAD_BASE_URL: "https://control.example.com",
                LAUNCHPAD_APPS_DOMAIN: "sites.example.net",
            }),
        ).not.toThrow();
    });

    it("refuses every removed name with an actionable message", () => {
        for (const name of [
            "LAUNCHPAD_PREVIEW_DOMAIN",
            "LAUNCHPAD_PREVIEW_PROXY_URL",
            "LAUNCHPAD_MAX_PREVIEWS",
            "LAUNCHPAD_ALLOW_NO_EXPIRY",
            "LAUNCHPAD_LIFECYCLE",
            "LAUNCHPAD_LIFECYCLE_INTERVAL",
        ]) {
            expect(() => assertNoRemovedSettings({ [name]: "x" })).toThrow(name);
            expect(() => assertCurrentSettings({ [name]: "x" })).toThrow(/no longer used/);
            // An empty value is the same as unset, as elsewhere.
            expect(() => assertCurrentSettings({ [name]: "" })).not.toThrow();
        }
    });

    it("keeps the apps domain separate from the management origin", () => {
        const env = (LAUNCHPAD_BASE_URL: string, LAUNCHPAD_APPS_DOMAIN: string) => ({
            LAUNCHPAD_BASE_URL,
            LAUNCHPAD_APPS_DOMAIN,
        });
        expect(() =>
            assertCurrentSettings(env("https://control.example.com", "sites.example.com")),
        ).toThrow("different registrable domain");
        expect(() =>
            assertCurrentSettings(env("https://control.example.com", "Not A Domain")),
        ).toThrow("not a valid");
        expect(() => assertCurrentSettings({ LAUNCHPAD_APPS_DOMAIN: "sites.example.net" })).toThrow(
            "LAUNCHPAD_BASE_URL",
        );
        // The management origin must be https once the apps domain is set.
        expect(() =>
            assertCurrentSettings(env("http://localhost:3000", "sites.example.net")),
        ).toThrow("https origin");
    });
});

describe("parseAliasConfig", () => {
    const on = {
        LAUNCHPAD_DEPLOYMENTS: "on",
        LAUNCHPAD_BASE_URL: "https://control.example.com",
        LAUNCHPAD_APPS_DOMAIN: "sites.example.net",
    };

    it("is off, and reads nothing else, unless switched on", () => {
        expect(parseAliasConfig(on)).toEqual({ enabled: false });
        expect(parseAliasConfig({ ...on, LAUNCHPAD_ALIASES: "off" })).toEqual({ enabled: false });
        expect(() => parseAliasConfig({ ...on, LAUNCHPAD_ALIASES: "yes" })).toThrow(
            /"on" or "off"/,
        );
    });

    it("needs deployments to be on", () => {
        expect(() =>
            parseAliasConfig({ ...on, LAUNCHPAD_DEPLOYMENTS: "off", LAUNCHPAD_ALIASES: "on" }),
        ).toThrow("needs LAUNCHPAD_DEPLOYMENTS=on");
    });

    it("applies defaults and validates limits and the template", () => {
        const config = parseAliasConfig({ ...on, LAUNCHPAD_ALIASES: "on" });
        if (!config.enabled) throw new Error("expected enabled");
        expect([config.maxAliasesPerApp, config.maxAliases]).toEqual([5, 50]);
        expect(config.aliasTemplate.source).toBe("view-{slug}-{id}");
        const bad = (extra: Record<string, string>) => () =>
            parseAliasConfig({ ...on, LAUNCHPAD_ALIASES: "on", ...extra });
        expect(bad({ LAUNCHPAD_MAX_ALIASES_PER_APP: "0" })).toThrow("positive integer");
        expect(bad({ LAUNCHPAD_MAX_ALIASES_PER_APP: "60", LAUNCHPAD_MAX_ALIASES: "50" })).toThrow(
            "cannot exceed",
        );
        expect(bad({ LAUNCHPAD_ALIAS_HOSTNAME_TEMPLATE: "no-placeholders" })).toThrow(
            "LAUNCHPAD_ALIAS_HOSTNAME_TEMPLATE",
        );
    });
});
