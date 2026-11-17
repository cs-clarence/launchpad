import { randomUUID } from "node:crypto";
import { createTestDatabase } from "@launchpad/database/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    addMember,
    claimDeletion,
    claimNext,
    createOrganization,
    createPreview,
    createProject,
    DEFAULT_LIFECYCLE,
    enqueueDeployment,
    expirePreviews,
    getPreviewDeletion,
    MAX_DELETION_ATTEMPTS,
    OWNED_APP_PATTERN,
    removeMember,
    requestPreviewDeletion,
    resolveDeletion,
    runDeletion,
    runDeployment,
    ServiceError,
    StaleAttemptError,
    type DeletionClaim,
    type DeployPorts,
    type DeletionDeps,
    type LifecyclePorts,
    type Principal,
} from "../index";

let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
const people: Record<string, Principal> = {};
const deps = {
    previewDomain: "previews.example.com",
    maxPreviews: 10_000,
    lifecycle: DEFAULT_LIFECYCLE,
};
// No waiting between attempts in tests, except where a test is about the wait.
const on: DeletionDeps = { enabled: true, retryBackoffMs: () => 0 };
let org = "";
let otherOrg = "";
let project = "";
let counter = 0;

const code = (promise: Promise<unknown>) =>
    promise.then(
        () => "ok",
        (e) => (e instanceof ServiceError ? e.code : `unexpected: ${e}`),
    );

