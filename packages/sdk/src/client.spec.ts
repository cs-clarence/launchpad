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
    it("sends artifacts as binary and deploys without any alias mutation", async () => {
        const id = crypto.randomUUID();
        const createdAt = new Date().toISOString();
        const { calls, client } = recording((url) =>
            url.endsWith("/artifacts")
                ? json({
                      id,
                      digest: "a".repeat(64),
                      sizeBytes: 3,
                      expandedBytes: 5,
                      entryCount: 1,
                      createdAt,
                      reused: false,
                  })
                : json({
                      id,
                      appId: id,
                      status: "queued",
                      desiredState: "active",
                      hostname: "preview.example.net",
                      spa: false,
                      createdAt,
                      finishedAt: null,
                      expiresAt: createdAt,
                      failureCode: null,
                      failureMessage: null,
                  }),
        );
        const archive = new Blob([new Uint8Array([31, 139, 8])]);
        const uploaded = await client.artifacts.upload(ORG, id, archive);
        await client.deployments.create(ORG, id, { artifactId: uploaded.id });
        expect(calls.map(({ url }) => new URL(url).pathname)).toEqual([
            `/api/v1/organizations/${ORG}/projects/${id}/artifacts`,
            `/api/v1/organizations/${ORG}/apps/${id}/deployments`,
        ]);
        expect(calls[0]!.init.body).toBe(archive);
        expect(new Headers(calls[0]!.init.headers).get("content-type")).toBe("application/gzip");
        expect(JSON.parse(calls[1]!.init.body as string)).toEqual({ artifactId: id });
    });

    it("preserves an alias generation outside the safe integer range and sends its retry key", async () => {
        const id = crypto.randomUUID();
        const expectedGeneration = "9007199254740993";
        const { client, calls } = recording(() =>
            json({ code: "conflict", status: 409, title: "Stale generation" }, { status: 409 }),
        );
        await expect(
            client.aliases.withdraw(
                ORG,
                id,
                { expectedGeneration },
                { idempotencyKey: "withdraw-1" },
            ),
        ).rejects.toMatchObject({ status: 409 });
        expect(calls[0]!.init.method).toBe("DELETE");
        expect(new Headers(calls[0]!.init.headers).get("idempotency-key")).toBe("withdraw-1");
        expect(calls[0]!.init.body).toBe(JSON.stringify({ expectedGeneration }));
    });
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
                    (i) => i !== "zod" && i !== "@launchpad-kit/contracts" && !i.startsWith("./"),
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

describe("errors", () => {
    it("turns an API error into a typed error and a bad shape into an invalid-response", async () => {
        const { client } = recording(() =>
            json(
                { code: "conflict", status: 409, title: "That project already exists." },
                { status: 409 },
            ),
        );
        const error = await client.projects
            .create(ORG, { name: "A", slug: "a" })
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(LaunchpadApiError);
        expect((error as LaunchpadApiError).code).toBe("conflict");
        const { client: odd } = recording(() => json({ items: "nope" }));
        await expect(odd.projects.list(ORG)).rejects.toMatchObject({ reason: "invalid-response" });
    });
});
