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
