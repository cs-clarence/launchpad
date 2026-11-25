import { promises as fs } from "node:fs";
import path from "node:path";
import { CredentialStore } from "@launchpad-kit/client-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "./errors";
import {
    COOKIE_NAME,
    CONTROLLER,
    json,
    makeDir,
    newServer,
    OWNER,
    OPERATOR,
    PASSWORD,
    USERS,
    session,
    type Options,
    type Server,
    type World,
    trackProcessListeners,
} from "./session-harness";

const KEY = "lp_" + "a".repeat(43);
trackProcessListeners();
let dir = "";
let server: Server;
beforeEach(async () => {
    dir = await makeDir();
    server = newServer();
});
afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
});

const file = () => path.join(dir, "session.json");
const stored = async () => JSON.parse(await fs.readFile(file(), "utf8"));
const entry = async (controller = CONTROLLER) => (await stored()).sessions[controller];
const go = (args: string[], options: Options = {}) => session(args, dir, { server, ...options });
const paths = (w: World) => w.requests.map((r) => r.path);
const keep = (...rest: string[]) => go(["api", "--session", "--keep", "--email", OWNER, ...rest]);
const login = (email = OWNER, options: Options = {}) =>
    go(["login", "--session", "--email", email], options);
const use = (...rest: string[]) => go(["api", "--session", ...rest]);

// A server session made outside the CLI, saved as if kept `ageMs` ago.
async function seed(email: string, ageMs = 0, name = "seed") {
    const pair = `${COOKIE_NAME}=${name}.sig`;
    server.sessions.set(pair, email);
    const { SessionStore } = await import("@launchpad-kit/client-core");
    await new SessionStore(dir).put({
        controller: CONTROLLER,
        email,
        cookie: pair,
        savedAt: new Date(Date.now() - ageMs).toISOString(),
    });
    return pair;
}
function secretsClean(w: World) {
    expect(w.text()).not.toContain(PASSWORD);
    expect(w.text()).not.toContain("secretvalue");
    for (const r of w.requests) expect(Object.keys(r.headers)).not.toContain("authorization");
}

describe("--keep and login --session", () => {
    it("writes session.json only with --keep or login, owner-only, and does not sign out", async () => {
        const plain = await use("--email", OWNER, "key");
        expect(plain.code).toBe(EXIT.ok);
        await expect(fs.stat(file())).rejects.toMatchObject({ code: "ENOENT" });

        const w = await keep("key");
        expect(w.code).toBe(EXIT.ok);
        expect(paths(w)).toEqual(["/api/auth/sign-in/email", "/api/v1/key"]);
        expect(w.signedOut).toEqual([]);
        expect(w.sessions.size).toBe(1);
        expect((await fs.stat(file())).mode & 0o777).toBe(0o600);
        const saved = await entry();
        expect(saved).toMatchObject({ controller: CONTROLLER, email: OWNER });
        expect(saved.cookie).toBe(w.requests[1]!.headers.cookie);
        expect(Date.parse(saved.savedAt)).toBeGreaterThan(Date.now() - 60_000);
        expect(await fs.readdir(dir)).toEqual(["session.json"]);
        secretsClean(w);
        expect(w.text()).not.toContain(saved.cookie);
        for (const set of w.listeners.values()) expect(set.size).toBe(0);
    });

    it("prints the controller and the account email, and calls nothing", async () => {
        const w = await login("Ann@Example.com");
        expect(w.code).toBe(EXIT.ok);
        expect(w.out.join("\n")).toBe(`Signed in to ${CONTROLLER} as ${OWNER}.`);
        expect(paths(w)).toEqual(["/api/auth/sign-in/email"]);
        expect((await entry()).email).toBe(OWNER);
        const json = await go(["login", "--session", "--email", OWNER, "--json"]);
        expect(JSON.parse(json.out.join("\n"))).toEqual({ controller: CONTROLLER, email: OWNER });
        secretsClean(w);
    });

    it("needs credentials even with an entry, signs the old session out and replaces it", async () => {
        const old = await seed(OPERATOR);
        for (const run of [() => login(OWNER), () => keep("key")]) {
            const first = await seed(OPERATOR);
            const w = await run();
            expect(w.code).toBe(EXIT.ok);
            expect(w.prompts).toHaveLength(1);
            expect(paths(w).slice(0, 2)).toEqual(["/api/auth/sign-in/email", "/api/auth/sign-out"]);
            const signOut = w.requests.find((r) => r.path === "/api/auth/sign-out")!;
            expect(signOut.headers.cookie).toBe(first);
            expect(w.signedOut).toEqual([OPERATOR]);
            expect(server.sessions.has(first)).toBe(false);
            expect((await entry()).email).toBe(OWNER);
        }
        void old;
    });

    it("warns, but still replaces the entry, when the old session cannot be signed out", async () => {
        const first = await seed(OPERATOR);
        const w = await login(OWNER, { signOut: () => json({}, { status: 500 }) });
        expect(w.code).toBe(EXIT.ok);
        expect(w.err.join("\n")).toContain("Warning: could not sign the previous session out");
        expect((await entry()).email).toBe(OWNER);
        expect(server.sessions.has(first)).toBe(true);
    });

    it("signs the new session out when it cannot be saved", async () => {
        await seed(OPERATOR);
        await fs.chmod(file(), 0o644);
        const w = await login(OWNER);
        expect(w.code).toBe(EXIT.local);
        expect(paths(w)).toEqual(["/api/auth/sign-in/email", "/api/auth/sign-out"]);
        expect(w.signedOut).toEqual([OWNER]);
    });

    it("keeps nothing when the sign-in fails", async () => {
        const w = await login(OWNER, { answer: "not the password" });
        expect(w.code).toBe(EXIT.unauthorized);
        await expect(fs.stat(file())).rejects.toMatchObject({ code: "ENOENT" });
    });
});

