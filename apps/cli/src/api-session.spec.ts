import { promises as fs } from "node:fs";
import path from "node:path";
import { CredentialStore } from "@launchpad-kit/client-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "./errors";
import {
    CONTROLLER,
    json,
    makeDir,
    OWNER,
    PASSWORD,
    session,
    type Options,
    type World,
} from "./session-harness";

const KEY = "lp_" + "a".repeat(43);
let dir = "";
beforeEach(async () => {
    dir = await makeDir();
});
afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
});

const args = (...rest: string[]) => ["api", "--session", "--email", OWNER, ...rest];
const run = (rest: string[], options: Options = {}) => session(args(...rest), dir, options);
const paths = (w: World) => w.requests.map((r) => r.path);
const SECRETS = ["tok1.sig", "tok1%2B", "secretvalue", "better-auth.session_token="];

// Nothing the user must keep secret reaches the terminal, and no request carries a key.
function expectClean(w: World, extra: string[] = []) {
    const text = w.text();
    for (const secret of [PASSWORD, ...SECRETS, ...extra]) expect(text).not.toContain(secret);
    for (const request of w.requests) {
        expect(Object.keys(request.headers)).not.toContain("authorization");
        expect(JSON.stringify(request.headers)).not.toContain(KEY);
    }
}
const noHandlers = (w: World) => {
    for (const set of w.listeners.values()) expect(set.size).toBe(0);
};
const diskEmpty = async () => expect(await fs.readdir(dir)).toEqual([]);

