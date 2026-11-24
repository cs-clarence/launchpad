import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDatabase } from "@launchpad-kit/database/testing";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    assertModelMutationsReady,
    blockRestoredModel,
    markDeploymentRecoveryBlocked,
    recordModelWriterSeen,
    withModelMutation,
    withDeploymentRecoveryMaintenance,
    beginDeploymentImport,
    acknowledgeDeploymentImport,
    assertNoPendingDeploymentImport,
} from "../deployment-recovery";
import { getStatus } from "../status";
import {
    agreeingEvidence,
    clearWithSettledFixtures as clearDeploymentRecovery,
} from "../testing/recovery";
import { clearDeploymentRecovery as verifiedClear } from "../deployment-recovery";

let source: Awaited<ReturnType<typeof createTestDatabase>>;
let dataDir: string;
const marker = () => path.join(dataDir, "maintenance/deployment-recovery-blocked");
const seen = () => path.join(dataDir, "maintenance/model-writer-seen");
beforeEach(async () => {
    source = await createTestDatabase();
    await source.migrate();
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lp-recovery-"));
});
afterEach(async () => {
    vi.restoreAllMocks();
    await source?.destroy();
    if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
});

describe("deployment model recovery gate", () => {
    it("refuses importer acknowledgement without attestation or while its backend is alive", async () => {
        await markDeploymentRecoveryBlocked(dataDir);
        const record = await beginDeploymentImport(dataDir, "localhost:5432/fixture");
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        let connected!: () => void;
        let failSetup!: (error: unknown) => void;
        const ready = new Promise<void>((resolve, reject) => {
            connected = resolve;
            failSetup = reject;
        });
        const importer = source.db.connection().execute(async (connection) => {
            await sql`select set_config('application_name', ${record.applicationName}, false)`.execute(
                connection,
            );
            connected();
            try {
                await held;
            } finally {
                await sql`reset application_name`.execute(connection);
            }
        });
        importer.catch(failSetup);
        try {
            await ready;
            await expect(
                acknowledgeDeploymentImport(source.db, dataDir, record.databaseIdentity, false),
            ).rejects.toThrow(/Confirm/);
            await expect(
                acknowledgeDeploymentImport(source.db, dataDir, record.databaseIdentity, true),
            ).rejects.toThrow(/backend/);
            await expect(clearDeploymentRecovery(source.db, dataDir, true)).rejects.toThrow(
                /pg_restore/,
            );
        } finally {
            release();
            await importer;
        }
        await expect(
            acknowledgeDeploymentImport(source.db, dataDir, "wrong:5432/database", true),
        ).rejects.toThrow(/different database/);
        await expect(assertNoPendingDeploymentImport(dataDir)).rejects.toThrow(
            /previous pg_restore/,
        );
        await acknowledgeDeploymentImport(source.db, dataDir, record.databaseIdentity, true);
        await assertNoPendingDeploymentImport(dataDir);
        const audit = path.join(dataDir, `maintenance/deployment-import-ack-${record.id}`);
        expect(JSON.parse(await fs.readFile(audit, "utf8"))).toMatchObject({
            attestedStoppedImports: 1,
            activeImportBackends: 0,
            stoppedImporterAttested: true,
        });
        // Importer acknowledgement is not model reconciliation.
        await expect(assertModelMutationsReady(source.db, dataDir)).rejects.toThrow(/blocked/);
    });
    it("resyncs the parent after a failed directory sync left maintenance present", async () => {
        const open = fs.open.bind(fs);
        let parentSyncs = 0;
        vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
            const handle = await open(file, flags, mode);
            if (file === dataDir) {
                parentSyncs++;
                if (parentSyncs === 1)
                    vi.spyOn(handle, "sync").mockRejectedValueOnce(
                        new Error("parent fsync failed"),
                    );
            }
            return handle;
        });
        await expect(markDeploymentRecoveryBlocked(dataDir)).rejects.toThrow("parent fsync failed");
        expect((await fs.stat(path.join(dataDir, "maintenance"))).isDirectory()).toBe(true);
        await markDeploymentRecoveryBlocked(dataDir);
        expect(parentSyncs).toBe(2);
    });

    it("still syncs the directories when a rerun keeps an anchored marker", async () => {
        const anchor = {
            routerEpoch: "11111111-1111-4111-8111-111111111111",
            note: "recorded",
        } as const;
        const open = fs.open.bind(fs);
        let parentSyncs = 0;
        vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
            const handle = await open(file, flags, mode);
            if (file === dataDir) {
                parentSyncs++;
                if (parentSyncs === 1) {
                    vi.spyOn(handle, "sync").mockRejectedValueOnce(
                        new Error("parent fsync failed"),
                    );
                }
            }
            return handle;
        });
        await expect(markDeploymentRecoveryBlocked(dataDir, anchor)).rejects.toThrow(
            "parent fsync failed",
        );
        // The record is on disk and anchored, yet the rerun must still write and sync it again.
        await markDeploymentRecoveryBlocked(dataDir, anchor);
        expect(parentSyncs).toBe(2);
    });

    it("aborts a queued maintenance lock before any callback or recovery marker write", async () => {
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        let entered!: () => void;
        const ready = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const writer = withModelMutation(source.db, dataDir, async () => {
            entered();
            await held;
        });
        await ready;
        // The writer keeps its lock; a blocking acquisition fails this watchdog instead.
        let watchdog: ReturnType<typeof setTimeout> | undefined;
        const stuck = new Promise<never>((_, reject) => {
            watchdog = setTimeout(
                () => reject(new Error("watchdog: maintenance lock wait never settled")),
                2000,
            );
        });
        let called = false;
        try {
            await expect(
                Promise.race([
                    stuck,
                    withDeploymentRecoveryMaintenance(
                        source.db,
                        async () => {
                            called = true;
                            await markDeploymentRecoveryBlocked(dataDir);
                        },
                        AbortSignal.timeout(50),
                    ),
                ]),
            ).rejects.toThrow(/abort|timeout|timed out/i);
            expect(called).toBe(false);
            await expect(fs.stat(marker())).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
            clearTimeout(watchdog);
            release();
            await writer;
        }
    });
    it("allows a fresh database and refuses a missing or invalid gate row", async () => {
        await assertModelMutationsReady(source.db, dataDir);
        await source.db
            .deleteFrom("instance_state")
            .where("key", "=", "deployment_recovery")
            .execute();
        await expect(assertModelMutationsReady(source.db, dataDir)).rejects.toThrow(/gate/);
        await source.db
            .insertInto("instance_state")
            .values({ key: "deployment_recovery", value: "unknown" })
            .execute();
        await expect(assertModelMutationsReady(source.db, dataDir)).rejects.toThrow(/gate/);
    });

    it("keeps an external marker authoritative over a restored ready row", async () => {
        await markDeploymentRecoveryBlocked(dataDir);
        expect((await fs.stat(marker())).mode & 0o777).toBe(0o600);
        expect(JSON.parse(await fs.readFile(marker(), "utf8"))).toMatchObject({
            version: 2,
            routerEpoch: null,
            routerEpochNote: "not-configured",
        });
        await expect(assertModelMutationsReady(source.db, dataDir)).rejects.toThrow(/blocked/);
        // Read-only operator administration remains usable during recovery.
        expect(
            (await getStatus(source.db, { userId: "operator", instanceRole: "operator" }))
                .dependencies.database,
        ).toBe("ok");
        let called = false;
        await expect(
            withModelMutation(source.db, dataDir, async () => {
                called = true;
            }),
        ).rejects.toThrow(/blocked/);
        expect(called).toBe(false);
        await expect(fs.stat(seen())).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("blocks on the database gate even without the external marker", async () => {
        await blockRestoredModel(source.db);
        await expect(assertModelMutationsReady(source.db, dataDir)).rejects.toThrow(/gate/);
    });

    it("never clears without the attestation, whatever the files or tables hold", async () => {
        // An empty database with no writer record is exactly a never-used installation, and a
        // restore can also bring either condition: neither may substitute for the operator.
        await markDeploymentRecoveryBlocked(dataDir);
        await blockRestoredModel(source.db);
        await expect(clearDeploymentRecovery(source.db, dataDir, false)).rejects.toThrow(
            /i-have-checked-the-dokku-host/,
        );
        expect((await fs.stat(marker())).isFile()).toBe(true);
        await expect(assertModelMutationsReady(source.db, dataDir)).rejects.toThrow(/blocked/);
        await recordModelWriterSeen(dataDir);
        await expect(clearDeploymentRecovery(source.db, dataDir, false)).rejects.toThrow(
            /i-have-checked-the-dokku-host/,
        );
        expect((await fs.stat(marker())).isFile()).toBe(true);
    });

    it("clears with verified evidence and audits the host check", async () => {
        await markDeploymentRecoveryBlocked(dataDir);
        await blockRestoredModel(source.db);
        await clearDeploymentRecovery(source.db, dataDir, true);
        await expect(fs.stat(marker())).rejects.toMatchObject({ code: "ENOENT" });
        await assertModelMutationsReady(source.db, dataDir);
        const audit = await source.db
            .selectFrom("audit_event")
            .select(["actor", "action", "detail"])
            .where("action", "=", "deployment.recovery-cleared")
            .execute();
        expect(audit).toEqual([
            {
                actor: "operator-cli",
                action: "deployment.recovery-cleared",
                detail: "attested=checked-dokku-host",
            },
        ]);
    });

    it("refuses to skip the grace period or clear if required evidence is unavailable", async () => {
        await markDeploymentRecoveryBlocked(dataDir);
        await blockRestoredModel(source.db);
        await expect(
            verifiedClear(source.db, dataDir, true, undefined, {
                evidence: agreeingEvidence,
            }),
        ).rejects.toThrow(/25 minutes/);
        await expect(
            clearDeploymentRecovery(source.db, dataDir, true, undefined, {
                evidence: {
                    ...agreeingEvidence,
                    dokku: async () => {
                        throw new Error("host unavailable");
                    },
                },
            }),
        ).rejects.toThrow(/cannot verify Dokku/);
        await expect(assertModelMutationsReady(source.db, dataDir)).rejects.toThrow(/blocked/);
    });

    it("clears after a writer has run and with a populated model, once attested", async () => {
        await source.db
            .insertInto("user")
            .values({
                id: "u1",
                name: "Fixture",
                email: "fixture@example.invalid",
                emailVerified: false,
                role: "user",
            })
            .execute();
        await recordModelWriterSeen(dataDir);
        await markDeploymentRecoveryBlocked(dataDir);
        await blockRestoredModel(source.db);
        await clearDeploymentRecovery(source.db, dataDir, true);
        await assertModelMutationsReady(source.db, dataDir);
        // The writer record is untouched: it is history, no longer a rule.
        expect((await fs.stat(seen())).isFile()).toBe(true);
    });

    it("keeps the marker when the audit transaction fails", async () => {
        await markDeploymentRecoveryBlocked(dataDir);
        await blockRestoredModel(source.db);
        await source.db.schema.dropTable("audit_event").execute();
        await expect(clearDeploymentRecovery(source.db, dataDir, true)).rejects.toThrow(
            /audit_event/,
        );
        expect((await fs.stat(marker())).isFile()).toBe(true);
        // The ready row rolled back with the failed audit, not only the marker holding.
        expect(
            (
                await source.db
                    .selectFrom("instance_state")
                    .select("value")
                    .where("key", "=", "deployment_recovery")
                    .executeTakeFirstOrThrow()
            ).value,
        ).toBe("blocked");
    });

    it("refuses on an uninitialized database with a clear error", async () => {
        const old = await createTestDatabase();
        try {
            await expect(clearDeploymentRecovery(old.db, dataDir, true)).rejects.toThrow(
                /Initialize the database/,
            );
        } finally {
            await old.destroy();
        }
    });

    it("refuses a populated database without the attestation", async () => {
        await source.db
            .insertInto("user")
            .values({
                id: randomUUID(),
                name: "Fixture",
                email: "populated@example.invalid",
                emailVerified: false,
                role: "user",
            })
            .execute();
        await markDeploymentRecoveryBlocked(dataDir);
        await blockRestoredModel(source.db);
        await expect(clearDeploymentRecovery(source.db, dataDir, false)).rejects.toThrow(
            /i-have-checked-the-dokku-host/,
        );
        expect((await fs.stat(marker())).isFile()).toBe(true);
    });

    it("records the writer before its first effect and retains that fact after a rollback", async () => {
        await expect(
            withModelMutation(source.db, dataDir, async (trx) => {
                expect((await fs.stat(seen())).isFile()).toBe(true);
                expect((await fs.stat(seen())).mode & 0o777).toBe(0o600);
                await trx
                    .insertInto("audit_event")
                    .values({
                        actor: "test",
                        action: "test.effect",
                        target_type: "instance",
                        target_id: "self",
                        organization_id: null,
                        detail: null,
                    })
                    .execute();
                throw new Error("simulated crash");
            }),
        ).rejects.toThrow("simulated crash");
        expect(
            await source.db
                .selectFrom("audit_event")
                .selectAll()
                .where("action", "=", "test.effect")
                .execute(),
        ).toEqual([]);
        expect((await fs.stat(seen())).isFile()).toBe(true);
    });

    it("aborts before the effect when writer-seen cannot be created safely", async () => {
        await fs.mkdir(path.join(dataDir, "maintenance"), { mode: 0o700 });
        await fs.symlink(path.join(dataDir, "not-a-writer-record"), seen());
        let called = false;
        await expect(
            withModelMutation(source.db, dataDir, async () => {
                called = true;
            }),
        ).rejects.toThrow();
        expect(called).toBe(false);
        await expect(fs.stat(path.join(dataDir, "not-a-writer-record"))).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("fails closed on a missing data mount or unsafe maintenance directory", async () => {
        await expect(
            assertModelMutationsReady(source.db, path.join(dataDir, "missing-mount")),
        ).rejects.toThrow();
        const outside = path.join(dataDir, "outside");
        await fs.mkdir(outside);
        await fs.symlink(outside, path.join(dataDir, "maintenance"));
        await expect(assertModelMutationsReady(source.db, dataDir)).rejects.toThrow(
            /plain directory/,
        );
        await expect(markDeploymentRecoveryBlocked(dataDir)).rejects.toThrow(/plain directory/);
    });

    it("serializes restore maintenance against a running model transaction", async () => {
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        let entered!: () => void;
        const ready = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const writer = withModelMutation(source.db, dataDir, async () => {
            entered();
            await held;
        });
        try {
            await ready;
            await source.db.connection().execute(async (connection) => {
                await sql`set lock_timeout = '250ms'`.execute(connection);
                try {
                    await expect(
                        withDeploymentRecoveryMaintenance(connection, async () => {}),
                    ).rejects.toThrow(/lock timeout/);
                } finally {
                    await sql`reset lock_timeout`.execute(connection);
                }
            });
        } finally {
            release();
            await writer;
        }
    });
});