describe("using a kept session", () => {
    it("needs no prompt and no --email, and sends the stored cookie", async () => {
        const cookie = await seed(OWNER);
        const w = await use("key");
        expect(w.code).toBe(EXIT.ok);
        expect(w.prompts).toEqual([]);
        expect(paths(w)).toEqual(["/api/v1/key"]);
        expect(w.requests[0]!.headers.cookie).toBe(cookie);
        expect(w.requests[0]!.headers.origin).toBe(CONTROLLER);
        expect(w.sessions.has(cookie)).toBe(true);
        expect(w.text()).not.toContain(cookie);
        for (const set of w.listeners.values()) expect(set.size).toBe(0);
    });

    it("accepts the same email in any case and ignores a password source", async () => {
        await seed(OWNER);
        const w = await use("--email", "ANN@example.COM", "--password-file", "/missing", "key");
        expect(w.code).toBe(EXIT.ok);
        expect(w.prompts).toEqual([]);
        expect(paths(w)).toEqual(["/api/v1/key"]);
    });

    it("refuses a different --email with nothing sent", async () => {
        await seed(OWNER);
        const w = await use("--email", OPERATOR, "key");
        expect(w.code).toBe(EXIT.usage);
        expect(w.requests).toEqual([]);
        expect(w.err.join("\n")).toContain("logout --session");
    });

    it("ignores an entry for another controller", async () => {
        await seed(OWNER);
        const w = await use("--controller", "https://other.example.com", "key");
        expect(w.code).toBe(EXIT.usage);
        expect(w.err.join("\n")).toContain("--email");
        expect(w.requests).toEqual([]);
    });

    it("deletes the entry on a 401 and says to sign in again", async () => {
        await seed(OWNER);
        server.sessions.clear();
        const w = await use("key");
        expect(w.code).toBe(EXIT.unauthorized);
        expect(w.err.join("\n")).toContain("no longer valid");
        expect(w.err.join("\n")).toContain("launchpad login --session");
        expect((await stored()).sessions).toEqual({});
    });

    it("warns about a session older than 15 minutes only before a key is issued", async () => {
        await seed(OWNER, 20 * 60_000);
        const issue = ["organizations/o1/api-keys", "-X", "POST", "-f", "name=ci", "--confirm"];
        const old = await use(...issue);
        expect(old.err.join("\n")).toContain("older than 15 minutes");
        expect(paths(old)).toEqual(["/api/v1/organizations/o1/api-keys"]);
        const warnedBefore = old.err.findIndex((l) => l.includes("older than 15 minutes"));
        expect(warnedBefore).toBeGreaterThanOrEqual(0);
        const read = await use("organizations/o1/api-keys");
        expect(read.err.join("\n")).not.toContain("older than");
        const other = await use("organizations", "-X", "POST", "-f", "name=x", "--confirm");
        expect(other.err.join("\n")).not.toContain("older than");

        await seed(OWNER, 60_000);
        expect((await use(...issue)).err.join("\n")).not.toContain("older than");
        // A session that is not kept is always new, so it never warns.
        await fs.rm(file());
        const fresh = await use("--email", OWNER, ...issue);
        expect(fresh.err.join("\n")).not.toContain("older than");
    });

    it("never rewrites the stored cookie from a later Set-Cookie", async () => {
        const cookie = await seed(OWNER);
        const before = await fs.readFile(file(), "utf8");
        const again = await go(["api", "--session", "key"], {
            respond: () =>
                new Response("{}", {
                    headers: new Headers([
                        ["content-type", "application/json"],
                        ["set-cookie", `${COOKIE_NAME}=refreshed.sig; Path=/`],
                    ]),
                }),
        });
        expect(again.code).toBe(EXIT.ok);
        expect(await fs.readFile(file(), "utf8")).toBe(before);
        expect(await fs.readFile(file(), "utf8")).toContain(cookie);
        expect(again.text()).not.toContain("refreshed");
    });
});