describe("api --session: the in-memory flow", () => {
    it("signs in, calls with Cookie and Origin only, signs out, and writes nothing", async () => {
        const seen: Array<[string, number]> = [];
        const w = await run(["key"], {
            onRequest: (r, world) => {
                if (r.path === "/api/v1/key") {
                    for (const [name, set] of world.listeners) seen.push([name, set.size]);
                }
            },
        });
        expect(w.code).toBe(EXIT.ok);
        expect(paths(w)).toEqual(["/api/auth/sign-in/email", "/api/v1/key", "/api/auth/sign-out"]);
        const [signIn, call, signOut] = w.requests;
        expect(signIn!.headers.cookie).toBeUndefined();
        expect(JSON.parse(signIn!.body)).toEqual({ email: OWNER, password: PASSWORD });
        expect(call!.method).toBe("GET");
        expect(call!.headers.cookie).toMatch(/^__Secure-better-auth\.session_token=tok1\./);
        expect(call!.headers.origin).toBe(CONTROLLER);
        expect(signOut!.headers.cookie).toBe(call!.headers.cookie);
        expect(signOut!.headers.origin).toBe(CONTROLLER);
        expect(w.signedIn).toEqual([OWNER]);
        expect(w.signedOut).toEqual([OWNER]);
        expect(w.sessions.size).toBe(0);
        expect(w.out.join("\n")).toBe(JSON.stringify({ ok: true }, null, 2));
        expect(w.err.join("\n")).toContain(`Signing in to ${CONTROLLER} as ${OWNER}.`);
        expect(seen.sort()).toEqual([
            ["SIGHUP", 1],
            ["SIGINT", 1],
            ["SIGTERM", 1],
        ]);
        noHandlers(w);
        await diskEmpty();
        expectClean(w);
    });

    it("shares one session across all pages of --paginate", async () => {
        let page = 0;
        const w = await run(["organizations", "--paginate"], {
            respond: () =>
                json([{ n: ++page }], {
                    headers:
                        page < 3
                            ? {
                                  link: `</api/v1/organizations?limit=1&cursor=c${page}>; rel="next"`,
                              }
                            : {},
                }),
        });
        expect(w.code).toBe(EXIT.ok);
        expect(paths(w)).toEqual([
            "/api/auth/sign-in/email",
            "/api/v1/organizations",
            "/api/v1/organizations",
            "/api/v1/organizations",
            "/api/auth/sign-out",
        ]);
        expect(JSON.parse(w.out.join("\n"))).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
        await diskEmpty();
        noHandlers(w);
    });

    it("signs out after an HTTP error, a thrown error and an abort", async () => {
        const forbidden = await run(["organizations"], {
            respond: () =>
                json({ code: "forbidden", status: 403, title: "Forbidden" }, { status: 403 }),
        });
        expect(forbidden.code).toBe(EXIT.unauthorized);
        expect(forbidden.signedOut).toEqual([OWNER]);
        expect(paths(forbidden).at(-1)).toBe("/api/auth/sign-out");

        const notList = await run(["key", "--paginate"], {
            respond: () => json({ not: "a list" }),
        });
        expect(notList.code).toBe(EXIT.usage);
        expect(notList.signedOut).toEqual([OWNER]);

        const unreachable = await run(["key"], {
            respond: () => {
                throw new TypeError("fetch failed");
            },
        });
        expect(unreachable.code).toBe(EXIT.transport);
        expect(unreachable.signedOut).toEqual([OWNER]);

        const aborted = await run(["key"], {
            respond: (_api, world) => {
                world.emit("SIGINT");
                return new Promise<Response>(() => {});
            },
        });
        expect(aborted.code).toBe(130);
        expect(aborted.err.join("\n")).toContain("Interrupted.");
        expect(aborted.signedOut).toEqual([OWNER]);
        expect(aborted.sessions.size).toBe(0);
        for (const w of [forbidden, notList, unreachable, aborted]) {
            noHandlers(w);
            expectClean(w);
        }
        await diskEmpty();
    });

    it("exits with 128 plus the signal for SIGTERM and SIGHUP during a call", async () => {
        for (const [signal, code] of [
            ["SIGTERM", 143],
            ["SIGHUP", 129],
        ] as const) {
            const w = await run(["key"], {
                respond: (_api, world) => {
                    world.emit(signal);
                    return new Promise<Response>(() => {});
                },
            });
            expect(w.code).toBe(code);
            expect(w.signedOut).toEqual([OWNER]);
            noHandlers(w);
        }
    });

    it("leaves at once on a second signal, even while signing out", async () => {
        const w = await run(["key"], {
            respond: (_api, world) => {
                world.emit("SIGINT");
                return new Promise<Response>(() => {});
            },
            signOut: (world) => {
                const pending = world.hang();
                world.emit("SIGTERM");
                return pending;
            },
        });
        expect(w.exits).toEqual([143]);
        expect(w.code).toBe(130);
        noHandlers(w);
    });

    it("warns when the sign-out fails and keeps the exit code of a call that succeeded", async () => {
        const ok = await run(["key"], { signOut: () => json({}, { status: 500 }) });
        expect(ok.code).toBe(EXIT.ok);
        expect(ok.err.join("\n")).toMatch(/Warning: could not sign out of .*at most 7 days/);
        expect(ok.out.join("\n")).toContain('"ok": true');

        const unreachable = await run(["key"], {
            signOut: () => {
                throw new TypeError("fetch failed");
            },
        });
        expect(unreachable.code).toBe(EXIT.ok);
        expect(unreachable.err.join("\n")).toContain("Warning: could not sign out");

        const failed = await run(["key"], {
            respond: () => json({ code: "forbidden", title: "Forbidden" }, { status: 403 }),
            signOut: () => json({}, { status: 500 }),
        });
        expect(failed.code).toBe(EXIT.unauthorized);
        expectClean(ok);
        expectClean(unreachable);
    });
});

