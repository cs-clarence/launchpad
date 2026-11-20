import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { createTestDatabase } from "@launchpad-kit/database/testing";
import { DokkuError, type DokkuClient } from "@launchpad-kit/dokku";
import {
    blockRestoredModel,
    createApp,
    createDeployment,
    createOrganization,
    createProject,
    getDeployment,
    markDeploymentRecoveryBlocked,
    parseDeploymentConfig,
    reconcileDeployment,
    requestDeploymentDeletion,
    resolveLimits,
    ServiceError,
    uploadArtifact,
    type Principal,
} from "@launchpad-kit/services";
import { SITE, tarGz } from "@launchpad-kit/services/testing";
import { clearWithSettledFixtures as clearDeploymentRecovery } from "@launchpad-kit/services/testing/recovery";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Docker } from "../docker";
import { createLifecyclePorts } from "../lifecycle-ports";
import { createDeployPorts } from "../ports";
import { compactId } from "../template";
import { tempDir } from "../testing";
import { workDeployments } from "../deployment-worker";

// P3's worked acceptance example, end to end: real PostgreSQL, the real services, the real
// worker loop, runner, build and readiness probe, with a stateful fake Dokku and Docker. Nothing
// here reaches a real Dokku or Docker engine. The HTTP layer is covered by the controller's
// deployments-api and deployments-hop (built server) suites. A worker that lost its lease and
// then writes changing zero rows is covered at the SQL level in
// packages/services (apps-deployments.spec.ts) and through the real store in
// deployment-worker.spec.ts.
let source: Awaited<ReturnType<typeof createTestDatabase>>;
let tmp: Awaited<ReturnType<typeof tempDir>>;
let proxy: http.Server;
let proxyUrl: URL;
let actor: Principal;
let org = "";
let project = "";
let app = "";
let artifactX = "";

const dokkuApps = new Map<string, { hostname?: string; loaded?: string }>();
const remoteLog: string[] = [];
let failNextLoad = false;
const localImages = new Set<string>();
const deps = () => ({
    dataDir: tmp.dir,
    settings: parseDeploymentConfig({
        LAUNCHPAD_DEPLOYMENTS: "on",
        LAUNCHPAD_BASE_URL: "https://manage.example.org",
        LAUNCHPAD_APPS_DOMAIN: "sites.example.net",
    }),
});

const dokku = {
    apps: {
        exists: async (name: string) => (remoteLog.push(`exists ${name}`), dokkuApps.has(name)),
        create: async (name: string) => {
            remoteLog.push(`create ${name}`);
            dokkuApps.set(name, {});
        },
        destroy: async (name: string) => {
            remoteLog.push(`destroy ${name}`);
            dokkuApps.delete(name);
        },
    },
    domains: {
        set: async (name: string, hostname: string) => {
            remoteLog.push(`domain ${name}`);
            dokkuApps.get(name)!.hostname = hostname;
        },
    },
    ports: { set: async (name: string) => void remoteLog.push(`port ${name}`) },
    git: {
        loadImage: async (name: string, tag: string, archive: AsyncIterable<Uint8Array>) => {
            remoteLog.push(`load ${name}`);
            for await (const _ of archive) {
                // consumed
            }
            if (failNextLoad) {
                failNextLoad = false;
                throw new DokkuError({
                    kind: "uncertain",
                    operation: "git:load-image",
                    mutating: true,
                    message: "The reply was lost.",
                });
            }
            dokkuApps.get(name)!.loaded = tag;
        },
    },
} as unknown as DokkuClient;

const docker = {
    build: async (_dir: string, tag: string) => void localImages.add(tag),
    imageId: async (tag: string) => `sha256:${createHash("sha256").update(tag).digest("hex")}`,
    save: () => ({
        stream: (async function* () {
            yield Buffer.from("image");
        })(),
        done: Promise.resolve(),
    }),
    removeImage: async (tag: string) => void localImages.delete(tag),
    remove: async () => {},
} as unknown as Docker;

beforeAll(async () => {
    tmp = await tempDir();
    source = await createTestDatabase();
    await source.migrate();
    // The proxy answers for a hostname only while that deployment's app has its image loaded.
    proxy = http.createServer(async (request, response) => {
        const host = String(request.headers.host);
        const row = await source.db
            .selectFrom("deployment")
            .select(["id", "app_name"])
            .where("hostname", "=", host)
            .executeTakeFirst();
        if (!row || !dokkuApps.get(row.app_name)?.loaded) {
            response.writeHead(404).end();
            return;
        }
        response.writeHead(200, { "x-launchpad-deployment": compactId(row.id) }).end("ok");
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    proxyUrl = new URL(`http://127.0.0.1:${(proxy.address() as AddressInfo).port}`);
    const operator = { userId: randomUUID(), instanceRole: "operator" } as const;
    await source.db
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
        await createOrganization(source.db, operator, {
            name: "Acme",
            slug: "acme",
            ownerEmail: "owner@example.com",
        })
    ).id;
    project = (await createProject(source.db, operator, org, { name: "Site", slug: "site" })).id;
    app = (await createApp(source.db, operator, org, project, { slug: "w" }, deps())).id;
});

afterAll(async () => {
    if (proxy) await new Promise((resolve) => proxy.close(resolve));
    await source?.destroy();
    await tmp?.cleanup();
});

async function upload(entries: Parameters<typeof tarGz>[0]) {
    const bytes = tarGz(entries);
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(bytes);
            controller.close();
        },
    });
    return (
        await uploadArtifact(
            source.db,
            actor,
            org,
            body,
            { contentLength: bytes.length, projectId: project },
            { dataDir: tmp.dir, limits: {} },
        )
    ).id;
}

