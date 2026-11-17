import { randomUUID } from "node:crypto";
import { createTestDatabase } from "@launchpad/database/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    addMember,
    createOrganization,
    createPreview,
    createProject,
    DEFAULT_LIFECYCLE,
    enqueueDeployment,
    expirePreviews,
    extendPreview,
    getPreview,
    removeMember,
    ServiceError,
    type LifecycleConfig,
    type Principal,
} from "../index";

let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
const people: Record<string, Principal> = {};
const DAY = 86_400_000;
const lifecycle: LifecycleConfig = { ...DEFAULT_LIFECYCLE, enabled: true };
const deps = { previewDomain: "previews.example.com", maxPreviews: 10_000, lifecycle };
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
    await testDb.db
        .insertInto("user")
        .values({
            id,
            name,
            email: `${name}@example.com`,
            emailVerified: false,
            image: null,
            role: name === "root" ? "operator" : "user",
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
    people[name] = { userId: id, instanceRole: name === "root" ? "operator" : "user" };
}

beforeAll(async () => {
    testDb = await createTestDatabase();
    await testDb.migrate();
    for (const n of ["root", "ann", "dee", "vic", "zoe"]) await newUser(n);
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
    await addMember(db, people.ann!, org, { email: "dee@example.com", role: "deployer" });
    await addMember(db, people.ann!, org, { email: "vic@example.com", role: "viewer" });
    project = (await createProject(db, people.ann!, org, { name: "Site", slug: "site" })).id;
});
afterAll(async () => {
    await testDb.destroy();
});

const make = (input: Record<string, unknown> = {}, extra: Partial<typeof deps> = {}) =>
    createPreview(
        testDb.db,
        people.dee!,
        org,
        project,
        { slug: `p${++counter}`, ...input },
        { ...deps, ...extra },
    );
const extend = (
    id: string,
    ttl: string,
    who = "dee",
    extra: Partial<typeof deps> = {},
    key?: string,
    organization = org,
) => extendPreview(testDb.db, people[who]!, organization, id, { ttl }, { ...deps, ...extra }, key);
const setExpiry = (id: string, at: Date | null) =>
    testDb.db.updateTable("preview").set({ expires_at: at }).where("id", "=", id).execute();
const row = (id: string) =>
    testDb.db.selectFrom("preview").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const ms = (date: Date | null) => (date ? date.getTime() : null);
const near = (value: number | null, expected: number, slack = 5_000) => {
    expect(value).not.toBeNull();
    expect(Math.abs(value! - expected)).toBeLessThan(slack);
};

describe("choosing a lifetime when a preview is created", () => {
    it("uses the default, an explicit lifetime, and records it on the preview", async () => {
        const byDefault = await make();
        near(ms(byDefault.expiresAt), Date.now() + 7 * DAY);
        const explicit = await make({ ttl: "24h" });
        near(ms(explicit.expiresAt), Date.now() + DAY);
        near(ms((await row(explicit.id)).expires_at), Date.now() + DAY);
        near(
            ms((await getPreview(testDb.db, people.dee!, org, explicit.id)).expiresAt),
            Date.now() + DAY,
        );
    });

    it("refuses a lifetime above the maximum, a bad one, and none unless allowed", async () => {
        expect(await code(make({ ttl: "31d" }))).toBe("invalid");
        expect(await code(make({ ttl: "30d" }))).toBe("ok");
        for (const bad of ["0d", "7", "-1d", "soon", ""]) {
            expect(await code(make({ ttl: bad })), bad).toBe("invalid");
        }
        expect(await code(make({ ttl: "none" }))).toBe("invalid");
        const never = await make(
            { ttl: "none" },
            { lifecycle: { ...lifecycle, allowNoExpiry: true } },
        );
        expect(never.expiresAt).toBeNull();
        // Omitted still means the default, even where none is allowed.
        const omitted = await make({}, { lifecycle: { ...lifecycle, allowNoExpiry: true } });
        near(ms(omitted.expiresAt), Date.now() + 7 * DAY);
    });

    it("treats the lifetime as part of an idempotent request", async () => {
        const key = `create-${randomUUID()}`;
        const slug = `idem${++counter}`;
        const first = await createPreview(
            testDb.db,
            people.dee!,
            org,
            project,
            { slug, ttl: "24h" },
            deps,
            key,
        );
        const again = await createPreview(
            testDb.db,
            people.dee!,
            org,
            project,
            { slug, ttl: "24h" },
            deps,
            key,
        );
        expect(again.id).toBe(first.id);
        expect(
            await code(
                createPreview(
                    testDb.db,
                    people.dee!,
                    org,
                    project,
                    { slug, ttl: "48h" },
                    deps,
                    key,
                ),
            ),
        ).toBe("conflict");
    });
});

describe("extending a preview", () => {
    it("adds to the current expiry, or to now when it has already passed", async () => {
        const p = await make({ ttl: "24h" });
        const before = ms((await row(p.id)).expires_at)!;
        await extend(p.id, "48h");
        near(ms((await row(p.id)).expires_at), before + 2 * DAY);
        // Overdue but not yet claimed: the extension counts from now, and rescues it.
        await setExpiry(p.id, new Date(Date.now() - 3 * DAY));
        const rescued = await extend(p.id, "2d");
        near(ms(rescued.expiresAt), Date.now() + 2 * DAY);
        expect((await row(p.id)).desired_state).toBe("active");
    });

    it("is capped at the maximum from now, and never shortens a lifetime", async () => {
        const p = await make({ ttl: "29d" });
        await extend(p.id, "20d");
        near(ms((await row(p.id)).expires_at), Date.now() + 30 * DAY);
        // An operator lowers the maximum below what the preview already has.
        const lowered = {
            lifecycle: { ...lifecycle, defaultTtlSeconds: 3600, maxTtlSeconds: 7 * 86_400 },
        };
        const before = ms((await row(p.id)).expires_at)!;
        const kept = await extend(p.id, "1d", "dee", lowered);
        expect(ms(kept.expiresAt)).toBe(before);
        expect(await code(extend(p.id, "8d", "dee", lowered))).toBe("invalid");
    });

    it("gives a preview with no expiry one, and removes one only where allowed", async () => {
        const never = await make(
            { ttl: "none" },
            { lifecycle: { ...lifecycle, allowNoExpiry: true } },
        );
        const given = await extend(never.id, "3d");
        near(ms(given.expiresAt), Date.now() + 3 * DAY);
        expect(await code(extend(never.id, "none"))).toBe("invalid");
        const removed = await extend(never.id, "none", "dee", {
            lifecycle: { ...lifecycle, allowNoExpiry: true },
        });
        expect(removed.expiresAt).toBeNull();
    });

    it("needs a positive lifetime and the deploy permission, inside its own organization", async () => {
        const p = await make();
        for (const bad of ["0d", "0s", "-1h", "1.5d", "x"]) {
            expect(await code(extend(p.id, bad)), bad).toBe("invalid");
        }
        expect(await code(extend(p.id, "1d", "vic"))).toBe("forbidden");
        expect(await code(extend(p.id, "1d", "zoe"))).toBe("not-found");
        expect(await code(extend(p.id, "1d", "zoe", {}, undefined, otherOrg))).toBe("not-found");
        expect(await code(extend(randomUUID(), "1d"))).toBe("not-found");
        expect(await code(extend("nope", "1d"))).toBe("not-found");
        expect(await code(extend(p.id, "1d", "ann"))).toBe("ok");
    });

    it("writes an audit event naming the change", async () => {
        const p = await make({ ttl: "24h" });
        await extend(p.id, "24h");
        const events = await testDb.db
            .selectFrom("audit_event")
            .select(["actor", "detail"])
            .where("target_id", "=", p.id)
            .where("action", "=", "preview.expiry-changed")
            .execute();
        expect(events).toHaveLength(1);
        expect(events[0]!.actor).toBe(`user:${people.dee!.userId}`);
        expect(events[0]!.detail).toContain("->");
    });

    it("does not extend twice for a repeated request, and refuses a changed one", async () => {
        const p = await make({ ttl: "24h" });
        const key = `extend-${randomUUID()}`;
        const first = await extend(p.id, "24h", "dee", {}, key);
        const again = await extend(p.id, "24h", "dee", {}, key);
        expect(ms(again.expiresAt)).toBe(ms(first.expiresAt));
        near(ms((await row(p.id)).expires_at), Date.now() + 2 * DAY);
        expect(await code(extend(p.id, "48h", "dee", {}, key))).toBe("conflict");
        // Concurrent repeats of one key extend once.
        const q = await make({ ttl: "24h" });
        const same = `extend-${randomUUID()}`;
        await Promise.all([1, 2, 3, 4].map(() => extend(q.id, "24h", "dee", {}, same)));
        near(ms((await row(q.id)).expires_at), Date.now() + 2 * DAY);
    });

    it("is refused once the preview is being deleted", async () => {
        const p = await make();
        await testDb.db
            .updateTable("preview")
            .set({ desired_state: "deleting" })
            .where("id", "=", p.id)
            .execute();
        expect(await code(extend(p.id, "1d"))).toBe("conflict");
    });

    it("answers a deleted preview as not found, and a replayed key whatever has happened since", async () => {
        const p = await make({ ttl: "24h" });
        const key = `extend-${randomUUID()}`;
        const first = await extend(p.id, "24h", "dee", {}, key);
        // A lowered maximum, or the preview leaving `active`, does not undo a replay.
        const lowered = { lifecycle: { ...lifecycle, maxTtlSeconds: 3600 } };
        expect(ms((await extend(p.id, "24h", "dee", lowered, key)).expiresAt)).toBe(
            ms(first.expiresAt),
        );
        expect(await code(extend(p.id, "24h", "dee", lowered))).toBe("invalid");
        await testDb.db
            .updateTable("preview")
            .set({ desired_state: "deleting" })
            .where("id", "=", p.id)
            .execute();
        expect((await extend(p.id, "24h", "dee", {}, key)).state).toBe("deleting");
        expect(await code(extend(p.id, "24h", "dee", {}, `other-${randomUUID()}`))).toBe(
            "conflict",
        );
        await testDb.db
            .updateTable("preview")
            .set({ desired_state: "deleted", deleted_at: new Date() })
            .where("id", "=", p.id)
            .execute();
        expect(await code(extend(p.id, "24h", "dee", {}, key))).toBe("not-found");
    });

    it("removes the expiry with none only where the instance allows it", async () => {
        const p = await make({ ttl: "24h" });
        expect(await code(extend(p.id, "none"))).toBe("invalid");
        const allowed = { lifecycle: { ...lifecycle, allowNoExpiry: true } };
        expect((await extend(p.id, "none", "dee", allowed)).expiresAt).toBeNull();
    });
});

describe("expiring previews", () => {
    const overdue = async (n = 1) => {
        const ids: string[] = [];
        for (let i = 0; i < n; i++) {
            const p = await make();
            await setExpiry(p.id, new Date(Date.now() - 60_000 - i));
            ids.push(p.id);
        }
        return ids;
    };

    it("claims only overdue active previews, and queues exactly one deletion for each", async () => {
        const [late] = await overdue();
        const future = await make({ ttl: "24h" });
        const never = await make(
            { ttl: "none" },
            { lifecycle: { ...lifecycle, allowNoExpiry: true } },
        );
        const gone = await make();
        await setExpiry(gone.id, new Date(Date.now() - 1000));
        await testDb.db
            .updateTable("preview")
            .set({ desired_state: "deleting" })
            .where("id", "=", gone.id)
            .execute();
        const { claimed } = await expirePreviews(testDb.db, { limit: 1000 });
        expect(claimed).toContain(late);
        for (const id of [future.id, never.id, gone.id]) expect(claimed).not.toContain(id);
        const state = await row(late!);
        expect(state.desired_state).toBe("deleting");
        const operations = await testDb.db
            .selectFrom("deletion_operation")
            .selectAll()
            .where("preview_id", "=", late!)
            .execute();
        expect(operations).toHaveLength(1);
        expect(operations[0]).toMatchObject({
            reason: "expired",
            requested_by: null,
            status: "queued",
            attempt: 0,
        });
        const audit = await testDb.db
            .selectFrom("audit_event")
            .select("actor")
            .where("target_id", "=", late!)
            .where("action", "=", "preview.expired")
            .execute();
        expect(audit).toEqual([{ actor: "system" }]);
        // A second sweep finds nothing new.
        expect((await expirePreviews(testDb.db, { limit: 1000 })).claimed).not.toContain(late);
    });

    it("cancels deployments that were queued and never started, so none begins after", async () => {
        const [id] = await overdue();
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
            id!,
            { artifactId: artifact.id },
            { enabled: true },
        );
        await expirePreviews(testDb.db, { limit: 1000 });
        const after = await testDb.db
            .selectFrom("deployment")
            .select(["status", "failure_code"])
            .where("id", "=", queued.id)
            .executeTakeFirstOrThrow();
        expect(after).toEqual({ status: "cancelled", failure_code: "preview-deleted" });
        // And a new deployment is refused.
        expect(
            await code(
                enqueueDeployment(
                    testDb.db,
                    people.dee!,
                    org,
                    id!,
                    { artifactId: artifact.id },
                    { enabled: true },
                ),
            ),
        ).toBe("conflict");
    });

    it("works off a long outage in bounded batches, claiming each preview once", async () => {
        const ids = await overdue(12);
        const seen = new Set<string>();
        let rounds = 0;
        for (;;) {
            const { claimed } = await expirePreviews(testDb.db, { limit: 5 });
            expect(claimed.length).toBeLessThanOrEqual(5);
            for (const id of claimed) {
                expect(seen.has(id), "claimed twice").toBe(false);
                seen.add(id);
            }
            rounds++;
            if (claimed.length === 0) break;
        }
        for (const id of ids) expect(seen.has(id)).toBe(true);
        expect(rounds).toBeGreaterThanOrEqual(3);
        for (const id of ids) {
            const n = await testDb.db
                .selectFrom("deletion_operation")
                .select((eb) => eb.fn.countAll<string>().as("n"))
                .where("preview_id", "=", id)
                .executeTakeFirstOrThrow();
            expect(Number(n.n)).toBe(1);
        }
    });

    it("lets concurrent sweeps share the work without claiming anything twice", async () => {
        const ids = await overdue(20);
        const sweeps = await Promise.all(
            [1, 2, 3, 4].map(() => expirePreviews(testDb.db, { limit: 100 })),
        );
        const all = sweeps.flatMap((s) => s.claimed);
        expect(new Set(all).size).toBe(all.length);
        for (const id of ids) expect(all).toContain(id);
    });

    it("refuses a limit that is not a positive integer", async () => {
        for (const limit of [0, -1, 1.5, Number.NaN]) {
            await expect(expirePreviews(testDb.db, { limit })).rejects.toThrow(/positive integer/);
        }
    });
});

