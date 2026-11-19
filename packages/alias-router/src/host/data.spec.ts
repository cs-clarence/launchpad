import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalHost, createDataHandler } from "./data";
import { hostFixture, type HostFixture } from "./test-support";
import { UpstreamError, type Upstream, type UpstreamRequest } from "./upstream";

let fixture: HostFixture;
afterEach(() => fixture?.cleanup());

const A = randomUUID();
const B = randomUUID();
const ALIAS = randomUUID();
const OTHER = randomUUID();

function setup(upstream?: Upstream) {
    fixture = hostFixture();
    const writer = fixture.store.authenticate(fixture.credentials);
    fixture.store.registerDeployment(writer, { deploymentId: A, hostname: "a.sites.example.net" });
    fixture.store.registerDeployment(writer, { deploymentId: B, hostname: "b.sites.example.net" });
    const bind = (aliasId: string, hostname: string, generation: string, target: string | null) =>
        fixture.store.replaceRoute(writer, {
            aliasId,
            hostname,
            operationId: randomUUID(),
            generation,
            targetDeploymentId: target,
        });
    const seen: UpstreamRequest[] = [];
    const fake: Upstream = async (request) => {
        seen.push(request);
        return new Response(`served:${request.hostname}`, {
            status: 200,
            headers: { "x-launchpad-deployment": request.hostname },
        });
    };
    const handle = createDataHandler(fixture.store, { upstream: upstream ?? fake });
    // The URL names the same host as the Host header when it can be parsed; a host that is not even
    // a valid URL authority (the unusual cases) is sent with a neutral URL and the raw header.
    const request = (
        host: string | null,
        method: string,
        path: string,
        headers: Record<string, string>,
    ) => {
        const withHost = host === null ? headers : { ...headers, host };
        try {
            return new Request(`http://${host ?? "placeholder.invalid"}${path}`, {
                method,
                headers: withHost,
            });
        } catch {
            return new Request(`http://placeholder.invalid${path}`, { method, headers: withHost });
        }
    };
    const call = (
        host: string | null,
        { method = "GET", path = "/", headers = {} as Record<string, string> } = {},
    ) => handle(request(host, method, path, headers));
    return { call, bind, seen, handle };
}
const ALIAS_HOST = "view-site.sites.example.net";
const body = async (r: Response) => r.text();

