import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Database } from "@launchpad/database";
import { type Kysely, sql } from "kysely";
import { ArchiveError, validateArchive } from "./archive";
import type { Principal } from "./authorization";
import { ServiceError } from "./errors";
import { recordAudit, requireMembership } from "./organizations";

type Db = Kysely<Database>;

export interface ArtifactLimits {
    maxUploadBytes: number;
    maxExpandedBytes: number;
    maxEntries: number;
    maxDepth: number;
    uploadTimeoutMs: number;
    // Artifacts kept per organization. They are not deleted until the cleanup
    // milestone, so this is a hard ceiling for now.
    maxArtifacts: number;
    // Uploads one organization may have in flight; each stages up to a full archive.
    maxConcurrentUploads: number;
}

export const DEFAULT_ARTIFACT_LIMITS: ArtifactLimits = {
    maxUploadBytes: 50 * 1024 * 1024,
    maxExpandedBytes: 200 * 1024 * 1024,
    maxEntries: 5000,
    maxDepth: 16,
    uploadTimeoutMs: 5 * 60 * 1000,
    maxArtifacts: 20,
    maxConcurrentUploads: 2,
};

export interface ArtifactDeps {
    // A directory only the controller can write. Uploads are staged in `tmp/` and
    // finalized into `artifacts/`; both are created on first use.
    dataDir: string;
    limits?: Partial<ArtifactLimits>;
}

export function resolveLimits(overrides: Partial<ArtifactLimits> = {}): ArtifactLimits {
    const limits = { ...DEFAULT_ARTIFACT_LIMITS, ...overrides };
    for (const [name, value] of Object.entries(limits)) {
        if (!Number.isSafeInteger(value) || value < 1) {
            throw new Error(`Artifact limit ${name} must be a positive integer.`);
        }
    }
    return limits;
}

const STORAGE_KEY = /^artifacts\/[0-9a-f]{32}\/[0-9a-f]{64}\.tar\.gz$/;

// The organization id is an opaque string from the auth library, so it never becomes
// a path component itself; a fixed-length hash of it does.
export function artifactStorageKey(organizationId: string, digest: string): string {
    const owner = createHash("sha256").update(organizationId).digest("hex").slice(0, 32);
    return `artifacts/${owner}/${digest}.tar.gz`;
}

// Turns a stored key back into a path, refusing anything that is not exactly the
// shape this module writes.
export function resolveArtifactPath(dataDir: string, storageKey: string): string {
    if (!STORAGE_KEY.test(storageKey)) throw new Error("Not an artifact storage key.");
    return path.join(dataDir, storageKey);
}

// FileHandle.write may write less than it was given. Writes the whole chunk, and
// fails if the file system stops making progress rather than dropping the rest.
export async function writeFully(
    handle: {
        write(
            buffer: Uint8Array,
            offset: number,
            length: number,
        ): Promise<{ bytesWritten: number }>;
    },
    chunk: Uint8Array,
): Promise<void> {
    let offset = 0;
    while (offset < chunk.byteLength) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
        if (bytesWritten <= 0) throw new Error("The staging file stopped accepting data.");
        offset += bytesWritten;
    }
}

const tmpDir = (dataDir: string) => path.join(dataDir, "tmp");

// Removes upload leftovers from a process that died mid-upload. Only `.part` files
// this module names are touched, and only once they are old enough to be abandoned.
export async function sweepStaleUploads(dataDir: string, maxAgeMs = 60 * 60 * 1000) {
    let names: string[];
    try {
        names = await fs.readdir(tmpDir(dataDir));
    } catch {
        return 0;
    }
    let removed = 0;
    for (const name of names) {
        if (!/^upload-[0-9a-f]{24}\.part$/.test(name)) continue;
        const file = path.join(tmpDir(dataDir), name);
        const stat = await fs.stat(file).catch(() => null);
        if (stat?.isFile() && Date.now() - stat.mtimeMs > maxAgeMs) {
            await fs.rm(file, { force: true });
            removed++;
        }
    }
    return removed;
}

export interface UploadedArtifact {
    id: string;
    digest: string;
    sizeBytes: number;
    expandedBytes: number;
    entryCount: number;
    createdAt: Date;
    reused: boolean;
}

