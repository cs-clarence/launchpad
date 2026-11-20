import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    createControlHandler,
    createDataHandler,
    initializeRouterState,
    openRouterState,
    type RouterStore,
} from "@launchpad-kit/alias-router";
import { createRouterControlClient } from "@launchpad-kit/alias-router/control-client";
import { createDatabase } from "@launchpad-kit/database";
import { createTestDatabase } from "@launchpad-kit/database/testing";
import {
    acknowledgePromotionDispatch,
    beginPromotionStep,
    claimPromotion,
    createAlias,
    createApp,
    createDeployment,
    createOrganization,
    createProject,
    parseAliasConfig,
    parseDeploymentConfig,
    requestDeploymentDeletion,
    requestPromotion,
    requestWithdrawal,
    ServiceError,
    supersedeOperation,
    uploadArtifact,
    type AliasDeps,
    type Principal,
} from "@launchpad-kit/services";
import { SITE, tarGz } from "@launchpad-kit/services/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workDeployments } from "../deployment-worker";
import { createPromotionPorts } from "../promotion-ports";
import { compactId } from "../template";
import { tempDir } from "../testing";

// P4c against the real router: the real alias-router store, control handler and data handler on
// loopback sockets, real PostgreSQL, and the real worker loop with its real router client and
// identity probe. Only the Dokku proxy behind the router is a stand-in (an in-process upstream
// that stamps each response with the deployment id, as the fixed site template does). Nothing
// here reaches Dokku, Docker or a real service.
let db: Awaited<ReturnType<typeof createTestDatabase>>;
// The worker's own pool, with the production limits (two connections, 5s statements, 10s idle in
// a transaction), so finalization verifying inside its transaction runs under them.
let workerDb: ReturnType<typeof createDatabase>;
let tmp: Awaited<ReturnType<typeof tempDir>>;
let routerDir = "";
let store: RouterStore;
let controlServer: ReturnType<typeof Bun.serve>;
let dataServer: ReturnType<typeof Bun.serve>;
let actor: Principal;
let org = "";
let project = "";
let counter = 0;

const instanceId = randomUUID();
const epoch = randomUUID();
const token = randomBytes(32).toString("hex");
const faults = { dropRouteReply: false, delayRouteReplyMs: 0, rejectRouteWrite: false };
const routeWrites: string[] = [];

const env = {
    LAUNCHPAD_DEPLOYMENTS: "on",
    LAUNCHPAD_ALIASES: "on",
    LAUNCHPAD_BASE_URL: "https://manage.example.org",
    LAUNCHPAD_APPS_DOMAIN: "sites.example.net",
    LAUNCHPAD_MAX_APPS: "1000",
    LAUNCHPAD_MAX_ALIASES_PER_APP: "50",
    LAUNCHPAD_MAX_ALIASES: "1000",
};
const deps = (): AliasDeps => ({
    dataDir: tmp.dir,
    settings: parseDeploymentConfig(env),
    aliases: parseAliasConfig(env),
});

const code = (promise: Promise<unknown>) =>
    promise.then(
        () => "ok",
        (error) => (error instanceof ServiceError ? error.code : `unexpected: ${error}`),
    );

