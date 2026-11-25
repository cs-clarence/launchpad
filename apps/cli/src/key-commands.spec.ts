import { promises as fs, statSync } from "node:fs";
import path from "node:path";
import { CredentialStore } from "@launchpad-kit/client-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "./errors";
import {
    ACTING,
    callLines,
    expectClean,
    ID,
    noHandlers,
    onFirstCall,
    ORG,
    OTHER_ORG,
    SECRET,
    v1,
} from "./org-harness";
import {
    CONTROLLER,
    json,
    makeDir,
    newServer,
    OPERATOR,
    OWNER,
    PASSWORD,
    session,
    trackProcessListeners,
    type Options,
    type Server,
    type World,
} from "./session-harness";

trackProcessListeners();
let dir = "";
let target = "";
let server: Server;
beforeEach(async () => {
    dir = await makeDir();
    target = path.join(dir, "ci.key");
    server = newServer();
});
afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
});

const go = (args: string[], options: Options = {}) => session(args, dir, { server, ...options });
const auth = ["--email", OWNER];
const exists = (file = target) =>
    fs.stat(file).then(
        () => true,
        () => false,
    );
const when = "2026-12-26T10:00:00.000Z";
const created = (extra: object = {}) =>
    json(
        {
            id: ID,
            name: "ci",
            secret: SECRET,
            scopes: ["project:read", "app:deploy"],
            projectIds: null,
            expiresAt: when,
            ...extra,
        },
        { status: 201 },
    );
const issueArgs = (...extra: string[]) => [
    "key",
    "issue",
    ...auth,
    "--org",
    ORG,
    "--name",
    "ci",
    "--scope",
    "project:read",
    "--scope",
    "app:deploy",
    "--expires-in-days",
    "30",
    "--secret-file",
    target,
    "--confirm",
    ...extra,
];
const refusedBeforeAnything = (w: World, code = EXIT.usage) => {
    expect(w.code).toBe(code);
    expect(w.requests).toEqual([]);
    expect(w.prompts).toEqual([]);
    expectClean(w, [SECRET]);
    noHandlers(w);
};

