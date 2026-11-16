import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDatabase } from "@launchpad/database/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    addMember,
    artifactStorageKey,
    beginLifecycle,
    collectArtifacts,
    createOrganization,
    createPreview,
    createProject,
    DEFAULT_LIFECYCLE,
    enqueueDeployment,
    recoverInterruptedCollections,
    requestPreviewDeletion,
    runLifecycleOnce,
    ServiceError,
    sweepOrphanArtifactFiles,
    uploadArtifact,
    type LifecycleConfig,
    type LifecyclePorts,
    type Principal,
} from "../index";
import { SITE, tarGz } from "../testing/tar-fixtures";

let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
let dataDir = "";
const people: Record<string, Principal> = {};
const on: LifecycleConfig = { ...DEFAULT_LIFECYCLE, enabled: true, artifactRetentionSeconds: 3600 };
const previewDeps = { previewDomain: "previews.example.com", maxPreviews: 10_000, lifecycle: on };
const HOUR = 3_600_000;
let org = "";
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
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "launchpad-lifecycle-"));
    testDb = await createTestDatabase();
    await testDb.migrate();
    for (const n of ["root", "ann", "dee"]) await newUser(n);
    org = (
        await createOrganization(testDb.db, people.root!, {
            name: "Acme",
            slug: "acme",
            ownerEmail: "ann@example.com",
        })
    ).id;
    await addMember(testDb.db, people.ann!, org, { email: "dee@example.com", role: "deployer" });
    project = (await createProject(testDb.db, people.ann!, org, { name: "Site", slug: "site" })).id;
});
afterAll(async () => {
    await testDb.destroy();
    await fs.rm(dataDir, { recursive: true, force: true });
});

// An artifact with a real file on disk, aged by `ageMs`.
async function artifact(ageMs = 2 * HOUR) {
    const digest = createHash("sha256").update(randomUUID()).digest("hex");
    const key = artifactStorageKey(org, digest);
    const file = path.join(dataDir, key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "archive");
    const aged = new Date(Date.now() - ageMs);
    await fs.utimes(file, aged, aged);
    const row = await testDb.db
        .insertInto("artifact")
        .values({
            organization_id: org,
            digest,
            size_bytes: 7,
            expanded_bytes: 7,
            entry_count: 1,
            storage_key: key,
            created_by: people.dee!.userId,
            created_at: aged,
        } as never)
        .returning("id")
        .executeTakeFirstOrThrow();
    return { id: row.id, file, key };
}
const exists = (file: string) =>
    fs.stat(file).then(
        () => true,
        () => false,
    );
const collected = async (id: string) =>
    (
        await testDb.db
            .selectFrom("artifact")
            .select("collected_at")
            .where("id", "=", id)
            .executeTakeFirstOrThrow()
    ).collected_at !== null;
const makePreview = async () => {
    const p = await createPreview(
        testDb.db,
        people.dee!,
        org,
        project,
        { slug: `p${++counter}` },
        previewDeps,
    );
    return p.id;
};
const deploy = async (
    previewId: string,
    artifactId: string,
    status: string,
    extra: Record<string, unknown> = {},
) => {
    const d = await enqueueDeployment(
        testDb.db,
        people.dee!,
        org,
        previewId,
        { artifactId },
        { enabled: true },
    );
    await testDb.db
        .updateTable("deployment")
        .set({ status, ...extra } as never)
        .where("id", "=", d.id)
        .execute();
    return d.id;
};
const collect = (retentionSeconds = 3600, limit = 1000) =>
    collectArtifacts(testDb.db, { dataDir, retentionSeconds, limit });

