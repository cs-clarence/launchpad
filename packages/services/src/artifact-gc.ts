import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ArtifactTable, Database } from "@launchpad-kit/database";
import { type Kysely, type SelectQueryBuilder, sql } from "kysely";
import { resolveArtifactPath } from "./artifacts";
import { assertModelMutationsReady, withModelMutation } from "./deployment-recovery";

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

// The eligibility rule, applied to a query over `artifact as a`. It is used twice per
// collection: to pick a candidate, and again after the row is locked, because a deployment
// can commit in between and the first answer is then out of date.
function eligible<O>(
    query: SelectQueryBuilder<Database & { a: ArtifactTable }, "a", O>,
    retentionSeconds: number,
): SelectQueryBuilder<Database & { a: ArtifactTable }, "a", O> {
    const q = query;
    return q
        .where("a.collected_at", "is", null)
        .where(
            "a.created_at",
            "<",
            sql<Date>`clock_timestamp() - ${retentionSeconds} * interval '1 second'`,
        )
        .where(({ not, exists, selectFrom }) =>
            not(
                exists(
                    selectFrom("deployment as d")
                        .select("d.id")
                        .whereRef("d.artifact_id", "=", "a.id")
                        .whereRef("d.organization_id", "=", "a.organization_id")
                        .where((eb) =>
                            eb.or([
                                eb("d.desired_state", "<>", "deleted"),
                                eb("d.status", "in", [...UNFINISHED]),
                                eb(
                                    "d.deleted_at",
                                    ">",
                                    sql<Date>`clock_timestamp() - ${retentionSeconds} * interval '1 second'`,
                                ),
                            ]),
                        ),
                ),
            ),
        );
}

export interface CollectOptions {
    dataDir: string;
    retentionSeconds: number;
    limit?: number;
    // Test seams: run between choosing a candidate and locking it, and between the commit
    // and the removal of the old file. They exist so the races they stand for can be
    // reproduced deterministically; nothing in production sets them.
    afterCandidate?: (artifactId: string) => Promise<void>;
    afterCommit?: (artifactId: string) => Promise<void>;
}