describe("key issue", () => {
    it("creates the file (0600) before the request, writes the secret to it and never shows it", async () => {
        const seen: Array<{ mode: number; size: number; path: string }> = [];
        const w = await go(issueArgs(), {
            respond: () => created(),
            onRequest: (r, world) => {
                const stat = statSync(target);
                seen.push({ mode: stat.mode & 0o777, size: stat.size, path: r.path });
                onFirstCall((x) => expect(x.err).toContain(ACTING(OWNER, ORG)))(r, world);
            },
        });
        expect(w.code).toBe(EXIT.ok);
        expect(seen.slice(0, 2).every((s) => s.mode === 0o600 && s.size === 0)).toBe(true);
        expect(await fs.readFile(target, "utf8")).toBe(`${SECRET}\n`);
        expect(callLines(w)).toEqual([`POST /api/v1/organizations/${ORG}/api-keys`]);
        expect(w.requests.map((r) => r.path)).toEqual([
            "/api/auth/sign-in/email",
            `/api/v1/organizations/${ORG}/api-keys`,
            "/api/auth/sign-out",
        ]);
        const request = v1(w)[0]!;
        expect(JSON.parse(request.body)).toEqual({
            name: "ci",
            scopes: ["project:read", "app:deploy"],
            expiresInDays: 30,
        });
        expect(request.headers.origin).toBe(CONTROLLER);
        expect(request.headers.cookie).toContain("session_token=");
        expect(w.out).toEqual([
            `Issued key ci (${ID}), expires ${when}. The secret is in ${target}.`,
        ]);
        expect(w.err.filter((l) => l.startsWith("Acting as"))).toEqual([ACTING(OWNER, ORG)]);
        expectClean(w, [SECRET]);
        noHandlers(w);
    });

    it("sends projectIds when limited, and --json hides the secret and keeps stdout pure", async () => {
        const project = "44444444-4444-4444-8444-444444444444";
        const w = await go([...issueArgs("--project", project), "--json"], {
            respond: () => created({ projectIds: [project] }),
        });
        expect(w.code).toBe(EXIT.ok);
        expect(JSON.parse(v1(w)[0]!.body).projectIds).toEqual([project]);
        const shown = JSON.parse(w.out.join("\n"));
        expect(shown.secret).toBe(`[written to ${target}]`);
        expect(shown.id).toBe(ID);
        expect(w.out.join("\n")).not.toContain("Acting as");
        expectClean(w, [SECRET]);
    });

    it("exits 2 with zero requests for every bad input", async () => {
        const project = "44444444-4444-4444-8444-444444444444";
        const without = (flag: string, drop = 2) => {
            const args = issueArgs();
            args.splice(args.indexOf(flag), drop);
            return args;
        };
        await fs.writeFile(path.join(dir, "taken"), "x");
        const cases: string[][] = [
            issueArgs().map((a) => (a === "app:deploy" ? "app:everything" : a)),
            issueArgs().map((a) => (a === "30" ? "366" : a)),
            issueArgs().map((a) => (a === "30" ? "0" : a)),
            issueArgs().map((a) => (a === "30" ? "1.5" : a)),
            issueArgs().map((a) => (a === "30" ? "abc" : a)),
            without("--confirm", 1),
            without("--secret-file"),
            without("--expires-in-days"),
            without("--name"),
            issueArgs("--project", "not-a-uuid"),
            [...issueArgs("--project", project), "--scope", "project:create"],
            issueArgs().map((a) => (a === target ? path.join(dir, "taken") : a)),
            issueArgs().map((a) => (a === ORG ? "demo" : a)),
            issueArgs().map((a) => (a === ORG ? "" : a)),
            issueArgs().map((a) => (a === OWNER ? "not-an-email" : a)),
        ];
        // Without --scope at all.
        const noScope = issueArgs();
        noScope.splice(noScope.indexOf("--scope"), 4);
        cases.push(noScope);
        for (const args of cases) {
            const w = await go(args, { respond: () => created() });
            refusedBeforeAnything(w);
        }
        expect(await fs.readFile(path.join(dir, "taken"), "utf8")).toBe("x");
        expect(await exists()).toBe(false);
    });

    it("refuses with LAUNCHPAD_API_KEY set: exit 2, nothing sent, no Authorization", async () => {
        for (const args of [
            issueArgs(),
            ["key", "list", "--org", ORG],
            ["key", "revoke", ID, "--org", ORG, "--confirm"],
        ]) {
            const w = await go(args, { env: { LAUNCHPAD_API_KEY: SECRET } });
            refusedBeforeAnything(w);
        }
        expect(await exists()).toBe(false);
    });

    it("needs --email when no session is saved, and sends nothing", async () => {
        const args = issueArgs();
        args.splice(args.indexOf("--email"), 2);
        refusedBeforeAnything(await go(args));
    });

    describe("after the request was sent", () => {
        const failing = (response: () => Response | Promise<Response>) =>
            go(issueArgs(), { respond: response });
        const MAY = 'The key may exist: run "launchpad key list" and revoke it.';

        it("keeps the secret and says the key exists when the answer cannot be parsed", async () => {
            const w = await failing(() =>
                json({ secret: SECRET, id: "not-a-uuid" }, { status: 201 }),
            );
            expect(w.code).toBe(EXIT.transport);
            expect(await fs.readFile(target, "utf8")).toBe(`${SECRET}\n`);
            expect(w.err.join("\n")).toContain(`secret is in ${target}`);
            expectClean(w, [SECRET]);
        });

        it("removes the file and says the key may exist for 408, 429, 5xx, no secret and a dropped connection", async () => {
            const answers: Array<[string, () => Response | Promise<Response>, number]> = [
                [
                    "408",
                    () => json({ code: "timeout", title: "Timeout" }, { status: 408 }),
                    EXIT.failure,
                ],
                [
                    "429",
                    () =>
                        json(
                            { code: "rate", title: "Slow down" },
                            { status: 429, headers: { "retry-after": "9" } },
                        ),
                    EXIT.failure,
                ],
                ["500", () => json({ code: "x", title: "Broken" }, { status: 500 }), EXIT.failure],
                [
                    "502",
                    () => json({ code: "x", title: "Bad gateway" }, { status: 502 }),
                    EXIT.failure,
                ],
                ["no secret", () => created({ secret: undefined }), EXIT.transport],
                ["not json", () => new Response("<html>", { status: 201 }), EXIT.transport],
                [
                    "dropped",
                    () => {
                        throw new TypeError("fetch failed");
                    },
                    EXIT.transport,
                ],
            ];
            for (const [name, response, code] of answers) {
                const w = await failing(response);
                expect(w.code, name).toBe(code);
                expect(w.err.join("\n"), name).toContain(MAY);
                expect(await exists(), name).toBe(false);
                expect(callLines(w), name).toHaveLength(1);
                expectClean(w, [SECRET]);
                noHandlers(w);
            }
        });

        it("removes the file without that message when the controller refused", async () => {
            for (const [status, title, code] of [
                [400, "Bad", EXIT.failure],
                [403, "Sign in again to do this.", EXIT.unauthorized],
                [404, "Not found", EXIT.notFound],
                [409, "This organization already has 100 active keys.", EXIT.failure],
                [422, "Invalid", EXIT.failure],
            ] as const) {
                const w = await failing(() => json({ code: "x", title }, { status }));
                expect(w.code, String(status)).toBe(code);
                expect(w.err.join("\n")).toContain(title);
                expect(w.text()).not.toContain("may exist");
                expect(await exists()).toBe(false);
                expect(callLines(w)).toHaveLength(1);
            }
        });

        it("does not say the key may exist when sign-in itself failed", async () => {
            const w = await go([...issueArgs()], { answer: "wrong password here" });
            expect(w.code).toBe(EXIT.unauthorized);
            expect(w.text()).not.toContain("may exist");
            expect(callLines(w)).toEqual([]);
            expect(await exists()).toBe(false);
        });

        it("keeps the existing message when the write fails after capture", async () => {
            const w = await go(issueArgs(), {
                respond: () => created(),
                secretFile: (file) => ({
                    write: async () => {
                        throw new Error("disk full");
                    },
                    remove: () => file.remove(),
                }),
            });
            expect(w.code).toBe(EXIT.local);
            expect(w.err.join("\n")).toContain("It exists");
            expectClean(w, [SECRET]);
        });

        it("exits with the signal code and removes the file when interrupted mid-request", async () => {
            const w = await go(issueArgs(), {
                respond: () => new Promise<Response>(() => {}),
                onRequest: (r, world) => {
                    if (r.path.startsWith("/api/v1/")) queueMicrotask(() => world.emit("SIGINT"));
                },
            });
            expect(w.code).toBe(130);
            expect(await exists()).toBe(false);
            expect(w.signedOut).toEqual([OWNER]);
            noHandlers(w);
            expectClean(w, [SECRET]);
        });
    });

    it("warns about a stale saved session and shows the controller's 403 hint, exit 3", async () => {
        await go(["login", "--session", ...auth]);
        const file = path.join(dir, "session.json");
        const stored = JSON.parse(await fs.readFile(file, "utf8"));
        stored.sessions[CONTROLLER].savedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
        await fs.writeFile(file, JSON.stringify(stored), { mode: 0o600 });
        const w = await go(
            [
                "key",
                "issue",
                "--org",
                ORG,
                "--name",
                "ci",
                "--scope",
                "project:read",
                "--expires-in-days",
                "30",
                "--secret-file",
                target,
                "--confirm",
            ],
            {
                respond: () =>
                    json(
                        { code: "forbidden", title: "Sign in again to do this." },
                        { status: 403 },
                    ),
            },
        );
        expect(w.code).toBe(EXIT.unauthorized);
        expect(w.err.join("\n")).toContain("older than 15 minutes");
        expect(w.err.join("\n")).toContain("Sign in again to do this.");
        expect(w.prompts).toEqual([]);
        expect(await exists()).toBe(false);
        expect(w.signedIn).toEqual([]);
    });

    it("shows the 429 wait and does not retry", async () => {
        const w = await go(issueArgs(), {
            respond: () =>
                json(
                    { code: "rate", title: "Too Many Requests" },
                    { status: 429, headers: { "x-retry-after": "12" } },
                ),
        });
        expect(w.code).toBe(EXIT.failure);
        expect(w.err.join("\n")).toContain("12 seconds");
        expect(callLines(w)).toHaveLength(1);
    });
});