describe("collecting artifacts", () => {
    it("collects an old unused archive: the file goes, the row stays marked, and it is audited", async () => {
        const a = await artifact();
        expect((await collect()).collected).toContain(a.id);
        expect(await exists(a.file)).toBe(false);
        expect(await collected(a.id)).toBe(true);
        const audit = await testDb.db
            .selectFrom("audit_event")
            .select("actor")
            .where("target_id", "=", a.id)
            .where("action", "=", "artifact.collected")
            .execute();
        expect(audit).toEqual([{ actor: "system" }]);
        // Nothing is collected twice.
        expect((await collect()).collected).not.toContain(a.id);
    });

    it("keeps what is too young, and what a live preview still points at", async () => {
        const young = await artifact(10 * 60_000);
        const live = await artifact();
        await deploy(await makePreview(), live.id, "succeeded");
        const queued = await artifact();
        const p = await makePreview();
        await deploy(p, queued.id, "queued");
        const result = (await collect()).collected;
        for (const a of [young, live, queued]) {
            expect(result).not.toContain(a.id);
            expect(await exists(a.file)).toBe(true);
            expect(await collected(a.id)).toBe(false);
        }
    });

    it("waits out the retention after the preview was deleted, and never takes an unfinished one", async () => {
        const recent = await artifact();
        const preview = await makePreview();
        await deploy(preview, recent.id, "succeeded");
        await testDb.db
            .updateTable("preview")
            .set({ desired_state: "deleted", deleted_at: new Date() })
            .where("id", "=", preview)
            .execute();
        expect((await collect()).collected).not.toContain(recent.id);
        // Deleted long enough ago: now it may go.
        await testDb.db
            .updateTable("preview")
            .set({ deleted_at: new Date(Date.now() - 2 * HOUR) })
            .where("id", "=", preview)
            .execute();
        expect((await collect()).collected).toContain(recent.id);

        // A deployment still held for reconciliation keeps its archive even on a deleted preview.
        const held = await artifact();
        const other = await makePreview();
        await deploy(other, held.id, "reconciliation-needed");
        await testDb.db
            .updateTable("preview")
            .set({ desired_state: "deleted", deleted_at: new Date(Date.now() - 2 * HOUR) })
            .where("id", "=", other)
            .execute();
        expect((await collect()).collected).not.toContain(held.id);
        // A preview that is only being deleted still counts as live.
        const going = await artifact();
        const deleting = await makePreview();
        await deploy(deleting, going.id, "succeeded");
        await testDb.db
            .updateTable("preview")
            .set({ desired_state: "deleting" })
            .where("id", "=", deleting)
            .execute();
        expect((await collect()).collected).not.toContain(going.id);
    });

    it("shares the work between concurrent collectors without collecting anything twice", async () => {
        const made = await Promise.all([1, 2, 3, 4, 5, 6].map(() => artifact()));
        const runs = await Promise.all([1, 2, 3].map(() => collect()));
        const all = runs.flatMap((r) => r.collected);
        expect(new Set(all).size).toBe(all.length);
        for (const a of made) expect(all).toContain(a.id);
    });

    it("refuses a bad limit or a negative retention", async () => {
        await expect(collect(3600, 0)).rejects.toThrow(/positive integer/);
        await expect(collect(-1)).rejects.toThrow(/negative/);
    });

    it("is refused for deployment once collected, and a deployment racing the collector never points at a collected archive", async () => {
        const gone = await artifact();
        await collect();
        expect(
            await code(
                enqueueDeployment(
                    testDb.db,
                    people.dee!,
                    org,
                    await makePreview(),
                    { artifactId: gone.id },
                    { enabled: true },
                ),
            ),
        ).toBe("not-found");

        const pairs = await Promise.all(
            Array.from({ length: 16 }, async () => ({
                a: await artifact(),
                p: await makePreview(),
            })),
        );
        const outcomes = await Promise.all(
            pairs.flatMap(({ a, p }) => [
                enqueueDeployment(
                    testDb.db,
                    people.dee!,
                    org,
                    p,
                    { artifactId: a.id },
                    { enabled: true },
                ).then(
                    () => "deployed",
                    (e) => (e instanceof ServiceError ? e.code : String(e)),
                ),
                collect().then(() => "collected-run"),
            ]),
        );
        await collect();
        for (const { a, p } of pairs) {
            const deployments = await testDb.db
                .selectFrom("deployment")
                .select("id")
                .where("preview_id", "=", p)
                .execute();
            if (deployments.length > 0) {
                // A deployment exists, so the archive was not taken from under it.
                expect(await collected(a.id), a.id).toBe(false);
                expect(await exists(a.file), a.id).toBe(true);
            } else {
                expect(await collected(a.id), a.id).toBe(true);
            }
        }
        expect(
            outcomes.filter((o) => o === "deployed" || o === "not-found" || o === "collected-run"),
        ).toHaveLength(outcomes.length);
    });
});

