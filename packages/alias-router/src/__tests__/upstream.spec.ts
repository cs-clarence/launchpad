import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TLSSocket } from "node:tls";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDataHandler } from "../host/data";
import { hostFixture, type HostFixture } from "../host/test-support";
import { createHttpUpstream, UpstreamError, type UpstreamRequest } from "../host/upstream";

// Loopback listeners only, in this integration suite (the default `test` opens none). They
// exercise the real Node HTTP/HTTPS transport that production uses.

interface Seen {
    host?: string;
    path?: string;
    headers: http.IncomingHttpHeaders;
    sni?: string;
}
const servers: { close: (callback?: () => void) => unknown; closeAllConnections?: () => void }[] =
    [];
afterEach(async () => {
    for (const server of servers.splice(0)) {
        server.closeAllConnections?.();
        await new Promise<void>((done) => server.close(() => done()));
    }
});

async function listen<T extends http.Server | https.Server>(server: T): Promise<number> {
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    return (server.address() as AddressInfo).port;
}
const request = (hostname: string, overrides: Partial<UpstreamRequest> = {}): UpstreamRequest => ({
    method: "GET",
    path: "/",
    headers: {},
    hostname,
    signal: new AbortController().signal,
    ...overrides,
});

describe("plain HTTP upstream", () => {
    it("rewrites Host, forwards path and query and only the allowed headers, and filters the response", async () => {
        const seen: Seen[] = [];
        const port = await listen(
            http.createServer((req, res) => {
                seen.push({ host: req.headers.host, path: req.url, headers: req.headers });
                res.writeHead(200, [
                    ["Content-Type", "text/css"],
                    ["Connection", "close, X-Hop"],
                    ["X-Hop", "named by Connection"],
                    ["Keep-Alive", "timeout=5"],
                    ["Set-Cookie", "a=1; Path=/"],
                    ["Set-Cookie", "b=2; Path=/"],
                    ["X-Launchpad-Deployment", "abc"],
                ]);
                res.end("body");
            }),
        );
        const upstream = createHttpUpstream({ origin: new URL(`http://127.0.0.1:${port}`) });
        const response = await upstream(
            request("a.sites.example.net", { path: "/x/y?q=%20", headers: { accept: "text/css" } }),
        );
        expect(await response.text()).toBe("body");
        expect(seen[0]!.host).toBe("a.sites.example.net");
        expect(seen[0]!.path).toBe("/x/y?q=%20");
        expect(seen[0]!.headers.accept).toBe("text/css");
        expect(response.headers.get("content-type")).toBe("text/css");
        expect(response.headers.get("x-launchpad-deployment")).toBe("abc");
        expect(response.headers.get("x-hop")).toBeNull();
        expect(response.headers.get("keep-alive")).toBeNull();
        expect(response.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    });

    it("returns redirects instead of following them, and no body for HEAD, 204 and 304", async () => {
        const port = await listen(
            http.createServer((req, res) => {
                if (req.url === "/redirect") {
                    res.writeHead(302, { location: "http://b.sites.example.net/" });
                    return res.end();
                }
                if (req.url === "/nochange") return res.writeHead(304).end();
                if (req.url === "/empty") return res.writeHead(204).end();
                res.writeHead(200, { "content-length": "4" });
                res.end(req.method === "HEAD" ? undefined : "body");
            }),
        );
        const upstream = createHttpUpstream({ origin: new URL(`http://127.0.0.1:${port}`) });
        const redirect = await upstream(request("a.sites.example.net", { path: "/redirect" }));
        expect(redirect.status).toBe(302);
        expect(redirect.headers.get("location")).toBe("http://b.sites.example.net/");
        expect((await upstream(request("a.sites.example.net", { path: "/nochange" }))).status).toBe(
            304,
        );
        expect((await upstream(request("a.sites.example.net", { path: "/empty" }))).status).toBe(
            204,
        );
        const head = await upstream(request("a.sites.example.net", { method: "HEAD" }));
        expect(head.status).toBe(200);
        expect(await head.text()).toBe("");
    });

    it("streams a large body unchanged", async () => {
        const payload = Buffer.alloc(3 * 1024 * 1024, "abc");
        const port = await listen(http.createServer((_req, res) => res.end(payload)));
        const upstream = createHttpUpstream({ origin: new URL(`http://127.0.0.1:${port}`) });
        const response = await upstream(request("a.sites.example.net"));
        expect(Buffer.from(await response.arrayBuffer()).equals(payload)).toBe(true);
    });

    it("times out waiting for headers, reports an unreachable upstream, and honours an abort", async () => {
        let closed = false;
        const port = await listen(
            http.createServer((req) => {
                req.on("close", () => (closed = true));
            }),
        );
        const upstream = createHttpUpstream({
            origin: new URL(`http://127.0.0.1:${port}`),
            headersTimeoutMs: 150,
        });
        const slow = upstream(request("a.sites.example.net")).catch((e) => e);
        expect(await slow).toMatchObject({ name: "UpstreamError", failure: "timeout" });
        await expect.poll(() => closed).toBe(true);

        const dead = createHttpUpstream({ origin: new URL("http://127.0.0.1:1") });
        expect(await dead(request("a.sites.example.net")).catch((e) => e)).toMatchObject({
            failure: "bad-gateway",
        });

        const controller = new AbortController();
        closed = false;
        const aborted = upstream(
            request("a.sites.example.net", { signal: controller.signal }),
        ).catch((e) => e);
        setTimeout(() => controller.abort(), 20);
        expect(await aborted).toBeInstanceOf(UpstreamError);
        await expect.poll(() => closed).toBe(true);
    });

    it("releases the abort listener when the request fails or the status is out of range", async () => {
        const port = await listen(http.createServer((_req, res) => res.destroy()));
        const upstream = createHttpUpstream({ origin: new URL(`http://127.0.0.1:${port}`) });
        const controller = new AbortController();
        const added: string[] = [];
        const removed: string[] = [];
        const signal = controller.signal;
        const add = signal.addEventListener.bind(signal);
        const remove = signal.removeEventListener.bind(signal);
        signal.addEventListener = ((type: string, ...rest: unknown[]) => {
            added.push(type);
            return (add as (...a: unknown[]) => void)(type, ...rest);
        }) as typeof signal.addEventListener;
        signal.removeEventListener = ((type: string, ...rest: unknown[]) => {
            removed.push(type);
            return (remove as (...a: unknown[]) => void)(type, ...rest);
        }) as typeof signal.removeEventListener;
        await upstream(request("a.sites.example.net", { signal })).catch(() => undefined);
        expect(added).toEqual(["abort"]);
        expect(removed).toEqual(["abort"]);
    });

    it("aborts the body stream when the upstream stalls after sending headers", async () => {
        const port = await listen(
            http.createServer((_req, res) => {
                res.writeHead(200, { "content-length": "100" });
                res.write("partial");
            }),
        );
        const upstream = createHttpUpstream({
            origin: new URL(`http://127.0.0.1:${port}`),
            idleTimeoutMs: 150,
        });
        const response = await upstream(request("a.sites.example.net"));
        expect(response.status).toBe(200);
        await expect(response.text()).rejects.toBeDefined();
    });

    it("refuses an upstream with a path and a client-chosen origin cannot be configured per request", () => {
        expect(() => createHttpUpstream({ origin: new URL("http://127.0.0.1:1/base") })).toThrow(
            "no path",
        );
    });
});

describe("HTTPS upstream: Host, SNI and certificate verification", () => {
    let dir = "";
    let port = 0;
    let server: https.Server;
    const seen: Seen[] = [];
    const openssl = (...args: string[]) =>
        execFileSync("openssl", args, { cwd: dir, stdio: "pipe", env: { PATH: process.env.PATH } });

    beforeAll(async () => {
        dir = mkdtempSync(path.join(tmpdir(), "launchpad-router-tls-"));
        openssl(
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            "ca.key",
            "-out",
            "ca.crt",
            "-days",
            "1",
            "-subj",
            "/CN=Router Test CA",
        );
        openssl(
            "req",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            "server.key",
            "-out",
            "server.csr",
            "-subj",
            "/CN=tls.sites.example.net",
        );
        writeFileSync(
            path.join(dir, "ext"),
            "subjectAltName=DNS:tls.sites.example.net\nextendedKeyUsage=serverAuth\n",
        );
        openssl(
            "x509",
            "-req",
            "-in",
            "server.csr",
            "-CA",
            "ca.crt",
            "-CAkey",
            "ca.key",
            "-CAcreateserial",
            "-out",
            "server.crt",
            "-days",
            "1",
            "-extfile",
            "ext",
        );
        server = https.createServer(
            {
                key: readFileSync(path.join(dir, "server.key")),
                cert: readFileSync(path.join(dir, "server.crt")),
            },
            (req, res) => {
                seen.push({
                    host: req.headers.host,
                    headers: req.headers,
                    sni: (req.socket as TLSSocket & { servername?: string }).servername,
                });
                res.end("secure");
            },
        );
        // Its own lifecycle: the per-test cleanup above must not close this shared server.
        await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
        port = (server.address() as AddressInfo).port;
    });
    afterAll(async () => {
        server.closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
        rmSync(dir, { recursive: true, force: true });
    });

    it("sends the trusted hostname as Host and SNI, and verifies the certificate against it", async () => {
        const upstream = createHttpUpstream({
            origin: new URL(`https://127.0.0.1:${port}`),
            caFile: path.join(dir, "ca.crt"),
        });
        const response = await upstream(request("tls.sites.example.net"));
        expect(await response.text()).toBe("secure");
        expect(seen.at(-1)).toMatchObject({
            host: "tls.sites.example.net",
            sni: "tls.sites.example.net",
        });
    });

    it("fails closed when the certificate does not match the name or the CA is not trusted", async () => {
        const before = seen.length;
        // Control: the same server answers when name and CA are right, so a refusal below is the
        // certificate check and not an unreachable port.
        const control = createHttpUpstream({
            origin: new URL(`https://127.0.0.1:${port}`),
            caFile: path.join(dir, "ca.crt"),
        });
        expect((await control(request("tls.sites.example.net"))).status).toBe(200);
        const baseline = seen.length;
        const trusted = createHttpUpstream({
            origin: new URL(`https://127.0.0.1:${port}`),
            caFile: path.join(dir, "ca.crt"),
        });
        expect(await trusted(request("wrong.sites.example.net")).catch((e) => e)).toMatchObject({
            failure: "bad-gateway",
        });
        const noCa = createHttpUpstream({ origin: new URL(`https://127.0.0.1:${port}`) });
        expect(await noCa(request("tls.sites.example.net")).catch((e) => e)).toMatchObject({
            failure: "bad-gateway",
        });
        expect(seen).toHaveLength(baseline);
        expect(baseline).toBe(before + 1);
    });
});

describe("data handler with the real transport", () => {
    let fixture: HostFixture;
    afterEach(() => fixture?.cleanup());

    it("serves an alias from the deployment's hostname and returns a fixed 502 when the upstream is down", async () => {
        const hosts: (string | undefined)[] = [];
        const port = await listen(
            http.createServer((req, res) => {
                hosts.push(req.headers.host);
                res.writeHead(200, { "x-launchpad-deployment": req.headers.host ?? "" });
                res.end("hello");
            }),
        );
        fixture = hostFixture();
        const writer = fixture.store.authenticate(fixture.credentials);
        const target = randomUUID();
        fixture.store.registerDeployment(writer, {
            deploymentId: target,
            hostname: "a.sites.example.net",
        });
        fixture.store.replaceRoute(writer, {
            aliasId: randomUUID(),
            hostname: "view-site.sites.example.net",
            operationId: randomUUID(),
            generation: "1",
            targetDeploymentId: target,
        });
        const handle = createDataHandler(fixture.store, {
            upstream: createHttpUpstream({ origin: new URL(`http://127.0.0.1:${port}`) }),
        });
        const get = (host: string) => handle(new Request(`http://${host}/`, { headers: { host } }));
        const ok = await get("view-site.sites.example.net");
        expect(await ok.text()).toBe("hello");
        expect(hosts).toEqual(["a.sites.example.net"]);
        expect(ok.headers.get("x-launchpad-deployment")).toBe("a.sites.example.net");
        expect((await get("unbound.sites.example.net")).status).toBe(404);
        expect(hosts).toHaveLength(1);

        const down = createDataHandler(fixture.store, {
            upstream: createHttpUpstream({ origin: new URL("http://127.0.0.1:1") }),
        });
        const failed = await down(
            new Request("http://view-site.sites.example.net/", {
                headers: { host: "view-site.sites.example.net" },
            }),
        );
        expect(failed.status).toBe(502);
        expect(await failed.text()).toBe("Bad gateway\n");
    });
});
