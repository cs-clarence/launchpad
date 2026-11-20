import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDatabase } from "@launchpad-kit/database/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
    addMember,
    artifactStorageKey,
    createOrganization,
    createProject,
    removeMember,
    resolveArtifactPath,
    resolveLimits,
    ServiceError,
    sweepStaleUploads,
    uploadArtifact,
    writeFully,
    type ArtifactDeps,
    type Principal,
} from "../index";
import { SITE, tarGz, type FixtureEntry } from "../testing/tar-fixtures";

let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
const people: Record<string, Principal> = {};
let org = "";
let otherOrg = "";
// One project per organization: every upload names the project it came through.
const projects: Record<string, string> = {};
let projectId = "";
let dataDir = "";

const code = (promise: Promise<unknown>) =>
    promise.then(
        () => "ok",
        (e) => (e instanceof ServiceError ? e.code : `unexpected: ${e}`),
    );

async function newUser(name: string, role: "user" | "operator" = "user") {
    const id = randomUUID();
    await testDb.db
        .insertInto("user")
        .values({ id, name, email: `${name}@example.com`, emailVerified: false, image: null, role })
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
    people[name] = { userId: id, instanceRole: role };
}

function stream(bytes: Buffer, chunk = 16 * 1024) {
    let offset = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (offset >= bytes.length) return controller.close();
            controller.enqueue(bytes.subarray(offset, offset + chunk));
            offset += chunk;
        },
    });
}

// A stream that records whether anything read it, and whether it was cancelled.
function spy(bytes: Buffer) {
    const state = { pulled: 0, cancelled: false };
    let offset = 0;
    // highWaterMark 0: nothing is pulled until a reader asks, so `pulled` counts reads.
    const body = new ReadableStream<Uint8Array>(
        {
            pull(controller) {
                state.pulled++;
                if (offset >= bytes.length) return controller.close();
                controller.enqueue(bytes.subarray(offset, offset + 4096));
                offset += 4096;
            },
            cancel() {
                state.cancelled = true;
            },
        },
        { highWaterMark: 0 },
    );
    return { body, state };
}

// Tests that start many uploads at once raise the per-organization cap, which is on its
// own in the test of the cap itself.
const deps = (limits: ArtifactDeps["limits"] = {}): ArtifactDeps => ({
    dataDir,
    limits: { maxConcurrentUploads: 50, ...limits },
});
const upload = (
    who: string,
    bytes: Buffer,
    options: { org?: string; limits?: ArtifactDeps["limits"]; length?: number | null } = {},
) =>
    uploadArtifact(
        testDb.db,
        people[who]!,
        options.org ?? org,
        stream(bytes),
        {
            contentLength: options.length === undefined ? bytes.length : options.length,
            projectId: projects[options.org ?? org]!,
        },
        deps(options.limits),
    );

// Every file below the data directory except the artifacts that were kept.
async function leftovers() {
    const names = await fs.readdir(path.join(dataDir, "tmp")).catch(() => []);
    return names;
}
const site = (extra: FixtureEntry[] = []) => tarGz([...SITE, ...extra]);

beforeAll(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "launchpad-artifacts-"));
    testDb = await createTestDatabase();
    await testDb.migrate();
    await newUser("root", "operator");
    for (const n of ["ann", "dee", "vic", "zoe"]) await newUser(n);
    const db = testDb.db;
    org = (
        await createOrganization(db, people.root!, {
            name: "Acme",
            slug: "acme",
            ownerEmail: "ann@example.com",
        })
    ).id;
    otherOrg = (
        await createOrganization(db, people.root!, {
            name: "Beta",
            slug: "beta",
            ownerEmail: "zoe@example.com",
        })
    ).id;
    projects[org] = (await createProject(db, people.ann!, org, { name: "Site", slug: "site" })).id;
    projectId = projects[org]!;
    projects[otherOrg] = (
        await createProject(db, people.zoe!, otherOrg, { name: "Site", slug: "site" })
    ).id;
    await addMember(db, people.ann!, org, { email: "dee@example.com", role: "deployer" });
    await addMember(db, people.ann!, org, { email: "vic@example.com", role: "viewer" });
});
afterAll(async () => {
    await testDb.destroy();
    await fs.rm(dataDir, { recursive: true, force: true });
});