describe("data plane routing", () => {
    it("serves a bound alias from its target's immutable hostname and follows promotion/rollback", async () => {
        const { call, bind, seen } = setup();
        bind(ALIAS, ALIAS_HOST, "1", A);
        bind(OTHER, "other.sites.example.net", "1", A);
        expect(await body(await call(ALIAS_HOST))).toBe("served:a.sites.example.net");
        bind(ALIAS, ALIAS_HOST, "2", B);
        expect(await body(await call(ALIAS_HOST))).toBe("served:b.sites.example.net");
        expect(await body(await call("other.sites.example.net"))).toBe(
            "served:a.sites.example.net",
        );
        bind(ALIAS, ALIAS_HOST, "3", A);
        expect(await body(await call(ALIAS_HOST))).toBe("served:a.sites.example.net");
        expect(seen.at(-1)).toMatchObject({
            method: "GET",
            path: "/",
            hostname: "a.sites.example.net",
        });
    });

    it("returns the same fixed 404 for unknown, unbound, withdrawn and unusual hosts, never calling upstream", async () => {
        const { call, bind, seen } = setup();
        bind(OTHER, "unbound.sites.example.net", "1", null);
        bind(ALIAS, ALIAS_HOST, "1", A);
        bind(ALIAS, ALIAS_HOST, "2", null);
        const hosts = [
            "unknown.sites.example.net",
            "unbound.sites.example.net",
            ALIAS_HOST,
            "a.sites.example.net:80:80",
            "a.sites.example.net.",
            "[::1]",
            "user@a.sites.example.net",
            "a.sites.example.net:0",
            "a.sites.example.net:00080",
            "a.sites.example.net:65536",
            "a.sites.example.net:abc",
            "a.sites.example.net,b.sites.example.net",
            "a.sites.example.net b.sites.example.net",
            "%61.sites.example.net",
            "é.sites.example.net",
            "10.0.0.1",
            "localhost",
        ];
        const texts = new Set<string>();
        for (const host of hosts) {
            const response = await call(host);
            expect(response.status, host).toBe(404);
            texts.add(await response.text());
        }
        expect([...texts]).toEqual(["Not found\n"]);
        expect(seen).toHaveLength(0);
        // A missing Host header (HTTP/1.0 style) is not a host either.
        const missing = await setup().handle(new Request("http://x.invalid/"));
        expect(missing.status).toBe(404);
    });

    it("canonicalizes case and port before the registry lookup", async () => {
        const { call, bind, seen } = setup();
        bind(ALIAS, ALIAS_HOST, "1", A);
        for (const host of [
            "VIEW-SITE.Sites.Example.NET",
            `${ALIAS_HOST}:8080`,
            `${ALIAS_HOST}:443`,
        ]) {
            const response = await call(host);
            expect(response.status, host).toBe(200);
        }
        expect(seen).toHaveLength(3);
        expect(canonicalHost(new Request("http://x/", { headers: { host: ALIAS_HOST } }))).toBe(
            ALIAS_HOST,
        );
    });

    it("allows only GET, HEAD and OPTIONS and never forwards a body", async () => {
        const { handle, bind, seen } = setup();
        bind(ALIAS, ALIAS_HOST, "1", A);
        const send = (init: RequestInit) =>
            handle(
                new Request(`http://${ALIAS_HOST}/`, {
                    ...init,
                    headers: { host: ALIAS_HOST, ...(init.headers as object) },
                }),
            );
        for (const method of ["POST", "PUT", "PATCH", "DELETE", "TRACE"]) {
            const response = await send({ method });
            expect(response.status, method).toBe(405);
            expect(response.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
        }
        for (const method of ["GET", "HEAD", "OPTIONS"]) {
            expect((await send({ method })).status, method).toBe(200);
        }
        expect((await send({ method: "GET", headers: { "content-length": "5" } })).status).toBe(
            400,
        );
        expect(
            (await send({ method: "GET", headers: { "transfer-encoding": "chunked" } })).status,
        ).toBe(400);
        expect(seen.map((r) => r.method)).toEqual(["GET", "HEAD", "OPTIONS"]);
    });

    it("rewrites Host, forwards the path and query, and drops hop-by-hop and forwarding headers", async () => {
        const { call, bind, seen } = setup();
        bind(ALIAS, ALIAS_HOST, "1", A);
        await call(ALIAS_HOST, {
            path: "/a/b.css?x=1&y=%20z",
            headers: {
                connection: "keep-alive, x-secret",
                "x-secret": "named by Connection",
                "keep-alive": "timeout=5",
                te: "trailers",
                upgrade: "websocket",
                "proxy-authorization": "Basic x",
                "proxy-foo": "x",
                forwarded: "for=1.2.3.4",
                "x-forwarded-for": "1.2.3.4",
                "x-forwarded-host": "evil.example.org",
                "x-real-ip": "1.2.3.4",
                via: "1.1 evil",
                authorization: "Bearer control-token",
                "x-launchpad-epoch": "e",
                "x-launchpad-instance": "i",
                cookie: "session=abc",
                accept: "text/css",
                "user-agent": "tests",
            },
        });
        const request = seen.at(-1)!;
        expect(request.path).toBe("/a/b.css?x=1&y=%20z");
        expect(request.hostname).toBe("a.sites.example.net");
        expect(request.headers).toEqual({
            accept: "text/css",
            cookie: "session=abc",
            "user-agent": "tests",
        });
    });

    it("never lets the client choose the upstream: absolute-form and dot-segment targets stay on the path", async () => {
        const { handle, bind, seen } = setup();
        bind(ALIAS, ALIAS_HOST, "1", A);
        await handle(
            new Request("http://evil.example.org/https://169.254.169.254/", {
                headers: { host: ALIAS_HOST },
            }),
        );
        expect(seen).toHaveLength(0);
        const response = await handle(
            new Request(`http://${ALIAS_HOST}//169.254.169.254/x`, {
                headers: { host: ALIAS_HOST },
            }),
        );
        expect(response.status).toBe(200);
        expect(seen.at(-1)!.path).toBe("//169.254.169.254/x");
        expect(seen.at(-1)!.hostname).toBe("a.sites.example.net");
    });

    it("maps upstream failures to fixed 502/504 and an unavailable store to a fixed 503", async () => {
        const failing = (failure: "timeout" | "bad-gateway" | "other") =>
            (async () => {
                throw failure === "other" ? new Error("secret detail") : new UpstreamError(failure);
            }) as Upstream;
        for (const [failure, status, text] of [
            ["timeout", 504, "Gateway timeout\n"],
            ["bad-gateway", 502, "Bad gateway\n"],
            ["other", 502, "Bad gateway\n"],
        ] as const) {
            const { call, bind } = setup(failing(failure));
            bind(ALIAS, ALIAS_HOST, "1", A);
            const response = await call(ALIAS_HOST);
            expect(response.status).toBe(status);
            expect(await response.text()).toBe(text);
            fixture.cleanup();
        }
        const { call, bind } = setup();
        bind(ALIAS, ALIAS_HOST, "1", A);
        fixture.store.close();
        const down = await call(ALIAS_HOST);
        expect(down.status).toBe(503);
        expect(await down.text()).toBe("Routing unavailable\n");
        expect(down.headers.get("cache-control")).toBe("no-store");
    });

    it("passes the client's abort signal to the upstream", async () => {
        let seenSignal: AbortSignal | undefined;
        const { call, bind } = setup(async (request) => {
            seenSignal = request.signal;
            return new Response("ok");
        });
        bind(ALIAS, ALIAS_HOST, "1", A);
        await call(ALIAS_HOST);
        expect(seenSignal).toBeInstanceOf(AbortSignal);
    });
});
