import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDatabase } from "@launchpad/database/testing";
import {
    createOrganization,
    recordHeartbeat,
    resolveArtifactPath,
    uploadArtifact,
    type Principal,
} from "@launchpad/services";
import { SITE, tarGz } from "@launchpad/services/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BackupError, createBackup, pgEnvironment, verifyBackup } from "../backup";

// pg_dump runs inside the disposable PostgreSQL container, so its version always matches the
// server (a host client older than the server refuses to dump). The wrapper keeps the program
// the backup runs identical to production: it still receives its settings in PG* variables.
const CONTAINER = "launchpad-test-db";

let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
let work = "";
let dataDir = "";
let org = "";
let owner: Principal;
let plainDump = "";
let pausedDump = "";
let marker = "";
let release = "";
let counter = 0;

const wrapper = (after = "") =>
    `#!/bin/sh
docker exec -i -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGUSER -e PGPASSWORD -e PGDATABASE ${CONTAINER} pg_dump "$@"
rc=$?
${after}
exit $rc
`;

async function upload(content: string) {
    const bytes = tarGz([...SITE, { name: `${content}.txt`, content }]);
    return uploadArtifact(
        testDb.db,
        owner,
        org,
        new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(bytes);
                controller.close();
            },
        }),
        { contentLength: bytes.length },
        { dataDir, limits: {} },
    );
}

const storedPath = async (digest: string) => {
    const row = await testDb.db
        .selectFrom("artifact")
        .select("storage_key")
        .where("digest", "=", digest)
        .executeTakeFirstOrThrow();
    return resolveArtifactPath(dataDir, row.storage_key);
};

const options = (dest: string, extra: Partial<Parameters<typeof createBackup>[0]> = {}) => ({
    db: testDb.db,
    databaseUrl: testDb.url,
    dataDir,
    dest,
    workersStopped: false,
    lifecycleEnabled: false,
    version: "0.0.0-test",
    pgDump: plainDump,
    ...extra,
});
const fresh = () => path.join(work, `backup-${++counter}`);