describe("uploading an artifact", () => {
    it("stores a valid archive under a content-addressed key and records it", async () => {
        const bytes = site([{ name: "unique-1.txt", content: "one" }]);
        const result = await upload("dee", bytes);
        expect(result).toMatchObject({ reused: false, sizeBytes: bytes.length, entryCount: 4 });
        expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
        const row = await testDb.db
            .selectFrom("artifact")
            .selectAll()
            .where("id", "=", result.id)
            .executeTakeFirstOrThrow();
        expect(row.storage_key).toBe(artifactStorageKey(org, result.digest));
        expect(row.storage_key).not.toContain(org);
        const stored = await fs.readFile(resolveArtifactPath(dataDir, row.storage_key));
        expect(stored.equals(bytes)).toBe(true);
        expect(await leftovers()).toEqual([]);
        const audit = await testDb.db
            .selectFrom("audit_event")
            .select("action")
            .where("target_id", "=", result.id)
            .execute();
        expect(audit.map((a) => a.action)).toEqual(["artifact.created"]);
    });

    it("reuses an identical archive within the organization, without a second copy", async () => {
        const bytes = site([{ name: "unique-2.txt", content: "two" }]);
        const first = await upload("dee", bytes);
        const again = await upload("ann", bytes);
        expect(again).toMatchObject({ id: first.id, reused: true });
        const rows = await testDb.db
            .selectFrom("artifact")
            .select("id")
            .where("digest", "=", first.digest)
            .where("organization_id", "=", org)
            .execute();
        expect(rows).toHaveLength(1);
        expect(await leftovers()).toEqual([]);
    });

    it("keeps organizations apart: the same bytes are a separate artifact, never an oracle", async () => {
        const bytes = site([{ name: "unique-3.txt", content: "three" }]);
        const mine = await upload("dee", bytes);
        const theirs = await upload("zoe", bytes, { org: otherOrg });
        expect(theirs.reused).toBe(false);
        expect(theirs.id).not.toBe(mine.id);
        expect(artifactStorageKey(org, mine.digest)).not.toBe(
            artifactStorageKey(otherOrg, mine.digest),
        );
        const dirs = (await fs.readdir(path.join(dataDir, "artifacts"))).length;
        expect(dirs).toBeGreaterThanOrEqual(2);
    });

    it("creates exactly one artifact for concurrent identical uploads", async () => {
        const bytes = site([{ name: "unique-4.txt", content: "four" }]);
        const results = await Promise.all(Array.from({ length: 6 }, () => upload("dee", bytes)));
        expect(new Set(results.map((r) => r.id)).size).toBe(1);
        expect(results.filter((r) => !r.reused)).toHaveLength(1);
        expect(await leftovers()).toEqual([]);
    });
});

describe("who may upload", () => {
    it("authorizes before reading a single byte", async () => {
        const bytes = site([{ name: "unique-5.txt", content: "five" }]);
        for (const who of ["vic", "root"]) {
            const { body, state } = spy(bytes);
            const result = await code(
                uploadArtifact(
                    testDb.db,
                    people[who]!,
                    org,
                    body,
                    { contentLength: bytes.length, projectId },
                    deps(),
                ),
            );
            expect(result).toBe(who === "vic" ? "forbidden" : "not-found");
            expect(state.pulled).toBe(0);
        }
        const { body, state } = spy(bytes);
        expect(
            await code(
                uploadArtifact(
                    testDb.db,
                    people.zoe!,
                    org,
                    body,
                    { contentLength: bytes.length, projectId },
                    deps(),
                ),
            ),
        ).toBe("not-found");
        expect(state.pulled).toBe(0);
    });

    it("refuses a caller removed during a long upload", async () => {
        await newUser("gone");
        await addMember(testDb.db, people.ann!, org, {
            email: "gone@example.com",
            role: "deployer",
        });
        const bytes = site([{ name: "unique-6.txt", content: "six" }]);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let sent = false;
        const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
                if (sent) return controller.close();
                await gate;
                sent = true;
                controller.enqueue(bytes);
            },
        });
        const pending = code(
            uploadArtifact(
                testDb.db,
                people.gone!,
                org,
                body,
                { contentLength: bytes.length, projectId },
                deps(),
            ),
        );
        await removeMember(testDb.db, people.ann!, org, people.gone!.userId);
        release();
        expect(await pending).toBe("not-found");
        expect(await leftovers()).toEqual([]);
        const rows = await testDb.db
            .selectFrom("artifact")
            .select("id")
            .where("created_by", "=", people.gone!.userId)
            .execute();
        expect(rows).toHaveLength(0);
    });
});