// Polls (bounded) until some statement in this database is waiting for a lock, so a test
// knows its request has reached the wait rather than hoping a delay was long enough.
async function untilBlocked(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const { rows } = await sql<{ n: string }>`select count(*)::text as n from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'`.execute(testDb.db);
        if (Number(rows[0]!.n) > 0) return;
        await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("nothing was waiting for the lock");
}

// Holds the preview's row lock while `during` runs. The lock is known to be held before
// `during` starts (the holder says so), and `during` is given `blocked()` to wait until its
// request is stuck behind it. `during` starts what must wait for the lock and returns that
// waiting work as `{ pending }` (wrapped, so it is not awaited early). The lock is always
// let go of and the holding transaction ended, even if `during` fails; then the waiting
// work is awaited.
async function whileLocked<T>(
    id: string,
    during: (blocked: () => Promise<void>) => Promise<{ pending: Promise<T> }>,
): Promise<T> {
    let release!: () => void;
    let locked!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const acquired = new Promise<void>((resolve) => (locked = resolve));
    const holder = testDb.db.transaction().execute(async (trx) => {
        await sql`select 1 from preview where id = ${id} for update`.execute(trx);
        locked();
        await held;
    });
    let pending: Promise<T> | undefined;
    try {
        await Promise.race([acquired, holder]);
        ({ pending } = await during(() => untilBlocked()));
    } finally {
        release();
        await holder;
    }
    return pending;
}

