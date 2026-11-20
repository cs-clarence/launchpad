import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { recoveryAnchorNotice, routerAnchorFromEnv, routerSessionFromEnv } from "./router-view";

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

describe("routerAnchorFromEnv", () => {
    it("records no anchor, and says why, when there is no router or it cannot be read", async () => {
        expect(await routerAnchorFromEnv(deploymentsOnly)).toEqual({
            routerEpoch: null,
            note: "not-configured",
        });
        // Incomplete router settings must not stop an emergency restore either.
        expect(
            await routerAnchorFromEnv({ LAUNCHPAD_ALIAS_CONTROL_URL: "http://127.0.0.1:9001" }),
        ).toEqual({ routerEpoch: null, note: "unreachable" });
        // Configured, but the credential files cannot be read: an emergency restore still proceeds.
        expect(await routerAnchorFromEnv(routerSettings)).toEqual({
            routerEpoch: null,
            note: "unreachable",
        });
    });

    it("anchors on the configured epoch file when the router cannot be reached", async () => {
        const dir = mkdtempSync(path.join(tmpdir(), "lp-anchor-env-"));
        try {
            const epoch = randomUUID();
            const tokenFile = path.join(dir, "token");
            const epochFile = path.join(dir, "epoch");
            writeFileSync(tokenFile, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
            writeFileSync(epochFile, `${epoch}\n`);
            const anchor = await routerAnchorFromEnv({
                ...routerSettings,
                // Nothing listens here: the router is down.
                LAUNCHPAD_ALIAS_CONTROL_URL: "http://127.0.0.1:1",
                LAUNCHPAD_ALIAS_CONTROL_TOKEN_FILE: tokenFile,
                LAUNCHPAD_ALIAS_ROUTER_EPOCH_FILE: epochFile,
            });
            expect(anchor).toEqual({ routerEpoch: epoch, note: "from-epoch-file" });
            // A file that does not hold an epoch is no anchor.
            writeFileSync(epochFile, "not-an-epoch\n");
            expect(
                await routerAnchorFromEnv({
                    ...routerSettings,
                    LAUNCHPAD_ALIAS_CONTROL_URL: "http://127.0.0.1:1",
                    LAUNCHPAD_ALIAS_CONTROL_TOKEN_FILE: tokenFile,
                    LAUNCHPAD_ALIAS_ROUTER_EPOCH_FILE: epochFile,
                }),
            ).toEqual({ routerEpoch: null, note: "unreachable" });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("recoveryAnchorNotice", () => {
    const base = { version: 2 as const, restoreStartedAt: "2026-01-01T00:00:00.000Z" };
    it("follows the marker that was kept, so a retry that read the router still warns about a file anchor", () => {
        // The first run anchored on the epoch file; a retry read the router fine but the marker keeps the first.
        const kept = {
            ...base,
            routerEpoch: randomUUID(),
            routerEpochNote: "from-epoch-file" as const,
        };
        expect(recoveryAnchorNotice(kept)).toMatch(/configured epoch file/);
        expect(recoveryAnchorNotice({ ...kept, routerEpochNote: "recorded" })).toBeNull();
        expect(
            recoveryAnchorNotice({ ...base, routerEpoch: null, routerEpochNote: "unreachable" }),
        ).toMatch(/router could not be read/);
        expect(
            recoveryAnchorNotice({ ...base, routerEpoch: null, routerEpochNote: "not-configured" }),
        ).toMatch(/no router is configured/);
        expect(
            recoveryAnchorNotice({
                ...base,
                routerEpoch: null,
                routerEpochNote: "history-unknown",
            }),
        ).toMatch(/not known whether a router was in use/);
        expect(recoveryAnchorNotice("damaged")).toMatch(/damaged/);
        expect(recoveryAnchorNotice(null)).toBeNull();
    });
});