describe("api --session: the hidden prompt and signals", () => {
    it("reads the password from the terminal prompt without echo", async () => {
        const w = await run(["key"], {
            prompt: "terminal",
            onPrompt: (world) => world.typed(`${PASSWORD}\r`),
        });
        expect(w.code).toBe(EXIT.ok);
        expect(w.prompts).toEqual([`Password for ${OWNER}: `]);
        expect(w.rawMode).toEqual([true, false]);
        expectClean(w);
    });

    it("restores the terminal for SIGTERM, SIGHUP and Ctrl-C at the prompt, sending nothing", async () => {
        for (const [signal, code] of [
            ["SIGTERM", 143],
            ["SIGHUP", 129],
            ["SIGINT", 130],
        ] as const) {
            let installed = 0;
            const w = await run(["key"], {
                prompt: "terminal",
                onPrompt: (world) => {
                    installed = world.listeners.get(signal)?.size ?? 0;
                    world.emit(signal);
                },
            });
            expect(w.code).toBe(code);
            expect(installed).toBe(1);
            expect(w.rawMode).toEqual([true, false]);
            expect(w.requests).toEqual([]);
            noHandlers(w);
        }
        const ctrlC = await run(["key"], {
            prompt: "terminal",
            onPrompt: (world) => world.typed("\u0003"),
        });
        expect(ctrlC.code).toBe(EXIT.usage);
        expect(ctrlC.rawMode).toEqual([true, false]);
        expect(ctrlC.requests).toEqual([]);
        noHandlers(ctrlC);
    });

    it("refuses without a terminal before prompting, and reads a password file instead", async () => {
        const none = await run(["key"], { interactive: false });
        expect(none.code).toBe(EXIT.usage);
        expect(none.err.join("\n")).toContain("--password-file");
        expect(none.prompts).toEqual([]);
        expect(none.requests).toEqual([]);

        const file = await run(["key", "--password-file", "/pw"], {
            interactive: false,
            files: { "/pw": PASSWORD },
        });
        expect(file.code).toBe(EXIT.ok);
        expect(file.prompts).toEqual([]);
        expectClean(file);

        const short = await run(["key", "--password-file", "/pw"], { files: { "/pw": "short" } });
        expect(short.code).toBe(EXIT.usage);
        expect(short.requests).toEqual([]);
        expect(short.text()).not.toContain("short\n");
    });
});

describe("api --session: refusals before anything is asked or sent", () => {
    const nothing = (w: World) => {
        expect(w.code).toBe(EXIT.usage);
        expect(w.requests).toEqual([]);
        expect(w.prompts).toEqual([]);
        noHandlers(w);
    };

    it("needs --email and names it", async () => {
        const w = await session(["api", "--session", "key"], dir);
        nothing(w);
        expect(w.err.join("\n")).toContain("--email");
        for (const bad of ["", "not-an-email", "a b@example.com"]) {
            nothing(await session(["api", "--session", "--email", bad, "key"], dir));
        }
    });

    it("is refused whenever LAUNCHPAD_API_KEY is set, even empty", async () => {
        for (const value of [KEY, ""]) {
            const w = await run(["key"], { env: { LAUNCHPAD_API_KEY: value } });
            nothing(w);
            expect(w.err.join("\n")).toContain("LAUNCHPAD_API_KEY");
        }
        const withBoth = await run(["key"], {
            env: { LAUNCHPAD_API_KEY: KEY, LAUNCHPAD_CONTROLLER: CONTROLLER },
        });
        nothing(withBoth);
    });

    it("accepts LAUNCHPAD_CONTROLLER alone", async () => {
        const w = await run(["key"], { env: { LAUNCHPAD_API_KEY: undefined } });
        expect(w.code).toBe(EXIT.ok);
        expect(w.requests[0]!.url).toBe(`${CONTROLLER}/api/auth/sign-in/email`);
    });

    it("rejects the session flags without --session", async () => {
        for (const extra of [
            ["--email", OWNER],
            ["--password-file", "/pw"],
            ["--controller", CONTROLLER],
        ]) {
            nothing(await session(["api", ...extra, "key"], dir));
        }
    });

    it("refuses controllers that are not https or loopback http", async () => {
        for (const url of [
            "http://example.com",
            "https://u:p@x.example.com",
            "ftp://x",
            "https://x?q",
        ]) {
            nothing(await run(["key", "--controller", url]));
        }
        expect((await run(["key", "--controller", "http://localhost:3000"])).code).not.toBe(
            EXIT.usage,
        );
    });

    it("refuses a {org} with no selection, with no key fallback and no request", async () => {
        nothing(await run(["organizations/{org}/apps"]));
        await new CredentialStore(dir).update((config) => {
            config.profiles.p = {
                controller: CONTROLLER,
                apiKey: KEY,
                organizationId: "org-key",
                savedAt: "now",
            };
            config.currentProfile = "p";
        });
        // The environment controller wins over the current profile, so its organization is unused.
        nothing(await run(["organizations/{org}/apps"]));
    });

    it("explains the throttle in --help", async () => {
        const w = await session(["api", "--help"], dir);
        expect(w.out.join("\n")).toMatch(/throttled/);
        expect(w.out.join("\n")).toMatch(/dashboard sign-in/);
        expect(w.requests).toEqual([]);
    });
});

