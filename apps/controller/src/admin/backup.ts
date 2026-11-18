import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { type Database, migrationStatus } from "@launchpad/database";
import { resolveArtifactPath, WORKER_LIVE_SECONDS } from "@launchpad/services";
import { type Kysely, sql } from "kysely";

export const BACKUP_FORMAT = 1;
const MANIFEST = "manifest.json";
const DUMP = "database.dump";
const STORAGE_KEY = /^artifacts\/[0-9a-f]{32}\/[0-9a-f]{64}\.tar\.gz$/;

export interface BackupManifest {
    format: typeof BACKUP_FORMAT;
    createdAt: string;
    launchpadVersion: string;
    // The migrations the dump was taken at; a restore needs a build that knows all of them.
    migrations: string[];
    database: { file: string; sha256: string; bytes: number };
    // Exactly the stored archives the dump's live artifact rows refer to.
    artifacts: { storageKey: string; sha256: string; bytes: number }[];
    // Said in the file itself so nobody takes it for a complete backup of the installation.
    excludes: string;
}

export class BackupError extends Error {
    override name = "BackupError";
}

export interface BackupOptions {
    db: Kysely<Database>;
    databaseUrl: string;
    dataDir: string;
    dest: string;
    // The operator's confirmation that every worker is stopped and the lifecycle is not running.
    workersStopped: boolean;
    lifecycleEnabled: boolean;
    version: string;
    // The dump program: `pg_dump` unless named (the version must not be older than the server).
    pgDump?: string;
}

// Connection settings travel in the environment, never in the argument list where any
// local user could read the password.
// The backup may run against a schema that is behind this build (the point is to back up before
// migrating), so a column a later migration added is only used where it exists.
export async function columnExists(db: Kysely<any>, table: string, column: string) {
    // The relation the search path resolves (a personal schema may be empty while the tables live
    // in `public`), not whatever schema is current.
    const { rows } = await sql<{ present: boolean }>`
        select exists (
            select 1 from pg_attribute
            where attrelid = to_regclass(${table}::text)
              and attname = ${column} and attnum > 0 and not attisdropped
        ) as present`.execute(db);
    return rows[0]?.present === true;
}

export function pgEnvironment(databaseUrl: string): Record<string, string> {
    const url = new URL(databaseUrl);
    const env: Record<string, string> = {};
    // libpq wants an IPv6 address without the brackets a URL puts around it.
    const host = (url.searchParams.get("host") ?? url.hostname).replace(/^\[(.*)\]$/, "$1");
    if (host) env.PGHOST = decodeURIComponent(host);
    if (url.port) env.PGPORT = url.port;
    if (url.username) env.PGUSER = decodeURIComponent(url.username);
    if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
    const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
    if (database) env.PGDATABASE = database;
    const sslmode = url.searchParams.get("sslmode");
    if (sslmode) env.PGSSLMODE = sslmode;
    return env;
}

async function hashFile(file: string) {
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of createReadStream(file)) {
        hash.update(chunk as Buffer);
        bytes += (chunk as Buffer).length;
    }
    return { sha256: hash.digest("hex"), bytes };
}

