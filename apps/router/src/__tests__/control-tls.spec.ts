import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createRouterControlClient } from "@launchpad-kit/alias-router/control-client";
import { initRouter } from "../commands";
import { checkHealth } from "../healthcheck";
import { startRouter, type RunningRouter } from "../serve";
import { tempState, newToken, type TempState } from "../test-support";
import { get } from "./support";

let state: TempState | undefined;
let router: RunningRouter | undefined;
afterEach(async () => {
    await router?.shutdown();
    router = undefined;
    state?.cleanup();
    state = undefined;
});

describe("verified router control TLS", () => {
    it("binds, promotes and withdraws over HTTPS, refusing untrusted and wrong-name certificates", async () => {
        state = tempState();
        const certFile = `${state.directory}/server.pem`;
        const keyFile = `${state.directory}/server.key`;
        const caFile = `${state.directory}/ca.pem`;
        const caKey = `${state.directory}/ca.key`;
        execFileSync(
            "openssl",
            [
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-days",
                "1",
                "-subj",
                "/CN=Fixture CA",
                "-addext",
                "basicConstraints=critical,CA:TRUE",
                "-keyout",
                caKey,
                "-out",
                caFile,
            ],
            { stdio: "ignore" },
        );
        execFileSync(
            "openssl",
            [
                "req",
                "-new",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-subj",
                "/CN=localhost",
                "-keyout",
                keyFile,
                "-out",
                `${state.directory}/server.csr`,
            ],
            { stdio: "ignore" },
        );
        writeFileSync(
            `${state.directory}/extensions`,
            "subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n",
        );
        execFileSync(
            "openssl",
            [
                "x509",
                "-req",
                "-days",
                "1",
                "-in",
                `${state.directory}/server.csr`,
                "-CA",
                caFile,
                "-CAkey",
                caKey,
                "-CAcreateserial",
                "-extfile",
                `${state.directory}/extensions`,
                "-out",
                certFile,
            ],
            { stdio: "ignore" },
        );
        chmodSync(keyFile, 0o600);
        const token = newToken();
        const epoch = initRouter(state.config, token);
        const tls = { certFile, keyFile, caFile, serverName: "localhost" };
        const config = {
            ...state.config,
            control: { host: "127.0.0.1", port: 0 },
            data: { host: "127.0.0.1", port: 0 },
            controlTls: tls,
            upstreamOrigin: new URL("http://127.0.0.1:1"),
            upstreamCaFile: null,
        };
        router = startRouter(config);
        const options = {
            baseUrl: new URL(`https://localhost:${router.control.port}`),
            credentials: { instanceId: state.config.instanceId, epoch, token },
            timeoutMs: 2000,
        };
        const trusted = createRouterControlClient({ ...options, caFile });
        expect(await trusted.readEpoch()).toBe(epoch);
        await expect(createRouterControlClient(options).readEpoch()).rejects.toThrow(
            "could not be confirmed",
        );
        await expect(
            createRouterControlClient({
                ...options,
                caFile,
                baseUrl: new URL(`https://127.0.0.1:${router.control.port}`),
            }).readEpoch(),
        ).rejects.toThrow("could not be confirmed");
        await expect(
            createRouterControlClient({
                ...options,
                baseUrl: new URL(`http://127.0.0.1:${router.control.port}`),
            }).readEpoch(),
        ).rejects.toThrow("could not be confirmed");
        expect(await checkHealth(router.control, fetch, 2000, tls)).toBe(true);
        expect(
            await checkHealth(router.control, fetch, 2000, {
                ...tls,
                serverName: "127.0.0.1",
            }),
        ).toBe(false);
        const emptyCa = `${state.directory}/empty-ca.pem`;
        writeFileSync(emptyCa, "");
        expect(() => createRouterControlClient({ ...options, caFile: emptyCa })).toThrow(
            "holds no certificate",
        );
        expect(() =>
            createRouterControlClient({
                ...options,
                caFile,
                baseUrl: new URL("http://127.0.0.1"),
            }),
        ).toThrow("requires HTTPS");
        const a = randomUUID();
        const b = randomUUID();
        const aliasId = randomUUID();
        const hostname = "view-fixture.sites.example.net";
        await trusted.registerDeployment({ deploymentId: a, hostname: "a.sites.example.net" });
        await trusted.registerDeployment({ deploymentId: b, hostname: "b.sites.example.net" });
        for (const [generation, targetDeploymentId] of [
            ["1", a],
            ["2", b],
            ["3", null],
        ] as const) {
            await trusted.replaceRoute({
                aliasId,
                hostname,
                generation,
                operationId: randomUUID(),
                targetDeploymentId,
            });
            expect((await trusted.readRoute(hostname)).route?.target?.deploymentId ?? null).toBe(
                targetDeploymentId,
            );
        }
        expect((await get(router.data.port, hostname)).status).toBe(404);
        expect((await fetch(`http://127.0.0.1:${router.data.port}/v1/routes`)).status).toBe(404);
        await router.shutdown();
        router = undefined;
        chmodSync(keyFile, 0o644);
        expect(() => startRouter(config)).toThrow("readable only by you");
        chmodSync(keyFile, 0o600);
        writeFileSync(keyFile, "not a private key");
        expect(() => startRouter(config)).toThrow();
    }, 15_000);
});
