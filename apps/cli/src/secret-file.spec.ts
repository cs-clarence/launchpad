import { promises as fs, statSync } from "node:fs";
import path from "node:path";
import { SessionStore } from "@launchpad-kit/client-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "./errors";
import {
    type Api,
    json,
    makeDir,
    OWNER,
    PASSWORD,
    session,
    type Options,
    type World,
    trackProcessListeners,
    COOKIE_NAME,
    CONTROLLER,
    newServer,
} from "./session-harness";

const SECRET = `lp_${"k".repeat(43)}`;
trackProcessListeners();
let dir = "";
let target = "";
beforeEach(async () => {
    dir = await makeDir();
    target = path.join(dir, "new-key");
});
afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
});

const issue = (...extra: string[]) => [
    "api",
    "--session",
    "--email",
    OWNER,
    "-X",
    "POST",
    "organizations/org-1/api-keys",
    "-f",
    "name=ci",
    "--confirm",
    "--secret-file",
    target,
    ...extra,
];
const created = () => json({ id: "k1", secret: SECRET }, { status: 201 });
const run = (options: Options = {}, ...extra: string[]) =>
    session(issue(...extra), dir, { respond: () => created(), ...options });
const exists = (file = target) =>
    fs.stat(file).then(
        () => true,
        () => false,
    );
const clean = (w: { text(): string }) => {
    expect(w.text()).not.toContain(SECRET);
    expect(w.text()).not.toContain(PASSWORD);
};

