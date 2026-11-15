import { randomUUID } from "node:crypto";
import { createDatabase } from "@launchpad/database";
import { createTestDatabase } from "@launchpad/database/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    addMember,
    claimNext,
    createOrganization,
    createPreview,
    createProject,
    deploymentsEnabled,
    enqueueDeployment,
    MAX_ATTEMPTS,
    resolveReconciliation,
    runDeployment,
    ServiceError,
    type Claim,
    type DeployPorts,
    type Principal,
} from "../index";

let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
const people: Record<string, Principal> = {};
const on = { enabled: true };
let org = "";
let otherOrg = "";
let project = "";

const code = (promise: Promise<unknown>) =>
    promise.then(
        () => "ok",
        (e) => (e instanceof ServiceError ? e.code : `unexpected: ${e}`),
    );

async function newUser(name: string, role: "user" | "operator" = "user") {
    const id = randomUUID();
    await testDb.db
        .insertInto("user")
        .values({ id, name, email: `${name}@example.com`, emailVerified: false, image: null, role })
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

async function artifactIn(organizationId: string, by: string) {
    return testDb.db
        .insertInto("artifact")
        .values({
            organization_id: organizationId,
            digest: randomUUID().replaceAll("-", "").padEnd(64, "0"),
            size_bytes: 10,
            expanded_bytes: 20,
            entry_count: 1,
            storage_key: "k",
            created_by: people[by]!.userId,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
}

let n = 0;
async function freshPreview() {
    const p = await createPreview(
        testDb.db,
        people.dee!,
        org,
        project,
        { slug: `p${n++}` },
        { previewDomain: "previews.example.com", maxPreviews: 1000 },
    );
    return p.id;
}
async function queue(previewId: string, who = "dee") {
    const artifact = await artifactIn(org, "dee");
    return enqueueDeployment(
        testDb.db,
        people[who]!,
        org,
        previewId,
        { artifactId: artifact.id },
        on,
    );
}

class FakeDokkuError extends Error {
    name = "DokkuError";
    constructor(readonly kind: string) {
        super(kind);
    }
}

interface Fake {
    calls: string[];
    ports: DeployPorts;
    existing: Set<string>;
    rolledBackTo?: string;
    failAt?: { call: string; error: Error };
    after?: Record<string, () => Promise<void> | void>;
}
function fake(db = testDb.db): Fake {
    const f: Fake = { calls: [], existing: new Set(), ports: undefined as never };
    const step = async (name: string) => {
        f.calls.push(name);
        if (f.failAt?.call === name) throw f.failAt.error;
    };
    const then = async (name: string) => f.after?.[name]?.();
    f.ports = {
        dokku: {
            apps: {
                exists: async (app) => {
                    await step("exists");
                    return f.existing.has(app);
                },
                create: async (app) => {
                    await step("create");
                    f.existing.add(app);
                    await then("create");
                },
            },
            domains: {
                set: async () => {
                    await step("domain");
                    await then("domain");
                },
            },
            ports: {
                set: async () => {
                    await step("ports");
                },
            },
        },
        build: async (c) => {
            await step("build");
            await then("build");
            return { imageTag: `lp/site:${c.deploymentId.slice(0, 8)}` };
        },
        loadImage: async () => {
            await step("load");
            await then("load");
        },
        verify: async () => {
            await step("verify");
        },
        rollback: async (_c, previous) => {
            await step("rollback");
            f.rolledBackTo = previous.deploymentId;
        },
    };
    void db;
    return f;
}

const state = (id: string) =>
    testDb.db
        .selectFrom("deployment")
        .select([
            "status",
            "attempt",
            "step_done",
            "step_pending",
            "failure_code",
            "lease_owner",
            "image_tag",
        ])
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
const active = async (previewId: string) =>
    (
        await testDb.db
            .selectFrom("preview")
            .select("active_deployment_id")
            .where("id", "=", previewId)
            .executeTakeFirstOrThrow()
    ).active_deployment_id;
const expire = (id: string) =>
    sql`update deployment set lease_expires_at = now() - interval '1 second' where id = ${id}`.execute(
        testDb.db,
    );

async function claimed(owner = "w1", leaseMs = 60_000): Promise<Claim> {
    const claim = await claimNext(testDb.db, owner, on, leaseMs);
    if (!claim) throw new Error("nothing to claim");
    return claim;
}
// Queued deployments from earlier tests must not be picked up by later ones.
async function drain() {
    await sql`update deployment set status = 'cancelled', finished_at = now(), lease_owner = null
        where status = 'queued'`.execute(testDb.db);
}

beforeAll(async () => {
    testDb = await createTestDatabase();
    await testDb.migrate();
    await newUser("root", "operator");
    for (const x of ["ann", "ben", "dee", "vic", "zoe"]) await newUser(x);
    const db = testDb.db;
    org = (
        await createOrganization(db, people.root!, {
            name: "Acme",
            slug: "acme",
            ownerEmail: "ann@example.com",
        })
    ).id;
    otherOrg = (
        await createOrganization(db, people.root!, {
            name: "Beta",
            slug: "beta",
            ownerEmail: "zoe@example.com",
        })
    ).id;
    await addMember(db, people.ann!, org, { email: "ben@example.com", role: "admin" });
    await addMember(db, people.ann!, org, { email: "dee@example.com", role: "deployer" });
    await addMember(db, people.ann!, org, { email: "vic@example.com", role: "viewer" });
    project = (await createProject(db, people.ann!, org, { name: "Site", slug: "site" })).id;
});
afterAll(async () => {
    await testDb.destroy();
});

describe("the feature flag", () => {
    it("is off unless explicitly on, and refuses nonsense", () => {
        expect(deploymentsEnabled(undefined)).toBe(false);
        expect(deploymentsEnabled("")).toBe(false);
        expect(deploymentsEnabled("off")).toBe(false);
        expect(deploymentsEnabled("on")).toBe(true);
        for (const bad of ["true", "1", "ON", "yes"])
            expect(() => deploymentsEnabled(bad)).toThrow();
    });
});

describe("queueing a deployment", () => {
    it("needs the deployer role, the flag, and an artifact of the same organization", async () => {
        const preview = await freshPreview();
        const artifact = await artifactIn(org, "dee");
        const foreign = await artifactIn(otherOrg, "zoe");
        const enq = (who: string, input: unknown, deps = on) =>
            enqueueDeployment(testDb.db, people[who]!, org, preview, input, deps);
        expect(await code(enq("vic", { artifactId: artifact.id }))).toBe("forbidden");
        expect(await code(enq("zoe", { artifactId: artifact.id }))).toBe("not-found");
        expect(await code(enq("dee", { artifactId: artifact.id }, { enabled: false }))).toBe(
            "conflict",
        );
        expect(await code(enq("dee", { artifactId: foreign.id }))).toBe("not-found");
        expect(await code(enq("dee", { artifactId: "nope" }))).toBe("invalid");
        expect(await code(enq("dee", { artifactId: artifact.id, spa: "yes" }))).toBe("invalid");
        const ok = await enq("dee", { artifactId: artifact.id, spa: true });
        expect(ok.status).toBe("queued");
        await drain();
    });

    it("allows one unfinished deployment per preview, even from concurrent requests", async () => {
        const preview = await freshPreview();
        const results = await Promise.all(Array.from({ length: 6 }, () => code(queue(preview))));
        expect(results.filter((r) => r === "ok")).toHaveLength(1);
        expect(results.filter((r) => r === "conflict")).toHaveLength(5);
        await drain();
    });

    it("refuses a preview that is being deleted", async () => {
        const preview = await freshPreview();
        await testDb.db
            .updateTable("preview")
            .set({ desired_state: "deleting" })
            .where("id", "=", preview)
            .execute();
        expect(await code(queue(preview))).toBe("conflict");
    });
});

describe("idempotency across previews", () => {
    it("lets only one of concurrent requests with the same key win, and keeps its binding", async () => {
        const [a, b] = [await freshPreview(), await freshPreview()];
        const artifact = await artifactIn(org, "dee");
        const enqueue = (preview: string) =>
            enqueueDeployment(
                testDb.db,
                people.dee!,
                org,
                preview,
                { artifactId: artifact.id },
                on,
                "shared-key",
            );
        const results = await Promise.allSettled([enqueue(a), enqueue(b)]);
        const ok = results.filter((r) => r.status === "fulfilled");
        const refused = results.filter((r) => r.status === "rejected");
        expect(ok).toHaveLength(1);
        expect(((refused[0] as PromiseRejectedResult).reason as ServiceError).code).toBe(
            "conflict",
        );
        // The first binding stands: repeating the winner's request returns its deployment.
        const winner = (ok[0] as PromiseFulfilledResult<{ id: string }>).value.id;
        const again = await enqueue(
            (
                await testDb.db
                    .selectFrom("deployment")
                    .select("preview_id")
                    .where("id", "=", winner)
                    .executeTakeFirstOrThrow()
            ).preview_id,
        );
        expect(again.id).toBe(winner);
        await drain();
    });
});

describe("running a deployment", () => {
    it("goes through every step in order and activates only at the end", async () => {
        const preview = await freshPreview();
        const d = await queue(preview);
        const f = fake();
        const claim = await claimed();
        expect(claim.attempt).toBe(1);
        expect(await runDeployment(testDb.db, claim, f.ports)).toBe("succeeded");
        expect(f.calls).toEqual(["exists", "create", "build", "domain", "ports", "load", "verify"]);
        expect(await state(d.id)).toMatchObject({
            status: "succeeded",
            step_pending: null,
            lease_owner: null,
        });
        expect((await state(d.id)).image_tag).toMatch(/^lp\/site:/);
        expect(await active(preview)).toBe(d.id);
        const events = await testDb.db
            .selectFrom("deployment_event")
            .select(["seq", "phase"])
            .where("deployment_id", "=", d.id)
            .orderBy("seq")
            .execute();
        expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
        expect(events.at(-1)!.phase).toBe("activate");
    });

    it("does not create an app that already exists, and keeps the previous deployment on failure", async () => {
        const preview = await freshPreview();
        const first = await queue(preview);
        const f = fake();
        await runDeployment(testDb.db, await claimed(), f.ports);
        expect(await active(preview)).toBe(first.id);

        const second = await queue(preview);
        f.calls.length = 0;
        f.failAt = { call: "build", error: new Error("boom: secret detail") };
        expect(await runDeployment(testDb.db, await claimed(), f.ports)).toBe("failed");
        expect(f.calls).toEqual(["exists", "build"]);
        const row = await state(second.id);
        expect(row).toMatchObject({
            status: "failed",
            failure_code: "build-failed",
            step_pending: null,
        });
        const text = JSON.stringify(
            await testDb.db
                .selectFrom("deployment_event")
                .selectAll()
                .where("deployment_id", "=", second.id)
                .execute(),
        );
        expect(text).not.toContain("secret detail");
        expect(await active(preview)).toBe(first.id);
        // The failure frees the preview for another deployment.
        expect(await code(queue(preview))).toBe("ok");
        await drain();
    });

    it("fails a deployment on a clear Dokku failure but holds the preview on an unclear load", async () => {
        const preview = await freshPreview();
        await queue(preview);
        const f = fake();
        f.failAt = { call: "domain", error: new FakeDokkuError("uncertain") };
        const claim = await claimed();
        expect(await runDeployment(testDb.db, claim, f.ports)).toBe("failed");
        expect(await state(claim.deploymentId)).toMatchObject({ failure_code: "dokku-uncertain" });

        const second = await queue(preview);
        const g = fake();
        g.failAt = { call: "load", error: new FakeDokkuError("failed") };
        // Even a reported failure of the load is held: it can come after the swap.
        expect(await runDeployment(testDb.db, await claimed(), g.ports)).toBe(
            "reconciliation-needed",
        );
        expect((await state(second.id)).failure_code).toBe("load-uncertain");
        await sql`update deployment set status = 'failed', finished_at = now() where id = ${second.id}`.execute(
            testDb.db,
        );
        const clean = await queue(preview);
        const k = fake();
        k.failAt = { call: "load", error: new FakeDokkuError("not-started") };
        expect(await runDeployment(testDb.db, await claimed(), k.ports)).toBe("failed");
        expect((await state(clean.id)).failure_code).toBe("dokku-not-started");

        const third = await queue(preview);
        const h = fake();
        h.failAt = { call: "load", error: new FakeDokkuError("uncertain") }; // timeout after success
        expect(await runDeployment(testDb.db, await claimed(), h.ports)).toBe(
            "reconciliation-needed",
        );
        expect(await state(third.id)).toMatchObject({
            status: "reconciliation-needed",
            failure_code: "load-uncertain",
            lease_owner: null,
        });
        // An unrecognised error during the load is just as uncertain.
        await sql`update deployment set status = 'failed', finished_at = now() where id = ${third.id}`.execute(
            testDb.db,
        );
        const fourth = await queue(preview);
        const i = fake();
        i.failAt = { call: "load", error: new Error("socket hung up") };
        expect(await runDeployment(testDb.db, await claimed(), i.ports)).toBe(
            "reconciliation-needed",
        );
        expect((await state(fourth.id)).status).toBe("reconciliation-needed");
        await sql`update deployment set status = 'failed', finished_at = now() where id = ${fourth.id}`.execute(
            testDb.db,
        );
    });
});

describe("failures after the image was loaded", () => {
    it("put the previous release back when the new one does not verify", async () => {
        for (const error of [
            new Error("probe failed"),
            new FakeDokkuError("uncertain"),
            new FakeDokkuError("not-started"),
        ]) {
            const preview = await freshPreview();
            const first = await queue(preview);
            await runDeployment(testDb.db, await claimed(), fake().ports);
            const d = await queue(preview);
            const f = fake();
            f.failAt = { call: "verify", error };
            expect(await runDeployment(testDb.db, await claimed(), f.ports)).toBe("failed");
            expect(f.calls.at(-1)).toBe("rollback");
            expect(f.rolledBackTo).toBe(first.id);
            expect(await state(d.id)).toMatchObject({
                status: "failed",
                failure_code: "verify-failed-rolled-back",
                step_pending: null,
            });
            // The previous release is still the active one, and the preview is free.
            expect(await active(preview)).toBe(first.id);
            expect(await code(queue(preview))).toBe("ok");
            await drain();
        }
    });

    it("give a rollback a longer lease than a single step, so it can finish", async () => {
        const preview = await freshPreview();
        await queue(preview);
        await runDeployment(testDb.db, await claimed(), fake().ports);
        const d = await queue(preview);
        const f = fake();
        f.failAt = { call: "verify", error: new Error("probe failed") };
        let remainingMs = 0;
        f.ports.rollback = async () => {
            const row = await testDb.db
                .selectFrom("deployment")
                .select(
                    sql<number>`extract(epoch from (lease_expires_at - clock_timestamp())) * 1000`.as(
                        "ms",
                    ),
                )
                .where("id", "=", d.id)
                .executeTakeFirstOrThrow();
            remainingMs = Number(row.ms);
        };
        expect(await runDeployment(testDb.db, await claimed("w", 60_000), f.ports)).toBe("failed");
        // More than the ordinary 60 s lease: it was extended to about two minutes.
        expect(remainingMs).toBeGreaterThan(90_000);
        await drain();
    });

    it("simply fail a first release that does not verify, with nothing to restore", async () => {
        const preview = await freshPreview();
        const d = await queue(preview);
        const f = fake();
        f.failAt = { call: "verify", error: new Error("probe failed") };
        expect(await runDeployment(testDb.db, await claimed(), f.ports)).toBe("failed");
        expect(f.calls).not.toContain("rollback");
        expect(await state(d.id)).toMatchObject({
            status: "failed",
            failure_code: "verify-failed",
        });
        expect(await active(preview)).toBeNull();
    });

    it("hold the preview when the rollback itself fails", async () => {
        const preview = await freshPreview();
        const first = await queue(preview);
        await runDeployment(testDb.db, await claimed(), fake().ports);
        const d = await queue(preview);
        const f = fake();
        f.failAt = { call: "verify", error: new Error("probe failed") };
        const original = f.ports.rollback;
        f.ports.rollback = async (...args) => {
            await original(...args);
            throw new Error("rollback load broke");
        };
        expect(await runDeployment(testDb.db, await claimed(), f.ports)).toBe(
            "reconciliation-needed",
        );
        expect(await state(d.id)).toMatchObject({
            status: "reconciliation-needed",
            failure_code: "rollback-failed",
        });
        expect(await active(preview)).toBe(first.id);
        expect(await code(queue(preview))).toBe("conflict");
        await resolveReconciliation(testDb.db, people.ben!, org, d.id, "failed");
    });

    it("hold a deployment whose worker stopped in the middle of a rollback", async () => {
        const preview = await freshPreview();
        const d = await queue(preview);
        await claimed("dead");
        await sql`update deployment set status = 'verifying', step_done = 'load', step_pending = 'rollback' where id = ${d.id}`.execute(
            testDb.db,
        );
        await expire(d.id);
        const f = fake();
        expect(await runDeployment(testDb.db, await claimed("w2"), f.ports)).toBe(
            "reconciliation-needed",
        );
        expect(f.calls).toEqual([]);
        await resolveReconciliation(testDb.db, people.ben!, org, d.id, "failed");
    });

    it("hold a rollback abandoned on its last attempt", async () => {
        const preview = await freshPreview();
        const d = await queue(preview);
        for (let i = 0; i < MAX_ATTEMPTS; i++) {
            await claimed(`w${i}`);
            await expire(d.id);
        }
        await sql`update deployment set status = 'verifying', step_done = 'load', step_pending = 'rollback' where id = ${d.id}`.execute(
            testDb.db,
        );
        expect(await claimNext(testDb.db, "last", on)).toBeNull();
        expect((await state(d.id)).status).toBe("reconciliation-needed");
        await resolveReconciliation(testDb.db, people.ben!, org, d.id, "failed");
    });

    it("stop and hand on a verify that a shutdown interrupted, without a rollback", async () => {
        const preview = await freshPreview();
        const d = await queue(preview);
        const controller = new AbortController();
        const f = fake();
        const original = f.ports.verify;
        f.ports.verify = async (...args) => {
            controller.abort();
            await original(...args);
            throw new Error("interrupted");
        };
        expect(
            await runDeployment(testDb.db, await claimed("w1"), f.ports, {
                signal: controller.signal,
            }),
        ).toBe("stopped");
        expect(f.calls).not.toContain("rollback");
        expect(await state(d.id)).toMatchObject({ step_pending: "verify", lease_owner: null });
        const next = await claimed("w2");
        const g = fake();
        g.existing = f.existing;
        expect(await runDeployment(testDb.db, next, g.ports)).toBe("succeeded");
        expect(g.calls).toEqual(["verify"]);
    });

    it("hold a deployment abandoned after the load on its last attempt", async () => {
        const preview = await freshPreview();
        const d = await queue(preview);
        for (let i = 0; i < MAX_ATTEMPTS; i++) {
            await claimed(`w${i}`);
            await expire(d.id);
        }
        await sql`update deployment set status = 'verifying', step_done = 'load', step_pending = 'verify' where id = ${d.id}`.execute(
            testDb.db,
        );
        expect(await claimNext(testDb.db, "last", on)).toBeNull();
        expect(await state(d.id)).toMatchObject({ status: "reconciliation-needed" });
        await resolveReconciliation(testDb.db, people.ben!, org, d.id, "failed");
    });

    it("roll back a resumed deployment whose verify then fails", async () => {
        const preview = await freshPreview();
        const d = await queue(preview);
        await claimed("dead");
        await sql`update deployment set status = 'verifying', step_done = 'load', step_pending = 'verify', image_tag = 'lp/site:x' where id = ${d.id}`.execute(
            testDb.db,
        );
        await expire(d.id);
        const f = fake();
        f.failAt = { call: "verify", error: new Error("down") };
        // A first release: nothing to restore, so it fails; the point is that a resumed
        // verify takes the same path as a fresh one.
        expect(await runDeployment(testDb.db, await claimed("w2"), f.ports)).toBe("failed");
        expect(await state(d.id)).toMatchObject({ failure_code: "verify-failed" });
    });
});

describe("the deadline and the shutdown request", () => {
    it("starts no further call once its deadline has passed", async () => {
        const preview = await freshPreview();
        const d = await queue(preview);
        const f = fake();
        // 80% of a 400 ms lease is 320 ms; the first call of `configure` takes longer.
        f.after = { domain: () => new Promise((resolve) => setTimeout(resolve, 380)) };
        const claim = await claimed("slow", 400);
        expect(await runDeployment(testDb.db, claim, f.ports)).toBe("stale");
        expect(f.calls).not.toContain("ports");
        expect(f.calls).not.toContain("load");
        expect((await state(d.id)).step_pending).toBe("configure");
        await sql`update deployment set status = 'cancelled', finished_at = now(), lease_owner = null where id = ${d.id}`.execute(
            testDb.db,
        );
    });

    it("on shutdown releases the lease and leaves the intent for a successor", async () => {
        const preview = await freshPreview();
        const d = await queue(preview);
        const controller = new AbortController();
        const f = fake();
        f.ports.build = async () => {
            controller.abort();
            throw new Error("interrupted by shutdown");
        };
        expect(
            await runDeployment(testDb.db, await claimed("w1"), f.ports, {
                signal: controller.signal,
            }),
        ).toBe("stopped");
        expect(await state(d.id)).toMatchObject({
            status: "building",
            step_pending: "build",
            lease_owner: null,
        });
        const next = await claimed("w2");
        expect(next.attempt).toBe(2);
        expect(await runDeployment(testDb.db, next, fake().ports)).toBe("succeeded");
    });

    it("does not even record a load intent once shutdown was requested", async () => {
        const preview = await freshPreview();
        const d = await queue(preview);
        const controller = new AbortController();
        const f = fake();
        f.after = { ports: () => controller.abort() };
        const original = f.ports.dokku.ports.set;
        f.ports.dokku.ports.set = async (...args) => {
            await original(...args);
            controller.abort();
        };
        expect(
            await runDeployment(testDb.db, await claimed("w1"), f.ports, {
                signal: controller.signal,
            }),
        ).toBe("stopped");
        expect(f.calls).not.toContain("load");
        expect(await state(d.id)).toMatchObject({
            step_done: "configure",
            step_pending: null,
            lease_owner: null,
        });
        const next = await claimed("w2");
        const g = fake();
        g.existing = f.existing;
        expect(await runDeployment(testDb.db, next, g.ports)).toBe("succeeded");
        expect(g.calls).toEqual(["load", "verify"]);
    });

    it("does not abort a load that is under way, and stops only claiming", async () => {
        const preview = await freshPreview();
        await queue(preview);
        const controller = new AbortController();
        const f = fake();
        let loadSignal: AbortSignal | undefined;
        f.ports.loadImage = async (_c, _t, signal) => {
            controller.abort();
            loadSignal = signal;
        };
        expect(
            await runDeployment(testDb.db, await claimed(), f.ports, { signal: controller.signal }),
        ).toBe("succeeded");
        expect(loadSignal?.aborted).toBe(false);
    });
});

describe("turning the feature off", () => {
    it("stops queued work from being claimed", async () => {
        const preview = await freshPreview();
        const d = await queue(preview);
        expect(await claimNext(testDb.db, "w", { enabled: false })).toBeNull();
        expect((await state(d.id)).status).toBe("queued");
        expect(await claimNext(testDb.db, "w", on)).not.toBeNull();
        await drain();
        await sql`update deployment set status = 'cancelled', finished_at = now(), lease_owner = null where id = ${d.id}`.execute(
            testDb.db,
        );
    });

    it("refuses an outcome that is not failed or succeeded", async () => {
        const preview = await freshPreview();
        const d = await queue(preview);
        const f = fake();
        f.failAt = { call: "load", error: new FakeDokkuError("uncertain") };
        await runDeployment(testDb.db, await claimed(), f.ports);
        for (const bad of ["queued", "building", "reconciliation-needed", ""]) {
            expect(
                await code(resolveReconciliation(testDb.db, people.ben!, org, d.id, bad as never)),
            ).toBe("invalid");
        }
        expect((await state(d.id)).status).toBe("reconciliation-needed");
        // An admin of another organization cannot reach it.
        expect(
            await code(resolveReconciliation(testDb.db, people.zoe!, otherOrg, d.id, "failed")),
        ).toBe("not-found");
        await resolveReconciliation(testDb.db, people.ben!, org, d.id, "failed");
    });
});

describe("reconciliation blocks the preview until a person decides", () => {
    it("refuses new deployments and is never claimed, and resolves only for admins", async () => {
        const preview = await freshPreview();
        const d = await queue(preview);
        const f = fake();
        f.failAt = { call: "load", error: new FakeDokkuError("uncertain") };
        await runDeployment(testDb.db, await claimed(), f.ports);
        expect(await code(queue(preview))).toBe("conflict");
        await expire(d.id);
        expect(await claimNext(testDb.db, "w2", on)).toBeNull();

        const resolve = (who: string, outcome: "failed" | "succeeded") =>
            code(resolveReconciliation(testDb.db, people[who]!, org, d.id, outcome));
        expect(await resolve("dee", "failed")).toBe("forbidden");
        expect(await resolve("vic", "failed")).toBe("forbidden");
        expect(await resolve("zoe", "failed")).toBe("not-found");
        expect(await resolve("ben", "succeeded")).toBe("ok");
        expect(await active(preview)).toBe(d.id);
        expect(await resolve("ben", "failed")).toBe("conflict");
        const audit = await testDb.db
            .selectFrom("audit_event")
            .select("detail")
            .where("action", "=", "deployment.reconciliation-resolved")
            .where("target_id", "=", d.id)
            .execute();
        expect(audit).toEqual([{ detail: "succeeded" }]);
        expect(await code(queue(preview))).toBe("ok");
        await drain();
    });
});

describe("a stale worker", () => {
    it("is fenced out after its lease passes, and its successor finishes the job", async () => {
        const preview = await freshPreview();
        const d = await queue(preview);
        const a = fake();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let reachedBuild!: () => void;
        const atBuild = new Promise<void>((resolve) => (reachedBuild = resolve));
        a.after = {
            build: async () => {
                reachedBuild();
                await gate;
            },
        };
        const claimA = await claimed("worker-a");
        const runA = runDeployment(testDb.db, claimA, a.ports);
        await atBuild;

        await expire(d.id);
        const claimB = await claimed("worker-b");
        expect(claimB.attempt).toBe(2);
        expect(claimB.stepPending).toBe("build");
        const b = fake();
        b.existing = a.existing;
        expect(await runDeployment(testDb.db, claimB, b.ports)).toBe("succeeded");

        release();
        expect(await runA).toBe("stale");
        // A made no Dokku call after it lost the lease; the image was loaded once, by B.
        expect(a.calls).toEqual(["exists", "create", "build"]);
        expect(b.calls.filter((c) => c === "load")).toHaveLength(1);
        expect(await state(d.id)).toMatchObject({ status: "succeeded", attempt: 2 });
        expect(await active(preview)).toBe(d.id);
    });

    it("cannot write once the deployment has finished or changed hands", async () => {
        const preview = await freshPreview();
        const d = await queue(preview);
        const claim = await claimed("w1");
        await expire(d.id);
        const next = await claimed("w2");
        expect(next.attempt).toBe(2);
        // The first holder's very first write is refused, and it calls Dokku not at all.
        const f = fake();
        expect(await runDeployment(testDb.db, claim, f.ports)).toBe("stale");
        expect(f.calls).toEqual([]);
        // A live lease also stops a second claimant.
        expect(await claimNext(testDb.db, "w3", on)).toBeNull();
        await sql`update deployment set status = 'cancelled', finished_at = now() where id = ${d.id}`.execute(
            testDb.db,
        );
        expect(await runDeployment(testDb.db, next, f.ports)).toBe("stale");
        expect(f.calls).toEqual([]);
    });

    it("hands one deployment to exactly one of several concurrent claimants", async () => {
        await drain();
        const preview = await freshPreview();
        await queue(preview);
        const claims = await Promise.all(
            Array.from({ length: 6 }, (_, i) => claimNext(testDb.db, `w${i}`, on)),
        );
        expect(claims.filter(Boolean)).toHaveLength(1);
        await drain();
        await sql`update deployment set status = 'cancelled', finished_at = now(), lease_owner = null where status = 'preparing' or lease_owner is not null`.execute(
            testDb.db,
        );
    });

    it("holds, rather than fails, a deployment abandoned during a load on its last attempt", async () => {
        const preview = await freshPreview();
        const d = await queue(preview);
        for (let i = 0; i < MAX_ATTEMPTS; i++) {
            await claimed(`w${i}`);
            await expire(d.id);
        }
        await sql`update deployment set status = 'deploying', step_done = 'configure', step_pending = 'load' where id = ${d.id}`.execute(
            testDb.db,
        );
        expect(await claimNext(testDb.db, "last", on)).toBeNull();
        expect(await state(d.id)).toMatchObject({
            status: "reconciliation-needed",
            failure_code: "load-uncertain",
        });
        expect(await code(queue(preview))).toBe("conflict");
        await resolveReconciliation(testDb.db, people.ben!, org, d.id, "failed");
    });

    it("gives up on a deployment abandoned too many times", async () => {
        const preview = await freshPreview();
        const d = await queue(preview);
        for (let i = 0; i < MAX_ATTEMPTS; i++) {
            const c = await claimed(`w${i}`);
            expect(c.attempt).toBe(i + 1);
            await expire(d.id);
        }
        expect(await claimNext(testDb.db, "last", on)).toBeNull();
        expect(await state(d.id)).toMatchObject({
            status: "failed",
            failure_code: "too-many-attempts",
        });
    });
});

describe("recovering from a worker that stopped mid-step", () => {
    it("re-runs an idempotent step recorded as in flight, from there on", async () => {
        const preview = await freshPreview();
        const d = await queue(preview);
        await claimed("dead");
        await sql`update deployment set status = 'deploying', step_done = 'build', step_pending = 'configure', image_tag = 'lp/site:x' where id = ${d.id}`.execute(
            testDb.db,
        );
        await expire(d.id);
        const claim = await claimed("w2");
        expect(claim).toMatchObject({ stepDone: "build", stepPending: "configure" });
        const f = fake();
        expect(await runDeployment(testDb.db, claim, f.ports)).toBe("succeeded");
        expect(f.calls).toEqual(["domain", "ports", "load", "verify"]);
    });

    it("never guesses about a load that was in flight", async () => {
        const preview = await freshPreview();
        const d = await queue(preview);
        await claimed("dead");
        await sql`update deployment set status = 'deploying', step_done = 'configure', step_pending = 'load' where id = ${d.id}`.execute(
            testDb.db,
        );
        await expire(d.id);
        const f = fake();
        expect(await runDeployment(testDb.db, await claimed("w2"), f.ports)).toBe(
            "reconciliation-needed",
        );
        expect(f.calls).toEqual([]);
        expect(await state(d.id)).toMatchObject({
            status: "reconciliation-needed",
            failure_code: "load-uncertain",
        });
        await resolveReconciliation(testDb.db, people.ben!, org, d.id, "failed");
    });

    it("loses the database after a change, and the successor re-checks rather than repeats it", async () => {
        const preview = await freshPreview();
        const d = await queue(preview);
        const workerDb = createDatabase(testDb.url, { max: 1 });
        const claim = await claimNext(workerDb, "doomed", on, 60_000);
        expect(claim).not.toBeNull();
        const a = fake();
        // The app is created, then this worker's database connection is lost before
        // it can record that.
        a.after = {
            create: async () => {
                await workerDb.destroy();
            },
        };
        await expect(runDeployment(workerDb, claim!, a.ports)).rejects.toThrow();
        expect(a.calls).toEqual(["exists", "create"]);
        expect(await state(d.id)).toMatchObject({
            status: "preparing",
            step_pending: "app",
            step_done: null,
        });

        await expire(d.id);
        const b = fake();
        b.existing = a.existing;
        expect(await runDeployment(testDb.db, await claimed("w2"), b.ports)).toBe("succeeded");
        // It found the app and did not create it again.
        expect(b.calls[0]).toBe("exists");
        expect(b.calls).not.toContain("create");
    });
});
