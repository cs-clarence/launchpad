import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { Transform } from "node:stream";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createDatabase, type Database, migrationStatus } from "@launchpad-kit/database";
import { resolveArtifactPath } from "@launchpad-kit/services";
import { type Kysely, sql } from "kysely";
import { type BackupManifest, columnExists, pgEnvironment, verifyBackup } from "./backup";

export class RestoreError extends Error {
    override name = "RestoreError";
}

export interface RestoreOptions {
    backupDir: string;
    // The database to restore into: an empty one, or one named in `replaceDatabase`.
    databaseUrl: string;
    dataDir: string;
    // The operator's confirmation that docs/plans/application.md's restore step 1 is done: the
    // every writer stopped and waited for, and the Dokku operations they dispatched settled.
    workersStopped: boolean;
    // Replace a database that already has data: its address typed out as host:port/database, so
    // naming a scratch copy with the live one's name is not enough.
    replaceDatabase?: string;
    pgRestore?: string;
    // Optional bounded drill cancellation; production CLI normally lets a restore complete.
    signal?: AbortSignal;
}

export interface RestoreResult {
    manifest: BackupManifest;
    // Migrations this build has that the restored database does not: run `migrate` next.
    pendingMigrations: string[];
    filesRestored: number;
    filesAlreadyPresent: number;
}

async function hashFile(file: string) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
    return hash.digest("hex");
}