describe("upload storage", () => {
    it.each(["tmp", "artifacts"])(
        "does not recreate a mount lost before creating %s",
        async (child) => {
            const root = await fs.mkdtemp(path.join(dataDir, "upload-mount-"));
            const saved = `${root}-saved`;
            const bytes = site([{ name: `lost-${child}.txt`, content: "mount lost" }]);
            const mkdir = fs.mkdir.bind(fs);
            const mock = vi.spyOn(fs, "mkdir").mockImplementation(async (directory, options) => {
                const target = path.join(root, child);
                if (directory === target || String(directory).startsWith(`${target}${path.sep}`)) {
                    await fs.rename(root, saved);
                }
                return mkdir(directory, options);
            });
            try {
                expect(
                    await code(
                        uploadArtifact(
                            testDb.db,
                            people.dee!,
                            org,
                            stream(bytes),
                            { contentLength: bytes.length, projectId },
                            { dataDir: root, limits: {} },
                        ),
                    ),
                ).toBe("unavailable");
                await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
            } finally {
                mock.mockRestore();
                await fs.rm(root, { recursive: true, force: true });
                await fs.rm(saved, { recursive: true, force: true });
            }
        },
    );

    it("never creates a missing data directory", async () => {
        const missing = path.join(dataDir, "not-mounted");
        const bytes = site([{ name: "missing.txt", content: "m" }]);
        const outcome = await code(
            uploadArtifact(
                testDb.db,
                people.dee!,
                org,
                stream(bytes),
                { contentLength: bytes.length, projectId },
                { dataDir: missing, limits: {} },
            ),
        );
        expect(outcome).toBe("unavailable");
        await expect(fs.stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
    });
});

describe("artifact project provenance", () => {
    const rows = (artifactId: string) =>
        testDb.db
            .selectFrom("artifact_project")
            .select("project_id")
            .where("artifact_id", "=", artifactId)
            .orderBy("project_id")
            .execute();

    it("records every project an artifact came through, including reuse and re-storing", async () => {
        const second = (
            await createProject(testDb.db, people.ann!, org, { name: "Prov", slug: "prov" })
        ).id;
        const bytes = site([{ name: "prov.txt", content: "prov" }]);
        const through = (project: string) =>
            uploadArtifact(
                testDb.db,
                people.dee!,
                org,
                stream(bytes),
                { contentLength: bytes.length, projectId: project },
                deps(),
            );
        const first = await through(projectId);
        expect(await rows(first.id)).toEqual([{ project_id: projectId }]);
        // The same bytes through another project: reused, and the new project is recorded.
        const reused = await through(second);
        expect(reused).toMatchObject({ id: first.id, reused: true });
        expect((await rows(first.id)).map((r) => r.project_id).sort()).toEqual(
            [projectId, second].sort(),
        );
        // Collected and stored again: still the same artifact, the history is kept.
        await testDb.db
            .updateTable("artifact")
            .set({ collected_at: new Date() })
            .where("id", "=", first.id)
            .execute();
        await fs.rm(resolveArtifactPath(dataDir, artifactStorageKey(org, first.digest)), {
            force: true,
        });
        const again = await through(projectId);
        expect(again.id).toBe(first.id);
        expect(await rows(first.id)).toHaveLength(2);
    });

    it("refuses a project outside a key's restriction and an unknown project", async () => {
        const bytes = site([{ name: "restricted.txt", content: "r" }]);
        const attempt = (project: string, restrictTo?: string[] | null) =>
            code(
                uploadArtifact(
                    testDb.db,
                    people.dee!,
                    org,
                    stream(bytes),
                    { contentLength: bytes.length, projectId: project, restrictTo },
                    deps(),
                ),
            );
        expect(await attempt(projectId, [randomUUID()])).toBe("not-found");
        expect(await attempt(randomUUID())).toBe("not-found");
        expect(await attempt(projects[otherOrg]!)).toBe("not-found");
        expect(await attempt(projectId, [projectId])).toBe("ok");
        expect(await attempt(projectId, null)).toBe("ok");
    });
});

describe("limits and failures leave nothing behind", () => {
    it("rejects a declared size over the limit without reading the body", async () => {
        const { body, state } = spy(Buffer.alloc(100));
        const result = await code(
            uploadArtifact(
                testDb.db,
                people.dee!,
                org,
                body,
                { contentLength: 2000, projectId },
                deps({ maxUploadBytes: 1000 }),
            ),
        );
        expect(result).toBe("too-large");
        expect(state.pulled).toBe(0);
        expect(state.cancelled).toBe(true);
    });

    it("stops an upload that exceeds the limit although its length was understated", async () => {
        const bytes = site([{ name: "big.bin", content: randomBytes(40 * 1024) }]);
        const { body, state } = spy(bytes);
        const result = await code(
            uploadArtifact(
                testDb.db,
                people.dee!,
                org,
                body,
                { contentLength: 10, projectId },
                deps({ maxUploadBytes: 64 }),
            ),
        );
        expect(result).toBe("too-large");
        expect(state.cancelled).toBe(true);
        expect(await leftovers()).toEqual([]);
    });

    it("rejects a missing body, an empty body and a truncated one", async () => {
        expect(
            await code(
                uploadArtifact(
                    testDb.db,
                    people.dee!,
                    org,
                    null,
                    { contentLength: 0, projectId },
                    deps(),
                ),
            ),
        ).toBe("invalid");
        expect(await code(upload("dee", Buffer.alloc(0)))).toBe("invalid");
        const bytes = site([{ name: "unique-7.txt", content: "seven" }]);
        expect(await code(upload("dee", bytes, { length: bytes.length + 100 }))).toBe("invalid");
        expect(await leftovers()).toEqual([]);
    });

    it("cleans up an upload whose connection breaks halfway", async () => {
        const bytes = site([{ name: "unique-8.txt", content: "eight" }]);
        let sent = false;
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                if (!sent) {
                    sent = true;
                    controller.enqueue(bytes.subarray(0, 40));
                } else {
                    controller.error(new Error("socket hang up"));
                }
            },
        });
        const result = await code(
            uploadArtifact(
                testDb.db,
                people.dee!,
                org,
                body,
                { contentLength: bytes.length, projectId },
                deps(),
            ),
        );
        expect(result).toBe("invalid");
        expect(await leftovers()).toEqual([]);
    });

    it("times out a stalled upload and cleans up", async () => {
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(Buffer.from("partial"));
            },
            pull: () => new Promise(() => {}),
        });
        const started = Date.now();
        const result = await code(
            uploadArtifact(
                testDb.db,
                people.dee!,
                org,
                body,
                { contentLength: 100, projectId },
                deps({ uploadTimeoutMs: 300 }),
            ),
        );
        expect(result).toBe("timeout");
        expect(Date.now() - started).toBeLessThan(3000);
        expect(await leftovers()).toEqual([]);
    });

    it("holds an organization to two uploads at once, and frees the slots afterwards", async () => {
        // `pull` runs only once an upload has its slot and starts reading, so each signal
        // says that slot is held; no timing guess.
        const stalled = () => {
            let reading!: () => void;
            const started = new Promise<void>((resolve) => (reading = resolve));
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(Buffer.from("partial"));
                },
                pull: () => {
                    reading();
                    return new Promise(() => {});
                },
            });
            return { body, started };
        };
        const run = (body: ReadableStream<Uint8Array>) =>
            code(
                uploadArtifact(
                    testDb.db,
                    people.dee!,
                    org,
                    body,
                    { contentLength: null, projectId },
                    deps({ uploadTimeoutMs: 800, maxConcurrentUploads: 2 }),
                ),
            );
        const first = stalled();
        const second = stalled();
        const held = [run(first.body), run(second.body)];
        await Promise.all([first.started, second.started]);
        const refused = spy(site());
        expect(await run(refused.body)).toBe("conflict");
        expect(refused.state.pulled).toBe(0);
        // Another organization is not held back by this one.
        expect(
            await code(
                uploadArtifact(
                    testDb.db,
                    people.zoe!,
                    otherOrg,
                    stream(site()),
                    { contentLength: null, projectId: projects[otherOrg]! },
                    deps(),
                ),
            ),
        ).toBe("ok");
        expect(await Promise.all(held)).toEqual(["timeout", "timeout"]);
        expect(await run(stream(site([{ name: "again.txt", content: "x" }])))).toBe("ok");
        expect(await leftovers()).toEqual([]);
    });

    it("stops at once when the caller was already gone before the upload began", async () => {
        const controller = new AbortController();
        controller.abort();
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            pull: () => new Promise(() => {}),
            cancel() {
                cancelled = true;
            },
        });
        const started = Date.now();
        const result = await code(
            uploadArtifact(
                testDb.db,
                people.dee!,
                org,
                body,
                { contentLength: 100, projectId },
                deps(),
                controller.signal,
            ),
        );
        expect(result).toBe("timeout");
        expect(Date.now() - started).toBeLessThan(2000);
        expect(cancelled).toBe(true);
        expect(await leftovers()).toEqual([]);
    });

    it("stops when the caller goes away", async () => {
        const controller = new AbortController();
        const body = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) });
        const pending = code(
            uploadArtifact(
                testDb.db,
                people.dee!,
                org,
                body,
                { contentLength: 100, projectId },
                deps(),
                controller.signal,
            ),
        );
        setTimeout(() => controller.abort(), 100);
        expect(await pending).toBe("timeout");
        expect(await leftovers()).toEqual([]);
    });

    it("stores nothing for an invalid archive", async () => {
        const before = await testDb.db.selectFrom("artifact").select("id").execute();
        for (const bad of [
            Buffer.from("not an archive"),
            tarGz([{ name: "other.html", content: "x" }]),
            tarGz([...SITE, { name: "../escape", content: "x" }]),
            tarGz([...SITE, { name: "link", type: "symlink", link: "/etc/passwd" }]),
            tarGz([...SITE, { name: ".env", content: "SECRET=1" }]),
        ]) {
            expect(await code(upload("dee", bad))).toBe("invalid");
        }
        expect(await testDb.db.selectFrom("artifact").select("id").execute()).toHaveLength(
            before.length,
        );
        expect(await leftovers()).toEqual([]);
    });
});

