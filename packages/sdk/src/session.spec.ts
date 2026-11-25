import { describe, expect, it } from "vitest";
import {
    createSessionClient,
    LaunchpadApiError,
    LaunchpadConfigError,
    LaunchpadTransportError,
} from "./index";

const PASSWORD = "correct horse battery";
const VALUE = "tok123.sig%2Babc";
const json = (body: unknown, init: ResponseInit = {}) =>
    new Response(JSON.stringify(body), {
        ...init,
        headers: { "content-type": "application/json", ...init.headers },
    });

type Responder = (url: string, init: RequestInit) => Response | Promise<Response>;

function setup(respond: Responder, options: { baseUrl?: string; cookie?: string } = {}) {
    const calls: { url: string; init: RequestInit; headers: Record<string, string> }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
        calls.push({ url, init, headers: init.headers as Record<string, string> });
        return respond(url, init);
    }) as unknown as typeof fetch;
    const client = createSessionClient({
        baseUrl: options.baseUrl ?? "https://control.example.com",
        cookie: options.cookie,
        fetch: fetchImpl,
    });
    return { calls, client };
}

const signedIn = (name = "__Secure-better-auth.session_token") =>
    new Response("{}", {
        status: 200,
        headers: new Headers([
            ["set-cookie", `${name}=${VALUE}; Max-Age=604800; Path=/; HttpOnly; Secure`],
        ]),
    });

describe("controller URL", () => {
    it("accepts and refuses the same addresses as the key client, sending nothing", async () => {
        for (const ok of [
            "https://x",
            "http://localhost:3000",
            "http://127.0.0.1",
            "http://[::1]:3000",
        ]) {
            expect(() => createSessionClient({ baseUrl: ok }), ok).not.toThrow();
        }
        for (const bad of [
            "http://example.com",
            "http://localhost.evil",
            "https://u:p@x",
            "https://x?q",
            "https://x#f",
            "ftp://x",
        ]) {
            expect(() => createSessionClient({ baseUrl: bad }), bad).toThrow(LaunchpadConfigError);
        }
    });
});

