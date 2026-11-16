import { describe, expect, it } from "vitest";
import { loadConfig, MAX_LEASE_MS, MIN_LEASE_MS } from "./config";

const full = {
    LAUNCHPAD_DEPLOYMENTS: "on",
    DATABASE_URL: "postgresql://u:p@db/launchpad",
    LAUNCHPAD_DATA_DIR: "/data",
    DOKKU_SSH_HOST: "dokku.example.com",
    DOKKU_SSH_KEY_PATH: "/run/secrets/key",
    DOKKU_SSH_KNOWN_HOSTS_PATH: "/run/secrets/known_hosts",
    LAUNCHPAD_PREVIEW_PROXY_URL: "http://dokku:80",
};

describe("worker configuration", () => {
    it("is off by default and reads nothing else while off", () => {
        expect(loadConfig({})).toEqual({ enabled: false });
        expect(loadConfig({ LAUNCHPAD_DEPLOYMENTS: "off", DOKKU_SSH_PORT: "nonsense" })).toEqual({
            enabled: false,
        });
        expect(() => loadConfig({ LAUNCHPAD_DEPLOYMENTS: "true" })).toThrow();
    });

    it("needs every setting once on, and names the one that is missing", () => {
        for (const name of Object.keys(full).filter((k) => k !== "LAUNCHPAD_DEPLOYMENTS")) {
            const env: Record<string, string> = { ...full };
            delete env[name];
            expect(() => loadConfig(env), name).toThrow(name);
        }
    });

    it("reads the same archive limits as the controller, and resolves the data directory", () => {
        const loaded = loadConfig({
            ...full,
            LAUNCHPAD_DATA_DIR: "./data/../data2",
            LAUNCHPAD_MAX_ARCHIVE_ENTRIES: "7",
            LAUNCHPAD_MAX_EXPANDED_BYTES: "1234",
            LAUNCHPAD_MAX_ARCHIVE_DEPTH: "3",
        });
        if (!loaded.enabled) throw new Error("expected enabled");
        expect(loaded.config.archiveLimits).toEqual({
            maxEntries: 7,
            maxExpandedBytes: 1234,
            maxDepth: 3,
        });
        expect(loaded.config.dataDir.startsWith("/")).toBe(true);
        expect(loaded.config.dataDir.endsWith("/data2")).toBe(true);
    });

    it("keeps the lifecycle off unless asked, and reads its settings with the same rules as the controller", () => {
        const off = loadConfig(full);
        if (!off.enabled) throw new Error("expected enabled");
        expect(off.config.lifecycle).toMatchObject({
            enabled: false,
            defaultTtlSeconds: 7 * 86_400,
        });
        const on = loadConfig({
            ...full,
            LAUNCHPAD_LIFECYCLE: "on",
            LAUNCHPAD_ARTIFACT_RETENTION: "48h",
        });
        if (!on.enabled) throw new Error("expected enabled");
        expect(on.config.lifecycle).toMatchObject({
            enabled: true,
            artifactRetentionSeconds: 172_800,
        });
        expect(() => loadConfig({ ...full, LAUNCHPAD_LIFECYCLE: "yes" })).toThrow(
            /LAUNCHPAD_LIFECYCLE/,
        );
        expect(() => loadConfig({ ...full, LAUNCHPAD_DEFAULT_TTL: "99d" })).toThrow(
            /must not be longer/,
        );
    });

    it("applies defaults and checks numbers and references", () => {
        const loaded = loadConfig(full);
        if (!loaded.enabled) throw new Error("expected enabled");
        expect(loaded.config).toMatchObject({
            baseImage: "nginx:1.27-alpine",
            dokku: { port: 22, username: "dokku" },
            pollMs: 2000,
            leaseMs: 900_000,
        });
        for (const bad of [
            { DOKKU_SSH_PORT: "0" },
            { LAUNCHPAD_WORKER_POLL_MS: "5" },
            { LAUNCHPAD_WORKER_LEASE_MS: "1000" },
            // Shorter than a load can take: every deployment would end held.
            { LAUNCHPAD_WORKER_LEASE_MS: String(MIN_LEASE_MS - 1) },
            // Longer than the scratch sweep can tolerate for a rollback's build.
            { LAUNCHPAD_WORKER_LEASE_MS: String(MAX_LEASE_MS + 1) },
            { DOKKU_SSH_PORT: "70000" },
            { LAUNCHPAD_DATA_DIR: "/data/with space" },
            { LAUNCHPAD_DATA_DIR: "/data/$(id)" },
            { LAUNCHPAD_MAX_ARCHIVE_ENTRIES: "0" },
            { LAUNCHPAD_BASE_IMAGE: "nginx:latest; rm -rf /" },
            { LAUNCHPAD_PREVIEW_PROXY_URL: "ftp://x" },
        ]) {
            expect(() => loadConfig({ ...full, ...bad }), JSON.stringify(bad)).toThrow();
        }
    });
});
