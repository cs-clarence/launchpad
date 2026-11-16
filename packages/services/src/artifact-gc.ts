import { promises as fs } from "node:fs";
import path from "node:path";
import type { Database } from "@launchpad/database";
import { type Kysely, sql } from "kysely";
import { resolveArtifactPath } from "./artifacts";
import { LIFECYCLE_AUDIT } from "./lifecycle";

type Db = Kysely<Database>;

const UNFINISHED = [
    "queued",
    "preparing",
    "building",
    "deploying",
    "verifying",
    "reconciliation-needed",
] as const;

export const COLLECT_BATCH = 50;

// Collects stored archives nothing can need any more, one artifact per transaction. An
// artifact is eligible only when ALL of these hold, judged under the row lock:
//   - it is older than the retention period;
//   - no deployment of a preview that is not `deleted` points at it (so a live preview keeps
//     the archive its rollback is rebuilt from), and none that is unfinished or held for
//     reconciliation does;
//   - no preview that used it was deleted within the retention period (so what was just
//     deleted can still be recovered by hand during that time).
// An upload nobody deployed is simply old enough. The row stays (marked collected) because
// deployments and audit records still point at it; the archive file goes after the row is
// marked, never before, so a row never claims an archive that is missing.
export async function collectArtifacts(
    db: Db,
    options: { dataDir: string; retentionSeconds: number; limit?: number },
): Promise<{ collected: string[] }> {
    const limit = options.limit ?? COLLECT_BATCH;
    if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new Error("limit must be a positive integer.");
    }
    if (!Number.isFinite(options.retentionSeconds) || options.retentionSeconds < 0) {
        throw new Error("retentionSeconds must not be negative.");
    }
    const collected: string[] = [];
    for (let i = 0; i < limit; i++) {
        const done = await db.transaction().execute(async (trx) => {
            const row = await trx
                .selectFrom("artifact as a")
                .select(["a.id", "a.organization_id", "a.storage_key"])
                .where("a.collected_at", "is", null)
                .where(
                    "a.created_at",
                    "<",
                    sql<Date>`clock_timestamp() - ${options.retentionSeconds} * interval '1 second'`,
                )
                .where(({ not, exists, selectFrom }) =>
                    not(
                        exists(
                            selectFrom("deployment as d")
                                .innerJoin("preview as p", (join) =>
                                    join
                                        .onRef("p.id", "=", "d.preview_id")
                                        .onRef("p.organization_id", "=", "d.organization_id"),
                                )
                                .select("d.id")
                                .whereRef("d.artifact_id", "=", "a.id")
                                .whereRef("d.organization_id", "=", "a.organization_id")
                                .where((eb) =>
                                    eb.or([
                                        eb("p.desired_state", "<>", "deleted"),
                                        eb("d.status", "in", [...UNFINISHED]),
                                        eb(
                                            "p.deleted_at",
                                            ">",
                                            sql<Date>`clock_timestamp() - ${options.retentionSeconds} * interval '1 second'`,
                                        ),
                                    ]),
                                ),
                        ),
                    ),
                )
                .orderBy("a.created_at")
                .limit(1)
                .forUpdate("a")
                .skipLocked()
                .executeTakeFirst();
            if (!row) return null;
            await trx
                .updateTable("artifact")
                .set({ collected_at: sql<Date>`now()` })
                .where("id", "=", row.id)
                .execute();
            await trx
                .insertInto("audit_event")
                .values({
                    actor: "system",
                    action: LIFECYCLE_AUDIT.artifactCollected,
                    target_type: "artifact",
                    target_id: row.id,
                    organization_id: row.organization_id,
                })
                .execute();
            return row;
        });
        if (!done) break;
        // After the commit: a crash here leaves a file with a collected row, which the orphan
        // sweep removes. The path is rebuilt from the stored key by the one checked resolver.
        await fs.rm(resolveArtifactPath(options.dataDir, done.storage_key), { force: true });
        collected.push(done.id);
    }
    return { collected };
}

const KEY_DIR = /^[0-9a-f]{32}$/;
const KEY_FILE = /^[0-9a-f]{64}\.tar\.gz$/;
export const MAX_SWEPT_FILES = 10_000;

// Removes archive files nothing refers to: no artifact row names them, or the row is
// marked collected, and the file is older than the retention period (a file younger than
// that may be an upload whose row is not committed yet). Only files named the way this
// module stores them, two levels below `artifacts/`, are looked at. The walk is bounded.
export async function sweepOrphanArtifactFiles(
    db: Db,
    options: { dataDir: string; retentionSeconds: number },
): Promise<{ removed: number }> {
    const root = path.join(options.dataDir, "artifacts");
    let removed = 0;
    let seen = 0;
    const owners = await fs.readdir(root).catch(() => [] as string[]);
    for (const owner of owners) {
        if (!KEY_DIR.test(owner)) continue;
        const names = await fs.readdir(path.join(root, owner)).catch(() => [] as string[]);
        for (const name of names) {
            if (!KEY_FILE.test(name)) continue;
            if (++seen > MAX_SWEPT_FILES) return { removed };
            const file = path.join(root, owner, name);
            const stat = await fs.lstat(file).catch(() => null);
            if (!stat?.isFile()) continue;
            if (Date.now() - stat.mtimeMs <= options.retentionSeconds * 1000) continue;
            const key = `artifacts/${owner}/${name}`;
            const live = await db
                .selectFrom("artifact")
                .select("id")
                .where("storage_key", "=", key)
                .where("collected_at", "is", null)
                .executeTakeFirst();
            if (live) continue;
            await fs.rm(file, { force: true });
            removed++;
        }
    }
    return { removed };
}
