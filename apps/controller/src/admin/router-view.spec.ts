import { describe, expect, it } from "vitest";
import { routerSessionFromEnv } from "./router-view";

// An installation that never used aliases has deployments on and an apps domain, but no router
// settings. recovery-clear must treat that as "no router", not fail before it reaches the service.
const deploymentsOnly = {
    LAUNCHPAD_DEPLOYMENTS: "on",
    LAUNCHPAD_BASE_URL: "https://control.example.com",
    LAUNCHPAD_APPS_DOMAIN: "sites.example.net",
    LAUNCHPAD_APPS_PROXY_URL: "http://127.0.0.1:8080",
};
const routerSettings = {
    ...deploymentsOnly,
    LAUNCHPAD_ALIAS_INSTANCE_ID: "11111111-1111-4111-8111-111111111111",
    LAUNCHPAD_ALIAS_CONTROL_URL: "http://127.0.0.1:9001",
    LAUNCHPAD_ALIAS_PROBE_URL: "http://127.0.0.1:9002",
    LAUNCHPAD_ALIAS_CONTROL_TOKEN_FILE: "/run/secrets/alias_token",
    LAUNCHPAD_ALIAS_ROUTER_EPOCH_FILE: "/run/secrets/alias_epoch",
};

describe("routerSessionFromEnv", () => {
    it("is no router when the control URL is unset, whatever else the environment holds", () => {
        expect(routerSessionFromEnv({})).toBeUndefined();
        expect(routerSessionFromEnv(deploymentsOnly)).toBeUndefined();
        expect(
            routerSessionFromEnv({ ...deploymentsOnly, LAUNCHPAD_ALIAS_CONTROL_URL: "" }),
        ).toBeUndefined();
    });

    it("requires every router setting once the control URL is set", () => {
        expect(() =>
            routerSessionFromEnv({ LAUNCHPAD_ALIAS_CONTROL_URL: "http://127.0.0.1:9001" }),
        ).toThrow(/LAUNCHPAD_APPS_DOMAIN and every LAUNCHPAD_ALIAS_\*/);
        const { LAUNCHPAD_ALIAS_ROUTER_EPOCH_FILE: _omitted, ...incomplete } = routerSettings;
        expect(() => routerSessionFromEnv(incomplete)).toThrow(/LAUNCHPAD_ALIAS_ROUTER_EPOCH_FILE/);
    });

    it("builds a session, refusing a control URL that would send the token in the clear", () => {
        const session = routerSessionFromEnv(routerSettings);
        expect(session).toBeDefined();
        expect(typeof session!.view).toBe("function");
        expect(() =>
            routerSessionFromEnv({
                ...routerSettings,
                LAUNCHPAD_ALIAS_CONTROL_URL: "http://10.0.0.5:9001",
            }),
        ).toThrow(/https/);
    });

    it("reports an unreadable credential file without echoing its path", async () => {
        const session = routerSessionFromEnv(routerSettings)!;
        const failure = await session.view().then(
            () => null,
            (error: Error) => error,
        );
        expect(failure?.message).toBe("Could not read the configured router credential file.");
        expect(failure?.message).not.toContain("alias_token");
    });
});
