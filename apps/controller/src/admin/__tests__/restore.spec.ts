import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateToLatest } from "@launchpad-kit/database";
import { createTestDatabase } from "@launchpad-kit/database/testing";
import {
    createOrganization,
    createProject,
    resolveArtifactPath,
    uploadArtifact,
    assertModelMutationsReady,
    clearImmutableRecovery,
    recordModelWriterSeen,
    acknowledgeImmutableImport,
    type Principal,
} from "@launchpad-kit/services";
import { SITE, tarGz } from "@launchpad-kit/services/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBackup, verifyBackup } from "../backup";
import { checkRestore, replaceTarget, restoreBackup } from "../restore";

// The PostgreSQL client programs run inside the disposable server's container (see backup.spec.ts);
// another TEST_DATABASE_URL server needs TEST_PG_DUMP and TEST_PG_RESTORE.
const CONTAINER = "launchpad-test-db";
const usesFixture = (() => {
    const url = new URL(process.env.TEST_DATABASE_URL ?? "postgres://x@127.0.0.1:55432/");
    return (
        ["127.0.0.1", "localhost"].includes(url.hostname) &&
        url.port === (process.env.TEST_DB_PORT ?? "55432")
    );
})();
const tool = (name: "pg_dump" | "pg_restore") =>
    usesFixture
        ? `docker exec -i -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGUSER -e PGPASSWORD -e PGDATABASE -e PGAPPNAME ${CONTAINER} ${name} "$@"`
        : `${process.env[name === "pg_dump" ? "TEST_PG_DUMP" : "TEST_PG_RESTORE"] ?? name} "$@"`;

let source: Awaited<ReturnType<typeof createTestDatabase>>;
let work = "";
let sourceData = "";
let dump = "";
let restoreTool = "";
let backupDir = "";
let owner: Principal;
let org = "";
let counter = 0;
const digests: string[] = [];
const targets: Awaited<ReturnType<typeof createTestDatabase>>[] = [];