beforeAll(async () => {
    tmp = await tempDir();
    db = await createTestDatabase();
    await db.migrate();
    workerDb = createDatabase(db.url, {
        max: 2,
        connectionTimeout: 5,
        closeTimeout: 0,
        connection: { statement_timeout: "5s", idle_in_transaction_session_timeout: "10s" },
    });
    routerDir = mkdtempSync(path.join(realpathSync(tmpdir()), "launchpad-promotion-router-"));
    chmodSync(routerDir, 0o700);
    const stateFile = path.join(routerDir, "routes.sqlite");
    const options = { instanceId, appsDomain: "sites.example.net" };
    initializeRouterState(stateFile, options, { epoch, token });
    store = openRouterState(stateFile, options);
    const control = createControlHandler(store);
    controlServer = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (request) => {
            const isRouteWrite =
                request.method === "POST" && new URL(request.url).pathname === "/v1/routes";
            if (isRouteWrite) routeWrites.push(request.url);
            if (isRouteWrite && faults.rejectRouteWrite) {
                return Response.json({ error: "invalid" }, { status: 400 });
            }
            const response = await control(request);
            // A reply lost or late after the router committed the write.
            if (isRouteWrite && faults.delayRouteReplyMs) await Bun.sleep(faults.delayRouteReplyMs);
            if (isRouteWrite && faults.dropRouteReply) {
                return new Response("Bad gateway\n", { status: 502 });
            }
            return response;
        },
    });
    const data = createDataHandler(store, {
        upstream: async ({ hostname }) => {
            const row = await db.db
                .selectFrom("deployment")
                .select("id")
                .where("hostname", "=", hostname)
                .executeTakeFirst();
            return row
                ? new Response("ok", {
                      status: 200,
                      headers: { "x-launchpad-deployment": compactId(row.id) },
                  })
                : new Response("missing", { status: 404 });
        },
    });
    dataServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => data(request) });

    const operator = { userId: randomUUID(), instanceRole: "operator" } as const;
    await db.db
        .insertInto("user")
        .values({
            id: operator.userId,
            name: "Owner",
            email: "owner@example.com",
            emailVerified: true,
            role: "operator",
        })
        .execute();
    actor = operator;
    org = (
        await createOrganization(db.db, operator, {
            name: "Acme",
            slug: "acme",
            ownerEmail: "owner@example.com",
        })
    ).id;
    project = (await createProject(db.db, operator, org, { name: "Site", slug: "site" })).id;
});

afterAll(async () => {
    await controlServer?.stop(true);
    await dataServer?.stop(true);
    store?.close();
    if (routerDir) rmSync(routerDir, { recursive: true, force: true });
    await workerDb?.destroy();
    await db?.destroy();
    await tmp?.cleanup();
});

function credentialFiles(overrides: { token?: string; epoch?: string } = {}) {
    const dir = mkdtempSync(path.join(realpathSync(tmpdir()), "launchpad-promotion-creds-"));
    const tokenFile = path.join(dir, "token");
    const epochFile = path.join(dir, "epoch");
    writeFileSync(tokenFile, `${overrides.token ?? token}\n`, { mode: 0o600 });
    writeFileSync(epochFile, `${overrides.epoch ?? epoch}\n`);
    return { dir, tokenFile, epochFile };
}

const baseUrl = () => new URL(`http://127.0.0.1:${controlServer.port}`);
const client = () =>
    createRouterControlClient({ baseUrl: baseUrl(), credentials: { instanceId, epoch, token } });
const serves = async (hostname: string) => {
    const response = await fetch(`http://127.0.0.1:${dataServer.port}/`, {
        headers: { host: hostname },
    });
    return { status: response.status, id: response.headers.get("x-launchpad-deployment") };
};

let artifactCount = 0;
async function artifact(appProject: string) {
    const bytes = tarGz([
        ...SITE,
        { name: `p-${++artifactCount}.txt`, content: String(artifactCount) },
    ]);
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(bytes);
            controller.close();
        },
    });
    return (
        await uploadArtifact(
            db.db,
            actor,
            org,
            body,
            { contentLength: bytes.length, projectId: appProject },
            { dataDir: tmp.dir, limits: { maxArtifacts: 1000 } },
        )
    ).id;
}

async function fixture() {
    const app = await createApp(db.db, actor, org, project, { slug: `app-${++counter}` }, deps());
    const alias = await createAlias(db.db, actor, org, app.id, { slug: "prod" }, deps());
    const ready = async () => {
        const deployment = await createDeployment(
            db.db,
            actor,
            org,
            app.id,
            { artifactId: await artifact(project) },
            deps(),
        );
        await db.db
            .updateTable("deployment")
            .set({
                status: "succeeded",
                finished_at: new Date(),
                step_done: "verify",
                image_tag: `launchpad/site:${compactId(deployment.id)}`,
                image_id: `sha256:${"f".repeat(64)}`,
            })
            .where("id", "=", deployment.id)
            .execute();
        return deployment.id;
    };
    return { app, alias, ready };
}

