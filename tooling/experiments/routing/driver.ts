import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, unlink } from "node:fs/promises";

const config = await Bun.file("/experiment/router-config.json").json();
const fixtures = await Bun.file("/data/fixtures.json").json();
const [host, other, unbound] = Object.keys(config.aliases) as [string, string, string];
const [a, b] = fixtures.map((fixture: { deploymentId: string }) => fixture.deploymentId);
const phase = process.argv[2];
const rotated = ["restart", "unavailable", "crash", "crash-recover"].includes(phase!);
let epoch = rotated ? config.epochs[1] : config.epochs[0];
let credential = rotated ? config.credentials[1] : config.credentials[0];
const observations: unknown[] = [];
async function control(path: string, body?: unknown, expected = 200, pair = { epoch, credential }) {
    const response = await fetch(`http://router:8081${path}`, {
        signal: AbortSignal.timeout(60_000),
        method: body === undefined ? "GET" : "POST",
        headers: {
            authorization: `Bearer ${pair.credential}`,
            "x-epoch": pair.epoch,
            "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    await appendFile(
        "/data/router-trace.ndjson",
        JSON.stringify({
            phase,
            control: path,
            status: response.status,
            observed: result,
        }) + "\n",
    );
    assert.equal(response.status, expected, `${path}: ${JSON.stringify(result)}`);
    return result;
}
const write = (hostname: string, generation: string, target: string | null, extra = {}) => ({
    instance: config.instance,
    alias: config.aliases[hostname],
    host: hostname,
    operation: randomUUID(),
    generation,
    target,
    ...extra,
});
async function probe(hostname: string, expected: number, body?: string) {
    const response = await fetch("http://upstream:8080/", {
        headers: { host: hostname },
        signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    await appendFile(
        "/data/router-trace.ndjson",
        JSON.stringify({
            phase,
            probe: hostname,
            status: response.status,
            body: text,
        }) + "\n",
    );
    assert.equal(response.status, expected, `${hostname}: ${text}`);
    if (body !== undefined) assert.equal(text, body);
    observations.push({ host: hostname, status: response.status, body: text });
    return text;
}
async function observed(operation: ReturnType<typeof write>) {
    const result = await control("/routes");
    assert.deepEqual(
        result.routes.find((route: { host: string }) => route.host === operation.host),
        {
            alias: operation.alias,
            host: operation.host,
            operation: operation.operation,
            generation: operation.generation,
            target: operation.target,
        },
    );
}
// A Promise must not be assimilated by an async helper while it is intentionally held.
async function startHeld(operation: ReturnType<typeof write>, expected: number) {
    const pending = control("/write", { ...operation, hold: true }, expected);
    for (let i = 0; i < 100; i++) {
        if ((await control("/held", { operation: operation.operation })).held) return { pending };
        await Bun.sleep(10);
    }
    throw new Error("No pre-commit gate.");
}

if (phase === "core") {
    for (const name of [host, other, unbound, "unknown.live.example.com"])
        await probe(name, 404, "Not found\n");
    const first = write(host, "1", a);
    await control("/write", first);
    await observed(first);
    await control("/write", write(other, "1", a));
    await probe(host, 200, `fixture:${a}`);
    await probe(other, 200, `fixture:${a}`);
    await control("/write", write(host, "2", b));
    await probe(host, 200, `fixture:${b}`);
    await probe(other, 200, `fixture:${a}`);
    await control("/write", write(host, "3", a));
    await probe(host, 200, `fixture:${a}`);
    for (const target of [b, null]) {
        const stale = write(host, "4", target);
        const { pending } = await startHeld(stale, 409);
        const newer = write(host, "9007199254740993", a);
        // Second iteration uses a newer barrier, still beyond JS's safe integer range.
        if (target === null) newer.generation = "9007199254740994";
        await control("/write", newer);
        await observed(newer);
        await control("/release", { operation: stale.operation });
        await pending;
        await observed(newer);
        await probe(host, 200, `fixture:${a}`);
    }
    const ambiguous = write(host, "9007199254740995", b);
    await Bun.write("/data/intended-write.json", JSON.stringify(ambiguous)); // driver journal
    // The ordinary proxy consumes the router's committed response and closes the client socket.
    await assert.rejects(
        fetch("http://upstream:8082/write", {
            signal: AbortSignal.timeout(10_000),
            method: "POST",
            headers: {
                authorization: `Bearer ${credential}`,
                "x-epoch": epoch,
                "content-type": "application/json",
                "x-experiment-drop-response": "1",
            },
            body: JSON.stringify(ambiguous),
        }),
    );
    await observed(ambiguous);
    await control("/write", ambiguous); // identical replay after ambiguous acknowledgement
    await control("/write", { ...ambiguous, target: a }, 409);
    await control("/write", write(host, ambiguous.generation, a), 409);
    await probe(host, 200, `fixture:${b}`);
    // Unknown/unbound withdrawal is itself a fence, not just a local DB operation.
    const barrier = write(unbound, "8", null);
    await control("/write", barrier);
    await observed(barrier);
    await control("/write", write(unbound, "7", a), 409);
    await probe(unbound, 404, "Not found\n");
    const tombstone = write(other, "2", null);
    await control("/write", tombstone);
    await observed(tombstone);
    await probe(other, 404, "Not found\n");
    // Trusted TLS hostname and certificate validation; the wrong-name target must fail closed.
    const tlsWrite = write(host, "9007199254740996", "tls-good");
    await control("/write", tlsWrite);
    assert.deepEqual(JSON.parse(await probe(host, 200)), {
        host: "tls.live.example.com",
        sni: "tls.live.example.com",
    });
    await control("/write", write(host, "9007199254740997", "tls-wrong-name"));
    await probe(host, 502, "Upstream unavailable\n");
    await control("/write", write(host, "9007199254740998", a));
    // Admission/authentication cannot select arbitrary hosts or upstreams.
    await control(
        "/write",
        { ...write(host, "9007199254740999", a), host: "arbitrary.example.org" },
        400,
    );
    await control("/write", write(host, "9007199254740999", "http://127.0.0.1/"), 400);
    await control(
        "/write",
        { ...write(host, "9007199254740999", a), instance: "other-instance" },
        400,
    );
    // Restore an older journal while a pre-restore sender has an unseen, huge generation.
    await Bun.write("/data/ingress-closed", "restore rehearsal");
    await probe(host, 503, "Ingress closed\n");
    await Bun.write("/data/restored-journal.json", JSON.stringify(first));
    const oldEpoch = write(host, "999999999999999999999999999", b);
    const { pending } = await startHeld(oldEpoch, 401);
    const before = await control("/routes");
    await control("/rotate", { epoch: config.epochs[1], credential: config.credentials[1] });
    epoch = config.epochs[1];
    credential = config.credentials[1];
    for (const oldPair of [
        { epoch: config.epochs[0], credential: config.credentials[0] },
        { epoch: config.epochs[0], credential },
        { epoch, credential: config.credentials[0] },
    ])
        await control("/write", oldEpoch, 401, oldPair);
    await control("/release", { operation: oldEpoch.operation });
    await pending;
    const after = await control("/routes");
    assert.deepEqual(after.routes, before.routes);
    assert.equal(after.epoch, epoch);
    // Raise the restored journal counter to authoritative value, never replay the old low write.
    const current = after.routes.find((route: { host: string }) => route.host === host);
    const recovered = write(host, (BigInt(current.generation) + 1n).toString(), a);
    await control("/write", recovered);
    await observed(recovered);
    await Bun.write("/data/recovered-write.json", JSON.stringify(recovered));
    await probe(host, 503, "Ingress closed\n");
    await unlink("/data/ingress-closed");
    await probe(host, 200, `fixture:${a}`);
    observations.push({
        assertion: "authenticated-old-epoch-write-rejected-at-commit",
        status: 401,
    });
} else if (phase === "crash") {
    // Exit after the router acknowledges (also traced), before recording a completion.
    // Recovery uses the intent journal, not the trace or an assumed successful outcome.
    const routes = (await control("/routes")).routes;
    const generation = routes.find((route: { host: string }) => route.host === host).generation;
    const intent = write(host, (BigInt(generation) + 1n).toString(), b);
    await Bun.write("/data/crash-intent.json", JSON.stringify(intent));
    await control("/write", intent);
    process.exit(73);
} else if (phase === "restart") {
    const recovered = await Bun.file("/data/recovered-write.json").json();
    await observed(recovered);
    await probe(host, 200, `fixture:${a}`);
    for (const name of [other, unbound, "unknown.live.example.com"])
        await probe(name, 404, "Not found\n");
} else if (phase === "crash-recover") {
    const intent = await Bun.file("/data/crash-intent.json").json();
    await observed(intent);
    await control("/write", intent);
    await observed(intent);
    observations.push({
        assertion: "crashed-driver-identical-replay",
        generation: intent.generation,
    });
} else if (phase === "unavailable") {
    await probe(host, 503, "Routing state unavailable\n");
    await control("/routes", undefined, 503);
} else if (phase === "lost") {
    epoch = config.epochs[2];
    credential = config.credentials[2];
    assert.deepEqual((await control("/routes")).routes, []);
    for (const oldEpoch of config.epochs) {
        for (const oldCredential of config.credentials) {
            if (oldEpoch === epoch && oldCredential === credential) continue;
            await control("/write", write(host, "999999999999999999999999999999", b), 401, {
                epoch: oldEpoch,
                credential: oldCredential,
            });
        }
    }
    await probe(host, 503, "Ingress closed\n");
    await unlink("/data/ingress-closed");
    for (const name of [host, other, unbound]) await probe(name, 404, "Not found\n");
    observations.push({ assertion: "state-loss-new-epoch-rejects-all-old-pairs" });
} else throw new Error("Unknown phase.");
await Bun.write(`/data/router-${phase}.json`, JSON.stringify(observations, null, 2));
console.log(`router phase ${phase}: passed (${observations.length} observations)`);
