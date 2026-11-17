import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDatabase } from "@launchpad/database/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    addMember,
    createOrganization,
    createPreview,
    createProject,
    DEFAULT_LIFECYCLE,
    enqueueDeployment,
    getStatus,
    recordHeartbeat,
    requestPreviewDeletion,
    STUCK_RUNNING_SECONDS,
    WORKER_LIVE_SECONDS,
    type Principal,
} from "../index";

let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
const people: Record<string, Principal> = {};
let dataDir = "";
let org = "";
let project = "";
let counter = 0;
const lifecycle = { ...DEFAULT_LIFECYCLE, enabled: true };
const previewDeps = { previewDomain: "previews.example.com", maxPreviews: 10_000, lifecycle };

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

const status = (deps: Partial<Parameters<typeof getStatus>[2]> = {}) =>
    getStatus(testDb.db, people.root!, {
        dataDir,
        deploymentsEnabled: true,
        lifecycleEnabled: true,
        deletionsAccepted: true,
        ...deps,
    });
const beat = (workerId: string, over: { lifecycleEnabled?: boolean; started?: boolean } = {}) =>
    recordHeartbeat(testDb.db, {
        workerId,
        version: "1.2.3",
        lifecycleEnabled: over.lifecycleEnabled ?? true,
        started: over.started,
    });
const age = (workerId: string, seconds: number) =>
    testDb.db
        .updateTable("worker_heartbeat")
        .set({ last_seen_at: new Date(Date.now() - seconds * 1000) })
        .where("worker_id", "=", workerId)
        .execute();
const makePreview = async () =>
    (
        await createPreview(
            testDb.db,
            people.ann!,
            org,
            project,
            { slug: `p${++counter}` },
            previewDeps,
        )
    ).id;

beforeAll(async () => {
    testDb = await createTestDatabase();
    await testDb.migrate();
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "launchpad-status-"));
    for (const n of ["root", "ann", "dee"]) await newUser(n);
    org = (
        await createOrganization(testDb.db, people.root!, {
            name: "Acme",
            slug: "acme",
            ownerEmail: "ann@example.com",
        })
    ).id;
    await addMember(testDb.db, people.ann!, org, { email: "dee@example.com", role: "viewer" });
    project = (await createProject(testDb.db, people.ann!, org, { name: "Site", slug: "site" })).id;
});
afterAll(async () => {
    await testDb.destroy();
    await fs.rm(dataDir, { recursive: true, force: true });
});

describe("worker heartbeats", () => {
    it("records a worker once, refreshes it, and restarts its clock only when it starts again", async () => {
        await beat("w-a", { started: true });
        const first = await testDb.db
            .selectFrom("worker_heartbeat")
            .selectAll()
            .where("worker_id", "=", "w-a")
            .executeTakeFirstOrThrow();
        expect(first).toMatchObject({ version: "1.2.3", lifecycle_enabled: true });
        await age("w-a", 30);
        await recordHeartbeat(testDb.db, {
            workerId: "w-a",
            version: "1.2.4",
            lifecycleEnabled: false,
        });
        const again = await testDb.db
            .selectFrom("worker_heartbeat")
            .selectAll()
            .where("worker_id", "=", "w-a")
            .executeTakeFirstOrThrow();
        expect(again.started_at.getTime()).toBe(first.started_at.getTime());
        expect(again.last_seen_at.getTime()).toBeGreaterThan(Date.now() - 5000);
        expect(again).toMatchObject({ version: "1.2.4", lifecycle_enabled: false });
        // The same id coming back after a restart starts its clock again.
        await testDb.db
            .updateTable("worker_heartbeat")
            .set({ started_at: new Date(Date.now() - 3_600_000) })
            .where("worker_id", "=", "w-a")
            .execute();
        await beat("w-a", { started: true });
        const restarted = await testDb.db
            .selectFrom("worker_heartbeat")
            .select("started_at")
            .where("worker_id", "=", "w-a")
            .executeTakeFirstOrThrow();
        expect(restarted.started_at.getTime()).toBeGreaterThan(Date.now() - 5000);
    });

    it("forgets a worker that stopped a day ago", async () => {
        await beat("w-gone");
        await age("w-gone", 2 * 86_400);
        await beat("w-b");
        const left = (
            await testDb.db.selectFrom("worker_heartbeat").select("worker_id").execute()
        ).map((r) => r.worker_id);
        expect(left).not.toContain("w-gone");
        expect(left).toContain("w-b");
    });
});

