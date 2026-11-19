import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateToLatest } from "@launchpad-kit/database";
import { createTestDatabase } from "@launchpad-kit/database/testing";
import {
    createOrganization,
    recordHeartbeat,
    resolveArtifactPath,
    uploadArtifact,
    type Principal,
} from "@launchpad-kit/services";
import { SITE, tarGz } from "@launchpad-kit/services/testing";
import { spawnSync } from "node:child_process";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BackupError, createBackup, pgEnvironment, verifyBackup } from "../backup";

// pg_dump runs inside the disposable PostgreSQL container, so its version always matches the
// server (a host client older than the server refuses to dump). The wrapper keeps the program
// the backup runs identical to production: it still receives its settings in PG* variables.
const CONTAINER = "launchpad-test-db";
// The container wrapper is for the default fixture. Another server named by TEST_DATABASE_URL
// needs a matching client: TEST_PG_DUMP and TEST_PG_RESTORE name them (default: on PATH).
const usesFixture = (() => {
    const url = new URL(process.env.TEST_DATABASE_URL ?? "postgres://x@127.0.0.1:55432/");
    return (
        ["127.0.0.1", "localhost"].includes(url.hostname) &&
        url.port === (process.env.TEST_DB_PORT ?? "55432")
    );
})();
const pgRestore = (input: Buffer) =>
    usesFixture
        ? spawnSync(
              "docker",
              ["exec", "-i", CONTAINER, "pg_restore", "--data-only", "-t", "artifact", "-f", "-"],
              { input, maxBuffer: 64 * 1024 * 1024 },
          )
        : spawnSync(
              process.env.TEST_PG_RESTORE ?? "pg_restore",
              ["--data-only", "-t", "artifact", "-f", "-"],
              { input, maxBuffer: 64 * 1024 * 1024 },
          );

let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
let work = "";
let dataDir = "";
let org = "";
let owner: Principal;
let plainDump = "";
let pausedDump = "";
let pausedBefore = "";
let markerBefore = "";
let releaseBefore = "";
let marker = "";
let release = "";
let counter = 0;

// Bounded, so a test that fails before releasing it cannot leave a shell looping forever.
const waitFor = (mark: string, release: string) =>
    `touch "${mark}"\nfor i in $(seq 1 600); do [ -e "${release}" ] && break; sleep 0.1; done`;

const dumpCommand = usesFixture
    ? `docker exec -i -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGUSER -e PGPASSWORD -e PGDATABASE ${CONTAINER} pg_dump "$@"`
    : `${process.env.TEST_PG_DUMP ?? "pg_dump"} "$@"`;

