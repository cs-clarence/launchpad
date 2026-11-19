// EXPERIMENT ONLY. Single-process Bun + SQLite candidate, no application integration.
// Fault hooks deliberately exist here to test the commit boundary; never ship this server.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import http from "node:http";
import https from "node:https";

type Target = { hostname: string; address: string; port: number; tls?: boolean };
type Route = {
    alias: string;
    host: string;
    operation: string;
    generation: string;
    target: string | null;
};
type Config = {
    instance: string;
    epoch: string;
    credential: string;
    aliases: Record<string, string>;
    targets: Record<string, Target>;
    ca: string;
};
const config: Config = await Bun.file("/experiment/router-config.json").json();
const file = "/state/routes.sqlite";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const initialize = process.argv.includes("--initialize");
if (!initialize) statSync(file); // State loss cannot silently initialize an empty router.
const db = new Database(file, { create: initialize, strict: true });
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
if (initialize) {
    db.exec(
        "CREATE TABLE authority (id INTEGER PRIMARY KEY CHECK(id=1), epoch TEXT NOT NULL, credential TEXT NOT NULL); CREATE TABLE route (host TEXT PRIMARY KEY, alias TEXT UNIQUE NOT NULL, operation TEXT NOT NULL, generation TEXT NOT NULL, target TEXT);",
    );
    db.query("INSERT INTO authority VALUES(1,?,?)").run(config.epoch, hash(config.credential));
    db.close();
    console.log("experimental router state initialized");
    process.exit(0);
}
const authority = () =>
    db
        .query<{ epoch: string; credential: string }, []>(
            "SELECT epoch,credential FROM authority WHERE id=1",
        )
        .get()!;
const lookup = (host: string) =>
    db.query<Route, [string]>("SELECT * FROM route WHERE host=?").get(host);
const auth = (epoch: string, credential: string) => {
    const current = authority();
    return epoch === current.epoch && hash(credential) === current.credential;
};
const available = () => {
    // A still-open SQLite inode is not permission to keep serving after state has disappeared.
    statSync(file);
    db.query("SELECT 1 FROM authority").get();
};
const gates = new Map<string, { release: () => void; wait: Promise<void> }>();
const json = (value: unknown, status = 200) => Response.json(value, { status });
const ca = await Bun.file(config.ca).text();

Bun.serve({
    port: 8081,
    hostname: "0.0.0.0",
    maxRequestBodySize: 8192,
    async fetch(request) {
        try {
            available();
            const credential = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
            const epoch = request.headers.get("x-epoch") ?? "";
            if (!auth(epoch, credential)) return json({ error: "unauthorized" }, 401);
            const url = new URL(request.url);
            if (request.method === "GET" && url.pathname === "/routes") {
                return json({
                    epoch: authority().epoch,
                    routes: db.query("SELECT * FROM route ORDER BY host").all(),
                });
            }
            if (request.method !== "POST") return json({}, 405);
            const body = await request.json();
            if (url.pathname === "/release") {
                gates.get(body.operation)?.release();
                return json({});
            }
            if (url.pathname === "/held") return json({ held: gates.has(body.operation) });
            if (url.pathname === "/rotate") {
                if (
                    typeof body.epoch !== "string" ||
                    typeof body.credential !== "string" ||
                    body.credential.length < 32
                )
                    return json({}, 400);
                const changed = db.transaction(() => {
                    if (!auth(epoch, credential)) return false;
                    db.query("UPDATE authority SET epoch=?,credential=? WHERE id=1").run(
                        body.epoch,
                        hash(body.credential),
                    );
                    return true;
                })();
                return json({ epoch: authority().epoch }, changed ? 200 : 401);
            }
            if (url.pathname !== "/write") return json({}, 404);
            if (
                body.instance !== config.instance ||
                config.aliases[body.host] !== body.alias ||
                !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
                    body.operation,
                ) ||
                typeof body.generation !== "string" ||
                !/^[1-9][0-9]{0,77}$/.test(body.generation) ||
                !(body.target === null || Object.hasOwn(config.targets, body.target))
            )
                return json({ error: "invalid" }, 400);
            if (body.hold === true) {
                const gate = Promise.withResolvers<void>();
                gates.set(body.operation, { release: () => gate.resolve(), wait: gate.promise });
                // Failure injection: request has authenticated, parsed and validated, but NOT committed.
                await gate.promise;
                gates.delete(body.operation);
            }
            const status = db.transaction(() => {
                available();
                // No await between this check, route CAS and durable transaction commit.
                if (!auth(epoch, credential)) return 401;
                const old = lookup(body.host);
                if (old) {
                    if (
                        old.generation === body.generation &&
                        old.operation === body.operation &&
                        old.alias === body.alias &&
                        old.target === body.target
                    )
                        return 200;
                    if (BigInt(old.generation) >= BigInt(body.generation)) return 409;
                }
                db.query(
                    "INSERT INTO route VALUES(?,?,?,?,?) ON CONFLICT(host) DO UPDATE SET operation=excluded.operation,generation=excluded.generation,target=excluded.target",
                ).run(body.host, body.alias, body.operation, body.generation, body.target);
                return 200;
            })();
            return json({ epoch: authority().epoch, route: lookup(body.host) }, status);
        } catch {
            return json({ error: "unavailable" }, 503);
        }
    },
});
http.createServer((request, response) => {
    try {
        available();
        const host = (request.headers.host ?? "").toLowerCase().split(":")[0]!;
        const route = lookup(host);
        if (!route?.target) {
            response.writeHead(404, { "content-type": "text/plain" });
            response.end("Not found\n");
            return;
        }
        const target = config.targets[route.target]!;
        const upstream = (target.tls ? https : http).request(
            {
                hostname: target.address,
                port: target.port,
                path: request.url,
                method: request.method,
                // Fixed host/SNI and CA validation. Never forward caller-controlled proxy headers.
                headers: { host: target.hostname },
                ...(target.tls
                    ? { servername: target.hostname, ca, rejectUnauthorized: true }
                    : {}),
                timeout: 5000,
            },
            (incoming) => {
                response.writeHead(incoming.statusCode ?? 502, {
                    "content-type": "text/plain",
                    ...(incoming.headers["x-launchpad-deployment"]
                        ? {
                              "x-launchpad-deployment": incoming.headers["x-launchpad-deployment"],
                          }
                        : {}),
                });
                incoming.pipe(response);
            },
        );
        upstream.on("error", () => {
            if (!response.headersSent) response.writeHead(502);
            response.end("Upstream unavailable\n");
        });
        upstream.on("timeout", () => upstream.destroy());
        request.pipe(upstream);
    } catch {
        response.writeHead(503);
        response.end("Routing state unavailable\n");
    }
}).listen(8080, "0.0.0.0");
console.log("experimental router ready");