describe("a deployment waiting on an artifact being collected", () => {
    it("is refused once the collector commits, instead of pointing at the collected archive", async () => {
        const a = await artifact();
        const preview = await makePreview();
        let release!: () => void;
        let locked!: () => void;
        const hold = new Promise<void>((resolve) => (release = resolve));
        const acquired = new Promise<void>((resolve) => (locked = resolve));
        // What the collector does, kept open: the row locked and marked, not yet committed.
        const collector = testDb.db.transaction().execute(async (trx) => {
            await trx
                .selectFrom("artifact")
                .select("id")
                .where("id", "=", a.id)
                .forUpdate()
                .execute();
            await trx
                .updateTable("artifact")
                .set({ collected_at: new Date() })
                .where("id", "=", a.id)
                .execute();
            locked();
            await hold;
        });
        let waiting: Promise<string> | undefined;
        try {
            await Promise.race([acquired, collector]);
            waiting = code(
                enqueueDeployment(
                    testDb.db,
                    people.dee!,
                    org,
                    preview,
                    { artifactId: a.id },
                    { enabled: true },
                ),
            );
            for (let i = 0; i < 250; i++) {
                const { rows } = await sql<{
                    n: string;
                }>`select count(*)::text as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`.execute(
                    testDb.db,
                );
                if (Number(rows[0]!.n) > 0) break;
                await new Promise((r) => setTimeout(r, 20));
            }
        } finally {
            release();
            await collector;
        }
        expect(await waiting).toBe("not-found");
        const deployments = await testDb.db
            .selectFrom("deployment")
            .select("id")
            .where("preview_id", "=", preview)
            .execute();
        expect(deployments).toEqual([]);
    });
});