describe("expiry racing an extension", () => {
    it("lets exactly one win, on every preview, never both", async () => {
        const ids: string[] = [];
        for (let i = 0; i < 24; i++) {
            const p = await make();
            await setExpiry(p.id, new Date(Date.now() - 1000));
            ids.push(p.id);
        }
        const outcomes = await Promise.all(
            ids.flatMap((id) => [
                extend(id, "2d").then(
                    () => ({ id, extended: true }),
                    (e) => ({
                        id,
                        extended: false,
                        error: e instanceof ServiceError ? e.code : String(e),
                    }),
                ),
                expirePreviews(testDb.db, { limit: 1000 }).then(() => ({ id, extended: null })),
            ]),
        );
        // Whatever sweeps missed (rows being extended at that moment) is claimed by one more.
        await expirePreviews(testDb.db, { limit: 1000 });
        for (const id of ids) {
            const result = outcomes.find((o) => o.id === id && o.extended !== null) as {
                extended: boolean;
                error?: string;
            };
            const state = await row(id);
            const operations = await testDb.db
                .selectFrom("deletion_operation")
                .select("id")
                .where("preview_id", "=", id)
                .execute();
            if (result.extended) {
                // The extension committed first: alive, with time, and nothing queued.
                expect(state.desired_state, id).toBe("active");
                expect(ms(state.expires_at)!, id).toBeGreaterThan(Date.now());
                expect(operations, id).toHaveLength(0);
            } else {
                // Expiry committed first: the extension was refused, one deletion queued.
                expect(result.error, id).toBe("conflict");
                expect(state.desired_state, id).toBe("deleting");
                expect(operations, id).toHaveLength(1);
            }
        }
        // The extended ones survive later sweeps.
        const survivors = (
            await testDb.db
                .selectFrom("preview")
                .select("id")
                .where("id", "in", ids)
                .where("desired_state", "=", "active")
                .execute()
        ).length;
        expect(
            (await expirePreviews(testDb.db, { limit: 1000 })).claimed.filter((id) =>
                ids.includes(id),
            ),
        ).toEqual([]);
        expect(
            (
                await testDb.db
                    .selectFrom("preview")
                    .select("id")
                    .where("id", "in", ids)
                    .where("desired_state", "=", "active")
                    .execute()
            ).length,
        ).toBe(survivors);
    });

    it("refuses a member removed while the extension waited for the lock", async () => {
        await newUser("leaver");
        await addMember(testDb.db, people.ann!, org, {
            email: "leaver@example.com",
            role: "deployer",
        });
        const p = await make({ ttl: "24h" });
        const before = ms((await row(p.id)).expires_at);
        const waiting = await whileLocked(p.id, async (blocked) => {
            const pending = code(extend(p.id, "2d", "leaver"));
            // Past its first membership check and stuck on the row lock: only now is the
            // member removed, so only the re-check after the lock can refuse it.
            await blocked();
            await removeMember(testDb.db, people.ann!, org, people.leaver!.userId);
            return { pending };
        });
        expect(waiting).toBe("not-found");
        expect(ms((await row(p.id)).expires_at)).toBe(before);
    });

    it("does not let a long wait for the lock leave the extension already past", async () => {
        const p = await make({ ttl: "24h" });
        // Still in the future when the request starts, already past when the lock is won.
        await setExpiry(p.id, new Date(Date.now() + 1000));
        const result = await whileLocked(p.id, async (blocked) => {
            const pending = extend(p.id, "1s");
            await blocked();
            // Time passes while it waits: the expiry set above is now behind us.
            await new Promise((r) => setTimeout(r, 1500));
            return { pending };
        });
        // The clock was read after the lock was won, so the new expiry is in the future.
        expect(ms(result.expiresAt)!).toBeGreaterThan(Date.now());
    });
});