describe("key list and revoke against a stateful controller", () => {
    const keys = new Map<string, { revoked: boolean }>();
    const respond = (api: { method: string; path: string }) => {
        const m = /^\/organizations\/([^/]+)\/api-keys(?:\/([^/]+))?$/.exec(api.path);
        if (!m || m[1] !== ORG)
            return json({ code: "not-found", title: "Not found" }, { status: 404 });
        if (api.method === "POST") {
            keys.set(ID, { revoked: false });
            return created();
        }
        if (api.method === "DELETE") {
            keys.get(m[2]!)!.revoked = true;
            return json({ ok: true });
        }
        return json(
            [...keys].map(([id, k]) => ({
                id,
                name: "ci",
                prefix: "lp_sssss",
                scopes: ["project:read", "app:deploy"],
                projectIds: null,
                createdBy: "u1",
                createdAt: when,
                expiresAt: when,
                revokedAt: k.revoked ? when : null,
                lastUsedAt: null,
                status: k.revoked ? "revoked" : "active",
            })),
        );
    };
    beforeEach(() => keys.clear());

    it("issues, lists active, revokes, lists revoked and revokes again with exit 0", async () => {
        await go(["login", "--session", ...auth]);
        const none = await go(["key", "list", "--org", ORG], { respond });
        expect(none.out).toEqual(["No API keys."]);
        const issued = await go(
            issueArgs().filter((a) => a !== "--email" && a !== OWNER),
            { respond },
        );
        expect(issued.code).toBe(EXIT.ok);
        const list = (flags: string[] = []) =>
            go(["key", "list", "--org", ORG, ...flags], { respond });
        const active = await list();
        expect(active.out.join("\n")).toMatch(
            /^ID\s+NAME\s+PREFIX\s+STATUS\s+SCOPES\s+PROJECTS\s+EXPIRES\s+LAST USED/,
        );
        expect(active.out.join("\n")).toMatch(
            new RegExp(
                `${ID}\\s+ci\\s+lp_sssss\\s+active\\s+project:read,app:deploy\\s+all\\s+${when}\\s+never`,
            ),
        );
        for (const again of [0, 1]) {
            const w = await go(["key", "revoke", ID, "--org", ORG, "--confirm"], { respond });
            expect(w.code, String(again)).toBe(EXIT.ok);
            expect(w.out).toEqual([`Revoked key ${ID}.`]);
            expect(callLines(w)).toEqual([`DELETE /api/v1/organizations/${ORG}/api-keys/${ID}`]);
            expect(w.err).toContain(ACTING(OWNER, ORG));
            expect(w.prompts).toEqual([]);
        }
        const revoked = await list(["--json"]);
        expect(JSON.parse(revoked.out.join("\n"))[0].status).toBe("revoked");
        expect(revoked.out.join("\n")).not.toContain("Acting as");
        expectClean(revoked, [SECRET]);
    });

    it("refuses revoke without --confirm or with a bad ID, sending nothing", async () => {
        for (const args of [
            ["key", "revoke", ID, "--org", ORG, ...auth],
            ["key", "revoke", "not-a-uuid", "--org", ORG, "--confirm", ...auth],
            ["key", "revoke", "..", "--org", ORG, "--confirm", ...auth],
        ]) {
            refusedBeforeAnything(await go(args));
        }
    });

    it("another organization's owner gets 404 (exit 4)", async () => {
        const w = await go(["key", "list", "--org", OTHER_ORG, ...auth], { respond });
        expect(w.code).toBe(EXIT.notFound);
        expect(w.err).toContain(ACTING(OWNER, OTHER_ORG));
    });

    it("uses a different --email from the saved session? exits 2 and sends nothing", async () => {
        await go(["login", "--session", ...auth]);
        const before = server.counter;
        const w = await go(["key", "list", "--org", ORG, "--email", OPERATOR], { respond });
        expect(w.code).toBe(EXIT.usage);
        expect(w.requests).toEqual([]);
        expect(server.counter).toBe(before);
    });
});

