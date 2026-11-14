import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    ClientCoreError,
    createContext,
    listProjects,
    listProfiles,
    login,
    logout,
    redact,
    resolve,
    useOrganization,
    useProfile,
    whoami,
} from "./index";

const KEY = "lp_" + "a".repeat(43);
const KEY2 = "lp_" + "b".repeat(43);
const ORG = "org-one";
const CONTROLLER = "https://control.example.com";
let dir = "";

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// A controller that knows one key (and accepts either of two).
const controller = ((url: string, init: RequestInit) => {
    const auth = (init.headers as Record<string, string>).authorization;
    if (auth !== `Bearer ${KEY}` && auth !== `Bearer ${KEY2}`) {
        return Promise.resolve(
            json({ code: "unauthenticated", status: 401, title: "Unauthorized" }, 401),
        );
    }
    const path = new URL(url).pathname;
    if (path === "/api/v1/key") {
        return Promise.resolve(
            json({
                id: crypto.randomUUID(),
                name: "ci",
                organizationId: ORG,
                scopes: ["project:read", "organization:read"],
                projectIds: null,
                expiresAt: new Date().toISOString(),
            }),
        );
    }
    if (path === "/api/v1/organizations") {
        return Promise.resolve(json([{ id: ORG, name: "Acme", slug: "acme", role: "admin" }]));
    }
    if (path === `/api/v1/organizations/${ORG}/projects`) {
        return Promise.resolve(
            json([
                {
                    id: crypto.randomUUID(),
                    slug: "site",
                    name: "Site",
                    createdAt: new Date().toISOString(),
                },
            ]),
        );
    }
    return Promise.resolve(json({ code: "not-found", status: 404, title: "Not Found" }, 404));
}) as unknown as typeof fetch;

const ctx = (env: Record<string, string | undefined> = {}) =>
    createContext({ LAUNCHPAD_CONFIG_DIR: dir, ...env }, { fetch: controller });

beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "launchpad-cc-"));
});
afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
});

describe("login and the credential file", () => {
    it("verifies the key, selects its organization and stores it owner-only", async () => {
        const result = await login(ctx(), { controller: `${CONTROLLER}/`, apiKey: KEY });
        expect(result).toMatchObject({ profile: "default", controller: CONTROLLER });
        expect(JSON.stringify(result)).not.toContain(KEY);
        expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
        expect((await fs.stat(path.join(dir, "credentials.json"))).mode & 0o777).toBe(0o600);
        const files = await fs.readdir(dir);
        expect(files).toEqual(["credentials.json"]); // no temp or lock files left behind
        expect(await listProfiles(ctx())).toMatchObject({
            current: "default",
            profiles: [{ name: "default", organizationId: ORG }],
        });
        expect(JSON.stringify(await listProfiles(ctx()))).not.toContain(KEY);
    });

    it("saves nothing when the controller rejects the key or the input is bad", async () => {
        await expect(
            login(ctx(), { controller: CONTROLLER, apiKey: "lp_" + "z".repeat(43) }),
        ).rejects.toMatchObject({ status: 401 });
        await expect(
            login(ctx(), { controller: "http://control.example.com", apiKey: KEY }),
        ).rejects.toThrow();
        await expect(
            login(ctx(), { controller: CONTROLLER, apiKey: KEY, profile: "../x" }),
        ).rejects.toBeInstanceOf(ClientCoreError);
        await expect(fs.readdir(dir)).resolves.toEqual([]);
    });

    it("does not lose changes made by concurrent logins", async () => {
        await Promise.all(
            ["a", "b", "c", "d", "e"].map((name) =>
                login(ctx(), { controller: CONTROLLER, apiKey: KEY, profile: name }),
            ),
        );
        const { profiles } = await listProfiles(ctx());
        expect(profiles.map((p) => p.name).toSorted()).toEqual(["a", "b", "c", "d", "e"]);
    });

    it("refuses a file others can read, a symlink and another format, and never rewrites them", async () => {
        await login(ctx(), { controller: CONTROLLER, apiKey: KEY });
        const file = path.join(dir, "credentials.json");
        await fs.chmod(file, 0o644);
        await expect(whoami(ctx())).rejects.toMatchObject({ code: "insecure-store" });
        await expect(
            login(ctx(), { controller: CONTROLLER, apiKey: KEY2, profile: "x" }),
        ).rejects.toMatchObject({ code: "insecure-store" });
        await fs.chmod(file, 0o600);

        const real = path.join(dir, "real.json");
        await fs.rename(file, real);
        await fs.symlink(real, file);
        await expect(whoami(ctx())).rejects.toMatchObject({ code: "insecure-store" });
        await fs.rm(file);
        await fs.rename(real, file);

        const future = JSON.stringify({ version: 2, profiles: {} });
        await fs.writeFile(file, future, { mode: 0o600 });
        await expect(whoami(ctx())).rejects.toMatchObject({ code: "unsupported-store" });
        await expect(
            login(ctx(), { controller: CONTROLLER, apiKey: KEY, profile: "y" }),
        ).rejects.toMatchObject({ code: "unsupported-store" });
        expect(await fs.readFile(file, "utf8")).toBe(future);

        await fs.writeFile(file, "{not json", { mode: 0o600 });
        await expect(whoami(ctx())).rejects.toMatchObject({ code: "corrupt-store" });
        expect(await fs.readFile(file, "utf8")).toBe("{not json");
    });
});

