import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    checkLocation,
    ClientCoreError,
    createContext,
    deploy,
    listPreviews,
    type Progress,
    packDirectory,
} from "./index";

const KEY = "lp_" + "a".repeat(43);
const ORG = "org-one";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const PREVIEW = "22222222-2222-4222-8222-222222222222";
const ARTIFACT = "33333333-3333-4333-8333-333333333333";
const DEPLOYMENT = "44444444-4444-4444-8444-444444444444";
const NOW = "2026-11-15T00:00:00.000Z";
const HOST = "review-a1b2c3.previews.example.com";

let dir = "";
beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "launchpad-deploy-"));
});
afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
});

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const previewBody = (slug = "review") => ({
    id: PREVIEW,
    projectId: PROJECT,
    slug,
    hostname: HOST,
    state: "active",
    activeDeploymentId: null,
    expiresAt: null,
    createdAt: NOW,
});
const deploymentBody = (status: string, failure: unknown = null) => ({
    id: DEPLOYMENT,
    previewId: PREVIEW,
    artifactId: ARTIFACT,
    spa: false,
    status,
    failure,
    createdAt: NOW,
    updatedAt: NOW,
    finishedAt: null,
});

interface Script {
    previews: ReturnType<typeof previewBody>[];
    statuses: string[]; // returned by successive GET deployment, the last repeating
    failure?: unknown;
    createDeployment?: () => Response;
    uploadReused?: boolean;
    createPreview?: () => Response;
    hangEvents?: boolean;
    pagedEvents?: boolean;
}

function controller(script: Script) {
    const calls: {
        method: string;
        path: string;
        headers: Record<string, string>;
        body?: unknown;
    }[] = [];
    let polled = 0;
    const fetchImpl = (async (url: string, init: RequestInit) => {
        const u = new URL(url);
        const method = init.method ?? "GET";
        const headers = init.headers as Record<string, string>;
        calls.push({ method, path: u.pathname + u.search, headers, body: init.body });
        const p = u.pathname.replace("/api/v1", "");
        if (p === "/key") {
            return json({
                id: PROJECT,
                name: "ci",
                organizationId: ORG,
                scopes: ["preview:deploy"],
                projectIds: null,
                expiresAt: NOW,
            });
        }
        if (p === `/organizations/${ORG}/projects`) {
            return json([{ id: PROJECT, slug: "site", name: "Site", createdAt: NOW }]);
        }
        if (p === `/organizations/${ORG}/artifacts`) {
            return json(
                {
                    id: ARTIFACT,
                    digest: "a".repeat(64),
                    sizeBytes: (init.body as Buffer).length,
                    expandedBytes: 1,
                    entryCount: 1,
                    createdAt: NOW,
                    reused: script.uploadReused ?? false,
                },
                201,
            );
        }
        if (p === `/organizations/${ORG}/previews` && method === "GET") {
            return json({ items: script.previews, nextCursor: null });
        }
        if (p === `/organizations/${ORG}/projects/${PROJECT}/previews`) {
            if (script.createPreview) return script.createPreview();
            script.previews.push(previewBody());
            return json(previewBody(), 201);
        }
        if (p === `/organizations/${ORG}/previews/${PREVIEW}/deployments`) {
            return script.createDeployment
                ? script.createDeployment()
                : json({ id: DEPLOYMENT, status: "queued", createdAt: NOW }, 202);
        }
        if (p === `/organizations/${ORG}/deployments/${DEPLOYMENT}/events`) {
            const after = Number(u.searchParams.get("after") ?? 0);
            if (script.hangEvents) {
                return new Promise<Response>((_resolve, reject) =>
                    init.signal?.addEventListener("abort", () =>
                        reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
                    ),
                );
            }
            if (script.pagedEvents) {
                const page = (seqs: number[], nextAfter: number | null) =>
                    json({
                        items: seqs.map((seq) => ({
                            seq,
                            phase: "build",
                            level: "info",
                            message: `step ${seq}`,
                            createdAt: NOW,
                        })),
                        nextAfter,
                    });
                if (after === 0) return page([1, 2], 2);
                if (after === 2) return page([3], null);
                return page([], null);
            }
            const all = [1, 2, 3].map((seq) => ({
                seq,
                phase: "build",
                level: "info",
                message: `step ${seq}`,
                createdAt: NOW,
            }));
            return json({
                items: all.filter((e) => e.seq > after && e.seq <= polled + 1),
                nextAfter: null,
            });
        }
        if (p === `/organizations/${ORG}/deployments/${DEPLOYMENT}`) {
            const status = script.statuses[Math.min(polled, script.statuses.length - 1)]!;
            polled++;
            return json(
                deploymentBody(status, status === "failed" ? (script.failure ?? null) : null),
            );
        }
        return json({ code: "not-found", status: 404, title: "Not Found" }, 404);
    }) as unknown as typeof fetch;
    const ctx = createContext(
        {
            LAUNCHPAD_CONFIG_DIR: dir,
            LAUNCHPAD_CONTROLLER: "https://control.example.com",
            LAUNCHPAD_API_KEY: KEY,
        },
        { fetch: fetchImpl },
    );
    return { ctx, calls };
}

