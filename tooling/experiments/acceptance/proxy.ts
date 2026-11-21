// Control-plane proxy for the acceptance rehearsal, run inside the worker image (Bun) with this
// directory mounted read-only. A test double in front of the real router, not part of it. Workers
// share this container's network namespace, so the control URL they are configured with is
// http://127.0.0.1:8082 (the control client accepts plain HTTP only on loopback).
//
//   :8082 proxy  forwards to router:8081; a matching rule holds the request (it is forwarded only
//                when released, even if its caller is gone: a delayed packet) or drops the
//                response after the router has committed
//   :8083 admin  POST /rules, POST /release/<id>, GET /log; private network only
//
// Only identifiers of route writes are recorded, never a header or a token.
import http from "node:http";
import { isFaultRule, pickRule, summarize, type FaultRule } from "./rules";

const ROUTER = { hostname: "router", port: 8081 };
const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "te", "upgrade", "trailer"]);

interface Entry {
    seq: number;
    at: string;
    method: string;
    path: string;
    request: Record<string, string | null>;
    rule: string | null;
    outcome: "forwarded" | "held" | "released" | "response-dropped" | "router-unreachable";
    routerStatus: number | null;
    routerConflict: boolean;
    callerGone: boolean | null;
}
const log: Entry[] = [];
const rules: FaultRule[] = [];
const spent = new Set<string>();
const held = new Map<string, () => void>();

function forward(method: string, url: string, headers: http.IncomingHttpHeaders, body: Buffer) {
    return new Promise<{ status: number; headers: http.OutgoingHttpHeaders; body: Buffer }>(
        (resolve, reject) => {
            const out: http.OutgoingHttpHeaders = {};
            for (const [name, value] of Object.entries(headers)) {
                if (!HOP.has(name) && name !== "content-length") out[name] = value;
            }
            out["content-length"] = body.length;
            const upstream = http.request(
                { ...ROUTER, path: url, method, headers: out },
                (incoming) => {
                    const chunks: Buffer[] = [];
                    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
                    incoming.once("error", reject);
                    incoming.once("close", () => {
                        if (!incoming.complete) reject(new Error("Incomplete router response."));
                    });
                    incoming.on("end", () => {
                        const reply: http.OutgoingHttpHeaders = {};
                        for (const [name, value] of Object.entries(incoming.headers)) {
                            if (!HOP.has(name) && name !== "content-length") reply[name] = value;
                        }
                        resolve({
                            status: incoming.statusCode ?? 502,
                            headers: reply,
                            body: Buffer.concat(chunks),
                        });
                    });
                },
            );
            upstream.on("error", reject);
            upstream.setTimeout(10_000, () => upstream.destroy(new Error("Router timed out.")));
            upstream.end(body);
        },
    );
}

function parse(body: Buffer): unknown {
    try {
        return JSON.parse(body.toString("utf8"));
    } catch {
        return null;
    }
}

const proxy = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", async () => {
        const body = Buffer.concat(chunks);
        const shape = {
            method: request.method ?? "GET",
            path: request.url ?? "/",
            body: parse(body),
        };
        const entry: Entry = {
            seq: log.length + 1,
            at: new Date().toISOString(),
            method: shape.method,
            path: shape.path.split("?")[0]!,
            request: summarize(shape.body),
            rule: null,
            outcome: "forwarded",
            routerStatus: null,
            routerConflict: false,
            callerGone: null,
        };
        log.push(entry);
        const rule = pickRule(rules, spent, shape);
        if (rule) {
            spent.add(rule.id);
            entry.rule = rule.id;
        }
        const relay = (reply: Awaited<ReturnType<typeof forward>>) => {
            entry.routerStatus = reply.status;
            const payload = parse(reply.body);
            entry.routerConflict =
                reply.status === 409 &&
                typeof payload === "object" &&
                payload !== null &&
                "error" in payload &&
                payload.error === "conflict";
            entry.callerGone = request.socket.destroyed;
            if (request.socket.destroyed) return;
            response.writeHead(reply.status, reply.headers);
            response.end(reply.body);
        };
        try {
            if (rule?.action === "hold") {
                entry.outcome = "held";
                await new Promise<void>((resolve) => held.set(rule.id, resolve));
                held.delete(rule.id);
                entry.outcome = "released";
                relay(await forward(shape.method, shape.path, request.headers, body));
                return;
            }
            const reply = await forward(shape.method, shape.path, request.headers, body);
            if (rule?.action === "drop-response") {
                // The router has answered and committed; the caller never sees it.
                entry.outcome = "response-dropped";
                entry.routerStatus = reply.status;
                request.socket.destroy();
                return;
            }
            relay(reply);
        } catch {
            entry.outcome = "router-unreachable";
            if (!request.socket.destroyed) response.writeHead(502).end();
        }
    });
});

const admin = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
        const url = request.url ?? "/";
        const json = (status: number, value: unknown) =>
            response
                .writeHead(status, { "content-type": "application/json" })
                .end(JSON.stringify(value));
        if (request.method === "POST" && url === "/rules") {
            const rule = parse(Buffer.concat(chunks));
            if (!isFaultRule(rule) || rules.some((existing) => existing.id === rule.id)) {
                return json(400, { error: "invalid rule" });
            }
            rules.push(rule);
            return json(200, { ok: true });
        }
        if (request.method === "POST" && url.startsWith("/release/")) {
            const release = held.get(url.slice("/release/".length));
            if (!release) return json(404, { error: "nothing held" });
            release();
            return json(200, { ok: true });
        }
        if (request.method === "GET" && url === "/log") return json(200, log);
        return json(404, { error: "unknown" });
    });
});

proxy.listen(8082, "0.0.0.0", () => {
    admin.listen(8083, "0.0.0.0", () => console.log("control-proxy ready"));
});