const wrapper = (before = "", after = "") =>
    `#!/bin/sh
${before}
${dumpCommand}
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
const firstDigest = async () =>
    testDb.db
        .selectFrom("artifact")
        .select("digest")
        .where("collected_at", "is", null)
        .orderBy("created_at")
        .limit(1)
        .executeTakeFirstOrThrow();
const fresh = () => path.join(work, `backup-${++counter}`);

beforeAll(async () => {
    work = await fs.mkdtemp(path.join(os.tmpdir(), "launchpad-backup-"));
    dataDir = path.join(work, "data");
    marker = path.join(work, "dumped");
    release = path.join(work, "release");
    plainDump = path.join(work, "pg_dump_plain.sh");
    pausedDump = path.join(work, "pg_dump_paused.sh");
    await fs.writeFile(plainDump, wrapper(), { mode: 0o700 });
    await fs.writeFile(pausedDump, wrapper("", waitFor(marker, release)), { mode: 0o700 });
    markerBefore = path.join(work, "before-dump");
    releaseBefore = path.join(work, "release-before");
    pausedBefore = path.join(work, "pg_dump_paused_before.sh");
    await fs.writeFile(pausedBefore, wrapper(waitFor(markerBefore, releaseBefore)), {
        mode: 0o700,
    });
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
    it("strips the brackets around an IPv6 host", () => {
        expect(pgEnvironment("postgres://u:p@[::1]:5432/launch").PGHOST).toBe("::1");
    });

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
        try {
            await expect(createBackup(options(fresh()))).rejects.toThrow(BackupError);
            await expect(
                createBackup(options(fresh(), { workersStopped: true, lifecycleEnabled: true })),
            ).resolves.toBeTruthy();
        } finally {
            await testDb.db.deleteFrom("worker_heartbeat").execute();
        }
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

    it("backs up a database whose migrations are pending, and refuses one a newer build migrated", async () => {
        // The folder this build "ships": every applied migration by name, plus one not applied.
        const source = path.resolve(
            import.meta.dirname,
            "../../../../../packages/database/src/migrations",
        );
        const folder = path.join(work, "behind-migrations");
        await fs.mkdir(folder);
        for (const file of await fs.readdir(source)) {
            await fs.writeFile(path.join(folder, file), "export async function up() {}");
        }
        await fs.writeFile(
            path.join(folder, "20991231_900_pending_check.mjs"),
            "export async function up() {}",
        );
        const before = process.env.LAUNCHPAD_MIGRATIONS_DIR;
        process.env.LAUNCHPAD_MIGRATIONS_DIR = folder;
        try {
            const dest = fresh();
            const manifest = await createBackup(options(dest));
            expect(manifest.migrations).not.toContain("20991231_900_pending_check");
            expect(manifest.migrations.length).toBeGreaterThan(10);
            expect(await verifyBackup(dest)).toEqual([]);
        } finally {
            if (before === undefined) delete process.env.LAUNCHPAD_MIGRATIONS_DIR;
            else process.env.LAUNCHPAD_MIGRATIONS_DIR = before;
        }
        await sql`insert into launchpad_migration (name, timestamp) values ('20991231_999_newer', now()::text)`.execute(
            testDb.db,
        );
        try {
            await expect(createBackup(options(fresh()))).rejects.toThrow(/does not know/);
        } finally {
            await sql`delete from launchpad_migration where name = '20991231_999_newer'`.execute(
                testDb.db,
            );
        }
    });

    it("backs up a database at an older schema (before the artifact and heartbeat columns existed)", async () => {
        // The first fourteen real migrations only: no collected_at, no lifecycle_enabled.
        const source = path.resolve(import.meta.dirname, "../../../../../packages/database/src");
        const root = path.join(work, "old-schema");
        const folder = path.join(root, "migrations");
        await fs.mkdir(folder, { recursive: true });
        await fs.copyFile(path.join(source, "auth-schema.ts"), path.join(root, "auth-schema.ts"));
        const files = (await fs.readdir(path.join(source, "migrations"))).sort();
        for (const file of files.slice(0, 14)) {
            await fs.copyFile(path.join(source, "migrations", file), path.join(folder, file));
        }
        const old = await createTestDatabase();
        try {
            await migrateToLatest(old.db, folder);
            const dest = fresh();
            const manifest = await createBackup({
                ...options(dest),
                db: old.db,
                databaseUrl: old.url,
            });
            expect(manifest.migrations).toHaveLength(14);
            expect(manifest.artifacts).toEqual([]);
            expect(await verifyBackup(dest)).toEqual([]);
        } finally {
            await old.destroy();
        }
    });

    it("finds the tables through the search path when the user's own schema is empty", async () => {
        const { rows } = await sql<{ name: string }>`select current_user as name`.execute(
            testDb.db,
        );
        const schema = rows[0]!.name;
        const stored = await upload("search-path");
        await sql.raw(`create schema "${schema}"`).execute(testDb.db);
        try {
            const dest = fresh();
            const manifest = await createBackup(options(dest));
            // An empty list would be a silently incomplete backup.
            expect(manifest.artifacts.map((x) => x.sha256)).toContain(stored.digest);
            expect(await verifyBackup(dest)).toEqual([]);
        } finally {
            await sql.raw(`drop schema "${schema}"`).execute(testDb.db);
        }
    });

    it("dumps the snapshot the rows were read in, not a later state", async () => {
        await fs.rm(markerBefore, { force: true });
        await fs.rm(releaseBefore, { force: true });
        const dest = fresh();
        // pg_dump is held back until after the artifact rows were read.
        const running = createBackup(options(dest, { pgDump: pausedBefore }));
        const outcome = running.then(
            (manifest) => ({ manifest }),
            (error) => ({ error }),
        );
        for (let i = 0; i < 200 && !(await fs.stat(markerBefore).catch(() => null)); i++) {
            await new Promise((r) => setTimeout(r, 100));
        }
        const late = await upload("committed-before-the-dump");
        await fs.writeFile(releaseBefore, "");
        const result = await outcome;
        expect("error" in result ? String(result.error) : "").toBe("");
        const text = pgRestore(
            await fs.readFile(path.join(dest, "database.dump")),
        ).stdout.toString();
        expect(text).toContain(Object.values(await firstDigest())[0]!);
        // Without --snapshot the dump would hold this row, whose file was never copied.
        expect(text).not.toContain(late.digest);
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
        await upload("verify-1");
        await upload("verify-2");
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
        // A link in place of a file is not a plain file, whatever it points at.
        const second = manifest.artifacts[2]!;
        const linked = path.join(dest, second.storageKey);
        const content = await fs.readFile(linked);
        await fs.rm(linked);
        await fs.writeFile(path.join(work, "target.bin"), content);
        await fs.symlink(path.join(work, "target.bin"), linked);
        expect((await verifyBackup(dest)).join("\n")).toMatch(/not a plain file/);
        const raw = await fs.readFile(path.join(dest, "manifest.json"), "utf8");
        const parsed = JSON.parse(raw);
        await fs.writeFile(
            path.join(dest, "manifest.json"),
            JSON.stringify({ ...parsed, artifacts: [null, ...parsed.artifacts] }),
        );
        expect((await verifyBackup(dest)).join("\n")).toMatch(/entry is not an object/);
        await fs.writeFile(path.join(dest, "manifest.json"), "null");
        expect(await verifyBackup(dest)).toEqual([
            expect.stringMatching(/unsupported backup format/),
        ]);
        await fs.rm(path.join(dest, "manifest.json"));
        expect(await verifyBackup(dest)).toEqual([
            expect.stringMatching(/manifest.json is missing/),
        ]);
    });
});