// Collects stored archives nothing can need any more, one artifact per transaction. An
// artifact is eligible only when ALL of these hold:
//   - it is older than the retention period;
//   - no non-deleted deployment or unfinished/held deployment points at it;
//   - no deployment that used it was deleted within the retention period (so what was just
//     deleted can still be recovered by hand during that time).
// An upload nobody deployed is simply old enough. The row stays (marked collected) because
// deployments and audit records still point at it.
//
// Concurrency: a candidate is chosen, then locked, then judged AGAIN in a new statement (a
// deployment may have committed in between; once the row is locked none can). The archive is
// moved aside to a name only this collection knows, inside the transaction, and removed after
// the commit: a re-upload that restores the archive in the meantime writes the real name and
// is never touched, and a failed commit puts the file back.
// A collection runs under the model-mutation gate and records model-writer-seen even when it
// removes nothing. The record is history for operators; it does not decide recovery-clear.
export async function collectArtifacts(
    db: Db,
    options: CollectOptions,
): Promise<{ collected: string[] }> {
    const limit = options.limit ?? COLLECT_BATCH;
    if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new Error("limit must be a positive integer.");
    }
    if (!Number.isFinite(options.retentionSeconds) || options.retentionSeconds < 0) {
        throw new Error("retentionSeconds must not be negative.");
    }
    const collected: string[] = [];
    const skipped: string[] = [];
    for (let round = 0; round < limit * 4 && collected.length < limit; round++) {
        let moved: { from: string; to: string } | null = null;
        let outcome:
            | { kind: "none" }
            | { kind: "skip"; id: string }
            | { kind: "collected"; id: string; to: string | null };
        try {
            outcome = await withModelMutation(db, options.dataDir, async (trx) => {
                const candidate = await (() => {
                    const q = eligible(
                        trx
                            .selectFrom("artifact as a")
                            .select(["a.id", "a.organization_id", "a.storage_key"]),
                        options.retentionSeconds,
                    );
                    return (skipped.length > 0 ? q.where("a.id", "not in", skipped) : q)
                        .orderBy("a.created_at")
                        .limit(1)
                        .executeTakeFirst();
                })();
                if (!candidate) return { kind: "none" } as const;
                // A key that is not one this module wrote cannot be moved or removed: leave the
                // row alone, and do not let it be the oldest candidate every round.
                let final: string;
                try {
                    final = resolveArtifactPath(options.dataDir, candidate.storage_key);
                } catch {
                    return { kind: "skip", id: candidate.id } as const;
                }
                await options.afterCandidate?.(candidate.id);
                // The owner's upload lock first, then the row, in the order finalizing an upload
                // takes them, so the two cannot wait on each other; and so a sweep or a
                // recovery (which take it per file) never sees an archive half moved.
                await sql`select pg_advisory_xact_lock(hashtextextended(${`artifacts:${candidate.storage_key.split("/")[1]}`}, 0))`.execute(
                    trx,
                );
                const locked = await trx
                    .selectFrom("artifact")
                    .select("id")
                    .where("id", "=", candidate.id)
                    .where("collected_at", "is", null)
                    .forUpdate()
                    .skipLocked()
                    .executeTakeFirst();
                if (!locked) return { kind: "skip", id: candidate.id } as const;
                // A new statement, so it sees what committed while this one waited.
                const still = await eligible(
                    trx.selectFrom("artifact as a").select("a.id"),
                    options.retentionSeconds,
                )
                    .where("a.id", "=", candidate.id)
                    .executeTakeFirst();
                if (!still) return { kind: "skip", id: candidate.id } as const;
                await trx
                    .updateTable("artifact")
                    .set({ collected_at: sql<Date>`now()` })
                    .where("id", "=", candidate.id)
                    .execute();
                await trx
                    .insertInto("audit_event")
                    .values({
                        actor: "system",
                        action: "artifact.collected",
                        target_type: "artifact",
                        target_id: candidate.id,
                        organization_id: candidate.organization_id,
                    })
                    .execute();
                const aside = `${final}.${randomBytes(8).toString("hex")}.gone`;
                const renamed = await fs.rename(final, aside).then(
                    () => true,
                    (error: NodeJS.ErrnoException) => {
                        if (error.code === "ENOENT") return false;
                        throw error;
                    },
                );
                if (renamed) moved = { from: final, to: aside };
                return { kind: "collected", id: candidate.id, to: renamed ? aside : null } as const;
            });
        } catch (error) {
            // The commit did not happen: the row still claims an archive, so it goes back.
            const undo = moved as { from: string; to: string } | null;
            if (undo) await fs.rename(undo.to, undo.from).catch(() => undefined);
            throw error;
        }
        if (outcome.kind === "none") break;
        if (outcome.kind === "skip") {
            skipped.push(outcome.id);
            continue;
        }
        await options.afterCommit?.(outcome.id);
        if (outcome.to) await fs.rm(outcome.to, { force: true });
        collected.push(outcome.id);
    }
    return { collected };
}

const KEY_DIR = /^[0-9a-f]{32}$/;
const KEY_FILE = /^[0-9a-f]{64}\.tar\.gz$/;
// What a collection moves an archive to before removing it for good.
const ASIDE_FILE = /^[0-9a-f]{64}\.tar\.gz\.[0-9a-f]{16}\.gone$/;
export const MAX_SWEPT_FILES = 10_000;