describe("collection racing deployments and uploads", () => {
    it("judges a candidate again once it is locked: a deployment that committed in between keeps the archive", async () => {
        const a = await artifact();
        const preview = await makePreview();
        let deployed = "";
        const result = await collectArtifacts(testDb.db, {
            dataDir,
            retentionSeconds: 3600,
            limit: 1000,
            // The deployment commits after the candidate was chosen and before it is locked.
            afterCandidate: async (id) => {
                if (id === a.id && !deployed) deployed = await deploy(preview, a.id, "succeeded");
            },
        });
        expect(deployed).not.toBe("");
        expect(result.collected).not.toContain(a.id);
        expect(await exists(a.file)).toBe(true);
        expect(await collected(a.id)).toBe(false);
    });

    it("never removes an archive that a re-upload restored between the commit and the removal", async () => {
        const bytes = tarGz([
            ...SITE,
            { name: "restored.txt", content: `restored ${randomUUID()}` },
        ]);
        const limits = { maxConcurrentUploads: 50, maxArtifacts: 100_000 };
        const stream = () =>
            new ReadableStream<Uint8Array>({
                start(c) {
                    c.enqueue(bytes);
                    c.close();
                },
            });
        const first = await uploadArtifact(
            testDb.db,
            people.dee!,
            org,
            stream(),
            { contentLength: bytes.length },
            { dataDir, limits },
        );
        await testDb.db
            .updateTable("artifact")
            .set({ created_at: new Date(Date.now() - 2 * HOUR) })
            .where("id", "=", first.id)
            .execute();
        const stored = path.join(dataDir, artifactStorageKey(org, first.digest));
        const result = await collectArtifacts(testDb.db, {
            dataDir,
            retentionSeconds: 3600,
            limit: 1000,
            afterCommit: async (id) => {
                if (id !== first.id) return;
                // The row is collected and the file is aside; now the same bytes are uploaded.
                const again = await uploadArtifact(
                    testDb.db,
                    people.dee!,
                    org,
                    stream(),
                    { contentLength: bytes.length },
                    { dataDir, limits },
                );
                expect(again).toMatchObject({ id: first.id, reused: false });
            },
        });
        expect(result.collected).toContain(first.id);
        expect(await exists(stored)).toBe(true);
        expect(await collected(first.id)).toBe(false);
        // No moved-aside file is left behind either.
        const leftovers = (await fs.readdir(path.dirname(stored))).filter((f) =>
            f.endsWith(".gone"),
        );
        expect(leftovers).toEqual([]);
        expect(
            await code(
                enqueueDeployment(
                    testDb.db,
                    people.dee!,
                    org,
                    await makePreview(),
                    { artifactId: first.id },
                    { enabled: true },
                ),
            ),
        ).toBe("ok");
    });

    it("puts the archive back if the collection could not commit", async () => {
        const a = await artifact();
        await expect(
            collectArtifacts(testDb.db, {
                dataDir,
                retentionSeconds: 3600,
                limit: 1000,
                afterCandidate: async (id) => {
                    if (id === a.id) throw new Error("boom");
                },
            }),
        ).rejects.toThrow("boom");
        expect(await exists(a.file)).toBe(true);
        expect(await collected(a.id)).toBe(false);
    });

    it("cannot delete an archive an upload stores in the gap between the sweep's check and its removal", async () => {
        const digest = createHash("sha256").update(randomUUID()).digest("hex");
        const key = artifactStorageKey(org, digest);
        const file = path.join(dataDir, key);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, "old");
        const aged = new Date(Date.now() - 2 * HOUR);
        await fs.utimes(file, aged, aged);
        await testDb.db
            .insertInto("artifact")
            .values({
                organization_id: org,
                digest,
                size_bytes: 1,
                expanded_bytes: 1,
                entry_count: 1,
                storage_key: key,
                created_by: people.dee!.userId,
                collected_at: new Date(),
                created_at: aged,
            } as never)
            .execute();
        const owner = key.split("/")[1]!;
        let finalizing: Promise<void> | undefined;
        await sweepOrphanArtifactFiles(testDb.db, {
            dataDir,
            retentionSeconds: 3600,
            // An upload finalizing starts now, with the sweep's check already made.
            beforeRemove: async (target) => {
                if (target !== file) return;
                finalizing = testDb.db.transaction().execute(async (trx) => {
                    await sql`select pg_advisory_xact_lock(hashtextextended(${`artifacts:${owner}`}, 0))`.execute(
                        trx,
                    );
                    await fs.writeFile(file, "restored");
                    await trx
                        .updateTable("artifact")
                        .set({ collected_at: null, created_at: new Date() })
                        .where("storage_key", "=", key)
                        .execute();
                });
                // Long enough that, with no lock in the way, it would be done before the removal.
                await new Promise((r) => setTimeout(r, 400));
            },
        });
        await finalizing;
        expect(await fs.readFile(file, "utf8")).toBe("restored");
        expect(
            await collected(
                (
                    await testDb.db
                        .selectFrom("artifact")
                        .select("id")
                        .where("storage_key", "=", key)
                        .executeTakeFirstOrThrow()
                ).id,
            ),
        ).toBe(false);
    });

    it("removes moved-aside files of an interrupted collection once they are old enough", async () => {
        const digest = createHash("sha256").update(randomUUID()).digest("hex");
        const key = artifactStorageKey(org, digest);
        const aside = path.join(dataDir, `${key}.0123456789abcdef.gone`);
        await fs.mkdir(path.dirname(aside), { recursive: true });
        await fs.writeFile(aside, "x");
        // Just moved: kept, whatever the file's own age.
        const aged = new Date(Date.now() - 2 * HOUR);
        await fs.utimes(aside, aged, aged);
        await sweepOrphanArtifactFiles(testDb.db, { dataDir, retentionSeconds: 3600 });
        expect(await exists(aside)).toBe(true);
        // Aside for longer than the retention: removed.
        await sweepOrphanArtifactFiles(testDb.db, { dataDir, retentionSeconds: 0 });
        expect(await exists(aside)).toBe(false);
    });
});

