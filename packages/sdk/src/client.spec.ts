import { describe, expect, it } from "vitest";
import {
    createClient,
    LaunchpadApiError,
    LaunchpadConfigError,
    LaunchpadTransportError,
    normalizeBaseUrl,
} from "./index";

const KEY = "lp_" + "a".repeat(43);
const ORG = "org_1";
const json = (body: unknown, init: ResponseInit = {}) =>
    new Response(JSON.stringify(body), {
        ...init,
        headers: { "content-type": "application/json", ...init.headers },
    });

function recording(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return respond(url, init);
    }) as unknown as typeof fetch;
    return {
        calls,
        client: createClient({
            baseUrl: "https://control.example.com",
            apiKey: KEY,
            fetch: fetchImpl,
        }),
    };
}

describe("configuration", () => {
    it("accepts https and loopback http only, without credentials, query or fragment", () => {
        expect(normalizeBaseUrl("https://control.example.com/")).toBe(
            "https://control.example.com",
        );
        expect(normalizeBaseUrl("https://example.com/launchpad/")).toBe(
            "https://example.com/launchpad",
        );
        expect(normalizeBaseUrl("http://localhost:3000")).toBe("http://localhost:3000");
        expect(normalizeBaseUrl("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
        for (const bad of [
            "http://control.example.com",
            "ftp://example.com",
            "https://user:pw@example.com",
            "https://example.com/?x=1",
            "https://example.com/#frag",
            "not a url",
            "http://localhost.example.com",
        ]) {
            expect(() => normalizeBaseUrl(bad), bad).toThrow(LaunchpadConfigError);
        }
    });

    it("rejects a malformed key without echoing it", () => {
        const secret = "hunter2-not-a-key";
        try {
            createClient({ baseUrl: "https://control.example.com", apiKey: secret });
            expect.unreachable();
        } catch (error) {
            expect(error).toBeInstanceOf(LaunchpadConfigError);
            expect((error as Error).message).not.toContain(secret);
        }
    });
});

describe("requests", () => {
    it("sends the key as a bearer token, never cookies, and refuses redirects", async () => {
        const { calls, client } = recording(() =>
            json({
                id: crypto.randomUUID(),
                name: "ci",
                organizationId: ORG,
                scopes: ["project:read"],
                projectIds: null,
                expiresAt: new Date().toISOString(),
            }),
        );
        await client.key.get();
        const { url, init } = calls[0]!;
        expect(url).toBe("https://control.example.com/api/v1/key");
        expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
        expect(init.credentials).toBe("omit");
        expect(init.redirect).toBe("error");
        expect(init.method).toBe("GET");
        expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it("encodes path segments and posts JSON", async () => {
        const { calls, client } = recording(() =>
            json({ id: crypto.randomUUID(), slug: "a", name: "A" }, { status: 201 }),
        );
        await client.projects.create("org/../x", { name: "A", slug: "a" });
        expect(calls[0]!.url).toBe(
            "https://control.example.com/api/v1/organizations/org%2F..%2Fx/projects",
        );
        expect(calls[0]!.init.method).toBe("POST");
        expect((calls[0]!.init.headers as Record<string, string>)["content-type"]).toBe(
            "application/json",
        );
        expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ name: "A", slug: "a" });
    });

    it("tolerates fields a newer controller adds, and rejects a wrong shape", async () => {
        const project = {
            id: crypto.randomUUID(),
            slug: "a",
            name: "A",
            createdAt: new Date().toISOString(),
        };
        const extra = recording(() => json([{ ...project, addedLater: true }]));
        expect(await extra.client.projects.list(ORG)).toHaveLength(1);
        const wrong = recording(() => json([{ id: 7 }]));
        await expect(wrong.client.projects.list(ORG)).rejects.toMatchObject({
            name: "LaunchpadTransportError",
            reason: "invalid-response",
        });
        const html = recording(() => new Response("<html>login</html>", { status: 200 }));
        await expect(html.client.organizations.list()).rejects.toBeInstanceOf(
            LaunchpadTransportError,
        );
    });
});

describe("errors", () => {
    it("maps the controller's error body, including unknown codes and retry-after", async () => {
        const known = recording(() =>
            json(
                { code: "not-found", status: 404, title: "Organization not found." },
                { status: 404 },
            ),
        );
        await expect(known.client.organizations.get(ORG)).rejects.toMatchObject({
            status: 404,
            code: "not-found",
            title: "Organization not found.",
        });
        const future = recording(() =>
            json({ code: "brand-new", status: 418, title: "Teapot" }, { status: 418 }),
        );
        await expect(future.client.organizations.list()).rejects.toMatchObject({
            code: "brand-new",
            status: 418,
        });
        const limited = recording(() =>
            json(
                { code: "too-many-requests", status: 429, title: "Slow down" },
                { status: 429, headers: { "retry-after": "60" } },
            ),
        );
        const error = await limited.client.organizations.list().catch((e) => e);
        expect(error).toBeInstanceOf(LaunchpadApiError);
        expect(error.retryAfterSeconds).toBe(60);
    });

    it("never repeats a non-JSON body, and never contains the key", async () => {
        const proxy = recording(() => new Response(`upstream said ${KEY}`, { status: 502 }));
        const error = await proxy.client.organizations.list().catch((e) => e);
        expect(error).toMatchObject({ status: 502, code: "unknown", title: "HTTP 502" });
        expect(JSON.stringify({ message: error.message, ...error })).not.toContain(KEY);
    });

    it("stops reading an oversized answer, with or without a declared length", async () => {
        let cancelled = false;
        const endless = new ReadableStream<Uint8Array>({
            pull(controller) {
                controller.enqueue(new Uint8Array(256 * 1024).fill(32));
            },
            cancel() {
                cancelled = true;
            },
        });
        const stream = recording(() => new Response(endless, { status: 200 }));
        await expect(stream.client.organizations.list()).rejects.toMatchObject({
            name: "LaunchpadTransportError",
            reason: "invalid-response",
        });
        expect(cancelled).toBe(true);
        const declared = recording(
            () =>
                new Response("[]", {
                    status: 200,
                    headers: { "content-length": String(50 * 1024 * 1024) },
                }),
        );
        await expect(declared.client.organizations.list()).rejects.toMatchObject({
            reason: "invalid-response",
        });
    });

    it("reports a stalled or broken body as a timeout or an unreachable controller, not a bad answer", async () => {
        const failing = (error: unknown) =>
            recording(
                () =>
                    new Response(
                        new ReadableStream({
                            start(controller) {
                                controller.error(error);
                            },
                        }),
                        { status: 200 },
                    ),
            );
        const timedOut = await failing(new DOMException("t", "TimeoutError"))
            .client.organizations.list()
            .catch((e) => e);
        expect(timedOut.reason).toBe("timeout");
        const broken = await failing(new TypeError("terminated"))
            .client.organizations.list()
            .catch((e) => e);
        expect(broken.reason).toBe("unreachable");
    });

    it("distinguishes unreachable, timeout and redirect failures", async () => {
        const failing = (error: unknown) =>
            createClient({
                baseUrl: "https://control.example.com",
                apiKey: KEY,
                fetch: (async () => {
                    throw error;
                }) as unknown as typeof fetch,
            });
        const reason = async (error: unknown) =>
            (
                await failing(error)
                    .organizations.list()
                    .catch((e) => e)
            ).reason;
        expect(await reason(new TypeError("fetch failed"))).toBe("unreachable");
        expect(await reason(new DOMException("t", "TimeoutError"))).toBe("timeout");
        expect(await reason(new TypeError("redirect mode is set to error"))).toBe("redirect");
    });
});

describe("packaging", () => {
    it("stays browser-safe: only zod, the contracts and its own files", async () => {
        const { promises: fs } = await import("node:fs");
        const dir = import.meta.dirname;
        for (const file of await fs.readdir(dir)) {
            if (!file.endsWith(".ts") || file.endsWith(".spec.ts")) continue;
            const source = await fs.readFile(`${dir}/${file}`, "utf8");
            const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
            expect(
                imports.filter(
                    (i) => i !== "zod" && i !== "@launchpad/contracts" && !i.startsWith("./"),
                ),
                file,
            ).toEqual([]);
        }
    });
});

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const PREVIEW = {
    id: ID,
    projectId: ID,
    slug: "review",
    hostname: "review-a1b2c3.previews.example.com",
    state: "active",
    activeDeploymentId: null,
    expiresAt: null,
    createdAt: "2026-11-15T00:00:00.000Z",
};
const DEPLOYMENT = {
    id: ID,
    previewId: ID,
    artifactId: ID,
    spa: false,
    status: "queued",
    failure: null,
    createdAt: "2026-11-15T00:00:00.000Z",
    updatedAt: "2026-11-15T00:00:00.000Z",
    finishedAt: null,
};

describe("previews and deployments", () => {
    it("extends with an idempotency key and forwards the resulting expiry", async () => {
        const expiresAt = "2026-11-20T00:00:00.000Z";
        const { calls, client } = recording(() => json({ ...PREVIEW, expiresAt }));
        expect(
            await client.previews.extend(ORG, ID, { ttl: "24h" }, { idempotencyKey: "extend-1" }),
        ).toMatchObject({ expiresAt });
        expect(calls[0]!.url).toBe(
            `https://control.example.com/api/v1/organizations/${ORG}/previews/${ID}/extend`,
        );
        expect(calls[0]!.init.method).toBe("POST");
        expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ ttl: "24h" });
        expect((calls[0]!.init.headers as Record<string, string>)["idempotency-key"]).toBe(
            "extend-1",
        );
    });

    it("requests deletion without a body and reads its operation", async () => {
        const { calls, client } = recording((_url, init) =>
            json(
                init.method === "DELETE"
                    ? { operationId: ID, state: "deleting" }
                    : {
                          id: ID,
                          previewId: ID,
                          status: "queued",
                          reason: "manual",
                          failure: null,
                          createdAt: PREVIEW.createdAt,
                          finishedAt: null,
                      },
            ),
        );
        expect(await client.previews.delete("org/1", ID)).toEqual({
            operationId: ID,
            state: "deleting",
        });
        expect(calls[0]!.url).toBe(
            `https://control.example.com/api/v1/organizations/org%2F1/previews/${ID}`,
        );
        expect(calls[0]!.init.method).toBe("DELETE");
        expect(calls[0]!.init.body).toBeUndefined();
        expect(await client.deletions.get("org/1", ID)).toMatchObject({ status: "queued" });
        expect(calls[1]!.url).toBe(
            `https://control.example.com/api/v1/organizations/org%2F1/deletions/${ID}`,
        );
    });
    it("rejects unknown deletion statuses and incomplete deletion acknowledgments", async () => {
        const malformed = recording(() => json({ operationId: ID, state: "active" }));
        await expect(malformed.client.previews.delete(ORG, ID)).rejects.toMatchObject({
            reason: "invalid-response",
        });
        const unknown = recording(() =>
            json({
                id: ID,
                previewId: ID,
                status: "mystery",
                reason: "manual",
                failure: null,
                createdAt: PREVIEW.createdAt,
                finishedAt: null,
            }),
        );
        await expect(unknown.client.deletions.get(ORG, ID)).rejects.toMatchObject({
            reason: "invalid-response",
        });
    });
    it("lists previews with a filter and cursor, tolerating fields a newer controller adds", async () => {
        const { client, calls } = recording(() =>
            json({ items: [{ ...PREVIEW, newField: 1 }], nextCursor: ID, extra: true }),
        );
        const page = await client.previews.list(ORG, { projectId: ID, cursor: ID });
        expect(page.nextCursor).toBe(ID);
        expect(page.items[0]!.hostname).toBe(PREVIEW.hostname);
        expect(calls[0]!.url).toBe(
            `https://control.example.com/api/v1/organizations/${ORG}/previews?projectId=${ID}&cursor=${ID}`,
        );
        expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(
            `Bearer ${KEY}`,
        );
    });

    it("sends the idempotency key on create and deploy, and refuses a malformed one before any request", async () => {
        const { client, calls } = recording((url) =>
            url.endsWith("/previews")
                ? json(PREVIEW, { status: 201 })
                : json({ id: ID, status: "queued", createdAt: PREVIEW.createdAt }, { status: 202 }),
        );
        await client.previews.create(ORG, ID, { slug: "review" }, { idempotencyKey: "create-1" });
        await client.deployments.create(
            ORG,
            ID,
            { artifactId: ID, spa: true },
            { idempotencyKey: "deploy-1" },
        );
        const header = (i: number) =>
            (calls[i]!.init.headers as Record<string, string>)["idempotency-key"];
        expect([header(0), header(1)]).toEqual(["create-1", "deploy-1"]);
        expect(JSON.parse(calls[1]!.init.body as string)).toEqual({ artifactId: ID, spa: true });
        for (const bad of ["", "has space", "x".repeat(129), "line\nbreak"]) {
            await expect(
                client.deployments.create(ORG, ID, { artifactId: ID }, { idempotencyKey: bad }),
            ).rejects.toBeInstanceOf(LaunchpadConfigError);
        }
        expect(calls).toHaveLength(2);
    });

    it("reads a deployment and its events from where the caller stopped", async () => {
        const { client, calls } = recording((url) =>
            url.includes("/events")
                ? json({
                      items: [
                          {
                              seq: 3,
                              phase: "build",
                              level: "info",
                              message: "m",
                              createdAt: PREVIEW.createdAt,
                          },
                      ],
                      nextAfter: null,
                  })
                : json({
                      ...DEPLOYMENT,
                      status: "failed",
                      failure: { code: "build-failed", message: "x" },
                  }),
        );
        const got = await client.deployments.get(ORG, ID);
        expect(got.failure).toEqual({ code: "build-failed", message: "x" });
        const events = await client.deployments.events(ORG, ID, 2);
        expect(events.items[0]!.seq).toBe(3);
        expect(calls[1]!.url).toMatch(/\/events\?after=2$/);
        await client.deployments.events(ORG, ID);
        expect(calls[2]!.url).toMatch(/\/events$/);
    });

    it("uploads the archive as the raw body with its content type and a longer deadline", async () => {
        const body = new Uint8Array([0x1f, 0x8b, 1, 2, 3]);
        const { client, calls } = recording(() =>
            json(
                {
                    id: ID,
                    digest: "a".repeat(64),
                    sizeBytes: 5,
                    expandedBytes: 10,
                    entryCount: 1,
                    createdAt: PREVIEW.createdAt,
                    reused: false,
                },
                { status: 201 },
            ),
        );
        const artifact = await client.artifacts.upload(ORG, body);
        expect(artifact.reused).toBe(false);
        const init = calls[0]!.init;
        expect((init.headers as Record<string, string>)["content-type"]).toBe("application/gzip");
        expect(init.body).toBe(body);
        expect(init.method).toBe("POST");
    });

    it("keeps the caller's own cancellation distinct from a timeout, and encodes path segments", async () => {
        const controller = new AbortController();
        const { client, calls } = recording(
            (_url, init) =>
                new Promise((_resolve, reject) => {
                    init.signal!.addEventListener("abort", () =>
                        reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
                    );
                    setTimeout(() => controller.abort(), 20);
                }),
        );
        await expect(
            client.deployments.get(ORG, ID, { signal: controller.signal }),
        ).rejects.not.toBeInstanceOf(LaunchpadTransportError);
        const { client: other, calls: otherCalls } = recording(() => json(DEPLOYMENT));
        await other.deployments.get("org/1", "a b");
        expect(otherCalls[0]!.url).toContain("/organizations/org%2F1/deployments/a%20b");
        void calls;
    });

    it("turns an API error into a typed error and a bad shape into an invalid-response", async () => {
        const { client } = recording(() =>
            json(
                {
                    code: "conflict",
                    status: 409,
                    title: "That preview already has an unfinished deployment.",
                },
                { status: 409 },
            ),
        );
        const error = await client.deployments
            .create(ORG, ID, { artifactId: ID })
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(LaunchpadApiError);
        expect((error as LaunchpadApiError).code).toBe("conflict");
        const { client: odd } = recording(() => json({ items: "nope" }));
        await expect(odd.previews.list(ORG)).rejects.toMatchObject({ reason: "invalid-response" });
    });
});
