import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import type { Evidence, Resources } from "./harness";
import type { FaultRule } from "./rules";

type Json = Record<string, any>;
export interface Reply {
    status: number;
    body: Json;
}
export interface RouteRead {
    status: number;
    route: null | {
        generation: string;
        operationId: string;
        aliasId: string;
        target: { deploymentId: string } | null;
    };
}
export interface WorkerEvent {
    event: string;
    operationId?: string;
    deploymentId?: string;
    status?: string;
}

// What the scenarios may use. Everything but `api` is a narrow, named mechanism: a SQL read, a
// docker control, a router read, a proxy fault. Each scenario's `mechanism` says which it used.
export interface World {
    r: Resources;
    dir: string;
    docker: (
        args: string[],
        allowFailure?: boolean,
        stdin?: string,
    ) => Promise<{ out: string; err: string; code: number }>;
    org: string;
    project: string;
    compact: (id: string) => string;
    api(
        method: string,
        path: string,
        body?: unknown,
        options?: { raw?: Uint8Array; idempotencyKey?: string },
    ): Promise<Reply>;
    sql<T = Json>(query: string): Promise<T[]>;
    probeRouter(host: string): Promise<{ status: number; deployment: string | null }>;
    probeDokku(host: string): Promise<{ status: number; deployment: string | null }>;
    routerRoute(host: string): Promise<RouteRead>;
    proxy: {
        addRule(rule: FaultRule): Promise<void>;
        release(id: string): Promise<boolean>;
        log(): Promise<Json[]>;
    };
    startWorker(which: 1 | 2): Promise<void>;
    pauseWorker(which: 1 | 2): Promise<void>;
    unpauseWorker(which: 1 | 2): Promise<void>;
    stopWorker(which: 1 | 2): Promise<void>;
    workerEvents(which: 1 | 2): Promise<WorkerEvent[]>;
    databaseWrites(since: string): Promise<Record<string, number>>;
    reconcile(
        operationId: string,
        targetId: string,
    ): Promise<{ code: number; out: string; err: string }>;
    discover(): Promise<void>;
    archive(name: string, files: Record<string, string>): Promise<Uint8Array>;
    damageArtifact(artifactId: string): Promise<void>;
    finish(): Promise<void>;
}

const sleep = (ms: number) => Bun.sleep(ms);

async function until<T>(
    what: string,
    check: () => Promise<T | false | undefined>,
    timeoutMs: number,
    everyMs = 1000,
): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await check();
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
        await sleep(everyMs);
    }
}

const FAST_LEASE = process.env.LAUNCHPAD_ACCEPTANCE_FAST_LEASE === "1";