const upload = async (content: string) => {
    const bytes = tarGz([...SITE, { name: `${content}.txt`, content }]);
    return uploadArtifact(
        source.db,
        owner,
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
};

const emptyTarget = async () => {
    const target = await createTestDatabase();
    targets.push(target);
    return target;
};
const dataDirectory = () => path.join(work, `data-${++counter}`);
const restoreOptions = (
    target: { url: string },
    extra: Partial<Parameters<typeof restoreBackup>[0]> = {},
) => {
    const options = {
        backupDir,
        databaseUrl: target.url,
        dataDir: dataDirectory(),
        workersStopped: true,
        pgRestore: restoreTool,
        ...extra,
    };
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
    return options;
};
const tableCount = async (db: Awaited<ReturnType<typeof createTestDatabase>>["db"]) =>
    Number(
        (
            await sql<{ n: string }>`
                select count(*) as n from pg_tables where schemaname = 'public'`.execute(db)
        ).rows[0]!.n,
    );

beforeAll(async () => {
    work = await fs.mkdtemp(path.join(os.tmpdir(), "launchpad-restore-"));
    sourceData = path.join(work, "source-data");
    dump = path.join(work, "pg_dump.sh");
    restoreTool = path.join(work, "pg_restore.sh");
    await fs.writeFile(dump, `#!/bin/sh\n${tool("pg_dump")}\n`, { mode: 0o700 });
    await fs.writeFile(restoreTool, `#!/bin/sh\n${tool("pg_restore")}\n`, { mode: 0o700 });
    source = await createTestDatabase();
    await source.migrate();
    const rootId = randomUUID();
    const annId = randomUUID();
    for (const [id, name, role] of [
        [rootId, "root", "operator"],
        [annId, "ann", "user"],
    ] as const) {
        await source.db
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
    org = (
        await createOrganization(
            source.db,
            { userId: rootId, instanceRole: "operator" },
            { name: "Acme", slug: "acme", ownerEmail: "ann@example.com" },
        )
    ).id;
    owner = { userId: annId, instanceRole: "user" };
    for (const name of ["one", "two", "three"]) digests.push((await upload(name)).digest);
    backupDir = path.join(work, "backup");
    await createBackup({
        db: source.db,
        databaseUrl: source.url,
        dataDir: sourceData,
        dest: backupDir,
        version: "0.0.0-test",
        pgDump: dump,
    });
});
afterAll(async () => {
    for (const target of targets) await target.destroy().catch(() => {});
    await source?.destroy();
    if (work) await fs.rm(work, { recursive: true, force: true });
});

describe("restoreBackup", () => {
    it("cancels a PostgreSQL preflight on an aborted drill deadline", async () => {
        const target = await emptyTarget();
        const deadline = new AbortController();
        deadline.abort();
        await expect(
            restoreBackup(restoreOptions(target, { signal: deadline.signal })),
        ).rejects.toThrow(/abort/i);
        expect(
            await sql<{
                present: boolean;
            }>`select to_regclass('public.user') is not null as present`.execute(target.db),
        ).toMatchObject({ rows: [{ present: false }] });
    });

    it("restores into an empty database with its archives, and the result checks clean", async () => {
        const target = await emptyTarget();
        const options = restoreOptions(target);
        const result = await restoreBackup(options);
        expect(result.filesRestored).toBe(3);
        expect(result.pendingMigrations).toEqual([]);
        expect(
            (
                await fs.stat(path.join(options.dataDir, "maintenance/immutable-recovery-blocked"))
            ).isFile(),
        ).toBe(true);
        expect(
            (
                await target.db
                    .selectFrom("instance_state")
                    .select("value")
                    .where("key", "=", "immutable_recovery")
                    .executeTakeFirstOrThrow()
            ).value,
        ).toBe("blocked");
        await expect(assertModelMutationsReady(target.db, options.dataDir)).rejects.toThrow(
            /blocked/,
        );
        const users = await target.db.selectFrom("user").select("email").orderBy("email").execute();
        expect(users.map((u) => u.email)).toEqual(["ann@example.com", "root@example.com"]);
        const report = await checkRestore({ db: target.db, dataDir: options.dataDir });
        expect(report.missingFiles).toEqual([]);
        // The archives are exactly the backed-up ones, byte for byte.
        const rows = await target.db.selectFrom("artifact").select("storage_key").execute();
        expect(rows).toHaveLength(3);
        for (const row of rows) {
            expect(
                (await fs.stat(resolveArtifactPath(options.dataDir, row.storage_key))).size,
            ).toBeGreaterThan(0);
        }
        // Running it again against the now-populated database is refused, nothing replaced.
        await expect(restoreBackup({ ...options })).rejects.toThrow(/already has data/);
        await clearImmutableRecovery(target.db, options.dataDir);
        await assertModelMutationsReady(target.db, options.dataDir);
    });

    it("needs the confirmation that the workers are stopped", async () => {
        const target = await emptyTarget();
        const options = restoreOptions(target, { workersStopped: false });
        await expect(restoreBackup(options)).rejects.toThrow(/i-have-stopped-the-workers/);
        expect(await tableCount(target.db)).toBe(0);
        await expect(fs.stat(path.join(options.dataDir, "maintenance"))).rejects.toThrow();
    });

    it("replaces a database only when it is named, and removes what the backup lacks", async () => {
        const target = await emptyTarget();
        await target.migrate();
        await sql`create table leftover_from_before (id int)`.execute(target.db);
        const name = replaceTarget(target.url);
        await expect(restoreBackup(restoreOptions(target))).rejects.toThrow(/already has data/);
        await expect(
            restoreBackup(restoreOptions(target, { replaceDatabase: "some_other_db" })),
        ).rejects.toThrow(/names some_other_db, but the target is/);
        expect(await tableCount(target.db)).toBeGreaterThan(1);
        const result = await restoreBackup(restoreOptions(target, { replaceDatabase: name }));
        expect(result.filesRestored).toBe(3);
        const gone = await sql<{ present: boolean }>`
            select to_regclass('leftover_from_before') is not null as present`.execute(target.db);
        expect(gone.rows[0]?.present).toBe(false);
        expect((await target.db.selectFrom("user").select("id").execute()).length).toBe(2);
    });

    it("puts the old data back when pg_restore fails after the swap", async () => {
        const target = await emptyTarget();
        await target.migrate();
        await sql`create table leftover_from_before (id int)`.execute(target.db);
        // Reads the dump (so the preflight passes) but fails the real restore.
        const failing = path.join(work, "pg_restore_failing.sh");
        await fs.writeFile(
            failing,
            `#!/bin/sh\ncase "$*" in *--list*|*--schema-only*) exec ${restoreTool} "$@";; esac\ncat >/dev/null\necho 'boom' >&2\nexit 1\n`,
            { mode: 0o700 },
        );
        const options = restoreOptions(target, {
            replaceDatabase: replaceTarget(target.url),
            pgRestore: failing,
        });
        await expect(restoreBackup(options)).rejects.toThrow(/boom/);
        expect(
            (
                await fs.stat(path.join(options.dataDir, "maintenance/immutable-recovery-blocked"))
            ).isFile(),
        ).toBe(true);
        await expect(assertModelMutationsReady(target.db, options.dataDir)).rejects.toThrow(
            /blocked/,
        );
        const present = await sql<{ present: boolean }>`
            select to_regclass('public.leftover_from_before') is not null as present`.execute(
            target.db,
        );
        expect(present.rows[0]?.present).toBe(true);
        const aside = await sql<{ n: string }>`
            select count(*) as n from pg_namespace where nspname like 'launchpad_replaced_%'`.execute(
            target.db,
        );
        expect(Number(aside.rows[0]?.n)).toBe(0);
    });

    it("stays blocked after the admin dies between import and the database gate write", async () => {
        const target = await emptyTarget();
        await target.migrate();
        const options = restoreOptions(target, { replaceDatabase: replaceTarget(target.url) });
        const crash = path.join(work, "pg_restore_crash_after_import.sh");
        // Only kills this test's spawned admin parent, after its pg_restore has
        // completed. The test runner and PostgreSQL container are not signalled.
        await fs.writeFile(
            crash,
            `#!/bin/sh
case "$*" in *--list*|*--schema-only*) exec ${restoreTool} "$@";; esac
${restoreTool} "$@"
rc=$?
[ "$rc" -eq 0 ] || exit "$rc"
kill -KILL "$PPID"
exit 0
`,
            { mode: 0o700 },
        );
        const result = spawnSync(
            "bun",
            [
                path.resolve(import.meta.dirname, "../../../.output/admin.mjs"),
                "restore",
                backupDir,
                "--i-have-stopped-the-workers",
                "--replace",
                replaceTarget(target.url),
            ],
            {
                env: {
                    PATH: process.env.PATH,
                    HOME: process.env.HOME,
                    DATABASE_URL: target.url,
                    LAUNCHPAD_DATA_DIR: options.dataDir,
                    LAUNCHPAD_PG_RESTORE: crash,
                },
                encoding: "utf8",
                timeout: 60_000,
            },
        );
        expect(result.error, result.stderr).toBeUndefined();
        expect(result.signal, result.stderr).toBe("SIGKILL");
        // No post-import gate update happened: the dump's ready row returned.
        expect(
            (
                await target.db
                    .selectFrom("instance_state")
                    .select("value")
                    .where("key", "=", "immutable_recovery")
                    .executeTakeFirstOrThrow()
            ).value,
        ).toBe("ready");
        expect(
            (
                await fs.stat(path.join(options.dataDir, "maintenance/immutable-recovery-blocked"))
            ).isFile(),
        ).toBe(true);
        await expect(assertModelMutationsReady(target.db, options.dataDir)).rejects.toThrow(
            /pg_restore/,
        );
        await expect(restoreBackup(options)).rejects.toThrow(/previous pg_restore/);
        await expect(clearImmutableRecovery(target.db, options.dataDir)).rejects.toThrow(
            /pg_restore/,
        );
        const acknowledged = spawnSync(
            "bun",
            [
                path.resolve(import.meta.dirname, "../../../.output/admin.mjs"),
                "recovery-ack-import",
                "--i-have-stopped-the-importer",
            ],
            {
                env: {
                    PATH: process.env.PATH,
                    HOME: process.env.HOME,
                    DATABASE_URL: target.url,
                    LAUNCHPAD_DATA_DIR: options.dataDir,
                },
                encoding: "utf8",
                timeout: 30_000,
            },
        );
        expect(acknowledged.status, acknowledged.stderr).toBe(0);
        await expect(assertModelMutationsReady(target.db, options.dataDir)).rejects.toThrow(
            /blocked/,
        );
    });

    it("refuses a second restore while a crashed admin's importer wrapper can still connect", async () => {
        const target = await emptyTarget();
        await target.migrate();
        const options = restoreOptions(target, { replaceDatabase: replaceTarget(target.url) });
        const heldDump = path.join(work, "held-import.dump");
        const release = path.join(work, "release-held-import");
        const finished = path.join(work, "held-import-exited");
        const crash = path.join(work, "pg_restore_surviving_wrapper.sh");
        await fs.writeFile(
            crash,
            `#!/bin/sh
case "$*" in *--list*|*--schema-only*) exec ${restoreTool} "$@";; esac
cat > "${heldDump}"
parent="$PPID"
exec >/dev/null 2>&1
kill -KILL "$parent"
for i in $(seq 1 400); do
    [ -e "${release}" ] && break
    sleep 0.05
done
if [ -e "${release}" ]; then
    ${restoreTool} "$@" < "${heldDump}"
    echo "$?" > "${finished}"
else
    echo "124" > "${finished}"
fi
`,
            { mode: 0o700 },
        );
        const result = spawnSync(
            "bun",
            [
                path.resolve(import.meta.dirname, "../../../.output/admin.mjs"),
                "restore",
                backupDir,
                "--i-have-stopped-the-workers",
                "--replace",
                replaceTarget(target.url),
            ],
            {
                env: {
                    PATH: process.env.PATH,
                    HOME: process.env.HOME,
                    DATABASE_URL: target.url,
                    LAUNCHPAD_DATA_DIR: options.dataDir,
                    LAUNCHPAD_PG_RESTORE: crash,
                },
                encoding: "utf8",
                timeout: 60_000,
            },
        );
        try {
            expect(result.error, result.stderr).toBeUndefined();
            expect(result.signal, result.stderr).toBe("SIGKILL");
            await expect(fs.stat(finished)).rejects.toMatchObject({ code: "ENOENT" });
            // There is not even a backend yet. The durable guard must refuse
            // before a later import could commit into the second restore's schema.
            await expect(restoreBackup(options)).rejects.toThrow(/previous pg_restore/);
            await expect(clearImmutableRecovery(target.db, options.dataDir)).rejects.toThrow(
                /pg_restore/,
            );
        } finally {
            await fs.writeFile(release, "");
            const deadline = Date.now() + 30_000;
            while (!(await fs.stat(finished).catch(() => null))) {
                if (Date.now() > deadline)
                    throw new Error("The test-owned importer wrapper did not exit.");
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
        }
        expect((await fs.readFile(finished, "utf8")).trim()).toBe("0");
        await acknowledgeImmutableImport(
            target.db,
            options.dataDir,
            replaceTarget(target.url),
            true,
        );
        await expect(assertModelMutationsReady(target.db, options.dataDir)).rejects.toThrow(
            /blocked/,
        );
    });

    it("puts the old data back when the restore exits 0 but loaded nothing", async () => {
        const target = await emptyTarget();
        await target.migrate();
        await sql`create table leftover_from_before (id int)`.execute(target.db);
        const empty = path.join(work, "pg_restore_noop.sh");
        await fs.writeFile(
            empty,
            `#!/bin/sh\ncase "$*" in *--list*|*--schema-only*) exec ${restoreTool} "$@";; esac\ncat >/dev/null\nexit 0\n`,
            { mode: 0o700 },
        );
        await expect(
            restoreBackup(
                restoreOptions(target, {
                    replaceDatabase: replaceTarget(target.url),
                    pgRestore: empty,
                }),
            ),
        ).rejects.toThrow(/does not hold the migrations/);
        const present = await sql<{ present: boolean }>`
            select to_regclass('public.leftover_from_before') is not null as present`.execute(
            target.db,
        );
        expect(present.rows[0]?.present).toBe(true);
    });

    it("finds a restore program that cannot read the dump before anything is moved", async () => {
        const target = await emptyTarget();
        await target.migrate();
        const refusing = path.join(work, "pg_restore_refusing.sh");
        await fs.writeFile(
            refusing,
            `#!/bin/sh\ncat >/dev/null\necho 'unsupported version' >&2\nexit 1\n`,
            {
                mode: 0o700,
            },
        );
        await expect(
            restoreBackup(
                restoreOptions(target, {
                    replaceDatabase: replaceTarget(target.url),
                    pgRestore: refusing,
                }),
            ),
        ).rejects.toThrow(/cannot read this dump.*Nothing was changed/);
        expect(await tableCount(target.db)).toBeGreaterThan(1);
    });

    it("refuses a database name that pg_restore would read as a connection string", async () => {
        const target = await emptyTarget();
        const url = new URL(target.url);
        url.pathname = "/dbname%3Dother";
        await expect(restoreBackup(restoreOptions({ url: url.toString() }))).rejects.toThrow(
            /plain database/,
        );
    });

    it("refuses a dump that would create another schema, and a replace with outside dependents", async () => {
        // A dump taken without the public-only filter, from a database with a second schema.
        const odd = await createTestDatabase();
        targets.push(odd);
        await odd.migrate();
        await sql`create schema extra`.execute(odd.db);
        await sql`create table extra.t (id int)`.execute(odd.db);
        const unfiltered = path.join(work, "pg_dump_unfiltered.sh");
        await fs.writeFile(
            unfiltered,
            `#!/bin/sh\nargs=""\nfor a in "$@"; do [ "$a" = "--schema=public" ] || args="$args $a"; done\n${tool("pg_dump").replace('"$@"', "$args")}\n`,
            { mode: 0o700 },
        );
        const everything = path.join(work, "backup-everything");
        await createBackup({
            db: odd.db,
            databaseUrl: odd.url,
            dataDir: path.join(work, "odd-data"),
            dest: everything,
            version: "0.0.0-test",
            pgDump: unfiltered,
        });
        const empty = await emptyTarget();
        await expect(
            restoreBackup(restoreOptions(empty, { backupDir: everything })),
        ).rejects.toThrow(/also creates schema extra/);
        expect(await tableCount(empty.db)).toBe(0);

        // A view in another schema that depends on a public table blocks --replace.
        const target = await emptyTarget();
        await target.migrate();
        await sql`create schema reporting`.execute(target.db);
        await sql`create view reporting.users as select id from public."user"`.execute(target.db);
        await expect(
            restoreBackup(restoreOptions(target, { replaceDatabase: replaceTarget(target.url) })),
        ).rejects.toThrow(/reporting\.users.*depend/);
        expect(await tableCount(target.db)).toBeGreaterThan(1);

        // So does a column default in another schema that uses a sequence in public.
        await sql`drop view reporting.users`.execute(target.db);
        await sql`create sequence public.shared_seq`.execute(target.db);
        await sql`create table reporting.t (id bigint default nextval('public.shared_seq'))`.execute(
            target.db,
        );
        await expect(
            restoreBackup(restoreOptions(target, { replaceDatabase: replaceTarget(target.url) })),
        ).rejects.toThrow(/reporting\.t.*depend/);
    });

    it("restores into an empty database that has no public schema", async () => {
        const target = await emptyTarget();
        await sql`drop schema public`.execute(target.db);
        const result = await restoreBackup(restoreOptions(target));
        expect(result.filesRestored).toBe(3);
        expect((await target.db.selectFrom("user").select("id").execute()).length).toBe(2);
    });

    it("restores a dump whose public schema has a non-default owner (listed, but not created)", async () => {
        const role = `lp_owner_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
        const odd = await createTestDatabase();
        targets.push(odd);
        await odd.migrate();
        await sql.raw(`create role ${role}`).execute(odd.db);
        try {
            await sql.raw(`alter schema public owner to ${role}`).execute(odd.db);
            // Taken without --schema=public, as an older version did.
            const unfiltered = path.join(work, "pg_dump_unfiltered2.sh");
            await fs.writeFile(
                unfiltered,
                `#!/bin/sh\nargs=""\nfor a in "$@"; do [ "$a" = "--schema=public" ] || args="$args $a"; done\n${tool("pg_dump").replace('"$@"', "$args")}\n`,
                { mode: 0o700 },
            );
            const dest = path.join(work, "backup-owner");
            await createBackup({
                db: odd.db,
                databaseUrl: odd.url,
                dataDir: path.join(work, "owner-data"),
                dest,
                version: "0.0.0-test",
                pgDump: unfiltered,
            });
            const target = await emptyTarget();
            await restoreBackup(restoreOptions(target, { backupDir: dest }));
            expect((await target.db.selectFrom("user").select("id").execute()).length).toBe(0);
            expect(await tableCount(target.db)).toBeGreaterThan(5);
        } finally {
            await sql.raw(`alter schema public owner to current_user`).execute(odd.db);
            await sql.raw(`drop role ${role}`).execute(odd.db);
        }
    });

    it("restores a dump made with every identifier quoted", async () => {
        const quoted = path.join(work, "pg_dump_quoted.sh");
        await fs.writeFile(
            quoted,
            `#!/bin/sh\n${tool("pg_dump").replace('"$@"', '"$@" --quote-all-identifiers')}\n`,
            { mode: 0o700 },
        );
        const dest = path.join(work, "backup-quoted");
        await createBackup({
            db: source.db,
            databaseUrl: source.url,
            dataDir: sourceData,
            dest,
            version: "0.0.0-test",
            pgDump: quoted,
        });
        const target = await emptyTarget();
        const result = await restoreBackup(restoreOptions(target, { backupDir: dest }));
        expect(result.filesRestored).toBe(3);
    });

    it("restores a backup older than the artifact table", async () => {
        const sourceFolder = path.resolve(
            import.meta.dirname,
            "../../../../../packages/database/src",
        );
        const root = path.join(work, "very-old-schema");
        const folder = path.join(root, "migrations");
        await fs.mkdir(folder, { recursive: true });
        await fs.copyFile(
            path.join(sourceFolder, "auth-schema.ts"),
            path.join(root, "auth-schema.ts"),
        );
        const files = (await fs.readdir(path.join(sourceFolder, "migrations"))).sort();
        for (const file of files.slice(0, 9)) {
            await fs.copyFile(path.join(sourceFolder, "migrations", file), path.join(folder, file));
        }
        const old = await createTestDatabase();
        targets.push(old);
        await migrateToLatest(old.db, folder);
        const dest = path.join(work, "very-old-backup");
        await createBackup({
            db: old.db,
            databaseUrl: old.url,
            dataDir: path.join(work, "very-old-data"),
            dest,
            version: "0.0.0-test",
            pgDump: dump,
        });
        const target = await emptyTarget();
        const result = await restoreBackup(restoreOptions(target, { backupDir: dest }));
        expect(result.pendingMigrations).toHaveLength(files.length - 9);
    });

    it("refuses a backup that does not verify, before changing anything", async () => {
        const broken = path.join(work, "broken");
        await fs.cp(backupDir, broken, { recursive: true });
        const manifest = JSON.parse(await fs.readFile(path.join(broken, "manifest.json"), "utf8"));
        await fs.appendFile(path.join(broken, manifest.artifacts[0].storageKey), "x");
        expect(await verifyBackup(broken)).not.toEqual([]);
        const target = await emptyTarget();
        const options = restoreOptions(target, { backupDir: broken });
        await expect(restoreBackup(options)).rejects.toThrow(/does not verify/);
        expect(await tableCount(target.db)).toBe(0);
        await expect(fs.stat(path.join(options.dataDir, "maintenance"))).rejects.toThrow();
    });

    it("refuses a backup from a newer version", async () => {
        const newer = path.join(work, "newer");
        await fs.cp(backupDir, newer, { recursive: true });
        const manifest = JSON.parse(await fs.readFile(path.join(newer, "manifest.json"), "utf8"));
        manifest.migrations.push("20991231_999_from_the_future");
        await fs.writeFile(path.join(newer, "manifest.json"), JSON.stringify(manifest));
        const target = await emptyTarget();
        await expect(restoreBackup(restoreOptions(target, { backupDir: newer }))).rejects.toThrow(
            /does not know.*from_the_future/,
        );
        expect(await tableCount(target.db)).toBe(0);
    });

    it("never overwrites a different file already in the data directory, and touches nothing first", async () => {
        const target = await emptyTarget();
        const options = restoreOptions(target);
        const manifest = JSON.parse(
            await fs.readFile(path.join(backupDir, "manifest.json"), "utf8"),
        );
        const clash = resolveArtifactPath(options.dataDir, manifest.artifacts[1].storageKey);
        await fs.mkdir(path.dirname(clash), { recursive: true });
        await fs.writeFile(clash, "someone else's bytes");
        await expect(restoreBackup(options)).rejects.toThrow(/different content/);
        expect(await fs.readFile(clash, "utf8")).toBe("someone else's bytes");
        expect(await tableCount(target.db)).toBe(0);
        const files = (await fs.readdir(path.dirname(clash))).filter((f) => !f.endsWith(".tar.gz"));
        expect(files).toEqual([]);
    });

    it("leaves archives already in place and reports them", async () => {
        const first = await emptyTarget();
        const options = restoreOptions(first);
        await restoreBackup(options);
        const second = await emptyTarget();
        const again = await restoreBackup({ ...options, databaseUrl: second.url });
        expect(again.filesRestored).toBe(0);
        expect(again.filesAlreadyPresent).toBe(3);
    });

    it("reports a restore program that is not there, and leaves the database empty", async () => {
        const target = await emptyTarget();
        await expect(
            restoreBackup(restoreOptions(target, { pgRestore: path.join(work, "no-such-tool") })),
        ).rejects.toThrow(/was not found/);
        expect(await tableCount(target.db)).toBe(0);
    });

    it("marks recovery when an older dump erases existing model rows, regardless of its manifest", async () => {
        // A backup at 014 can erase 018 resources without erasing their remote side effects.
        const sourceFolder = path.resolve(
            import.meta.dirname,
            "../../../../../packages/database/src",
        );
        const root = path.join(work, "old-schema");
        const folder = path.join(root, "migrations");
        await fs.mkdir(folder, { recursive: true });
        await fs.copyFile(
            path.join(sourceFolder, "auth-schema.ts"),
            path.join(root, "auth-schema.ts"),
        );
        const files = (await fs.readdir(path.join(sourceFolder, "migrations"))).sort();
        for (const file of files.slice(0, 14)) {
            await fs.copyFile(path.join(sourceFolder, "migrations", file), path.join(folder, file));
        }
        const old = await createTestDatabase();
        targets.push(old);
        await migrateToLatest(old.db, folder);
        const dest = path.join(work, "old-backup");
        await createBackup({
            db: old.db,
            databaseUrl: old.url,
            dataDir: path.join(work, "old-data"),
            dest,
            version: "0.0.0-test",
            pgDump: dump,
        });
        const target = await emptyTarget();
        await target.migrate();
        const actor = randomUUID();
        const tenant = randomUUID();
        await target.db
            .insertInto("user")
            .values({
                id: actor,
                name: "Model owner",
                email: "model-owner@example.invalid",
                emailVerified: false,
                role: "user",
            })
            .execute();
        await target.db
            .insertInto("organization")
            .values({
                id: tenant,
                name: "Model tenant",
                slug: "model-tenant",
                createdAt: new Date(),
            })
            .execute();
        const project = await target.db
            .insertInto("project")
            .values({
                organization_id: tenant,
                name: "Site",
                slug: "site",
                created_by: actor,
            })
            .returning("id")
            .executeTakeFirstOrThrow();
        await target.db
            .insertInto("app")
            .values({
                organization_id: tenant,
                project_id: project.id,
                slug: "site",
                created_by: actor,
            })
            .execute();
        const options = restoreOptions(target, {
            backupDir: dest,
            replaceDatabase: replaceTarget(target.url),
        });
        await recordModelWriterSeen(options.dataDir);
        const result = await restoreBackup(options);
        expect(result.pendingMigrations).toHaveLength(files.length - 14);
        expect(
            (
                await fs.stat(path.join(options.dataDir, "maintenance/immutable-recovery-blocked"))
            ).isFile(),
        ).toBe(true);
        await target.migrate();
        expect(await target.db.selectFrom("app").select("id").execute()).toEqual([]);
        await expect(assertModelMutationsReady(target.db, options.dataDir)).rejects.toThrow(
            /blocked/,
        );
        await expect(clearImmutableRecovery(target.db, options.dataDir)).rejects.toThrow(/writer/);
    });

    it("migrates a restored 017 dump without overwriting its blocked gate", async () => {
        const old = await emptyTarget();
        await old.migrateTo("20261116_017_worker_heartbeat_lifecycle");
        const dest = path.join(work, "schema-017-backup");
        await createBackup({
            db: old.db,
            databaseUrl: old.url,
            dataDir: sourceData,
            dest,
            version: "0.0.0-test",
            pgDump: dump,
        });
        const target = await emptyTarget();
        const options = restoreOptions(target, { backupDir: dest });
        await restoreBackup(options);
        await target.migrate();
        expect(
            (
                await target.db
                    .selectFrom("instance_state")
                    .select("value")
                    .where("key", "=", "immutable_recovery")
                    .executeTakeFirstOrThrow()
            ).value,
        ).toBe("blocked");
        await clearImmutableRecovery(target.db, options.dataDir);
        await assertModelMutationsReady(target.db, options.dataDir);
    });
});

describe("checkRestore", () => {
    it("lists missing archives and missing apps, and changes nothing", async () => {
        const target = await emptyTarget();
        const options = restoreOptions(target);
        await restoreBackup(options);
        // Two immutable deployments reached Dokku; a queued one has not touched it.
        const project = await createProject(target.db, owner, org, { name: "Site", slug: "site" });
        const parent = await target.db
            .insertInto("app")
            .values({
                organization_id: org,
                project_id: project.id,
                slug: "site",
                created_by: owner.userId,
            })
            .returning("id")
            .executeTakeFirstOrThrow();
        const artifact = await target.db
            .selectFrom("artifact")
            .select("id")
            .limit(1)
            .executeTakeFirstOrThrow();
        const previews: { id: string; app_name: string }[] = [];
        for (const slug of ["kept", "lost", "never-deployed"]) {
            const id = randomUUID();
            const app = `lp-${randomUUID().replaceAll("-", "").slice(0, 10)}`;
            await target.db.transaction().execute(async (trx) => {
                await trx
                    .insertInto("immutable_deployment")
                    .values({
                        id,
                        organization_id: org,
                        app_id: parent.id,
                        artifact_id: artifact.id,
                        app_name: app,
                        hostname: `${slug}-${app}.previews.example.com`,
                        status: slug === "never-deployed" ? "queued" : "succeeded",
                        image_tag: `launchpad/site:${id}`,
                        image_id: `sha256:${"a".repeat(64)}`,
                        finished_at: slug === "never-deployed" ? null : new Date(),
                        requested_by: owner.userId,
                        preview_expires_at: new Date(Date.now() + 86400000),
                    })
                    .execute();
                await trx
                    .insertInto("hostname_reservation")
                    .values({
                        hostname: `${slug}-${app}.previews.example.com`,
                        owner_kind: "deployment",
                        owner_id: id,
                        organization_id: org,
                    })
                    .execute();
                await trx
                    .insertInto("dokku_name_reservation")
                    .values({
                        app_name: app,
                        owner_kind: "deployment",
                        owner_id: id,
                        organization_id: org,
                    })
                    .execute();
            });
            previews.push({ id, app_name: app });
        }
        await target.db
            .updateTable("immutable_deployment")
            .set({ preview_expires_at: sql<Date>`now() - interval '1 day'` })
            .where("id", "=", previews[0]!.id)
            .execute();
        const gone = (await target.db.selectFrom("artifact").select("storage_key").execute())[0]!;
        await fs.rm(resolveArtifactPath(options.dataDir, gone.storage_key));
        const asked: string[] = [];
        const before = await target.db
            .selectFrom("immutable_deployment")
            .selectAll()
            .orderBy("id")
            .execute();
        const report = await checkRestore({
            db: target.db,
            dataDir: options.dataDir,
            appExists: async (name) => {
                asked.push(name);
                return name !== previews[1]!.app_name;
            },
        });
        expect(report.missingFiles).toEqual([gone.storage_key]);
        expect(report.missingApps.map((a) => a.deploymentId)).toEqual([previews[1]!.id]);
        expect(report.appsChecked).toBe(2);
        expect(report.expired.map((p) => p.deploymentId)).toEqual([previews[0]!.id]);
        expect(asked).not.toContain(previews[2]!.app_name);
        // Nothing was changed.
        expect(
            await target.db.selectFrom("immutable_deployment").selectAll().orderBy("id").execute(),
        ).toEqual(before);
        const skipped = await checkRestore({ db: target.db, dataDir: options.dataDir });
        expect(skipped.dokkuChecked).toBe(false);
        expect(skipped.missingApps).toEqual([]);
    });
});
