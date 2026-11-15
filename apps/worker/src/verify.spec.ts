import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compactId } from "./template";
import { parseProxyUrl, probe } from "./verify";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
let server: http.Server;
let url: URL;
let hosts: (string | undefined)[] = [];
let respond: (res: http.ServerResponse) => void;

beforeAll(async () => {
    server = http.createServer((req, res) => {
        hosts.push(req.headers.host);
        respond(res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const config = () => ({ proxyUrl: url, timeoutMs: 1500, intervalMs: 50 });
const target = { hostname: "demo-a1b2c3.previews.example.com", deploymentId: ID };
const stamped = (res: http.ServerResponse, status = 200, id = compactId(ID)) => {
    res.writeHead(status, { "X-Launchpad-Deployment": id });
    res.end("ok");
};

describe("the readiness probe", () => {
    it("asks the proxy for the preview's own hostname and accepts this deployment's 200", async () => {
        hosts = [];
        respond = (res) => stamped(res);
        await expect(
            probe(target, config(), new AbortController().signal),
        ).resolves.toBeUndefined();
        expect(hosts[0]).toBe("demo-a1b2c3.previews.example.com");
    });

    it("does not accept an older deployment, a non-200, or a missing stamp", async () => {
        for (const answer of [
            (res: http.ServerResponse) => stamped(res, 200, "f".repeat(32)),
            (res: http.ServerResponse) => stamped(res, 404),
            (res: http.ServerResponse) => stamped(res, 502),
            (res: http.ServerResponse) => {
                res.writeHead(200);
                res.end("no header");
            },
        ]) {
            respond = answer;
            await expect(
                probe(target, { ...config(), timeoutMs: 300 }, new AbortController().signal),
            ).rejects.toThrow(/did not become ready/);
        }
    });

    it("waits for the preview to come up", async () => {
        let calls = 0;
        respond = (res) => (++calls < 4 ? stamped(res, 502) : stamped(res));
        await probe(target, config(), new AbortController().signal);
        expect(calls).toBe(4);
    });

    it("keeps trying while nothing is listening, and stops when cancelled", async () => {
        const dead = { ...config(), proxyUrl: new URL("http://127.0.0.1:1"), timeoutMs: 400 };
        await expect(probe(target, dead, new AbortController().signal)).rejects.toThrow(
            /did not become ready/,
        );
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 100);
        await expect(
            probe(target, { ...dead, timeoutMs: 10_000 }, controller.signal),
        ).rejects.toThrow();
    });

    it("accepts only http and https proxy URLs", () => {
        expect(parseProxyUrl("http://dokku:80").hostname).toBe("dokku");
        expect(() => parseProxyUrl("ftp://x")).toThrow();
        expect(() => parseProxyUrl("nope")).toThrow();
    });
});
