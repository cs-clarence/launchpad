import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseRouterHostConfig } from "./config";

const valid = {
    LAUNCHPAD_ROUTER_STATE_FILE: "/state/routes.sqlite",
    LAUNCHPAD_ROUTER_INSTANCE_ID: randomUUID(),
    LAUNCHPAD_APPS_DOMAIN: "sites.example.net",
    LAUNCHPAD_ROUTER_CONTROL_LISTEN: "127.0.0.1:32301",
    LAUNCHPAD_ROUTER_DATA_LISTEN: "0.0.0.0:32302",
    LAUNCHPAD_APPS_PROXY_URL: "http://dokku:80",
};

describe("parseRouterHostConfig", () => {
    it("requires all control TLS settings together, with plain absolute file paths", () => {
        const tls = {
            LAUNCHPAD_ROUTER_CONTROL_TLS_CERT_FILE: "/tls/server.pem",
            LAUNCHPAD_ROUTER_CONTROL_TLS_KEY_FILE: "/tls/server.key",
            LAUNCHPAD_ROUTER_CONTROL_TLS_CA_FILE: "/tls/ca.pem",
            LAUNCHPAD_ROUTER_CONTROL_TLS_SERVER_NAME: "router",
        };
        expect(parseRouterHostConfig({ ...valid, ...tls }).controlTls).toEqual({
            certFile: "/tls/server.pem",
            keyFile: "/tls/server.key",
            caFile: "/tls/ca.pem",
            serverName: "router",
        });
        for (const key of Object.keys(tls)) {
            expect(() => parseRouterHostConfig({ ...valid, ...tls, [key]: "" })).toThrow(key);
        }
        expect(() =>
            parseRouterHostConfig({
                ...valid,
                ...tls,
                LAUNCHPAD_ROUTER_CONTROL_TLS_KEY_FILE: "key.pem",
            }),
        ).toThrow("absolute");
        expect(() =>
            parseRouterHostConfig({
                ...valid,
                ...tls,
                LAUNCHPAD_ROUTER_CONTROL_TLS_SERVER_NAME: "router/path",
            }),
        ).toThrow("DNS name");
    });

    it("accepts a complete configuration and carries no secret", () => {
        const config = parseRouterHostConfig(valid);
        expect(config).toMatchObject({
            stateFile: "/state/routes.sqlite",
            control: { host: "127.0.0.1", port: 32301 },
            data: { host: "0.0.0.0", port: 32302 },
            controlPrivateNetwork: false,
            upstreamCaFile: null,
        });
        expect(config.upstreamOrigin.origin).toBe("http://dokku");
    });

    it.each(Object.keys(valid))("requires %s", (name) => {
        expect(() => parseRouterHostConfig({ ...valid, [name]: undefined })).toThrow(name);
        expect(() => parseRouterHostConfig({ ...valid, [name]: "" })).toThrow(name);
    });

    it("refuses a non-loopback control listener unless a private network is confirmed", () => {
        for (const host of ["0.0.0.0", "10.0.0.5", "[::]"]) {
            const env = { ...valid, LAUNCHPAD_ROUTER_CONTROL_LISTEN: `${host}:32301` };
            expect(() => parseRouterHostConfig(env)).toThrow("PRIVATE_NETWORK");
            const allowed = parseRouterHostConfig({
                ...env,
                LAUNCHPAD_ROUTER_CONTROL_PRIVATE_NETWORK: "1",
            });
            expect(allowed.controlPrivateNetwork).toBe(true);
        }
        for (const host of ["127.0.0.1", "127.9.9.9", "localhost", "[::1]"]) {
            expect(
                parseRouterHostConfig({ ...valid, LAUNCHPAD_ROUTER_CONTROL_LISTEN: `${host}:1234` })
                    .control.host,
            ).toBe(host.replace(/^\[|\]$/g, "")); // IPv6 is bare, ready to bind
        }
    });

    it("refuses equal or wildcard-overlapping control and data addresses", () => {
        const both = (control: string, data: string) =>
            parseRouterHostConfig({
                ...valid,
                LAUNCHPAD_ROUTER_CONTROL_PRIVATE_NETWORK: "1",
                LAUNCHPAD_ROUTER_CONTROL_LISTEN: control,
                LAUNCHPAD_ROUTER_DATA_LISTEN: data,
            });
        expect(() => both("127.0.0.1:9000", "127.0.0.1:9000")).toThrow("share an address");
        expect(() => both("127.0.0.1:9000", "0.0.0.0:9000")).toThrow("share an address");
        expect(() => both("0.0.0.0:9000", "127.0.0.1:9000")).toThrow("share an address");
        expect(() => both("[::1]:9000", "[::]:9000")).toThrow("share an address");
        expect(both("127.0.0.1:9000", "127.0.0.1:9001").data.port).toBe(9001);
    });

    it.each([
        "127.0.0.1",
        "127.0.0.1:",
        "127.0.0.1:0",
        "127.0.0.1:70000",
        "example.com:80",
        "999.1.1.1:80",
        ":80",
        "127.0.0.1:80x",
    ])("refuses the malformed listen address %s", (address) => {
        expect(() =>
            parseRouterHostConfig({ ...valid, LAUNCHPAD_ROUTER_DATA_LISTEN: address }),
        ).toThrow("LAUNCHPAD_ROUTER_DATA_LISTEN");
    });

    it("validates the upstream origin and CA file", () => {
        for (const url of [
            "ftp://x",
            "http://u:p@x",
            "http://x/path",
            "http://x/?q=1",
            "http://x/#f",
            "nonsense",
        ]) {
            expect(
                () => parseRouterHostConfig({ ...valid, LAUNCHPAD_APPS_PROXY_URL: url }),
                url,
            ).toThrow("LAUNCHPAD_APPS_PROXY_URL");
        }
        expect(() =>
            parseRouterHostConfig({ ...valid, LAUNCHPAD_ROUTER_UPSTREAM_CA_FILE: "/ca.pem" }),
        ).toThrow("https upstream");
        const tls = { ...valid, LAUNCHPAD_APPS_PROXY_URL: "https://dokku" };
        expect(
            parseRouterHostConfig({ ...tls, LAUNCHPAD_ROUTER_UPSTREAM_CA_FILE: "/ca.pem" })
                .upstreamCaFile,
        ).toBe("/ca.pem");
        expect(() =>
            parseRouterHostConfig({ ...tls, LAUNCHPAD_ROUTER_UPSTREAM_CA_FILE: "ca.pem" }),
        ).toThrow("absolute");
    });

    it("refuses a relative or traversing state file, a bad instance ID and a bad apps domain", () => {
        expect(() =>
            parseRouterHostConfig({ ...valid, LAUNCHPAD_ROUTER_STATE_FILE: "state/routes" }),
        ).toThrow("absolute");
        expect(() =>
            parseRouterHostConfig({ ...valid, LAUNCHPAD_ROUTER_STATE_FILE: "/a/../b" }),
        ).toThrow("absolute");
        expect(() =>
            parseRouterHostConfig({ ...valid, LAUNCHPAD_ROUTER_INSTANCE_ID: "x" }),
        ).toThrow("UUID");
        expect(() =>
            parseRouterHostConfig({ ...valid, LAUNCHPAD_APPS_DOMAIN: "Sites.Example" }),
        ).toThrow("domain");
    });
});
