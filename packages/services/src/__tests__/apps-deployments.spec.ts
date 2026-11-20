import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDatabase } from "@launchpad-kit/database/testing";
import type { Database } from "@launchpad-kit/database";
import { type Kysely, sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
    addMember,
    collectArtifacts,
    claimDeployment,
    reconcileDeployment,
    claimDeletion,
    beginDeletionStep,
    completeDeletionStep,
    renewDeletionClaim,
    requestDeploymentDeletion,
    stopDeletionStep,
    beginDeploymentStep,
    completeDeploymentStep,
    stopDeploymentStep,
    createApp,
    createDeployment,
    createOrganization,
    createProject,
    getApp,
    getDeployment,
    listApps,
    listDeploymentEvents,
    listDeployments,
    artifactStorageKey,
    markDeploymentRecoveryBlocked,
    resolveArtifactPath,
    parseDeploymentConfig,
    renewDeploymentClaim,
    ServiceError,
    uploadArtifact,
    type AppDeps,
    type Principal,
} from "../index";
import { SITE, tarGz } from "../testing/tar-fixtures";

let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
const people: Record<string, Principal> = {};
let org = "";
let otherOrg = "";
let p1 = "";
let p2 = "";
let dataDir = "";

const env = {
    LAUNCHPAD_DEPLOYMENTS: "on",
    LAUNCHPAD_BASE_URL: "https://control.example.com",
    LAUNCHPAD_APPS_DOMAIN: "sites.example.net",
    // The tests create many apps; the quota tests set their own limits.
    LAUNCHPAD_MAX_APPS: "1000",
};
const deps = (extra: Record<string, string> = {}): AppDeps => ({
    dataDir,
    settings: parseDeploymentConfig({ ...env, ...extra }),
});

const code = (promise: Promise<unknown>) =>
    promise.then(
        () => "ok",
        (e) => (e instanceof ServiceError ? e.code : `unexpected: ${e}`),
    );

async function newUser(name: string, role: "user" | "operator" = "user") {
    const id = randomUUID();
    await testDb.db
        .insertInto("user")
        .values({
            id,
            name,
            email: `${name}@example.com`,
            emailVerified: false,
            role,
        })
        .execute();
    await testDb.db
        .insertInto("audit_event")
        .values({
            actor: "operator-cli",
            action: "user.provisioned",
            target_type: "user",
            target_id: id,
        })
        .execute();
    people[name] = { userId: id, instanceRole: role };
}

let uploads = 0;
async function artifactFor(projectId: string, who = "dee", organizationId = org) {
    uploads++;
    const bytes = tarGz([...SITE, { name: `unique-${uploads}.txt`, content: String(uploads) }]);
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(bytes);
            controller.close();
        },
    });
    return (
        await uploadArtifact(
            testDb.db,
            people[who]!,
            organizationId,
            body,
            { contentLength: bytes.length, projectId },
            { dataDir, limits: { maxArtifacts: 100 } },
        )
    ).id;
}

let appCount = 0;
async function newApp(projectId = p1, extra: Record<string, string> = {}) {
    appCount++;
    return createApp(
        testDb.db,
        people.dee!,
        org,
        projectId,
        { slug: `site-${appCount}` },
        deps(extra),
    );
}

// Finishes a deployment so the next one for the app is allowed.
const finish = (id: string) =>
    sql`update deployment set status = 'failed', finished_at = now() where id = ${id}`.execute(
        testDb.db,
    );

beforeAll(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "launchpad-apps-"));
    testDb = await createTestDatabase();
    await testDb.migrate();
    await newUser("root", "operator");
    for (const n of ["ann", "dee", "vic", "zoe"]) await newUser(n);
    org = (
        await createOrganization(testDb.db, people.root!, {
            name: "Acme",
            slug: "acme",
            ownerEmail: "ann@example.com",
        })
    ).id;
    otherOrg = (
        await createOrganization(testDb.db, people.root!, {
            name: "Beta",
            slug: "beta",
            ownerEmail: "zoe@example.com",
        })
    ).id;
    await addMember(testDb.db, people.ann!, org, { email: "dee@example.com", role: "deployer" });
    await addMember(testDb.db, people.ann!, org, { email: "vic@example.com", role: "viewer" });
    p1 = (await createProject(testDb.db, people.ann!, org, { name: "One", slug: "one" })).id;
    p2 = (await createProject(testDb.db, people.ann!, org, { name: "Two", slug: "two" })).id;
});
beforeEach(async () => {
    // A restore marker from one test must not leak into the next.
    await fs.rm(path.join(dataDir, "maintenance"), { recursive: true, force: true });
});
afterAll(async () => {
    await testDb.destroy();
    await fs.rm(dataDir, { recursive: true, force: true });
});

describe("deployment configuration", () => {
    it("is off unless switched on, and reads nothing else while off", () => {
        expect(parseDeploymentConfig({})).toEqual({ enabled: false });
        expect(parseDeploymentConfig({ LAUNCHPAD_DEPLOYMENTS: "off" })).toEqual({
            enabled: false,
        });
        expect(parseDeploymentConfig({ LAUNCHPAD_DEPLOYMENTS: "" })).toEqual({ enabled: false });
        expect(() => parseDeploymentConfig({ LAUNCHPAD_DEPLOYMENTS: "yes" })).toThrow(
            /"on" or "off"/,
        );
    });

    it("needs only the domain and applies the documented defaults when on", () => {
        const config = parseDeploymentConfig(env);
        if (!config.enabled) throw new Error("expected enabled");
        expect([config.maxApps, config.maxDeploymentsPerApp, config.maxDeployments]).toEqual([
            1000, 20, 100,
        ]);
        const defaults = parseDeploymentConfig({ ...env, LAUNCHPAD_MAX_APPS: "" });
        if (!defaults.enabled) throw new Error("expected enabled");
        expect(defaults.maxApps).toBe(10);
        expect([config.defaultTtlSeconds, config.maxTtlSeconds]).toEqual([7 * 86_400, 30 * 86_400]);
        expect(() => parseDeploymentConfig({ LAUNCHPAD_DEPLOYMENTS: "on" })).toThrow(
            "LAUNCHPAD_APPS_DOMAIN",
        );
        expect(() =>
            parseDeploymentConfig({ ...env, LAUNCHPAD_APPS_DOMAIN: "sites.example.com" }),
        ).toThrow("different registrable domain");
        expect(() => parseDeploymentConfig({ ...env, LAUNCHPAD_MAX_PREVIEWS: "5" })).toThrow(
            "no longer used",
        );
        expect(() =>
            parseDeploymentConfig({ ...env, LAUNCHPAD_MAX_DEPLOYMENTS_PER_APP: "200" }),
        ).toThrow("cannot exceed");
        expect(() =>
            parseDeploymentConfig({
                ...env,
                LAUNCHPAD_DEFAULT_TTL: "40d",
                LAUNCHPAD_MAX_TTL: "30d",
            }),
        ).toThrow("LAUNCHPAD_DEFAULT_TTL");
        expect(() =>
            parseDeploymentConfig({ ...env, LAUNCHPAD_DEPLOYMENT_HOSTNAME_TEMPLATE: "{slug}" }),
        ).toThrow("LAUNCHPAD_DEPLOYMENT_HOSTNAME_TEMPLATE");
        const clamped = parseDeploymentConfig({ ...env, LAUNCHPAD_MAX_TTL: "2d" });
        if (!clamped.enabled) throw new Error("expected enabled");
        expect(clamped.defaultTtlSeconds).toBe(2 * 86_400);
    });
});