beforeAll(async () => {
    work = await fs.mkdtemp(path.join(os.tmpdir(), "launchpad-backup-"));
    dataDir = path.join(work, "data");
    marker = path.join(work, "dumped");
    release = path.join(work, "release");
    plainDump = path.join(work, "pg_dump_plain.sh");
    pausedDump = path.join(work, "pg_dump_paused.sh");
    await fs.writeFile(plainDump, wrapper(), { mode: 0o700 });
    await fs.writeFile(
        pausedDump,
        wrapper(`touch "${marker}"\nwhile [ ! -e "${release}" ]; do sleep 0.1; done`),
        { mode: 0o700 },
    );
    testDb = await createTestDatabase();
    await testDb.migrate();
    const rootId = randomUUID();
    const annId = randomUUID();
    for (const [id, name, role] of [
        [rootId, "root", "operator"],
        [annId, "ann", "user"],
    ] as const) {
        await testDb.db
            .insertInto("user")
            .values({
                id,
                name,
                email: `${name}@example.com`,
                emailVerified: false,
                image: null,
                role,
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
    }
    org = (
        await createOrganization(
            testDb.db,
            { userId: rootId, instanceRole: "operator" },
            { name: "Acme", slug: "acme", ownerEmail: "ann@example.com" },
        )
    ).id;
    owner = { userId: annId, instanceRole: "user" };
});
afterAll(async () => {
    await testDb?.destroy();
    if (work) await fs.rm(work, { recursive: true, force: true });
});

describe("pgEnvironment", () => {
    it("moves the connection settings into variables, never arguments", () => {
        expect(
            pgEnvironment("postgres://lp%40user:p%2Fw@db.example.com:6543/launch?sslmode=require"),
        ).toEqual({
            PGHOST: "db.example.com",
            PGPORT: "6543",
            PGUSER: "lp@user",
            PGPASSWORD: "p/w",
            PGDATABASE: "launch",
            PGSSLMODE: "require",
        });
    });
});

describe("createBackup", () => {
    it("writes a dump, exactly the live archives and a manifest that verifies", async () => {
        const a = await upload("one");
        const b = await upload("two");
        const dest = fresh();
        const manifest = await createBackup(options(dest));
        expect(manifest.artifacts.map((x) => x.sha256).sort()).toEqual([a.digest, b.digest].sort());
        expect(manifest.migrations.length).toBeGreaterThan(10);
        expect(await verifyBackup(dest)).toEqual([]);
        const dump = await fs.readFile(path.join(dest, "database.dump"));
        expect(dump.subarray(0, 5).toString()).toBe("PGDMP");
        expect((await fs.stat(dest)).mode & 0o777).toBe(0o700);
        expect((await fs.stat(path.join(dest, "database.dump"))).mode & 0o777).toBe(0o600);
    });

    it("never overwrites an existing backup", async () => {
        const dest = fresh();
        await createBackup(options(dest));
        await expect(createBackup(options(dest))).rejects.toThrow(/already exists/);
        expect(await verifyBackup(dest)).toEqual([]);
    });

    it("refuses beside the lifecycle or a live lifecycle worker unless the workers are confirmed stopped", async () => {
        await expect(createBackup(options(fresh(), { lifecycleEnabled: true }))).rejects.toThrow(
            /lifecycle is on/,
        );
        await recordHeartbeat(testDb.db, {
            workerId: "w1",
            version: "t",
            lifecycleEnabled: true,
            started: true,
        });
        await expect(createBackup(options(fresh()))).rejects.toThrow(BackupError);
        await expect(
            createBackup(options(fresh(), { workersStopped: true, lifecycleEnabled: true })),
        ).resolves.toBeTruthy();
        await testDb.db.deleteFrom("worker_heartbeat").execute();
    });

    it("fails and leaves nothing when a live archive's file is missing or altered", async () => {
        const gone = await upload("gone");
        const file = await storedPath(gone.digest);
        const kept = await fs.readFile(file);
        await fs.rm(file);
        const dest = fresh();
        await expect(createBackup(options(dest))).rejects.toThrow(/missing/);
        await expect(fs.stat(dest)).rejects.toThrow();
        await fs.writeFile(file, Buffer.concat([kept, Buffer.from("x")]));
        await expect(createBackup(options(fresh()))).rejects.toThrow(
            /does not match its recorded digest/,
        );
        await fs.writeFile(file, kept);
        await expect(createBackup(options(fresh()))).resolves.toBeTruthy();
    });

    it("reports a missing dump program clearly and leaves nothing", async () => {
        const dest = fresh();
        await expect(
            createBackup(options(dest, { pgDump: path.join(work, "no-such-pg_dump") })),
        ).rejects.toThrow(/was not found/);
        await expect(fs.stat(dest)).rejects.toThrow();
    });

    it("is consistent when an archive is uploaded between the dump and the copy", async () => {
        await fs.rm(marker, { force: true });
        await fs.rm(release, { force: true });
        const before = await testDb.db
            .selectFrom("artifact")
            .select((eb) => eb.fn.countAll<string>().as("n"))
            .where("collected_at", "is", null)
            .executeTakeFirstOrThrow();
        const dest = fresh();
        const running = createBackup(options(dest, { pgDump: pausedDump }));
        for (let i = 0; i < 200 && !(await fs.stat(marker).catch(() => null)); i++) {
            await new Promise((r) => setTimeout(r, 100));
        }
        const late = await upload("late");
        await fs.writeFile(release, "");
        const manifest = await running;
        expect(manifest.artifacts).toHaveLength(Number(before.n));
        expect(manifest.artifacts.map((x) => x.sha256)).not.toContain(late.digest);
        expect(await verifyBackup(dest)).toEqual([]);
    });

    it("fails when a file is removed between the dump and the copy", async () => {
        await fs.rm(marker, { force: true });
        await fs.rm(release, { force: true });
        const victim = await upload("victim");
        const dest = fresh();
        const running = createBackup(options(dest, { pgDump: pausedDump }));
        const outcome = running.then(
            () => "ok",
            (e) => String(e),
        );
        for (let i = 0; i < 200 && !(await fs.stat(marker).catch(() => null)); i++) {
            await new Promise((r) => setTimeout(r, 100));
        }
        await fs.rm(await storedPath(victim.digest));
        await fs.writeFile(release, "");
        expect(await outcome).toMatch(/missing/);
        await expect(fs.stat(dest)).rejects.toThrow();
        // Later tests share the database: the row without its file would fail them.
        await testDb.db.deleteFrom("artifact").where("digest", "=", victim.digest).execute();
    });
});

describe("verifyBackup", () => {
    it("finds a changed, missing or extra file", async () => {
        const dest = fresh();
        const manifest = await createBackup(options(dest));
        const first = manifest.artifacts[0]!;
        await fs.appendFile(path.join(dest, first.storageKey), "x");
        await fs.writeFile(path.join(dest, "extra.txt"), "x");
        await fs.rm(path.join(dest, manifest.artifacts[1]!.storageKey));
        const problems = await verifyBackup(dest);
        expect(problems.join("\n")).toMatch(/does not match/);
        expect(problems.join("\n")).toMatch(/missing/);
        expect(problems.join("\n")).toMatch(/extra.txt: not in the manifest/);
        await fs.rm(path.join(dest, "manifest.json"));
        expect(await verifyBackup(dest)).toEqual([
            expect.stringMatching(/manifest.json is missing/),
        ]);
    });
});