async function site(extra: Record<string, string> = {}) {
    const root = path.join(dir, "dist");
    await fs.mkdir(path.join(root, "assets"), { recursive: true });
    await fs.writeFile(path.join(root, "index.html"), "<p>hi</p>");
    await fs.writeFile(path.join(root, "assets", "app.js"), "1");
    for (const [name, content] of Object.entries(extra)) {
        await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
        await fs.writeFile(path.join(root, name), content);
    }
    return root;
}

const noSleep = async () => {};
const args = (source: string, over: Record<string, unknown> = {}) => ({
    source,
    project: "site",
    name: "review",
    sleep: noSleep,
    pollMs: 1,
    ...over,
});

describe("deploying a directory", () => {
    it("packs, uploads, creates the preview, queues, and follows it to success", async () => {
        const { ctx, calls } = controller({
            previews: [],
            statuses: ["queued", "building", "succeeded"],
        });
        const progress: Progress[] = [];
        const result = await deploy(
            ctx,
            args(await site(), { spa: true, onProgress: (p: Progress) => progress.push(p) }),
        );
        expect(result.outcome).toBe("succeeded");
        expect(result.preview.hostname).toBe(HOST);
        expect(result.artifact).toMatchObject({ id: ARTIFACT, reused: false });
        const upload = calls.find((c) => c.path.endsWith("/artifacts"))!;
        expect(upload.headers["content-type"]).toBe("application/gzip");
        expect((upload.body as Buffer).subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
        const queued = calls.find((c) => c.path.endsWith("/deployments") && c.method === "POST")!;
        expect(JSON.parse(queued.body as string)).toEqual({ artifactId: ARTIFACT, spa: true });
        expect(queued.headers["idempotency-key"]).toMatch(/^deploy-/);
        // Events arrive in order, once each.
        const seqs = progress
            .filter((p) => p.kind === "event")
            .map((p) => (p as { seq: number }).seq);
        expect(seqs).toEqual([...new Set(seqs)].toSorted());
        expect(progress.some((p) => p.kind === "status" && p.status === "succeeded")).toBe(true);
    });

    it("reuses an existing preview of that name and does not create another", async () => {
        const { ctx, calls } = controller({ previews: [previewBody()], statuses: ["succeeded"] });
        await deploy(ctx, args(await site()));
        expect(calls.some((c) => c.path.includes("/projects/") && c.method === "POST")).toBe(false);
    });

    it("gives a new preview the chosen lifetime, and leaves an existing one alone, saying so", async () => {
        const fresh = controller({ previews: [], statuses: ["succeeded"] });
        await deploy(fresh.ctx, args(await site(), { ttl: "24h" }));
        const create = fresh.calls.find(
            (c) => c.path.includes("/projects/") && c.method === "POST",
        )!;
        expect(JSON.parse(create.body as string)).toEqual({ slug: "review", ttl: "24h" });
        const noTtl = controller({ previews: [], statuses: ["succeeded"] });
        await deploy(noTtl.ctx, args(await site()));
        const plain = noTtl.calls.find(
            (c) => c.path.includes("/projects/") && c.method === "POST",
        )!;
        expect(JSON.parse(plain.body as string)).toEqual({ slug: "review" });
        const existing = controller({ previews: [previewBody()], statuses: ["succeeded"] });
        const steps: string[] = [];
        await deploy(
            existing.ctx,
            args(await site(), {
                ttl: "24h",
                onProgress: (p: Progress) => p.kind === "step" && steps.push(p.message),
            }),
        );
        expect(steps.some((m) => m.includes("--ttl was not applied"))).toBe(true);
        expect(
            existing.calls.some((c) => c.path.includes("/projects/") && c.method === "POST"),
        ).toBe(false);
    });

    it("stops before uploading when the preview of that name is being deleted", async () => {
        const { ctx, calls } = controller({
            previews: [{ ...previewBody(), state: "deleting" }],
            statuses: ["succeeded"],
        });
        await expect(deploy(ctx, args(await site()))).rejects.toThrow(/being deleted/);
        expect(calls.some((c) => c.path.endsWith("/artifacts"))).toBe(false);
    });

    it("returns at once with --no-wait", async () => {
        const { ctx, calls } = controller({ previews: [], statuses: ["queued"] });
        const result = await deploy(ctx, args(await site(), { wait: false }));
        expect(result).toMatchObject({ outcome: "queued", deployment: { id: DEPLOYMENT } });
        expect(calls.some((c) => c.path.includes("/events"))).toBe(false);
    });

    it("reports a failed deployment with its safe failure, and one that needs an administrator", async () => {
        const failure = {
            code: "verify-failed-rolled-back",
            message: "The new release did not become ready.",
        };
        const failed = controller({
            previews: [previewBody()],
            statuses: ["building", "failed"],
            failure,
        });
        const result = await deploy(failed.ctx, args(await site()));
        expect(result.outcome).toBe("failed");
        expect((result.deployment as { failure: unknown }).failure).toEqual(failure);
        const held = controller({ previews: [previewBody()], statuses: ["reconciliation-needed"] });
        expect((await deploy(held.ctx, args(await site()))).outcome).toBe("reconciliation-needed");
    });

    it("stops waiting at the deadline and says the deployment is still going", async () => {
        const { ctx } = controller({ previews: [previewBody()], statuses: ["building"] });
        const result = await deploy(ctx, args(await site(), { waitTimeoutMs: 5, pollMs: 50 }));
        expect(result).toMatchObject({ outcome: "timeout", deployment: { status: "building" } });
    });

    it("repeats a deploy that got no answer with the same idempotency key, and no more than a few times", async () => {
        let attempts = 0;
        const { ctx, calls } = controller({
            previews: [previewBody()],
            statuses: ["succeeded"],
            createDeployment: () => {
                attempts++;
                if (attempts < 3) throw new TypeError("fetch failed");
                return json({ id: DEPLOYMENT, status: "queued", createdAt: NOW }, 202);
            },
        });
        expect((await deploy(ctx, args(await site()))).outcome).toBe("succeeded");
        const keys = calls
            .filter((c) => c.path.endsWith("/deployments") && c.method === "POST")
            .map((c) => c.headers["idempotency-key"]);
        expect(keys).toHaveLength(3);
        expect(new Set(keys).size).toBe(1);

        const dead = controller({
            previews: [previewBody()],
            statuses: ["succeeded"],
            createDeployment: () => {
                throw new TypeError("fetch failed");
            },
        });
        await expect(deploy(dead.ctx, args(await site()))).rejects.toMatchObject({
            reason: "unreachable",
        });
        expect(dead.calls.filter((c) => c.path.endsWith("/deployments"))).toHaveLength(3);
    });

    it("does not repeat a request the controller answered", async () => {
        const { ctx, calls } = controller({
            previews: [previewBody()],
            statuses: ["succeeded"],
            createDeployment: () =>
                json(
                    {
                        code: "conflict",
                        status: 409,
                        title: "That preview already has an unfinished deployment.",
                    },
                    409,
                ),
        });
        await expect(deploy(ctx, args(await site()))).rejects.toMatchObject({ status: 409 });
        expect(
            calls.filter((c) => c.path.endsWith("/deployments") && c.method === "POST"),
        ).toHaveLength(1);
    });
});

describe("cancellation, the deadline and the last events", () => {
    it("does no further work once cancelled, and never queues the deployment", async () => {
        const { ctx, calls } = controller({ previews: [], statuses: ["succeeded"] });
        const abort = new AbortController();
        await expect(
            deploy(
                ctx,
                args(await site(), {
                    signal: abort.signal,
                    onProgress: (p: Progress) => {
                        if (p.kind === "step" && p.message.startsWith("Deploying to"))
                            abort.abort();
                    },
                }),
            ),
        ).rejects.toBeDefined();
        expect(calls.some((c) => c.path.endsWith("/deployments") && c.method === "POST")).toBe(
            false,
        );
        // Cancelled before the preview is created, too, so nothing is uploaded either.
        const early = controller({ previews: [], statuses: ["succeeded"] });
        const first = new AbortController();
        await expect(
            deploy(
                early.ctx,
                args(await site(), {
                    signal: first.signal,
                    onProgress: (p: Progress) => {
                        if (p.kind === "step" && p.message === "Packing the site") first.abort();
                    },
                }),
            ),
        ).rejects.toBeDefined();
        expect(early.calls.some((c) => c.path.includes("/projects/") && c.method === "POST")).toBe(
            false,
        );
    });

    it("rejects when cancelled while the final events are delivered, instead of reporting success", async () => {
        const { ctx } = controller({
            previews: [previewBody()],
            statuses: ["succeeded"],
            pagedEvents: true,
        });
        const abort = new AbortController();
        await expect(
            deploy(
                ctx,
                args(await site(), {
                    signal: abort.signal,
                    onProgress: (p: Progress) => {
                        if (p.kind === "status" && p.status === "succeeded") abort.abort();
                    },
                }),
            ),
        ).rejects.toBeDefined();
    });

    it("holds every poll to the wait deadline, however long the controller takes", async () => {
        const { ctx } = controller({
            previews: [previewBody()],
            statuses: ["building"],
            hangEvents: true,
        });
        const started = Date.now();
        const result = await deploy(ctx, args(await site(), { waitTimeoutMs: 300 }));
        expect(result.outcome).toBe("timeout");
        expect(Date.now() - started).toBeLessThan(5000);
        // A caller's cancellation is still theirs, not a timeout.
        const cancelled = controller({
            previews: [previewBody()],
            statuses: ["building"],
            hangEvents: true,
        });
        const abort = new AbortController();
        setTimeout(() => abort.abort(), 100);
        await expect(
            deploy(
                cancelled.ctx,
                args(await site(), { signal: abort.signal, waitTimeoutMs: 10_000 }),
            ),
        ).rejects.toBeDefined();
    });

    it("delivers every event, across pages, before it reports the end", async () => {
        const { ctx } = controller({
            previews: [previewBody()],
            statuses: ["succeeded"],
            pagedEvents: true,
        });
        const seen: number[] = [];
        const result = await deploy(
            ctx,
            args(await site(), {
                onProgress: (p: Progress) => {
                    if (p.kind === "event") seen.push(p.seq);
                },
            }),
        );
        expect(result.outcome).toBe("succeeded");
        expect(seen).toEqual([1, 2, 3]);
    });

    it("repeats a lost preview creation with the one key", async () => {
        let attempts = 0;
        const { ctx, calls } = controller({
            previews: [],
            statuses: ["succeeded"],
            createPreview: () => {
                attempts++;
                if (attempts < 3) throw new TypeError("fetch failed");
                return json(previewBody(), 201);
            },
        });
        await deploy(ctx, args(await site()));
        const keys = calls
            .filter((c) => c.path.includes("/projects/") && c.method === "POST")
            .map((c) => c.headers["idempotency-key"]);
        expect(keys).toHaveLength(3);
        expect(new Set(keys).size).toBe(1);
        expect(keys[0]).toMatch(/^preview-/);
    });
});

describe("naming the project", () => {
    it("uses an id as it is, so a key without project:read can deploy and list by id", async () => {
        const byId = controller({ previews: [previewBody()], statuses: ["succeeded"] });
        await deploy(byId.ctx, args(await site(), { project: PROJECT }));
        expect(byId.calls.some((c) => c.path.endsWith("/projects"))).toBe(false);
        await listPreviews(byId.ctx, { project: PROJECT });
        expect(byId.calls.some((c) => c.path.endsWith("/projects"))).toBe(false);
        expect(byId.calls.some((c) => c.path.includes(`projectId=${PROJECT}`))).toBe(true);

        const bySlug = controller({ previews: [previewBody()], statuses: ["succeeded"] });
        await deploy(bySlug.ctx, args(await site(), { project: "site" }));
        expect(bySlug.calls.some((c) => c.path.endsWith("/projects"))).toBe(true);
        await expect(listPreviews(bySlug.ctx, { project: "nope" })).rejects.toThrow(
            /cannot see a project/,
        );
    });
});

describe("what is refused before anything is sent", () => {
    it("a bad name, an unknown project, a missing source", async () => {
        const { ctx, calls } = controller({ previews: [], statuses: ["succeeded"] });
        const root = await site();
        await expect(deploy(ctx, args(root, { name: "Bad Name" }))).rejects.toBeInstanceOf(
            ClientCoreError,
        );
        await expect(deploy(ctx, args(root, { project: "nope" }))).rejects.toThrow(
            /cannot see a project/,
        );
        await expect(deploy(ctx, args(path.join(dir, "missing")))).rejects.toThrow(
            /does not exist/,
        );
        expect(calls.some((c) => c.path.endsWith("/artifacts"))).toBe(false);
    });

    it("secrets, links, special files, deep trees, a missing index and too many files", async () => {
        const root = await site({ ".env": "SECRET=1" });
        await expect(packDirectory(root)).rejects.toThrow(/secret/);
        await fs.rm(path.join(root, ".env"));
        for (const bad of [".git/config", "keys/id_ed25519", "cert.pem", ".npmrc"]) {
            const r = await site({ [bad]: "x" });
            await expect(packDirectory(r), bad).rejects.toThrow(/secret|version-control/);
            await fs.rm(path.join(r, bad.split("/")[0]!), { recursive: true, force: true });
        }
        await fs.symlink("/etc/passwd", path.join(root, "link"));
        await expect(packDirectory(root)).rejects.toThrow(/not a regular file/);
        await fs.rm(path.join(root, "link"));

        const empty = path.join(dir, "empty");
        await fs.mkdir(empty);
        await fs.writeFile(path.join(empty, "page.html"), "x");
        await expect(packDirectory(empty)).rejects.toThrow(/index\.html/);

        const deep = path.join(dir, "deep");
        await fs.mkdir(path.join(deep, "a", "b", "c"), { recursive: true });
        await fs.writeFile(path.join(deep, "index.html"), "x");
        await fs.writeFile(path.join(deep, "a", "b", "c", "f.txt"), "x");
        await expect(
            packDirectory(deep, { maxArchiveBytes: 1e6, maxEntries: 100, maxDepth: 3 }),
        ).rejects.toThrow(/deeper/);
        await expect(
            packDirectory(root, { maxArchiveBytes: 1e6, maxEntries: 1, maxDepth: 16 }),
        ).rejects.toThrow(/more than 1 files/);
        await expect(
            packDirectory(root, { maxArchiveBytes: 10, maxEntries: 100, maxDepth: 16 }),
        ).rejects.toThrow(/larger than/);
        await expect(packDirectory(path.join(root, "index.html"))).rejects.toThrow(
            /not a directory/,
        );
    });

    it("reads an archive within the limit it was given, and reports the bytes actually read", async () => {
        const file = path.join(dir, "grow.tar.gz");
        await fs.writeFile(file, Buffer.alloc(1000, 1));
        const { readArchive } = await import("./index");
        expect(
            (await readArchive(file, { maxArchiveBytes: 5000, maxEntries: 1, maxDepth: 1 })).bytes,
        ).toBe(1000);
        await expect(
            readArchive(file, { maxArchiveBytes: 999, maxEntries: 1, maxDepth: 1 }),
        ).rejects.toThrow(/larger than/);
        await expect(readArchive(dir)).rejects.toThrow(/not a file/);
    });

    it("sends an existing archive as it is, after a size check", async () => {
        const { ctx, calls } = controller({ previews: [previewBody()], statuses: ["succeeded"] });
        const file = path.join(dir, "site.tar.gz");
        const packed = await packDirectory(await site());
        await fs.writeFile(file, packed.archive);
        await deploy(ctx, args(file));
        expect(
            (calls.find((c) => c.path.endsWith("/artifacts"))!.body as Buffer).equals(
                packed.archive,
            ),
        ).toBe(true);
    });
});

describe("choosing which files are published", () => {
    const names = async (archive: Buffer) => {
        const { list } = await import("tar");
        const out: string[] = [];
        const file = path.join(dir, "selected.tar.gz");
        await fs.writeFile(file, archive);
        await list({ file, onReadEntry: (e) => out.push(e.path) });
        return out.toSorted();
    };
    const pick = (include: string[], exclude: string[], prefix = "dist") => ({
        include,
        exclude,
        prefix,
    });

    it("packs only included files, patterns being relative to the directory above", async () => {
        const root = await site({ "notes/todo.txt": "x", "assets/map.js.map": "x" });
        const packed = await packDirectory(
            root,
            undefined,
            pick(["dist/**"], ["**/*.map", "dist/notes/**"]),
        );
        expect(await names(packed.archive)).toEqual(["assets/app.js", "index.html"]);
        // The same patterns, relative to the packed directory itself.
        const here = await packDirectory(
            root,
            undefined,
            pick(["**"], ["notes/**", "**/*.map"], ""),
        );
        expect(await names(here.archive)).toEqual(["assets/app.js", "index.html"]);
    });

    it("lets an exclusion win over an inclusion, however specific", async () => {
        const root = await site();
        await expect(
            packDirectory(
                root,
                undefined,
                pick(["dist/index.html", "dist/assets/**"], ["dist/index.html"]),
            ),
        ).rejects.toThrow(/no index\.html/);
        const packed = await packDirectory(
            root,
            undefined,
            pick(["dist/index.html", "dist/assets/app.js"], ["dist/assets/app.js"]),
        );
        expect(await names(packed.archive)).toEqual(["index.html"]);
    });

    it("does not judge what is not selected, but still refuses a secret that is", async () => {
        const root = await site({ ".env": "SECRET=1", "keys/server.pem": "x" });
        await fs.symlink("/etc/passwd", path.join(root, "link"));
        const safe = await packDirectory(
            root,
            undefined,
            pick(["dist/index.html", "dist/assets/**"], ["dist/.env"]),
        );
        expect(await names(safe.archive)).toEqual(["assets/app.js", "index.html"]);
        for (const include of ["dist/**", "dist/.env", "dist/keys/*", "dist/link"]) {
            await expect(
                packDirectory(root, undefined, pick([include], ["nothing-matches"])),
                include,
            ).rejects.toThrow(/secret|not a regular file/);
        }
    });

    it("refuses a secret-named directory above the packed one, and ignores deep unselected trees", async () => {
        const aws = path.join(dir, ".aws", "site");
        await fs.mkdir(aws, { recursive: true });
        await fs.writeFile(path.join(aws, "index.html"), "x");
        await expect(
            packDirectory(aws, undefined, pick([".aws/**"], ["nothing"], ".aws/site")),
        ).rejects.toThrow(/secret/);
        const root = await site();
        await fs.mkdir(path.join(root, "a", "b", "c", "d", "e"), { recursive: true });
        await fs.writeFile(path.join(root, "a", "b", "c", "d", "e", "deep.txt"), "x");
        const shallow = { maxArchiveBytes: 1e6, maxEntries: 100, maxDepth: 3 };
        const packed = await packDirectory(root, shallow, pick(["dist/index.html"], ["nothing"]));
        expect(await names(packed.archive)).toEqual(["index.html"]);
        await expect(packDirectory(root, shallow, pick(["dist/**"], ["nothing"]))).rejects.toThrow(
            /deeper/,
        );
    });

    it("does not send an archive in place of a directory when a selection was given", async () => {
        const root = await site();
        const file = path.join(dir, "x.tar.gz");
        await fs.writeFile(file, (await packDirectory(root)).archive);
        const { ctx, calls } = controller({ previews: [previewBody()], statuses: ["succeeded"] });
        await expect(
            deploy(ctx, args(file, { selection: pick(["dist/**"], ["x"]) })),
        ).rejects.toThrow(/needs a directory/);
        expect(calls.some((c) => c.path.endsWith("/artifacts"))).toBe(false);
    });

    it("never merges an archive named by a file starting with @, selected or not", async () => {
        const { create } = await import("tar");
        const outside = path.join(dir, "outside");
        await fs.mkdir(outside);
        await fs.writeFile(path.join(outside, "creds.txt"), "SECRET=1");
        const loot = path.join(dir, "loot.tar");
        await create({ file: loot, cwd: outside }, ["creds.txt"]);
        const bytes = await fs.readFile(loot);
        // Selected mode: an unselected symlink to the archive, and a plain file of that name.
        const root = await site();
        await fs.writeFile(path.join(root, "@loot.bin"), bytes);
        await fs.symlink(loot, path.join(root, "loot.bin"));
        const picked = await packDirectory(
            root,
            undefined,
            pick(["dist/@*", "dist/index.html"], ["nothing"]),
        );
        expect(await names(picked.archive)).toEqual(["@loot.bin", "index.html"]);
        // Plain mode (the CLI): the same file, no selection.
        await fs.rm(path.join(root, "loot.bin"));
        const plain = await packDirectory(root);
        expect(await names(plain.archive)).toEqual(["@loot.bin", "assets/app.js", "index.html"]);
    });

    it("excludes a directory named without a glob, ignores case, and honors [!x]", async () => {
        const root = await site({
            "private/key.txt": "x",
            "Admin/a.txt": "x",
            "b/ok.txt": "x",
            "c/ok.txt": "x",
        });
        const packed = await packDirectory(
            root,
            undefined,
            pick(["dist/**"], ["dist/private", "DIST/ADMIN/**", "dist/[!a]/ok.txt"]),
        );
        expect(await names(packed.archive)).toEqual(["assets/app.js", "index.html"]);
    });

    it("does not walk directories nothing can select, and stops when cancelled", async () => {
        const root = await site({ "other/x.txt": "x" });
        const walked: string[] = [];
        const readdir = fs.readdir.bind(fs);
        const spy = vi.spyOn(fs, "readdir").mockImplementation(((
            target: string,
            ...rest: unknown[]
        ) => {
            walked.push(String(target));
            return (readdir as (...a: unknown[]) => unknown)(target, ...rest);
        }) as typeof fs.readdir);
        try {
            const packed = await packDirectory(
                root,
                undefined,
                pick(["dist/index.html"], ["nothing"]),
            );
            expect(await names(packed.archive)).toEqual(["index.html"]);
            expect(walked.some((w) => w.endsWith("other"))).toBe(false);
            const cancelled = new AbortController();
            cancelled.abort();
            await expect(
                packDirectory(root, undefined, pick(["dist/**"], ["nothing"]), cancelled.signal),
            ).rejects.toMatchObject({ name: "AbortError" });
        } finally {
            spy.mockRestore();
        }
    });

    it("refuses a selected file inside a protected path that sits below the packed directory", async () => {
        const root = await site({ "cfg/credentials.json": "{}" });
        const store = path.join(root, "cfg");
        const selection = { ...pick(["dist/**"], ["nothing"]), protectedPaths: [store] };
        await expect(packDirectory(root, undefined, selection)).rejects.toThrow(/credential store/);
        // Not selected, it is simply not published.
        const narrow = { ...pick(["dist/index.html"], ["nothing"]), protectedPaths: [store] };
        expect(await names((await packDirectory(root, undefined, narrow)).archive)).toEqual([
            "index.html",
        ]);
    });

    it("refuses a location inside secret data or this client's own store", () => {
        expect(() => checkLocation("/home/u/.aws/site")).toThrow(/credential/);
        expect(() => checkLocation("/home/u/.kube")).toThrow(/credential/);
        expect(() => checkLocation("/home/u/site", ["/home/u/.config/launchpad"])).not.toThrow();
        expect(() =>
            checkLocation("/home/u/.config/launchpad/x", ["/home/u/.config/launchpad"]),
        ).toThrow(/holds this client's credentials/);
        expect(() =>
            checkLocation("/home/u/.config/launchpad", ["/home/u/.config/launchpad"]),
        ).toThrow();
    });

    it("refuses patterns that could reach outside the directory or mean something else", async () => {
        const root = await site();
        for (const bad of [
            "/etc/**",
            "../x/**",
            "dist/../../x",
            "!dist/**",
            "#x",
            "a\\b",
            "",
            "x".repeat(300),
            "a\u0001b",
        ]) {
            await expect(packDirectory(root, undefined, pick([bad], ["x"])), bad).rejects.toThrow(
                /pattern|1 to/,
            );
            await expect(
                packDirectory(root, undefined, pick(["dist/**"], [bad])),
                bad,
            ).rejects.toThrow(/pattern|1 to/);
        }
        await expect(packDirectory(root, undefined, pick([], ["x"]))).rejects.toThrow(/1 to 100/);
        await expect(packDirectory(root, undefined, pick(["dist/**"], []))).rejects.toThrow(
            /1 to 100/,
        );
        await expect(
            packDirectory(
                root,
                undefined,
                pick(
                    Array.from({ length: 101 }, (_, i) => `a${i}`),
                    ["x"],
                ),
            ),
        ).rejects.toThrow(/1 to 100/);
    });
});

describe("packing", () => {
    it("carries relative names and no local ownership", async () => {
        const root = await site();
        const a = await packDirectory(root);
        expect(a.files).toBe(2);
        // Entry names are relative; nothing names the local machine.
        const { list } = await import("tar");
        const names: string[] = [];
        const file = path.join(dir, "a.tar.gz");
        await fs.writeFile(file, a.archive);
        await list({
            file,
            onReadEntry: (e) => names.push(`${e.path}:${e.uid ?? 0}:${e.uname ?? ""}`),
        });
        expect(names.toSorted()).toEqual(["assets/app.js:0:", "index.html:0:"]);
    });
});
