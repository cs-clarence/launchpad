import { describe, expect, it } from "vitest";
import {
    createClient,
    LaunchpadApiError,
    LaunchpadConfigError,
    LaunchpadTransportError,
    FORBIDDEN_RAW_HEADERS,
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

describe("paged lists", () => {
    const APP = {
        id: ID,
        projectId: ID,
        slug: "site",
        state: "active",
        createdAt: "2026-11-15T00:00:00.000Z",
    };
    const apps = `/api/v1/organizations/${ORG}/apps`;

    it("returns items and the next cursor from a relative Link, then the last page", async () => {
        const { client, calls } = recording((url) =>
            new URL(url).searchParams.get("cursor") === "c1"
                ? json([APP])
                : json([APP, APP], {
                      headers: { link: `<${apps}?limit=2&cursor=c1>; rel="next"` },
                  }),
        );
        const first = await client.apps.listPage(ORG, { limit: 2 });
        expect(first.items.length).toBe(2);
        expect(first.next).toEqual({ cursor: "c1" });
        const last = await client.apps.listPage(ORG, { limit: 2, cursor: first.next!.cursor });
        expect(last).toEqual({ items: [expect.objectContaining({ slug: "site" })] });
        expect(calls.map((call) => call.url)).toEqual([
            `https://control.example.com${apps}?limit=2`,
            `https://control.example.com${apps}?limit=2&cursor=c1`,
        ]);
    });

    it("ignores links to another host, another path or without a cursor", async () => {
        for (const link of [
            `<https://evil.example.net${apps}?limit=2&cursor=c1>; rel="next"`,
            `<//evil.example.net${apps}?limit=2&cursor=c1>; rel="next"`,
            `</other/path?limit=2&cursor=c1>; rel="next"`,
            `<${apps.replace("/api/v1", "")}?limit=2&cursor=c1>; rel="next"`,
            `<${apps}?limit=2>; rel="next"`,
            `<${apps}?limit=2&cursor=c1>; rel="prev"`,
            `<${apps}?limit=2&cursor=a%20b>; rel="next"`,
            "garbage",
        ]) {
            const { client } = recording(() => json([APP], { headers: { link } }));
            expect((await client.apps.listPage(ORG, { limit: 2 })).next, link).toBeUndefined();
        }
    });

    it("accepts an absolute link on the controller's own origin", async () => {
        const { client } = recording(() =>
            json([APP], {
                headers: {
                    link: `<https://control.example.com${apps}?limit=2&cursor=c9>; rel="next"`,
                },
            }),
        );
        expect((await client.apps.listPage(ORG, { limit: 2 })).next).toEqual({ cursor: "c9" });
    });

    it("rejects a limit outside 1 to 100 before any request", async () => {
        const { client, calls } = recording(() => json([]));
        for (const limit of [0, 101, 1.5, Number.NaN]) {
            await expect(client.apps.listPage(ORG, { limit })).rejects.toBeInstanceOf(
                LaunchpadConfigError,
            );
        }
        expect(calls).toEqual([]);
    });

    it("keeps list unchanged: no query, bare array", async () => {
        const { client, calls } = recording(() => json([APP]));
        expect(await client.apps.list(ORG)).toHaveLength(1);
        expect(calls[0]!.url).toBe(`https://control.example.com${apps}`);
    });

    it("pages events by after, taking nextAfter from the Link", async () => {
        const path = `/api/v1/organizations/${ORG}/deployments/${ID}/events`;
        const EVENT = {
            seq: "2",
            phase: "build",
            level: "info",
            message: "x",
            createdAt: "2026-11-15T00:00:00.000Z",
        };
        const { client, calls } = recording(() =>
            json([EVENT], { headers: { link: `<${path}?after=2&limit=1>; rel="next"` } }),
        );
        const page = await client.deployments.eventsPage(ORG, ID, { after: "1", limit: 1 });
        expect(page.nextAfter).toBe("2");
        expect(calls[0]!.url).toBe(`https://control.example.com${path}?after=1&limit=1`);
        const { client: bad } = recording(() =>
            json([EVENT], { headers: { link: `<${path}?after=x&limit=1>; rel="next"` } }),
        );
        expect((await bad.deployments.eventsPage(ORG, ID, { limit: 1 })).nextAfter).toBeUndefined();
        await expect(client.deployments.eventsPage(ORG, ID, { limit: 501 })).rejects.toBeInstanceOf(
            LaunchpadConfigError,
        );
    });
});

describe("raw", () => {
    const base = "https://control.example.com/api/v1";

    it("refuses hostile paths before anything is sent", async () => {
        const { client, calls } = recording(() => json({}));
        for (const path of [
            "https://evil.example/x",
            "http://evil.example/x",
            "//evil.example/x",
            "/\\evil.example/x",
            "evil.example:80/x",
            "a/../b",
            "a/./b",
            "..",
            "a/%2e%2e/b",
            "a/%2E/b",
            "a%2fb",
            "a%5cb",
            "a%00b",
            "a%zz",
            "x#y",
            "x?y=1",
            "a\nb",
            "a\rb",
            "a b",
            "a\tb",
            "é",
            "",
            "/",
            "a//b",
            "x".repeat(3000),
        ]) {
            await expect(client.raw("GET", path), JSON.stringify(path)).rejects.toBeInstanceOf(
                LaunchpadConfigError,
            );
        }
        expect(calls).toEqual([]);
    });

    it("refuses bad methods, headers and bodies before anything is sent", async () => {
        const { client, calls } = recording(() => json({}));
        const cases: Array<[string, Parameters<typeof client.raw>[2]]> = [
            ["TRACE", {}],
            ["GET /", {}],
            ["GET", { headers: { Authorization: "Bearer x" } }],
            ["GET", { headers: { cookie: "a=b" } }],
            ["GET", { headers: { Host: "evil" } }],
            ["GET", { headers: { "content-length": "1" } }],
            ["GET", { headers: { origin: "https://evil" } }],
            ["GET", { headers: { "idempotency-key": "k" } }],
            ["GET", { headers: { "x-a": "b\r\nauthorization: x" } }],
            ["GET", { headers: { "x a": "b" } }],
            ["GET", { body: "{}" }],
            ["POST", { body: "x".repeat(1024 * 1024 + 1) }],
            ["POST", { idempotencyKey: "has space" }],
        ];
        for (const [method, options] of cases) {
            await expect(client.raw(method, "key", options), method).rejects.toBeInstanceOf(
                LaunchpadConfigError,
            );
        }
        expect(calls).toEqual([]);
    });

    it("sends the key, query, body and headers, and returns status, headers and text", async () => {
        const { client, calls } = recording(
            () => new Response("plain text", { status: 200, headers: { "x-id": "7" } }),
        );
        const result = await client.raw("post", "organizations/o/projects", {
            query: [
                ["a", "1"],
                ["a", "2 3"],
            ],
            body: '{"n":1}',
            headers: { "X-Trace": "t" },
            idempotencyKey: "k-1",
        });
        expect(result.status).toBe(200);
        expect(result.body).toBe("plain text");
        expect(result.headers.get("x-id")).toBe("7");
        expect(result.next).toBeNull();
        expect(calls[0]!.url).toBe(`${base}/organizations/o/projects?a=1&a=2+3`);
        expect(calls[0]!.init.method).toBe("POST");
        expect(calls[0]!.init.body).toBe('{"n":1}');
        expect(calls[0]!.init.redirect).toBe("error");
        expect(calls[0]!.init.headers).toEqual({
            accept: "application/json",
            authorization: `Bearer ${KEY}`,
            "content-type": "application/json",
            "idempotency-key": "k-1",
            "x-trace": "t",
        });
    });

    it("returns an empty body for 204 and maps errors without exposing the body", async () => {
        const empty = recording(() => new Response(null, { status: 204 }));
        expect((await empty.client.raw("DELETE", "x")).body).toBe("");
        const failing = recording(() =>
            json({ code: "forbidden", title: "No", detail: KEY }, { status: 403 }),
        );
        const error = await failing.client.raw("GET", "x").catch((e) => e);
        expect(error).toBeInstanceOf(LaunchpadApiError);
        expect(error.status).toBe(403);
        expect(JSON.stringify(error) + error.message).not.toContain(KEY);
        const big = recording(() => new Response("x".repeat(1024 * 1024 + 1)));
        await expect(big.client.raw("GET", "x")).rejects.toBeInstanceOf(LaunchpadTransportError);
    });

    it("exposes only a validated next link of a GET", async () => {
        const path = `/api/v1/organizations/${ORG}/apps`;
        const link = (target: string) => ({ link: `<${target}>; rel="next"` });
        const good = recording(() => json([], { headers: link(`${path}?limit=2&cursor=c1`) }));
        expect((await good.client.raw("GET", `organizations/${ORG}/apps`)).next).toEqual([
            ["limit", "2"],
            ["cursor", "c1"],
        ]);
        for (const target of [
            `https://evil.example.net${path}?cursor=c1`,
            `//evil.example.net${path}?cursor=c1`,
            `/api/v1/other?cursor=c1`,
        ]) {
            const { client } = recording(() => json([], { headers: link(target) }));
            expect((await client.raw("GET", `organizations/${ORG}/apps`)).next, target).toBeNull();
        }
    });

    it("refuses every credential, framing, method-override and forwarding header", async () => {
        const { client, calls } = recording(() => json({}));
        for (const name of [
            "authorization",
            "proxy-authorization",
            "cookie",
            "host",
            "content-length",
            "origin",
            "transfer-encoding",
            "connection",
            "upgrade",
            "idempotency-key",
            "x-http-method-override",
            "x-method-override",
            "x-http-method",
            "x-forwarded-host",
            "x-forwarded-for",
            "x-forwarded-proto",
            "forwarded",
            "proxy-connection",
            "te",
            "trailer",
            "keep-alive",
            "expect",
        ]) {
            expect(FORBIDDEN_RAW_HEADERS.has(name), name).toBe(true);
            await expect(
                client.raw("GET", "key", { headers: { [name.toUpperCase()]: "v" } }),
                name,
            ).rejects.toBeInstanceOf(LaunchpadConfigError);
        }
        expect(calls).toEqual([]);
    });
});
