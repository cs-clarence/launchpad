import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import type { Evidence, Resources } from "./harness";
import { INGRESS_MARKER_HEADER } from "./ingress";
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
    signal: AbortSignal;
    api(
        method: string,
        path: string,
        body?: unknown,
        options?: { raw?: Uint8Array; idempotencyKey?: string },
    ): Promise<Reply>;
    sql<T = Json>(query: string): Promise<T[]>;
    probeRouter(host: string): Promise<{ status: number; deployment: string | null }>;
    probeDokku(host: string): Promise<{ status: number; deployment: string | null }>;
    smokeIngress?<T>(
        deploymentHosts: string[],
        aliasHost: string,
        test: (marker: string) => Promise<T>,
    ): Promise<T>;
    restoreDrill?: {
        snapshot(): Promise<void>;
        restore(): Promise<{
            restoreStartedAt: string;
            routerEpoch: string;
            routerEpochNote: string;
        }>;
        rotate(host: string): Promise<{
            before: string;
            after: string;
            oldTokenStatus: number;
            oldEpochStatus: number;
        }>;
        raiseCounters(): Promise<void>;
        republish(aliasId: string): Promise<void>;
        requireEarlyRefusal(aliasId: string): Promise<void>;
        waitForRecovery(started: string): Promise<number>;
        clear(): Promise<void>;
    };
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
        w.signal.throwIfAborted();
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

    if (w.restoreDrill) {
        const drill = w.restoreDrill;
        let backupGeneration = "";
        let newerGeneration = "";
        let restoreStartedAt = "";
        let recordedEpoch = "";
        const gate = async () => {
            const [row] = await w.sql<{ value: string }>(
                "select value from instance_state where key = 'deployment_recovery'",
            );
            return row?.value;
        };
        const requireRoute = async (target: string, generation: string) => {
            const row = (await w.routerRoute(prod.hostname)).route;
            assert.equal(row?.aliasId, prod.id);
            assert.equal(row?.target?.deploymentId, target);
            assert.equal(row?.generation, generation);
            return served(prod.hostname, target);
        };
        const requireBlocked = async (target: string, key: string) => {
            const view = await aliasView(prod.id); // A 200 proves the restored credential is valid.
            const count = (await operations(prod.id)).length;
            const reply = await promoteRaw(prod.id, target, view.reserved, key);
            assert.equal(reply.status, 503);
            assert.equal(reply.body.code, "unavailable");
            assert.match(reply.body.title, /recovery is in progress/);
            assert.deepEqual(await aliasView(prod.id), view);
            assert.equal((await operations(prod.id)).length, count);
            assert.equal(await gate(), "blocked");
            return reply.status;
        };
        await scenario(
            "R1",
            "Back up A, then promote the live router to B",
            "Built admin backup and verify-backup; HTTP and both router planes",
            async () => {
                prod = await createAlias(app, "production");
                backupGeneration = (await promote(prod.id, A, "restore-bind-a")).generation;
                await requireRoute(A, backupGeneration);
                await drill.snapshot();
                newerGeneration = (await promote(prod.id, B, "restore-live-b")).generation;
                assert.ok(BigInt(newerGeneration) > BigInt(backupGeneration));
                await requireRoute(B, newerGeneration);
                return {
                    aliasId: prod.id,
                    backupGeneration,
                    newerGeneration,
                    targetBeforeBackup: A,
                    liveTarget: B,
                };
            },
        );
        await scenario(
            "R2",
            "Restore into an empty database with writes blocked",
            "Stopped fixture writers; real restore, migration status and check-restore; marker and authenticated API",
            async () => {
                const marker = await drill.restore();
                restoreStartedAt = marker.restoreStartedAt;
                recordedEpoch = marker.routerEpoch;
                assert.equal(marker.routerEpochNote, "recorded");
                assert.match(recordedEpoch, /^[0-9a-f-]{36}$/);
                const view = await aliasView(prod.id);
                assert.equal(view.target, A);
                assert.equal(view.committed, backupGeneration);
                assert.equal(view.reserved, backupGeneration);
                const liveStatus = await requireRoute(B, newerGeneration);
                const mutationStatus = await requireBlocked(B, "restore-before-rotation");
                return {
                    restoreStartedAt,
                    recordedEpoch,
                    database: view,
                    liveStatus,
                    mutationStatus,
                };
            },
        );
        await scenario(
            "R3",
            "Rotate and raise the fence; reject early republish and clear",
            "Managed router rotation; built admin counter repair and early refusals; HTTP and both router planes",
            async () => {
                const epochs = await drill.rotate(prod.hostname);
                assert.equal(epochs.before, recordedEpoch);
                assert.notEqual(epochs.after, epochs.before);
                assert.equal(epochs.oldTokenStatus, 401);
                assert.equal(epochs.oldEpochStatus, 401);
                await requireRoute(B, newerGeneration);
                await drill.raiseCounters();
                const raised = await aliasView(prod.id);
                assert.equal(raised.committed, backupGeneration);
                assert.equal(raised.reserved, newerGeneration);
                assert.equal(raised.target, A);
                await drill.requireEarlyRefusal(prod.id);
                assert.deepEqual(await aliasView(prod.id), raised);
                const liveStatus = await requireRoute(B, newerGeneration);
                const mutationStatus = await requireBlocked(B, "restore-after-rotation");
                return {
                    epochs,
                    raised,
                    liveStatus,
                    mutationStatus,
                    earlyRepublishAndClearRefused: true,
                };
            },
        );
        // Preserve the pre-wait evidence while the real timer is running.
        await writeFile(`${w.dir}/evidence.json`, JSON.stringify(evidence, null, 2));
        await scenario(
            "R4",
            "Republish A after the real recovery wait, clear, then promote B again",
            "Dokku process check; built admin republish and recovery-clear without overrides; SQL, HTTP and both router planes",
            async () => {
                const elapsedMs = await drill.waitForRecovery(restoreStartedAt);
                await drill.republish(prod.id);
                const repaired = await aliasView(prod.id);
                const republishedGeneration = repaired.committed;
                assert.equal(repaired.reserved, republishedGeneration);
                assert.equal(repaired.target, A);
                assert.ok(BigInt(republishedGeneration) > BigInt(newerGeneration));
                const republishedStatus = await requireRoute(A, republishedGeneration);
                const mutationStatus = await requireBlocked(B, "restore-after-republish");
                await drill.clear();
                assert.equal(await gate(), "ready");
                await w.startWorker(2);
                const promotion = await promote(prod.id, B, "restore-resume-b");
                assert.ok(BigInt(promotion.generation) > BigInt(republishedGeneration));
                const liveStatus = await requireRoute(B, promotion.generation);
                const view = await aliasView(prod.id);
                assert.equal(view.committed, promotion.generation);
                assert.equal(view.target, B);
                await w.stopWorker(2);
                return {
                    elapsedMs,
                    repaired,
                    republishedStatus,
                    mutationStatus,
                    gate: "ready",
                    promotion,
                    database: view,
                    liveStatus,
                };
            },
        );
        return;
    }

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

    if (w.smokeIngress) {
        const smoke = w.smokeIngress;
        await scenario(
            "Ingress",
            "Public deployment and alias hosts through the loopback ingress",
            "Public HTTPS via Cloudflare; exact-host fixture forwarding to Dokku and the router data plane",
            async () => {
                const aHost = (await getDeployment(A)).hostname as string;
                const bHost = (await getDeployment(B)).hostname as string;
                assert.equal(new Set([aHost, bHost, prod.hostname]).size, 3);
                const probe = async (
                    marker: string,
                    hostname: string,
                    deployment: string | null,
                ) => {
                    const response = await fetch(`https://${hostname}/`, {
                        cache: "no-store",
                        redirect: "error",
                        signal: AbortSignal.any([w.signal, AbortSignal.timeout(15_000)]),
                    });
                    const body = await response.text();
                    const identity = response.headers.get("x-launchpad-deployment");
                    const expected = deployment === null ? null : w.compact(deployment);
                    assert.equal(response.status, expected === null ? 404 : 200, hostname);
                    assert.equal(response.headers.get(INGRESS_MARKER_HEADER), marker, hostname);
                    assert.equal(identity, expected, hostname);
                    if (expected !== null) assert.ok(body.includes("Launchpad acceptance"));
                    return { status: response.status, identity, forwarded: true };
                };
                return smoke([aHost, bHost], prod.hostname, async (marker) => {
                    const before = {
                        a: await probe(marker, aHost, A),
                        b: await probe(marker, bHost, B),
                        alias: await probe(marker, prod.hostname, A),
                    };
                    await promote(prod.id, B, "ingress-promote-b");
                    const after = {
                        a: await probe(marker, aHost, A),
                        b: await probe(marker, bHost, B),
                        alias: await probe(marker, prod.hostname, B),
                    };
                    const alias = await getAlias(prod.id);
                    const withdrawal = ok(
                        await withdrawRaw(prod.id, alias.reservedGeneration, "ingress-withdraw"),
                        202,
                        "withdraw public fixture alias",
                    );
                    await waitOperation(prod.id, withdrawal.id, "succeeded");
                    return { before, after, withdrawn: await probe(marker, prod.hostname, null) };
                });
            },
        );
        await w.stopWorker(1);
        return;
    }

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
                    assert.equal(await dokkuHas(await appNameOf(candidate)), false);
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
            const ended = await until(
                "the stale worker to end its run",
                async () =>
                    (await w.workerEvents(1)).find(
                        (entry) =>
                            entry.event === "promotion-run-ended" && entry.operationId === op.id,
                    ),
                120_000,
                1000,
            );
            assert.equal(ended.status, "authority-lost");
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

    // Isolate the corrective chain from the other aliases so no unrelated pin can mask a
    // premature release. Reuse this fixture for shutdown once the chain is settled.
    let chain!: {
        appId: string;
        priorId: string;
        candidateId: string;
        alias: { id: string; hostname: string };
    };
    await scenario(
        "S13",
        "An uncertain correction retains both targets until a later correction settles the chain",
        "HTTP API; two committed router replies dropped by the proxy; SQL pin reads; operator promotion-reconcile",
        async () => {
            const { id: appId } = await createApp("chain");
            const prior = await deployed(appId, artifact);
            const candidate = await deployed(appId, artifact);
            const chainAlias = await createAlias(appId, "release");
            chain = { appId, priorId: prior.id, candidateId: candidate.id, alias: chainAlias };
            const base = await promote(chainAlias.id, prior.id, "chain-bind");
            const dropNextReply = (id: string, previousGeneration: string) =>
                w.proxy.addRule({
                    id,
                    action: "drop-response",
                    method: "POST",
                    pathPrefix: "/v1/routes",
                    body: {
                        hostname: chainAlias.hostname,
                        generation: String(BigInt(previousGeneration) + 1n),
                    },
                    once: true,
                });
            const assertHeld = async (id: string, target: string, rule: string) => {
                const held = await waitOperation(chainAlias.id, id, "reconciliation-needed");
                assert.deepEqual(await route(chainAlias.hostname), {
                    generation: held.generation,
                    target,
                    operationId: id,
                });
                assert.ok(
                    (await w.proxy.log()).some(
                        (entry) =>
                            entry.rule === rule &&
                            entry.outcome === "response-dropped" &&
                            entry.routerStatus === 200 &&
                            entry.request?.operationId === id,
                    ),
                    `No successful router reply dropped for ${id}.`,
                );
                await served(chainAlias.hostname, target);
                return held.generation as string;
            };
            const correct = async (id: string, target: string) => {
                const result = await w.reconcile(id, target);
                assert.equal(result.code, 0, result.err.slice(0, 500));
                const correction = (await operations(chainAlias.id)).find(
                    (entry) => entry.supersedesOperationId === id,
                );
                assert.ok(correction, `No correction for ${id}.`);
                return correction.id as string;
            };

            await dropNextReply("chain-first", base.generation);
            const first = ok(
                await promoteRaw(chainAlias.id, candidate.id, base.generation, "chain-promote"),
                202,
                "promote chain candidate",
            );
            const firstGeneration = await assertHeld(first.id, candidate.id, "chain-first");
            await dropNextReply("chain-correction", firstGeneration);
            // Correct back to the prior target. The first operation still pins the candidate
            // even though neither the corrective intent nor the live route needs it now.
            const correction = await correct(first.id, prior.id);
            const correctionGeneration = await assertHeld(correction, prior.id, "chain-correction");
            const heldPins = await pins([prior.id, candidate.id]);
            assert.equal(heldPins.length, 2);
            for (const pin of heldPins) assert.ok(pin.aliased || pin.open_operation);
            const heldDeleteStatuses = [
                (await deleteDeployment(prior.id)).status,
                (await deleteDeployment(candidate.id)).status,
            ];
            assert.deepEqual(heldDeleteStatuses, [409, 409]);

            const final = await correct(correction, prior.id);
            const settled = await waitOperation(chainAlias.id, final, "succeeded");
            assert.ok(BigInt(settled.generation) > BigInt(correctionGeneration));
            const history = await operations(chainAlias.id);
            for (const id of [first.id, correction]) {
                assert.equal(history.find((entry) => entry.id === id)?.status, "superseded");
            }
            assert.deepEqual(await route(chainAlias.hostname), {
                generation: settled.generation,
                target: prior.id,
                operationId: final,
            });
            const finalPins = await pins([prior.id, candidate.id]);
            assert.equal(finalPins.find((pin) => pin.id === prior.id)?.aliased, true);
            const released = finalPins.find((pin) => pin.id === candidate.id);
            assert.equal(released?.aliased, false);
            assert.equal(released.open_operation, false);
            assert.ok(released.last_unpinned_at);
            return { first: first.id, correction, final, heldPins, heldDeleteStatuses, finalPins };
        },
    );

    await scenario(
        "S14",
        "App shutdown withdraws routes before a separate request can queue deletion",
        "HTTP API; router control and data planes; SQL reads of app and deletion state; Dokku apps:exists",
        async () => {
            const { appId, priorId, candidateId, alias: chainAlias } = chain;
            const shutdown = async () =>
                ok(await api("DELETE", `/apps/${appId}`), 202, "shut down app");
            const first = await shutdown();
            assert.equal(first.state, "shutting-down");
            assert.equal(first.withdrawalsQueued, 1);
            assert.equal(first.deletionsQueued, 0);
            const withdrawal = (await operations(chainAlias.id)).find(
                (entry) => entry.action === "withdraw",
            );
            assert.ok(withdrawal, "No shutdown withdrawal was queued.");
            await waitOperation(chainAlias.id, withdrawal.id, "succeeded");
            await served(chainAlias.hostname, null);
            assert.deepEqual(await route(chainAlias.hostname), {
                generation: withdrawal.generation,
                target: null,
                operationId: withdrawal.id,
            });
            const deletionCount = () =>
                w.sql<{ n: number }>(
                    `select count(*)::int as n from deployment_deletion_operation
                     where app_id = '${appId}'`,
                );
            assert.deepEqual(await deletionCount(), [{ n: 0 }]);
            const names = [await appNameOf(priorId), await appNameOf(candidateId)];
            for (const name of names) assert.equal(await dokkuHas(name), true);
            const second = await shutdown();
            assert.equal(second.withdrawalsQueued, 0);
            assert.equal(second.deletionsQueued, 2);
            await until(
                "the final deletion to settle app shutdown",
                async () =>
                    (
                        await w.sql<{ state: string }>(
                            `select state from app where id = '${appId}'`,
                        )
                    )[0]?.state === "deleted",
                180_000,
            );
            for (const name of names) assert.equal(await dokkuHas(name), false);
            await served(chainAlias.hostname, null);
            return { first, second, withdrawal: withdrawal.id, removedApps: names };
        },
    );
    await w.stopWorker(1);
}