describe("a collection that died before its commit", () => {
    // What the crash leaves: the row live, the archive moved aside under its own name.
    const interrupted = async () => {
        const a = await artifact();
        const aside = `${a.file}.0123456789abcdef.gone`;
        await fs.rename(a.file, aside);
        return { ...a, aside };
    };

    it("is put back at the worker's start, before anything can read the missing archive", async () => {
        const a = await interrupted();
        expect(await exists(a.file)).toBe(false);
        expect(await recoverInterruptedCollections(testDb.db, { dataDir })).toMatchObject({
            restored: 1,
        });
        expect(await fs.readFile(a.file, "utf8")).toBe("archive");
        expect(await exists(a.aside)).toBe(false);
        expect(await collected(a.id)).toBe(false);
    });

    it("is never swept away as the only copy, however old, and is put back after the grace period", async () => {
        const a = await interrupted();
        // Within the grace period a collection in progress may be holding it aside.
        const kept = await sweepOrphanArtifactFiles(testDb.db, { dataDir, retentionSeconds: 0 });
        expect(kept.restored).toBe(0);
        expect(await exists(a.aside)).toBe(true);
        // Past it, even with the retention long over, it is restored rather than removed.
        const swept = await sweepOrphanArtifactFiles(testDb.db, {
            dataDir,
            retentionSeconds: 0,
            graceMs: 0,
        });
        expect(swept.restored).toBeGreaterThanOrEqual(1);
        expect(await fs.readFile(a.file, "utf8")).toBe("archive");
        expect(await exists(a.aside)).toBe(false);
    });

    it("looks at every moved-aside file however many ordinary archives there are, while an ordinary sweep is bounded", async () => {
        // Ordinary archives that a bounded sweep would spend its whole budget on.
        for (let i = 0; i < 5; i++) await artifact();
        const a = await interrupted();
        // Looking only at moved-aside files, a budget of one is enough: nothing else is counted.
        const only = await sweepOrphanArtifactFiles(testDb.db, {
            dataDir,
            retentionSeconds: Number.POSITIVE_INFINITY,
            graceMs: 0,
            maxFiles: 1,
            asideOnly: true,
        });
        expect(only.restored).toBe(1);
        expect(await fs.readFile(a.file, "utf8")).toBe("archive");
        // An ordinary sweep honors its bound: with three restorable archives waiting, a budget of
        // one cannot put them all back.
        const b = await interrupted();
        await interrupted();
        await interrupted();
        const bounded = await sweepOrphanArtifactFiles(testDb.db, {
            dataDir,
            retentionSeconds: 3600,
            graceMs: 0,
            maxFiles: 1,
        });
        expect(bounded.restored + bounded.removed).toBeLessThanOrEqual(1);
        // Recovery finishes what the bounded sweep left.
        const rest = await recoverInterruptedCollections(testDb.db, { dataDir });
        expect(rest.restored + bounded.restored).toBe(3);
        expect(await fs.readFile(b.file, "utf8")).toBe("archive");
    });

    it("drops the spare copy when the archive is already back", async () => {
        const a = await interrupted();
        await fs.writeFile(a.file, "already back");
        await sweepOrphanArtifactFiles(testDb.db, { dataDir, retentionSeconds: 3600, graceMs: 0 });
        expect(await exists(a.aside)).toBe(false);
        expect(await fs.readFile(a.file, "utf8")).toBe("already back");
    });

    it("is repaired by an upload of the same bytes instead of being reported as reused with no file", async () => {
        const bytes = tarGz([...SITE, { name: "repair.txt", content: `repair ${randomUUID()}` }]);
        const limits = { maxConcurrentUploads: 50, maxArtifacts: 100_000 };
        const stream = () =>
            new ReadableStream<Uint8Array>({
                start(c) {
                    c.enqueue(bytes);
                    c.close();
                },
            });
        const first = await uploadArtifact(
            testDb.db,
            people.dee!,
            org,
            stream(),
            { contentLength: bytes.length },
            { dataDir, limits },
        );
        const stored = path.join(dataDir, artifactStorageKey(org, first.digest));
        await fs.rename(stored, `${stored}.0123456789abcdef.gone`);
        const again = await uploadArtifact(
            testDb.db,
            people.dee!,
            org,
            stream(),
            { contentLength: bytes.length },
            { dataDir, limits },
        );
        expect(again).toMatchObject({ id: first.id, reused: false });
        expect((await fs.readFile(stored)).equals(bytes)).toBe(true);
        // A live upload whose archive is present is still reused, untouched.
        const third = await uploadArtifact(
            testDb.db,
            people.dee!,
            org,
            stream(),
            { contentLength: bytes.length },
            { dataDir, limits },
        );
        expect(third).toMatchObject({ id: first.id, reused: true });
    });
});