describe("worker claims", () => {
    const fixtures: string[] = [];
    async function enqueue() {
        const app = await newApp();
        const artifactId = await artifactFor(p1);
        const deployment = await createDeployment(
            testDb.db,
            people.dee!,
            org,
            app.id,
            { artifactId },
            deps(),
        );
        fixtures.push(deployment.id);
        return deployment;
    }

    const claim = (owner: string) => claimDeployment(testDb.db, dataDir, owner);
    const expire = (id: string) =>
        testDb.db
            .updateTable("deployment")
            .set({ lease_expires_at: new Date(0) })
            .where("id", "=", id)
            .execute();

    afterEach(async () => {
        const ids = fixtures.splice(0);
        if (!ids.length) return;
        // Keep historical rows but remove these fixtures from the runnable queue.
        await testDb.db
            .updateTable("deployment")
            .set({ status: "cancelled", lease_owner: null, lease_expires_at: null })
            .where("id", "in", ids)
            .where("status", "in", ["queued", "preparing", "building", "deploying", "verifying"])
            .execute();
    });

    it("lets only one concurrent worker claim the same queued deployment", async () => {
        const queued = await enqueue();
        const results = await Promise.all([claim("first"), claim("second")]);
        const claims = results.filter((result) => result.kind === "claimed");
        expect(claims).toHaveLength(1);
        expect(claims[0]?.token).toMatchObject({ id: queued.id, attempt: 1, fence: "1" });
        expect(results.filter((result) => result.kind === "idle")).toHaveLength(1);
        expect(await claim("third")).toEqual({ kind: "idle" });
    });

    it("skips the locked oldest row, then claims it after release", async () => {
        await enqueue();
        await enqueue();
        const [oldest, next] = await testDb.db
            .selectFrom("deployment")
            .select("id")
            .where("id", "in", fixtures)
            .orderBy("created_at")
            .orderBy("id")
            .execute();
        await testDb.db.transaction().execute(async (trx) => {
            await trx
                .selectFrom("deployment")
                .select("id")
                .where("id", "=", oldest!.id)
                .forUpdate()
                .executeTakeFirstOrThrow();
            expect(await claim("first")).toMatchObject({
                kind: "claimed",
                token: { id: next!.id },
            });
        });
        expect(await claim("second")).toMatchObject({ kind: "claimed", token: { id: oldest!.id } });
    });

    it("lets parallel workers claim distinct queued deployments", async () => {
        const first = await enqueue();
        const second = await enqueue();
        const results = await Promise.all([claim("first"), claim("second")]);
        const claims = results.filter((result) => result.kind === "claimed");
        expect(new Set(claims.map(({ token }) => token.id))).toEqual(
            new Set([first.id, second.id]),
        );
        expect(claims.map(({ token }) => token.owner)).toEqual(["first", "second"]);
    });

    it("rejects both expired and superseded heartbeats and renews the current claim", async () => {
        const queued = await enqueue();
        const first = await claim("worker");
        if (first.kind !== "claimed") throw new Error("Expected first claim");
        await expire(queued.id);
        expect(await renewDeploymentClaim(testDb.db, dataDir, first.token)).toBeNull();

        // Reuse the owner so the attempt and fence, not a different owner, stop the stale write.
        const current = await claim("worker");
        if (current.kind !== "claimed") throw new Error("Expected replacement claim");
        expect(current.token).toMatchObject({ id: queued.id, attempt: 2, fence: "2" });
        expect(await renewDeploymentClaim(testDb.db, dataDir, first.token)).toBeNull();
        const row = await testDb.db
            .selectFrom("deployment")
            .select("lease_expires_at")
            .where("id", "=", queued.id)
            .executeTakeFirstOrThrow();
        expect(row.lease_expires_at).toEqual(current.deployment.lease_expires_at);
        expect(await renewDeploymentClaim(testDb.db, dataDir, current.token)).toBeInstanceOf(Date);
    });

    it.each(["load", "verify"] as const)(
        "reclaims expired work with pending %s safely",
        async (step) => {
            const queued = await enqueue();
            const first = await claim("first");
            if (first.kind !== "claimed") throw new Error("Expected first claim");
            await testDb.db
                .updateTable("deployment")
                .set({
                    step_done: step === "verify" ? "load" : "build",
                    step_pending: step,
                    lease_expires_at: new Date(0),
                })
                .where("id", "=", queued.id)
                .execute();

            const result = await claim("second");
            if (step === "verify") {
                expect(result).toMatchObject({
                    kind: "claimed",
                    deployment: { step_done: "load", step_pending: null },
                });
            } else {
                expect(result).toEqual({ kind: "reconciliation-needed", id: queued.id });
                expect(await claim("third")).toEqual({ kind: "idle" });
                expect(
                    await listDeploymentEvents(testDb.db, people.vic!, org, queued.id),
                ).toMatchObject([
                    { seq: 1, phase: "queued" },
                    { seq: 2, phase: "reconciliation-needed" },
                ]);
                expect(
                    await testDb.db
                        .selectFrom("deployment")
                        .select("step_pending")
                        .where("id", "=", queued.id)
                        .executeTakeFirstOrThrow(),
                ).toEqual({ step_pending: "load" });
            }
        },
    );

    it("blocks both claims and heartbeats during recovery", async () => {
        await enqueue();
        const first = await claim("first");
        if (first.kind !== "claimed") throw new Error("Expected first claim");
        await markDeploymentRecoveryBlocked(dataDir);
        await expect(claim("second")).rejects.toThrow(/recovery is blocked/i);
        await expect(renewDeploymentClaim(testDb.db, dataDir, first.token)).rejects.toThrow(
            /recovery is blocked/i,
        );
    });

    it("commits step intent before work and finalizes only in order with the built image", async () => {
        const job = await enqueue();
        const claimed = await claim("worker");
        if (claimed.kind !== "claimed") throw new Error("Expected a claim");
        const { token } = claimed;
        const { db } = testDb;
        expect(await beginDeploymentStep(db, dataDir, token, "build")).toBeNull();
        const steps = ["app", "build", "configure", "load", "verify"] as const;
        const image = {
            imageTag: `launchpad/site:${job.id.replaceAll("-", "")}`,
            imageId: `sha256:${"a".repeat(64)}`,
        };
        for (const step of steps) {
            expect(await beginDeploymentStep(db, dataDir, token, step)).toMatchObject({
                step_pending: step,
            });
            expect(
                await db
                    .selectFrom("deployment")
                    .select("step_pending")
                    .where("id", "=", job.id)
                    .executeTakeFirstOrThrow(),
            ).toEqual({ step_pending: step });
            expect(await beginDeploymentStep(db, dataDir, token, step)).toBeNull();
            expect(
                await completeDeploymentStep(
                    db,
                    dataDir,
                    token,
                    step === "build" ? { step, ...image } : { step },
                ),
            ).toMatchObject({ step_done: step, step_pending: null });
        }
        expect(
            await db
                .selectFrom("deployment")
                .selectAll()
                .where("id", "=", job.id)
                .executeTakeFirstOrThrow(),
        ).toMatchObject({
            status: "succeeded",
            image_tag: image.imageTag,
            image_id: image.imageId,
            lease_owner: null,
            lease_expires_at: null,
            finished_at: expect.any(Date),
        });
        const events = await listDeploymentEvents(db, people.vic!, org, job.id);
        expect(events.map((event) => event.seq)).toEqual(
            Array.from({ length: 11 }, (_, i) => i + 1),
        );
        expect(events.at(-1)).toMatchObject({ phase: "succeeded" });
    });

    it("rejects a delayed completion after reclaim without changing state or appending events", async () => {
        const job = await enqueue();
        const old = await claim("worker");
        if (old.kind !== "claimed") throw new Error("Expected a claim");
        const { db } = testDb;
        for (const step of ["app", "build", "configure", "load"] as const) {
            await beginDeploymentStep(db, dataDir, old.token, step);
            await completeDeploymentStep(
                db,
                dataDir,
                old.token,
                step === "build"
                    ? {
                          step,
                          imageTag: `launchpad/site:${job.id.replaceAll("-", "")}`,
                          imageId: `sha256:${"b".repeat(64)}`,
                      }
                    : { step },
            );
        }
        await beginDeploymentStep(db, dataDir, old.token, "verify");
        await expire(job.id);
        expect(await completeDeploymentStep(db, dataDir, old.token, { step: "verify" })).toBeNull();
        const current = await claim("worker");
        if (current.kind !== "claimed") throw new Error("Expected replacement claim");
        const before = await beginDeploymentStep(db, dataDir, current.token, "verify");
        const events = await listDeploymentEvents(db, people.vic!, org, job.id);
        expect(await completeDeploymentStep(db, dataDir, old.token, { step: "verify" })).toBeNull();
        expect(await stopDeploymentStep(db, dataDir, old.token, "verify", "failed")).toBeNull();
        expect(
            await db
                .selectFrom("deployment")
                .selectAll()
                .where("id", "=", job.id)
                .executeTakeFirstOrThrow(),
        ).toEqual(before);
        expect(await listDeploymentEvents(db, people.vic!, org, job.id)).toEqual(events);
        expect(
            await completeDeploymentStep(db, dataDir, current.token, { step: "verify" }),
        ).toMatchObject({ status: "succeeded" });
    });

    it.each(["failed", "reconciliation-needed"] as const)(
        "records %s and ends the lease",
        async (outcome) => {
            await enqueue();
            const claimed = await claim("worker");
            if (claimed.kind !== "claimed") throw new Error("Expected a claim");
            const { db } = testDb;
            await beginDeploymentStep(db, dataDir, claimed.token, "app");
            expect(
                await stopDeploymentStep(db, dataDir, claimed.token, "app", outcome),
            ).toMatchObject({
                status: outcome,
                step_pending: outcome === "failed" ? null : "app",
                lease_owner: null,
                lease_expires_at: null,
            });
            expect(await claim("replacement")).toEqual({ kind: "idle" });
        },
    );
});

