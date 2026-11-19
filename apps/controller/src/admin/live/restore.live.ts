import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDatabase, testDatabaseUrl } from "@launchpad-kit/database/testing";
import { createDokkuClient } from "@launchpad-kit/dokku";
import {
    beginLifecycle,
    claimDeletion,
    createOrganization,
    createProject,
    extendPreview,
    lifecycleConfigFromEnv,
    requestPreviewDeletion,
    runDeletion,
    runLifecycleOnce,
    uploadArtifact,
    type DeployContext,
    type Principal,
} from "@launchpad-kit/services";
import { SITE, tarGz } from "@launchpad-kit/services/testing";
import { sql } from "kysely";
import { expect, it } from "vitest";
import { createBackup } from "../backup";
import { checkRestore, restoreBackup } from "../restore";

// A deliberately separate, opt-in test. Production preview names and the default Dokku client
// accept only lp-<10>; the test changes the CHECK constraint in *its disposable database only*
// and injects a test-only allowlist into the client/deletion ports. Neither production rule changes.
const APP = /^lp-test-[a-z0-9]{6}$/;
const TEST_HOST = "127.0.0.1";
const TEST_PORT = "33022";
const TEST_DATA = "/tmp/opencode/live-dokku-20261117/data";
const created = new Set<string>();
const diagnostic = (error: unknown) =>
    error instanceof Error
        ? `${error.message} ${"detail" in error ? String(error.detail) : ""}`
        : String(error);

function requireDisposable() {
    const env = process.env;
    const url = new URL(testDatabaseUrl());
    if (
        env.LAUNCHPAD_LIVE_DOKKU !== "1" ||
        env.DOKKU_SSH_HOST !== TEST_HOST ||
        env.DOKKU_SSH_PORT !== TEST_PORT ||
        url.href !== "postgres://postgres:dev@127.0.0.1:55432/postgres" ||
        env.DOKKU_SSH_KEY_PATH !== "/tmp/opencode/live-dokku-20261117/id_ed25519" ||
        env.DOKKU_SSH_KNOWN_HOSTS_PATH !== "/tmp/opencode/live-dokku-20261117/known_hosts"
    ) {
        throw new Error(
            "Restore live drill requires the approved disposable Dokku and test database.",
        );
    }
    const inspected = spawnSync(
        "docker",
        [
            "inspect",
            "--format",
            "{{.State.Running}} {{json .HostConfig.PortBindings}} {{range .Mounts}}{{.Source}} {{end}}",
            "launchpad-live-dokku",
        ],
        {
            encoding: "utf8",
            timeout: 15_000,
        },
    );
    if (
        inspected.status !== 0 ||
        !inspected.stdout.startsWith("true ") ||
        !inspected.stdout.includes(TEST_DATA) ||
        !inspected.stdout.includes('"HostIp":"127.0.0.1","HostPort":"33022"') ||
        !inspected.stdout.includes('"HostIp":"127.0.0.1","HostPort":"39080"')
    ) {
        throw new Error(
            "The approved disposable Dokku must be running with its isolated data mount.",
        );
    }
    const database = spawnSync(
        "docker",
        [
            "inspect",
            "--format",
            "{{.State.Running}} {{json .HostConfig.PortBindings}}",
            "launchpad-test-db",
        ],
        { encoding: "utf8", timeout: 15_000 },
    );
    if (
        database.status !== 0 ||
        !database.stdout.startsWith("true ") ||
        !database.stdout.includes('"HostIp":"127.0.0.1","HostPort":"55432"')
    ) {
        throw new Error("The disposable PostgreSQL container must own loopback port 55432.");
    }
}

function pgTool(name: "pg_dump" | "pg_restore") {
    return `#!/bin/sh\ndocker exec -i -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGUSER -e PGPASSWORD -e PGDATABASE launchpad-test-db ${name} "$@"\n`;
}