describe("the status", () => {
    it("is for the operator only", async () => {
        for (const who of ["ann", "dee"]) {
            await expect(
                getStatus(testDb.db, people[who]!, {
                    dataDir,
                    deploymentsEnabled: true,
                    lifecycleEnabled: true,
                    deletionsAccepted: true,
                }),
            ).rejects.toMatchObject({ code: "forbidden" });
        }
        expect(await status()).toMatchObject({
            dependencies: { database: "ok" },
            controller: {
                deploymentsEnabled: true,
                lifecycleEnabled: true,
                deletionsAccepted: true,
            },
        });
        expect((await status({ deletionsAccepted: false })).controller.deletionsAccepted).toBe(
            false,
        );
    });

    it("counts the work waiting and says how old the oldest is", async () => {
        const before = await status();
        const artifact = await testDb.db
            .insertInto("artifact")
            .values({
                organization_id: org,
                digest: randomUUID().replaceAll("-", "").padEnd(64, "0"),
                size_bytes: 1000,
                expanded_bytes: 1000,
                entry_count: 1,
                storage_key: "x",
                created_by: people.ann!.userId,
            })
            .returning("id")
            .executeTakeFirstOrThrow();
        const queuedPreview = await makePreview();
        const d = await enqueueDeployment(
            testDb.db,
            people.ann!,
            org,
            queuedPreview,
            { artifactId: artifact.id },
            { enabled: true },
        );
        await testDb.db
            .updateTable("deployment")
            .set({ created_at: new Date(Date.now() - 125_000) })
            .where("id", "=", d.id)
            .execute();
        const runningPreview = await makePreview();
        const r = await enqueueDeployment(
            testDb.db,
            people.ann!,
            org,
            runningPreview,
            { artifactId: artifact.id },
            { enabled: true },
        );
        await testDb.db
            .updateTable("deployment")
            .set({ status: "building" })
            .where("id", "=", r.id)
            .execute();
        const heldPreview = await makePreview();
        const h = await enqueueDeployment(
            testDb.db,
            people.ann!,
            org,
            heldPreview,
            { artifactId: artifact.id },
            { enabled: true },
        );
        await testDb.db
            .updateTable("deployment")
            .set({ status: "reconciliation-needed" })
            .where("id", "=", h.id)
            .execute();
        const overdue = await makePreview();
        await testDb.db
            .updateTable("preview")
            .set({ expires_at: new Date(Date.now() - 1000) })
            .where("id", "=", overdue)
            .execute();
        const deleting = await makePreview();
        await requestPreviewDeletion(testDb.db, people.ann!, org, deleting, { enabled: true });
        const heldDeleting = await makePreview();
        const op = await requestPreviewDeletion(testDb.db, people.ann!, org, heldDeleting, {
            enabled: true,
        });
        await testDb.db
            .updateTable("deletion_operation")
            .set({ status: "reconciliation-needed" })
            .where("id", "=", op.operationId)
            .execute();
        const now = await status();
        expect(now.deployments.queued - before.deployments.queued).toBe(1);
        expect(now.deployments.running - before.deployments.running).toBe(1);
        expect(now.deployments.held - before.deployments.held).toBe(1);
        expect(now.deployments.oldestQueuedSeconds).toBeGreaterThanOrEqual(124);
        expect(now.expiry.overdue - before.expiry.overdue).toBe(1);
        expect(now.deletions.waiting - before.deletions.waiting).toBe(1);
        expect(now.deletions.held - before.deletions.held).toBe(1);
        expect(now.artifacts.stored - before.artifacts.stored).toBe(1);
        expect(now.artifacts.bytes - before.artifacts.bytes).toBe(1000);
        expect(now.warnings.some((w) => /1 deployment\(s\) need an administrator/.test(w))).toBe(
            true,
        );
        expect(now.warnings.some((w) => /1 deletion\(s\) need an administrator/.test(w))).toBe(
            true,
        );
        // Only counts and ages: nothing a remote system said, no ids or names.
        expect(JSON.stringify(now)).not.toContain(org);
    });

    it("reports workers as live or not, and warns when none is live while work waits", async () => {
        await testDb.db.deleteFrom("worker_heartbeat").execute();
        await beat("w-old");
        await age("w-old", WORKER_LIVE_SECONDS + 30);
        const stale = await status();
        expect(stale.workers).toEqual([
            expect.objectContaining({ id: "w-old", live: false, version: "1.2.3" }),
        ]);
        expect(stale.workers[0]!.lastSeenSecondsAgo).toBeGreaterThanOrEqual(
            WORKER_LIVE_SECONDS + 29,
        );
        expect(stale.warnings.some((w) => w.startsWith("No worker has reported"))).toBe(true);
        await beat("w-new");
        const fresh = await status();
        expect(fresh.workers.find((w) => w.id === "w-new")).toMatchObject({ live: true });
        expect(fresh.warnings.some((w) => w.startsWith("No worker has reported"))).toBe(false);
    });

    it("warns when the controller and the workers disagree about the lifecycle, either way", async () => {
        await testDb.db.deleteFrom("worker_heartbeat").execute();
        await beat("w-off", { lifecycleEnabled: false });
        expect(
            (await status({ deletionsAccepted: true })).warnings.some((w) =>
                w.includes("no live worker has the lifecycle on"),
            ),
        ).toBe(true);
        expect(
            (await status({ deletionsAccepted: false })).warnings.some((w) =>
                w.includes("does not accept deletions"),
            ),
        ).toBe(false);
        await beat("w-on", { lifecycleEnabled: true });
        expect(
            (await status({ deletionsAccepted: true })).warnings.some((w) =>
                w.includes("no live worker has the lifecycle on"),
            ),
        ).toBe(false);
        expect(
            (await status({ deletionsAccepted: false })).warnings.some((w) =>
                w.includes("does not accept deletions"),
            ),
        ).toBe(true);
    });

    it("reports the data directory as missing or unwritable", async () => {
        expect((await status()).dependencies.dataDirectory).toBe("ok");
        const gone = await status({ dataDir: path.join(dataDir, "nope") });
        expect(gone.dependencies.dataDirectory).toBe("missing");
        expect(gone.warnings).toContain("The data directory is missing.");
        const readonly = await fs.mkdtemp(path.join(os.tmpdir(), "launchpad-ro-"));
        await fs.chmod(readonly, 0o500);
        try {
            const result = await status({ dataDir: readonly });
            // Running as root, a read-only directory is still writable: only assert it is
            // reported consistently with what the system says.
            const writable = await fs.access(readonly, fs.constants.W_OK).then(
                () => true,
                () => false,
            );
            expect(result.dependencies.dataDirectory).toBe(writable ? "ok" : "not-writable");
        } finally {
            await fs.chmod(readonly, 0o700);
            await fs.rm(readonly, { recursive: true, force: true });
        }
    });

    it("checks the data directory only where deployments use it, and only a directory counts", async () => {
        const off = await status({
            deploymentsEnabled: false,
            dataDir: path.join(dataDir, "nope"),
        });
        expect(off.dependencies.dataDirectory).toBe("not-checked");
        expect(off.warnings.some((w) => w.includes("data directory"))).toBe(false);
        const file = path.join(dataDir, "a-file");
        await fs.writeFile(file, "x");
        const notDir = await status({ dataDir: file });
        expect(notDir.dependencies.dataDirectory).toBe("not-a-directory");
        expect(notDir.warnings).toContain("The data directory is not a directory.");
    });

    it("counts work only where it will be done, and a running deployment with no worker is work", async () => {
        await testDb.db.deleteFrom("worker_heartbeat").execute();
        // Overdue previews and waiting deletions exist (earlier tests), but with the lifecycle
        // off nothing will do them: no warning for that.
        await testDb.db.deleteFrom("deployment").execute();
        const off = await status({ lifecycleEnabled: false, deletionsAccepted: false });
        expect(off.warnings.some((w) => w.startsWith("No worker has reported"))).toBe(false);
        const on = await status();
        expect(on.warnings.some((w) => w.startsWith("No worker has reported"))).toBe(true);
        // A running deployment with nobody reporting is work too, whatever the lifecycle says.
        const artifact = await testDb.db
            .insertInto("artifact")
            .values({
                organization_id: org,
                digest: randomUUID().replaceAll("-", "").padEnd(64, "0"),
                size_bytes: 1,
                expanded_bytes: 1,
                entry_count: 1,
                storage_key: "y",
                created_by: people.ann!.userId,
            })
            .returning("id")
            .executeTakeFirstOrThrow();
        const preview = await makePreview();
        const d = await enqueueDeployment(
            testDb.db,
            people.ann!,
            org,
            preview,
            { artifactId: artifact.id },
            { enabled: true },
        );
        await testDb.db
            .updateTable("deployment")
            .set({ status: "building" })
            .where("id", "=", d.id)
            .execute();
        await testDb.db.deleteFrom("deletion_operation").execute();
        await testDb.db.updateTable("preview").set({ expires_at: null }).execute();
        const running = await status({ lifecycleEnabled: false, deletionsAccepted: false });
        expect(running.warnings.some((w) => w.startsWith("No worker has reported"))).toBe(true);
    });

    it("warns about a deployment that has not moved for too long, and a lifecycle without deployments", async () => {
        await beat("w-live");
        const stuck = await testDb.db
            .selectFrom("deployment")
            .select("id")
            .where("status", "=", "building")
            .executeTakeFirstOrThrow();
        const fresh = await status();
        expect(fresh.warnings.some((w) => w.includes("may be stuck"))).toBe(false);
        expect(fresh.deployments.oldestRunningSeconds).toBeLessThan(60);
        await testDb.db
            .updateTable("deployment")
            .set({ updated_at: new Date(Date.now() - (STUCK_RUNNING_SECONDS + 60) * 1000) })
            .where("id", "=", stuck.id)
            .execute();
        const old = await status();
        expect(old.warnings.some((w) => w.includes("may be stuck"))).toBe(true);
        expect(old.deployments.oldestRunningSeconds).toBeGreaterThan(STUCK_RUNNING_SECONDS);
        const noDeployments = await status({ deploymentsEnabled: false, deletionsAccepted: false });
        expect(noDeployments.warnings).toContain(
            "The lifecycle is on but deployments are off, so deletions are refused.",
        );
    });
});