describe("apps", () => {
    it("lets a deployer create and read an app, audited, and refuses everyone else", async () => {
        const app = await createApp(testDb.db, people.dee!, org, p1, { slug: "website" }, deps());
        expect(app).toMatchObject({ slug: "website", projectId: p1, state: "active" });
        expect(await getApp(testDb.db, people.vic!, org, app.id)).toMatchObject({ id: app.id });
        expect((await listApps(testDb.db, people.vic!, org)).map((a) => a.id)).toContain(app.id);
        const audit = await testDb.db
            .selectFrom("audit_event")
            .select("detail")
            .where("action", "=", "app.created")
            .where("target_id", "=", app.id)
            .execute();
        expect(audit).toHaveLength(1);
        expect(
            await code(createApp(testDb.db, people.vic!, org, p1, { slug: "nope" }, deps())),
        ).toBe("forbidden");
        expect(
            await code(createApp(testDb.db, people.zoe!, org, p1, { slug: "nope" }, deps())),
        ).toBe("not-found");
        expect(await code(getApp(testDb.db, people.zoe!, otherOrg, app.id))).toBe("not-found");
        expect(
            await code(createApp(testDb.db, people.dee!, org, p1, { slug: "website" }, deps())),
        ).toBe("conflict");
        expect(
            await code(createApp(testDb.db, people.dee!, org, p1, { slug: "Bad Slug" }, deps())),
        ).toBe("invalid");
    });

    it("honors the off switch and a key's project restriction", async () => {
        expect(
            await code(
                createApp(
                    testDb.db,
                    people.dee!,
                    org,
                    p1,
                    { slug: "off" },
                    {
                        dataDir,
                        settings: { enabled: false },
                    },
                ),
            ),
        ).toBe("unavailable");
        expect(
            await code(createApp(testDb.db, people.dee!, org, p1, { slug: "r" }, deps(), [p2])),
        ).toBe("not-found");
        const app = await newApp(p1);
        expect(await code(getApp(testDb.db, people.dee!, org, app.id, [p2]))).toBe("not-found");
        expect(await code(getApp(testDb.db, people.dee!, org, app.id, [p1]))).toBe("ok");
        expect(await listApps(testDb.db, people.dee!, org, [])).toEqual([]);
        expect(
            (await listApps(testDb.db, people.dee!, org, [p2])).every((a) => a.projectId === p2),
        ).toBe(true);
    });

    it("refuses an app over the organization's quota and serializes racing creators", async () => {
        const other = (
            await createOrganization(testDb.db, people.root!, {
                name: "Quota",
                slug: "quota",
                ownerEmail: "vic@example.com",
            })
        ).id;
        const project = (
            await createProject(testDb.db, people.vic!, other, { name: "Q", slug: "q" })
        ).id;
        const limited = deps({ LAUNCHPAD_MAX_APPS: "3" });
        const results = await Promise.all(
            ["a", "b", "c", "d", "e"].map((slug) =>
                code(createApp(testDb.db, people.vic!, other, project, { slug }, limited)),
            ),
        );
        expect(results.filter((r) => r === "ok")).toHaveLength(3);
        expect(results.filter((r) => r === "conflict")).toHaveLength(2);
    });
});