async function runPgRestore(options: RestoreOptions, dump: string) {
    const binary = options.pgRestore ?? "pg_restore";
    const child = spawn(
        binary,
        [
            "--no-owner",
            "--no-privileges",
            "--no-password",
            "--exit-on-error",
            "--single-transaction",
            `--dbname=${pgEnvironment(options.databaseUrl).PGDATABASE ?? ""}`,
        ],
        {
            env: { PATH: process.env.PATH, ...pgEnvironment(options.databaseUrl) },
            stdio: ["pipe", "pipe", "pipe"],
            signal: options.signal,
        },
    );
    let errors = "";
    child.stderr.on("data", (chunk) => (errors += chunk));
    child.stdout.resume();
    const exited = new Promise<number | null>((resolve, reject) => {
        let spawnError: Error | undefined;
        child.once("error", (error) => (spawnError = error));
        child.once("close", (code) => (spawnError ? reject(spawnError) : resolve(code)));
    });
    // The dump is fed on stdin so the program may run elsewhere (a container) than this file.
    let feedError: unknown;
    const fed = pipeline(createReadStream(dump), child.stdin).catch((error) => {
        // A program that stopped early (or never started) closes its input: its exit says why.
        feedError = error;
    });
    const [code] = await Promise.all([exited, fed]).catch((error) => {
        throw new RestoreError(
            error?.code === "ENOENT"
                ? `${binary} was not found: install the PostgreSQL client tools or set LAUNCHPAD_PG_RESTORE.`
                : `${binary} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
    });
    if (code === 0 && feedError && (feedError as NodeJS.ErrnoException).code !== "EPIPE") {
        throw new RestoreError(`The dump could not be read: ${String(feedError)}`);
    }
    if (code !== 0) {
        throw new RestoreError(`${binary} exited with code ${code}: ${errors.trim().slice(-500)}`);
    }
}

// How the operator names the database they mean to replace: host:port/database.
export function replaceTarget(databaseUrl: string): string {
    const env = pgEnvironment(databaseUrl);
    return `${env.PGHOST ?? "localhost"}:${env.PGPORT ?? "5432"}/${env.PGDATABASE ?? ""}`;
}

// Before anything changes: the program exists and can read this dump (a client older than the
// one that wrote it refuses the header). A restore that cannot work must be found out here, not
// after the old data has been moved aside.
async function preflightPgRestore(
    options: RestoreOptions,
    dump: string,
): Promise<{ createsPublic: boolean }> {
    const binary = options.pgRestore ?? "pg_restore";
    const child = spawn(binary, ["--list"], {
        env: { PATH: process.env.PATH, ...pgEnvironment(options.databaseUrl) },
        stdio: ["pipe", "pipe", "pipe"],
        signal: options.signal,
    });
    let errors = "";
    let toc = "";
    child.stderr.on("data", (chunk) => (errors += chunk));
    child.stdout.on("data", (chunk) => (toc += chunk));
    const exited = new Promise<number | null>((resolve, reject) => {
        let spawnError: Error | undefined;
        child.once("error", (error) => (spawnError = error));
        child.once("close", (code) => (spawnError ? reject(spawnError) : resolve(code)));
    });
    const fed = pipeline(createReadStream(dump), child.stdin).catch(() => {});
    const [code] = await Promise.all([exited, fed]).catch((error) => {
        throw new RestoreError(
            error?.code === "ENOENT"
                ? `${binary} was not found: install the PostgreSQL client tools or set LAUNCHPAD_PG_RESTORE. Nothing was changed.`
                : `${binary} failed: ${error instanceof Error ? error.message : String(error)}. Nothing was changed.`,
        );
    });
    if (code !== 0) {
        throw new RestoreError(
            `${binary} cannot read this dump (${errors.trim().slice(-300)}); it must be at least the version that wrote it. Nothing was changed.`,
        );
    }
    // A restore changes the `public` schema and nothing else. A dump that creates another schema
    // or an extension (an older backup, or a database an operator changed) would reach outside it.
    const outside = [...toc.matchAll(/^\s*\d+;\s+\d+\s+\d+\s+(SCHEMA|EXTENSION)\s+-\s+(\S+)/gm)]
        .map((m) => `${m[1]!.toLowerCase()} ${m[2]}`)
        .filter((name) => name !== "schema public" && name !== "extension plpgsql");
    if (outside.length > 0) {
        throw new RestoreError(
            `The dump also creates ${outside.join(", ")}, outside the public schema that a restore replaces. Nothing was changed.`,
        );
    }
    return { createsPublic: await dumpCreatesPublic(options, dump) };
}

// Whether restoring this dump runs `CREATE SCHEMA public` (one taken with --schema=public does; an
// older one does not; one whose `public` has a non-default owner can list the entry with only a
// comment). Read from the SQL it would run, not from its table of contents.
async function dumpCreatesPublic(options: RestoreOptions, dump: string): Promise<boolean> {
    const binary = options.pgRestore ?? "pg_restore";
    const child = spawn(binary, ["--schema-only", "--no-owner", "--no-privileges", "-f", "-"], {
        env: { PATH: process.env.PATH, ...pgEnvironment(options.databaseUrl) },
        stdio: ["pipe", "pipe", "pipe"],
        signal: options.signal,
    });
    let sqlText = "";
    child.stdout.on("data", (chunk) => (sqlText += chunk));
    child.stderr.resume();
    const exited = new Promise<number | null>((resolve, reject) => {
        let spawnError: Error | undefined;
        child.once("error", (error) => (spawnError = error));
        child.once("close", (code) => (spawnError ? reject(spawnError) : resolve(code)));
    });
    const fed = pipeline(createReadStream(dump), child.stdin).catch(() => {});
    const [code] = await Promise.all([exited, fed]);
    if (code !== 0) {
        throw new RestoreError(
            `${binary} could not read the schema of this dump. Nothing was changed.`,
        );
    }
    return /^CREATE SCHEMA "?public"?;\s*$/m.test(sqlText);
}

// Views, foreign keys and column defaults in other schemas that depend on an object in `public`: dropping the old
// schema afterwards would cascade into them, outside what a restore may touch.
async function outsideDependents(db: Kysely<any>): Promise<string[]> {
    const views = await sql<{ name: string }>`
        select distinct vs.nspname || '.' || v.relname as name
        from pg_depend d
        join pg_rewrite r on r.oid = d.objid and d.classid = 'pg_rewrite'::regclass
        join pg_class v on v.oid = r.ev_class
        join pg_namespace vs on vs.oid = v.relnamespace
        join pg_class t on t.oid = d.refobjid and d.refclassid = 'pg_class'::regclass
        join pg_namespace ts on ts.oid = t.relnamespace
        where ts.nspname = 'public' and vs.nspname <> 'public' and v.oid <> t.oid`.execute(db);
    const keys = await sql<{ name: string }>`
        select distinct cs.nspname || '.' || c.relname as name
        from pg_constraint k
        join pg_class c on c.oid = k.conrelid
        join pg_namespace cs on cs.oid = c.relnamespace
        join pg_class t on t.oid = k.confrelid
        join pg_namespace ts on ts.oid = t.relnamespace
        where k.contype = 'f' and ts.nspname = 'public' and cs.nspname <> 'public'`.execute(db);
    const defaults = await sql<{ name: string }>`
        select distinct ns.nspname || '.' || c.relname as name
        from pg_depend d
        join pg_attrdef a on a.oid = d.objid and d.classid = 'pg_attrdef'::regclass
        join pg_class c on c.oid = a.adrelid
        join pg_namespace ns on ns.oid = c.relnamespace
        join pg_class q on q.oid = d.refobjid and d.refclassid = 'pg_class'::regclass
        join pg_namespace qs on qs.oid = q.relnamespace
        where qs.nspname = 'public' and ns.nspname <> 'public'`.execute(db);
    return [...views.rows, ...keys.rows, ...defaults.rows].map((r) => r.name).sort();
}

async function userTableCount(db: Kysely<any>) {
    const { rows } = await sql<{ n: string }>`
        select count(*) as n from pg_class c join pg_namespace s on s.oid = c.relnamespace
        where s.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')`.execute(db);
    return Number(rows[0]?.n ?? 0);
}

// Restores a backup made by `createBackup`: the stored archives first (additive, so a failure
// there changes nothing that matters), then the database. It never touches Dokku. It restores
// into an empty database, or into one the operator names to be replaced, and it refuses while a
// writer is running against the target. What the operator must do before and after is the
// restore runbook in docs/restore.md; this does the middle of it.
export async function restoreBackup(options: RestoreOptions): Promise<RestoreResult> {
    if (!options.workersStopped) {
        throw new RestoreError(
            "Restore needs your confirmation that the controller, every worker and every admin job that " +
                "could write are stopped, and that Dokku operations they dispatched have settled " +
                "(--i-have-stopped-the-workers).",
        );
    }
    const problems = await verifyBackup(options.backupDir);
    if (problems.length > 0) {
        throw new RestoreError(
            `The backup does not verify, so nothing was restored:\n${problems.map((p) => `  ${p}`).join("\n")}`,
        );
    }
    const root = path.resolve(options.backupDir);
    const manifest: BackupManifest = JSON.parse(
        await fs.readFile(path.join(root, "manifest.json"), "utf8"),
    );
    const database = pgEnvironment(options.databaseUrl).PGDATABASE;
    // pg_restore reads a value with `=` or a URL scheme as a connection string, not a name.
    if (!database || database.includes("=") || /^postgres(ql)?:/i.test(database)) {
        throw new RestoreError("DATABASE_URL must name a plain database.");
    }
    const { createsPublic } = await preflightPgRestore(
        options,
        path.join(root, manifest.database.file),
    );

    const db = createDatabase(options.databaseUrl, { max: 1 });
    try {
        const populated = (await userTableCount(db)) > 0;
        const target = replaceTarget(options.databaseUrl);
        if (populated) {
            const dependents = await outsideDependents(db);
            if (dependents.length > 0) {
                throw new RestoreError(
                    `${dependents.join(", ")} (outside the public schema) depend on tables that --replace would drop. ` +
                        "Remove them, or restore into an empty database. Nothing was changed.",
                );
            }
            if (options.replaceDatabase === undefined) {
                throw new RestoreError(
                    `${target} already has data. Restore into an empty database, or replace it by naming ` +
                        `it with --replace ${target} (back it up first).`,
                );
            }
            if (options.replaceDatabase !== target) {
                throw new RestoreError(
                    `--replace names ${options.replaceDatabase}, but the target is ${target}.`,
                );
            }
        } else if (options.replaceDatabase !== undefined && options.replaceDatabase !== target) {
            throw new RestoreError(
                `--replace names ${options.replaceDatabase}, but the target is ${target}.`,
            );
        }

        // This build must know every migration the backup holds; one it does not know came from a
        // newer version, and restoring it here would leave a schema no code here understands.
        const status = await migrationStatus(db).catch(() => null);
        const known = status ? new Set([...status.applied, ...status.pending]) : new Set<string>();
        const unknown = manifest.migrations.filter((name) => !known.has(name));
        if (unknown.length > 0) {
            throw new RestoreError(
                `The backup holds migrations this version does not know (${unknown.join(", ")}): ` +
                    "restore it with the version that made it, or a newer one.",
            );
        }

        // Check every archive before anything is written: a file with the same name and other
        // content is not ours to overwrite.
        const toCopy: BackupManifest["artifacts"] = [];
        let present = 0;
        for (const artifact of manifest.artifacts) {
            const target = resolveArtifactPath(options.dataDir, artifact.storageKey);
            const existing = await fs.lstat(target).catch(() => null);
            if (!existing) {
                toCopy.push(artifact);
            } else if (existing.isFile() && (await hashFile(target)) === artifact.sha256) {
                present++;
            } else {
                throw new RestoreError(
                    `${target} exists with different content (or is not a plain file); nothing was restored.`,
                );
            }
        }
        for (const artifact of toCopy) {
            const target = resolveArtifactPath(options.dataDir, artifact.storageKey);
            await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
            const temp = `${target}.restore-${randomBytes(6).toString("hex")}`;
            try {
                // Hashed as it is copied: the file is checked against the manifest at the moment it is used.
                const hash = createHash("sha256");
                await pipeline(
                    createReadStream(path.join(root, artifact.storageKey)),
                    new Transform({
                        transform(chunk, _encoding, done) {
                            hash.update(chunk);
                            done(null, chunk);
                        },
                    }),
                    createWriteStream(temp, { mode: 0o600, flags: "wx" }),
                );
                if (hash.digest("hex") !== artifact.sha256) {
                    throw new RestoreError(
                        `${artifact.storageKey} changed while it was being copied.`,
                    );
                }
                await fs.rename(temp, target);
            } catch (error) {
                await fs.rm(temp, { force: true });
                throw error;
            }
        }

        // The old data is moved aside, not dropped: a restore that fails (or does not load what
        // the backup holds) puts it back, and it is dropped only once the new data checks out.
        const aside = `launchpad_replaced_${Date.now()}`;
        if (populated) {
            await db.transaction().execute(async (trx) => {
                // Do not wait behind a session that still holds the schema.
                await sql`set local lock_timeout = '10s'`.execute(trx);
                await sql.raw(`alter schema public rename to ${aside}`).execute(trx);
                if (!createsPublic) await sql`create schema public`.execute(trx);
            });
        } else if (createsPublic) {
            // The empty database's own `public` makes way for the one the dump creates.
            await sql`drop schema if exists public`.execute(db);
        } else {
            await sql`create schema if not exists public`.execute(db);
        }
        const putBack = async () => {
            await db.transaction().execute(async (trx) => {
                await sql`drop schema if exists public cascade`.execute(trx);
                if (populated) await sql.raw(`alter schema ${aside} rename to public`).execute(trx);
                else await sql`create schema public`.execute(trx);
            });
        };
        try {
            await runPgRestore(options, path.join(root, manifest.database.file));
            await verifyRestored(db, manifest);
        } catch (error) {
            await putBack().catch((undo) => {
                throw new RestoreError(
                    `The restore failed (${error instanceof Error ? error.message : String(error)}) and the old ` +
                        `data could not be put back (${String(undo)}); it is in the schema ${aside}.`,
                );
            });
            throw error;
        }
        if (populated) await sql.raw(`drop schema ${aside} cascade`).execute(db);

        const after = await migrationStatus(db);
        return {
            manifest,
            pendingMigrations: after.pending,
            filesRestored: toCopy.length,
            filesAlreadyPresent: present,
        };
    } finally {
        await db.destroy();
    }
}

// The restored database holds exactly the migrations and live archives the manifest names.
async function verifyRestored(db: Kysely<any>, manifest: BackupManifest) {
    const hasTable = await sql<{ present: boolean }>`
        select to_regclass('public.launchpad_migration') is not null as present`.execute(db);
    const applied = hasTable.rows[0]?.present
        ? (
              await sql<{
                  name: string;
              }>`select name from launchpad_migration order by name`.execute(db)
          ).rows.map((r) => r.name)
        : [];
    if (JSON.stringify(applied) !== JSON.stringify([...manifest.migrations].sort())) {
        throw new RestoreError(
            "The restored database does not hold the migrations the backup recorded.",
        );
    }
    // A backup older than the artifact table (before migration 010) has none to compare.
    const uncollected = (await columnExists(db, "artifact", "collected_at"))
        ? sql`where collected_at is null`
        : sql``;
    const keys = (await columnExists(db, "artifact", "storage_key"))
        ? (
              await sql<{ storage_key: string }>`
                  select storage_key from artifact ${uncollected} order by storage_key`.execute(db)
          ).rows.map((r) => r.storage_key)
        : [];
    if (
        JSON.stringify(keys) !== JSON.stringify(manifest.artifacts.map((a) => a.storageKey).sort())
    ) {
        throw new RestoreError("The restored artifacts do not match the backup's.");
    }
}

export interface CheckRestoreOptions {
    db: Kysely<Database>;
    dataDir: string;
    // Whether Dokku has the app; undefined skips that part of the check.
    appExists?: (appName: string) => Promise<boolean>;
}

export interface CheckRestoreReport {
    // Live archives whose file is not in the data directory.
    missingFiles: string[];
    // Live previews with a deployment whose Dokku app is gone.
    missingApps: { previewId: string; organizationId: string; slug: string; appName: string }[];
    appsChecked: number;
    dokkuChecked: boolean;
    // Live previews whose expiry has passed: extend any to keep before the lifecycle is switched on.
    expired: { previewId: string; slug: string; expiresAt: Date }[];
}

// Read-only: steps 3 and 4 of the restore runbook. It changes nothing and never destroys or
// recreates anything; what to do about what it finds (redeploy, extend, delete) is the
// administrator's, after deployments are back on.
export async function checkRestore(options: CheckRestoreOptions): Promise<CheckRestoreReport> {
    const { db } = options;
    const missingFiles: string[] = [];
    const artifacts = await db
        .selectFrom("artifact")
        .select("storage_key")
        .where("collected_at", "is", null)
        .orderBy("storage_key")
        .execute();
    for (const row of artifacts) {
        const file = resolveArtifactPath(options.dataDir, row.storage_key);
        if (!(await fs.lstat(file).catch(() => null))?.isFile()) missingFiles.push(row.storage_key);
    }

    const missingApps: CheckRestoreReport["missingApps"] = [];
    let appsChecked = 0;
    if (options.appExists) {
        // Only a preview that was ever deployed has an app; one being deleted is the deletion's.
        const previews = await db
            .selectFrom("preview")
            .select(["id", "organization_id", "slug", "app_name"])
            .where("desired_state", "=", "active")
            .where("active_deployment_id", "is not", null)
            .orderBy("created_at")
            .execute();
        for (const preview of previews) {
            appsChecked++;
            if (!(await options.appExists(preview.app_name))) {
                missingApps.push({
                    previewId: preview.id,
                    organizationId: preview.organization_id,
                    slug: preview.slug,
                    appName: preview.app_name,
                });
            }
        }
    }
    return {
        missingFiles,
        missingApps,
        appsChecked,
        dokkuChecked: options.appExists !== undefined,
        expired: (
            await db
                .selectFrom("preview")
                .select(["id", "slug", "expires_at"])
                .where("desired_state", "=", "active")
                .where("expires_at", "<", sql<Date>`now()`)
                .orderBy("expires_at")
                .execute()
        ).map((p) => ({ previewId: p.id, slug: p.slug, expiresAt: p.expires_at! })),
    };
}
