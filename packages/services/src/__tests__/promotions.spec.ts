import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDatabase } from "@launchpad-kit/database/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    addMember,
    createAlias,
    createApp,
    createDeployment,
    createOrganization,
    createProject,
    listAliasOperations,
    listDeploymentEvents,
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
} from "../index";
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
        .execute();
const deleteDeployment = (id: string) =>
    requestDeploymentDeletion(testDb.db, people.dee!, org, id, deps());

beforeAll(async () => {
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
});
afterAll(async () => {
    await testDb.destroy();
    await fs.rm(dataDir, { recursive: true, force: true });
});

describe("promotion intent", () => {
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
        const [a, b] = [await ready(), await ready().catch(() => null)];
        const targets = [a, b ?? a];
        const results = await Promise.all(
            targets.concat(targets).map((target) => code(promote(alias.id, target, "0"))),
        );
        expect(results.filter((result) => result === "ok")).toHaveLength(1);
        expect(await operations(alias.id)).toHaveLength(1);
        expect(await aliasRow(alias.id)).toMatchObject({ reserved_generation: "1" });
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
        // Being deleted.
        await sql`update deployment set status = 'failed' where id = ${queued.id}`.execute(
            testDb.db,
        );
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
        expect(typeof last.generation).toBe("string");
        await sql`update promotion_operation set status = 'failed', finished_at = now() where id = ${last.id}`.execute(
            testDb.db,
        );
        await sql`update app_alias set state = 'unbound' where id = ${alias.id}`.execute(testDb.db);
        expect(await code(promote(alias.id, target, "9223372036854775807"))).toBe("conflict");
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
    async function held() {
        const { alias, ready } = await fixture();
        const [first, second] = [await ready(), await ready()];
        const operation = await promote(alias.id, first, "0");
        await sql`update promotion_operation set status = 'reconciliation-needed' where id = ${operation.id}`.execute(
            testDb.db,
        );
        await sql`update app_alias set state = 'binding-uncertain' where id = ${alias.id}`.execute(
            testDb.db,
        );
        return { alias, first, second, operation };
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

    it("blocks ordinary requests while an operation is held", async () => {
        const { alias, second } = await held();
        expect(await code(promote(alias.id, second, "1"))).toBe("conflict");
        expect(await code(withdraw(alias.id, "1"))).toBe("conflict");
    });

    it("takes a higher generation, links the chain and keeps every possible target pinned", async () => {
        const { alias, first, second, operation } = await held();
        const result = await correct(operation.id, "bind", second);
        expect(result).toMatchObject({ supersedes: operation.id, generation: "2" });
        const rows = await operations(alias.id);
        expect(rows).toHaveLength(2);
        expect(rows.find((row) => row.id === operation.id)).toMatchObject({
            status: "reconciliation-needed",
            superseded_by_operation_id: result.operationId,
        });
        expect(rows.find((row) => row.id === result.operationId)).toMatchObject({
            status: "queued",
            supersedes_operation_id: operation.id,
            generation: "2",
            expected_generation: "1",
        });
        expect(await aliasRow(alias.id)).toMatchObject({ reserved_generation: "2" });
        // The held operation's target and the corrective one's both stay pinned.
        expect(await code(deleteDeployment(first))).toBe("conflict");
        expect(await code(deleteDeployment(second))).toBe("conflict");
        // Only one unfinished operation can be dispatched.
        expect(
            await testDb.db
                .selectFrom("promotion_operation")
                .select("id")
                .where("alias_id", "=", alias.id)
                .where("status", "in", ["queued", "applying", "verifying"])
                .where("superseded_by_operation_id", "is", null)
                .execute(),
        ).toHaveLength(1);
        // A second correction of the same held operation is refused.
        expect(await code(correct(operation.id, "withdraw"))).toBe("conflict");
    });

    it("needs the attestation, a held operation and a coherent request", async () => {
        const { alias, second, operation } = await held();
        await expect(correct(operation.id, "bind", second, false)).rejects.toThrow(/exact-route/);
        expect(await code(correct(operation.id, "bind"))).toBe("invalid");
        expect(await code(correct(operation.id, "withdraw", second))).toBe("invalid");
        expect(await code(correct(randomUUID(), "withdraw"))).toBe("not-found");
        const other = await fixture();
        const target = await other.ready();
        const fresh = await promote(other.alias.id, target, "0");
        expect(await code(correct(fresh.id, "withdraw"))).toBe("conflict");
        expect(await operations(alias.id)).toHaveLength(1);
    });
});