describe("creating a deployment", () => {
    it("queues it with a permanent identity, reservations and a first event", async () => {
        const app = await newApp();
        const artifact = await artifactFor(p1);
        const deployment = await createDeployment(
            testDb.db,
            people.dee!,
            org,
            app.id,
            { artifactId: artifact },
            deps(),
        );
        expect(deployment).toMatchObject({ status: "queued", desiredState: "active", spa: false });
        expect(deployment.hostname).toMatch(
            new RegExp(`^${app.slug}-[a-z0-9]{10}-preview\\.sites\\.example\\.net$`),
        );
        const row = await testDb.db
            .selectFrom("deployment")
            .select(["app_name", "preview_expires_at", "requested_by"])
            .where("id", "=", deployment.id)
            .executeTakeFirstOrThrow();
        expect(row.app_name).toMatch(/^lp-[a-z0-9]{10}$/);
        expect(row.requested_by).toBe(people.dee!.userId);
        const days = (row.preview_expires_at.getTime() - Date.now()) / 86_400_000;
        expect(days).toBeGreaterThan(6.9);
        expect(days).toBeLessThan(7.1);
        const reservations = await sql<{ n: number }>`
            select (select count(*) from hostname_reservation where owner_id = ${deployment.id})
                 + (select count(*) from dokku_name_reservation where owner_id = ${deployment.id}) as n`.execute(
            testDb.db,
        );
        expect(Number(reservations.rows[0]!.n)).toBe(2);
        const events = await listDeploymentEvents(testDb.db, people.vic!, org, deployment.id);
        expect(events).toMatchObject([{ seq: 1, phase: "queued", level: "info" }]);
        expect(await getDeployment(testDb.db, people.vic!, org, deployment.id)).toMatchObject({
            id: deployment.id,
        });
        expect(
            (await listDeployments(testDb.db, people.vic!, org, app.id)).map((d) => d.id),
        ).toEqual([deployment.id]);
    });

    it("applies the ttl: shorter is allowed, longer than the maximum is refused", async () => {
        const app = await newApp();
        const artifact = await artifactFor(p1);
        expect(
            await code(
                createDeployment(
                    testDb.db,
                    people.dee!,
                    org,
                    app.id,
                    { artifactId: artifact, ttl: "31d" },
                    deps(),
                ),
            ),
        ).toBe("invalid");
        const short = await createDeployment(
            testDb.db,
            people.dee!,
            org,
            app.id,
            { artifactId: artifact, ttl: "1h", spa: true },
            deps(),
        );
        expect(short.spa).toBe(true);
        const stored = await testDb.db
            .selectFrom("deployment")
            .select("preview_expires_at")
            .where("id", "=", short.id)
            .executeTakeFirstOrThrow();
        expect(stored.preview_expires_at.getTime() - Date.now()).toBeLessThan(3_700_000);
    });

    describe("against artifact collection", () => {
        const stored = (digest: string) =>
            fs.stat(resolveArtifactPath(dataDir, artifactStorageKey(org, digest))).then(
                () => true,
                (error) => {
                    // Only a missing file is "removed"; any other failure is not an answer.
                    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
                    throw error;
                },
            );
        const age = (artifact: string) =>
            sql`update artifact set created_at = now() - interval '30 days' where id = ${artifact}`.execute(
                testDb.db,
            );
        const digestOf = async (artifact: string) =>
            (
                await testDb.db
                    .selectFrom("artifact")
                    .select("digest")
                    .where("id", "=", artifact)
                    .executeTakeFirstOrThrow()
            ).digest;
        const deploymentsOf = (artifact: string) =>
            testDb.db
                .selectFrom("deployment")
                .select("id")
                .where("artifact_id", "=", artifact)
                .execute();

        // A step that must not wait on a held lock: it fails the test instead of hanging it.
        const bounded = <T>(promise: Promise<T>, what: string, ms = 5000) =>
            Promise.race([
                promise,
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error(`${what} did not finish in ${ms}ms`)), ms),
                ),
            ]);

        // A transaction held open by the test, so an interleaving is chosen, not hoped for.
        // `ready` rejects if the transaction fails before it is holding anything.
        function holder(work: (trx: Kysely<Database>) => Promise<void>) {
            let release!: () => void;
            const hold = new Promise<void>((resolve) => (release = resolve));
            let signal!: (pid: number) => void;
            const readyPid = new Promise<number>((resolve) => (signal = resolve));
            const done = testDb.db.transaction().execute(async (trx) => {
                await work(trx);
                const pid = (
                    await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(trx)
                ).rows[0]!.pid;
                signal(pid);
                await hold;
            });
            const ready = Promise.race([
                readyPid,
                done.then(() => {
                    throw new Error("the holding transaction ended before it was ready");
                }),
            ]) as Promise<number>;
            return { ready, release, done };
        }

        // Bounded wait until a backend is blocked by `blocker` while running a statement that
        // mentions `fragment`: proof that the operation reached its lock wait.
        async function waitBlocked(blocker: number, fragment: string) {
            for (let i = 0; i < 100; i++) {
                const rows = await sql<{ pid: number }>`
                    select pid from pg_stat_activity
                    where ${blocker} = any(pg_blocking_pids(pid)) and query ilike ${`%${fragment}%`}`.execute(
                    testDb.db,
                );
                if (rows.rows.length > 0) return;
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            throw new Error(`nothing was blocked on ${fragment}`);
        }

        it("keeps an artifact that a deployment already references", async () => {
            const app = await newApp();
            const artifact = await artifactFor(p1);
            await age(artifact);
            await createDeployment(
                testDb.db,
                people.dee!,
                org,
                app.id,
                { artifactId: artifact },
                deps(),
            );
            await collectArtifacts(testDb.db, { dataDir, retentionSeconds: 0 });
            const row = await testDb.db
                .selectFrom("artifact")
                .select("collected_at")
                .where("id", "=", artifact)
                .executeTakeFirstOrThrow();
            expect(row.collected_at).toBeNull();
            expect(await stored(await digestOf(artifact))).toBe(true);
        });

        it("refuses an artifact that collection already took", async () => {
            const app = await newApp();
            const artifact = await artifactFor(p1);
            const digest = await digestOf(artifact);
            await age(artifact);
            await collectArtifacts(testDb.db, { dataDir, retentionSeconds: 0 });
            expect(await stored(digest)).toBe(false);
            expect(
                await code(
                    createDeployment(
                        testDb.db,
                        people.dee!,
                        org,
                        app.id,
                        { artifactId: artifact },
                        deps(),
                    ),
                ),
            ).toBe("not-found");
        });

        // A collector mid-transaction holds the artifact row; the deployment must be provably
        // waiting on it before the collector commits, with or without having collected the row.
        async function deployWhileCollectorHolds(collects: boolean) {
            const app = await newApp();
            const artifact = await artifactFor(p1);
            const collector = holder(async (trx) => {
                await trx
                    .selectFrom("artifact")
                    .select("id")
                    .where("id", "=", artifact)
                    .forUpdate()
                    .execute();
                if (collects) {
                    await trx
                        .updateTable("artifact")
                        .set({ collected_at: new Date() })
                        .where("id", "=", artifact)
                        .execute();
                }
            });
            let deploying: Promise<string> | undefined;
            try {
                const pid = await collector.ready;
                deploying = code(
                    createDeployment(
                        testDb.db,
                        people.dee!,
                        org,
                        app.id,
                        { artifactId: artifact },
                        deps(),
                    ),
                );
                // The deployment is provably waiting on the collector's row lock.
                await waitBlocked(pid, "artifact");
            } finally {
                collector.release();
                await collector.done.catch(() => {});
                // Every started operation ends before the test does, even after a failure.
                await deploying;
            }
            return { outcome: await deploying, deployments: await deploymentsOf(artifact) };
        }

        it("waits for a collector that holds the artifact row, then proceeds if it left it", async () => {
            const { outcome, deployments } = await deployWhileCollectorHolds(false);
            expect(outcome).toBe("ok");
            expect(deployments).toHaveLength(1);
        });

        it("refuses an artifact the collector took while the deployment was waiting", async () => {
            const { outcome, deployments } = await deployWhileCollectorHolds(true);
            expect(outcome).toBe("not-found");
            expect(deployments).toEqual([]);
        });

        it("skips an artifact while a real deployment holds it, and the deployment then commits", async () => {
            const app = await newApp();
            const artifact = await artifactFor(p1);
            const digest = await digestOf(artifact);
            await age(artifact);
            // Pause the real deployment after its artifact lookup: block its next step, the
            // hostname registry read, behind a lock the test holds.
            const gate = holder(async (trx) => {
                await sql`lock table hostname_reservation in access exclusive mode`.execute(trx);
            });
            let deploying: Promise<string> | undefined;
            let collection: Promise<{ collected: string[] }> | undefined;
            let collected: string[] = [];
            try {
                const pid = await gate.ready;
                deploying = code(
                    createDeployment(
                        testDb.db,
                        people.dee!,
                        org,
                        app.id,
                        { artifactId: artifact },
                        deps(),
                    ),
                );
                await waitBlocked(pid, "hostname_reservation");
                // It is past the artifact lookup now: collection must skip the artifact.
                collection = collectArtifacts(testDb.db, { dataDir, retentionSeconds: 0 });
                collected = (await bounded(collection, "collection")).collected;
            } finally {
                gate.release();
                await gate.done.catch(() => {});
                // Both operations end before the test does, even after a failure above.
                await collection?.catch(() => {});
                await deploying;
            }
            expect(await deploying).toBe("ok");
            expect(collected).not.toContain(artifact);
            expect((await deploymentsOf(artifact)).length).toBe(1);
            expect(await stored(digest)).toBe(true);
        });

        it("never ends with a deployment whose archive is gone, in either interleaving", async () => {
            for (let i = 0; i < 5; i++) {
                const app = await newApp();
                const artifact = await artifactFor(p1);
                const digest = await digestOf(artifact);
                await age(artifact);
                const [deployed, collected] = await Promise.allSettled([
                    createDeployment(
                        testDb.db,
                        people.dee!,
                        org,
                        app.id,
                        { artifactId: artifact },
                        deps(),
                    ),
                    collectArtifacts(testDb.db, { dataDir, retentionSeconds: 0 }),
                ]);
                expect(collected.status).toBe("fulfilled");
                if (deployed.status === "fulfilled") {
                    expect((await deploymentsOf(artifact)).length).toBe(1);
                    expect(await stored(digest)).toBe(true);
                } else {
                    // Only a refusal, and only because collection took this very artifact.
                    expect(deployed.reason).toBeInstanceOf(ServiceError);
                    expect((deployed.reason as ServiceError).code).toBe("not-found");
                    expect(await stored(digest)).toBe(false);
                    expect(await deploymentsOf(artifact)).toEqual([]);
                }
            }
        });
    });

    it("refuses a second unfinished deployment and allows one after it finishes", async () => {
        const app = await newApp();
        const artifact = await artifactFor(p1);
        const first = await createDeployment(
            testDb.db,
            people.dee!,
            org,
            app.id,
            { artifactId: artifact },
            deps(),
        );
        expect(
            await code(
                createDeployment(
                    testDb.db,
                    people.dee!,
                    org,
                    app.id,
                    { artifactId: artifact },
                    deps(),
                ),
            ),
        ).toBe("conflict");
        await finish(first.id);
        const second = await createDeployment(
            testDb.db,
            people.dee!,
            org,
            app.id,
            { artifactId: artifact },
            deps(),
        );
        expect(second.id).not.toBe(first.id);
        // Two deployments never share a remote identity.
        const names = await sql<{ app_name: string; hostname: string }>`
            select app_name, hostname from deployment where app_id = ${app.id}`.execute(testDb.db);
        expect(new Set(names.rows.map((r) => r.app_name)).size).toBe(2);
        expect(new Set(names.rows.map((r) => r.hostname)).size).toBe(2);
    });

    it("serializes racing requests for one app: exactly one is accepted", async () => {
        const app = await newApp();
        const artifact = await artifactFor(p1);
        const results = await Promise.all(
            Array.from({ length: 6 }, () =>
                code(
                    createDeployment(
                        testDb.db,
                        people.dee!,
                        org,
                        app.id,
                        { artifactId: artifact },
                        deps(),
                    ),
                ),
            ),
        );
        expect(results.filter((r) => r === "ok")).toHaveLength(1);
        expect(results.filter((r) => r === "conflict")).toHaveLength(5);
    });

    it("enforces the per-app and per-organization deployment quotas", async () => {
        const app = await newApp();
        const artifact = await artifactFor(p1);
        const perApp = deps({ LAUNCHPAD_MAX_DEPLOYMENTS_PER_APP: "2" });
        for (let i = 0; i < 2; i++) {
            const d = await createDeployment(
                testDb.db,
                people.dee!,
                org,
                app.id,
                { artifactId: artifact },
                perApp,
            );
            await finish(d.id);
        }
        expect(
            await code(
                createDeployment(
                    testDb.db,
                    people.dee!,
                    org,
                    app.id,
                    { artifactId: artifact },
                    perApp,
                ),
            ),
        ).toBe("conflict");
        // The organization total counts every app; a tiny limit is already exceeded.
        const another = await newApp();
        expect(
            await code(
                createDeployment(
                    testDb.db,
                    people.dee!,
                    org,
                    another.id,
                    { artifactId: artifact },
                    deps({
                        LAUNCHPAD_MAX_DEPLOYMENTS: "1",
                        LAUNCHPAD_MAX_DEPLOYMENTS_PER_APP: "1",
                    }),
                ),
            ),
        ).toBe("conflict");
    });

    it("checks authority, the artifact's organization and the off switch", async () => {
        const app = await newApp();
        const artifact = await artifactFor(p1);
        const foreign = await artifactFor(
            (await createProject(testDb.db, people.zoe!, otherOrg, { name: "F", slug: "f" })).id,
            "zoe",
            otherOrg,
        );
        const create = (who: string, artifactId: string, d = deps()) =>
            code(createDeployment(testDb.db, people[who]!, org, app.id, { artifactId }, d));
        expect(await create("vic", artifact)).toBe("forbidden");
        expect(await create("zoe", artifact)).toBe("not-found");
        expect(await create("dee", foreign)).toBe("not-found");
        expect(await create("dee", randomUUID())).toBe("not-found");
        expect(await create("dee", artifact, { dataDir, settings: { enabled: false } })).toBe(
            "unavailable",
        );
        expect(
            await code(
                createDeployment(
                    testDb.db,
                    people.dee!,
                    org,
                    randomUUID(),
                    { artifactId: artifact },
                    deps(),
                ),
            ),
        ).toBe("not-found");
    });

    it("lets a project-restricted key use only artifacts uploaded through the app's project", async () => {
        // Two keys with the same creator, restricted to different projects.
        const app1 = await newApp(p1);
        const app2 = await newApp(p2);
        const through2 = await artifactFor(p2);
        const attempt = (appId: string, artifactId: string, restrictTo: string[] | null) =>
            code(
                createDeployment(
                    testDb.db,
                    people.dee!,
                    org,
                    appId,
                    { artifactId },
                    deps(),
                    restrictTo,
                ),
            );
        // The key for project 1 cannot use project 2's upload, even though the creator is the same.
        expect(await attempt(app1.id, through2, [p1])).toBe("not-found");
        // A key for project 2 cannot reach the app in project 1 at all.
        expect(await attempt(app1.id, through2, [p2])).toBe("not-found");
        expect(await attempt(app2.id, through2, [p2])).toBe("ok");
        // An unrestricted key (or a session) needs only the organization match.
        const finishedApp = await newApp(p1);
        expect(await attempt(finishedApp.id, through2, null)).toBe("ok");
        // The same bytes uploaded through project 1 as well make it usable there.
        const reupload = await artifactFor(p1);
        expect(await attempt(app1.id, reupload, [p1])).toBe("ok");
        // An older artifact with no provenance is refused to restricted keys only.
        const legacy = await testDb.db
            .insertInto("artifact")
            .values({
                organization_id: org,
                digest: "e".repeat(64),
                size_bytes: 10,
                expanded_bytes: 10,
                entry_count: 1,
                storage_key: "legacy",
                created_by: people.dee!.userId,
            })
            .returning("id")
            .executeTakeFirstOrThrow();
        const legacyApp = await newApp(p1);
        expect(await attempt(legacyApp.id, legacy.id, [p1])).toBe("not-found");
        expect(await attempt(legacyApp.id, legacy.id, null)).toBe("ok");
    });

    it("refuses while model recovery is blocked, and records the writer first", async () => {
        const app = await newApp();
        const artifact = await artifactFor(p1);
        await markDeploymentRecoveryBlocked(dataDir);
        await expect(
            createDeployment(testDb.db, people.dee!, org, app.id, { artifactId: artifact }, deps()),
        ).rejects.toThrow(/recovery is blocked/i);
        expect(
            await testDb.db
                .selectFrom("deployment")
                .select("id")
                .where("app_id", "=", app.id)
                .execute(),
        ).toEqual([]);
    });

    it("hides deployments and events of other organizations and projects", async () => {
        const app = await newApp(p1);
        const artifact = await artifactFor(p1);
        const deployment = await createDeployment(
            testDb.db,
            people.dee!,
            org,
            app.id,
            { artifactId: artifact },
            deps(),
        );
        expect(await code(getDeployment(testDb.db, people.zoe!, org, deployment.id))).toBe(
            "not-found",
        );
        expect(await code(getDeployment(testDb.db, people.zoe!, otherOrg, deployment.id))).toBe(
            "not-found",
        );
        expect(await code(getDeployment(testDb.db, people.vic!, org, deployment.id, [p2]))).toBe(
            "not-found",
        );
        expect(
            await code(listDeploymentEvents(testDb.db, people.vic!, org, deployment.id, {}, [p2])),
        ).toBe("not-found");
        expect(await code(listDeployments(testDb.db, people.vic!, org, app.id, [p2]))).toBe(
            "not-found",
        );
        expect(
            await listDeploymentEvents(testDb.db, people.vic!, org, deployment.id, { afterSeq: 1 }),
        ).toEqual([]);
    });
});