describe("signIn", () => {
    it("posts the credentials with only Origin, keeps the session cookie and uses the __Secure- name on https", async () => {
        const { calls, client } = setup(() => signedIn());
        const result = await client.signIn("ann@example.com", PASSWORD);
        expect(result.cookie).toBe(`__Secure-better-auth.session_token=${VALUE}`);
        expect(client.cookie()).toBe(result.cookie);
        expect(calls).toHaveLength(1);
        const [call] = calls;
        expect(call!.url).toBe("https://control.example.com/api/auth/sign-in/email");
        expect(call!.init.method).toBe("POST");
        expect(JSON.parse(String(call!.init.body))).toEqual({
            email: "ann@example.com",
            password: PASSWORD,
        });
        expect(Object.keys(call!.headers).sort()).toEqual(["accept", "content-type", "origin"]);
        expect(call!.headers.origin).toBe("https://control.example.com");
        expect(call!.init).toMatchObject({ credentials: "omit", redirect: "error" });
    });

    it("uses the plain cookie name over loopback http and a path prefix keeps the origin bare", async () => {
        const plain = setup(() => signedIn("better-auth.session_token"), {
            baseUrl: "http://localhost:3000",
        });
        expect((await plain.client.signIn("a@b.c", PASSWORD)).cookie).toBe(
            `better-auth.session_token=${VALUE}`,
        );
        const prefixed = setup(() => signedIn(), { baseUrl: "https://x.example.com/launchpad/" });
        await prefixed.client.signIn("a@b.c", PASSWORD);
        expect(prefixed.calls[0]!.url).toBe(
            "https://x.example.com/launchpad/api/auth/sign-in/email",
        );
        expect(prefixed.calls[0]!.headers.origin).toBe("https://x.example.com");
    });

    it("fails a 200 without the right session cookie, and never reports the password", async () => {
        for (const response of [
            () => json({ ok: true }),
            () => signedIn("better-auth.session_token"), // https wants the __Secure- name
            () => signedIn("other"),
            () =>
                new Response("{}", {
                    headers: new Headers([
                        ["set-cookie", "__Secure-better-auth.session_token=bad value; Path=/"],
                    ]),
                }),
        ]) {
            const { client } = setup(response);
            const error = await client.signIn("a@b.c", PASSWORD).catch((e: Error) => e);
            expect(error).toBeInstanceOf(LaunchpadApiError);
            expect((error as LaunchpadApiError).code).toBe("no-session");
            expect(client.cookie()).toBeNull();
            expect((error as Error).message).not.toContain(PASSWORD);
        }
    });

    it("maps 401, 429 (both header names), 400 and 403 without echoing the server's words or the password", async () => {
        const failure = async (response: Response) => {
            const { client } = setup(() => response);
            const error = await client.signIn("a@b.c", PASSWORD).catch((e: unknown) => e);
            expect(error).toBeInstanceOf(LaunchpadApiError);
            expect(JSON.stringify(error) + (error as Error).message).not.toContain(PASSWORD);
            return error as LaunchpadApiError;
        };
        const wrong = await failure(
            json(
                { code: "INVALID_EMAIL_OR_PASSWORD", message: `bad ${PASSWORD}` },
                { status: 401 },
            ),
        );
        expect(wrong).toMatchObject({ status: 401, title: "Wrong email or password." });

        const controller = await failure(
            json(
                { code: "too-many-requests", status: 429, title: "Too Many Requests" },
                { status: 429, headers: { "retry-after": "60" } },
            ),
        );
        expect(controller).toMatchObject({ status: 429, retryAfterSeconds: 60 });
        const betterAuth = await failure(
            json(
                { message: "Too many requests" },
                { status: 429, headers: { "x-retry-after": "42" } },
            ),
        );
        expect(betterAuth).toMatchObject({ status: 429, retryAfterSeconds: 42 });
        const both = await failure(
            json({}, { status: 429, headers: { "retry-after": "60", "x-retry-after": "42" } }),
        );
        expect(both.retryAfterSeconds).toBe(60);

        const noAddress = await failure(
            json(
                { code: "client-address-unavailable", status: 400, title: "Bad Request" },
                { status: 400 },
            ),
        );
        expect(noAddress).toMatchObject({ status: 400, code: "client-address-unavailable" });

        const origin = await failure(
            json({ code: "forbidden-origin", status: 403, title: "Forbidden" }, { status: 403 }),
        );
        expect(origin.title).toContain("LAUNCHPAD_BASE_URL");
        const authOrigin = await failure(
            json({ code: "INVALID_ORIGIN", message: "Invalid origin" }, { status: 403 }),
        );
        expect(authOrigin.title).toContain("LAUNCHPAD_BASE_URL");
    });

    it("maps timeouts, redirects and unreachable controllers without leaking the password", async () => {
        for (const [failure, reason] of [
            [new TypeError("fetch failed: unexpected redirect"), "redirect"],
            [new TypeError(`connect ECONNREFUSED ${PASSWORD}`), "unreachable"],
        ] as const) {
            const { client } = setup(() => {
                throw failure;
            });
            const error = await client.signIn("a@b.c", PASSWORD).catch((e: unknown) => e);
            expect(error).toBeInstanceOf(LaunchpadTransportError);
            expect((error as LaunchpadTransportError).reason).toBe(reason);
            expect((error as Error).message).not.toContain(PASSWORD);
        }
    });

    it("refuses a second sign-in and empty credentials before sending", async () => {
        const { calls, client } = setup(() => signedIn());
        await expect(client.signIn("", PASSWORD)).rejects.toBeInstanceOf(LaunchpadConfigError);
        await expect(client.signIn("a@b.c", "")).rejects.toBeInstanceOf(LaunchpadConfigError);
        expect(calls).toHaveLength(0);
        await client.signIn("a@b.c", PASSWORD);
        await expect(client.signIn("a@b.c", PASSWORD)).rejects.toBeInstanceOf(LaunchpadConfigError);
        expect(calls).toHaveLength(1);
    });
});

