import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

// Shared by the live experiment and its cheap preflight: this must drop the TCP
// response, not return an HTTP error that could be mistaken for a router outcome.
export function controlProxy(hostname: string, port: number) {
    return http.createServer((request, response) => {
        const upstream = http.request(
            {
                hostname,
                port,
                path: request.url,
                method: request.method,
                headers: {
                    authorization: request.headers.authorization ?? "",
                    "x-epoch": request.headers["x-epoch"] ?? "",
                    "content-type": "application/json",
                },
            },
            (incoming) => {
                if (request.headers["x-experiment-drop-response"] === "1") {
                    incoming.resume();
                    // response.destroy() under Bun's node:http compatibility layer may
                    // complete an empty response. Destroy the underlying socket instead.
                    request.socket.destroy();
                } else {
                    response.writeHead(incoming.statusCode ?? 502);
                    incoming.pipe(response);
                }
            },
        );
        upstream.on("error", () => {
            response.writeHead(502);
            response.end();
        });
        request.pipe(upstream);
    });
}

export async function verifyFaultTransport() {
    let committed = false;
    const origin = http.createServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) body += chunk;
        if (request.method === "POST" && body !== '{"operation":"test"}') {
            response.writeHead(400);
            response.end("bad body");
            return;
        }
        committed = true;
        response.end("committed");
    });
    origin.listen(0, "127.0.0.1");
    await once(origin, "listening");
    const proxy = controlProxy("127.0.0.1", (origin.address() as AddressInfo).port);
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const url = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
        assert.equal(response.status, 200);
        assert.equal(await response.text(), "committed");
        committed = false;
        await assert.rejects(
            fetch(url, {
                method: "POST",
                body: '{"operation":"test"}',
                headers: { "x-experiment-drop-response": "1" },
                signal: AbortSignal.timeout(3000),
            }),
        );
        assert.equal(committed, true, "The origin must commit before its response is lost.");
        console.log("Response-loss transport preflight passed.");
    } finally {
        proxy.closeAllConnections();
        origin.closeAllConnections();
        proxy.close();
        origin.close();
    }
}
