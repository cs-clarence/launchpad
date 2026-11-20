import { randomUUID } from "node:crypto";
import { createDatabase } from "@launchpad-kit/database";
import { createTestDatabase } from "@launchpad-kit/database/testing";
import {
    beginDeploymentStep,
    claimDeployment,
    createApp,
    createDeployment,
    createOrganization,
    createProject,
    lockDeploymentRecovery,
    markDeploymentRecoveryBlocked,
    parseDeploymentConfig,
    uploadArtifact,
} from "@launchpad-kit/services";
import { SITE, tarGz } from "@launchpad-kit/services/testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DeploymentRunnerPorts } from "../deployment-runner";
import { workDeployments } from "../deployment-worker";
import { imageTagFor } from "../template";
import { tempDir } from "../testing";

let source: Awaited<ReturnType<typeof createTestDatabase>>;
let tmp: Awaited<ReturnType<typeof tempDir>>;

beforeEach(async () => {
    tmp = await tempDir();
    source = await createTestDatabase();
    await source.migrate();
});

afterEach(async () => {
    await source?.destroy();
    await tmp?.cleanup();
});

async function enqueue() {
    const { db } = source;
    const actor = { userId: randomUUID(), instanceRole: "operator" } as const;
    const email = "owner@example.com";
    await db
        .insertInto("user")
        .values({
            id: actor.userId,
            name: "Owner",
            email,
            emailVerified: true,
            role: "operator",
        })
        .execute();
    const org = await createOrganization(db, actor, {
        name: "Acme",
        slug: "acme",
        ownerEmail: email,
    });
    const project = await createProject(db, actor, org.id, { name: "Site", slug: "site" });
    const dataDir = tmp.dir;
    const deps = {
        dataDir,
        settings: parseDeploymentConfig({
            LAUNCHPAD_DEPLOYMENTS: "on",
            LAUNCHPAD_BASE_URL: "https://manage.example.org",
            LAUNCHPAD_APPS_DOMAIN: "sites.example.net",
        }),
    };
    const app = await createApp(db, actor, org.id, project.id, { slug: "site" }, deps);
    const bytes = tarGz(SITE);
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(bytes);
            controller.close();
        },
    });
    const artifact = await uploadArtifact(
        db,
        actor,
        org.id,
        body,
        { contentLength: bytes.length, projectId: project.id },
        { dataDir, limits: {} },
    );
    return createDeployment(db, actor, org.id, app.id, { artifactId: artifact.id }, deps);
}

function fixture() {
    const shutdown = new AbortController();
    const ports = {
        exists: vi.fn(async () => false),
        create: vi.fn(async () => {}),
        build: vi.fn<DeploymentRunnerPorts["build"]>(async ({ deploymentId }) => ({
            imageTag: imageTagFor(deploymentId),
            imageId: `sha256:${"a".repeat(64)}`,
        })),
        setDomain: vi.fn(async () => {}),
        setPort: vi.fn(async () => {}),
        load: vi.fn(async () => {}),
        verify: vi.fn(async () => {}),
    } satisfies DeploymentRunnerPorts;
    const markHealthy = vi.fn();
    return { shutdown, ports, markHealthy };
}

it("rejects a delayed result through the worker's real PostgreSQL store", async () => {
    const queued = await enqueue();
    const { shutdown, ports, markHealthy } = fixture();
    const release = Promise.withResolvers<void>();
    ports.verify.mockImplementationOnce(() => release.promise);
    const log = vi.fn((entry: Record<string, unknown>) => {
        if (entry.event === "deployment-run-ended" || entry.event === "deployment-worker-error")
            shutdown.abort();
    });
    const { db } = source;
    const worker = workDeployments({
        db,
        dataDir: tmp.dir,
        owner: "old",
        ports,
        markHealthy,
        log,
        shutdown: shutdown.signal,
    });
    try {
        await vi.waitFor(() => expect(ports.verify).toHaveBeenCalledOnce(), 10_000);
        expect(markHealthy).toHaveBeenCalled();
        await db
            .updateTable("deployment")
            .set({ lease_expires_at: new Date(0) })
            .where("id", "=", queued.id)
            .execute();
        const current = await claimDeployment(db, tmp.dir, "new");
        if (current.kind !== "claimed") throw new Error("Expected replacement claim");
        const before = await beginDeploymentStep(db, tmp.dir, current.token, "verify");
        expect(before).toMatchObject({ lease_owner: "new", step_pending: "verify" });
        const events = () =>
            db
                .selectFrom("app_deployment_event")
                .selectAll()
                .where("deployment_id", "=", queued.id)
                .orderBy("seq")
                .execute();
        const existing = await events();
        release.resolve();
        await worker;
        expect(log).toHaveBeenCalledWith({
            event: "deployment-run-ended",
            deploymentId: queued.id,
            status: "authority-lost",
        });
        expect(
            await db
                .selectFrom("deployment")
                .selectAll()
                .where("id", "=", queued.id)
                .executeTakeFirstOrThrow(),
        ).toEqual(before);
        expect(await events()).toEqual(existing);
        expect(ports.verify).toHaveBeenCalledOnce();
        expect(ports.load).toHaveBeenCalledOnce();
    } finally {
        shutdown.abort();
        release.resolve();
        await worker;
    }
});

it("does not dispatch or touch the health marker while recovery blocks the queue", async () => {
    const job = await enqueue();
    const { shutdown, ports, markHealthy } = fixture();
    await markDeploymentRecoveryBlocked(tmp.dir);
    const log = vi.fn(() => shutdown.abort());
    await workDeployments({
        db: source.db,
        dataDir: tmp.dir,
        owner: "blocked",
        ports,
        markHealthy,
        log,
        shutdown: shutdown.signal,
    });
    expect(log).toHaveBeenCalledExactlyOnceWith({ event: "deployment-recovery-blocked" });
    expect(markHealthy).not.toHaveBeenCalled();
    expect(ports.exists).not.toHaveBeenCalled();
    expect(
        await source.db
            .selectFrom("deployment")
            .select("status")
            .where("id", "=", job.id)
            .executeTakeFirstOrThrow(),
    ).toEqual({ status: "queued" });
});

it("fails the worker loop on a stalled claim and lets the caller close the pool", async () => {
    const job = await enqueue();
    const { shutdown, ports, markHealthy } = fixture();
    const db = createDatabase(source.url, { max: 2, closeTimeout: 0 });
    try {
        await source.db.transaction().execute(async (trx) => {
            await lockDeploymentRecovery(trx, true);
            await expect(
                workDeployments({
                    db,
                    dataDir: tmp.dir,
                    owner: "stalled",
                    ports,
                    markHealthy,
                    log: vi.fn(),
                    shutdown: shutdown.signal,
                    databaseTimeoutMs: 100,
                }),
            ).rejects.toThrow("Deployment worker database deadline exceeded.");
            // Close while the server still holds the lock; do not let the
            // abandoned transaction claim after the timeout.
            await db.destroy();
        });
        expect(ports.exists).not.toHaveBeenCalled();
        expect(markHealthy).not.toHaveBeenCalled();
        expect(
            await source.db
                .selectFrom("deployment")
                .select("status")
                .where("id", "=", job.id)
                .executeTakeFirstOrThrow(),
        ).toEqual({ status: "queued" });
    } finally {
        await db.destroy();
    }
}, 5000);