describe("logout --session", () => {
    it("revokes the session on the controller, then deletes the entry", async () => {
        const cookie = await seed(OWNER);
        const w = await go(["logout", "--session"]);
        expect(w.code).toBe(EXIT.ok);
        expect(paths(w)).toEqual(["/api/auth/sign-out"]);
        expect(w.requests[0]!.headers.cookie).toBe(cookie);
        expect(server.sessions.size).toBe(0);
        expect((await stored()).sessions).toEqual({});
        expect(w.out.join("\n")).toContain(`Signed ${OWNER} out of ${CONTROLLER}`);
        expect(w.text()).not.toContain(cookie);
    });

    it("deletes the entry even if the sign-out fails, but does not claim a revocation", async () => {
        const failures: Array<[string, Options["signOut"]]> = [
            ["500", () => json({}, { status: 500 })],
            [
                "network",
                () => {
                    throw new TypeError("fetch failed");
                },
            ],
        ];
        for (const [name, signOut] of failures) {
            await seed(OWNER);
            const human = await go(["logout", "--session"], { signOut });
            expect(human.code, name).toBe(EXIT.ok);
            expect(human.err.join("\n")).toContain("Warning: could not sign out");
            expect(human.out.join("\n")).toMatch(/did not confirm the sign-out.*may still accept/);
            expect(human.out.join("\n")).not.toContain("Signed ann");
            expect((await stored()).sessions).toEqual({});

            await seed(OWNER);
            const machine = await go(["logout", "--session", "--json"], { signOut });
            expect(JSON.parse(machine.out.join("\n"))).toEqual({
                controller: CONTROLLER,
                email: OWNER,
                signedOut: false,
                localEntryRemoved: true,
            });
            expect((await stored()).sessions).toEqual({});
        }
    });

    it("counts a 401 as already ended, and reports confirmed revocation", async () => {
        await seed(OWNER);
        const ended = await go(["logout", "--session", "--json"], {
            signOut: () => json({}, { status: 401 }),
        });
        expect(JSON.parse(ended.out.join("\n"))).toMatchObject({
            signedOut: true,
            localEntryRemoved: true,
        });
        expect(ended.err).toEqual([]);
        await seed(OWNER);
        const ok = await go(["logout", "--session", "--json"]);
        expect(JSON.parse(ok.out.join("\n"))).toMatchObject({
            signedOut: true,
            localEntryRemoved: true,
        });
        const none = await go(["logout", "--session", "--json"]);
        expect(JSON.parse(none.out.join("\n"))).toEqual({
            controller: CONTROLLER,
            signedOut: false,
            localEntryRemoved: false,
        });
    });

    it("says so and exits 0 with no entry, ignoring --email", async () => {
        const w = await go(["logout", "--session", "--email", OWNER]);
        expect(w.code).toBe(EXIT.ok);
        expect(w.out.join("\n")).toBe(`No saved session for ${CONTROLLER}.`);
        expect(w.requests).toEqual([]);
    });
});

describe("refusals", () => {
    it("refuses login, logout and api --keep with LAUNCHPAD_API_KEY set, sending nothing", async () => {
        await seed(OWNER);
        const before = await fs.readFile(file(), "utf8");
        const env = { LAUNCHPAD_API_KEY: KEY };
        for (const args of [
            ["login", "--session", "--email", OWNER],
            ["logout", "--session"],
            ["api", "--session", "--keep", "--email", OWNER, "key"],
            ["api", "--session", "key"],
        ]) {
            const w = await go(args, { env });
            expect(w.code, args.join(" ")).toBe(EXIT.usage);
            expect(w.requests).toEqual([]);
            expect(w.prompts).toEqual([]);
        }
        expect(await fs.readFile(file(), "utf8")).toBe(before);
    });

    it("rejects --keep without --session, mixing --session with a key, and a missing --email", async () => {
        for (const args of [
            ["api", "--keep", "key"],
            ["login", "--session", "--key-stdin", "--email", OWNER],
            ["login", "--email", OWNER, "--controller", CONTROLLER],
            ["login", "--session"],
            ["logout", "--controller", CONTROLLER],
        ]) {
            const w = await go(args);
            expect(w.code, args.join(" ")).toBe(EXIT.usage);
            expect(w.requests).toEqual([]);
        }
    });

    it("keeps key login unchanged: --controller is still required and the store stays separate", async () => {
        const w = await go(["login"]);
        expect(w.code).toBe(EXIT.usage);
        expect(w.err.join("\n")).toContain("--controller");
        await new CredentialStore(dir).update(() => {});
        await expect(fs.stat(file())).rejects.toMatchObject({ code: "ENOENT" });
        void USERS;
    });
});