// Uploads in flight stage up to a full archive each on the controller's disk, so a
// caller cannot hold more than a few open: per organization (a limit) and in total.
export const MAX_UPLOADS_TOTAL = 8;
const activeUploads = new Map<string, number>();
let activeTotal = 0;

function takeUploadSlot(organizationId: string, perOrganization: number): boolean {
    const mine = activeUploads.get(organizationId) ?? 0;
    if (mine >= perOrganization || activeTotal >= MAX_UPLOADS_TOTAL) return false;
    activeUploads.set(organizationId, mine + 1);
    activeTotal++;
    return true;
}

function releaseUploadSlot(organizationId: string): void {
    const mine = (activeUploads.get(organizationId) ?? 1) - 1;
    if (mine <= 0) activeUploads.delete(organizationId);
    else activeUploads.set(organizationId, mine);
    activeTotal = Math.max(0, activeTotal - 1);
}

async function countArtifacts(db: Db, organizationId: string): Promise<number> {
    const row = await db
        .selectFrom("artifact")
        .select((eb) => eb.fn.countAll<string>().as("n"))
        .where("organization_id", "=", organizationId)
        .executeTakeFirstOrThrow();
    return Number(row.n);
}

// Streams `body` to a private temporary file, bounded in bytes and in time, then
// validates it as an archive and finalizes it. The caller is authorized before the
// first byte is read. Only a finished, valid archive ever becomes an artifact: the
// temporary file is removed on every other path.
export async function uploadArtifact(
    db: Db,
    principal: Principal,
    organizationId: string,
    body: ReadableStream<Uint8Array> | null,
    meta: { contentLength: number | null },
    deps: ArtifactDeps,
    signal?: AbortSignal,
): Promise<UploadedArtifact> {
    await requireMembership(db, principal, organizationId, "preview:deploy");
    const limits = resolveLimits(deps.limits);
    if (!body) throw new ServiceError("invalid", "The request has no body.");
    if (meta.contentLength !== null && meta.contentLength > limits.maxUploadBytes) {
        await body.cancel().catch(() => {});
        throw new ServiceError("too-large", "The upload is larger than the allowed size.");
    }
    // Fail before reading anything when the organization has no room left.
    if ((await countArtifacts(db, organizationId)) >= limits.maxArtifacts) {
        await body.cancel().catch(() => {});
        throw new ServiceError("conflict", "This organization has too many stored artifacts.");
    }

    if (!takeUploadSlot(organizationId, limits.maxConcurrentUploads)) {
        await body.cancel().catch(() => {});
        throw new ServiceError("conflict", "Too many uploads are in progress. Try again shortly.");
    }
    let temp = "";
    try {
        await fs.mkdir(tmpDir(deps.dataDir), { recursive: true, mode: 0o700 });
        temp = path.join(tmpDir(deps.dataDir), `upload-${randomBytes(12).toString("hex")}.part`);
        const { digest, bytes } = await receive(body, temp, limits, meta.contentLength, signal);
        let summary;
        try {
            summary = await validateArchive(temp, limits);
        } catch (error) {
            if (error instanceof ArchiveError) throw new ServiceError("invalid", error.message);
            throw error;
        }
        return await finalize(
            db,
            principal,
            organizationId,
            temp,
            digest,
            bytes,
            summary,
            deps,
            limits,
        );
    } finally {
        releaseUploadSlot(organizationId);
        if (temp) await fs.rm(temp, { force: true });
    }
}