describe("--secret-file", () => {
    it("holds the new key, created 0600 before any request, and the screen shows it redacted", async () => {
        const seen: Array<{ mode: number; size: number; path: string }> = [];
        const w = await run({
            onRequest: (request) => {
                const stat = statSync(target);
                seen.push({ mode: stat.mode & 0o777, size: stat.size, path: request.path });
            },
        });
        expect(w.code).toBe(EXIT.ok);
        expect(seen.map((s) => s.path)).toEqual([
            "/api/auth/sign-in/email",
            "/api/v1/organizations/org-1/api-keys",
            "/api/auth/sign-out",
        ]);
        expect(seen.slice(0, 2).every((s) => s.mode === 0o600 && s.size === 0)).toBe(true);
        expect(await fs.readFile(target, "utf8")).toBe(`${SECRET}\n`);
        expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
        expect(w.out.join("\n")).toContain("lp_[redacted]");
        clean(w);
        expect(w.signedOut).toEqual([OWNER]);
    });

    it("sends nothing when the file exists, and leaves it alone", async () => {
        await fs.writeFile(target, "mine", { mode: 0o600 });
        const w = await run();
        expect(w.code).toBe(EXIT.usage);
        expect(w.requests).toEqual([]);
        expect(w.prompts).toEqual([]);
        expect(await fs.readFile(target, "utf8")).toBe("mine");
        const link = path.join(dir, "link");
        await fs.symlink(path.join(dir, "elsewhere"), link);
        const viaLink = await session(
            issue().map((a) => (a === target ? link : a)),
            dir,
        );
        expect(viaLink.code).toBe(EXIT.usage);
        expect(viaLink.requests).toEqual([]);
        await expect(fs.stat(path.join(dir, "elsewhere"))).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("sends nothing when the directory is missing, and refuses --paginate", async () => {
        const w = await session(
            issue().map((a) => (a === target ? path.join(dir, "no/dir") : a)),
            dir,
        );
        expect(w.code).toBe(EXIT.usage);
        expect(w.requests).toEqual([]);
        const paged = await run({}, "--paginate", "-X", "GET");
        expect(paged.code).toBe(EXIT.usage);
        expect(paged.requests).toEqual([]);
        expect(await exists()).toBe(false);
    });

    it("removes the file and signs out when the request fails", async () => {
        const w = await run({
            respond: () =>
                json({ code: "forbidden", status: 403, title: "Forbidden" }, { status: 403 }),
        });
        expect(w.code).toBe(EXIT.unauthorized);
        expect(await exists()).toBe(false);
        expect(w.signedOut).toEqual([OWNER]);
        const down = await run({
            respond: () => {
                throw new TypeError("fetch failed");
            },
        });
        expect(down.code).toBe(EXIT.transport);
        expect(await exists()).toBe(false);
        expect(down.signedOut).toEqual([OWNER]);
    });

    it("removes the file and fails when the answer has no secret", async () => {
        for (const body of [{ id: "k1" }, { id: "k1", secret: "" }, { secret: 5 }]) {
            const w = await run({ respond: (_api: Api) => json(body, { status: 201 }) });
            expect(w.code).toBe(EXIT.failure);
            expect(w.err.join("\n")).toContain("no secret");
            expect(await exists()).toBe(false);
            expect(w.signedOut).toEqual([OWNER]);
        }
        const text = await run({ respond: () => new Response("not json", { status: 201 }) });
        expect(text.code).toBe(EXIT.failure);
        expect(await exists()).toBe(false);
    });

    it("reports a failed write as a created key, never prints it, and still signs out", async () => {
        const w = await run({
            secretFile: (file) => ({
                write: async () => {
                    throw new Error(`disk full ${SECRET}`);
                },
                remove: () => file.remove(),
            }),
        });
        expect(w.code).toBe(EXIT.local);
        expect(w.err.join("\n")).toMatch(/key was created.*revoke it/s);
        expect(w.err.join("\n")).toContain(target);
        clean(w);
        expect(await exists()).toBe(false);
        expect(w.signedOut).toEqual([OWNER]);
    });

    it("keeps the file when a later step such as --jq fails", async () => {
        const w = await run({}, "--jq", ".secret");
        expect(await fs.readFile(target, "utf8")).toBe(`${SECRET}\n`);
        clean(w);
    });

    it("never prints a secret that is not key-shaped, and still saves it", async () => {
        const plain = "plain-secret-value-1234567890";
        const w = await run(
            { respond: () => json({ id: "k1", secret: plain }, { status: 201 }) },
            "--verbose",
            "-i",
        );
        expect(w.code).toBe(EXIT.ok);
        expect(w.text()).not.toContain(plain);
        expect(w.text()).toContain("[redacted]");
        expect(await fs.readFile(target, "utf8")).toBe(`${plain}\n`);
    });
});

describe("--secret-file with a key and signals", () => {
    const KEY = `lp_${"a".repeat(43)}`;
    const keyArgs = [
        "api",
        "-X",
        "POST",
        "organizations/org-1/api-keys",
        "-f",
        "name=ci",
        "--confirm",
        "--secret-file",
    ];
    const withKey = (options: Options = {}) =>
        session([...keyArgs, target], dir, { key: KEY, respond: () => created(), ...options });

    it("works with a key and no session", async () => {
        const w = await withKey();
        expect(w.code).toBe(EXIT.ok);
        expect(w.requests.map((r) => r.path)).toEqual(["/api/v1/organizations/org-1/api-keys"]);
        expect(await fs.readFile(target, "utf8")).toBe(`${SECRET}\n`);
    });

    it("removes the empty file on a signal, so a retry works, and removes its handlers", async () => {
        const installed: number[] = [];
        for (const [signal, code] of [
            ["SIGINT", 130],
            ["SIGTERM", 143],
            ["SIGHUP", 129],
        ] as const) {
            const w = await withKey({
                respond: (_api, world) => {
                    installed.push(world.listeners.get(signal)?.size ?? 0);
                    world.emit(signal);
                    return new Promise<Response>(() => {});
                },
            });
            expect(w.code).toBe(code);
            expect(await exists()).toBe(false);
            for (const set of w.listeners.values()) expect(set.size).toBe(0);
        }
        expect(installed).toEqual([1, 1, 1]);
        expect((await withKey()).code).toBe(EXIT.ok);
    });

    it("keeps a file that already holds the secret", async () => {
        const w = await withKey({
            secretFile: (file) => ({
                write: async (text) => {
                    await file.write(text);
                    w0.emit("SIGTERM");
                },
                remove: () => file.remove(),
            }),
            onRequest: (_r, world) => void (w0 = world),
        });
        expect(w.code).toBe(143);
        expect(await fs.readFile(target, "utf8")).toBe(`${SECRET}\n`);
    });

    it("leaves immediately on a second signal", async () => {
        const w = await withKey({
            respond: (_api, world) => {
                world.emit("SIGINT");
                world.emit("SIGINT");
                return new Promise<Response>(() => {});
            },
        });
        expect(w.exits).toEqual([130]);
        expect(await exists()).toBe(false);
    });
});
let w0: World;

describe("--secret-file with a session and signals", () => {
    it("removes the empty file when a signal arrives during a kept session's request", async () => {
        const server = newServer();
        const pair = `${COOKIE_NAME}=kept.sig`;
        server.sessions.set(pair, OWNER);
        await new SessionStore(dir).put({ controller: CONTROLLER, email: OWNER, cookie: pair });
        const args = issue().filter((_, i) => i !== 2 && i !== 3);
        let installed = 0;
        const w = await session(args, dir, {
            server,
            respond: (_api, world) => {
                installed = world.listeners.get("SIGTERM")?.size ?? 0;
                world.emit("SIGTERM");
                return new Promise<Response>(() => {});
            },
        });
        expect(installed).toBe(1);
        expect(w.code).toBe(143);
        expect(await exists()).toBe(false);
        expect(w.signedOut).toEqual([]);
        expect(server.sessions.has(pair)).toBe(true);
        for (const set of w.listeners.values()) expect(set.size).toBe(0);
    });

    it("removes the empty file when a signal arrives while stdin is still being read", async () => {
        const w = await session(issue("-F", "k=@-"), dir, {
            readData: (_source, world) => {
                world.emit("SIGINT");
                return new Promise<Uint8Array>(() => {});
            },
        });
        expect(w.code).toBe(130);
        expect(w.requests).toEqual([]);
        expect(await exists()).toBe(false);
        for (const set of w.listeners.values()) expect(set.size).toBe(0);
    });

    it("keeps a file that already holds the secret when a signal follows", async () => {
        let world!: World;
        const w = await run({
            onRequest: (_r, current) => void (world = current),
            secretFile: (file) => ({
                write: async (text) => {
                    await file.write(text);
                    world.emit("SIGHUP");
                },
                remove: () => file.remove(),
            }),
        });
        expect(w.code).toBe(129);
        expect(await fs.readFile(target, "utf8")).toBe(`${SECRET}\n`);
        expect(w.signedOut).toEqual([OWNER]);
    });
});