it(
    "rehearses stop, settled remote destroy, restore, detect, redeploy, extend and delete",
    { timeout: 12 * 60_000 },
    async () => {
        requireDisposable();
        // Leave four minutes before Vitest's own timeout for bounded, exact-name cleanup.
        // Survives an abrupt test-process exit; never record the URL (it holds credentials).
        const record = `/tmp/opencode/launchpad-restore-live-${randomUUID()}.log`;
        await fs.writeFile(record, "Disposable restore drill resources (exact names only)\n", {
            mode: 0o600,
        });
        console.info(`Restore drill resource record: ${record}`);
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "launchpad-restore-live-"));
        const note = (kind: string, name: string) => fs.appendFile(record, `${kind}: ${name}\n`);
        const deadline = new AbortController();
        const deadlineTimer = setTimeout(() => deadline.abort(), 8 * 60_000);
        const signal = deadline.signal;
        const sourceData = path.join(root, "source");
        const targetData = path.join(root, "target");
        const backupDir = path.join(root, "backup");
        let source: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
        let target: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
        const dokku = createDokkuClient(
            {
                host: TEST_HOST,
                port: Number(TEST_PORT),
                username: "dokku",
                privateKeyPath: process.env.DOKKU_SSH_KEY_PATH!,
                knownHostsPath: process.env.DOKKU_SSH_KNOWN_HOSTS_PATH!,
            },
            { appNamePattern: APP },
        );
        // Test-only cross-app adapter: load the worker's real ports without making the controller
        // package depend on the worker or changing either production runtime.
        const worker = path.resolve(import.meta.dirname, "../../../../worker/src");
        const [{ createDocker }, { createDeployPorts }, { createLifecyclePorts }] =
            await Promise.all([
                import(path.join(worker, "docker.ts")),
                import(path.join(worker, "ports.ts")),
                import(path.join(worker, "lifecycle-ports.ts")),
            ]);
        const docker = createDocker({ binary: "docker" });
        const portsFor = (dataDir: string) =>
            createDeployPorts({
                dokku,
                docker,
                dataDir,
                limits: { maxExpandedBytes: 10 * 1024 * 1024, maxEntries: 100, maxDepth: 8 },
                baseImage: "nginx:1.27-alpine",
                probe: {
                    proxyUrl: new URL("http://127.0.0.1:39080"),
                    timeoutMs: 120_000,
                    intervalMs: 2000,
                },
            });
        const names = new Map<string, { id: string; app: string; deploymentId: string }>();
        let drillError: unknown;
        let cleanupError: unknown;
        try {
            source = await createTestDatabase();
            await note("database", new URL(source.url).pathname.slice(1));
            await source.migrate();
            // This DB is exclusively ours and is dropped below, including this test-only constraint.
            await sql`alter table preview drop constraint preview_app_name_check`.execute(
                source.db,
            );
            await sql`alter table preview add constraint preview_app_name_check
            check (app_name ~ '^lp-test-[a-z0-9]{6}$')`.execute(source.db);
            const operatorId = randomUUID();
            const ownerId = randomUUID();
            for (const [id, role, email] of [
                [operatorId, "operator", "restore-operator@example.invalid"],
                [ownerId, "user", "restore-owner@example.invalid"],
            ] as const) {
                await source.db
                    .insertInto("user")
                    .values({
                        id,
                        name: role,
                        email,
                        emailVerified: false,
                        image: null,
                        role,
                    })
                    .execute();
                await source.db
                    .insertInto("audit_event")
                    .values({
                        actor: "operator-cli",
                        action: "user.provisioned",
                        target_type: "user",
                        target_id: id,
                    })
                    .execute();
            }
            const org = (
                await createOrganization(
                    source.db,
                    { userId: operatorId, instanceRole: "operator" },
                    {
                        name: "Restore fixture",
                        slug: "restore-fixture",
                        ownerEmail: "restore-owner@example.invalid",
                    },
                )
            ).id;
            const principal: Principal = { userId: ownerId, instanceRole: "user" };
            const project = await createProject(source.db, principal, org, {
                name: "Site",
                slug: "site",
            });
            const bytes = tarGz(SITE);
            const artifact = await uploadArtifact(
                source.db,
                principal,
                org,
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(bytes);
                        controller.close();
                    },
                }),
                { contentLength: bytes.length },
                { dataDir: sourceData, limits: {} },
            );
            const storageKey = (
                await source.db
                    .selectFrom("artifact")
                    .select("storage_key")
                    .where("id", "=", artifact.id)
                    .executeTakeFirstOrThrow()
            ).storage_key;
            const initialPorts = portsFor(sourceData);
            for (const slug of ["kept", "expired", "ending"]) {
                const app = `lp-test-${randomBytes(3).toString("hex")}`;
                if (!APP.test(app) || (await dokku.apps.exists(app, signal))) {
                    throw new Error(`Test app ${app} already exists; refusing to adopt it.`);
                }
                // Register before create: a lost create response still leaves only this exact app to clean up.
                created.add(app);
                await note("app", app);
                const id = randomUUID();
                const deploymentId = randomUUID();
                const hostname = `${app}.live.example.com`;
                await source.db
                    .insertInto("preview")
                    .values({
                        id,
                        organization_id: org,
                        project_id: project.id,
                        slug,
                        app_name: app,
                        hostname,
                        created_by: ownerId,
                    })
                    .execute();
                await source.db
                    .insertInto("deployment")
                    .values({
                        id: deploymentId,
                        organization_id: org,
                        preview_id: id,
                        artifact_id: artifact.id,
                        status: "succeeded",
                        requested_by: ownerId,
                    })
                    .execute();
                await source.db
                    .updateTable("preview")
                    .set({ active_deployment_id: deploymentId })
                    .where("id", "=", id)
                    .execute();
                const context: DeployContext = {
                    appName: app,
                    hostname,
                    deploymentId,
                    storageKey,
                    spa: false,
                };
                await dokku.apps.create(app, signal);
                const { imageTag } = await initialPorts.build(context, signal);
                await dokku.domains.set(app, hostname, signal);
                await dokku.ports.set(app, "http:80:80", signal);
                await initialPorts.loadImage(context, imageTag, signal).catch((error: unknown) => {
                    throw new Error(`Test app ${app} could not load: ${diagnostic(error)}`);
                });
                await initialPorts.verify(context, signal);
                names.set(slug, { id, app, deploymentId });
            }
            await beginLifecycle(source.db); // record that the one-time first-enable grace was used.
            await source.db
                .updateTable("preview")
                .set({ expires_at: sql<Date>`now() - interval '1 day'` })
                .where("id", "=", names.get("expired")!.id)
                .execute();
            const pgDump = path.join(root, "pg_dump.sh");
            const pgRestore = path.join(root, "pg_restore.sh");
            await fs.writeFile(pgDump, pgTool("pg_dump"), { mode: 0o700 });
            await fs.writeFile(pgRestore, pgTool("pg_restore"), { mode: 0o700 });
            await createBackup({
                db: source.db,
                databaseUrl: source.url,
                dataDir: sourceData,
                dest: backupDir,
                workersStopped: true,
                lifecycleEnabled: false,
                version: "restore-live-test",
                pgDump,
                signal,
            });
            // Step 1: the deletion began after the backup. This test-only port holds the remote
            // command after the worker has issued it, models stopping the local worker, and lets the
            // command complete on Dokku after the local signal. Wait for that completion AND the
            // deliberately shortened test lease before touching the backup.
            await requestPreviewDeletion(source.db, principal, org, names.get("ending")!.id, {
                enabled: true,
            });
            const deps = { enabled: true, ownedApp: APP };
            const claim = await claimDeletion(source.db, "restore-worker-test", deps, 1000);
            expect(claim).not.toBeNull();
            let entered!: () => void;
            let release!: () => void;
            const started = new Promise<void>((resolve) => {
                entered = resolve;
            });
            const resume = new Promise<void>((resolve) => {
                release = resolve;
            });
            const stopSignal = new AbortController();
            const lifecycle = createLifecyclePorts({ dokku, docker });
            const interrupted = runDeletion(
                source.db,
                claim!,
                {
                    ...lifecycle,
                    dokku: {
                        apps: {
                            exists: (app: string, signal?: AbortSignal) =>
                                dokku.apps.exists(app, signal),
                            destroy: async (app: string) => {
                                entered();
                                await resume;
                                await dokku.apps.destroy(app, signal); // remote outlives local stop, not the drill deadline
                                throw new Error(
                                    "The stopped worker did not receive the remote result.",
                                );
                            },
                        },
                    },
                },
                deps,
                { signal: AbortSignal.any([stopSignal.signal, signal]) },
            );
            await Promise.race([
                started,
                interrupted.then(() => {
                    throw new Error("Deletion finished before the remote destroy began.");
                }),
                new Promise<never>((_, reject) =>
                    signal.addEventListener(
                        "abort",
                        () => reject(new Error("Drill deadline reached.")),
                        {
                            once: true,
                        },
                    ),
                ),
            ]);
            stopSignal.abort();
            release();
            await interrupted;
            expect(await dokku.apps.exists(names.get("ending")!.app, signal)).toBe(false);
            // The other missing app is deliberately kept: unlike `ending`, it must be
            // recreated and deployed from the restored artifact in step 4.
            await dokku.apps.destroy(names.get("kept")!.app, signal);
            expect(await dokku.apps.exists(names.get("kept")!.app, signal)).toBe(false);
            await new Promise((resolve) => setTimeout(resolve, 1200)); // > the test's 1s lease
            await source.destroy();
            source = undefined;
            // Steps 2–4: matched dump/files, then read-only detection with the real guarded Dokku
            // client. The missing app must be listed, and the expired preview extended while
            // lifecycle remains off.
            target = await createTestDatabase();
            await note("database", new URL(target.url).pathname.slice(1));
            await restoreBackup({
                backupDir,
                databaseUrl: target.url,
                dataDir: targetData,
                workersStopped: true,
                pgRestore,
                signal,
            });
            const report = await checkRestore({
                db: target.db,
                dataDir: targetData,
                appExists: (name) => dokku.apps.exists(name, signal),
            });
            expect(report.missingFiles).toEqual([]);
            expect(report.missingApps.map((item) => item.appName).sort()).toEqual(
                [names.get("ending")!.app, names.get("kept")!.app].sort(),
            );
            expect(report.expired.map((item) => item.slug)).toEqual(["expired"]);
            const restoredPorts = portsFor(targetData);
            const kept = names.get("kept")!;
            const newDeploymentId = randomUUID();
            const context: DeployContext = {
                appName: kept.app,
                hostname: `${kept.app}.live.example.com`,
                deploymentId: newDeploymentId,
                storageKey,
                spa: false,
            };
            await dokku.apps.create(kept.app, signal);
            const { imageTag } = await restoredPorts.build(context, signal);
            await restoredPorts.loadImage(context, imageTag, signal).catch((error: unknown) => {
                throw new Error(`Kept preview could not redeploy: ${diagnostic(error)}`);
            });
            await restoredPorts.verify(context, signal);
            await target.db
                .insertInto("deployment")
                .values({
                    id: newDeploymentId,
                    organization_id: org,
                    preview_id: kept.id,
                    artifact_id: artifact.id,
                    status: "succeeded",
                    requested_by: ownerId,
                })
                .execute();
            await target.db
                .updateTable("preview")
                .set({ active_deployment_id: newDeploymentId })
                .where("id", "=", kept.id)
                .execute();
            await extendPreview(
                target.db,
                principal,
                org,
                names.get("expired")!.id,
                { ttl: "7d" },
                {
                    previewDomain: "live.example.com",
                    lifecycle: lifecycleConfigFromEnv({ LAUNCHPAD_LIFECYCLE: "off" }),
                },
            );
            // Step 5: lifecycle resumes. The extended preview survives; the chosen-to-end
            // preview is deleted (its missing app is not recreated just to remove it).
            await requestPreviewDeletion(target.db, principal, org, names.get("ending")!.id, {
                enabled: true,
            });
            const result = await runLifecycleOnce(target.db, lifecycle, {
                owner: "restore-worker-test",
                config: lifecycleConfigFromEnv({ LAUNCHPAD_LIFECYCLE: "on" }),
                dataDir: targetData,
                deletion: { ownedApp: APP },
                leaseMs: 1000,
            });
            expect(result.deletion).toBe("succeeded");
            expect(await dokku.apps.exists(names.get("ending")!.app, signal)).toBe(false);
            const ended = await target.db
                .selectFrom("preview")
                .select("desired_state")
                .where("id", "=", names.get("ending")!.id)
                .executeTakeFirstOrThrow();
            expect(ended.desired_state).toBe("deleted");
            const expired = await target.db
                .selectFrom("preview")
                .select("desired_state")
                .where("id", "=", names.get("expired")!.id)
                .executeTakeFirstOrThrow();
            expect(expired.desired_state).toBe("active");
            expect(await dokku.apps.exists(kept.app, signal)).toBe(true);
            expect(await dokku.apps.exists(names.get("expired")!.app, signal)).toBe(true);
        } catch (error) {
            drillError = error;
        } finally {
            clearTimeout(deadlineTimer);
            // A separate deadline ensures a stalled SSH cleanup cannot wait until Vitest
            // terminates its worker. Any leftovers are reported by exact test-only name.
            const cleanupSignal = AbortSignal.timeout(3 * 60_000);
            const leftover: string[] = [];
            for (const app of created) {
                if (!APP.test(app)) continue;
                try {
                    if (await dokku.apps.exists(app, cleanupSignal))
                        await dokku.apps.destroy(app, cleanupSignal);
                    if (await dokku.apps.exists(app, cleanupSignal)) leftover.push(app);
                } catch {
                    leftover.push(app);
                }
            }
            const cleaned = await Promise.allSettled([
                target?.destroy(),
                source?.destroy(),
                fs.rm(root, { recursive: true, force: true }),
            ]);
            if (leftover.length > 0) {
                cleanupError = new Error(
                    `Test apps still need exact-name cleanup: ${leftover.join(", ")}`,
                );
            }
            const failures = cleaned.flatMap((result, index) =>
                result.status === "rejected"
                    ? [
                          new Error(
                              `${["target database", "source database", "temporary directory"][index]} cleanup failed`,
                              { cause: result.reason },
                          ),
                      ]
                    : [],
            );
            if (failures.length)
                cleanupError = new AggregateError(
                    [cleanupError, ...failures].filter(Boolean),
                    "Restore drill cleanup failed.",
                );
            await note("cleanup", cleanupError ? "incomplete" : "completed").catch((error) => {
                cleanupError = new AggregateError(
                    [cleanupError, error].filter(Boolean),
                    `Could not update resource record ${record}`,
                );
            });
        }
        if (drillError || cleanupError)
            throw new AggregateError(
                [drillError, cleanupError].filter(Boolean),
                `Restore drill failed; exact resource names: ${record}`,
            );
    },
);