// Runs the real worker loop until one run ends, then stops it. Any other outcome than the one
// expected fails here with its cause instead of looping until the timeout.
async function work(expected: "succeeded" | "failed" | "reconciliation-needed" = "succeeded") {
    const shutdown = new AbortController();
    let outcome: unknown;
    const log = vi.fn((entry: Record<string, unknown>) => {
        const event = String(entry.event);
        if (event.endsWith("-run-ended")) outcome = entry.status;
        if (event.endsWith("-run-ended") || event === "deployment-worker-error") {
            outcome ??= event;
            shutdown.abort();
        }
    });
    await workDeployments({
        db: source.db,
        dataDir: tmp.dir,
        owner: `worker-${randomUUID()}`,
        ports: createDeployPorts({
            dokku,
            docker,
            dataDir: tmp.dir,
            limits: resolveLimits({}),
            baseImage: "nginx:1.27-alpine",
            probe: { proxyUrl, timeoutMs: 10_000, intervalMs: 100 },
        }),
        deletionPorts: createLifecyclePorts({ dokku, docker }),
        markHealthy: () => {},
        log,
        shutdown: shutdown.signal,
    });
    expect(outcome).toBe(expected);
    return log;
}

const row = (id: string) =>
    source.db.selectFrom("deployment").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const code = (promise: Promise<unknown>) =>
    promise.then(
        () => "ok",
        (error) => (error instanceof ServiceError ? error.code : `unexpected: ${error}`),
    );

// The scenario is one ordered story: each step builds on the state the last one left, so it
// runs as a single test, with the failing step named in the error.
async function step(name: string, run: () => Promise<void>) {
    try {
        await run();
    } catch (error) {
        if (error instanceof Error) error.message = `${name}: ${error.message}`;
        throw error;
    }
}

