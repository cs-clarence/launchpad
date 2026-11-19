import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import net from "node:net";

// Runs inside the worker container (Bun, on the experiment network). Each phase asserts what the
// accepted prototype experiment proved, against the production router. Request headers (and so
// credentials) are never traced.

interface Pair {
    epoch: string;
    token: string;
}
const cfg = await Bun.file("/experiment/rehearsal-config.json").json();
const fixtures = await Bun.file("/data/fixtures.json").json();
const [A, B] = fixtures.map((f: { deploymentId: string }) => f.deploymentId) as [string, string];
const [DA, DB] = fixtures.map((f: { hostname: string }) => f.hostname) as [string, string];
const ONE = "view-one.live.example.com";
const TWO = "view-two.live.example.com";
const UNBOUND = "view-unbound.live.example.com";
const UNKNOWN = "unknown.live.example.com";
const ALIAS: Record<string, string> = cfg.aliasIds;
const phase = process.argv[2];
const current: Pair = cfg.current;
const ROUTER = "http://router:8081";
const observations: unknown[] = [];

async function trace(entry: unknown) {
    observations.push(entry);
    await appendFile(
        "/data/rehearsal-trace.ndjson",
        `${JSON.stringify({ phase, ...(entry as object) })}\n`,
    );
}
const headersFor = (pair: Pair, extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${pair.token}`,
    "x-launchpad-instance": cfg.instanceId,
    "x-launchpad-epoch": pair.epoch,
    "content-type": "application/json",
    ...extra,
});
async function control(
    method: string,
    path: string,
    body?: unknown,
    expected = 200,
    pair: Pair = current,
    base = ROUTER,
) {
    const response = await fetch(`${base}${path}`, {
        method,
        headers: headersFor(pair),
        ...(body === undefined
            ? {}
            : { body: typeof body === "string" ? body : JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
        parsed = JSON.parse(text);
    } catch {
        // Keep the text.
    }
    await trace({ control: `${method} ${path}`, status: response.status, body: parsed });
    assert.equal(response.status, expected, `${method} ${path}: ${text}`);
    return parsed as any;
}
const write = (host: string, generation: string, target: string | null) => ({
    aliasId: ALIAS[host],
    hostname: host,
    operationId: randomUUID(),
    generation,
    targetDeploymentId: target,
});
async function probe(host: string, status: number, body?: string, base = "http://ingress:8080") {
    const response = await fetch(`${base}/`, {
        headers: { host },
        signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    await trace({ probe: host, status: response.status, body: text });
    assert.equal(response.status, status, `${host}: ${text}`);
    if (body !== undefined) assert.equal(text, body);
    return text;
}
const routes = async (pair: Pair = current) =>
    (await control("GET", "/v1/routes", undefined, 200, pair)).routes;
const one = async () => (await control("GET", `/v1/routes/${ONE}`)).route;
function raw(port: number, request: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve) => {
        const socket = net.connect(port, "router");
        let data = "";
        const timer = setTimeout(() => socket.destroy(), 5000);
        socket.setEncoding("utf8");
        socket.on("connect", () => socket.write(request));
        socket.on("data", (chunk) => (data += chunk));
        socket.on("error", () => undefined);
        socket.on("close", () => {
            clearTimeout(timer);
            resolve({ status: Number(/^HTTP\/1\.[01] (\d{3})/.exec(data)?.[1] ?? 0), body: data });
        });
    });
}
const saveRoutes = (name: string, value: unknown) =>
    Bun.write(`/data/${name}.json`, JSON.stringify(value));

if (phase === "core") {
    for (const host of [ONE, TWO, UNBOUND, UNKNOWN]) await probe(host, 404, "Not found\n");
    const health = await fetch(`${ROUTER}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });

    // Authentication: one fixed 401 whatever is wrong, before anything else is looked at.
    const bad: Record<string, Record<string, string>> = {
        none: {},
        "wrong token": headersFor({ ...current, token: "0".repeat(64) }),
        "wrong instance": { ...headersFor(current), "x-launchpad-instance": randomUUID() },
        "stale epoch": headersFor({ ...current, epoch: randomUUID() }),
    };
    const bodies = new Set<string>();
    for (const [name, headers] of Object.entries(bad)) {
        const response = await fetch(`${ROUTER}/v1/routes`, { headers });
        const text = await response.text();
        await trace({ control: `GET /v1/routes (${name})`, status: response.status, body: text });
        assert.equal(response.status, 401);
        bodies.add(text);
    }
    assert.deepEqual([...bodies], ['{"error":"unauthorized"}']);

    // Deployments are admitted once and never move.
    await control("POST", "/v1/deployments", { deploymentId: A, hostname: DA });
    await control("POST", "/v1/deployments", { deploymentId: B, hostname: DB });
    await control("POST", "/v1/deployments", { deploymentId: A, hostname: DA });
    await control("POST", "/v1/deployments", { deploymentId: A, hostname: DB }, 409);

    // Bind two aliases to A, promote one to B, roll it back; the other never moves.
    await control("POST", "/v1/routes", write(ONE, "1", A));
    await control("POST", "/v1/routes", write(TWO, "1", A));
    await probe(ONE, 200, `fixture:${A}`);
    await probe(TWO, 200, `fixture:${A}`);
    await control("POST", "/v1/routes", write(ONE, "2", B));
    await probe(ONE, 200, `fixture:${B}`);
    await probe(TWO, 200, `fixture:${A}`);
    await control("POST", "/v1/routes", write(ONE, "3", A));
    await probe(ONE, 200, `fixture:${A}`);

    // A delayed sender's lower generations conflict and change nothing.
    const before = await routes();
    await control("POST", "/v1/routes", write(ONE, "2", B), 409);
    await control("POST", "/v1/routes", write(ONE, "2", null), 409);
    assert.deepEqual(await routes(), before);
    await control("POST", "/v1/routes", write(ONE, "9007199254740993", A));
    await control("POST", "/v1/routes", write(ONE, "9007199254740992", B), 409);
    await control("POST", "/v1/routes", write(ONE, "9007199254740993", B), 409);
    await probe(ONE, 200, `fixture:${A}`);

    // The response is lost after the router committed: an authoritative read shows the outcome and
    // an identical replay is idempotent, a changed one conflicts.
    const ambiguous = write(ONE, "9007199254740995", B);
    await Bun.write("/data/intended-write.json", JSON.stringify(ambiguous));
    const lost = await fetch("http://fault-proxy:8082/v1/routes", {
        method: "POST",
        headers: headersFor(current, { "x-experiment-drop-response": "1" }),
        body: JSON.stringify(ambiguous),
        signal: AbortSignal.timeout(15_000),
    }).then(
        () => undefined,
        (error: unknown) => error as Error,
    );
    assert.ok(lost, "the response must be lost, not delivered");
    // The 15-second deadline expiring is not a cut connection.
    assert.notEqual(lost.name, "TimeoutError", "a timeout is not a dropped response");
    await trace({ lostResponse: "POST /v1/routes", operation: ambiguous.operationId });
    const applied = await one();
    assert.equal(applied.operationId, ambiguous.operationId);
    assert.equal(applied.target.deploymentId, B);
    const replay = await control("POST", "/v1/routes", ambiguous);
    assert.deepEqual(replay.route, applied);
    await control("POST", "/v1/routes", { ...ambiguous, targetDeploymentId: A }, 409);
    await control("POST", "/v1/routes", write(ONE, ambiguous.generation, A), 409);
    await probe(ONE, 200, `fixture:${B}`);

    // Withdrawing an unbound alias still writes a fence; withdrawing a bound one gives a fixed 404.
    await control("POST", "/v1/routes", write(UNBOUND, "8", null));
    assert.equal((await control("GET", `/v1/routes/${UNBOUND}`)).route.generation, "8");
    await control("POST", "/v1/routes", write(UNBOUND, "7", A), 409);
    await probe(UNBOUND, 404, "Not found\n");
    await control("POST", "/v1/routes", write(TWO, "2", null));
    await probe(TWO, 404, "Not found\n");

    // Nothing a client sends can choose a host, a target or an upstream. The inventory is read first,
    // so "rejected requests changed nothing" is compared against a snapshot from before them.
    const inventoryBefore = await routes();
    const fresh = (host: string, target: string | null = A) => ({
        aliasId: randomUUID(),
        hostname: host,
        operationId: randomUUID(),
        generation: "1",
        targetDeploymentId: target,
    });
    await control("POST", "/v1/routes", fresh("arbitrary.example.org"), 400);
    await control("POST", "/v1/routes", fresh("a.b.live.example.com"), 400);
    await control("POST", "/v1/routes", fresh("view-x.live.example.com", randomUUID()), 400);
    await control(
        "POST",
        "/v1/routes",
        { ...fresh("view-y.live.example.com"), upstream: "http://127.0.0.1" },
        400,
    );
    for (const generation of ["0", "01", "-1", "9223372036854775808", "1e3"]) {
        await control(
            "POST",
            "/v1/routes",
            { ...fresh("view-z.live.example.com"), generation },
            400,
        );
    }
    await control("POST", "/v1/routes", JSON.stringify({ pad: "x".repeat(9000) }), 413);
    // A write that is valid in every way except its media type, so only Content-Type can reject it.
    const typed = fresh("view-ct.live.example.com");
    const wrongType = await fetch(`${ROUTER}/v1/routes`, {
        method: "POST",
        headers: { ...headersFor(current), "content-type": "text/plain" },
        body: JSON.stringify(typed),
    });
    await trace({ control: "POST /v1/routes (content-type text/plain)", status: wrongType.status });
    assert.equal(wrongType.status, 400);
    for (const path of ["/v1/rotate", "/v1/init", "/v1/held", "/v1/release", "/v1/write"]) {
        await control("POST", path, {}, 404);
    }
    await control("DELETE", "/v1/routes", undefined, 405);
    assert.deepEqual(await routes(), inventoryBefore);
    // Positive control: the same payload as application/json is accepted, so the 400 above was the
    // media type. (It is the one deliberate change to the inventory in this block.)
    await control("POST", "/v1/routes", typed);
    const dataHealthz = await fetch("http://router:8080/healthz").then((r) => r.status);
    await trace({ probe: "data plane /healthz (no such route)", status: dataHealthz });
    assert.equal(dataHealthz, 404);

    // Hostile request forms straight at the data plane never reach another app.
    const host = (value: string, extra = "") =>
        `GET / HTTP/1.1\r\nHost: ${value}\r\n${extra}Connection: close\r\n\r\n`;
    const hostile: Record<string, [string, number[]]> = {
        "duplicate Host": [
            `GET / HTTP/1.1\r\nHost: ${ONE}\r\nHost: evil.example.org\r\nConnection: close\r\n\r\n`,
            [400, 404],
        ],
        "absolute-form to another host": [
            `GET http://evil.example.org/ HTTP/1.1\r\nHost: ${UNKNOWN}\r\nConnection: close\r\n\r\n`,
            [400, 404],
        ],
        "bracketed IPv6": [host("[::1]"), [400, 404]],
        userinfo: [host(`user@${ONE}`), [400, 404]],
        "trailing dot": [host(`${ONE}.`), [400, 404]],
        POST: [
            `POST / HTTP/1.1\r\nHost: ${ONE}\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi`,
            [400, 405, 411, 413],
        ],
        "chunked GET": [
            `GET / HTTP/1.1\r\nHost: ${ONE}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n0\r\n\r\n`,
            [400, 501],
        ],
    };
    for (const [name, [request, allowed]] of Object.entries(hostile)) {
        const result = await raw(8080, request);
        await trace({ hostile: name, status: result.status });
        assert.ok(allowed.includes(result.status), `${name}: ${result.status}`);
        if (name !== "duplicate Host")
            assert.ok(!result.body.includes("fixture:"), `${name} served content`);
    }
    // None of that disturbed the data plane.
    await probe(ONE, 200, `fixture:${B}`);
    await saveRoutes("routes-core", await routes());
} else if (phase === "restart") {
    // Acknowledged routes, tombstones, counters and the epoch are exactly what they were.
    assert.deepEqual(await routes(), await Bun.file("/data/routes-core.json").json());
    await probe(ONE, 200, `fixture:${B}`);
    for (const host of [TWO, UNBOUND, UNKNOWN]) await probe(host, 404, "Not found\n");
    assert.equal((await fetch(`${ROUTER}/healthz`)).status, 200);
} else if (phase === "crash") {
    // The router acknowledges, then this driver dies before recording a completion.
    const intent = write(ONE, (BigInt((await one()).generation) + 1n).toString(), A);
    await Bun.write("/data/crash-intent.json", JSON.stringify(intent));
    await control("POST", "/v1/routes", intent);
    process.exit(73);
} else if (phase === "crash-recover") {
    const intent = await Bun.file("/data/crash-intent.json").json();
    const applied = await one();
    assert.equal(applied.operationId, intent.operationId);
    assert.deepEqual((await control("POST", "/v1/routes", intent)).route, applied);
    await probe(ONE, 200, `fixture:${A}`);
    await saveRoutes("routes-recovered", await routes());
} else if (phase === "unavailable") {
    // The durable state is gone from under a running router: a controlled error, never another app.
    for (const host of [ONE, TWO, UNKNOWN]) {
        const text = await probe(host, 503, "Routing unavailable\n");
        assert.ok(!text.includes("fixture:"));
    }
    await control("GET", "/v1/routes", undefined, 503);
    await control("POST", "/v1/routes", write(ONE, "999999999999999990", A), 503);
    await control("POST", "/v1/deployments", { deploymentId: A, hostname: DA }, 503);
    const health = await fetch(`${ROUTER}/healthz`);
    assert.equal(health.status, 503);
    assert.deepEqual(await health.json(), { status: "unavailable" });
} else if (phase === "after-recovery") {
    assert.deepEqual(await routes(), await Bun.file("/data/routes-recovered.json").json());
    await probe(ONE, 200, `fixture:${A}`);
} else if (phase === "pre-restore") {
    // What a pre-restore sender would still hold: a delayed write with a generation the router has
    // never seen, and an older journal entry.
    await saveRoutes("routes-pre-restore", await routes());
    await Bun.write("/data/delayed.json", JSON.stringify(write(ONE, "999999999999999999", B)));
    await Bun.write("/data/restored-journal.json", JSON.stringify(write(ONE, "1", A)));
} else if (phase === "restore") {
    const oldPair: Pair = cfg.history[0];
    assert.notEqual(oldPair.epoch, current.epoch);
    const delayed = await Bun.file("/data/delayed.json").json();
    const before = await Bun.file("/data/routes-pre-restore.json").json();
    assert.deepEqual(await routes(), before);
    // Every old epoch/credential combination is rejected, even for a generation above anything seen.
    await control("POST", "/v1/routes", delayed, 401, oldPair);
    await control("POST", "/v1/routes", delayed, 401, {
        epoch: oldPair.epoch,
        token: current.token,
    });
    await control("POST", "/v1/routes", delayed, 401, {
        epoch: current.epoch,
        token: oldPair.token,
    });
    await control("GET", "/v1/routes", undefined, 401, oldPair);
    assert.deepEqual(await routes(), before);
    // Ingress is still closed while the state is reconciled.
    await probe(ONE, 503, "Ingress closed\n");
    // An older journal entry is never replayed over newer state; the next write raises the counter
    // above what the router acknowledged.
    await control("POST", "/v1/routes", await Bun.file("/data/restored-journal.json").json(), 409);
    const generation = (BigInt((await one()).generation) + 1n).toString();
    await control("POST", "/v1/routes", write(ONE, generation, B));
} else if (phase === "reopened") {
    await probe(ONE, 200, `fixture:${B}`);
} else if (phase === "lost") {
    // A fresh state in a new epoch: nothing of the old routes, and no old pair works.
    const list = await control("GET", "/v1/routes");
    assert.deepEqual(list.routes, []);
    assert.equal(list.epoch, current.epoch);
    const stale = write(ONE, "999999999999999999", B);
    const pairs: Pair[] = [];
    for (const epoch of cfg.history.map((p: Pair) => p.epoch)) {
        for (const token of cfg.history.map((p: Pair) => p.token)) pairs.push({ epoch, token });
    }
    let rejected = 0;
    for (const pair of pairs) {
        if (pair.epoch === current.epoch && pair.token === current.token) continue;
        await control("POST", "/v1/routes", stale, 401, pair);
        rejected++;
    }
    assert.equal(rejected, cfg.history.length ** 2 - 1);
    for (const host of [ONE, TWO, UNBOUND]) await probe(host, 404, "Not found\n");
    assert.equal((await fetch(`${ROUTER}/healthz`)).status, 200);
    observations.push({ assertion: "state-loss-new-epoch-rejects-all-old-pairs", rejected });
} else if (phase === "tls") {
    // The upstream is https with a private CA: Host and SNI are the registry's hostname, and a
    // certificate for another name fails closed.
    const base = "http://router-tls:8081";
    const good = randomUUID();
    const wrong = randomUUID();
    await control(
        "POST",
        "/v1/deployments",
        { deploymentId: good, hostname: "tls.live.example.com" },
        200,
        current,
        base,
    );
    await control(
        "POST",
        "/v1/deployments",
        { deploymentId: wrong, hostname: "wrong.live.example.com" },
        200,
        current,
        base,
    );
    const bind = (host: string, target: string) => ({
        aliasId: randomUUID(),
        hostname: host,
        operationId: randomUUID(),
        generation: "1",
        targetDeploymentId: target,
    });
    await control(
        "POST",
        "/v1/routes",
        bind("view-tls.live.example.com", good),
        200,
        current,
        base,
    );
    await control(
        "POST",
        "/v1/routes",
        bind("view-wrong.live.example.com", wrong),
        200,
        current,
        base,
    );
    const ok = await probe("view-tls.live.example.com", 200, undefined, "http://router-tls:8080");
    assert.deepEqual(JSON.parse(ok), { host: "tls.live.example.com", sni: "tls.live.example.com" });
    await probe("view-wrong.live.example.com", 502, "Bad gateway\n", "http://router-tls:8080");
    await probe("view-unknown.live.example.com", 404, "Not found\n", "http://router-tls:8080");
} else {
    throw new Error("Unknown phase.");
}
await Bun.write(`/data/rehearsal-${phase}.json`, JSON.stringify(observations, null, 2));
console.log(`rehearsal phase ${phase}: passed (${observations.length} observations)`);