describe("--org", () => {
    const list = (args: string[], options: Options = {}) =>
        go(["key", "list", ...auth, ...args], { respond: () => json([]), ...options });
    const orgOf = (w: World) => v1(w)[0]!.path.split("/")[4];
    const HINT = "launchpad api --session organizations";

    it("refuses a slug, an empty value or a non-UUID before any sign-in, with the ID hint", async () => {
        for (const value of ["demo", "", "123", `${ORG}x`, "../x"]) {
            const w = await list(["--org", value]);
            refusedBeforeAnything(w);
            expect(w.err.join("\n")).toContain(HINT);
            expect(w.err.join("\n")).toContain("dashboard");
            expect(w.err.join("\n")).not.toContain("org list");
        }
    });

    it("has no organization: exit 2, nothing sent", async () => {
        refusedBeforeAnything(await list([]));
    });

    it("takes --org, then launchpad.json, then LAUNCHPAD_ORG, then the profile", async () => {
        const [A, B, C, D] = [ORG, OTHER_ORG, ID, "55555555-5555-4555-8555-555555555555"];
        await new CredentialStore(dir).update((config) => {
            config.profiles.p = {
                controller: CONTROLLER,
                apiKey: "lp_" + "a".repeat(43),
                organizationId: D,
                savedAt: "now",
            };
            config.currentProfile = "p";
        });
        const profileOnly = await list([], { env: { LAUNCHPAD_CONTROLLER: undefined } });
        expect(orgOf(profileOnly)).toBe(D);
        const env = await list([], { env: { LAUNCHPAD_ORG: C } });
        expect(orgOf(env)).toBe(C);
        await fs.writeFile(
            path.join(dir, "launchpad.json"),
            JSON.stringify({ organization: B, project: "site" }),
        );
        expect(orgOf(await list([], { env: { LAUNCHPAD_ORG: C } }))).toBe(B);
        expect(orgOf(await list(["--org", A], { env: { LAUNCHPAD_ORG: C } }))).toBe(A);
    });

    it("refuses a slug in launchpad.json, LAUNCHPAD_ORG or the profile without a GET /organizations", async () => {
        await fs.writeFile(
            path.join(dir, "launchpad.json"),
            JSON.stringify({ organization: "acme", project: "site" }),
        );
        const fromFile = await list([]);
        refusedBeforeAnything(fromFile);
        expect(fromFile.err.join("\n")).toContain(HINT);
        await fs.rm(path.join(dir, "launchpad.json"));
        refusedBeforeAnything(await list([], { env: { LAUNCHPAD_ORG: "acme" } }));
        await new CredentialStore(dir).update((config) => {
            config.profiles.p = {
                controller: CONTROLLER,
                apiKey: "lp_" + "a".repeat(43),
                organizationId: "acme",
                savedAt: "now",
            };
            config.currentProfile = "p";
        });
        refusedBeforeAnything(await list([], { env: { LAUNCHPAD_CONTROLLER: undefined } }));
    });
});

describe("help", () => {
    it("names the call and the lockout note, without a request", async () => {
        for (const sub of ["list", "issue", "revoke"]) {
            const w = await go(["key", sub, "--help"]);
            expect(w.requests).toEqual([]);
            expect(w.out.join("\n")).toContain("/api-keys");
            expect(w.out.join("\n")).toContain("dashboard sign-in");
        }
        expect(PASSWORD).toBeTruthy();
    });
});