describe("calls with a session", () => {
    const cookie = `__Secure-better-auth.session_token=${VALUE}`;

    it("sends Cookie and the exact Origin and never Authorization", async () => {
        const { calls, client } = setup(() => json({ ok: true }), { cookie });
        await client.raw("POST", "/organizations", { body: '{"a":1}' });
        await client.raw("GET", "organizations");
        await client.signOut();
        expect(calls.map((c) => [c.init.method, c.url])).toEqual([
            ["POST", "https://control.example.com/api/v1/organizations"],
            ["GET", "https://control.example.com/api/v1/organizations"],
            ["POST", "https://control.example.com/api/auth/sign-out"],
        ]);
        for (const call of calls) {
            expect(Object.keys(call.headers).some((n) => n.toLowerCase() === "authorization")).toBe(
                false,
            );
            expect(call.headers.cookie).toBe(cookie);
            expect(call.headers.origin).toBe("https://control.example.com");
            expect(call.init).toMatchObject({ credentials: "omit", redirect: "error" });
        }
    });

    it("refuses credential headers and hostile paths, sending nothing", async () => {
        const { calls, client } = setup(() => json({}), { cookie });
        for (const name of ["authorization", "Cookie", "origin", "proxy-authorization"]) {
            await expect(
                client.raw("GET", "/key", { headers: { [name]: "x" } }),
            ).rejects.toBeInstanceOf(LaunchpadConfigError);
        }
        for (const path of ["https://evil.example/x", "//evil/x", "a/../b", "/x#y", "/x%2fy"]) {
            await expect(client.raw("GET", path)).rejects.toBeInstanceOf(LaunchpadConfigError);
        }
        expect(calls).toHaveLength(0);
    });

    it("needs a session and a well-formed cookie, without echoing it", async () => {
        const { calls, client } = setup(() => json({}));
        await expect(client.raw("GET", "/key")).rejects.toBeInstanceOf(LaunchpadConfigError);
        await expect(client.signOut()).rejects.toBeInstanceOf(LaunchpadConfigError);
        expect(calls).toHaveLength(0);
        for (const bad of ["x=1", `better-auth.session_token=${VALUE}`, `${cookie}; other=1`, ""]) {
            const error = (() => {
                try {
                    createSessionClient({ baseUrl: "https://control.example.com", cookie: bad });
                } catch (e) {
                    return e as Error;
                }
            })();
            expect(error, bad).toBeInstanceOf(LaunchpadConfigError);
            expect(error!.message).not.toContain(VALUE);
        }
    });

    it("removes Set-Cookie and scrubs the cookie from bodies, headers and errors", async () => {
        const { client } = setup(
            () =>
                new Response(JSON.stringify({ echo: cookie, value: VALUE }), {
                    headers: new Headers([
                        ["set-cookie", `${cookie}; Path=/`],
                        ["x-echo", cookie],
                        ["content-type", "application/json"],
                    ]),
                }),
            { cookie },
        );
        const response = await client.raw("GET", "/me");
        expect(response.headers.has("set-cookie")).toBe(false);
        expect(response.headers.get("x-echo")).toBe("[redacted]");
        expect(response.body).not.toContain(VALUE);

        const failing = setup(
            () => json({ code: `c-${VALUE}`, title: `nope ${cookie}` }, { status: 403 }),
            { cookie },
        );
        const error = (await failing.client
            .raw("GET", "/me")
            .catch((e: unknown) => e)) as LaunchpadApiError;
        expect(error.message + error.code + error.title).not.toContain(VALUE);
    });

    it("hints at the origin setting on a forbidden-origin answer from any call", async () => {
        const { client } = setup(
            () =>
                json(
                    { code: "forbidden-origin", status: 403, title: "Forbidden" },
                    { status: 403 },
                ),
            { cookie },
        );
        const error = (await client
            .raw("POST", "/organizations", { body: "{}" })
            .catch((e: unknown) => e)) as LaunchpadApiError;
        expect(error).toMatchObject({ status: 403, code: "forbidden-origin" });
        expect(error.title).toContain("LAUNCHPAD_BASE_URL");
    });

    it("keeps a next link for paging and reads 429 headers on any call", async () => {
        const { client } = setup(
            () => json([], { headers: { link: '</api/v1/organizations?cursor=abc>; rel="next"' } }),
            { cookie },
        );
        expect((await client.raw("GET", "/organizations")).next).toEqual([["cursor", "abc"]]);
        const limited = setup(() => json({}, { status: 429, headers: { "x-retry-after": "9" } }), {
            cookie,
        });
        await expect(limited.client.raw("GET", "/key")).rejects.toMatchObject({
            status: 429,
            retryAfterSeconds: 9,
        });
    });
});
