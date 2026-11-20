import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    createControlHandler,
    initializeRouterState,
    openRouterState,
} from "@launchpad-kit/alias-router";
import { createRouterControlClient } from "@launchpad-kit/alias-router/control-client";
import type { DriftDatabase } from "@launchpad-kit/services";
import { describe, expect, it } from "vitest";
import {
    collectDrift,
    driftCommandExitCode,
    readDriftProbes,
    readDriftRouter,
    readRepublishProbe,
    readUnservableProbe,
} from "../drift";
import { routerSessionFromEnv } from "../router-view";

const empty: DriftDatabase = {
    deployments: [],
    aliases: [],
    operations: [],
    reservations: [],
    legacyPreviewIds: [],
    knownAppNames: [],
};

describe("drift reads through the real loopback router", () => {
    it("reads every page including tombstones and marks a changed authority unavailable", async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "drift-router-"));
        await fs.chmod(dir, 0o700);
        const instanceId = randomUUID();
        const epoch = randomUUID();
        const token = randomBytes(32).toString("hex");
        const state = path.join(dir, "router.sqlite");
        initializeRouterState(
            state,
            { instanceId, appsDomain: "sites.example.net" },
            { epoch, token },
        );
        const store = openRouterState(state, { instanceId, appsDomain: "sites.example.net" });
        let corruptAuthority = false;
        let reads = 0;
        const control = createControlHandler(store);
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
                const response = await control(request);
                if (request.method !== "GET") return response;
                reads++;
                if (!corruptAuthority) return response;
                return Response.json({
                    ...((await response.json()) as object),
                    epoch: randomUUID(),
                });
            },
        });
        try {
            const baseUrl = new URL(`http://127.0.0.1:${server.port}`);
            const client = createRouterControlClient({
                baseUrl,
                credentials: { instanceId, epoch, token },
            });
            // More than one page; tombstones must not be silently omitted.
            for (let i = 0; i < 501; i++) {
                await client.replaceRoute({
                    aliasId: randomUUID(),
                    hostname: `view-${String(i).padStart(4, "0")}.sites.example.net`,
                    operationId: randomUUID(),
                    generation: "9007199254740993",
                    targetDeploymentId: null,
                });
            }
            await fs.writeFile(path.join(dir, "epoch"), epoch);
            await fs.writeFile(path.join(dir, "token"), token, { mode: 0o600 });
            const session = routerSessionFromEnv({
                LAUNCHPAD_APPS_DOMAIN: "sites.example.net",
                LAUNCHPAD_BASE_URL: "https://control.example.org",
                LAUNCHPAD_APPS_PROXY_URL: "http://127.0.0.1:1",
                LAUNCHPAD_ALIAS_CONTROL_URL: baseUrl.href,
                LAUNCHPAD_ALIAS_PROBE_URL: "http://127.0.0.1:1",
                LAUNCHPAD_ALIAS_INSTANCE_ID: instanceId,
                LAUNCHPAD_ALIAS_CONTROL_TOKEN_FILE: path.join(dir, "token"),
                LAUNCHPAD_ALIAS_ROUTER_EPOCH_FILE: path.join(dir, "epoch"),
            })!;
            const inventory = await readDriftRouter(session);
            expect(reads).toBe(2);
            expect(inventory.routes).toHaveLength(501);
            expect(
                inventory.routes.every(
                    (r) => r.targetDeploymentId === null && r.generation === 9007199254740993n,
                ),
            ).toBe(true);
            corruptAuthority = true;
            const report = await collectDrift({
                database: async () => empty,
                router: () => readDriftRouter(session),
                archives: async () => ({ keys: [] }),
                config: { expectedEpoch: epoch, now: new Date(), appNamePattern: /^lp-/ },
            });
            expect(report.sources.router).toBe("unavailable");
            expect(report.findings).toEqual([]);
            expect(driftCommandExitCode(report)).toBe(2);
        } finally {
            await server.stop(true);
            store.close();
            await fs.rm(dir, { recursive: true, force: true });
        }
    });

    it("probes identities with Host, without following redirects or conflating connection failure with 404", async () => {
        const id = randomUUID();
        const hosts: string[] = [];
        let status = 200;
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
                hosts.push(request.headers.get("host")!);
                return new Response(null, {
                    status,
                    headers: {
                        "x-launchpad-deployment": id.replaceAll("-", ""),
                        location: "http://must-not-follow.example.net/",
                    },
                });
            },
        });
        const db: DriftDatabase = {
            ...empty,
            aliases: [
                {
                    id: randomUUID(),
                    appId: randomUUID(),
                    hostname: "view-prod.sites.example.net",
                    state: "bound",
                    reservedGeneration: 1n,
                    committedGeneration: 1n,
                    targetDeploymentId: id,
                    lastOperationId: randomUUID(),
                },
            ],
        };
        const env = { LAUNCHPAD_ALIAS_PROBE_URL: `http://127.0.0.1:${server.port}` };
        try {
            expect(await readDriftProbes(env, db)).toEqual({
                results: [{ hostname: db.aliases[0]!.hostname, deploymentId: id }],
            });
            expect(hosts).toEqual([db.aliases[0]!.hostname]);
            status = 404;
            expect((await readDriftProbes(env, db)).results[0]!.deploymentId).toBeNull();
            status = 302;
            await expect(readDriftProbes(env, db)).rejects.toThrow("unavailable");
            expect(hosts).toHaveLength(3);
            await expect(
                readDriftProbes({ LAUNCHPAD_ALIAS_PROBE_URL: "http://127.0.0.1:1" }, db),
            ).rejects.toThrow();
        } finally {
            await server.stop(true);
        }
    });

    it("treats a proxy with no upstream as serving nothing, and anything ambiguous as an error", async () => {
        let status = 503;
        let identity: string | null = null;
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: () =>
                new Response(null, {
                    status,
                    headers: identity ? { "x-launchpad-deployment": identity } : {},
                }),
        });
        const origin = `http://127.0.0.1:${server.port}`;
        const host = "view-prod.sites.example.net";
        try {
            for (status of [502, 503, 504]) {
                expect(await readUnservableProbe(origin, host)).toBeNull();
                // The republish probe stays strict: an upstream failure is not a verified withdrawal.
                await expect(readRepublishProbe(origin, host)).rejects.toThrow();
            }
            // A proxy that stamps an identity is serving something: not an absent upstream.
            identity = randomUUID().replaceAll("-", "");
            status = 503;
            await expect(readUnservableProbe(origin, host)).rejects.toThrow();
            identity = null;
            for (status of [500, 401, 302]) {
                await expect(readUnservableProbe(origin, host)).rejects.toThrow();
            }
            await expect(readUnservableProbe("http://127.0.0.1:1", host)).rejects.toThrow();
        } finally {
            await server.stop(true);
        }
    });
});