// Removes archive files nothing refers to: no live artifact row names them (none, or one
// marked collected), and the file is older than the retention period (a younger one may be an
// upload whose row is not committed yet). Only files named the way this module stores them,
// two levels below `artifacts/`, are looked at. The walk is bounded.
//
// A moved-aside file belongs to a collection. If its artifact is collected (or unknown) it is
// removed once it has been aside for the retention. If the artifact is still live, the
// collection never committed (its process died between the move and the commit): the
// archive is the only copy, so it is put back, never removed.
//
// Each change is made under the owner's upload lock, the one finalizing an upload holds
// while it stores the archive and makes its row live: the file and the row are looked at
// again under it, so an upload that lands after the first look is never deleted.
export async function sweepOrphanArtifactFiles(
    db: Db,
    options: {
        dataDir: string;
        retentionSeconds: number;
        // How long a moved-aside file of a live artifact is left alone before it is put back:
        // a collection in progress holds it aside for a moment. Defaults to a minute.
        graceMs?: number;
        // Upper bound on recognized files visited in one call; defaults to MAX_SWEPT_FILES.
        maxFiles?: number;
        // Look only at moved-aside files (what recovery needs), not counting the rest.
        asideOnly?: boolean;
        // Test seam: runs after a file was judged removable and before it is removed, so the
        // race it stands for (an upload landing in that gap) can be reproduced.
        beforeRemove?: (file: string) => Promise<void>;
    },
): Promise<{ removed: number; restored: number }> {
    await assertModelMutationsReady(db, options.dataDir);
    const root = path.join(options.dataDir, "artifacts");
    const graceMs = options.graceMs ?? 60_000;
    const maxFiles = options.maxFiles ?? MAX_SWEPT_FILES;
    let removed = 0;
    let restored = 0;
    let seen = 0;
    const owners = await fs.readdir(root).catch(() => [] as string[]);
    for (const owner of owners) {
        if (!KEY_DIR.test(owner)) continue;
        // A plain directory only: a link here could point the sweep outside the data directory.
        const entry = await fs.lstat(path.join(root, owner)).catch(() => null);
        if (!entry?.isDirectory()) continue;
        const names = await fs.readdir(path.join(root, owner)).catch(() => [] as string[]);
        for (const name of names) {
            const aside = ASIDE_FILE.test(name);
            if (!aside && (options.asideOnly || !KEY_FILE.test(name))) continue;
            if (++seen > maxFiles) return { removed, restored };
            const file = path.join(root, owner, name);
            const base = aside ? name.slice(0, name.indexOf(".tar.gz") + ".tar.gz".length) : name;
            const baseKey = `artifacts/${owner}/${base}`;
            const outcome = await withModelMutation(db, options.dataDir, async (trx) => {
                await sql`select pg_advisory_xact_lock(hashtextextended(${`artifacts:${owner}`}, 0))`.execute(
                    trx,
                );
                const stat = await fs.lstat(file).catch(() => null);
                if (!stat?.isFile()) return "kept" as const;
                const live = await trx
                    .selectFrom("artifact")
                    .select("id")
                    .where("storage_key", "=", baseKey)
                    .where("collected_at", "is", null)
                    .executeTakeFirst();
                // A moved-aside file keeps its archive's modification time; the move itself
                // is what ctime records.
                const since = aside ? stat.ctimeMs : stat.mtimeMs;
                const age = Date.now() - since;
                if (aside && live) {
                    if (age <= graceMs) return "kept" as const;
                    const target = path.join(root, owner, base);
                    const present = await fs.lstat(target).then(
                        () => true,
                        () => false,
                    );
                    if (present) {
                        // The archive is back (a re-upload repaired it): this copy is spare.
                        await fs.rm(file, { force: true });
                        return "removed" as const;
                    }
                    await fs.rename(file, target);
                    return "restored" as const;
                }
                if (age <= options.retentionSeconds * 1000) return "kept" as const;
                if (!aside && live) return "kept" as const;
                await options.beforeRemove?.(file);
                await fs.rm(file, { force: true });
                return "removed" as const;
            });
            if (outcome === "removed") removed++;
            if (outcome === "restored") restored++;
        }
    }
    return { removed, restored };
}

// For a worker's start, before it claims anything: puts back every archive a collection that
// died before its commit left aside, so a live artifact never points at a missing file. No
// grace period is needed: a collection in progress (this worker's or another's) holds the
// owner's upload lock, which every file here is judged under, so it is seen either before it
// moved the archive or after it committed.
export async function recoverInterruptedCollections(
    db: Db,
    options: { dataDir: string },
): Promise<{ restored: number }> {
    const { restored } = await sweepOrphanArtifactFiles(db, {
        dataDir: options.dataDir,
        // Nothing ordinary is removed: only what belongs to a live artifact is touched.
        retentionSeconds: Number.POSITIVE_INFINITY,
        graceMs: 0,
        // Every moved-aside file is looked at once, however many ordinary archives there are:
        // a bound that stopped early could leave a live artifact without its file.
        asideOnly: true,
        maxFiles: Number.POSITIVE_INFINITY,
    });
    return { restored };
}