describe("using credentials", () => {
    it("rejects a half-configured environment instead of falling back to a saved profile", async () => {
        await login(ctx(), { controller: CONTROLLER, apiKey: KEY });
        for (const env of [
            { LAUNCHPAD_CONTROLLER: "https://staging.example.com" },
            { LAUNCHPAD_API_KEY: KEY2 },
        ]) {
            await expect(resolve(ctx(env))).rejects.toMatchObject({ code: "bad-input" });
            expect((await resolve(ctx(env), "default")).profile).toBe("default");
        }
    });

    it("discovers the key's org for environment-only project listing without writing the store", async () => {
        const env = ctx({ LAUNCHPAD_CONTROLLER: CONTROLLER, LAUNCHPAD_API_KEY: KEY });
        expect(await listProjects(env)).toMatchObject([{ slug: "site" }]);
        expect(await fs.readdir(dir)).toEqual([]);
        // An explicit organization ID is not silently replaced.
        await expect(
            listProjects(
                ctx({
                    LAUNCHPAD_CONTROLLER: CONTROLLER,
                    LAUNCHPAD_API_KEY: KEY,
                    LAUNCHPAD_ORG: "another-id",
                }),
            ),
        ).rejects.toMatchObject({ status: 404 });
    });

    it("resolves explicit profile, then environment profile, then the current one", async () => {
        await login(ctx(), { controller: CONTROLLER, apiKey: KEY, profile: "one" });
        await login(ctx(), {
            controller: "https://other.example.com",
            apiKey: KEY2,
            profile: "two",
        });
        expect((await resolve(ctx())).profile).toBe("one");
        expect((await resolve(ctx({ LAUNCHPAD_PROFILE: "two" }))).controller).toBe(
            "https://other.example.com",
        );
        expect((await resolve(ctx({ LAUNCHPAD_PROFILE: "two" }), "one")).profile).toBe("one");
        await useProfile(ctx(), "two");
        expect((await resolve(ctx())).profile).toBe("two");
        await expect(resolve(ctx(), "missing")).rejects.toMatchObject({ code: "not-logged-in" });
    });

    it("works from the environment alone, without touching the store", async () => {
        const env = ctx({
            LAUNCHPAD_CONTROLLER: CONTROLLER,
            LAUNCHPAD_API_KEY: KEY,
            LAUNCHPAD_ORG: ORG,
        });
        expect((await whoami(env)).key.organizationId).toBe(ORG);
        expect(await listProjects(env)).toHaveLength(1);
        expect(await fs.readdir(dir)).toEqual([]);
    });

    it("reports who the key is and lists its projects", async () => {
        await expect(whoami(ctx())).rejects.toMatchObject({ code: "not-logged-in" });
        await login(ctx(), { controller: CONTROLLER, apiKey: KEY });
        expect((await whoami(ctx())).key).toMatchObject({ organizationId: ORG, name: "ci" });
        expect(await listProjects(ctx())).toMatchObject([{ slug: "site" }]);
    });

    it("selects an organization by slug or id, and refuses one the key cannot see", async () => {
        await login(ctx(), { controller: CONTROLLER, apiKey: KEY });
        expect((await useOrganization(ctx(), "acme")).organization.id).toBe(ORG);
        expect((await useOrganization(ctx(), ORG)).organization.slug).toBe("acme");
        await expect(useOrganization(ctx(), "beta")).rejects.toMatchObject({
            code: "no-organization",
        });
    });

    it("logs out one profile and moves the current one", async () => {
        await login(ctx(), { controller: CONTROLLER, apiKey: KEY, profile: "one" });
        await login(ctx(), { controller: CONTROLLER, apiKey: KEY2, profile: "two" });
        await logout(ctx(), "one");
        expect(await listProfiles(ctx())).toMatchObject({ current: "two" });
        await logout(ctx());
        expect(await listProfiles(ctx())).toEqual({ current: null, profiles: [] });
        await expect(logout(ctx())).rejects.toMatchObject({ code: "not-logged-in" });
    });
});

