import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createDatabase, type Database, migrationStatus } from "@launchpad/database";
import { resolveArtifactPath, WORKER_LIVE_SECONDS } from "@launchpad/services";
import { type Kysely, sql } from "kysely";
import { type BackupManifest, pgEnvironment, verifyBackup } from "./backup";

export class RestoreError extends Error {
    override name = "RestoreError";
}

export interface RestoreOptions {
    backupDir: string;
    // The database to restore into: an empty one, or one named in `replaceDatabase`.
    databaseUrl: string;
    dataDir: string;
    // The operator's confirmation that docs/plans/application.md's restore step 1 is done: the
    // lifecycle and deployments off, every worker stopped and waited for, destroys settled.
    workersStopped: boolean;
    // Replace a database that already has data: the name of that database, typed out.
    replaceDatabase?: string;
    pgRestore?: string;
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
        },
    );
    let errors = "";
    child.stderr.on("data", (chunk) => (errors += chunk));
    child.stdout.resume();
    const exited = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
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

async function userTableCount(db: Kysely<any>) {
    const { rows } = await sql<{ n: string }>`
        select count(*) as n from pg_class c join pg_namespace s on s.oid = c.relnamespace
        where s.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')`.execute(db);
    return Number(rows[0]?.n ?? 0);
}

// Restores a backup made by `createBackup`: the stored archives first (additive, so a failure
// there changes nothing that matters), then the database. It never touches Dokku. It restores
// into an empty database, or into one the operator names to be replaced, and it refuses while a
// worker is running against the target. What the operator must do before and after is the
// restore runbook in docs/plans/application.md; this does the middle of it.
export async function restoreBackup(options: RestoreOptions): Promise<RestoreResult> {
    if (!options.workersStopped) {
        throw new RestoreError(
            "Restore needs your confirmation that the lifecycle and deployments are off and every worker " +
                "has stopped and been waited for (--i-have-stopped-the-workers).",
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

    const db = createDatabase(options.databaseUrl, { max: 1 });
    try {
        const populated = (await userTableCount(db)) > 0;
        if (populated) {
            // Whoever is running against this database is the first thing to refuse, whatever else is said.
            const heartbeat = await sql<{ n: string }>`
                select count(*) as n from (select to_regclass('worker_heartbeat') as t) r
                where t is not null`.execute(db);
            if (Number(heartbeat.rows[0]?.n) > 0) {
                const live = await sql<{ n: string }>`
                    select count(*) as n from worker_heartbeat
                    where last_seen_at > now() - ${WORKER_LIVE_SECONDS} * interval '1 second'`.execute(
                    db,
                );
                if (Number(live.rows[0]?.n) > 0) {
                    throw new RestoreError(
                        "A worker has reported in the last minute: it is still running against this database. " +
                            "Stop every worker and wait for it to exit first.",
                    );
                }
            }
            if (options.replaceDatabase === undefined) {
                throw new RestoreError(
                    `The database ${database} already has data. Restore into an empty database, or replace it ` +
                        "by naming it with --replace (everything in it is deleted).",
                );
            }
            if (options.replaceDatabase !== database) {
                throw new RestoreError(
                    `--replace names ${options.replaceDatabase}, but the database is ${database}.`,
                );
            }
        } else if (options.replaceDatabase !== undefined && options.replaceDatabase !== database) {
            throw new RestoreError(
                `--replace names ${options.replaceDatabase}, but the database is ${database}.`,
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
                await pipeline(
                    createReadStream(path.join(root, artifact.storageKey)),
                    createWriteStream(temp, { mode: 0o600 }),
                );
                await fs.rename(temp, target);
            } catch (error) {
                await fs.rm(temp, { force: true });
                throw error;
            }
        }

        if (populated) {
            // Replacing is a clean slate: restoring over the top would leave anything this backup
            // does not have (a newer table, say) beside the old data.
            await sql`drop schema public cascade`.execute(db);
            await sql`create schema public`.execute(db);
        }
        await runPgRestore(options, path.join(root, manifest.database.file));

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
    };
}