const promote = (aliasId: string, target: string, expected: string) =>
    requestPromotion(
        db.db,
        actor,
        org,
        aliasId,
        { targetDeploymentId: target, expectedGeneration: expected },
        randomUUID(),
        deps(),
    );
const withdraw = (aliasId: string, expected: string) =>
    requestWithdrawal(
        db.db,
        actor,
        org,
        aliasId,
        { expectedGeneration: expected },
        randomUUID(),
        deps(),
    );
const aliasRow = (id: string) =>
    db.db.selectFrom("app_alias").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const operations = (aliasId: string) =>
    db.db
        .selectFrom("promotion_operation")
        .selectAll()
        .where("alias_id", "=", aliasId)
        .orderBy("generation")
        .execute();
const unpinned = async (id: string) =>
    (
        await db.db
            .selectFrom("deployment")
            .select("last_unpinned_at")
            .where("id", "=", id)
            .executeTakeFirstOrThrow()
    ).last_unpinned_at;
const expire = (id: string) =>
    db.db
        .updateTable("promotion_operation")
        .set({ lease_expires_at: new Date(0) })
        .where("id", "=", id)
        .execute();

// Runs the real worker loop until a promotion run (or park) ends, then stops it.
async function work(
    options: { credentials?: ReturnType<typeof credentialFiles>; timeoutMs?: number } = {},
) {
    const files = options.credentials ?? credentialFiles();
    const shutdown = new AbortController();
    const events: Record<string, unknown>[] = [];
    const guard = setTimeout(() => shutdown.abort(), 60_000);
    try {
        await workDeployments({
            db: workerDb,
            dataDir: tmp.dir,
            owner: `worker-${randomUUID()}`,
            ports: {} as never,
            deletionPorts: {} as never,
            promotionPorts: createPromotionPorts({
                controlTimeoutMs: options.timeoutMs,
                settings: {
                    aliasControlUrl: baseUrl(),
                    aliasProbeUrl: new URL(`http://127.0.0.1:${dataServer.port}`),
                    aliasInstanceId: instanceId,
                    aliasControlTokenFile: files.tokenFile,
                    aliasRouterEpochFile: files.epochFile,
                },
            }),
            markHealthy: () => {},
            log: (entry) => {
                events.push(entry);
                if (
                    [
                        "promotion-run-ended",
                        "promotion-reconciliation-needed",
                        "deployment-worker-error",
                    ].includes(String(entry.event))
                ) {
                    shutdown.abort();
                }
            },
            shutdown: shutdown.signal,
        });
    } finally {
        clearTimeout(guard);
        if (!options.credentials) rmSync(files.dir, { recursive: true, force: true });
    }
    return events;
}
const ended = (events: Record<string, unknown>[]) =>
    events.find((entry) => entry.event === "promotion-run-ended")?.status ??
    events.find((entry) => entry.event === "promotion-reconciliation-needed")?.event ??
    events.map((entry) => entry.event);