describe("api --session: controller and organization", () => {
    const profile = async () =>
        new CredentialStore(dir).update((config) => {
            config.profiles.p = {
                controller: "https://profile.example.com",
                apiKey: KEY,
                organizationId: "org-profile",
                savedAt: "now",
            };
        });
    const host = (w: World) => new URL(w.requests[0]!.url).host;

    it("takes the controller from --controller, then --profile, then LAUNCHPAD_CONTROLLER", async () => {
        await profile();
        const explicit = await run(["key", "--controller", "https://flag.example.com"]);
        expect(host(explicit)).toBe("flag.example.com");
        const chosen = await run(["key", "--profile", "p"]);
        expect(host(chosen)).toBe("profile.example.com");
        const env = await run(["key"]);
        expect(host(env)).toBe("control.example.com");
        const both = await run([
            "key",
            "--controller",
            "https://flag.example.com",
            "--profile",
            "p",
        ]);
        expect(host(both)).toBe("flag.example.com");
    });

    it("uses only the profile's controller and organization, never its key", async () => {
        await profile();
        const w = await run(["organizations/{org}/projects", "--profile", "p"]);
        expect(w.code).toBe(EXIT.ok);
        expect(paths(w)).toEqual([
            "/api/auth/sign-in/email",
            "/api/v1/organizations/org-profile/projects",
            "/api/auth/sign-out",
        ]);
        expect(JSON.stringify(w.requests)).not.toContain(KEY);
        expect(w.text()).not.toContain(KEY);
        expectClean(w);
    });

    it("ignores a profile's organization when the controller is another one", async () => {
        await profile();
        const w = await run([
            "organizations/{org}/projects",
            "--profile",
            "p",
            "--controller",
            "https://other.example.com",
        ]);
        expect(w.code).toBe(EXIT.usage);
        expect(w.requests).toEqual([]);
    });

    it("prefers LAUNCHPAD_ORG and resolves a launchpad.json slug through the session", async () => {
        const env = await run(["organizations/{org}/apps"], { env: { LAUNCHPAD_ORG: "org-env" } });
        expect(paths(env)[1]).toBe("/api/v1/organizations/org-env/apps");

        await fs.writeFile(
            path.join(dir, "launchpad.json"),
            JSON.stringify({ organization: "acme", project: "site" }),
        );
        const named = await run(["organizations/{org}/apps"], {
            respond: (api) =>
                api.path === "/organizations"
                    ? json([{ id: "org-1", slug: "acme", name: "Acme", role: "owner" }])
                    : json([]),
        });
        expect(named.code).toBe(EXIT.ok);
        expect(paths(named)).toEqual([
            "/api/auth/sign-in/email",
            "/api/v1/organizations",
            "/api/v1/organizations/org-1/apps",
            "/api/auth/sign-out",
        ]);
        expect(named.signedIn).toHaveLength(1);
    });
});