describe("deployment deletion", () => {
    async function finished(status: "succeeded" | "failed" = "succeeded", stepDone = "verify") {
        const app = await newApp();
        const artifactId = await artifactFor(p1);
        const deployment = await createDeployment(
            testDb.db,
            people.dee!,
            org,
            app.id,
            { artifactId },
            deps(),
        );
        const compact = deployment.id.replaceAll("-", "");
        await sql`
            update deployment set status = ${status}, finished_at = now(), step_done = ${stepDone},
                image_tag = ${status === "succeeded" ? `launchpad/site:${compact}` : null},
                image_id = ${status === "succeeded" ? `sha256:${"c".repeat(64)}` : null}
            where id = ${deployment.id}`.execute(testDb.db);
        return { app, artifactId, deployment };
    }
    const request = (id: string, who = "dee", restrictTo?: string[], settings = deps()) =>
        requestDeploymentDeletion(testDb.db, people[who]!, org, id, settings, restrictTo);
    const state = (id: string) =>
        testDb.db
            .selectFrom("deployment")
            .select(["desired_state", "deleted_at", "status"])
            .where("id", "=", id)
            .executeTakeFirstOrThrow();

    afterEach(async () => {
        // Leave nothing runnable behind for the claim tests that share this database.
        await testDb.db
            .updateTable("deployment_deletion_operation")
            .set({ status: "reconciliation-needed", lease_owner: null, lease_expires_at: null })
            .where("status", "in", ["queued", "running"])
            .execute();
    });

    it("queues one manual deletion and refuses repeats, unfinished and unreconciled work", async () => {
        const { deployment } = await finished();
        const result = await request(deployment.id);
        expect(result).toMatchObject({ deploymentId: deployment.id, status: "queued" });
        expect(await state(deployment.id)).toMatchObject({ desired_state: "deleting" });
        expect(await code(request(deployment.id))).toBe("conflict");
        expect(
            (await listDeploymentEvents(testDb.db, people.vic!, org, deployment.id)).at(-1),
        ).toMatchObject({ phase: "deleting" });

        const app = await newApp();
        const artifactId = await artifactFor(p1);
        const queued = await createDeployment(
            testDb.db,
            people.dee!,
            org,
            app.id,
            { artifactId },
            deps(),
        );
        expect(await code(request(queued.id))).toBe("conflict");
        await sql`update deployment set status = 'reconciliation-needed' where id = ${queued.id}`.execute(
            testDb.db,
        );
        expect(await code(request(queued.id))).toBe("conflict");
        expect(await state(queued.id)).toMatchObject({ desired_state: "active" });
    });

    it("needs the deployer role, the project and a switched-on instance", async () => {
        const { deployment } = await finished("failed", "app");
        expect(await code(request(deployment.id, "vic"))).toBe("forbidden");
        expect(await code(request(deployment.id, "dee", [p2]))).toBe("not-found");
        expect(
            await code(
                requestDeploymentDeletion(testDb.db, people.dee!, otherOrg, deployment.id, deps()),
            ),
        ).toBeDefined();
        expect(
            await code(
                request(deployment.id, "dee", undefined, { dataDir, settings: { enabled: false } }),
            ),
        ).toBe("unavailable");
        expect(await state(deployment.id)).toMatchObject({ desired_state: "active" });
        expect(await request(deployment.id, "dee", [p1])).toMatchObject({ status: "queued" });
    });

    it("serializes concurrent requests for the same deployment", async () => {
        const { deployment } = await finished();
        const results = await Promise.all(
            [request(deployment.id), request(deployment.id)].map(code),
        );
        expect(results.toSorted()).toEqual(["conflict", "ok"]);
        expect(
            await testDb.db
                .selectFrom("deployment_deletion_operation")
                .select("id")
                .where("deployment_id", "=", deployment.id)
                .execute(),
        ).toHaveLength(1);
    });

    it("runs through its steps, deletes, and keeps both names reserved", async () => {
        const { deployment } = await finished();
        const operation = await request(deployment.id);
        const claimed = await claimDeletion(testDb.db, dataDir, "worker");
        if (claimed.kind !== "claimed") throw new Error("Expected a claim");
        const { token } = claimed;
        expect(claimed.deletion).toMatchObject({
            deploymentId: deployment.id,
            ownsRemoteApp: true,
        });
        expect(token.id).toBe(operation.operationId);
        expect(await beginDeletionStep(testDb.db, dataDir, token, "images")).toBeNull();
        expect(await beginDeletionStep(testDb.db, dataDir, token, "destroy")).not.toBeNull();
        expect(await beginDeletionStep(testDb.db, dataDir, token, "destroy")).toBeNull();
        expect(await completeDeletionStep(testDb.db, dataDir, token, "destroy")).toMatchObject({
            step_done: "destroy",
        });
        expect(await state(deployment.id)).toMatchObject({ desired_state: "deleting" });
        await beginDeletionStep(testDb.db, dataDir, token, "images");
        expect(await completeDeletionStep(testDb.db, dataDir, token, "images")).toMatchObject({
            status: "succeeded",
        });
        expect(await state(deployment.id)).toMatchObject({
            desired_state: "deleted",
            deleted_at: expect.any(Date),
        });
        const row = await testDb.db
            .selectFrom("deployment")
            .select(["hostname", "app_name"])
            .where("id", "=", deployment.id)
            .executeTakeFirstOrThrow();
        expect(
            await testDb.db
                .selectFrom("hostname_reservation")
                .select("released_at")
                .where("hostname", "=", row.hostname)
                .executeTakeFirstOrThrow(),
        ).toEqual({ released_at: null });
        expect(
            await testDb.db
                .selectFrom("dokku_name_reservation")
                .select("released_at")
                .where("app_name", "=", row.app_name)
                .executeTakeFirstOrThrow(),
        ).toEqual({ released_at: null });
        expect(
            (await listDeploymentEvents(testDb.db, people.vic!, org, deployment.id)).at(-1),
        ).toMatchObject({ phase: "deleted" });
        expect(await claimDeletion(testDb.db, dataDir, "worker")).toEqual({ kind: "idle" });
    });

    it("does not treat a name that was never created as an owned app", async () => {
        const { deployment } = await finished("failed", null as unknown as string);
        await request(deployment.id);
        const claimed = await claimDeletion(testDb.db, dataDir, "worker");
        expect(claimed).toMatchObject({ kind: "claimed", deletion: { ownsRemoteApp: false } });
    });

    it("rejects a delayed step from a reclaimed worker without changing the operation or events", async () => {
        const { deployment } = await finished();
        await request(deployment.id);
        const old = await claimDeletion(testDb.db, dataDir, "worker");
        if (old.kind !== "claimed") throw new Error("Expected a claim");
        await beginDeletionStep(testDb.db, dataDir, old.token, "destroy");
        await testDb.db
            .updateTable("deployment_deletion_operation")
            .set({ lease_expires_at: new Date(0), step_pending: null })
            .where("id", "=", old.token.id)
            .execute();
        const current = await claimDeletion(testDb.db, dataDir, "worker");
        if (current.kind !== "claimed") throw new Error("Expected replacement claim");
        expect(current.token).toMatchObject({ attempt: 2, fence: "2" });
        const before = await testDb.db
            .selectFrom("deployment_deletion_operation")
            .selectAll()
            .where("id", "=", old.token.id)
            .executeTakeFirstOrThrow();
        const events = await listDeploymentEvents(testDb.db, people.vic!, org, deployment.id);
        expect(await completeDeletionStep(testDb.db, dataDir, old.token, "destroy")).toBeNull();
        expect(
            await stopDeletionStep(
                testDb.db,
                dataDir,
                old.token,
                "destroy",
                "reconciliation-needed",
            ),
        ).toBeNull();
        expect(await renewDeletionClaim(testDb.db, dataDir, old.token)).toBeNull();
        expect(
            await testDb.db
                .selectFrom("deployment_deletion_operation")
                .selectAll()
                .where("id", "=", old.token.id)
                .executeTakeFirstOrThrow(),
        ).toEqual(before);
        expect(await listDeploymentEvents(testDb.db, people.vic!, org, deployment.id)).toEqual(
            events,
        );
        expect(await state(deployment.id)).toMatchObject({ desired_state: "deleting" });
    });

    it("holds a pending destroy for reconciliation, repeats a pending image removal, and backs off a retry", async () => {
        const first = await finished();
        const second = await finished();
        await request(first.deployment.id);
        await request(second.deployment.id);
        const a = await claimDeletion(testDb.db, dataDir, "worker");
        const b = await claimDeletion(testDb.db, dataDir, "worker");
        if (a.kind !== "claimed" || b.kind !== "claimed") throw new Error("Expected claims");
        await beginDeletionStep(testDb.db, dataDir, a.token, "destroy");
        await beginDeletionStep(testDb.db, dataDir, b.token, "destroy");
        await completeDeletionStep(testDb.db, dataDir, b.token, "destroy");
        await beginDeletionStep(testDb.db, dataDir, b.token, "images");
        await testDb.db
            .updateTable("deployment_deletion_operation")
            .set({ lease_expires_at: new Date(0) })
            .where("id", "in", [a.token.id, b.token.id])
            .execute();
        const results = [
            await claimDeletion(testDb.db, dataDir, "next"),
            await claimDeletion(testDb.db, dataDir, "next"),
        ];
        expect(results).toContainEqual({ kind: "reconciliation-needed", id: a.token.id });
        expect(results).toContainEqual(
            expect.objectContaining({
                kind: "claimed",
                deletion: expect.objectContaining({ stepDone: "destroy" }),
            }),
        );
        expect(await claimDeletion(testDb.db, dataDir, "next")).toEqual({ kind: "idle" });

        const retry = await finished();
        await request(retry.deployment.id);
        const claim = await claimDeletion(testDb.db, dataDir, "worker");
        if (claim.kind !== "claimed") throw new Error("Expected a claim");
        expect(
            await stopDeletionStep(testDb.db, dataDir, claim.token, "destroy", "retry"),
        ).toMatchObject({
            status: "queued",
            step_pending: null,
        });
        expect(await claimDeletion(testDb.db, dataDir, "worker")).toEqual({ kind: "idle" });
    });

    it("blocks claims and steps during recovery", async () => {
        const { deployment } = await finished();
        await request(deployment.id);
        const claimed = await claimDeletion(testDb.db, dataDir, "worker");
        if (claimed.kind !== "claimed") throw new Error("Expected a claim");
        await markDeploymentRecoveryBlocked(dataDir);
        await expect(claimDeletion(testDb.db, dataDir, "other")).rejects.toThrow(
            /recovery is blocked/i,
        );
        await expect(
            beginDeletionStep(testDb.db, dataDir, claimed.token, "destroy"),
        ).rejects.toThrow(/recovery is blocked/i);
    });

    it("keeps an artifact pinned while its deployment is deleting and for the retention period after", async () => {
        const { deployment, artifactId } = await finished();
        await request(deployment.id);
        const collected = async () =>
            (
                await testDb.db
                    .selectFrom("artifact")
                    .select("collected_at")
                    .where("id", "=", artifactId)
                    .executeTakeFirstOrThrow()
            ).collected_at;
        await testDb.db
            .updateTable("artifact")
            .set({ created_at: new Date(0) })
            .where("id", "=", artifactId)
            .execute();
        await collectArtifacts(testDb.db, { dataDir, retentionSeconds: 0 });
        expect(await collected()).toBeNull();
        const claimed = await claimDeletion(testDb.db, dataDir, "worker");
        if (claimed.kind !== "claimed") throw new Error("Expected a claim");
        for (const step of ["destroy", "images"] as const) {
            await beginDeletionStep(testDb.db, dataDir, claimed.token, step);
            await completeDeletionStep(testDb.db, dataDir, claimed.token, step);
        }
        await collectArtifacts(testDb.db, { dataDir, retentionSeconds: 3600 });
        expect(await collected()).toBeNull();
        await collectArtifacts(testDb.db, { dataDir, retentionSeconds: 0 });
        expect(await collected()).toBeInstanceOf(Date);
    });
});

