import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDatabase } from "@launchpad-kit/database/testing";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
    acknowledgePromotionDispatch,
    addMember,
    beginPromotionStep,
    claimPromotion,
    createAlias,
    createApp,
    createDeployment,
    createOrganization,
    createProject,
    failPromotion,
    finalizePromotion,
    holdPromotion,
    listAliasOperations,
    listDeploymentEvents,
    parseAliasConfig,
    parseDeploymentConfig,
    requestDeploymentDeletion,
    requestPromotion,
    requestWithdrawal,
    renewPromotionClaim,
    ServiceError,
    supersedeOperation,
    uploadArtifact,
    withDeploymentRecoveryMaintenance,
    type AliasDeps,
    type Principal,
} from "../index";
import type { PromotionClaimToken, PromotionReadback } from "../promotion-claims";
import { SITE, tarGz } from "../testing/tar-fixtures";

let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
let dataDir = "";
let org = "";
let p1 = "";
let p2 = "";
const people: Record<string, Principal> = {};
const env = {
    LAUNCHPAD_DEPLOYMENTS: "on",
    LAUNCHPAD_ALIASES: "on",
    LAUNCHPAD_BASE_URL: "https://control.example.com",
    LAUNCHPAD_APPS_DOMAIN: "sites.example.net",
    LAUNCHPAD_MAX_APPS: "1000",
    LAUNCHPAD_MAX_ALIASES_PER_APP: "50",
    LAUNCHPAD_MAX_ALIASES: "1000",
};
const deps = (extra: Record<string, string> = {}): AliasDeps => ({
    dataDir,
    settings: parseDeploymentConfig({ ...env, ...extra }),
    aliases: parseAliasConfig({ ...env, ...extra }),
});
const code = (promise: Promise<unknown>) =>
    promise.then(
        () => "ok",
        (error) => (error instanceof ServiceError ? error.code : `unexpected: ${error}`),
    );

async function newUser(name: string, role: "user" | "operator" = "user") {
    const id = randomUUID();
    await testDb.db
        .insertInto("user")
        .values({ id, name, email: `${name}@example.com`, emailVerified: false, role })
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

let counter = 0;
async function artifact() {
    const bytes = tarGz([...SITE, { name: `p-${++counter}.txt`, content: String(counter) }]);
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(bytes);
            controller.close();
        },
    });
    return (
        await uploadArtifact(
            testDb.db,
            people.dee!,
            org,
            body,
            { contentLength: bytes.length, projectId: p1 },
            { dataDir, limits: { maxArtifacts: 1000 } },
        )
    ).id;
}

// A fresh app with one alias, plus a way to add finished deployments to it.
async function fixture(aliasExtra: Record<string, string> = {}) {
    const app = await createApp(
        testDb.db,
        people.dee!,
        org,
        p1,
        { slug: `app-${++counter}` },
        deps(),
    );
    const alias = await createAlias(
        testDb.db,
        people.dee!,
        org,
        app.id,
        { slug: "prod" },
        deps(aliasExtra),
    );
    const ready = async () => {
        const deployment = await createDeployment(
            testDb.db,
            people.dee!,
            org,
            app.id,
            { artifactId: await artifact() },
            deps(),
        );
        await sql`update deployment set status = 'succeeded', finished_at = now(), step_done = 'verify',
            image_tag = ${`launchpad/site:${deployment.id.replaceAll("-", "")}`},
            image_id = ${`sha256:${"f".repeat(64)}`} where id = ${deployment.id}`.execute(
            testDb.db,
        );
        return deployment.id;
    };
    return { app, alias, ready };
}

const promote = (
    aliasId: string,
    target: string,
    expected: string,
    key: string = randomUUID(),
    who = "dee",
    restrictTo?: string[],
    extra: Record<string, string> = {},
) =>
    requestPromotion(
        testDb.db,
        people[who]!,
        org,
        aliasId,
        { targetDeploymentId: target, expectedGeneration: expected },
        key,
        deps(extra),
        restrictTo,
    );
const withdraw = (aliasId: string, expected: string, key: string = randomUUID(), who = "dee") =>
    requestWithdrawal(
        testDb.db,
        people[who]!,
        org,
        aliasId,
        { expectedGeneration: expected },
        key,
        deps(),
    );
const aliasRow = (id: string) =>
    testDb.db.selectFrom("app_alias").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const operations = (aliasId: string) =>
    testDb.db
        .selectFrom("promotion_operation")
        .selectAll()
        .where("alias_id", "=", aliasId)
        .orderBy("generation")
        .execute();
const deleteDeployment = (id: string) =>
    requestDeploymentDeletion(testDb.db, people.dee!, org, id, deps());

async function setupDatabase() {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "launchpad-promotions-"));
    testDb = await createTestDatabase();
    await testDb.migrate();
    await newUser("root", "operator");
    for (const name of ["ann", "dee", "vic"]) await newUser(name);
    org = (
        await createOrganization(testDb.db, people.root!, {
            name: "Acme",
            slug: "acme",
            ownerEmail: "ann@example.com",
        })
    ).id;
    await addMember(testDb.db, people.ann!, org, { email: "dee@example.com", role: "deployer" });
    await addMember(testDb.db, people.ann!, org, { email: "vic@example.com", role: "viewer" });
    p1 = (await createProject(testDb.db, people.ann!, org, { name: "One", slug: "one" })).id;
    p2 = (await createProject(testDb.db, people.ann!, org, { name: "Two", slug: "two" })).id;
}
async function teardownDatabase() {
    try {
        await testDb?.destroy();
    } finally {
        if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
    }
}