describe("hardening", () => {
    it("does not steal an old lock, even with multiple waiting writers", async () => {
        await login(ctx(), { controller: CONTROLLER, apiKey: KEY });
        const file = path.join(dir, "credentials.json");
        const before = await fs.readFile(file, "utf8");
        const lock = `${file}.lock`;
        await fs.writeFile(lock, "existing-owner", { mode: 0o600 });
        await fs.utimes(lock, new Date(0), new Date(0));
        const results = await Promise.allSettled([
            useProfile(ctx(), "default"),
            login(ctx(), { controller: CONTROLLER, apiKey: KEY2, profile: "second" }),
        ]);
        for (const result of results) {
            expect(result).toMatchObject({
                status: "rejected",
                reason: { code: "store-busy" },
            });
        }
        expect(await fs.readFile(lock, "utf8")).toBe("existing-owner");
        expect(await fs.readFile(file, "utf8")).toBe(before);
    });

    it("cleans up a temporary credential file after failed replacement", async () => {
        await login(ctx(), { controller: CONTROLLER, apiKey: KEY });
        const file = path.join(dir, "credentials.json");
        const before = await fs.readFile(file, "utf8");
        vi.spyOn(fs, "rename").mockRejectedValueOnce(
            Object.assign(new Error("I/O failure"), { code: "EIO" }),
        );
        await expect(
            login(ctx(), { controller: CONTROLLER, apiKey: KEY2, profile: "second" }),
        ).rejects.toMatchObject({ code: "store-unavailable" });
        expect(await fs.readFile(file, "utf8")).toBe(before);
        expect(await fs.readdir(dir)).toEqual(["credentials.json"]);
    });

    it("does not release a lock that no longer has its ownership token", async () => {
        await login(ctx(), { controller: CONTROLLER, apiKey: KEY });
        const lock = path.join(dir, "credentials.json.lock");
        const rename = fs.rename.bind(fs);
        vi.spyOn(fs, "rename").mockImplementationOnce(async (from, to) => {
            // Simulate an external replacement before the writer releases its lock.
            await fs.writeFile(lock, "replacement-owner");
            return rename(from, to);
        });
        await useProfile(ctx(), "default");
        expect(await fs.readFile(lock, "utf8")).toBe("replacement-owner");
    });

    it("treats only saved profiles as profiles, not inherited names", async () => {
        for (const name of ["constructor", "toString", "__proto__"]) {
            await expect(useProfile(ctx(), name), name).rejects.toMatchObject({
                code: "not-logged-in",
            });
            await expect(resolve(ctx(), name), name).rejects.toMatchObject({
                code: "not-logged-in",
            });
            await expect(logout(ctx(), name), name).rejects.toMatchObject({
                code: "not-logged-in",
            });
        }
        await expect(fs.readdir(dir)).resolves.toEqual([]);
    });

    it("rejects a stale organization choice when the profile was replaced meanwhile", async () => {
        await login(ctx(), { controller: CONTROLLER, apiKey: KEY });
        let release!: () => void;
        let started!: () => void;
        const gate = new Promise<void>((resolveGate) => (release = resolveGate));
        const requestStarted = new Promise<void>((resolveStart) => (started = resolveStart));
        const slow = createContext(
            { LAUNCHPAD_CONFIG_DIR: dir },
            {
                fetch: (async (url: string, init: RequestInit) => {
                    started();
                    await gate;
                    return controller(url, init);
                }) as unknown as typeof fetch,
            },
        );
        const choice = useOrganization(slow, "acme");
        // The old credentials have been read and their request is in flight.
        await requestStarted;
        await login(ctx(), { controller: CONTROLLER, apiKey: KEY2 }); // replaces the profile
        release();
        await expect(choice).rejects.toMatchObject({ code: "bad-input" });
        expect((await listProfiles(ctx())).profiles[0]).toMatchObject({ organizationId: ORG });
    });

    it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
        "reports an unreadable file as an unavailable store",
        async () => {
            await login(ctx(), { controller: CONTROLLER, apiKey: KEY });
            const file = path.join(dir, "credentials.json");
            await fs.chmod(file, 0o000);
            await expect(whoami(ctx())).rejects.toMatchObject({ code: "store-unavailable" });
            await expect(
                login(ctx(), { controller: CONTROLLER, apiKey: KEY2, profile: "x" }),
            ).rejects.toMatchObject({ code: "store-unavailable" });
            await fs.chmod(file, 0o600);
        },
    );

    it.skipIf(process.platform === "win32")("refuses a FIFO instead of waiting on it", async () => {
        await promisify(execFile)("mkfifo", [path.join(dir, "credentials.json")]);
        await expect(whoami(ctx())).rejects.toMatchObject({ code: "insecure-store" });
    });

    it("refuses a credential directory that is a link or open to others, and does not use it", async () => {
        const target = await fs.mkdtemp(path.join(os.tmpdir(), "launchpad-target-"));
        const link = path.join(dir, "linked");
        await fs.symlink(target, link);
        const through = createContext({ LAUNCHPAD_CONFIG_DIR: link }, { fetch: controller });
        await expect(login(through, { controller: CONTROLLER, apiKey: KEY })).rejects.toMatchObject(
            { code: "insecure-store" },
        );
        await expect(whoami(through)).rejects.toMatchObject({ code: "insecure-store" });
        expect(await fs.readdir(target)).toEqual([]);
        await fs.rm(target, { recursive: true });

        await login(ctx(), { controller: CONTROLLER, apiKey: KEY });
        await fs.chmod(dir, 0o755);
        await expect(whoami(ctx())).rejects.toMatchObject({ code: "insecure-store" });
        // Writing repairs a directory we own, since nothing is exposed by tightening it.
        await login(ctx(), { controller: CONTROLLER, apiKey: KEY2, profile: "second" });
        expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    });
});

describe("redact", () => {
    it("hides anything shaped like a key", () => {
        expect(redact(`failed with ${KEY} and ${KEY2}`)).toBe(
            "failed with lp_[redacted] and lp_[redacted]",
        );
        expect(redact("nothing here")).toBe("nothing here");
    });
});