describe("storing a collected archive again", () => {
    it("makes the same artifact usable, and starts its retention again", async () => {
        const bytes = tarGz([...SITE, { name: "again.txt", content: "again" }]);
        const limits = { maxConcurrentUploads: 50, maxArtifacts: 100_000 };
        const stream = () =>
            new ReadableStream<Uint8Array>({
                start(c) {
                    c.enqueue(bytes);
                    c.close();
                },
            });
        const first = await uploadArtifact(
            testDb.db,
            people.dee!,
            org,
            stream(),
            { contentLength: bytes.length },
            { dataDir, limits },
        );
        await testDb.db
            .updateTable("artifact")
            .set({ created_at: new Date(Date.now() - 2 * HOUR) })
            .where("id", "=", first.id)
            .execute();
        const stored = path.join(dataDir, artifactStorageKey(org, first.digest));
        expect((await collect()).collected).toContain(first.id);
        expect(await exists(stored)).toBe(false);
        const again = await uploadArtifact(
            testDb.db,
            people.dee!,
            org,
            stream(),
            { contentLength: bytes.length },
            { dataDir, limits },
        );
        expect(again).toMatchObject({ id: first.id, reused: false });
        // The answer carries the new time, not the old one the retention no longer uses.
        expect(again.createdAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
        expect(await exists(stored)).toBe(true);
        expect(await collected(first.id)).toBe(false);
        // Young again, so the next collection leaves it.
        expect((await collect()).collected).not.toContain(first.id);
        // And it can be deployed.
        expect(
            await code(
                enqueueDeployment(
                    testDb.db,
                    people.dee!,
                    org,
                    await makePreview(),
                    { artifactId: first.id },
                    { enabled: true },
                ),
            ),
        ).toBe("ok");
    });

    it("does not count collected archives against the organization's quota", async () => {
        const before = await testDb.db
            .selectFrom("artifact")
            .select((eb) => eb.fn.countAll<string>().as("n"))
            .where("organization_id", "=", org)
            .where("collected_at", "is", null)
            .executeTakeFirstOrThrow();
        const bytes = tarGz([...SITE, { name: "quota.txt", content: `quota ${randomUUID()}` }]);
        const stream = () =>
            new ReadableStream<Uint8Array>({
                start(c) {
                    c.enqueue(bytes);
                    c.close();
                },
            });
        // A limit exactly at the live count would refuse a new one...
        const limits = { maxConcurrentUploads: 50, maxArtifacts: Number(before.n) };
        expect(
            await code(
                uploadArtifact(
                    testDb.db,
                    people.dee!,
                    org,
                    stream(),
                    { contentLength: bytes.length },
                    { dataDir, limits },
                ),
            ),
        ).toBe("conflict");
        // ...until something is collected.
        const old = await artifact();
        await testDb.db
            .updateTable("artifact")
            .set({ collected_at: new Date() })
            .where("id", "=", old.id)
            .execute();
        expect(
            await code(
                uploadArtifact(
                    testDb.db,
                    people.dee!,
                    org,
                    stream(),
                    { contentLength: bytes.length },
                    { dataDir, limits: { ...limits, maxArtifacts: Number(before.n) + 1 } },
                ),
            ),
        ).toBe("ok");
    });
});

describe("sweeping orphaned archive files", () => {
    const orphan = async (ageMs: number, collectedRow = false) => {
        const digest = createHash("sha256").update(randomUUID()).digest("hex");
        const key = artifactStorageKey(org, digest);
        const file = path.join(dataDir, key);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, "x");
        const aged = new Date(Date.now() - ageMs);
        await fs.utimes(file, aged, aged);
        if (collectedRow) {
            await testDb.db
                .insertInto("artifact")
                .values({
                    organization_id: org,
                    digest,
                    size_bytes: 1,
                    expanded_bytes: 1,
                    entry_count: 1,
                    storage_key: key,
                    created_by: people.dee!.userId,
                    collected_at: new Date(),
                })
                .execute();
        }
        return file;
    };

    it("removes old files nothing refers to, and files of collected rows, and nothing else", async () => {
        const lost = await orphan(2 * HOUR);
        const leftover = await orphan(2 * HOUR, true);
        const young = await orphan(10 * 60_000);
        const live = await artifact();
        // A stray name is not one this module wrote, so it is not touched.
        const owner = path.dirname(live.file);
        await fs.writeFile(path.join(owner, "notes.txt"), "keep");
        await fs.utimes(path.join(owner, "notes.txt"), new Date(0), new Date(0));
        const { removed } = await sweepOrphanArtifactFiles(testDb.db, {
            dataDir,
            retentionSeconds: 3600,
        });
        expect(removed).toBeGreaterThanOrEqual(2);
        expect(await exists(lost)).toBe(false);
        expect(await exists(leftover)).toBe(false);
        expect(await exists(young)).toBe(true);
        expect(await exists(live.file)).toBe(true);
        expect(await exists(path.join(owner, "notes.txt"))).toBe(true);
    });
});