describe("deployment reconcile", () => {
    async function held(pending: string, image = true) {
        const app = await newApp();
        const artifactId = await artifactFor(p1);
        const deployment = await createDeployment(
            testDb.db,
            people.dee!,
            org,
            app.id,
            { artifactId },
            deps(),
        );
        await sql`update deployment set status = 'reconciliation-needed', step_pending = ${pending},
            step_done = ${pending === "app" ? null : "app"},
            image_tag = ${image ? `launchpad/site:${deployment.id.replaceAll("-", "")}` : null},
            image_id = ${image ? `sha256:${"e".repeat(64)}` : null}
            where id = ${deployment.id}`.execute(testDb.db);
        return { app, artifactId, deployment };
    }
    const reconcile = (
        deploymentId: string,
        outcome: "succeeded" | "failed-clean" | "abandon",
        attested = true,
    ) => reconcileDeployment(testDb.db, dataDir, { deploymentId, outcome, attested });
    const row = (id: string) =>
        testDb.db
            .selectFrom("deployment")
            .selectAll()
            .where("id", "=", id)
            .executeTakeFirstOrThrow();

    it("needs the attestation and a held deployment", async () => {
        const { deployment } = await held("load");
        await expect(reconcile(deployment.id, "failed-clean", false)).rejects.toThrow(/exact-name/);
        expect(await code(reconcile(randomUUID(), "failed-clean"))).toBe("not-found");
        expect((await row(deployment.id)).status).toBe("reconciliation-needed");
        const fresh = await newApp();
        const artifact = await artifactFor(p1);
        const queued = await createDeployment(
            testDb.db,
            people.dee!,
            org,
            fresh.id,
            { artifactId: artifact },
            deps(),
        );
        expect(await code(reconcile(queued.id, "abandon"))).toBe("conflict");
    });

    it("unblocks the app with each outcome and records an audited event", async () => {
        const succeeded = await held("verify");
        expect(await reconcile(succeeded.deployment.id, "succeeded")).toEqual({
            kind: "deployment",
            outcome: "succeeded",
        });
        expect(await row(succeeded.deployment.id)).toMatchObject({
            status: "succeeded",
            step_done: "verify",
            step_pending: null,
            finished_at: expect.any(Date),
        });
        const clean = await held("app");
        await reconcile(clean.deployment.id, "failed-clean");
        expect(await row(clean.deployment.id)).toMatchObject({
            status: "failed",
            step_done: null,
            step_pending: null,
            failure_code: "reconciled-clean",
        });
        const abandoned = await held("load");
        await reconcile(abandoned.deployment.id, "abandon");
        expect(await row(abandoned.deployment.id)).toMatchObject({
            status: "failed",
            step_done: "app",
            failure_code: "abandoned",
        });
        expect(
            (await listDeploymentEvents(testDb.db, people.vic!, org, abandoned.deployment.id)).at(
                -1,
            ),
        ).toMatchObject({ phase: "reconciled" });
        expect(
            await testDb.db
                .selectFrom("audit_event")
                .select("detail")
                .where("action", "=", "deployment.reconciled")
                .where("target_id", "=", abandoned.deployment.id)
                .executeTakeFirstOrThrow(),
        ).toEqual({ detail: "kind=deployment;outcome=abandon" });
        // The app can deploy again.
        const next = await createDeployment(
            testDb.db,
            people.dee!,
            org,
            clean.app.id,
            { artifactId: await artifactFor(p1) },
            deps(),
        );
        expect(next.status).toBe("queued");
    });

    it("refuses to mark a deployment succeeded when no image was recorded", async () => {
        const { deployment } = await held("build", false);
        expect(await code(reconcile(deployment.id, "succeeded"))).toBe("conflict");
        expect((await row(deployment.id)).status).toBe("reconciliation-needed");
    });

    it("releases a held deletion for the worker, never abandons it", async () => {
        const { deployment } = await held("verify");
        await reconcile(deployment.id, "succeeded");
        await requestDeploymentDeletion(testDb.db, people.dee!, org, deployment.id, deps());
        const claim = await claimDeletion(testDb.db, dataDir, "worker");
        if (claim.kind !== "claimed") throw new Error("Expected a claim");
        await beginDeletionStep(testDb.db, dataDir, claim.token, "destroy");
        await stopDeletionStep(testDb.db, dataDir, claim.token, "destroy", "reconciliation-needed");
        expect(await code(reconcile(deployment.id, "abandon"))).toBe("invalid");
        await reconcile(deployment.id, "succeeded");
        const next = await claimDeletion(testDb.db, dataDir, "worker");
        expect(next).toMatchObject({ kind: "claimed", deletion: { stepDone: "destroy" } });
        if (next.kind !== "claimed") throw new Error("Expected a claim");
        await beginDeletionStep(testDb.db, dataDir, next.token, "images");
        await completeDeletionStep(testDb.db, dataDir, next.token, "images");
        expect(await row(deployment.id)).toMatchObject({ desired_state: "deleted" });
    });
});