describe("promotion claims and finalization", () => {
    beforeEach(setupDatabase);
    afterEach(teardownDatabase);
    const authority = { instanceId: randomUUID(), epoch: randomUUID() };
    async function claim(aliasId: string) {
        const result = await claimPromotion(testDb.db, dataDir, "worker");
        if (result.kind !== "claimed") throw new Error(`Expected a claim, got ${result.kind}`);
        expect(result.alias.id).toBe(aliasId);
        return result;
    }
    const dispatch = (token: PromotionClaimToken) =>
        beginPromotionStep(testDb.db, dataDir, token, "dispatch");
    const ack = (token: PromotionClaimToken) =>
        acknowledgePromotionDispatch(testDb.db, dataDir, token);
    const verify = (token: PromotionClaimToken) =>
        beginPromotionStep(testDb.db, dataDir, token, "verify");
    const expire = (id: string) =>
        testDb.db
            .updateTable("promotion_operation")
            .set({ lease_expires_at: new Date(0) })
            .where("id", "=", id)
            .execute();

    function observation(job: Awaited<ReturnType<typeof claim>>): PromotionReadback {
        return {
            ...authority,
            route: {
                aliasId: job.alias.id,
                hostname: job.alias.hostname,
                operationId: job.operation.id,
                generation: job.operation.generation,
                target: job.target
                    ? { deploymentId: job.target.id, hostname: job.target.hostname }
                    : null,
            },
        };
    }
    async function verifying(job: Awaited<ReturnType<typeof claim>>) {
        expect(await dispatch(job.token)).toEqual({ id: job.token.id });
        expect(await ack(job.token)).toEqual({ id: job.token.id });
        expect(await verify(job.token)).toEqual({ id: job.token.id });
    }
    const finish = (job: Awaited<ReturnType<typeof claim>>, seen = observation(job)) =>
        finalizePromotion(testDb.db, dataDir, job.token, authority, async () => seen);
    const unpinned = async (id: string) =>
        (
            await testDb.db
                .selectFrom("deployment")
                .select("last_unpinned_at")
                .where("id", "=", id)
                .executeTakeFirstOrThrow()
        ).last_unpinned_at;

    // Hold the app row on another connection so finalization blocks after its readback.
    async function holdAppLock(appId: string) {
        const locked = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const done = testDb.db.transaction().execute(async (trx) => {
            await trx.selectFrom("app").select("id").where("id", "=", appId).forUpdate().execute();
            locked.resolve();
            await release.promise;
        });
        await locked.promise;
        return {
            async release() {
                release.resolve();
                await done;
            },
        };
    }
    async function waitForRowLockWait() {
        for (let attempt = 0; attempt < 200; attempt++) {
            const { rows } = await sql<{ waiting: string }>`
                select count(*)::text as waiting from pg_stat_activity
                where datname = current_database() and wait_event_type = 'Lock'`.execute(testDb.db);
            if (rows[0]!.waiting !== "0") return;
            await new Promise<void>((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("Finalization never waited for the row lock.");
    }

    it("holds lost dispatch without reissuing it or releasing its target", async () => {
        const { alias, ready } = await fixture();
        const target = await ready();
        await promote(alias.id, target, "0");
        const job = await claim(alias.id);
        expect(await ack(job.token)).toBeNull();
        expect(await dispatch(job.token)).not.toBeNull();
        await expire(job.token.id);
        expect(await claimPromotion(testDb.db, dataDir, "worker")).toEqual({
            kind: "reconciliation-needed",
            id: job.token.id,
        });
        expect(await claimPromotion(testDb.db, dataDir, "worker")).toEqual({ kind: "idle" });
        expect(await aliasRow(alias.id)).toMatchObject({ state: "binding-uncertain" });
        expect(await code(deleteDeployment(target))).toBe("conflict");
        expect(await ack(job.token)).toBeNull();
    });

    it("resumes readback and rejects a stale worker's actual finalization write", async () => {
        const { alias, ready } = await fixture();
        const target = await ready();
        await promote(alias.id, target, "0");
        const old = await claim(alias.id);
        await verifying(old);
        await expire(old.token.id);
        const current = await claim(alias.id);
        expect(current.token).toMatchObject({ id: old.token.id, attempt: 2, fence: "2" });
        expect(current.operation).toMatchObject({ step_done: "dispatch", step_pending: null });
        expect(await dispatch(current.token)).toBeNull();
        expect(await verify(current.token)).not.toBeNull();
        const before = await operations(alias.id);
        expect(await finish(old)).toBeNull();
        expect(await renewPromotionClaim(testDb.db, dataDir, old.token)).toBeNull();
        expect(await operations(alias.id)).toEqual(before);
        expect(await aliasRow(alias.id)).toMatchObject({ committed_generation: "0" });
        expect(await finish(current)).toEqual({ id: current.token.id });
    });

    it("refuses the current token after expiry, without needing a replacement claim", async () => {
        const { alias, ready } = await fixture();
        await promote(alias.id, await ready(), "0");
        const job = await claim(alias.id);
        const { token } = job;
        expect(await holdPromotion(testDb.db, dataDir, token)).toBeNull();
        await expire(token.id);
        let before = await operations(alias.id);
        expect(await dispatch(token)).toBeNull();
        expect(await renewPromotionClaim(testDb.db, dataDir, token)).toBeNull();
        expect(await operations(alias.id)).toEqual(before);
        const second = await claim(alias.id);
        expect(await dispatch(second.token)).not.toBeNull();
        await expire(second.token.id);
        before = await operations(alias.id);
        expect(await ack(second.token)).toBeNull();
        expect(await holdPromotion(testDb.db, dataDir, second.token)).toBeNull();
        expect(await operations(alias.id)).toEqual(before);
        expect(await claimPromotion(testDb.db, dataDir, "worker")).toMatchObject({
            kind: "reconciliation-needed",
            id: second.token.id,
        });

        const fresh = await fixture();
        await promote(fresh.alias.id, await fresh.ready(), "0");
        const verifyingJob = await claim(fresh.alias.id);
        await verifying(verifyingJob);
        await expire(verifyingJob.token.id);
        before = await operations(fresh.alias.id);
        expect(await finish(verifyingJob)).toBeNull();
        expect(await operations(fresh.alias.id)).toEqual(before);
        expect(await aliasRow(fresh.alias.id)).toMatchObject({ committed_generation: "0" });
        const retry = await claim(fresh.alias.id);
        expect(await verify(retry.token)).not.toBeNull();
        expect(await finish(retry)).not.toBeNull();
    });

    it("parks a generation mismatch without hiding the next runnable operation", async () => {
        const bad = await fixture();
        const target = await bad.ready();
        const operation = await promote(bad.alias.id, target, "0");
        await testDb.db
            .updateTable("app_alias")
            .set({ reserved_generation: "2" })
            .where("id", "=", bad.alias.id)
            .execute();
        const before = await aliasRow(bad.alias.id);
        const next = await fixture();
        const queued = await promote(next.alias.id, await next.ready(), "0");
        expect(await claimPromotion(testDb.db, dataDir, "worker")).toEqual({
            kind: "reconciliation-needed",
            id: operation.id,
        });
        expect(await operations(bad.alias.id)).toMatchObject([
            {
                status: "reconciliation-needed",
                failure_code: "alias-generation-mismatch",
            },
        ]);
        expect(await aliasRow(bad.alias.id)).toEqual(before);
        expect(await code(deleteDeployment(target))).toBe("conflict");
        const job = await claim(next.alias.id);
        expect(job.token.id).toBe(queued.id);
        await verifying(job);
        expect(await finish(job)).not.toBeNull();
        const repairInput = {
            operationId: operation.id,
            action: "bind" as const,
            targetDeploymentId: target,
            attested: true,
        };
        expect(await code(supersedeOperation(testDb.db, dataDir, repairInput))).toBe("conflict");
        const seen: PromotionReadback = {
            ...authority,
            route: {
                aliasId: bad.alias.id,
                hostname: bad.alias.hostname,
                operationId: operation.id,
                generation: "8",
                target: { deploymentId: target, hostname: "wrong.sites.example.net" },
            },
        };
        const repair = { authority, readRoute: async () => seen };
        const deployment = await testDb.db
            .selectFrom("deployment")
            .select("hostname")
            .where("id", "=", target)
            .executeTakeFirstOrThrow();
        const route = {
            ...seen.route!,
            operationId: randomUUID(),
            target: { deploymentId: target, hostname: deployment.hostname },
        };
        for (const refused of [
            seen, // unexpected target hostname and conflicting recorded operation
            { ...seen, instanceId: randomUUID(), route },
            { ...seen, epoch: randomUUID(), route },
            { ...seen, route: { ...route, aliasId: randomUUID() } },
            { ...seen, route: { ...route, hostname: "wrong.sites.example.net" } },
            { ...seen, route: { ...route, operationId: operation.id } },
            { ...seen, route: { ...route, target: null } },
            {
                ...seen,
                route: { ...route, target: { ...route.target, deploymentId: randomUUID() } },
            },
        ]) {
            expect(
                await code(
                    supersedeOperation(testDb.db, dataDir, repairInput, {
                        ...repair,
                        readRoute: async () => refused,
                    }),
                ),
            ).toBe("conflict");
        }
        await expect(
            supersedeOperation(testDb.db, dataDir, repairInput, {
                ...repair,
                readRoute: async () => {
                    throw new Error("Router unavailable.");
                },
            }),
        ).rejects.toThrow("Router unavailable.");
        expect(await aliasRow(bad.alias.id)).toEqual(before);
        expect(await operations(bad.alias.id)).toMatchObject([
            { id: operation.id, status: "reconciliation-needed", superseded_by_operation_id: null },
        ]);
        seen.route = route;
        const fixed = await supersedeOperation(testDb.db, dataDir, repairInput, repair);
        expect(fixed.generation).toBe("9");
        expect(await aliasRow(bad.alias.id)).toMatchObject({
            state: "binding-uncertain",
            committed_generation: "0",
            reserved_generation: "9",
        });
        expect(await code(deleteDeployment(target))).toBe("conflict");
        const audit = await testDb.db
            .selectFrom("audit_event")
            .select("detail")
            .where("action", "=", "alias.operation-superseded")
            .where("target_id", "=", bad.alias.id)
            .executeTakeFirstOrThrow();
        expect(audit.detail).toContain(
            `observedGeneration=8;observedOperation=${route.operationId};observedTarget=${target}`,
        );
        const correction = await claim(bad.alias.id);
        expect(correction.token.id).toBe(fixed.operationId);
        await verifying(correction);
        expect(await finish(correction)).not.toBeNull();
        expect(await operations(bad.alias.id)).toMatchObject([
            { id: operation.id, status: "superseded" },
            { id: fixed.operationId, status: "succeeded" },
        ]);
    });

    it("repairs a withdrawal above the database counter and keeps the pin until verified", async () => {
        const { alias, ready } = await fixture();
        const target = await ready();
        await promote(alias.id, target, "0");
        const bound = await claim(alias.id);
        await verifying(bound);
        expect(await finish(bound)).not.toBeNull();
        const withdrawal = await withdraw(alias.id, "1");
        await testDb.db
            .updateTable("app_alias")
            .set({ reserved_generation: "4" })
            .where("id", "=", alias.id)
            .execute();
        expect(await claimPromotion(testDb.db, dataDir, "worker")).toEqual({
            kind: "reconciliation-needed",
            id: withdrawal.id,
        });
        const input = { operationId: withdrawal.id, action: "withdraw" as const, attested: true };
        expect(
            await code(
                supersedeOperation(testDb.db, dataDir, input, {
                    authority,
                    readRoute: async () => ({ ...authority, route: null }),
                }),
            ),
        ).toBe("conflict");
        const result = await supersedeOperation(testDb.db, dataDir, input, {
            authority,
            readRoute: async () => observation(bound),
        });
        expect(result.generation).toBe("5");
        expect(await aliasRow(alias.id)).toMatchObject({ state: "withdrawal-uncertain" });
        expect(await code(deleteDeployment(target))).toBe("conflict");
        const correction = await claim(alias.id);
        await verifying(correction);
        expect(await finish(correction)).not.toBeNull();
        expect(await unpinned(target)).toBeInstanceOf(Date);
        expect(await code(deleteDeployment(target))).toBe("ok");
    });

    describe("reconciling an ordinary hold with router evidence", () => {
        const hostnameOf = async (id: string) =>
            (
                await testDb.db
                    .selectFrom("deployment")
                    .select("hostname")
                    .where("id", "=", id)
                    .executeTakeFirstOrThrow()
            ).hostname;
        async function held(alias: { id: string }, run: () => Promise<{ id: string }>) {
            const operation = await run();
            const job = await claim(alias.id);
            expect(await dispatch(job.token)).not.toBeNull();
            expect(await holdPromotion(testDb.db, dataDir, job.token)).not.toBeNull();
            return operation;
        }
        const seen = async (
            alias: { id: string; hostname: string },
            route: { operationId: string; generation: string; target: string | null } | null,
        ): Promise<PromotionReadback> => {
            const target = route?.target
                ? { deploymentId: route.target, hostname: await hostnameOf(route.target) }
                : null;
            return {
                ...authority,
                route: route && {
                    aliasId: alias.id,
                    hostname: alias.hostname,
                    operationId: route.operationId,
                    generation: route.generation,
                    target,
                },
            };
        };
        const reconcile = async (
            operationId: string,
            input: { action: "bind" | "withdraw"; target?: string },
            readback: PromotionReadback,
        ) =>
            supersedeOperation(
                testDb.db,
                dataDir,
                {
                    operationId,
                    action: input.action,
                    targetDeploymentId: input.target,
                    attested: true,
                },
                { authority, readRoute: async () => readback },
            );
        const auditOf = async (aliasId: string) =>
            (
                await testDb.db
                    .selectFrom("audit_event")
                    .select("detail")
                    .where("action", "=", "alias.operation-superseded")
                    .where("target_id", "=", aliasId)
                    .orderBy("id", "desc")
                    .executeTakeFirstOrThrow()
            ).detail;

        // Hold everything before reconciling anything: a reconciled operation's correction is
        // queued, and the next claim takes the oldest runnable one.
        it("accepts a route the router committed, and one it never wrote", async () => {
            const committed = await fixture();
            const a = await committed.ready();
            const absent = await fixture();
            const b = await absent.ready();
            const op = await held(committed.alias, () => promote(committed.alias.id, a, "0"));
            const lost = await held(absent.alias, () => promote(absent.alias.id, b, "0"));

            const result = await reconcile(
                op.id,
                { action: "bind", target: a },
                await seen(committed.alias, { operationId: op.id, generation: "1", target: a }),
            );
            expect(result.generation).toBe("2");
            expect(await auditOf(committed.alias.id)).toContain("repair=router-verified");
            expect(await aliasRow(committed.alias.id)).toMatchObject({
                state: "binding-uncertain",
                reserved_generation: "2",
            });
            const next = await reconcile(
                lost.id,
                { action: "bind", target: b },
                await seen(absent.alias, null),
            );
            expect(next.generation).toBe("2");
        });

        it("repoints and withdraws with the router still showing the previous target", async () => {
            const { alias, ready } = await fixture();
            const a = await ready();
            const b = await ready();
            const other = await fixture();
            const c = await other.ready();
            for (const [aliasId, target] of [
                [alias.id, a],
                [other.alias.id, c],
            ] as const) {
                await promote(aliasId, target, "0");
                const bound = await claim(aliasId);
                await verifying(bound);
                expect(await finish(bound)).not.toBeNull();
            }
            const boundA = (await operations(alias.id))[0]!;
            const boundC = (await operations(other.alias.id))[0]!;
            const repoint = await held(alias, () => promote(alias.id, b, "1"));
            const withdrawal = await held(other.alias, () => withdraw(other.alias.id, "1"));

            const showsA = await seen(alias, {
                operationId: boundA.id,
                generation: "1",
                target: a,
            });
            expect(
                (await reconcile(repoint.id, { action: "bind", target: b }, showsA)).generation,
            ).toBe("3");
            const stillC = await seen(other.alias, {
                operationId: boundC.id,
                generation: "1",
                target: c,
            });
            expect(
                (await reconcile(withdrawal.id, { action: "withdraw" }, stillC)).generation,
            ).toBe("3");
            expect(await aliasRow(other.alias.id)).toMatchObject({ state: "withdrawal-uncertain" });
        });

        it("refuses evidence that disagrees with the held alias, changing nothing", async () => {
            const { alias, ready } = await fixture();
            const a = await ready();
            const outside = await ready();
            await promote(alias.id, a, "0");
            const bound = await claim(alias.id);
            await verifying(bound);
            expect(await finish(bound)).not.toBeNull();
            const b = await ready();
            const op = await held(alias, () => promote(alias.id, b, "1"));
            const before = {
                alias: await aliasRow(alias.id),
                operations: await operations(alias.id),
            };
            for (const readback of [
                await seen(alias, null), // committed generation is 1, so an empty route is wrong
                await seen(alias, { operationId: randomUUID(), generation: "1", target: outside }),
                await seen(alias, { operationId: bound.token.id, generation: "7", target: a }),
                await seen(alias, { operationId: op.id, generation: "9", target: b }),
            ]) {
                expect(await code(reconcile(op.id, { action: "bind", target: b }, readback))).toBe(
                    "conflict",
                );
            }
            expect(await aliasRow(alias.id)).toEqual(before.alias);
            expect(await operations(alias.id)).toEqual(before.operations);
        });
    });

    it("excludes managed rotation from router verification through commit", async () => {
        const { alias, ready } = await fixture();
        await promote(alias.id, await ready(), "0");
        const job = await claim(alias.id);
        await verifying(job);
        const hold = await holdAppLock(job.operation.app_id);
        let released = false;
        try {
            // Readback returns at once; finalization then waits for the row lock before commit.
            const finalized = finalizePromotion(
                testDb.db,
                dataDir,
                job.token,
                authority,
                async () => observation(job),
            );
            await waitForRowLockWait();
            await expect(
                withDeploymentRecoveryMaintenance(
                    testDb.db,
                    async () => {
                        throw new Error("Rotation entered before finalization committed.");
                    },
                    AbortSignal.timeout(100),
                ),
            ).rejects.toMatchObject({ name: "TimeoutError" });
            released = true;
            await hold.release();
            expect(await finalized).toEqual({ id: job.token.id });
        } finally {
            if (!released) await hold.release();
        }
        await withDeploymentRecoveryMaintenance(testDb.db, async (connection) => {
            expect(
                await connection
                    .selectFrom("app_alias")
                    .select("committed_generation")
                    .where("id", "=", alias.id)
                    .executeTakeFirst(),
            ).toEqual({ committed_generation: "1" });
        });
    });

    it("refuses mismatched authority, operation, generation, or target readback", async () => {
        const { alias, ready } = await fixture();
        const target = await ready();
        await promote(alias.id, target, "0");
        const job = await claim(alias.id);
        await verifying(job);
        const seen = observation(job);
        const route = seen.route!;
        const before = await operations(alias.id);
        for (const mismatch of [
            { ...seen, epoch: randomUUID() },
            { ...seen, instanceId: randomUUID() },
            { ...seen, route: null },
            { ...seen, route: { ...route, aliasId: randomUUID() } },
            { ...seen, route: { ...route, hostname: "wrong.sites.example.net" } },
            { ...seen, route: { ...route, operationId: randomUUID() } },
            { ...seen, route: { ...route, generation: "2" } },
            { ...seen, route: { ...route, target: null } },
            {
                ...seen,
                route: {
                    ...route,
                    target: { deploymentId: target, hostname: "wrong.sites.example.net" },
                },
            },
        ]) {
            expect(await finish(job, mismatch)).toBeNull();
        }
        expect(await operations(alias.id)).toEqual(before);
        expect(await aliasRow(alias.id)).toMatchObject({
            state: "binding",
            committed_generation: "0",
        });
        expect(await finish(job)).not.toBeNull();
    });

    it("releases only the last pin and leaves a permanent withdrawal reservation", async () => {
        const { alias, app, ready } = await fixture();
        const other = await createAlias(
            testDb.db,
            people.dee!,
            org,
            app.id,
            { slug: "stable" },
            deps(),
        );
        const first = await ready();
        const next = await ready();
        for (const id of [alias.id, other.id]) {
            await promote(id, first, "0");
            const job = await claim(id);
            await verifying(job);
            expect(await finish(job)).not.toBeNull();
        }
        await promote(alias.id, next, "1");
        const repoint = await claim(alias.id);
        await verifying(repoint);
        expect(await finish(repoint)).not.toBeNull();
        expect(await unpinned(first)).toBeNull();
        expect(await code(deleteDeployment(first))).toBe("conflict");

        await withdraw(other.id, "1");
        const withdrawal = await claim(other.id);
        await verifying(withdrawal);
        expect(await finish(withdrawal)).not.toBeNull();
        expect(await unpinned(first)).toBeInstanceOf(Date);
        expect(await unpinned(next)).toBeNull();
        expect(await aliasRow(other.id)).toMatchObject({
            state: "withdrawn",
            target_deployment_id: null,
            committed_generation: "2",
        });
        expect(
            await testDb.db
                .selectFrom("hostname_reservation")
                .select(["hostname", "released_at"])
                .where("owner_id", "=", other.id)
                .executeTakeFirstOrThrow(),
        ).toEqual({
            hostname: other.hostname,
            released_at: expect.any(Date),
        });
        expect(await code(deleteDeployment(first))).toBe("ok");
    });

    it("commits the readback snapshot even if the caller reuses the reply object", async () => {
        const { alias, ready } = await fixture();
        const target = await ready();
        await promote(alias.id, target, "0");
        const job = await claim(alias.id);
        await verifying(job);
        const seen = observation(job);
        const hold = await holdAppLock(job.operation.app_id);
        let released = false;
        try {
            const finalized = finalizePromotion(
                testDb.db,
                dataDir,
                job.token,
                authority,
                async () => seen,
            );
            // Finalization has its snapshot and is still blocked before commit.
            await waitForRowLockWait();
            seen.epoch = randomUUID();
            seen.route!.target!.hostname = "different.sites.example.net";
            released = true;
            await hold.release();
            expect(await finalized).toEqual({ id: job.token.id });
        } finally {
            if (!released) await hold.release();
        }
        expect(await operations(alias.id)).toMatchObject([
            { observed_epoch: authority.epoch, observed_target_deployment_id: target },
        ]);
    });

    it("settles every ancestor only after the corrective tip is verified", async () => {
        const { alias, ready } = await fixture();
        const a = await ready();
        const b = await ready();
        await promote(alias.id, a, "0");
        const bound = await claim(alias.id);
        await verifying(bound);
        expect(await finish(bound)).not.toBeNull();
        await promote(alias.id, b, "1");
        const uncertain = await claim(alias.id);
        expect(await dispatch(uncertain.token)).not.toBeNull();
        expect(await holdPromotion(testDb.db, dataDir, uncertain.token)).not.toBeNull();
        const corrected = await supersedeOperation(testDb.db, dataDir, {
            operationId: uncertain.token.id,
            action: "bind",
            targetDeploymentId: a,
            attested: true,
        });
        const uncertainAgain = await claim(alias.id);
        expect(uncertainAgain.token.id).toBe(corrected.operationId);
        // A corrective operation is never failed outright: that would strand its held ancestors.
        expect(
            await failPromotion(testDb.db, dataDir, uncertainAgain.token, "router-refused", "x"),
        ).toBeNull();
        expect(await dispatch(uncertainAgain.token)).not.toBeNull();
        expect(await holdPromotion(testDb.db, dataDir, uncertainAgain.token)).not.toBeNull();
        await supersedeOperation(testDb.db, dataDir, {
            operationId: uncertainAgain.token.id,
            action: "bind",
            targetDeploymentId: a,
            attested: true,
        });
        const tip = await claim(alias.id);
        await verifying(tip);
        expect(await code(deleteDeployment(b))).toBe("conflict");
        expect(await finish(tip)).not.toBeNull();
        expect((await operations(alias.id)).filter((row) => row.status === "superseded")).toEqual(
            expect.arrayContaining(
                [uncertain, uncertainAgain].map(({ token }) =>
                    expect.objectContaining({
                        id: token.id,
                        observed_operation_id: tip.token.id,
                        observed_epoch: authority.epoch,
                    }),
                ),
            ),
        );
        expect(await aliasRow(alias.id)).toMatchObject({
            target_deployment_id: a,
            committed_generation: "4",
        });
        expect(await unpinned(b)).toBeInstanceOf(Date);
        expect(await unpinned(a)).toBeNull();
        expect(await code(deleteDeployment(b))).toBe("ok");
    });
});

describe("promotion intent", () => {
    beforeAll(setupDatabase);
    afterAll(teardownDatabase);
    it("queues a bind: reserves the next generation, pins the target and records the intent", async () => {
        const { alias, ready } = await fixture();
        const target = await ready();
        const operation = await promote(alias.id, target, "0");
        expect(operation).toMatchObject({
            aliasId: alias.id,
            action: "bind",
            status: "queued",
            generation: "1",
            expectedGeneration: "0",
            previousTargetDeploymentId: null,
            desiredTargetDeploymentId: target,
        });
        expect(await aliasRow(alias.id)).toMatchObject({
            state: "binding",
            reserved_generation: "1",
            committed_generation: "0",
            target_deployment_id: null,
        });
        // Nothing is committed, and the target cannot be deleted while the operation is open.
        expect(await code(deleteDeployment(target))).toBe("conflict");
        expect(
            (await listDeploymentEvents(testDb.db, people.vic!, org, target)).at(-1),
        ).toMatchObject({ phase: "promotion-requested" });
        expect(await listAliasOperations(testDb.db, people.vic!, org, alias.id)).toEqual([
            operation,
        ]);
        expect(
            await testDb.db
                .selectFrom("audit_event")
                .select("action")
                .where("target_id", "=", alias.id)
                .where("action", "=", "alias.promotion-requested")
                .executeTakeFirstOrThrow(),
        ).toBeDefined();
    });

    it("compare-and-swaps on the expected generation, with no side effect on a miss", async () => {
        const { alias, ready } = await fixture();
        const target = await ready();
        expect(await code(promote(alias.id, target, "5"))).toBe("conflict");
        expect(await operations(alias.id)).toEqual([]);
        expect(await aliasRow(alias.id)).toMatchObject({
            state: "unbound",
            reserved_generation: "0",
        });
    });

    it("accepts exactly one of several simultaneous requests", async () => {
        const { alias, ready } = await fixture();
        const targets = [await ready(), await ready()];
        const results = await Promise.all(
            targets.concat(targets).map((target) => code(promote(alias.id, target, "0"))),
        );
        expect(results.filter((result) => result === "ok")).toHaveLength(1);
        expect(results.filter((result) => result === "conflict")).toHaveLength(3);
        expect(await operations(alias.id)).toHaveLength(1);
        expect(await aliasRow(alias.id)).toMatchObject({ reserved_generation: "1" });
    });

    it("returns one operation to simultaneous retries with the same key", async () => {
        const { alias, ready } = await fixture();
        const target = await ready();
        const results = await Promise.all(
            [1, 2, 3].map(() => promote(alias.id, target, "0", "same-key")),
        );
        expect(new Set(results.map((result) => result.id)).size).toBe(1);
        expect(await operations(alias.id)).toHaveLength(1);
        expect(await aliasRow(alias.id)).toMatchObject({ reserved_generation: "1" });
    });

    it("lets exactly one of a promotion and a deletion of the same deployment win", async () => {
        const { alias, ready } = await fixture();
        const target = await ready();
        const [promotion, deletion] = await Promise.all([
            code(promote(alias.id, target, "0")),
            code(deleteDeployment(target)),
        ]);
        expect([promotion, deletion].toSorted()).toEqual(["conflict", "ok"]);
        expect((await operations(alias.id)).length === 0).toBe(deletion === "ok");
    });

    it("keys idempotency to the member who sent it", async () => {
        const { alias, ready } = await fixture();
        const target = await ready();
        const mine = await promote(alias.id, target, "0", "shared");
        // Another member's identical key is theirs: they never receive someone else's operation.
        expect(await code(promote(alias.id, target, "0", "shared", "ann"))).toBe("conflict");
        expect(await operations(alias.id)).toHaveLength(1);
        expect(mine.status).toBe("queued");
    });

    it("clears the target's last unpinned time and accepts an uppercase id", async () => {
        const { alias, ready } = await fixture();
        const target = await ready();
        await sql`update deployment set last_unpinned_at = now() where id = ${target}`.execute(
            testDb.db,
        );
        const operation = await promote(alias.id, target.toUpperCase(), "0");
        expect(operation.desiredTargetDeploymentId).toBe(target);
        expect(
            await testDb.db
                .selectFrom("deployment")
                .select("last_unpinned_at")
                .where("id", "=", target)
                .executeTakeFirstOrThrow(),
        ).toEqual({ last_unpinned_at: null });
    });

    it("retries idempotently, and refuses a different request under the same key", async () => {
        const { alias, ready } = await fixture();
        const target = await ready();
        const key = "retry-1";
        const first = await promote(alias.id, target, "0", key);
        // The alias has moved on (reserved 1), but the same key and payload return the first result.
        expect(await promote(alias.id, target, "0", key)).toEqual(first);
        expect(await operations(alias.id)).toHaveLength(1);
        expect(await aliasRow(alias.id)).toMatchObject({ reserved_generation: "1" });
        expect(await code(promote(alias.id, target, "1", key))).toBe("conflict");
        expect(await code(withdraw(alias.id, "0", key))).toBe("conflict");
        expect(await operations(alias.id)).toHaveLength(1);
        expect(await aliasRow(alias.id)).toMatchObject({
            reserved_generation: "1",
            state: "binding",
        });
        expect(
            await testDb.db
                .selectFrom("audit_event")
                .select("id")
                .where("target_id", "=", alias.id)
                .where("action", "like", "alias.%requested")
                .execute(),
        ).toHaveLength(1);
    });

    it("needs a valid Idempotency-Key", async () => {
        const { alias, ready } = await fixture();
        const target = await ready();
        for (const key of ["", "x".repeat(129), "has space"]) {
            expect(await code(promote(alias.id, target, "0", key))).toBe("invalid");
        }
        expect(
            await code(
                requestPromotion(
                    testDb.db,
                    people.dee!,
                    org,
                    alias.id,
                    { targetDeploymentId: target, expectedGeneration: "0" },
                    undefined,
                    deps(),
                ),
            ),
        ).toBe("invalid");
    });

    it("refuses ineligible targets and unstable aliases", async () => {
        const { alias, ready, app } = await fixture();
        const target = await ready();
        const other = await fixture();
        const foreign = await other.ready();
        expect(await code(promote(alias.id, foreign, "0"))).toBe("not-found");
        expect(await code(promote(alias.id, randomUUID(), "0"))).toBe("not-found");
        // Not succeeded: a fresh queued deployment.
        const queued = await createDeployment(
            testDb.db,
            people.dee!,
            org,
            app.id,
            { artifactId: await artifact() },
            deps(),
        );
        expect(await code(promote(alias.id, queued.id, "0"))).toBe("conflict");
        // Failed, not succeeded.
        await sql`update deployment set status = 'failed', finished_at = now() where id = ${queued.id}`.execute(
            testDb.db,
        );
        expect(await code(promote(alias.id, queued.id, "0"))).toBe("conflict");
        await promote(alias.id, target, "0");
        // The alias now has an operation in progress.
        expect(await code(promote(alias.id, target, "1"))).toBe("conflict");
        expect(await code(withdraw(alias.id, "1"))).toBe("conflict");
    });

    it("refuses a deployment that is being deleted, and one the alias already serves", async () => {
        const { alias, ready } = await fixture();
        const doomed = await ready();
        await deleteDeployment(doomed);
        expect(await code(promote(alias.id, doomed, "0"))).toBe("conflict");
        const target = await ready();
        await sql`update app_alias set state = 'bound', target_deployment_id = ${target},
            committed_generation = 1, reserved_generation = 1 where id = ${alias.id}`.execute(
            testDb.db,
        );
        expect(await code(promote(alias.id, target, "1"))).toBe("conflict");
    });

    it("keeps the previous target pinned while a repoint is open", async () => {
        const { alias, ready } = await fixture();
        const [current, next] = [await ready(), await ready()];
        await sql`update app_alias set state = 'bound', target_deployment_id = ${current},
            committed_generation = 3, reserved_generation = 3 where id = ${alias.id}`.execute(
            testDb.db,
        );
        const operation = await promote(alias.id, next, "3");
        expect(operation).toMatchObject({
            generation: "4",
            previousTargetDeploymentId: current,
            desiredTargetDeploymentId: next,
        });
        // `current` is pinned by the alias itself and `next` by the open operation.
        expect(await code(deleteDeployment(current))).toBe("conflict");
        expect(await code(deleteDeployment(next))).toBe("conflict");
    });

    it("refuses to delete a deployment an alias points at, and frees it once nothing uses it", async () => {
        const { alias, ready } = await fixture();
        const target = await ready();
        await sql`update app_alias set state = 'bound', target_deployment_id = ${target},
            committed_generation = 1, reserved_generation = 1 where id = ${alias.id}`.execute(
            testDb.db,
        );
        expect(await code(deleteDeployment(target))).toBe("conflict");
        await sql`update app_alias set state = 'withdrawn', target_deployment_id = null,
            committed_generation = 2, reserved_generation = 2 where id = ${alias.id}`.execute(
            testDb.db,
        );
        expect(await code(deleteDeployment(target))).toBe("ok");
    });

    it("withdraws an unbound alias", async () => {
        const { alias } = await fixture();
        const operation = await withdraw(alias.id, "0");
        expect(operation).toMatchObject({
            action: "withdraw",
            generation: "1",
            previousTargetDeploymentId: null,
        });
        expect(await aliasRow(alias.id)).toMatchObject({ state: "withdrawing" });
    });

    it("queues a withdrawal and refuses a withdrawn alias", async () => {
        const { alias, ready } = await fixture();
        const target = await ready();
        await sql`update app_alias set state = 'bound', target_deployment_id = ${target},
            committed_generation = 2, reserved_generation = 2 where id = ${alias.id}`.execute(
            testDb.db,
        );
        const operation = await withdraw(alias.id, "2");
        expect(operation).toMatchObject({
            action: "withdraw",
            generation: "3",
            previousTargetDeploymentId: target,
            desiredTargetDeploymentId: null,
        });
        expect(await aliasRow(alias.id)).toMatchObject({
            state: "withdrawing",
            reserved_generation: "3",
        });
        expect(await code(deleteDeployment(target))).toBe("conflict");
        await sql`update promotion_operation set status = 'succeeded', finished_at = now() where id = ${operation.id}`.execute(
            testDb.db,
        );
        await sql`update app_alias set state = 'withdrawn', target_deployment_id = null,
            committed_generation = 3 where id = ${alias.id}`.execute(testDb.db);
        expect(await code(withdraw(alias.id, "3"))).toBe("conflict");
    });

    it("fails closed at the last generation and keeps decimal strings", async () => {
        const { alias, ready } = await fixture();
        const target = await ready();
        const nearEnd = "9223372036854775806";
        await sql`update app_alias set reserved_generation = ${nearEnd}, committed_generation = 0
            where id = ${alias.id}`.execute(testDb.db);
        const last = await promote(alias.id, target, nearEnd);
        expect(last.generation).toBe("9223372036854775807");
        const rowsBefore = (await operations(alias.id)).length;
        expect(typeof last.generation).toBe("string");
        await sql`update promotion_operation set status = 'failed', finished_at = now() where id = ${last.id}`.execute(
            testDb.db,
        );
        await sql`update app_alias set state = 'unbound' where id = ${alias.id}`.execute(testDb.db);
        await expect(promote(alias.id, target, "9223372036854775807")).rejects.toThrow(
            /no generations left/,
        );
        expect((await operations(alias.id)).length).toBe(rowsBefore);
        expect(await code(promote(alias.id, target, "9223372036854775808"))).toBe("invalid");
    });

    it("needs the scope's role, the project and a switched-on instance", async () => {
        const { alias, ready } = await fixture();
        const target = await ready();
        expect(await code(promote(alias.id, target, "0", randomUUID(), "vic"))).toBe("forbidden");
        expect(await code(withdraw(alias.id, "0", randomUUID(), "vic"))).toBe("forbidden");
        expect(await code(promote(alias.id, target, "0", randomUUID(), "dee", [p2]))).toBe(
            "not-found",
        );
        expect(
            await code(
                promote(alias.id, target, "0", randomUUID(), "dee", undefined, {
                    LAUNCHPAD_ALIASES: "off",
                }),
            ),
        ).toBe("unavailable");
        expect(await code(promote("not-a-uuid", target, "0"))).toBe("not-found");
        expect(await operations(alias.id)).toEqual([]);
    });
});

describe("corrective operations", () => {
    beforeAll(setupDatabase);
    afterAll(teardownDatabase);
    // An alias bound to `previous`, with a repoint to `first` held for reconciliation.
    async function held() {
        const { alias, ready } = await fixture();
        const [previous, first] = [await ready(), await ready()];
        await sql`update app_alias set state = 'bound', target_deployment_id = ${previous},
            committed_generation = 1, reserved_generation = 1 where id = ${alias.id}`.execute(
            testDb.db,
        );
        const operation = await promote(alias.id, first, "1");
        await sql`update promotion_operation set status = 'reconciliation-needed' where id = ${operation.id}`.execute(
            testDb.db,
        );
        await sql`update app_alias set state = 'binding-uncertain' where id = ${alias.id}`.execute(
            testDb.db,
        );
        return { alias, previous, first, operation, ready };
    }
    const correct = (
        operationId: string,
        action: "bind" | "withdraw",
        targetDeploymentId?: string,
        attested = true,
    ) =>
        supersedeOperation(testDb.db, dataDir, {
            operationId,
            action,
            targetDeploymentId,
            attested,
        });
    const hold = (id: string) =>
        sql`update promotion_operation set status = 'reconciliation-needed' where id = ${id}`.execute(
            testDb.db,
        );

    it("blocks ordinary requests while an operation is held", async () => {
        const { alias, ready } = await held();
        const another = await ready();
        expect(await code(promote(alias.id, another, "2"))).toBe("conflict");
        expect(await code(withdraw(alias.id, "2"))).toBe("conflict");
    });

    it("takes a higher generation, links the chain and keeps every possible target pinned", async () => {
        const { alias, previous, first, operation } = await held();
        const result = await correct(operation.id, "bind", previous);
        expect(result).toMatchObject({ supersedes: operation.id, generation: "3" });
        const rows = await operations(alias.id);
        expect(rows.find((row) => row.id === operation.id)).toMatchObject({
            status: "reconciliation-needed",
            superseded_by_operation_id: result.operationId,
        });
        expect(rows.find((row) => row.id === result.operationId)).toMatchObject({
            status: "queued",
            supersedes_operation_id: operation.id,
            generation: "3",
            expected_generation: "2",
            idempotency_key: `correction ${operation.id}`,
        });
        // The alias keeps its uncertain state: finalization, not the request, decides the outcome.
        expect(await aliasRow(alias.id)).toMatchObject({
            state: "binding-uncertain",
            reserved_generation: "3",
            committed_generation: "1",
        });
        expect(await code(deleteDeployment(previous))).toBe("conflict");
        expect(await code(deleteDeployment(first))).toBe("conflict");
        expect(
            await testDb.db
                .selectFrom("promotion_operation")
                .select("id")
                .where("alias_id", "=", alias.id)
                .where("status", "in", ["queued", "applying", "verifying"])
                .where("superseded_by_operation_id", "is", null)
                .execute(),
        ).toHaveLength(1);
        expect(
            (
                await testDb.db
                    .selectFrom("audit_event")
                    .select("detail")
                    .where("action", "=", "alias.operation-superseded")
                    .where("target_id", "=", alias.id)
                    .executeTakeFirstOrThrow()
            ).detail,
        ).toContain(`new=${result.operationId}`);
        // A second correction of the same held operation is refused.
        expect(await code(correct(operation.id, "bind", first))).toBe("conflict");
    });

    it("keeps both targets pinned through two corrections in a row", async () => {
        const { alias, previous, first, operation } = await held();
        const second = await correct(operation.id, "bind", previous);
        await hold(second.operationId);
        const third = await correct(second.operationId, "bind", first);
        expect(third.generation).toBe("4");
        const rows = await operations(alias.id);
        expect(
            rows
                .map((row) => row.superseded_by_operation_id)
                .filter(Boolean)
                .toSorted(),
        ).toEqual([second.operationId, third.operationId].toSorted());
        expect(await code(deleteDeployment(previous))).toBe("conflict");
        expect(await code(deleteDeployment(first))).toBe("conflict");
    });

    it(
        "accepts an uppercase target and remembers every target of a chain past 100 links",
        { timeout: 90_000 },
        async () => {
            const { alias, previous, first, operation } = await held();
            let current = operation.id;
            // Many corrections back to the prior target: the original target must stay valid.
            for (let i = 0; i < 105; i += 1) {
                const next = await correct(current, "bind", previous.toUpperCase());
                await hold(next.operationId);
                current = next.operationId;
            }
            const last = await correct(current, "bind", first.toUpperCase());
            expect(last.generation).toBe("108");
            expect((await operations(alias.id)).length).toBe(107);
        },
    );

    it("permits only the outcomes the design allows", async () => {
        const { alias, first, operation, ready } = await held();
        const unrelated = await ready();
        // A held bind cannot be corrected to a withdrawal or to a deployment it never involved.
        expect(await code(correct(operation.id, "withdraw"))).toBe("invalid");
        expect(await code(correct(operation.id, "bind", unrelated))).toBe("invalid");
        expect(await code(correct(operation.id, "bind", randomUUID()))).toBe("invalid");
        expect(await operations(alias.id)).toHaveLength(1);
        expect(await code(correct(operation.id, "bind", first))).toBe("ok");
    });

    it("corrects a held withdrawal to another withdrawal or back to the prior target", async () => {
        const { alias, ready } = await fixture();
        const target = await ready();
        await sql`update app_alias set state = 'bound', target_deployment_id = ${target},
            committed_generation = 1, reserved_generation = 1 where id = ${alias.id}`.execute(
            testDb.db,
        );
        const operation = await withdraw(alias.id, "1");
        await hold(operation.id);
        await sql`update app_alias set state = 'withdrawal-uncertain' where id = ${alias.id}`.execute(
            testDb.db,
        );
        expect(await code(correct(operation.id, "bind", await ready()))).toBe("invalid");
        const back = await correct(operation.id, "bind", target);
        expect(back.generation).toBe("3");
        await hold(back.operationId);
        expect(await code(correct(back.operationId, "withdraw"))).toBe("ok");
    });

    it("needs the attestation, a held operation and a coherent request", async () => {
        const { alias, previous, operation } = await held();
        await expect(correct(operation.id, "bind", previous, false)).rejects.toThrow(/exact-route/);
        expect(await code(correct(operation.id, "bind"))).toBe("invalid");
        expect(await code(correct(operation.id, "withdraw", previous))).toBe("invalid");
        expect(await code(correct(randomUUID(), "withdraw"))).toBe("not-found");
        const other = await fixture();
        const target = await other.ready();
        const fresh = await promote(other.alias.id, target, "0");
        expect(await code(correct(fresh.id, "withdraw"))).toBe("conflict");
        expect(await operations(alias.id)).toHaveLength(1);
    });
});
