import http from "node:http";
import https from "node:https";
import { existsSync, readFileSync } from "node:fs";
import { controlProxy } from "./fault-proxy";

// TLS fixture exposes exactly what Host and SNI arrived; the separate ingress proxy
// proves that reaching the router does not depend on a particular tunnel/VPN product.
https
    .createServer(
        {
            key: readFileSync("/tls/server.key"),
            cert: readFileSync("/tls/server.crt"),
        },
        (request, response) => {
            response.end(
                JSON.stringify({
                    host: request.headers.host,
                    sni: (request.socket as import("node:tls").TLSSocket & { servername?: string })
                        .servername,
                }),
            );
        },
    )
    .listen(8443, "0.0.0.0");
http.createServer((request, response) => {
    if (existsSync("/data/ingress-closed")) {
        response.writeHead(503);
        response.end("Ingress closed\n");
        return;
    }
    const upstream = http.request(
        {
            hostname: "router",
            port: 8080,
            path: request.url,
            headers: { host: request.headers.host ?? "" },
        },
        (incoming) => {
            response.writeHead(incoming.statusCode ?? 502);
            incoming.pipe(response);
        },
    );
    upstream.on("error", () => {
        response.writeHead(502);
        response.end();
    });
    request.pipe(upstream);
}).listen(8080, "0.0.0.0");

controlProxy("router", 8081).listen(8082, "0.0.0.0");