async function dumpDatabase(options: BackupOptions, snapshot: string, file: string) {
    const binary = options.pgDump ?? "pg_dump";
    const child = spawn(
        binary,
        [
            "--format=custom",
            "--no-owner",
            "--no-privileges",
            "--no-password",
            `--snapshot=${snapshot}`,
        ],
        {
            env: { PATH: process.env.PATH, ...pgEnvironment(options.databaseUrl) },
            stdio: ["ignore", "pipe", "pipe"],
        },
    );
    let errors = "";
    child.stderr.on("data", (chunk) => (errors += chunk));
    const exited = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
    });
    const written = pipeline(child.stdout, createWriteStream(file, { mode: 0o600 }));
    const [code] = await Promise.all([exited, written]).catch((error) => {
        throw new BackupError(
            error?.code === "ENOENT"
                ? `${binary} was not found: install the PostgreSQL client tools or set LAUNCHPAD_PG_DUMP.`
                : `${binary} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
    });
    if (code !== 0) {
        throw new BackupError(`${binary} exited with code ${code}: ${errors.trim().slice(-500)}`);
    }
}

// A backup is a directory: the database dump, the stored archives its live artifact rows refer
// to, and a manifest with checksums. Nothing else is copied: environment files, the Better Auth
// secret and Dokku's own state are the operator's to keep separately. The dump DOES hold
// password and API-key hashes, so the directory is private (mode 0700) and must be kept so.
//
// One consistent view of both halves: the live artifact rows are read inside the same exported
// snapshot the dump uses, and the files are copied for exactly those rows. An upload made
// meanwhile is only an extra file that is not copied; the only thing that removes an archive is
// the lifecycle's collection, which is why this refuses to run beside it.
export async function createBackup(options: BackupOptions): Promise<BackupManifest> {
    const { db } = options;
    if (!options.workersStopped) {
        // Before the lifecycle existed no worker collected anything, but one that is running
        // still counts: only a column that exists is used to narrow the question.
        let live = 0;
        if (await columnExists(db, "worker_heartbeat", "last_seen_at")) {
            const onlyLifecycle = (await columnExists(db, "worker_heartbeat", "lifecycle_enabled"))
                ? sql`and lifecycle_enabled`
                : sql``;
            const { rows } = await sql<{ n: string }>`
                select count(*) as n from worker_heartbeat
                where last_seen_at > now() - ${WORKER_LIVE_SECONDS} * interval '1 second' ${onlyLifecycle}`.execute(
                db,
            );
            live = Number(rows[0]?.n ?? 0);
        }
        if (options.lifecycleEnabled || live > 0) {
            throw new BackupError(
                "The lifecycle is on (or a worker with it on is running): its collection can remove an archive " +
                    "while the backup copies. Stop the workers and the lifecycle, then confirm with " +
                    "--i-have-stopped-the-workers.",
            );
        }
    }
    // A database that is BEHIND this build can be backed up (that is what comes before migrating);
    // one a newer build already migrated cannot: this build would not know what it dumped.
    const known = await migrationStatus(db);
    if (known.unknown.length > 0) {
        throw new BackupError(
            `The database has migrations this version does not know (${known.unknown.join(", ")}): ` +
                "run the backup with the newer version.",
        );
    }

    const dest = path.resolve(options.dest);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    try {
        await fs.mkdir(dest, { mode: 0o700 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            throw new BackupError(`${dest} already exists; a backup never overwrites one.`);
        }
        throw error;
    }
    // From here the directory is ours: a failed backup leaves nothing half-written behind.
    try {
        const dumpFile = path.join(dest, DUMP);
        const { rows, migrations } = await db
            .transaction()
            .setIsolationLevel("repeatable read")
            .execute(async (trx) => {
                const { rows: snap } = await sql<{
                    id: string;
                }>`select pg_export_snapshot() as id`.execute(trx);
                // This session only waits while pg_dump reads: a server setting must not end it.
                await sql`set local idle_in_transaction_session_timeout = 0`.execute(trx);
                const applied = await sql<{
                    name: string;
                }>`select name from launchpad_migration order by name`.execute(trx);
                const uncollected = (await columnExists(trx, "artifact", "collected_at"))
                    ? sql`where collected_at is null`
                    : sql``;
                const hasArtifacts = await columnExists(trx, "artifact", "storage_key");
                const live = hasArtifacts
                    ? (
                          await sql<{ storage_key: string; digest: string }>`
                              select storage_key, digest from artifact ${uncollected} order by storage_key`.execute(
                              trx,
                          )
                      ).rows
                    : [];
                await dumpDatabase(options, snap[0]!.id, dumpFile);
                return { rows: live, migrations: applied.rows.map((r) => r.name) };
            });

        const artifacts: BackupManifest["artifacts"] = [];
        const problems: string[] = [];
        for (const row of rows) {
            const source = resolveArtifactPath(options.dataDir, row.storage_key);
            const target = path.join(dest, row.storage_key);
            try {
                await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
                await pipeline(
                    createReadStream(source),
                    createWriteStream(target, { mode: 0o600 }),
                );
            } catch (error) {
                problems.push(
                    `${row.storage_key}: ${(error as NodeJS.ErrnoException).code === "ENOENT" ? "the stored file is missing" : String(error)}`,
                );
                continue;
            }
            const copied = await hashFile(target);
            if (copied.sha256 !== row.digest) {
                problems.push(
                    `${row.storage_key}: the stored file does not match its recorded digest`,
                );
                continue;
            }
            artifacts.push({ storageKey: row.storage_key, ...copied });
        }
        if (problems.length > 0) {
            throw new BackupError(
                `The data directory does not match the database (${problems.length} problem(s)); no backup was made:\n` +
                    problems.map((p) => `  ${p}`).join("\n"),
            );
        }

        const manifest: BackupManifest = {
            format: BACKUP_FORMAT,
            createdAt: new Date().toISOString(),
            launchpadVersion: options.version,
            migrations,
            database: { file: DUMP, ...(await hashFile(dumpFile)) },
            artifacts,
            excludes:
                "Environment files, the authentication secret, Dokku's own state and any preview datastore. " +
                "The dump contains password and API-key hashes and live session tokens: keep this directory private " +
                "and never store the authentication secret beside it.",
        };
        const temp = path.join(dest, `${MANIFEST}.partial`);
        await fs.writeFile(temp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
        await fs.rename(temp, path.join(dest, MANIFEST));
        const problemsAfter = await verifyBackup(dest);
        if (problemsAfter.length > 0) {
            throw new BackupError(
                `The finished backup does not verify: ${problemsAfter.join("; ")}`,
            );
        }
        return manifest;
    } catch (error) {
        await fs.rm(dest, { recursive: true, force: true }).catch(() => {});
        throw error;
    }
}

async function listFiles(root: string, dir = root): Promise<string[]> {
    const found: string[] = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) found.push(...(await listFiles(root, full)));
        else found.push(path.relative(root, full).split(path.sep).join("/"));
    }
    return found;
}

// Everything the manifest names is present with the recorded size and checksum, and nothing
// else is in the directory. Returns the problems found (none means it verifies).
export async function verifyBackup(dir: string): Promise<string[]> {
    const root = path.resolve(dir);
    let manifest: BackupManifest;
    try {
        // A link in place of the manifest could point anywhere.
        if (!(await fs.lstat(path.join(root, MANIFEST))).isFile()) {
            return [`${MANIFEST} is not a plain file`];
        }
        manifest = JSON.parse(await fs.readFile(path.join(root, MANIFEST), "utf8"));
    } catch {
        return [`${MANIFEST} is missing or unreadable`];
    }
    if (manifest?.format !== BACKUP_FORMAT) {
        return [`unsupported backup format ${String(manifest?.format)}`];
    }
    if (
        manifest.database?.file !== DUMP ||
        !Array.isArray(manifest.artifacts) ||
        !Array.isArray(manifest.migrations)
    ) {
        return [`${MANIFEST} is not a backup manifest`];
    }
    const problems: string[] = [];
    const expected = new Map<string, { sha256: string; bytes: number }>();
    expected.set(manifest.database.file, manifest.database);
    for (const artifact of manifest.artifacts) {
        if (artifact === null || typeof artifact !== "object") {
            problems.push("an artifact entry is not an object");
            continue;
        }
        if (!STORAGE_KEY.test(artifact.storageKey)) {
            problems.push(`${artifact.storageKey}: not an artifact storage key`);
            continue;
        }
        expected.set(artifact.storageKey, artifact);
    }
    for (const [file, want] of expected) {
        if (file !== path.posix.normalize(file) || file.startsWith("..") || path.isAbsolute(file)) {
            problems.push(`${file}: not a path inside the backup`);
            continue;
        }
        try {
            // A link or special file at an expected path could hang or point elsewhere.
            if (!(await fs.lstat(path.join(root, file))).isFile()) {
                problems.push(`${file}: not a plain file`);
                continue;
            }
            const got = await hashFile(path.join(root, file));
            if (got.bytes !== want.bytes || got.sha256 !== want.sha256) {
                problems.push(`${file}: does not match its recorded size and checksum`);
            }
        } catch {
            problems.push(`${file}: missing`);
        }
    }
    for (const file of await listFiles(root)) {
        if (file !== MANIFEST && !expected.has(file)) problems.push(`${file}: not in the manifest`);
    }
    return problems;
}