describe("promotion runner against the real router", () => {
    it("binds, repoints and withdraws, releasing pins only after verified readback", async () => {
        const { alias, ready } = await fixture();
        const a = await ready();
        const b = await ready();

        await promote(alias.id, a, "0");
        expect(ended(await work())).toBe("succeeded");
        expect(await aliasRow(alias.id)).toMatchObject({
            state: "bound",
            target_deployment_id: a,
            committed_generation: "1",
        });
        expect((await client().readRoute(alias.hostname)).route).toMatchObject({
            generation: "1",
            target: { deploymentId: a },
        });
        expect(await serves(alias.hostname)).toEqual({ status: 200, id: compactId(a) });
        expect(await unpinned(a)).toBeNull();

        await promote(alias.id, b, "1");
        expect(ended(await work())).toBe("succeeded");
        expect(await serves(alias.hostname)).toEqual({ status: 200, id: compactId(b) });
        expect(await aliasRow(alias.id)).toMatchObject({ target_deployment_id: b });
        expect(await unpinned(a)).toBeInstanceOf(Date);
        expect(await unpinned(b)).toBeNull();
        expect(await code(requestDeploymentDeletion(db.db, actor, org, a, deps()))).toBe("ok");

        await withdraw(alias.id, "2");
        expect(ended(await work())).toBe("succeeded");
        expect(await serves(alias.hostname)).toEqual({ status: 404, id: null });
        expect((await client().readRoute(alias.hostname)).route).toMatchObject({
            generation: "3",
            target: null,
        });
        expect(await aliasRow(alias.id)).toMatchObject({
            state: "withdrawn",
            target_deployment_id: null,
            committed_generation: "3",
        });
        expect(await unpinned(b)).toBeInstanceOf(Date);
        expect((await operations(alias.id)).map((row) => row.status)).toEqual([
            "succeeded",
            "succeeded",
            "succeeded",
        ]);
    });

    it("holds a write whose reply was lost after the router committed it, then settles a correction", async () => {
        const { alias, ready } = await fixture();
        const a = await ready();
        const before = routeWrites.length;
        const { id } = await promote(alias.id, a, "0");

        faults.dropRouteReply = true;
        let events;
        try {
            events = await work();
        } finally {
            faults.dropRouteReply = false;
        }
        expect(ended(events)).toBe("reconciliation-needed");
        expect(routeWrites.length - before).toBe(1);
        // The router did commit it: the worker could not know.
        expect((await client().readRoute(alias.hostname)).route).toMatchObject({
            operationId: id,
            generation: "1",
        });
        expect(await aliasRow(alias.id)).toMatchObject({
            state: "binding-uncertain",
            committed_generation: "0",
        });
        expect(await unpinned(a)).toBeNull();
        expect(await code(requestDeploymentDeletion(db.db, actor, org, a, deps()))).toBe(
            "conflict",
        );

        const corrected = await supersedeOperation(db.db, tmp.dir, {
            operationId: id,
            action: "bind",
            targetDeploymentId: a,
            attested: true,
        });
        expect(ended(await work())).toBe("succeeded");
        expect((await client().readRoute(alias.hostname)).route).toMatchObject({
            operationId: corrected.operationId,
            generation: corrected.generation,
        });
        expect(await aliasRow(alias.id)).toMatchObject({ state: "bound", target_deployment_id: a });
        expect((await operations(alias.id)).map((row) => row.status)).toEqual([
            "superseded",
            "succeeded",
        ]);
    });

    it("never repeats a dispatch after a crash, and resumes verification after an acknowledged one", async () => {
        const first = await fixture();
        const a = await first.ready();
        const { id } = await promote(first.alias.id, a, "0");
        // A worker that sent the write and died before acknowledging it.
        const claim = await claimPromotion(db.db, tmp.dir, "crashed-worker");
        if (claim.kind !== "claimed") throw new Error("expected a claim");
        await beginPromotionStep(db.db, tmp.dir, claim.token, "dispatch");
        await client().registerDeployment({ deploymentId: a, hostname: claim.target!.hostname });
        await client().replaceRoute({
            hostname: first.alias.hostname,
            aliasId: first.alias.id,
            operationId: id,
            generation: "1",
            targetDeploymentId: a,
        });
        await expire(id);
        const writes = routeWrites.length;
        // Parked on reclaim: the claim itself reports it, no run starts and nothing is re-sent.
        expect(ended(await work())).toBe("promotion-reconciliation-needed");
        expect(routeWrites.length).toBe(writes);
        expect(await aliasRow(first.alias.id)).toMatchObject({ state: "binding-uncertain" });

        // One that acknowledged the dispatch resumes read-only verification and does not write.
        const second = await fixture();
        const b = await second.ready();
        const op = await promote(second.alias.id, b, "0");
        const claimed = await claimPromotion(db.db, tmp.dir, "crashed-worker");
        if (claimed.kind !== "claimed") throw new Error("expected a claim");
        await beginPromotionStep(db.db, tmp.dir, claimed.token, "dispatch");
        await client().registerDeployment({ deploymentId: b, hostname: claimed.target!.hostname });
        await client().replaceRoute({
            hostname: second.alias.hostname,
            aliasId: second.alias.id,
            operationId: op.id,
            generation: "1",
            targetDeploymentId: b,
        });
        await acknowledgePromotionDispatch(db.db, tmp.dir, claimed.token);
        await expire(op.id);
        const before = routeWrites.length;
        expect(ended(await work())).toBe("succeeded");
        expect(routeWrites.length).toBe(before);
        expect(await aliasRow(second.alias.id)).toMatchObject({
            state: "bound",
            target_deployment_id: b,
        });
    });

    it("holds a write that outlives its deadline instead of treating it as failed", async () => {
        const { alias, ready } = await fixture();
        const a = await ready();
        const { id } = await promote(alias.id, a, "0");
        // Only the route write is slow; registration answers at once under the same deadline.
        faults.delayRouteReplyMs = 4000;
        let events;
        try {
            events = await work({ timeoutMs: 1500 });
        } finally {
            faults.delayRouteReplyMs = 0;
        }
        expect(ended(events)).toBe("reconciliation-needed");
        expect((await client().readRoute(alias.hostname)).route).toMatchObject({ operationId: id });
        expect(await aliasRow(alias.id)).toMatchObject({ state: "binding-uncertain" });
        expect(await unpinned(a)).toBeNull();
    });

    it("reconciles a lost reply by reading the router, then settles the corrective chain", async () => {
        const { alias, ready } = await fixture();
        const a = await ready();
        const { id } = await promote(alias.id, a, "0");
        faults.dropRouteReply = true;
        try {
            expect(ended(await work())).toBe("reconciliation-needed");
        } finally {
            faults.dropRouteReply = false;
        }
        const corrected = await supersedeOperation(
            db.db,
            tmp.dir,
            { operationId: id, action: "bind", targetDeploymentId: a, attested: true },
            {
                authority: { instanceId, epoch },
                readRoute: (hostname, signal) => client().readRoute(hostname, signal),
            },
        );
        expect(corrected.generation).toBe("2");
        expect(ended(await work())).toBe("succeeded");
        expect(await aliasRow(alias.id)).toMatchObject({
            state: "bound",
            target_deployment_id: a,
            committed_generation: "2",
        });
        expect((await operations(alias.id)).map((row) => row.status)).toEqual([
            "superseded",
            "succeeded",
        ]);
    });

    it("fails a route write the router refused, restoring the alias and releasing the target", async () => {
        const { alias, ready } = await fixture();
        const a = await ready();
        await promote(alias.id, a, "0");
        faults.rejectRouteWrite = true;
        try {
            expect(ended(await work())).toBe("failed");
        } finally {
            faults.rejectRouteWrite = false;
        }
        expect(await operations(alias.id)).toMatchObject([
            { status: "failed", failure_code: "router-refused" },
        ]);
        expect(await aliasRow(alias.id)).toMatchObject({ state: "unbound" });
        expect(await unpinned(a)).toBeInstanceOf(Date);
        expect((await client().readRoute(alias.hostname)).route).toBeNull();
    });

    it("retries a setup fault a bounded number of times, then ends the operation", async () => {
        const { alias, ready } = await fixture();
        const a = await ready();
        const { id } = await promote(alias.id, a, "0");
        const writes = routeWrites.length;
        const wrong = credentialFiles({ token: randomBytes(32).toString("hex") });
        try {
            for (const expected of ["retry", "retry", "failed"]) {
                const events = await work({ credentials: wrong });
                expect(ended(events)).toBe(expected);
                if (expected === "retry") {
                    expect(events).toContainEqual(
                        expect.objectContaining({
                            event: "promotion-retry",
                            reason: "registration-refused",
                        }),
                    );
                    await expire(id);
                }
            }
        } finally {
            rmSync(wrong.dir, { recursive: true, force: true });
        }
        expect(routeWrites.length).toBe(writes);
        expect(await operations(alias.id)).toMatchObject([
            { status: "failed", failure_code: "router-unavailable", attempt: 3 },
        ]);
        expect(await aliasRow(alias.id)).toMatchObject({
            state: "unbound",
            committed_generation: "0",
        });
        expect(await unpinned(a)).toBeInstanceOf(Date);
        expect((await client().readRoute(alias.hostname)).route).toBeNull();
    });
});