async function receive(
    body: ReadableStream<Uint8Array>,
    temp: string,
    limits: ArtifactLimits,
    declared: number | null,
    outer?: AbortSignal,
) {
    const timeout = AbortSignal.timeout(limits.uploadTimeoutMs);
    const signal = outer ? AbortSignal.any([outer, timeout]) : timeout;
    const reader = body.getReader();
    const hash = createHash("sha256");
    // `wx`: never reopen an existing file; `0o600`: private to the controller.
    const handle = await fs.open(temp, "wx", 0o600);
    let bytes = 0;
    const stop = () => void reader.cancel().catch(() => {});
    signal.addEventListener("abort", stop, { once: true });
    try {
        // An abort that happened before the listener was added would never fire it.
        if (signal.aborted) stop();
        for (;;) {
            let result: Awaited<ReturnType<typeof reader.read>>;
            try {
                result = await reader.read();
            } catch {
                if (signal.aborted) {
                    throw new ServiceError(
                        "timeout",
                        "The upload did not finish in time or was cancelled.",
                    );
                }
                throw new ServiceError("invalid", "The upload was interrupted.");
            }
            if (signal.aborted) {
                throw new ServiceError("timeout", "The upload did not finish in time.");
            }
            if (result.done) break;
            bytes += result.value.byteLength;
            if (bytes > limits.maxUploadBytes) {
                await reader.cancel().catch(() => {});
                throw new ServiceError("too-large", "The upload is larger than the allowed size.");
            }
            hash.update(result.value);
            await writeFully(handle, result.value);
        }
    } finally {
        signal.removeEventListener("abort", stop);
        await handle.close();
    }
    if (bytes === 0) throw new ServiceError("invalid", "The upload is empty.");
    if (declared !== null && bytes !== declared) {
        throw new ServiceError("invalid", "The upload ended before its declared length.");
    }
    return { digest: hash.digest("hex"), bytes };
}

async function finalize(
    db: Db,
    principal: Principal,
    organizationId: string,
    temp: string,
    digest: string,
    bytes: number,
    summary: { entryCount: number; expandedBytes: number },
    deps: ArtifactDeps,
    limits: ArtifactLimits,
): Promise<UploadedArtifact> {
    const key = artifactStorageKey(organizationId, digest);
    const final = resolveArtifactPath(deps.dataDir, key);
    const shape = (
        row: {
            id: string;
            created_at: Date;
            size_bytes: string | number;
            expanded_bytes: string | number;
            entry_count: number;
        },
        reused: boolean,
    ): UploadedArtifact => ({
        id: row.id,
        digest,
        sizeBytes: Number(row.size_bytes),
        expandedBytes: Number(row.expanded_bytes),
        entryCount: row.entry_count,
        createdAt: row.created_at,
        reused,
    });

    return db.transaction().execute(async (trx) => {
        // One finalizer per organization: the quota and the digest check cannot race.
        await sql`select pg_advisory_xact_lock(hashtextextended(${`artifacts:${organizationId}`}, 0))`.execute(
            trx,
        );
        // Authority is re-read under the lock: a caller removed during a long upload
        // must not still store an artifact.
        await requireMembership(trx, principal, organizationId, "preview:deploy");
        const existing = await trx
            .selectFrom("artifact")
            .select(["id", "created_at", "size_bytes", "expanded_bytes", "entry_count"])
            .where("organization_id", "=", organizationId)
            .where("digest", "=", digest)
            .executeTakeFirst();
        if (existing) return shape(existing, true);
        if ((await countArtifacts(trx, organizationId)) >= limits.maxArtifacts) {
            throw new ServiceError("conflict", "This organization has too many stored artifacts.");
        }
        const existed = await fs.stat(final).then(
            () => true,
            () => false,
        );
        await fs.mkdir(path.dirname(final), { recursive: true, mode: 0o700 });
        // Atomic on one file system: the file appears under its final name only when
        // complete. The same digest is the same bytes, so a leftover is harmless.
        await fs.rename(temp, final);
        try {
            const row = await trx
                .insertInto("artifact")
                .values({
                    organization_id: organizationId,
                    digest,
                    size_bytes: bytes,
                    expanded_bytes: summary.expandedBytes,
                    entry_count: summary.entryCount,
                    storage_key: key,
                    created_by: principal.userId,
                })
                .returning(["id", "created_at", "size_bytes", "expanded_bytes", "entry_count"])
                .executeTakeFirstOrThrow();
            await recordAudit(trx, {
                actor: principal,
                action: "artifact.created",
                targetType: "artifact",
                targetId: row.id,
                organizationId,
                detail: JSON.stringify({ sizeBytes: bytes, entryCount: summary.entryCount }),
            });
            return shape(row, false);
        } catch (error) {
            if (!existed) await fs.rm(final, { force: true });
            throw error;
        }
    });
}