describe("one round of lifecycle work", () => {
    const fakePorts = () => {
        const calls: string[] = [];
        const ports: LifecyclePorts = {
            dokku: {
                apps: {
                    exists: async (app) => {
                        calls.push(`exists:${app}`);
                        return true;
                    },
                    destroy: async (app) => {
                        calls.push(`destroy:${app}`);
                    },
                },
            },
            removeImages: async () => {
                calls.push("images");
            },
        };
        return { ports, calls };
    };

    it("does nothing at all while the lifecycle is off", async () => {
        const untouched = new Proxy(
            {},
            {
                get: () => {
                    throw new Error("touched");
                },
            },
        ) as typeof testDb.db;
        const { ports, calls } = fakePorts();
        const result = await runLifecycleOnce(untouched, ports, {
            owner: "w",
            config: { ...on, enabled: false },
            dataDir,
        });
        expect(result).toEqual({ expired: 0, deletion: "none", collected: 0, swept: 0 });
        expect(calls).toEqual([]);
    });

    it("expires, deletes and collects in order, and collects on its own rhythm", async () => {
        // Make this round's work the only work.
        await testDb.db
            .updateTable("deletion_operation")
            .set({ status: "succeeded", finished_at: new Date() })
            .where("status", "in", ["queued", "running", "reconciliation-needed"])
            .execute();
        await testDb.db
            .updateTable("preview")
            .set({ expires_at: null })
            .where("desired_state", "=", "active")
            .execute();
        const p = await makePreview();
        await testDb.db
            .updateTable("preview")
            .set({ expires_at: new Date(Date.now() - 1000) })
            .where("id", "=", p)
            .execute();
        const old = await artifact();
        const { ports, calls } = fakePorts();
        const state = { lastCollect: 0, started: true };
        const options = {
            owner: "w",
            config: on,
            dataDir,
            deletion: { retryBackoffMs: () => 0 },
            collectEveryMs: 60_000,
        };
        const first = await runLifecycleOnce(testDb.db, ports, options, state);
        expect(first.expired).toBe(1);
        expect(first.deletion).toBe("succeeded");
        expect(first.collected).toBeGreaterThanOrEqual(1);
        expect(calls[0]).toMatch(/^exists:lp-/);
        expect(
            (
                await testDb.db
                    .selectFrom("preview")
                    .select("desired_state")
                    .where("id", "=", p)
                    .executeTakeFirstOrThrow()
            ).desired_state,
        ).toBe("deleted");
        expect(await collected(old.id)).toBe(true);
        // Collection is not repeated within its interval; the rest runs every time.
        const fresh = await artifact();
        const second = await runLifecycleOnce(testDb.db, ports, options, state);
        expect(second).toEqual({ expired: 0, deletion: "none", collected: 0, swept: 0 });
        expect(await collected(fresh.id)).toBe(false);
    });

    it("leaves a deletion untouched when asked to shut down first", async () => {
        const p = await makePreview();
        await requestPreviewDeletion(testDb.db, people.dee!, org, p, { enabled: true });
        const stop = new AbortController();
        stop.abort();
        const { ports, calls } = fakePorts();
        expect(
            await runLifecycleOnce(testDb.db, ports, {
                owner: "w",
                config: on,
                dataDir,
                signal: stop.signal,
            }),
        ).toEqual({ expired: 0, deletion: "none", collected: 0, swept: 0 });
        expect(calls).toEqual([]);
    });
});

