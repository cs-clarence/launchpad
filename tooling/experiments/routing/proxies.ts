// Support servers for the production-router rehearsal, run inside the worker image (Bun) with this
// directory mounted read-only. They are test doubles around the real router, not part of it:
//   ingress       an ordinary reverse proxy in front of the data plane, with a closable gate
//   control-proxy a proxy in front of the control plane that can drop a response after the router
//                 has committed (the router itself has no such hook)
//   tls-upstream  an https server that reports the Host header and SNI it received
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { TLSSocket } from "node:tls";

const mode = process.argv[2];
// Logged from the listen callback, i.e. once the port is really bound, not when listen() was called.
const ready = () => console.log(`${mode} ready`);
const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "te", "upgrade", "trailer"]);

function forward(
    target: { hostname: string; port: number },
    request: http.IncomingMessage,
    response: http.ServerResponse,
    dropResponse = false,
) {
    const headers: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(request.headers)) {
        if (!HOP.has(name) && name !== "x-experiment-drop-response") headers[name] = value;
    }
    const upstream = http.request(
        { ...target, path: request.url, method: request.method, headers },
        (incoming) => {
            if (dropResponse) {
                // The router has answered (and committed); the caller never sees it.
                incoming.resume();
                request.socket.destroy();
                return;
            }
            const outgoing: http.OutgoingHttpHeaders = {};
            for (const [name, value] of Object.entries(incoming.headers)) {
                if (!HOP.has(name)) outgoing[name] = value;
            }
            response.writeHead(incoming.statusCode ?? 502, outgoing);
            incoming.pipe(response);
        },
    );
    upstream.on("error", () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
    });
    request.pipe(upstream);
}

if (mode === "ingress") {
    http.createServer((request, response) => {
        if (existsSync("/data/ingress-closed")) {
            response.writeHead(503);
            response.end("Ingress closed\n");
            return;
        }
        forward({ hostname: "router", port: 8080 }, request, response);
    }).listen(8080, "0.0.0.0", ready);
} else if (mode === "control-proxy") {
    http.createServer((request, response) =>
        forward(
            { hostname: "router", port: 8081 },
            request,
            response,
            request.headers["x-experiment-drop-response"] === "1",
        ),
    ).listen(8082, "0.0.0.0", ready);
} else if (mode === "tls-upstream") {
    https
        .createServer(
            { key: readFileSync("/tls/server.key"), cert: readFileSync("/tls/server.crt") },
            (request, response) => {
                response.end(
                    JSON.stringify({
                        host: request.headers.host,
                        sni: (request.socket as TLSSocket & { servername?: string }).servername,
                    }),
                );
            },
        )
        .listen(8443, "0.0.0.0", ready);
} else {
    throw new Error("Unknown mode.");
}