describe("the artifact quota", () => {
    it("is checked before reading and holds under concurrent uploads", async () => {
        const quotaOrg = (
            await createOrganization(testDb.db, people.root!, {
                name: "Quota",
                slug: "quota-org",
                ownerEmail: "ann@example.com",
            })
        ).id;
        projects[quotaOrg] = (
            await createProject(testDb.db, people.ann!, quotaOrg, { name: "Q", slug: "q" })
        ).id;
        const limits = { maxArtifacts: 3 };
        const results = await Promise.all(
            Array.from({ length: 7 }, (_, i) =>
                code(
                    upload("ann", site([{ name: `q${i}.txt`, content: String(i) }]), {
                        org: quotaOrg,
                        limits,
                    }),
                ),
            ),
        );
        expect(results.filter((r) => r === "ok")).toHaveLength(3);
        expect(results.filter((r) => r === "conflict")).toHaveLength(4);
        // A full organization refuses before it reads the body.
        const { body, state } = spy(site([{ name: "late.txt", content: "x" }]));
        expect(
            await code(
                uploadArtifact(
                    testDb.db,
                    people.ann!,
                    quotaOrg,
                    body,
                    { contentLength: 100, projectId: projects[quotaOrg]! },
                    deps(limits),
                ),
            ),
        ).toBe("conflict");
        expect(state.pulled).toBe(0);
        // The ceiling is hard until cleanup exists: even an identical archive is
        // refused before it is read. Existing artifacts are reused by id instead.
        expect(
            await code(
                upload("ann", site([{ name: "q0.txt", content: "0" }]), { org: quotaOrg, limits }),
            ),
        ).toBe("conflict");
    });
});