it("runs the worked acceptance example in order", { timeout: 120_000 }, async () => {
    let a = "";
    let b = "";

    await step(
        "deploys the same artifact twice into two independent apps and hostnames",
        async () => {
            const artifact = await upload(SITE);
            artifactX = artifact;
            // Two simultaneous deploys to one app: exactly one is accepted.
            const raced = await Promise.all(
                [1, 2].map(() =>
                    createDeployment(
                        source.db,
                        actor,
                        org,
                        app,
                        { artifactId: artifact },
                        deps(),
                    ).then(
                        (deployment) => deployment,
                        (error: unknown) => error,
                    ),
                ),
            );
            const refused = raced.filter((result) => result instanceof ServiceError);
            expect(refused).toHaveLength(1);
            expect((refused[0] as ServiceError).code).toBe("conflict");
            a = (raced.find((result) => !(result instanceof ServiceError)) as { id: string }).id;
            await work();
            expect(await row(a)).toMatchObject({ status: "succeeded", step_done: "verify" });
            b = (
                await createDeployment(source.db, actor, org, app, { artifactId: artifact }, deps())
            ).id;
            await work();
            const [first, second] = [await row(a), await row(b)];
            expect(second).toMatchObject({ status: "succeeded" });
            expect(new Set([first.app_name, second.app_name]).size).toBe(2);
            expect(new Set([first.hostname, second.hostname]).size).toBe(2);
            for (const deployment of [first, second]) {
                expect(deployment.app_name).toMatch(/^lp-[a-z0-9]{10}$/);
                expect(deployment.image_id).toMatch(/^sha256:[0-9a-f]{64}$/);
                expect(deployment.image_tag).toBe(`launchpad/site:${compactId(deployment.id)}`);
            }
            expect(new Set([first.image_id, second.image_id]).size).toBe(2);
            for (const deployment of [first, second]) {
                expect(dokkuApps.get(deployment.app_name)).toMatchObject({
                    hostname: deployment.hostname,
                    loaded: deployment.image_tag,
                });
            }
        },
    );

    await step("fails a bad artifact having touched only its own resources", async () => {
        const before = structuredClone(Object.fromEntries(dokkuApps));
        const logStart = remoteLog.length;
        // It passed validation at upload, then the stored archive was damaged: the worker
        // validates again before building.
        const bad = await upload([...SITE, { name: "damaged.txt", content: "x" }]);
        const stored = await source.db
            .selectFrom("artifact")
            .select("storage_key")
            .where("id", "=", bad)
            .executeTakeFirstOrThrow();
        await fs.writeFile(path.join(tmp.dir, stored.storage_key), "not an archive");
        const c = (await createDeployment(source.db, actor, org, app, { artifactId: bad }, deps()))
            .id;
        await work("failed");
        expect(await row(c)).toMatchObject({ status: "failed", step_done: "app" });
        const own = (await row(c)).app_name;
        // Every remote call of this run named only C's app; A and B were never addressed.
        const named = remoteLog.slice(logStart).map((line) => line.split(" ")[1]);
        expect(new Set(named)).toEqual(new Set([own]));
        for (const deployment of [a, b]) {
            const { app_name } = await row(deployment);
            expect(dokkuApps.get(app_name)).toEqual(before[app_name]);
            expect(before[app_name]).toBeDefined();
        }
    });

    await step(
        "refuses to delete unfinished or held deployments, and reconcile unblocks the app",
        async () => {
            const artifact = await upload([...SITE, { name: "next.txt", content: "next" }]);
            const d = (
                await createDeployment(source.db, actor, org, app, { artifactId: artifact }, deps())
            ).id;
            expect(await code(requestDeploymentDeletion(source.db, actor, org, d, deps()))).toBe(
                "conflict",
            );
            // A load whose reply is lost is uncertain: the deployment is held, never retried.
            failNextLoad = true;
            await work("reconciliation-needed");
            expect(await row(d)).toMatchObject({
                status: "reconciliation-needed",
                step_pending: "load",
            });
            expect(await code(requestDeploymentDeletion(source.db, actor, org, d, deps()))).toBe(
                "conflict",
            );
            expect(
                await code(
                    createDeployment(source.db, actor, org, app, { artifactId: artifact }, deps()),
                ),
            ).toBe("conflict");
            // Its app exists on Dokku (only the load reply was lost), so the operator records ownership.
            expect(dokkuApps.has((await row(d)).app_name)).toBe(true);
            await reconcileDeployment(source.db, tmp.dir, {
                deploymentId: d,
                outcome: "failed-owned",
                attested: true,
            });
            expect(await row(d)).toMatchObject({
                status: "failed",
                failure_code: "reconciled-owned",
            });
        },
    );

    await step(
        "deletes B: its app and exact image go, its row stays and its names stay reserved",
        async () => {
            const target = await row(b);
            const tags = [a, b].map((id) => `launchpad/site:${compactId(id)}`);
            expect(tags.every((tag) => localImages.has(tag))).toBe(true);
            await requestDeploymentDeletion(source.db, actor, org, b, deps());
            expect(await code(requestDeploymentDeletion(source.db, actor, org, b, deps()))).toBe(
                "conflict",
            );
            const logStart = remoteLog.length;
            await work();
            expect(new Set(remoteLog.slice(logStart).map((line) => line.split(" ")[1]))).toEqual(
                new Set([target.app_name]),
            );
            expect(dokkuApps.has(target.app_name)).toBe(false);
            expect(localImages.has(tags[1]!)).toBe(false);
            expect(localImages.has(tags[0]!)).toBe(true);
            expect(await row(b)).toMatchObject({ desired_state: "deleted" });
            expect(await row(a)).toMatchObject({ status: "succeeded", desired_state: "active" });
            expect(dokkuApps.has((await row(a)).app_name)).toBe(true);
            expect(
                await source.db
                    .selectFrom("hostname_reservation")
                    .select("released_at")
                    .where("hostname", "=", target.hostname)
                    .executeTakeFirstOrThrow(),
            ).toEqual({ released_at: null });
            expect(
                await source.db
                    .selectFrom("dokku_name_reservation")
                    .select("released_at")
                    .where("app_name", "=", target.app_name)
                    .executeTakeFirstOrThrow(),
            ).toEqual({ released_at: null });
            const shown = await getDeployment(source.db, actor, org, b);
            expect(shown).toMatchObject({ desiredState: "deleted" });
        },
    );

    await step("refuses model mutations after a restore until the operator attests", async () => {
        await markDeploymentRecoveryBlocked(tmp.dir);
        await blockRestoredModel(source.db);
        await expect(
            createDeployment(source.db, actor, org, app, { artifactId: artifactX }, deps()),
        ).rejects.toThrow(/recovery/i);
        await expect(requestDeploymentDeletion(source.db, actor, org, a, deps())).rejects.toThrow(
            /recovery/i,
        );
        await expect(clearDeploymentRecovery(source.db, tmp.dir, false)).rejects.toThrow(
            /i-have-checked-the-dokku-host/,
        );
        // Still refused: a failed attestation reopens nothing.
        await expect(
            createDeployment(source.db, actor, org, app, { artifactId: artifactX }, deps()),
        ).rejects.toThrow(/recovery/i);
        await clearDeploymentRecovery(source.db, tmp.dir, true);
        expect(
            (await createDeployment(source.db, actor, org, app, { artifactId: artifactX }, deps()))
                .status,
        ).toBe("queued");
    });
});