export async function runScenarios(w: World, evidence: Evidence[], raceRounds: number) {
    const { api } = w;
    const page = (title: string) => `<!doctype html><title>${title}</title><h1>${title}</h1>\n`;

    const scenario = async (
        id: string,
        title: string,
        mechanism: string,
        run: () => Promise<Record<string, unknown>>,
    ) => {
        console.log(`scenario ${id}: ${title}`);
        try {
            const observations = await run();
            evidence.push({ id, title, result: "pass", mechanism, observations });
            console.log("  pass");
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            evidence.push({
                id,
                title,
                result: "fail",
                mechanism,
                observations: {},
                error: message.slice(0, 2000),
            });
            console.log(`  FAIL ${message.slice(0, 500)}`);
            await writeFile(`${w.dir}/evidence.json`, JSON.stringify(evidence, null, 2));
            throw error;
        }
    };

    const ok = (reply: Reply, expected: number | number[], what: string) => {
        const list = Array.isArray(expected) ? expected : [expected];
        assert.ok(
            list.includes(reply.status),
            `${what}: HTTP ${reply.status} ${JSON.stringify(reply.body).slice(0, 300)}`,
        );
        return reply.body;
    };

    const upload = async (bytes: Uint8Array) =>
        ok(
            await api("POST", `/projects/${w.project}/artifacts`, undefined, { raw: bytes }),
            [200, 201],
            "upload",
        ) as { id: string; reused: boolean; digest: string };
    const createApp = async (slug: string) =>
        ok(await api("POST", `/projects/${w.project}/apps`, { slug }), 201, "create app") as {
            id: string;
        };
    const deploy = async (app: string, artifactId: string) => {
        const body = ok(
            await api("POST", `/apps/${app}/deployments`, { artifactId }),
            202,
            "deploy",
        ) as { id: string; hostname: string };
        // Record the product-chosen names immediately, before the worker builds anything.
        await w.discover();
        return body;
    };
    const getDeployment = async (id: string) =>
        ok(await api("GET", `/deployments/${id}`), 200, "get deployment");
    const waitDeployment = (id: string, status: string, timeoutMs = 300_000) =>
        until(
            `deployment ${id} to be ${status}`,
            async () => {
                const row = await getDeployment(id);
                if (row.status === status) return row;
                if (["failed", "reconciliation-needed", "cancelled"].includes(row.status)) {
                    throw new Error(
                        `deployment ${id} ended ${row.status}: ${row.failureCode ?? ""}`,
                    );
                }
                return false;
            },
            timeoutMs,
        );
    const deployed = async (app: string, artifactId: string) => {
        const created = await deploy(app, artifactId);
        await waitDeployment(created.id, "succeeded");
        return created;
    };
    const createAlias = async (app: string, slug: string) =>
        ok(await api("POST", `/apps/${app}/aliases`, { slug }), 201, "create alias") as {
            id: string;
            hostname: string;
            reservedGeneration: string;
        };
    const getAlias = async (id: string) => ok(await api("GET", `/aliases/${id}`), 200, "get alias");
    const operations = async (alias: string) =>
        ok(
            await api("GET", `/aliases/${alias}/operations`),
            200,
            "operations",
        ) as unknown as Json[];
    const promoteRaw = (alias: string, target: string, expected: string, key: string) =>
        api(
            "POST",
            `/aliases/${alias}/promotions`,
            { targetDeploymentId: target, expectedGeneration: expected },
            { idempotencyKey: key },
        );
    const waitOperation = (alias: string, id: string, status: string, timeoutMs = 180_000) =>
        until(
            `operation ${id} to be ${status}`,
            async () => {
                const op = (await operations(alias)).find((entry) => entry.id === id);
                if (op?.status === status) return op;
                if (op && ["failed", "superseded"].includes(op.status) && op.status !== status) {
                    throw new Error(`operation ${id} ended ${op.status} (${op.failureCode ?? ""})`);
                }
                return false;
            },
            timeoutMs,
        );
    const promote = async (alias: string, target: string, key: string) => {
        const current = await getAlias(alias);
        const op = ok(
            await promoteRaw(alias, target, current.reservedGeneration, key),
            202,
            "promote",
        ) as { id: string; generation: string };
        await waitOperation(alias, op.id, "succeeded");
        return op;
    };
    const withdrawRaw = (alias: string, expected: string, key: string) =>
        api(
            "DELETE",
            `/aliases/${alias}`,
            { expectedGeneration: expected },
            { idempotencyKey: key },
        );
    const deleteDeployment = (id: string) => api("DELETE", `/deployments/${id}`);

    const idList = (ids: string[]) => ids.map((id) => `'${id}'`).join(",");
    const pins = async (ids: string[]) =>
        w.sql<{
            id: string;
            desired_state: string;
            aliased: boolean;
            open_operation: boolean;
            last_unpinned_at: string | null;
        }>(
            // The same definition as services/src/pins.ts, read directly.
            `select d.id, d.desired_state, d.last_unpinned_at,
                exists(select 1 from app_alias a where a.target_deployment_id = d.id) as aliased,
                exists(select 1 from promotion_operation o
                    where o.status in ('queued','applying','verifying','reconciliation-needed')
                    and (o.previous_target_deployment_id = d.id or o.desired_target_deployment_id = d.id)) as open_operation
             from deployment d where d.id in (${idList(ids)}) order by d.id`,
        );
    const pinned = async (id: string) => {
        const [row] = await pins([id]);
        return row!.aliased || row!.open_operation;
    };
    const appNameOf = async (id: string) =>
        (
            await w.sql<{ app_name: string }>(`select app_name from deployment where id = '${id}'`)
        )[0]!.app_name;

    const dokkuHas = async (app: string) => {
        assert.match(app, /^lp-[a-z0-9]{10}$/);
        const result = await w.docker(
            ["exec", w.r.containers.dokku, "dokku", "apps:exists", app],
            true,
        );
        if (result.code === 0) return true;
        if (
            [1, 20].includes(result.code) &&
            new RegExp(`\\bApp ${app} does not exist\\b`, "i").test(`${result.out}\n${result.err}`)
        )
            return false;
        throw new Error(`Could not verify Dokku app ${app} (exit ${result.code}).`);
    };
    // Image identities and the container of a deployment's own Dokku app.
    const fingerprint = async (id: string) => {
        const app = await appNameOf(id);
        const tag = `launchpad/site:${w.compact(id)}`;
        const image = (await w.docker(["image", "inspect", "--format", "{{.Id}}", tag], true)).out;
        const dokkuImage = (
            await w.docker(["image", "inspect", "--format", "{{.Id}}", `dokku/${app}:latest`], true)
        ).out;
        const containers = (
            await w.docker(["ps", "-aq", "--filter", `label=com.dokku.app-name=${app}`], true)
        ).out
            .split("\n")
            .filter(Boolean);
        const started: string[] = [];
        for (const container of containers) {
            started.push(
                (await w.docker(["inspect", "--format", "{{.Id}} {{.State.StartedAt}}", container]))
                    .out,
            );
        }
        return { image, dokkuImage, containers: started.sort() };
    };
    const deploymentRunsEnded = async () =>
        (await w.workerEvents(1)).filter((entry) => entry.event === "deployment-run-ended").length;
    const aliasView = async (id: string) => {
        const alias = await getAlias(id);
        return {
            state: alias.state,
            target: alias.targetDeploymentId,
            reserved: alias.reservedGeneration,
            committed: alias.committedGeneration,
        };
    };
    const route = async (host: string) => {
        const read = await w.routerRoute(host);
        return read.route
            ? {
                  generation: read.route.generation,
                  target: read.route.target?.deploymentId ?? null,
                  operationId: read.route.operationId,
              }
            : null;
    };
    // Alias hostnames are served by the router; a withdrawn or unbound one is a fixed 404.
    const served = async (host: string, expected: string | null) => {
        const result = await until(
            `${host} to serve ${expected ?? "404"}`,
            async () => {
                const probe = await w.probeRouter(host);
                return expected === null
                    ? probe.status === 404 && probe.deployment === null && probe
                    : probe.status === 200 && probe.deployment === w.compact(expected) && probe;
            },
            30_000,
            500,
        );
        return result.status;
    };

    // --- shared story state -------------------------------------------------------------------
    let artifact = "";
    let app = "";
    let A = "";
    let B = "";
    let prod = { id: "", hostname: "" };
    let stg = { id: "", hostname: "" };
    let baseline: Record<string, Awaited<ReturnType<typeof fingerprint>>> = {};
    let runsAfterDeploys = 0;

    await w.startWorker(1);

    await scenario("S1", "Upload once", "HTTP API; one SQL count of artifact rows", async () => {
        const site = await w.archive("site", { "index.html": page("Launchpad acceptance") });
        const first = await upload(site);
        const second = await upload(site);
        assert.equal(second.id, first.id);
        assert.equal(second.reused, true);
        artifact = first.id;
        const [count] = await w.sql<{ n: number }>(
            `select count(*)::int as n from artifact where organization_id = '${w.org}'`,
        );
        assert.equal(count!.n, 1);
        return {
            artifactId: artifact,
            digest: first.digest,
            secondUploadReused: second.reused,
            artifactRows: count!.n,
        };
    });

    await scenario(
        "S2",
        "Deploy A and B from one artifact into distinct Dokku apps and hostnames",
        "HTTP API; SQL read of deployment rows; docker image inspect; probe of Dokku's proxy",
        async () => {
            app = (await createApp("w")).id;
            A = (await deployed(app, artifact)).id;
            B = (await deployed(app, artifact)).id;
            const rows = await w.sql<Json>(
                `select id, app_name, hostname, image_id, status, artifact_id from deployment
                 where id in (${idList([A, B])}) order by id`,
            );
            assert.equal(rows.length, 2);
            assert.equal(new Set(rows.map((row) => row.app_name)).size, 2);
            assert.equal(new Set(rows.map((row) => row.hostname)).size, 2);
            assert.equal(new Set(rows.map((row) => row.artifact_id)).size, 1);
            for (const row of rows) {
                assert.match(row.app_name, /^lp-[a-z0-9]{10}$/);
                assert.match(row.image_id, /^sha256:[0-9a-f]{64}$/);
                assert.equal(row.status, "succeeded");
                const probe = await w.probeDokku(row.hostname);
                assert.deepEqual(probe, { status: 200, deployment: w.compact(row.id) });
            }
            baseline = { A: await fingerprint(A), B: await fingerprint(B) };
            runsAfterDeploys = await until(
                "both deployment run-end events",
                async () => {
                    const events = (await w.workerEvents(1)).filter(
                        (entry) => entry.event === "deployment-run-ended",
                    );
                    return (
                        [A, B].every((id) => events.some((entry) => entry.deploymentId === id)) &&
                        events.length
                    );
                },
                30_000,
            );
            return {
                deployments: rows.map((row) => ({
                    id: row.id,
                    app: row.app_name,
                    hostname: row.hostname,
                    imageId: row.image_id,
                })),
                oneArtifact: true,
                deploymentRunsEnded: runsAfterDeploys,
            };
        },
    );

    await scenario(
        "S3",
        "Bind production and staging to A",
        "HTTP API; router control read (read-only); probe of the router data plane",
        async () => {
            prod = await createAlias(app, "production");
            stg = await createAlias(app, "staging");
            assert.notEqual(prod.hostname, stg.hostname);
            const before = [await w.probeRouter(prod.hostname), await w.probeRouter(stg.hostname)];
            assert.deepEqual(
                before.map((probe) => probe.status),
                [404, 404],
            );
            await promote(prod.id, A, "bind-prod-a");
            await promote(stg.id, A, "bind-stg-a");
            await served(prod.hostname, A);
            await served(stg.hostname, A);
            return {
                aliases: { production: prod, staging: stg },
                unboundStatuses: before.map((probe) => probe.status),
                routes: {
                    production: await route(prod.hostname),
                    staging: await route(stg.hostname),
                },
                states: { production: await aliasView(prod.id), staging: await aliasView(stg.id) },
            };
        },
    );

    await scenario(
        "S4",
        "Promote only production to B",
        "HTTP API; router control read; probe of the router data plane",
        async () => {
            await promote(prod.id, B, "prod-to-b");
            await served(prod.hostname, B);
            await served(stg.hostname, A);
            const staging = await aliasView(stg.id);
            assert.equal(staging.target, A);
            return {
                production: await aliasView(prod.id),
                staging,
                routes: {
                    production: await route(prod.hostname),
                    staging: await route(stg.hostname),
                },
            };
        },
    );

    await scenario(
        "S5",
        "Roll back production to A without a rebuild",
        "HTTP API; docker image/container inspect; worker log event count",
        async () => {
            await promote(prod.id, A, "prod-back-to-a");
            await served(prod.hostname, A);
            const after = { A: await fingerprint(A), B: await fingerprint(B) };
            assert.deepEqual(after, baseline);
            assert.ok(after.A.image && after.B.image && after.A.image !== after.B.image);
            const runs = await deploymentRunsEnded();
            assert.equal(runs, runsAfterDeploys);
            return {
                imageIdsIdentical: true,
                fingerprints: after,
                deploymentRunsEndedBefore: runsAfterDeploys,
                deploymentRunsEndedAfter: runs,
                production: await aliasView(prod.id),
            };
        },
    );

    await scenario(
        "S6",
        "A failed candidate C cannot change aliases or A",
        "HTTP API; stored archive damaged through the shared data volume (root helper); docker inspect; router control read",
        async () => {
            const aliasesBefore = [await aliasView(prod.id), await aliasView(stg.id)];
            const routesBefore = [await route(prod.hostname), await route(stg.hostname)];
            const before = { A: await fingerprint(A), B: await fingerprint(B) };
            const bad = await upload(
                await w.archive("bad", { "index.html": page("damaged"), "damaged.txt": "x" }),
            );
            await w.damageArtifact(bad.id);
            const created = await deploy(app, bad.id);
            await until(
                "candidate C to fail",
                async () => {
                    const row = await getDeployment(created.id);
                    if (row.status === "failed") return row;
                    assert.ok(
                        !["succeeded", "reconciliation-needed"].includes(row.status),
                        `C ended ${row.status}`,
                    );
                    return false;
                },
                180_000,
            );
            const [row] = await w.sql<Json>(
                `select app_name, status, failure_code from deployment where id = '${created.id}'`,
            );
            assert.notEqual(row!.app_name, await appNameOf(A));
            assert.deepEqual([await aliasView(prod.id), await aliasView(stg.id)], aliasesBefore);
            assert.deepEqual([await route(prod.hostname), await route(stg.hostname)], routesBefore);
            assert.deepEqual({ A: await fingerprint(A), B: await fingerprint(B) }, before);
            await served(prod.hostname, A);
            return {
                candidate: created.id,
                failureCode: row!.failure_code,
                aliasesUnchanged: aliasesBefore,
                routesUnchanged: routesBefore,
                aAndBContainersAndImagesUnchanged: true,
            };
        },
    );

    await scenario(
        "S7",
        "Two concurrent promotions at the same expected generation: exactly one is accepted",
        "HTTP API; SQL count of operations at the contested generation",
        async () => {
            const expected = (await getAlias(prod.id)).reservedGeneration;
            const replies = await Promise.all(
                ["race-1", "race-2"].map((key) => promoteRaw(prod.id, B, expected, key)),
            );
            const statuses = replies.map((reply) => reply.status).sort();
            assert.deepEqual(statuses, [202, 409]);
            const accepted = replies.find((reply) => reply.status === 202)!.body as {
                id: string;
            };
            await waitOperation(prod.id, accepted.id, "succeeded");
            const [count] = await w.sql<{ n: number }>(
                `select count(*)::int as n from promotion_operation
                 where alias_id = '${prod.id}' and expected_generation = ${expected}`,
            );
            assert.equal(count!.n, 1);
            await served(prod.hostname, B);
            return {
                expectedGeneration: expected,
                statuses,
                operationsAtExpectedGeneration: count!.n,
                refusal: replies.find((reply) => reply.status === 409)!.body.code,
                production: await aliasView(prod.id),
            };
        },
    );

    // Production back to A: B is unpinned again, as the race below needs.
    await promote(prod.id, A, "prod-back-to-a-2");

    await scenario(
        "S8",
        "Promotion races deletion of the same deployment: the pin wins or the deletion wins, never both",
        "HTTP API (simultaneous requests); SQL read of pins and deployment state; docker exec dokku apps:exists",
        async () => {
            const race = await createAlias(app, "race");
            const rounds: Json[] = [];
            let candidate = B;
            for (let round = 1; round <= raceRounds; round++) {
                if (round > 1) candidate = (await deployed(app, artifact)).id;
                assert.equal(await pinned(candidate), false, "the candidate starts unpinned");
                const alias = await getAlias(race.id);
                const promotionFirst = round % 2 === 1;
                const requests = [
                    () =>
                        promoteRaw(race.id, candidate, alias.reservedGeneration, `race-r${round}`),
                    () => deleteDeployment(candidate),
                ];
                if (!promotionFirst) requests.reverse();
                const replies = await Promise.all(requests.map((request) => request()));
                const promotion = replies[promotionFirst ? 0 : 1]!;
                const deletion = replies[promotionFirst ? 1 : 0]!;
                assert.equal(
                    [promotion.status, deletion.status].filter((status) => status === 202).length,
                    1,
                    JSON.stringify({ promotion, deletion }),
                );
                let winner: "pin" | "deletion";
                if (promotion.status === 202) {
                    winner = "pin";
                    assert.equal(deletion.status, 409);
                    await waitOperation(
                        race.id,
                        (promotion.body as { id: string }).id,
                        "succeeded",
                    );
                    assert.equal((await aliasView(race.id)).target, candidate);
                    assert.equal((await deleteDeployment(candidate)).status, 409);
                    assert.equal(await dokkuHas(await appNameOf(candidate)), true);
                } else {
                    winner = "deletion";
                    assert.ok(
                        [404, 409].includes(promotion.status),
                        `promotion ${promotion.status}`,
                    );
                    await until(
                        `deployment ${candidate} to be deleted`,
                        async () => (await getDeployment(candidate)).desiredState === "deleted",
                        180_000,
                    );
                    assert.notEqual((await aliasView(race.id)).target, candidate);
                    assert.equal(await pinned(candidate), false);
                    const refused = await promoteRaw(
                        race.id,
                        candidate,
                        (await getAlias(race.id)).reservedGeneration,
                        `race-after-${round}`,
                    );
                    assert.ok([404, 409].includes(refused.status));
                }
                rounds.push({
                    round,
                    candidate,
                    promotionStatus: promotion.status,
                    deletionStatus: deletion.status,
                    winner,
                });
            }
            return {
                rounds,
                outcomes: {
                    pinWon: rounds.filter((entry) => entry.winner === "pin").length,
                    deletionWon: rounds.filter((entry) => entry.winner === "deletion").length,
                },
            };
        },
    );

    await scenario(
        "S9",
        "Withdrawing one of two aliases does not unpin A; manual DELETE refuses while pinned",
        "HTTP API; SQL read of pins; probe of the router data plane",
        async () => {
            assert.equal(await pinned(A), true);
            const staging = await getAlias(stg.id);
            const op = ok(
                await withdrawRaw(stg.id, staging.reservedGeneration, "withdraw-stg"),
                202,
                "withdraw staging",
            ) as { id: string };
            await waitOperation(stg.id, op.id, "succeeded");
            assert.equal((await aliasView(stg.id)).state, "withdrawn");
            await served(stg.hostname, null);
            const after = await pins([A]);
            assert.equal(await pinned(A), true);
            const refused = await deleteDeployment(A);
            assert.equal(refused.status, 409);
            return {
                stagingWithdrawn: await aliasView(stg.id),
                productionStillOnA: await aliasView(prod.id),
                pinsOfA: after[0],
                deleteWhilePinnedStatus: refused.status,
            };
        },
    );

    await scenario(
        "S10",
        "Final withdrawal releases the last pin and starts the rollback window; manual DELETE waives time only",
        "HTTP API; SQL read of pins and last_unpinned_at",
        async () => {
            const [{ at: beforeAt }] = await w.sql<{ at: string }>(
                "select clock_timestamp() as at",
            );
            const production = await getAlias(prod.id);
            const op = ok(
                await withdrawRaw(prod.id, production.reservedGeneration, "withdraw-prod"),
                202,
                "withdraw production",
            ) as { id: string };
            await waitOperation(prod.id, op.id, "succeeded");
            await served(prod.hostname, null);
            const [released] = await pins([A]);
            assert.equal(released!.aliased, false);
            assert.equal(released!.open_operation, false);
            assert.ok(released!.last_unpinned_at, "the rollback window did not start");
            assert.ok(new Date(released!.last_unpinned_at!) >= new Date(beforeAt));
            const [window] = await w.sql<{ elapsed_seconds: number }>(
                `select extract(epoch from clock_timestamp() - last_unpinned_at)::int as elapsed_seconds
                 from deployment where id = '${A}'`,
            );
            // The default rollback retention is seven days; a manual DELETE does not wait for it.
            assert.ok(window!.elapsed_seconds < 3600);
            const accepted = await deleteDeployment(A);
            assert.equal(accepted.status, 202);
            await until(
                "A to be deleted",
                async () => (await getDeployment(A)).desiredState === "deleted",
                180_000,
            );
            assert.equal(await dokkuHas(await appNameOf(A)), false);
            return {
                aliasProduction: await aliasView(prod.id),
                pinsOfA: released,
                secondsSinceUnpinnedAtDelete: window!.elapsed_seconds,
                manualDeleteStatus: accepted.status,
                aDokkuAppRemoved: true,
            };
        },
    );

    let L1 = "";
    let L2 = "";
    await scenario(
        "S11",
        "A lost acknowledgement keeps both candidates pinned until an authoritative readback",
        "HTTP API; proxy fault (the router's reply is dropped after it commits); SQL read of pins; operator promotion-reconcile (controller image)",
        async () => {
            L1 = (await deployed(app, artifact)).id;
            L2 = (await deployed(app, artifact)).id;
            const ack = await createAlias(app, "ack");
            await promote(ack.id, L1, "ack-bind-l1");
            const expected = (await getAlias(ack.id)).reservedGeneration;
            const generation = BigInt(expected) + 1n;
            await w.proxy.addRule({
                id: "lost-ack",
                action: "drop-response",
                method: "POST",
                pathPrefix: "/v1/routes",
                body: { hostname: ack.hostname, generation: String(generation) },
                once: true,
            });
            const op = ok(
                await promoteRaw(ack.id, L2, expected, "ack-to-l2"),
                202,
                "promote L1 to L2",
            ) as { id: string };
            const held = await waitOperation(ack.id, op.id, "reconciliation-needed");
            const alias = await aliasView(ack.id);
            assert.equal(alias.state, "binding-uncertain");
            // The router did commit; the worker could not know.
            const committed = await route(ack.hostname);
            assert.equal(committed?.target, L2);
            assert.equal(committed?.generation, String(generation));
            assert.equal(committed?.operationId, op.id);
            const dropped = (await w.proxy.log()).find(
                (entry) =>
                    entry.rule === "lost-ack" &&
                    entry.outcome === "response-dropped" &&
                    entry.routerStatus === 200 &&
                    entry.request?.operationId === op.id &&
                    entry.request?.generation === String(generation),
            );
            assert.ok(dropped, "proxy did not record dropping the successful reply");
            const heldPins = await pins([L1, L2]);
            for (const pin of heldPins) assert.equal(pin.aliased || pin.open_operation, true);
            const refusals = [
                (await deleteDeployment(L1)).status,
                (await deleteDeployment(L2)).status,
            ];
            assert.deepEqual(refusals, [409, 409]);
            const refused = await promoteRaw(ack.id, L1, String(generation), "ack-while-uncertain");
            assert.equal(refused.status, 409);
            // Authoritative readback by the operator command.
            const result = await w.reconcile(op.id, L2);
            assert.equal(result.code, 0, `${result.err}`.slice(0, 500));
            const corrective = (await operations(ack.id)).find(
                (entry) => entry.supersedesOperationId === op.id,
            );
            assert.ok(corrective, "no corrective operation was queued");
            await waitOperation(ack.id, corrective.id, "succeeded");
            const settled = await pins([L1, L2]);
            assert.equal(settled.find((pin) => pin.id === L1)!.aliased, false);
            assert.equal(settled.find((pin) => pin.id === L1)!.open_operation, false);
            assert.equal(settled.find((pin) => pin.id === L2)!.aliased, true);
            await served(ack.hostname, L2);
            return {
                heldOperation: { id: held.id, status: held.status, failureCode: held.failureCode },
                aliasWhileHeld: alias,
                routerRouteWhileHeld: committed,
                droppedReply: dropped,
                pinsWhileHeld: heldPins,
                deleteStatusesWhileHeld: refusals,
                newPromotionWhileHeld: refused.status,
                correctiveGeneration: corrective.generation,
                pinsAfterReadback: settled,
                aliasAfter: await aliasView(ack.id),
            };
        },
    );

    await scenario(
        "S12",
        "A stale worker cannot finalize database state or undo a newer router generation",
        "HTTP API; proxy fault (the authenticated route write is held in the network); docker pause of worker 1; real lease expiry (SQL expiry when LAUNCHPAD_ACCEPTANCE_FAST_LEASE=1); worker 2 started; operator promotion-reconcile; SQL snapshots including xmin; router control read; Postgres log_statement=mod counts",
        async () => {
            const stale = await createAlias(app, "stale");
            await promote(stale.id, L1, "stale-bind-l1");
            const base = await getAlias(stale.id);
            const staleGeneration = BigInt(base.reservedGeneration) + 1n;
            const ruleId = "stale-hold";
            await w.proxy.addRule({
                id: ruleId,
                action: "hold",
                method: "POST",
                pathPrefix: "/v1/routes",
                body: { hostname: stale.hostname, generation: String(staleGeneration) },
                once: true,
            });
            const op = ok(
                await promoteRaw(stale.id, L2, base.reservedGeneration, "stale-to-l2"),
                202,
                "promote",
            ) as { id: string };
            // Pause inside the worker's own ten-second client deadline: the write is in flight.
            await until(
                "the route write to be held by the proxy",
                async () =>
                    (await w.proxy.log()).find(
                        (entry) => entry.rule === ruleId && entry.outcome === "held",
                    ),
                60_000,
                100,
            );
            await w.pauseWorker(1);
            const [claim] = await w.sql<Json>(
                `select status, step_pending, step_done, lease_owner, attempt
                 from promotion_operation where id = '${op.id}'`,
            );
            assert.equal(claim!.step_pending, "dispatch");
            assert.ok(claim!.lease_owner);
            assert.equal(
                (await route(stale.hostname))?.target,
                L1,
                "the delayed write must not have arrived",
            );

            if (FAST_LEASE) {
                await w.docker([
                    "exec",
                    w.r.containers.postgres,
                    "psql",
                    "-U",
                    "launchpad",
                    "-d",
                    "launchpad",
                    "-c",
                    `update promotion_operation set lease_expires_at = clock_timestamp() - interval '1 second' where id = '${op.id}'`,
                ]);
            } else {
                await until(
                    "the paused worker's lease to expire on the database clock",
                    async () =>
                        (
                            await w.sql<{ expired: boolean }>(
                                `select lease_expires_at <= clock_timestamp() as expired
                                 from promotion_operation where id = '${op.id}'`,
                            )
                        )[0]!.expired,
                    420_000,
                    5000,
                );
            }
            await w.startWorker(2);
            // The second worker's normal claim finds the unconfirmed dispatch and holds it.
            await waitOperation(stale.id, op.id, "reconciliation-needed", 120_000);
            const heldRow = (
                await w.sql<Json>(
                    `select status, lease_owner, failure_code from promotion_operation where id = '${op.id}'`,
                )
            )[0]!;
            assert.equal(heldRow.lease_owner, null);

            const result = await w.reconcile(op.id, L1);
            assert.equal(result.code, 0, `${result.err}`.slice(0, 500));
            const corrective = (await operations(stale.id)).find(
                (entry) => entry.supersedesOperationId === op.id,
            );
            assert.ok(corrective, "no corrective operation was queued");
            assert.ok(BigInt(corrective.generation) > staleGeneration);
            await waitOperation(stale.id, corrective.id, "succeeded");
            const newer = await route(stale.hostname);
            assert.equal(newer?.generation, corrective.generation);
            assert.equal(newer?.target, L1);
            await w.stopWorker(2);

            const snapshotQuery = `select 'operation' as kind, id::text as id, xmin::text as xmin, status as a, lease_owner as b, generation::text as c
                 from promotion_operation where alias_id = '${stale.id}'
                 union all select 'alias', id::text, xmin::text, state, target_deployment_id::text, reserved_generation::text || '/' || committed_generation::text
                 from app_alias where id = '${stale.id}'
                 union all select 'deployment', id::text, xmin::text, status, desired_state, last_unpinned_at::text
                 from deployment where id in (${idList([L1, L2])})
                 order by kind, id`;
            const snapshotBefore = await w.sql<Json>(snapshotQuery);
            // The delayed write now reaches the router, after a newer generation was acknowledged.
            assert.equal(await w.proxy.release(ruleId), true);
            const released = await until(
                "the held write to be answered by the router",
                async () =>
                    (await w.proxy.log()).find(
                        (entry) =>
                            entry.rule === ruleId &&
                            entry.outcome === "released" &&
                            entry.request?.operationId === op.id &&
                            entry.request?.generation === String(staleGeneration) &&
                            entry.routerStatus,
                    ),
                30_000,
                200,
            );
            const afterRelease = await route(stale.hostname);
            assert.deepEqual(afterRelease, newer, "the stale write changed the router");
            assert.equal(released.routerStatus, 409, "expected a conflict for the stale write");
            assert.equal(released.routerConflict, true, "expected the router's conflict error");
            await served(stale.hostname, L1);

            // Only now does the stale worker run again.
            const [{ at: resumeAt }] = await w.sql<{ at: string }>(
                `select to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at`,
            );
            await w.unpauseWorker(1);
            await until(
                "the stale worker to end its run",
                async () =>
                    (await w.workerEvents(1)).find(
                        (entry) =>
                            entry.event === "promotion-run-ended" && entry.operationId === op.id,
                    ),
                120_000,
                1000,
            );
            await sleep(5000);
            const staleRun = (await w.workerEvents(1)).filter(
                (entry) => entry.operationId === op.id,
            );
            const snapshotAfter = await w.sql<Json>(snapshotQuery);
            assert.deepEqual(
                snapshotAfter,
                snapshotBefore,
                "the stale worker changed database state",
            );
            const writes = await w.databaseWrites(resumeAt);
            assert.deepEqual(await route(stale.hostname), newer);
            await served(stale.hostname, L1);
            await w.stopWorker(1);
            return {
                operation: op.id,
                staleGeneration: String(staleGeneration),
                claimBeforePause: {
                    status: claim!.status,
                    stepPending: claim!.step_pending,
                    attempt: claim!.attempt,
                },
                leaseExpiry: FAST_LEASE ? "forced by SQL (fast mode)" : "waited for real expiry",
                heldByWorker2: { status: heldRow.status, failureCode: heldRow.failure_code },
                correctiveOperation: { id: corrective.id, generation: corrective.generation },
                routerBeforeRelease: newer,
                staleWriteRouterStatus: released.routerStatus,
                staleWriteCallerGone: released.callerGone,
                routerAfterRelease: afterRelease,
                staleWorkerEvents: staleRun,
                databaseSnapshotUnchanged: true,
                snapshotRows: snapshotAfter.length,
                postgresMutatingStatementsInResumeWindow: writes,
            };
        },
    );
}
