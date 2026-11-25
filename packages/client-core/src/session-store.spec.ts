import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    CredentialStore,
    listProfiles,
    login,
    resolve,
    SessionStore,
    createContext,
} from "./index";

const run = promisify(execFile);
const KEY = "lp_" + "a".repeat(43);
const COOKIE = "better-auth.session_token=abc.def";
let dir = "";
let store: SessionStore;
let file = "";

beforeEach(async () => {
    dir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "lp-sess-")), "cfg");
    store = new SessionStore(dir);
    file = path.join(dir, "session.json");
});
afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(path.dirname(dir), { recursive: true, force: true });
});

const put = (controller = "https://x.example.com", email = "ann@example.com", cookie = COOKIE) =>
    store.put({ controller, email, cookie });

describe("session store", () => {
    it("creates an owner-only file in an owner-only directory and leaves no lock behind", async () => {
        expect(await store.get("https://x.example.com")).toBeNull();
        await expect(fs.stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
        await put();
        expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
        expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
        expect(await fs.readdir(dir)).toEqual(["session.json"]);
        const saved = JSON.parse(await fs.readFile(file, "utf8"));
        expect(saved.version).toBe(1);
        expect(saved.sessions["https://x.example.com"]).toMatchObject({
            controller: "https://x.example.com",
            email: "ann@example.com",
            cookie: COOKIE,
        });
    });

    it("keys controllers by their normalized URL and emails by trim and lower case", async () => {
        await put("https://x.example.com/", "  Ann@Example.COM ");
        expect((await store.get("https://x.example.com"))?.email).toBe("ann@example.com");
        expect((await store.get("https://x.example.com/"))?.controller).toBe(
            "https://x.example.com",
        );
        const replaced = await put("https://x.example.com", "bob@example.com", "b=1");
        expect(replaced?.email).toBe("ann@example.com");
        expect(Object.keys((await store.load()).sessions)).toEqual(["https://x.example.com"]);
        await expect(store.get("http://example.com")).rejects.toThrow(/https/);
        expect(await store.get("https://x.example.com/launchpad")).toBeNull();
    });

    it("removes an entry, only if it still holds the given cookie when one is named", async () => {
        await put();
        expect(await store.remove("https://x.example.com", "other=1")).toBeNull();
        expect(await store.get("https://x.example.com")).not.toBeNull();
        expect((await store.remove("https://x.example.com/", COOKIE))?.cookie).toBe(COOKIE);
        expect(await store.remove("https://x.example.com")).toBeNull();
    });

    it("does not lose concurrent writers", async () => {
        await Promise.all(Array.from({ length: 8 }, (_, i) => put(`https://c${i}.example.com`)));
        expect(Object.keys((await store.load()).sessions)).toHaveLength(8);
    });

    it("refuses a file others can read, a link, a FIFO, a link directory and a foreign owner", async () => {
        await put();
        await fs.chmod(file, 0o644);
        await expect(store.get("https://x.example.com")).rejects.toMatchObject({
            code: "insecure-store",
        });
        await expect(put("https://y.example.com")).rejects.toMatchObject({
            code: "insecure-store",
        });
        await fs.chmod(file, 0o600);

        const real = path.join(dir, "real.json");
        await fs.rename(file, real);
        await fs.symlink(real, file);
        await expect(store.load()).rejects.toMatchObject({ code: "insecure-store" });
        await fs.rm(file);
        await run("mkfifo", [file]);
        await expect(store.load()).rejects.toMatchObject({ code: "insecure-store" });
        await fs.rm(file);
        await fs.rename(real, file);

        const getuid = process.getuid!;
        vi.spyOn(process, "getuid").mockReturnValue(getuid.call(process) + 1);
        await expect(store.load()).rejects.toMatchObject({ code: "insecure-store" });
        vi.restoreAllMocks();

        const linked = path.join(path.dirname(dir), "linked");
        await fs.symlink(dir, linked);
        await expect(new SessionStore(linked).load()).rejects.toMatchObject({
            code: "insecure-store",
        });
        await fs.chmod(dir, 0o755);
        await expect(store.load()).rejects.toMatchObject({ code: "insecure-store" });
    });

    it("refuses an unknown version, bad JSON and entries that disagree with their key, without rewriting", async () => {
        await fs.mkdir(dir, { mode: 0o700 });
        for (const [text, code] of [
            [JSON.stringify({ version: 2, sessions: {} }), "unsupported-store"],
            ["{nope", "corrupt-store"],
            [
                JSON.stringify({
                    version: 1,
                    sessions: {
                        "https://x.example.com/": {
                            controller: "https://x.example.com/",
                            email: "a@b.c",
                            cookie: "a=b",
                            savedAt: "now",
                        },
                    },
                }),
                "corrupt-store",
            ],
        ] as const) {
            await fs.writeFile(file, text, { mode: 0o600 });
            await expect(store.load()).rejects.toMatchObject({ code });
            await expect(put()).rejects.toMatchObject({ code });
            expect(await fs.readFile(file, "utf8")).toBe(text);
        }
    });

    it("is busy, not stolen, when a lock exists", async () => {
        await put();
        await fs.writeFile(`${file}.lock`, "someone", { mode: 0o600 });
        await expect(put("https://y.example.com")).rejects.toMatchObject({ code: "store-busy" });
        expect(await fs.readFile(`${file}.lock`, "utf8")).toBe("someone");
    });
});

describe("separation from credentials.json", () => {
    it("never touches credentials.json, and key readers never open session.json", async () => {
        const ctx = (env: Record<string, string> = {}) =>
            createContext(
                { LAUNCHPAD_CONFIG_DIR: dir, ...env },
                {
                    fetch: (async () =>
                        new Response(
                            JSON.stringify({
                                id: crypto.randomUUID(),
                                name: "ci",
                                organizationId: "org",
                                scopes: [],
                                projectIds: null,
                                expiresAt: new Date().toISOString(),
                            }),
                            { headers: { "content-type": "application/json" } },
                        )) as unknown as typeof fetch,
                },
            );
        await login(ctx(), { controller: "https://x.example.com", apiKey: KEY });
        const credentials = path.join(dir, "credentials.json");
        const before = await fs.readFile(credentials, "utf8");
        expect(JSON.parse(before).version).toBe(1);

        await put();
        expect(await fs.readFile(credentials, "utf8")).toBe(before);
        await new CredentialStore(dir).update(() => {});
        expect(await fs.readFile(file, "utf8")).toContain(COOKIE);

        // An unusable session file does not affect the key-only readers.
        await fs.chmod(file, 0o644);
        const opened = vi.spyOn(fs, "open");
        expect((await resolve(ctx())).apiKey).toBe(KEY);
        await listProfiles(ctx());
        await login(ctx(), { controller: "https://x.example.com", apiKey: KEY, profile: "two" });
        expect(opened.mock.calls.some(([target]) => String(target).includes("session.json"))).toBe(
            false,
        );
    });
});