describe("api --session: errors and secrets", () => {
    it("does not retry, and shows the wait from either header", async () => {
        const limited = (headers: Record<string, string>) => () =>
            json(
                { code: "too-many-requests", status: 429, title: "Too Many Requests" },
                { status: 429, headers },
            );
        for (const [headers, wait] of [
            [{ "retry-after": "60" }, "60"],
            [{ "x-retry-after": "42" }, "42"],
            [{ "retry-after": "60", "x-retry-after": "42" }, "60"],
        ] as const) {
            const w = await run(["key"], { signIn: limited(headers) });
            expect(w.code).toBe(EXIT.failure);
            expect(w.err.join("\n")).toContain(`Try again in ${wait} seconds.`);
            expect(paths(w)).toEqual(["/api/auth/sign-in/email"]);
            noHandlers(w);
        }
    });

    it("treats client-address-unavailable and a wrong password as plain, non-retried errors", async () => {
        const noAddress = await run(["key"], {
            signIn: () =>
                json(
                    { code: "client-address-unavailable", status: 400, title: "Bad Request" },
                    { status: 400 },
                ),
        });
        expect(noAddress.code).toBe(EXIT.failure);
        expect(paths(noAddress)).toEqual(["/api/auth/sign-in/email"]);

        const wrong = await run(["key"], { answer: "wrong password 123" });
        expect(wrong.code).toBe(EXIT.unauthorized);
        expect(wrong.err.join("\n")).toContain("Wrong email or password.");
        expect(paths(wrong)).toEqual(["/api/auth/sign-in/email"]);
        expect(wrong.text()).not.toContain("wrong password 123");
    });

    it("fails a 200 sign-in with no session cookie, without a sign-out", async () => {
        const w = await run(["key"], { signIn: () => json({ ok: true }) });
        expect(w.code).toBe(EXIT.failure);
        expect(w.err.join("\n")).toContain("no session cookie");
        expect(paths(w)).toEqual(["/api/auth/sign-in/email"]);
    });

    it("hints at the origin setting on forbidden-origin and still signs out", async () => {
        const w = await run(["organizations", "-X", "POST", "-f", "name=x", "--confirm"], {
            respond: () =>
                json(
                    { code: "forbidden-origin", status: 403, title: "Forbidden" },
                    { status: 403 },
                ),
        });
        expect(w.code).toBe(EXIT.unauthorized);
        expect(w.err.join("\n")).toContain("LAUNCHPAD_BASE_URL");
        expect(w.signedOut).toEqual([OWNER]);
    });

    it("never prints the cookie or the password, in output, errors or --verbose", async () => {
        const echo = (api: { cookie: string }) => {
            const value = api.cookie.slice(api.cookie.indexOf("=") + 1);
            return new Response(
                JSON.stringify({
                    cookie: api.cookie,
                    value,
                    decoded: decodeURIComponent(value),
                    password: PASSWORD,
                    quoted: JSON.stringify(PASSWORD),
                }),
                {
                    headers: new Headers([
                        ["content-type", "application/json"],
                        ["x-echo", api.cookie],
                        ["set-cookie", `${api.cookie}; Path=/`],
                    ]),
                },
            );
        };
        const ok = await run(["key", "--verbose", "-i"], { respond: echo });
        expect(ok.code).toBe(EXIT.ok);
        expectClean(ok);
        const text = ok.text();
        expect(text).toContain("> cookie: [redacted]");
        expect(text).toContain(`> origin: ${CONTROLLER}`);
        expect(text.toLowerCase()).not.toContain("authorization");
        expect(text).toContain("[redacted]");

        const failing = await run(["key", "--json"], {
            respond: (api) =>
                json({ code: "bad", title: `nope ${api.cookie} ${PASSWORD}` }, { status: 400 }),
        });
        expect(failing.code).toBe(EXIT.failure);
        expectClean(failing);

        const wrong = await run(["key", "--verbose"], { answer: "another password 99" });
        expect(wrong.text()).not.toContain("another password 99");
    });
});