describe("writing the staging file", () => {
    it("writes a whole chunk even when the file system accepts it in parts", async () => {
        const written: number[] = [];
        const handle = {
            write: async (buffer: Uint8Array, offset: number, length: number) => {
                const take = Math.min(3, length);
                written.push(...buffer.subarray(offset, offset + take));
                return { bytesWritten: take };
            },
        };
        await writeFully(handle, Buffer.from("0123456789"));
        expect(Buffer.from(written).toString()).toBe("0123456789");
    });

    it("fails instead of dropping data when no progress is made", async () => {
        const stuck = { write: async () => ({ bytesWritten: 0 }) };
        await expect(writeFully(stuck, Buffer.from("abc"))).rejects.toThrow(/stopped accepting/);
        await expect(writeFully(stuck, Buffer.alloc(0))).resolves.toBeUndefined();
    });
});

describe("storage helpers", () => {
    it("only resolves keys of the exact shape it writes", () => {
        const good = artifactStorageKey("org", "a".repeat(64));
        expect(resolveArtifactPath("/data", good)).toBe(path.join("/data", good));
        for (const bad of [
            "../etc/passwd",
            "artifacts/../x",
            `artifacts/${"a".repeat(32)}/${"b".repeat(64)}.tar.gz/../x`,
            `/artifacts/${"a".repeat(32)}/${"b".repeat(64)}.tar.gz`,
            `artifacts/${"A".repeat(32)}/${"b".repeat(64)}.tar.gz`,
            "",
        ]) {
            expect(() => resolveArtifactPath("/data", bad), bad).toThrow();
        }
    });

    it("validates limits", () => {
        for (const value of [0, -1, 1.5, Number.NaN, Infinity]) {
            expect(() => resolveLimits({ maxEntries: value })).toThrow(/maxEntries/);
        }
        expect(resolveLimits({ maxArtifacts: 2 }).maxArtifacts).toBe(2);
    });

    it("sweeps only old upload leftovers", async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "launchpad-sweep-"));
        try {
            await fs.mkdir(path.join(dir, "tmp"));
            const old = `upload-${"a".repeat(24)}.part`;
            const fresh = `upload-${"b".repeat(24)}.part`;
            for (const name of [old, fresh, "keep.txt", "upload-short.part"]) {
                await fs.writeFile(path.join(dir, "tmp", name), "x");
            }
            const aged = new Date(Date.now() - 2 * 60 * 60 * 1000);
            for (const name of [old, "keep.txt", "upload-short.part"]) {
                await fs.utimes(path.join(dir, "tmp", name), aged, aged);
            }
            expect(await sweepStaleUploads(dir)).toBe(1);
            expect((await fs.readdir(path.join(dir, "tmp"))).toSorted()).toEqual(
                [fresh, "keep.txt", "upload-short.part"].toSorted(),
            );
            expect(await sweepStaleUploads(path.join(dir, "missing"))).toBe(0);
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    });
});