async function newUser(name: string) {
    const id = randomUUID();
    const role = name === "root" ? "operator" : "user";
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

beforeAll(async () => {
    testDb = await createTestDatabase();
    await testDb.migrate();
    for (const n of ["root", "ann", "ben", "dee", "vic", "zoe"]) await newUser(n);
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

const make = async () => {
    const preview = await createPreview(
        testDb.db,
        people.dee!,
        org,
        project,
        { slug: `p${++counter}` },
        deps,
    );
    const { app_name } = await testDb.db
        .selectFrom("preview")
        .select("app_name")
        .where("id", "=", preview.id)
        .executeTakeFirstOrThrow();
    return { id: preview.id, app: app_name };
};
const request = (id: string, who = "dee", organization = org) =>
    requestPreviewDeletion(testDb.db, people[who]!, organization, id, { enabled: true });
const preview = (id: string) =>
    testDb.db.selectFrom("preview").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const operation = (id: string) =>
    testDb.db
        .selectFrom("deletion_operation")
        .selectAll()
        .where("preview_id", "=", id)
        .orderBy("created_at", "desc")
        .executeTakeFirstOrThrow();

// The fake host: the apps that exist, every call in order, and what each may do.
function host(
    apps: string[],
    behaviour: {
        destroy?: (app: string, calls: number) => Promise<void> | void;
        exists?: (app: string, calls: number) => Promise<boolean | undefined> | boolean | undefined;
        images?: (tags: string[], calls: number) => Promise<void> | void;
    } = {},
) {
    const present = new Set(apps);
    const calls: string[] = [];
    const count = { exists: 0, destroy: 0, images: 0 };
    const ports: LifecyclePorts = {
        dokku: {
            apps: {
                exists: async (app) => {
                    calls.push(`exists:${app}`);
                    count.exists++;
                    const forced = await behaviour.exists?.(app, count.exists);
                    return forced ?? present.has(app);
                },
                destroy: async (app) => {
                    calls.push(`destroy:${app}`);
                    count.destroy++;
                    // The change happens first, so a failure after it is a success that
                    // was not reported.
                    present.delete(app);
                    await behaviour.destroy?.(app, count.destroy);
                },
            },
        },
        removeImages: async ({ imageTags }) => {
            calls.push(`images:${imageTags.join(",")}`);
            count.images++;
            await behaviour.images?.(imageTags, count.images);
        },
    };
    return { ports, calls, present, count };
}
const dokkuError = (kind: string) =>
    Object.assign(new Error(`dokku ${kind}`), { name: "DokkuError", kind });

const claim = async (owner = "w1", extra: Partial<DeletionDeps> = {}, leaseMs?: number) =>
    claimDeletion(testDb.db, owner, { ...on, ...extra }, leaseMs);
const runAll = async (id: string, ports: LifecyclePorts, extra: Partial<DeletionDeps> = {}) => {
    const outcomes: string[] = [];
    for (let i = 0; i < 12; i++) {
        const next = await claim("w1", extra);
        if (!next || next.previewId !== id) {
            if (next) await expireLease(next);
            if (!next) break;
            continue;
        }
        const outcome = await runDeletion(testDb.db, next, ports, { ...on, ...extra });
        outcomes.push(outcome);
        if (outcome !== "retry") break;
    }
    return outcomes;
};
const expireLease = (c: DeletionClaim) =>
    testDb.db
        .updateTable("deletion_operation")
        .set({ lease_expires_at: new Date(Date.now() - 1000) })
        .where("id", "=", c.operationId)
        .execute();
const drain = async (keep: string[] = []) => {
    // Other tests' operations must not be picked up by this one's claims.
    await testDb.db
        .updateTable("deletion_operation")
        .set({ status: "succeeded", finished_at: new Date() })
        .where("preview_id", "not in", keep.length ? keep : [randomUUID()])
        .where("status", "in", ["queued", "running", "reconciliation-needed"])
        .execute();
};

describe("requesting a deletion", () => {
    it("flips the preview to deleting and queues one operation, in one commit", async () => {
        const p = await make();
        const result = await request(p.id);
        expect(result.state).toBe("deleting");
        expect((await preview(p.id)).desired_state).toBe("deleting");
        expect(await operation(p.id)).toMatchObject({
            id: result.operationId,
            reason: "manual",
            status: "queued",
            requested_by: people.dee!.userId,
            attempt: 0,
        });
        const audit = await testDb.db
            .selectFrom("audit_event")
            .select("action")
            .where("target_id", "=", p.id)
            .where("action", "=", "preview.deletion-requested")
            .execute();
        expect(audit).toHaveLength(1);
    });

    it("repeats safely: the same operation comes back, even from concurrent requests", async () => {
        const p = await make();
        const results = await Promise.all([1, 2, 3, 4].map(() => request(p.id)));
        expect(new Set(results.map((r) => r.operationId)).size).toBe(1);
        const n = await testDb.db
            .selectFrom("deletion_operation")
            .select((eb) => eb.fn.countAll<string>().as("n"))
            .where("preview_id", "=", p.id)
            .executeTakeFirstOrThrow();
        expect(Number(n.n)).toBe(1);
    });

    it("needs the delete permission, and keeps organizations apart", async () => {
        const p = await make();
        expect(await code(request(p.id, "vic"))).toBe("forbidden");
        expect(await code(request(p.id, "zoe"))).toBe("not-found");
        expect(await code(request(p.id, "zoe", otherOrg))).toBe("not-found");
        expect(await code(request(randomUUID()))).toBe("not-found");
        expect(await code(request("nope"))).toBe("not-found");
        expect((await preview(p.id)).desired_state).toBe("active");
        expect(await code(request(p.id, "ben"))).toBe("ok");
    });

    it("cancels deployments that never started and refuses new ones", async () => {
        const p = await make();
        const artifact = await testDb.db
            .insertInto("artifact")
            .values({
                organization_id: org,
                digest: randomUUID().replaceAll("-", "").padEnd(64, "0"),
                size_bytes: 1,
                expanded_bytes: 1,
                entry_count: 1,
                storage_key: "x",
                created_by: people.dee!.userId,
            })
            .returning("id")
            .executeTakeFirstOrThrow();
        const queued = await enqueueDeployment(
            testDb.db,
            people.dee!,
            org,
            p.id,
            { artifactId: artifact.id },
            { enabled: true },
        );
        await request(p.id);
        const after = await testDb.db
            .selectFrom("deployment")
            .select(["status", "failure_code"])
            .where("id", "=", queued.id)
            .executeTakeFirstOrThrow();
        expect(after).toEqual({ status: "cancelled", failure_code: "preview-deleted" });
        expect(
            await code(
                enqueueDeployment(
                    testDb.db,
                    people.dee!,
                    org,
                    p.id,
                    { artifactId: artifact.id },
                    { enabled: true },
                ),
            ),
        ).toBe("conflict");
    });

    it("is not-found once the preview is gone, and refused for a member removed while it waited", async () => {
        const gone = await make();
        await testDb.db
            .updateTable("preview")
            .set({ desired_state: "deleted", deleted_at: new Date() })
            .where("id", "=", gone.id)
            .execute();
        expect(await code(request(gone.id))).toBe("not-found");

        await newUser("leaver2");
        await addMember(testDb.db, people.ann!, org, {
            email: "leaver2@example.com",
            role: "deployer",
        });
        const p = await make();
        let release!: () => void;
        let locked!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        const acquired = new Promise<void>((resolve) => (locked = resolve));
        const holder = testDb.db.transaction().execute(async (trx) => {
            await sql`select 1 from preview where id = ${p.id} for update`.execute(trx);
            locked();
            await held;
        });
        let waiting: Promise<string> | undefined;
        try {
            await Promise.race([acquired, holder]);
            waiting = code(request(p.id, "leaver2"));
            for (let i = 0; i < 250; i++) {
                const { rows } = await sql<{
                    n: string;
                }>`select count(*)::text as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`.execute(
                    testDb.db,
                );
                if (Number(rows[0]!.n) > 0) break;
                await new Promise((r) => setTimeout(r, 20));
            }
            await removeMember(testDb.db, people.ann!, org, people.leaver2!.userId);
        } finally {
            release();
            await holder;
        }
        expect(await waiting).toBe("not-found");
        expect((await preview(p.id)).desired_state).toBe("active");
    });
});

describe("asking for a deletion while the lifecycle is off", () => {
    it("is refused, leaving the preview as it was", async () => {
        const p = await make();
        expect(
            await code(
                requestPreviewDeletion(testDb.db, people.dee!, org, p.id, { enabled: false }),
            ),
        ).toBe("conflict");
        expect((await preview(p.id)).desired_state).toBe("active");
        const queued = await testDb.db
            .selectFrom("deletion_operation")
            .select("id")
            .where("preview_id", "=", p.id)
            .execute();
        expect(queued).toEqual([]);
        // Authorization still comes first: a stranger learns nothing about the setting.
        expect(
            await code(
                requestPreviewDeletion(testDb.db, people.zoe!, org, p.id, { enabled: false }),
            ),
        ).toBe("not-found");
    });
});

describe("repeating a deletion request while the lifecycle is off", () => {
    it("still answers one already queued, and finds not-found before the setting", async () => {
        const p = await make();
        const queued = await request(p.id);
        const off = await requestPreviewDeletion(testDb.db, people.dee!, org, p.id, {
            enabled: false,
        });
        expect(off.operationId).toBe(queued.operationId);
        expect(
            await code(
                requestPreviewDeletion(testDb.db, people.dee!, org, randomUUID(), {
                    enabled: false,
                }),
            ),
        ).toBe("not-found");
    });
});

describe("finding a preview's deletion", () => {
    it("returns the latest one, with its note, to a reader, and not-found to others", async () => {
        const p = await make();
        expect(await code(getPreviewDeletion(testDb.db, people.dee!, org, p.id))).toBe("not-found");
        const queued = await request(p.id);
        const found = await getPreviewDeletion(testDb.db, people.dee!, org, p.id);
        expect(found).toMatchObject({ id: queued.operationId, status: "queued", failure: null });
        await testDb.db
            .updateTable("deletion_operation")
            .set({ status: "succeeded", failure_code: "images-left-behind", failure_message: null })
            .where("id", "=", queued.operationId)
            .execute();
        // A success can carry a note, and the message falls back to a fixed text.
        expect(await getPreviewDeletion(testDb.db, people.dee!, org, p.id)).toMatchObject({
            status: "succeeded",
            failure: { code: "images-left-behind", message: expect.any(String) },
        });
        expect(await code(getPreviewDeletion(testDb.db, people.zoe!, org, p.id))).toBe("not-found");
        expect(await code(getPreviewDeletion(testDb.db, people.dee!, org, "x"))).toBe("not-found");
    });
});

describe("a name after its preview is gone", () => {
    it("can be used again once the preview is deleted, but not while it is being deleted", async () => {
        const p = await make();
        const slug = (await preview(p.id)).slug;
        const again = () => createPreview(testDb.db, people.dee!, org, project, { slug }, deps);
        expect(await code(again())).toBe("conflict");
        await request(p.id);
        expect(await code(again())).toBe("conflict");
        await drain();
        await testDb.db
            .updateTable("preview")
            .set({ desired_state: "deleted", deleted_at: new Date() })
            .where("id", "=", p.id)
            .execute();
        const second = await again();
        expect(second.id).not.toBe(p.id);
        expect(second.slug).toBe(slug);
        // The old row stays, with its own generated names, and two live ones still cannot share.
        expect(await code(again())).toBe("conflict");
        const rows = await testDb.db
            .selectFrom("preview")
            .select(["id", "app_name", "hostname"])
            .where("slug", "=", slug)
            .where("project_id", "=", project)
            .execute();
        expect(rows).toHaveLength(2);
        expect(new Set(rows.map((r) => r.app_name)).size).toBe(2);
        expect(new Set(rows.map((r) => r.hostname)).size).toBe(2);
    });
});

describe("claiming a deletion", () => {
    it("does nothing while the feature is off, and hands one operation to one worker", async () => {
        await drain();
        const p = await make();
        await request(p.id);
        expect(await claimDeletion(testDb.db, "w1", { enabled: false })).toBeNull();
        const claims = await Promise.all([claim("a"), claim("b"), claim("c")]);
        expect(claims.filter(Boolean)).toHaveLength(1);
        expect(claims.find(Boolean)).toMatchObject({
            previewId: p.id,
            attempt: 1,
            stepDone: null,
            stepPending: null,
        });
        expect(await claim("d")).toBeNull();
    });

    it("waits for a running deployment to finish, but not for one held for reconciliation", async () => {
        await drain();
        const p = await make();
        const artifact = await testDb.db
            .insertInto("artifact")
            .values({
                organization_id: org,
                digest: randomUUID().replaceAll("-", "").padEnd(64, "0"),
                size_bytes: 1,
                expanded_bytes: 1,
                entry_count: 1,
                storage_key: "x",
                created_by: people.dee!.userId,
            })
            .returning("id")
            .executeTakeFirstOrThrow();
        const d = await enqueueDeployment(
            testDb.db,
            people.dee!,
            org,
            p.id,
            { artifactId: artifact.id },
            { enabled: true },
        );
        // It has started (so the deletion does not cancel it) before the deletion is asked for.
        await testDb.db
            .updateTable("deployment")
            .set({ status: "building", attempt: 1 })
            .where("id", "=", d.id)
            .execute();
        await request(p.id);
        expect(await claim()).toBeNull();
        // Abandoned just now: its image load may still be running on the host, so wait.
        await testDb.db
            .updateTable("deployment")
            .set({ status: "reconciliation-needed", updated_at: new Date() })
            .where("id", "=", d.id)
            .execute();
        expect(await claim()).toBeNull();
        // Abandoned long ago: the destroy is what puts the host right.
        await testDb.db
            .updateTable("deployment")
            .set({ updated_at: new Date(Date.now() - 2 * 3_600_000) })
            .where("id", "=", d.id)
            .execute();
        expect(await claim()).toMatchObject({ previewId: p.id });
    });

    it("closes a deployment that was held for an administrator when the deletion finishes, by either way", async () => {
        for (const resolution of ["run", "resolved"] as const) {
            await drain();
            const p = await make();
            const artifact = await testDb.db
                .insertInto("artifact")
                .values({
                    organization_id: org,
                    digest: randomUUID().replaceAll("-", "").padEnd(64, "0"),
                    size_bytes: 1,
                    expanded_bytes: 1,
                    entry_count: 1,
                    storage_key: "x",
                    created_by: people.dee!.userId,
                })
                .returning("id")
                .executeTakeFirstOrThrow();
            const d = await enqueueDeployment(
                testDb.db,
                people.dee!,
                org,
                p.id,
                { artifactId: artifact.id },
                { enabled: true },
            );
            await testDb.db
                .updateTable("deployment")
                .set({
                    status: "reconciliation-needed",
                    attempt: 1,
                    updated_at: new Date(Date.now() - 2 * 3_600_000),
                })
                .where("id", "=", d.id)
                .execute();
            const requested = await request(p.id);
            if (resolution === "run") {
                const fake = host([p.app]);
                expect(await runAll(p.id, fake.ports)).toEqual(["succeeded"]);
            } else {
                await testDb.db
                    .updateTable("deletion_operation")
                    .set({ status: "reconciliation-needed" })
                    .where("id", "=", requested.operationId)
                    .execute();
                await resolveDeletion(
                    testDb.db,
                    people.ann!,
                    org,
                    requested.operationId,
                    "deleted",
                );
            }
            expect((await preview(p.id)).desired_state).toBe("deleted");
            const after = await testDb.db
                .selectFrom("deployment")
                .select(["status", "failure_code"])
                .where("id", "=", d.id)
                .executeTakeFirstOrThrow();
            expect(after, resolution).toEqual({
                status: "failed",
                failure_code: "preview-deleted",
            });
            // The audit record names what was closed.
            const audit = await testDb.db
                .selectFrom("audit_event")
                .select("detail")
                .where("action", "=", "preview.deleted")
                .where("target_id", "=", p.id)
                .executeTakeFirstOrThrow();
            expect(JSON.parse(audit.detail!).closedDeployments).toEqual([d.id]);
            // A deleted preview takes no deployment, and is not found: it is gone, not going.
            expect(
                await code(
                    enqueueDeployment(
                        testDb.db,
                        people.dee!,
                        org,
                        p.id,
                        { artifactId: artifact.id },
                        { enabled: true },
                    ),
                ),
            ).toBe("not-found");
        }
    });

    it("takes over an operation whose worker died, counting the attempt", async () => {
        await drain();
        const p = await make();
        await request(p.id);
        const first = (await claim("w1"))!;
        expect(first.attempt).toBe(1);
        expect(await claim("w2")).toBeNull();
        await expireLease(first);
        const second = (await claim("w2"))!;
        expect(second).toMatchObject({ previewId: p.id, attempt: 2, owner: "w2" });
    });

    it("holds an operation abandoned too many times for a person", async () => {
        await drain();
        const p = await make();
        await request(p.id);
        for (let i = 0; i < MAX_DELETION_ATTEMPTS; i++) {
            const c = (await claim("w1"))!;
            expect(c.attempt).toBe(i + 1);
            await expireLease(c);
        }
        expect(await claim("w1")).toBeNull();
        expect(await operation(p.id)).toMatchObject({
            status: "reconciliation-needed",
            failure_code: "too-many-attempts",
        });
        expect((await preview(p.id)).desired_state).toBe("deleting");
    });
});

describe("running a deletion", () => {
    it("destroys the app, removes its images by recorded tag, and marks the preview deleted", async () => {
        await drain();
        const p = await make();
        const artifact = await testDb.db
            .insertInto("artifact")
            .values({
                organization_id: org,
                digest: randomUUID().replaceAll("-", "").padEnd(64, "0"),
                size_bytes: 1,
                expanded_bytes: 1,
                entry_count: 1,
                storage_key: "x",
                created_by: people.dee!.userId,
            })
            .returning("id")
            .executeTakeFirstOrThrow();
        const d = await enqueueDeployment(
            testDb.db,
            people.dee!,
            org,
            p.id,
            { artifactId: artifact.id },
            { enabled: true },
        );
        await testDb.db
            .updateTable("deployment")
            .set({ status: "succeeded", image_tag: "lp-image:one", finished_at: new Date() })
            .where("id", "=", d.id)
            .execute();
        await request(p.id);
        const fake = host([p.app, "someone-elses-app"]);
        expect(await runAll(p.id, fake.ports)).toEqual(["succeeded"]);
        expect(fake.calls).toEqual([`exists:${p.app}`, `destroy:${p.app}`, "images:lp-image:one"]);
        expect(fake.present.has("someone-elses-app")).toBe(true);
        expect(await preview(p.id)).toMatchObject({ desired_state: "deleted" });
        expect((await preview(p.id)).deleted_at).toBeInstanceOf(Date);
        expect(await operation(p.id)).toMatchObject({
            status: "succeeded",
            step_done: "images",
            step_pending: null,
            lease_owner: null,
        });
        const audit = await testDb.db
            .selectFrom("audit_event")
            .select("actor")
            .where("target_id", "=", p.id)
            .where("action", "=", "preview.deleted")
            .execute();
        expect(audit).toEqual([{ actor: "system" }]);
        // Gone from reads, and its name stays taken.
        const taken = await testDb.db
            .selectFrom("preview")
            .select("app_name")
            .where("app_name", "=", p.app)
            .execute();
        expect(taken).toHaveLength(1);
    });

    it("does not destroy an app that is already gone", async () => {
        await drain();
        const p = await make();
        await request(p.id);
        const fake = host([]);
        expect(await runAll(p.id, fake.ports)).toEqual(["succeeded"]);
        expect(fake.calls[0]).toBe(`exists:${p.app}`);
        expect(fake.calls.some((c) => c.startsWith("destroy"))).toBe(false);
        expect((await preview(p.id)).desired_state).toBe("deleted");
    });

    it("never calls Dokku for an app that is not of the owned kind", async () => {
        await drain();
        const p = await make();
        await request(p.id);
        const fake = host([p.app]);
        const guarded = { ownedApp: /^lp-test-[a-z0-9]{6}$/ };
        expect(await runAll(p.id, fake.ports, guarded)).toEqual(["reconciliation-needed"]);
        expect(fake.calls).toEqual([]);
        expect(await operation(p.id)).toMatchObject({
            status: "reconciliation-needed",
            failure_code: "not-owned",
        });
        expect(fake.present.has(p.app)).toBe(true);
        expect((await preview(p.id)).desired_state).toBe("deleting");
        // Production's pattern is the generated one, and nothing else.
        expect(OWNED_APP_PATTERN.test(p.app)).toBe(true);
        for (const foreign of [
            "view-demo",
            "lp-test-abc123",
            "lp-ABCDEFGHIJ",
            "lp-abc",
            "lp-abcdefghijk",
            "x-lp-abcdefghij",
            "lp-abcdefghij\n",
        ]) {
            expect(OWNED_APP_PATTERN.test(foreign), foreign).toBe(false);
        }
    });

    it("recovers from a destroy that did not answer: it asks before it acts again", async () => {
        await drain();
        // The destroy worked but the answer was lost: the next attempt finds the app gone.
        const lost = await make();
        await request(lost.id);
        const a = host([lost.app], {
            destroy: (_app, n) => {
                if (n === 1) throw dokkuError("uncertain");
            },
        });
        expect(await runAll(lost.id, a.ports)).toEqual(["retry", "succeeded"]);
        expect(a.count.destroy).toBe(1);
        expect(a.count.exists).toBe(2);
        expect((await preview(lost.id)).desired_state).toBe("deleted");

        // The destroy did not happen: the next attempt destroys it.
        const failed = await make();
        await request(failed.id);
        const b = host([failed.app], {
            destroy: (app, n) => {
                if (n === 1) {
                    b.present.add(app);
                    throw dokkuError("failed");
                }
            },
        });
        expect(await runAll(failed.id, b.ports)).toEqual(["retry", "succeeded"]);
        expect(b.count.destroy).toBe(2);
    });

    it("waits between attempts, and is held for a person once the attempts run out", async () => {
        await drain();
        const p = await make();
        await request(p.id);
        const fake = host([p.app], {
            destroy: (app) => {
                fake.present.add(app);
                throw dokkuError("uncertain");
            },
        });
        const slow = { retryBackoffMs: () => 60_000 };
        const first = (await claim("w1", slow))!;
        expect(await runDeletion(testDb.db, first, fake.ports, { ...on, ...slow })).toBe("retry");
        // Not claimable until the wait has passed.
        expect(await claim("w1", slow)).toBeNull();
        await testDb.db
            .updateTable("deletion_operation")
            .set({ lease_expires_at: new Date(Date.now() - 1) })
            .where("preview_id", "=", p.id)
            .execute();

        const rest = await runAll(p.id, fake.ports);
        expect(rest.at(-1)).toBe("reconciliation-needed");
        expect(fake.count.destroy).toBe(MAX_DELETION_ATTEMPTS);
        expect(await operation(p.id)).toMatchObject({
            status: "reconciliation-needed",
            failure_code: "destroy-uncertain",
            lease_owner: null,
        });
        // Nothing runs it again by itself, and the preview is still being deleted.
        expect(await claim("w1")).toBeNull();
        expect((await preview(p.id)).desired_state).toBe("deleting");
    });

    it("waits out an unreachable host without using up the attempts", async () => {
        await drain();
        const p = await make();
        await request(p.id);
        let outage = MAX_DELETION_ATTEMPTS * 3;
        const fake = host([p.app], {
            exists: () => {
                if (outage-- > 0) throw dokkuError("not-started");
                return undefined;
            },
        });
        const outcomes: string[] = [];
        for (let i = 0; i < MAX_DELETION_ATTEMPTS * 12; i++) {
            const next = await claim();
            if (!next) {
                // Not claimable until the wait has passed: let it.
                await testDb.db
                    .updateTable("deletion_operation")
                    .set({ lease_expires_at: new Date(Date.now() - 1) })
                    .where("preview_id", "=", p.id)
                    .execute();
                continue;
            }
            const outcome = await runDeletion(testDb.db, next, fake.ports, on);
            outcomes.push(outcome);
            if (outcome !== "retry") break;
        }
        expect(outcomes.filter((o) => o === "retry").length).toBe(MAX_DELETION_ATTEMPTS * 3);
        expect(outcomes.at(-1)).toBe("succeeded");
        expect((await preview(p.id)).desired_state).toBe("deleted");
        expect(fake.count.destroy).toBe(1);
    });

    it("does not use up attempts when only the existence probe was uncertain", async () => {
        await drain();
        const p = await make();
        await request(p.id);
        const fake = host([p.app], {
            exists: () => {
                throw dokkuError("uncertain");
            },
        });
        let probes = 0;
        for (let i = 0; i < MAX_DELETION_ATTEMPTS + 2; i++) {
            // Let the retry delay pass, so every pass runs a probe.
            await testDb.db
                .updateTable("deletion_operation")
                .set({ lease_expires_at: new Date(Date.now() - 1) })
                .where("preview_id", "=", p.id)
                .execute();
            const next = (await claim())!;
            expect(next).toBeTruthy();
            expect(await runDeletion(testDb.db, next, fake.ports, on)).toBe("retry");
            probes++;
        }
        expect(probes).toBe(MAX_DELETION_ATTEMPTS + 2);
        expect((await operation(p.id)).attempt).toBe(0);
        expect(fake.count.destroy).toBe(0);
    });

    it("holds a preview that is not being deleted, sending nothing to Dokku", async () => {
        await drain();
        const p = await make();
        await request(p.id);
        const c = (await claim())!;
        // Something put it back (or never marked it): the operation has no business running.
        await testDb.db
            .updateTable("preview")
            .set({ desired_state: "active" })
            .where("id", "=", p.id)
            .execute();
        const fake = host([p.app]);
        expect(await runDeletion(testDb.db, c, fake.ports, on)).toBe("reconciliation-needed");
        expect(fake.calls).toEqual([]);
        expect(await operation(p.id)).toMatchObject({ failure_code: "unexpected-state" });
    });

    it("does not destroy twice when the lease is lost between asking and destroying", async () => {
        await drain();
        const p = await make();
        await request(p.id);
        let successorRan = false;
        const fake = host([p.app], {
            exists: async (_app, n) => {
                if (n !== 1) return undefined;
                // Between the answer and the destroy another worker takes over.
                await testDb.db
                    .updateTable("deletion_operation")
                    .set({ lease_expires_at: new Date(Date.now() - 1000) })
                    .where("preview_id", "=", p.id)
                    .execute();
                const successor = (await claim("w2"))!;
                expect(successor.attempt).toBe(2);
                successorRan = true;
                return undefined;
            },
        });
        const first = (await claim("w1"))!;
        // The first worker goes on to destroy (its own deadline has not passed), then its next
        // write is refused: it is stale, and the app is gone exactly once.
        expect(await runDeletion(testDb.db, first, fake.ports, on)).toBe("stale");
        expect(successorRan).toBe(true);
        expect(fake.count.destroy).toBe(1);
        const next = await testDb.db
            .selectFrom("deletion_operation")
            .selectAll()
            .where("preview_id", "=", p.id)
            .executeTakeFirstOrThrow();
        // The successor's claim is the live one, and it finishes without a second destroy.
        const successor: DeletionClaim = {
            operationId: next.id,
            organizationId: org,
            previewId: p.id,
            attempt: next.attempt,
            fence: next.fence,
            owner: "w2",
            leaseMs: 60_000,
            stepDone: next.step_done,
            stepPending: next.step_pending,
        };
        expect(await runDeletion(testDb.db, successor, fake.ports, on)).toBe("succeeded");
        expect(fake.count.destroy).toBe(1);
        expect((await preview(p.id)).desired_state).toBe("deleted");
    });

    it("does not retry a call Dokku refused before it ran", async () => {
        await drain();
        for (const kind of ["invalid-argument", "trust"]) {
            const p = await make();
            await request(p.id);
            const fake = host([p.app], {
                destroy: () => {
                    throw dokkuError(kind);
                },
            });
            expect(await runAll(p.id, fake.ports), kind).toEqual(["reconciliation-needed"]);
            expect(fake.count.destroy).toBe(1);
            expect(await operation(p.id)).toMatchObject({ failure_code: "destroy-rejected" });
            await drain();
        }
    });

    it("continues from the recorded step after a worker dies, never destroying twice", async () => {
        await drain();
        // Died after the destroy was recorded as intended, before the answer.
        const p = await make();
        await request(p.id);
        const first = (await claim("w1"))!;
        await testDb.db
            .updateTable("deletion_operation")
            .set({ status: "running", step_pending: "destroy" })
            .where("id", "=", first.operationId)
            .execute();
        await expireLease(first);
        const fake = host([]);
        expect(await runAll(p.id, fake.ports)).toEqual(["succeeded"]);
        expect(fake.count.destroy).toBe(0);

        // Died after the destroy finished: only the images remain.
        const q = await make();
        await request(q.id);
        const c = (await claim("w1"))!;
        await testDb.db
            .updateTable("deletion_operation")
            .set({ status: "running", step_done: "destroy", step_pending: "images" })
            .where("id", "=", c.operationId)
            .execute();
        await expireLease(c);
        const second = host([]);
        expect(await runAll(q.id, second.ports)).toEqual(["succeeded"]);
        expect(second.calls.every((call) => call.startsWith("images"))).toBe(true);
    });

    it("stops a stale worker before it touches Dokku, and lets the successor finish", async () => {
        await drain();
        const p = await make();
        await request(p.id);
        const slow = (await claim("old"))!;
        await expireLease(slow);
        const successor = (await claim("new"))!;
        expect(successor.attempt).toBe(2);
        const fake = host([p.app]);
        // The old worker wakes up after its lease was taken over.
        expect(await runDeletion(testDb.db, slow, fake.ports, on)).toBe("stale");
        expect(fake.calls).toEqual([]);
        expect(await runDeletion(testDb.db, successor, fake.ports, on)).toBe("succeeded");
        expect(fake.count.destroy).toBe(1);
    });

    it("refuses a stale worker's late write even after the successor finished", async () => {
        await drain();
        const p = await make();
        await request(p.id);
        const old = (await claim("old"))!;
        await expireLease(old);
        const next = (await claim("new"))!;
        const fake = host([p.app]);
        await runDeletion(testDb.db, next, fake.ports, on);
        expect(await runDeletion(testDb.db, old, fake.ports, on)).toBe("stale");
        expect(fake.count.destroy).toBe(1);
        expect((await preview(p.id)).desired_state).toBe("deleted");
    });

    it("stops starting work when its lease deadline has passed", async () => {
        await drain();
        const p = await make();
        await request(p.id);
        const c = (await claimDeletion(testDb.db, "w1", on, 10))!;
        await new Promise((r) => setTimeout(r, 60));
        const fake = host([p.app]);
        expect(await runDeletion(testDb.db, c, fake.ports, on)).toBe("stale");
        expect(fake.calls).toEqual([]);
    });

    it("finishes the deletion even if images cannot be removed, and says so", async () => {
        await drain();
        const p = await make();
        await request(p.id);
        const fake = host([p.app], {
            images: () => {
                throw new Error("docker is busy");
            },
        });
        const outcomes = await runAll(p.id, fake.ports);
        expect(outcomes.at(-1)).toBe("succeeded");
        expect(fake.count.destroy).toBe(1);
        expect(fake.count.images).toBe(MAX_DELETION_ATTEMPTS);
        expect(await operation(p.id)).toMatchObject({
            status: "succeeded",
            failure_code: "images-left-behind",
        });
        expect((await preview(p.id)).desired_state).toBe("deleted");
    });

    it("hands the operation on, untouched, when asked to shut down before it starts", async () => {
        await drain();
        const p = await make();
        await request(p.id);
        const c = (await claim("w1"))!;
        const stop = new AbortController();
        stop.abort();
        const fake = host([p.app]);
        expect(await runDeletion(testDb.db, c, fake.ports, on, { signal: stop.signal })).toBe(
            "stopped",
        );
        expect(fake.calls).toEqual([]);
        expect(await claim("w2")).toMatchObject({ previewId: p.id, attempt: 2 });
    });

    it("is what scheduled expiry runs too: an expired preview ends up deleted", async () => {
        await drain();
        const p = await make();
        await testDb.db
            .updateTable("preview")
            .set({ expires_at: new Date(Date.now() - 1000) })
            .where("id", "=", p.id)
            .execute();
        expect((await expirePreviews(testDb.db, { limit: 1000 })).claimed).toContain(p.id);
        const fake = host([p.app]);
        expect(await runAll(p.id, fake.ports)).toEqual(["succeeded"]);
        expect(await operation(p.id)).toMatchObject({
            reason: "expired",
            requested_by: null,
            status: "succeeded",
        });
        expect((await preview(p.id)).desired_state).toBe("deleted");
    });
});

describe("resolving a deletion held for a person", () => {
    const held = async () => {
        await drain();
        const p = await make();
        await request(p.id);
        const fake = host([p.app], {
            destroy: (app) => {
                fake.present.add(app);
                throw dokkuError("invalid-argument");
            },
        });
        await runAll(p.id, fake.ports);
        const op = await operation(p.id);
        expect(op.status).toBe("reconciliation-needed");
        return { p, op };
    };

    it("finishes the deletion when the app is confirmed gone", async () => {
        const { p, op } = await held();
        await resolveDeletion(testDb.db, people.ben!, org, op.id, "deleted");
        expect(await operation(p.id)).toMatchObject({
            status: "succeeded",
            failure_code: "resolved-deleted",
        });
        expect((await preview(p.id)).desired_state).toBe("deleted");
        const audit = await testDb.db
            .selectFrom("audit_event")
            .select("actor")
            .where("target_id", "=", p.id)
            .where("action", "=", "preview.deletion-resolved")
            .execute();
        expect(audit).toEqual([{ actor: `user:${people.ben!.userId}` }]);
    });

    it("runs it again from the start when the app is still there", async () => {
        const { p, op } = await held();
        await resolveDeletion(testDb.db, people.ben!, org, op.id, "retry");
        expect(await operation(p.id)).toMatchObject({
            status: "queued",
            attempt: 0,
            step_pending: null,
            step_done: null,
            failure_code: null,
        });
        const fake = host([p.app]);
        expect(await runAll(p.id, fake.ports)).toEqual(["succeeded"]);
        expect(fake.count.destroy).toBe(1);
    });

    it("keeps the fence going up when the retry budget is reset, so an old claim stays stale", async () => {
        await drain();
        const p = await make();
        await request(p.id);
        // An old claim that is never heard from again, while later attempts use up the budget.
        const old = (await claim("w1"))!;
        expect(old).toMatchObject({ attempt: 1, fence: 1 });
        await expireLease(old);
        const fake = host([p.app], {
            destroy: (app) => {
                fake.present.add(app);
                throw dokkuError("uncertain");
            },
        });
        const rest = await runAll(p.id, fake.ports);
        expect(rest.at(-1)).toBe("reconciliation-needed");
        const held = await operation(p.id);
        expect(held.fence).toBeGreaterThan(old.fence);
        await resolveDeletion(testDb.db, people.ben!, org, held.id, "retry");
        const reset = await operation(p.id);
        expect(reset).toMatchObject({ attempt: 0, fence: held.fence });
        // The same owner claims again and gets attempt 1 again, but a new fence.
        const fresh = (await claim("w1"))!;
        expect(fresh).toMatchObject({ attempt: 1 });
        expect(fresh.fence).toBeGreaterThan(held.fence);
        // The old claim has the same owner and the same attempt number as the new one: only
        // the fence tells them apart.
        const untouched = host([p.app]);
        expect(await runDeletion(testDb.db, old, untouched.ports, on)).toBe("stale");
        expect(untouched.calls).toEqual([]);
        expect(await runDeletion(testDb.db, fresh, untouched.ports, on)).toBe("succeeded");
    });

    it("refuses an administrator removed while the resolution waited for the locks", async () => {
        const { p, op } = await held();
        await newUser("leaver3");
        await addMember(testDb.db, people.ann!, org, {
            email: "leaver3@example.com",
            role: "admin",
        });
        let release!: () => void;
        let locked!: () => void;
        const hold = new Promise<void>((resolve) => (release = resolve));
        const acquired = new Promise<void>((resolve) => (locked = resolve));
        const holder = testDb.db.transaction().execute(async (trx) => {
            await sql`select 1 from preview where id = ${p.id} for update`.execute(trx);
            locked();
            await hold;
        });
        let waiting: Promise<string> | undefined;
        try {
            await Promise.race([acquired, holder]);
            waiting = code(resolveDeletion(testDb.db, people.leaver3!, org, op.id, "deleted"));
            // Past both pre-lock checks and stuck on the preview lock: only now is the
            // administrator removed.
            for (let i = 0; i < 250; i++) {
                const { rows } = await sql<{
                    n: string;
                }>`select count(*)::text as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`.execute(
                    testDb.db,
                );
                if (Number(rows[0]!.n) > 0) break;
                await new Promise((r) => setTimeout(r, 20));
            }
            await removeMember(testDb.db, people.ann!, org, people.leaver3!.userId);
        } finally {
            release();
            await holder;
        }
        expect(await waiting).toBe("not-found");
        expect((await operation(p.id)).status).toBe("reconciliation-needed");
        expect((await preview(p.id)).desired_state).toBe("deleting");
    });

    it("is for administrators, once, inside the organization", async () => {
        const { op } = await held();
        expect(await code(resolveDeletion(testDb.db, people.dee!, org, op.id, "deleted"))).toBe(
            "forbidden",
        );
        expect(await code(resolveDeletion(testDb.db, people.vic!, org, op.id, "deleted"))).toBe(
            "forbidden",
        );
        expect(
            await code(resolveDeletion(testDb.db, people.zoe!, otherOrg, op.id, "deleted")),
        ).toBe("not-found");
        expect(
            await code(resolveDeletion(testDb.db, people.ben!, org, op.id, "maybe" as never)),
        ).toBe("invalid");
        expect(
            await code(resolveDeletion(testDb.db, people.ben!, org, randomUUID(), "deleted")),
        ).toBe("not-found");
        expect(await code(resolveDeletion(testDb.db, people.ben!, org, "nope", "deleted"))).toBe(
            "not-found",
        );
        expect(await code(resolveDeletion(testDb.db, people.ben!, org, op.id, "deleted"))).toBe(
            "ok",
        );
        expect(await code(resolveDeletion(testDb.db, people.ben!, org, op.id, "deleted"))).toBe(
            "conflict",
        );
    });

    it("refuses an operation that is not held", async () => {
        await drain();
        const p = await make();
        const { operationId } = await request(p.id);
        expect(
            await code(resolveDeletion(testDb.db, people.ben!, org, operationId, "deleted")),
        ).toBe("conflict");
    });
});

describe("a deployment claimed just before the deletion", () => {
    it("stops as stale before any Dokku call, because the deletion cancelled it", async () => {
        await drain();
        const p = await make();
        const artifact = await testDb.db
            .insertInto("artifact")
            .values({
                organization_id: org,
                digest: randomUUID().replaceAll("-", "").padEnd(64, "0"),
                size_bytes: 1,
                expanded_bytes: 1,
                entry_count: 1,
                storage_key: "x",
                created_by: people.dee!.userId,
            })
            .returning("id")
            .executeTakeFirstOrThrow();
        await enqueueDeployment(
            testDb.db,
            people.dee!,
            org,
            p.id,
            { artifactId: artifact.id },
            { enabled: true },
        );
        // The worker has claimed it (still `queued`, with a lease) when the deletion arrives.
        const claimed = (await claimNext(testDb.db, "w1", { enabled: true }))!;
        expect(claimed).toBeTruthy();
        await request(p.id);
        let touched = 0;
        const dokku = new Proxy(
            {},
            {
                get: () => () => {
                    touched++;
                },
            },
        );
        const ports = {
            dokku,
            build: async () => {
                touched++;
                return { imageTag: "x" };
            },
            loadImage: async () => {
                touched++;
            },
            verify: async () => {
                touched++;
            },
            rollback: async () => {
                touched++;
            },
        } as unknown as DeployPorts;
        expect(await runDeployment(testDb.db, claimed, ports)).toBe("stale");
        expect(touched).toBe(0);
    });
});

describe("a deployment racing a deletion", () => {
    it("lets exactly one win on every preview, and never leaves a deployment that can start after the delete", async () => {
        await drain();
        const artifact = await testDb.db
            .insertInto("artifact")
            .values({
                organization_id: org,
                digest: randomUUID().replaceAll("-", "").padEnd(64, "0"),
                size_bytes: 1,
                expanded_bytes: 1,
                entry_count: 1,
                storage_key: "x",
                created_by: people.dee!.userId,
            })
            .returning("id")
            .executeTakeFirstOrThrow();
        const previews = [];
        for (let i = 0; i < 20; i++) previews.push(await make());
        const results = await Promise.all(
            previews.flatMap((p) => [
                enqueueDeployment(
                    testDb.db,
                    people.dee!,
                    org,
                    p.id,
                    { artifactId: artifact.id },
                    { enabled: true },
                ).then(
                    (d) => ({ id: p.id, kind: "deploy" as const, ok: true, deployment: d.id }),
                    (e) => ({
                        id: p.id,
                        kind: "deploy" as const,
                        ok: false,
                        error: e instanceof ServiceError ? e.code : String(e),
                    }),
                ),
                request(p.id).then(() => ({ id: p.id, kind: "delete" as const, ok: true })),
            ]),
        );
        for (const p of previews) {
            const deploy = results.find((r) => r.id === p.id && r.kind === "deploy") as {
                ok: boolean;
                error?: string;
                deployment?: string;
            };
            const rows = await testDb.db
                .selectFrom("deployment")
                .select(["id", "status"])
                .where("preview_id", "=", p.id)
                .execute();
            expect((await preview(p.id)).desired_state).toBe("deleting");
            // Either the deployment was refused, or it was queued first and then cancelled by
            // the delete: nothing queued survives the deletion.
            if (!deploy.ok) expect(deploy.error).toBe("conflict");
            expect(rows.filter((r) => r.status === "queued")).toEqual([]);
        }
    });
});