describe("collection edge cases", () => {
    it("skips a row whose storage key is malformed and still collects the rest", async () => {
        const bad = await artifact(5 * HOUR);
        await testDb.db
            .updateTable("artifact")
            .set({ storage_key: "../escape" })
            .where("id", "=", bad.id)
            .execute();
        const good = await artifact(3 * HOUR);
        const result = await collect();
        expect(result).toBeDefined();
        expect(await collected(bad.id)).toBe(false);
        expect(await collected(good.id)).toBe(true);
    });

    it("does not follow a symlinked owner directory when sweeping", async () => {
        const outside = await fs.mkdtemp(path.join(os.tmpdir(), "lp-outside-"));
        const digest = createHash("sha256").update(randomUUID()).digest("hex");
        const victim = path.join(outside, `${digest}.tar.gz`);
        await fs.writeFile(victim, "x");
        await fs.utimes(victim, new Date(0), new Date(0));
        const other = createHash("sha256").update(randomUUID()).digest("hex").slice(0, 32);
        await fs.mkdir(path.join(dataDir, "artifacts"), { recursive: true });
        await fs.symlink(outside, path.join(dataDir, "artifacts", other));
        await sweepOrphanArtifactFiles(testDb.db, { dataDir, retentionSeconds: 3600 });
        expect(await exists(victim)).toBe(true);
        await fs.rm(path.join(dataDir, "artifacts", other));
        await fs.rm(outside, { recursive: true, force: true });
    });
});

describe("the first switch-on", () => {
    it("gives overdue previews a grace once, and does nothing the second time", async () => {
        await testDb.db.deleteFrom("instance_state").execute();
        const p = await makePreview();
        await testDb.db
            .updateTable("preview")
            .set({ expires_at: new Date(Date.now() - 1000) })
            .where("id", "=", p)
            .execute();
        const first = await beginLifecycle(testDb.db, 3600);
        expect(first.first).toBe(true);
        expect(first.graced).toBeGreaterThanOrEqual(1);
        const row = await testDb.db
            .selectFrom("preview")
            .select("expires_at")
            .where("id", "=", p)
            .executeTakeFirstOrThrow();
        expect(row.expires_at!.getTime()).toBeGreaterThan(Date.now() + 3000_000);
        await testDb.db
            .updateTable("preview")
            .set({ expires_at: new Date(Date.now() - 1000) })
            .where("id", "=", p)
            .execute();
        expect(await beginLifecycle(testDb.db, 3600)).toEqual({ first: false, graced: 0 });
        const again = await testDb.db
            .selectFrom("preview")
            .select("expires_at")
            .where("id", "=", p)
            .executeTakeFirstOrThrow();
        expect(again.expires_at!.getTime()).toBeLessThan(Date.now());
        const audit = await testDb.db
            .selectFrom("audit_event")
            .select("id")
            .where("action", "=", "lifecycle.enabled")
            .execute();
        expect(audit.length).toBeGreaterThanOrEqual(1);
    });
});
