import { promises as fs, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "./errors";
import { type Api, json, makeDir, OWNER, PASSWORD, session, type Options } from "./session-harness";

const SECRET = `lp_${"k".repeat(43)}`;
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
});
