import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    symlinkSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createContext, whoami } from "../packages/client-core/src/index";
import {
    adminArgs,
    checkController,
    ensureOutDirectory,
    classifyAdmin,
    DEFAULT_CONTROLLER,
    HELP,
    main,
    parseArgs,
    KEY_SCOPES,
    resolvePath,
    scrub,
    seed,
    SeedError,
    SWITCH_FLAGS,
    VALUE_FLAGS,
    type Deps,
    type Options,
    type RunResult,
} from "./local-seed";

const BASE = "http://127.0.0.1:5173";
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
    });

// An in-memory controller and operator command line: just enough of both for the script.
class Fake {
    users = new Map<string, { password: string; role: "operator" | "user" }>();
    orgs: { id: string; slug: string; owner: string }[] = [];
    projects: { id: string; slug: string; org: string }[] = [];
    keys = new Map<string, string>();
    calls: string[] = [];
    adminCalls: string[][] = [];
    adminFailure: RunResult | null = null;
    trustedOrigin = BASE;
    up = true;
    transcript: string[] = [];
    failKeyLogin = false;
    keyBodies: { scopes: string[] }[] = [];
    onKeyIssue: (() => void) | null = null;
    keyStatus = 201;
    projectStatus = 201;
    private seq = 0;

    run = async (args: string[]): Promise<RunResult> => {
        this.adminCalls.push(args);
        this.transcript.push(args.join(" "));
        if (this.adminFailure) return this.adminFailure;
        const command = args.find((a) => a.startsWith("command="))!.slice("command=".length);
        if (command === "migrate") return { code: 0, output: "Database is up to date." };
        const options = (args.find((a) => a.startsWith("options=")) ?? "").slice(8).split(" ");
        const email = options[options.indexOf("--email") + 1]!.toLowerCase();
        const password = readFileSync(options[options.indexOf("--password-file") + 1]!, "utf8");
        if (command === "setup" && [...this.users.values()].some((u) => u.role === "operator")) {
            return { code: 1, output: "An operator already exists; use the recovery command." };
        }
        if (this.users.has(email)) {
            return { code: 1, output: "A user with that email already exists." };
        }
        this.users.set(email, { password, role: command === "setup" ? "operator" : "user" });
        return { code: 0, output: `Created ${email}.` };
    };

    fetch = (async (input: string, init: RequestInit = {}) => {
        const url = new URL(input);
        const method = init.method ?? "GET";
        this.calls.push(`${method} ${url.pathname}`);
        if (!this.up) throw new TypeError("connection refused");
        const headers = new Headers(init.headers);
        if (url.pathname === "/api/health") return json({ name: "launchpad" });
        if (url.pathname === "/api/auth/sign-in/email") {
            if (headers.get("origin") !== this.trustedOrigin) return json({}, 403);
            const body = JSON.parse(init.body as string);
            const user = this.users.get(body.email.toLowerCase());
            if (!user || user.password !== body.password) return json({}, 401);
            return json({}, 200, { "set-cookie": `session=${body.email.toLowerCase()}; Path=/` });
        }
        if (url.pathname === "/api/v1/key") {
            const secret = /^Bearer (.+)$/.exec(headers.get("authorization") ?? "")?.[1];
            const org = secret ? this.keys.get(secret) : undefined;
            if (!org || this.failKeyLogin) return json({ code: "unauthenticated" }, 401);
            return json({
                id: crypto.randomUUID(),
                name: "local-quickstart",
                organizationId: org,
                scopes: ["organization:read"],
                projectIds: null,
                expiresAt: new Date().toISOString(),
            });
        }
        const user = /^session=(.+)$/.exec(headers.get("cookie") ?? "")?.[1];
        if (!user) return json({}, 401);
        if (headers.get("origin") !== this.trustedOrigin) return json({}, 403);
        const parts = url.pathname.replace("/api/v1", "").split("/").filter(Boolean);
        const body = init.body ? JSON.parse(init.body as string) : {};
        if (parts[0] === "organizations" && parts.length === 1) {
            if (method === "GET") {
                return json(this.orgs.filter((o) => o.owner === user));
            }
            if (this.users.get(user)?.role !== "operator") return json({}, 403);
            if (this.orgs.some((o) => o.slug === body.slug)) return json({}, 409);
            const org = { id: `org-${++this.seq}`, slug: body.slug, owner: body.ownerEmail };
            this.orgs.push(org);
            return json({ id: org.id, name: body.name, slug: body.slug }, 201);
        }
        const org = parts[1]!;
        if (parts[2] === "projects") {
            if (method === "GET") return json(this.projects.filter((p) => p.org === org));
            if (this.projectStatus !== 201) return json({}, this.projectStatus);
            const project = { id: `proj-${++this.seq}`, slug: body.slug, org };
            this.projects.push(project);
            return json({ id: project.id, slug: body.slug, name: body.name }, 201);
        }
        if (parts[2] === "api-keys") {
            this.keyBodies.push(body);
            this.onKeyIssue?.();
            if (this.keyStatus !== 201) return json({}, this.keyStatus);
            const secret = `lp_${"k".repeat(20)}${++this.seq}`;
            this.keys.set(secret, org);
            return json({ id: crypto.randomUUID(), secret }, 201);
        }
        return json({}, 404);
    }) as unknown as typeof fetch;
}

let dir: string;
let fake: Fake;
let logs: string[];
beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "local-seed-"));
    fake = new Fake();
    logs = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const deps = (): Deps => ({
    fetch: fake.fetch,
    run: fake.run,
    env: { HOME: dir },
    log: (line) => logs.push(line),
});
const options = (extra: string[] = []): Options =>
    parseArgs(["--out", path.join(dir, "cfg"), ...extra]);
const everything = () => [...logs, ...fake.transcript, ...fake.adminCalls.flat()].join("\n");
const secretsOnDisk = () => {
    const found: string[] = [];
    for (const name of ["local-operator.password", "local-owner.password"]) {
        const file = path.join(dir, "cfg", name);
        if (existsSync(file)) found.push(readFileSync(file, "utf8"));
    }
    return found;
};

describe("arguments", () => {
    it("has defaults that need no flags", () => {
        const o = parseArgs([]);
        expect(o.controller).toBe(DEFAULT_CONTROLLER);
        expect(o.origin).toBe(DEFAULT_CONTROLLER);
        expect([o.org, o.project, o.profile]).toEqual(["local", "demo", "local"]);
    });

    it("rejects what it does not know or cannot use", () => {
        for (const bad of [
            ["--nope"],
            ["--org"],
            ["--org", "--project"],
            ["--org", "Not A Slug"],
            ["--owner-email", "nobody"],
            ["--operator-email", "a@b.test", "--owner-email", "A@B.test"],
            ["--profile", "has space"],
            ["--out", "/tmp/a b"],
            ["--operator-password-file", "/tmp/x;rm"],
        ]) {
            expect(() => parseArgs(bad), bad.join(" ")).toThrow(SeedError);
        }
    });

    it("takes no password or key as an option", () => {
        for (const flag of [...VALUE_FLAGS, ...SWITCH_FLAGS]) {
            expect(flag).not.toMatch(/^--(password|api-key|key)$/);
        }
        expect(() => parseArgs(["--password", "x"])).toThrow(SeedError);
        expect(() => parseArgs(["--api-key", "x"])).toThrow(SeedError);
    });

    it("lists every flag in --help", () => {
        for (const flag of [...VALUE_FLAGS, ...SWITCH_FLAGS]) expect(HELP).toContain(flag);
    });
});

describe("controller address", () => {
    it("accepts loopback over http and any https origin only with --allow-remote", () => {
        expect(checkController("http://127.0.0.1:5173", false)).toBe(BASE);
        expect(checkController("http://localhost:3000/", false)).toBe("http://localhost:3000");
        expect(checkController("http://[::1]:3000", false)).toBe("http://[::1]:3000");
        expect(() => checkController("https://control.example.com", false)).toThrow(
            /--allow-remote/,
        );
        expect(checkController("https://control.example.com", true)).toBe(
            "https://control.example.com",
        );
    });

    it("never allows http off this machine, nor a path or credentials", () => {
        expect(() => checkController("http://control.example.com", true)).toThrow(/https/);
        expect(() => checkController("http://localhost.example.com", true)).toThrow(/https/);
        for (const bad of ["ftp://127.0.0.1", "http://u:p@127.0.0.1", "http://127.0.0.1/x", "x"]) {
            expect(() => checkController(bad, true), bad).toThrow(SeedError);
        }
    });
});

describe("admin command line", () => {
    it("runs through Omni with no shell and no secret", () => {
        expect(adminArgs("setup", ["--email", "a@b.test", "--password-file", "/x/p"])).toEqual([
            "omni",
            "-i",
            "run",
            "admin",
            "-p",
            "@launchpad-kit/controller",
            "-a",
            "command=setup",
            "-a",
            "options=--email a@b.test --password-file /x/p",
        ]);
    });

    it("tells an existing account from a failure, and never echoes child output", () => {
        const failed = (output: string) => ({ code: 1, output });
        expect(classifyAdmin("setup", { code: 0, output: "" })).toBe("done");
        expect(classifyAdmin("setup", failed("An operator already exists"))).toBe("exists");
        expect(classifyAdmin("create-user", failed("A user with that email already exists."))).toBe(
            "exists",
        );
        expect(() => classifyAdmin("migrate", failed("relation already exists"))).toThrow(
            /migrate failed/,
        );
        expect(() => classifyAdmin("migrate", failed("DATABASE_URL is required."))).toThrow(
            /DATABASE_URL is not set/,
        );
        expect(() =>
            classifyAdmin("migrate", failed("connect ECONNREFUSED postgres://u:hunter2@h/db")),
        ).toThrow(/PostgreSQL is running/);
        try {
            classifyAdmin("migrate", failed("boom postgres://u:hunter2@h/db"));
        } catch (error) {
            expect((error as Error).message).not.toContain("hunter2");
        }
    });
});

describe("the worked example", () => {
    it("sets up a fresh controller and saves a working profile", async () => {
        const summary = await seed(deps(), options());
        expect(summary).toMatchObject({
            organization: "local",
            project: "demo",
            profile: "local",
            keyIssued: true,
        });
        expect(fake.orgs).toHaveLength(1);
        expect(fake.projects).toHaveLength(1);
        expect(fake.keys.size).toBe(1);
        expect(fake.adminCalls.map((c) => c[7])).toEqual([
            "command=migrate",
            "command=setup",
            "command=create-user",
        ]);

        // The same profile `launchpad login` would write works against the controller.
        const ctx = createContext(
            { LAUNCHPAD_CONFIG_DIR: path.join(dir, "cfg") },
            { fetch: fake.fetch },
        );
        const me = await whoami(ctx);
        expect(me.profile).toBe("local");
        expect(me.controller).toBe(BASE);
        expect(me.key.organizationId).toBe(fake.orgs[0]!.id);
    });

    it("writes password and credential files readable only by the owner", async () => {
        await seed(deps(), options());
        for (const name of [
            "local-operator.password",
            "local-owner.password",
            "credentials.json",
        ]) {
            const file = path.join(dir, "cfg", name);
            expect(statSync(file).mode & 0o777, name).toBe(0o600);
        }
        expect(existsSync(path.join(dir, "cfg", "local-api-key.local.pending"))).toBe(false);
    });

    it("prints and passes no password or key", async () => {
        await seed(deps(), options());
        const secrets = [
            ...secretsOnDisk(),
            ...fake.keys.keys(),
            JSON.parse(readFileSync(path.join(dir, "cfg", "credentials.json"), "utf8")).profiles
                .local.apiKey,
        ];
        expect(secrets.length).toBeGreaterThanOrEqual(3);
        for (const secret of secrets) {
            expect(secret.length).toBeGreaterThan(15);
            expect(everything()).not.toContain(secret);
        }
        expect(everything()).toContain("local-owner.password");
    });

    it("sends the controller's own origin on every session request", async () => {
        await seed(deps(), options());
        expect(fake.calls.filter((c) => c.startsWith("POST /api/auth"))).toHaveLength(4);
    });
});

describe("re-running", () => {
    it("changes nothing and issues no second key", async () => {
        await seed(deps(), options());
        const before = fake.calls.length;
        const again = await seed(deps(), options());
        expect(again.keyIssued).toBe(false);
        expect(again.passwordFiles).toEqual([]);
        expect(fake.orgs).toHaveLength(1);
        expect(fake.projects).toHaveLength(1);
        expect(fake.keys.size).toBe(1);
        expect(fake.users.size).toBe(2);
        expect(fake.calls.slice(before).some((c) => c.startsWith("POST /api/v1"))).toBe(false);
    });

    it("issues another key only with --new-key", async () => {
        await seed(deps(), options());
        const again = await seed(deps(), options(["--new-key"]));
        expect(again.keyIssued).toBe(true);
        expect(fake.keys.size).toBe(2);
        expect(fake.orgs).toHaveLength(1);
    });

    it("reuses an existing organization without the operator password", async () => {
        await seed(deps(), options());
        rmSync(path.join(dir, "cfg", "local-operator.password"));
        const again = await seed(deps(), options());
        expect(again.keyIssued).toBe(false);
        expect(fake.orgs).toHaveLength(1);
    });

    it("reseeds a dropped database with the passwords it already wrote", async () => {
        await seed(deps(), options());
        const owner = readFileSync(path.join(dir, "cfg", "local-owner.password"), "utf8");
        fake.users.clear();
        fake.orgs = [];
        fake.projects = [];
        await seed(deps(), options(["--force"]));
        expect(fake.users.get("owner@launchpad.local")?.password).toBe(owner);
    });
});

describe("failures give one clear message", () => {
    const message = async (run: () => Promise<unknown>) => {
        try {
            await run();
        } catch (error) {
            expect(error).toBeInstanceOf(SeedError);
            return (error as Error).message;
        }
        throw new Error("did not fail");
    };

    it("controller not up", async () => {
        fake.up = false;
        expect(await message(() => seed(deps(), options()))).toMatch(
            /Cannot reach the controller at http:\/\/127\.0\.0\.1:5173.*omni -i run dev/,
        );
        expect(fake.adminCalls).toHaveLength(0);
    });

    it("wrong origin", async () => {
        fake.trustedOrigin = "https://control.example.com";
        const text = await message(() => seed(deps(), options()));
        expect(text).toMatch(/LAUNCHPAD_BASE_URL/);
        expect(text).toMatch(/--origin/);
    });

    it("migrations that fail", async () => {
        fake.adminFailure = { code: 1, output: "boom" };
        expect(await message(() => seed(deps(), options()))).toMatch(/migrate failed \(exit 1\)/);
        expect(fake.users.size).toBe(0);
    });

    it("a wrong operator password", async () => {
        await seed(deps(), options());
        fake.orgs = [];
        writeFileSync(path.join(dir, "cfg", "local-operator.password"), "x".repeat(20), {
            mode: 0o600,
        });
        expect(await message(() => seed(deps(), options()))).toMatch(
            /rejected the operator sign-in for operator@launchpad.local/,
        );
    });

    it("an existing owner whose password file is missing", async () => {
        fake.users.set("owner@launchpad.local", { password: "p".repeat(20), role: "user" });
        expect(await message(() => seed(deps(), options()))).toMatch(
            /owner owner@launchpad.local already exists.*password file/,
        );
        expect(secretsOnDisk().length).toBeLessThanOrEqual(1);
        expect(existsSync(path.join(dir, "cfg", "local-owner.password"))).toBe(false);
    });

    it("an existing operator without a password file only matters when it is needed", async () => {
        fake.users.set("someone@else.test", { password: "p".repeat(20), role: "operator" });
        expect(await message(() => seed(deps(), options()))).toMatch(
            /operator already exists.*Creating the organization needs it/,
        );
    });

    it("an organization slug held by another owner", async () => {
        fake.orgs.push({ id: "org-x", slug: "local", owner: "someone@else.test" });
        expect(await message(() => seed(deps(), options()))).toMatch(/slug is already taken/);
    });

    it("a password file open to other users", async () => {
        await seed(deps(), options());
        const file = path.join(dir, "cfg", "local-owner.password");
        await Bun.$`chmod 644 ${file}`.quiet();
        expect(await message(() => seed(deps(), options()))).toMatch(/chmod 600/);
    });

    it("a profile that is not ours, unless --force", async () => {
        await seed(deps(), options());
        fake.keys.clear();
        expect(await message(() => seed(deps(), options()))).toMatch(/--force/);
        const forced = await seed(deps(), options(["--force"]));
        expect(forced.keyIssued).toBe(true);
    });

    it("keeps the key when saving the profile fails, and still prints no secret", async () => {
        fake.failKeyLogin = true;
        const text = await message(() => seed(deps(), options()));
        expect(text).toMatch(/could not be saved/);
        const pending = path.join(dir, "cfg", "local-api-key.local.pending");
        expect(text).toContain(pending);
        const key = readFileSync(pending, "utf8");
        expect(statSync(pending).mode & 0o777).toBe(0o600);
        expect(text).not.toContain(key);
        expect(await message(() => seed(deps(), options()))).toMatch(/interrupted run/);
    });

    it("refuses a remote controller before doing anything", async () => {
        expect(
            await message(() => seed(deps(), options(["--controller", "https://x.example.com"]))),
        ).toMatch(/--allow-remote/);
        expect(fake.calls).toHaveLength(0);
        expect(fake.adminCalls).toHaveLength(0);
    });
});

describe("secrets in messages", () => {
    it("scrubs a known secret from any message", () => {
        expect(scrub("failed with hunter2 inside", ["hunter2"])).toBe(
            "failed with [redacted] inside",
        );
        expect(scrub("nothing", [""])).toBe("nothing");
    });

    it("prints --help without touching anything", async () => {
        const lines: string[] = [];
        const original = console.log;
        console.log = (line: string) => void lines.push(line);
        try {
            expect(await main(["--help"])).toBe(0);
        } finally {
            console.log = original;
        }
        expect(lines.join("\n")).toContain("--allow-remote");
    });
});

const adminPasswordFiles = () =>
    fake.adminCalls
        .map((args) => args.find((a) => a.startsWith("options=")))
        .filter((o): o is string => o !== undefined)
        .map((o) => o.split(" ")[o.split(" ").indexOf("--password-file") + 1]!);

describe("paths", () => {
    const failure = async (run: () => Promise<unknown>) => {
        try {
            await run();
        } catch (error) {
            expect(error).toBeInstanceOf(SeedError);
            return (error as Error).message;
        }
        throw new Error("did not fail");
    };

    it("resolves a relative --out to one absolute path shared with admin", async () => {
        const rel = path.relative(process.cwd(), path.join(dir, "rel"));
        expect(path.isAbsolute(rel)).toBe(false);
        await seed(deps(), parseArgs(["--out", rel]));
        const used = adminPasswordFiles();
        expect(used).toHaveLength(2);
        for (const file of used) {
            expect(path.isAbsolute(file)).toBe(true);
            expect(path.dirname(file)).toBe(path.join(dir, "rel"));
            expect(existsSync(file)).toBe(true);
        }
    });

    it("expands ~ itself instead of leaving it to the shell", async () => {
        expect(resolvePath("~/cfg", "/home/u")).toBe("/home/u/cfg");
        await seed(deps(), parseArgs(["--out", "~/cfg2"]));
        for (const file of adminPasswordFiles()) {
            expect(file.startsWith(path.join(dir, "cfg2"))).toBe(true);
            expect(existsSync(file)).toBe(true);
        }
        expect(fake.adminCalls.flat().join(" ")).not.toContain("~");
    });

    it("refuses a default directory that a shell would split", async () => {
        const spaced = { ...deps(), env: { XDG_CONFIG_HOME: path.join(dir, "a b") } };
        expect(await failure(() => seed(spaced, parseArgs([])))).toMatch(/spaces or quotes/);
        const viaEnv = { ...deps(), env: { LAUNCHPAD_CONFIG_DIR: path.join(dir, "x y") } };
        expect(await failure(() => seed(viaEnv, parseArgs([])))).toMatch(/spaces or quotes/);
        expect(fake.adminCalls).toHaveLength(0);
    });

    it("honors LAUNCHPAD_CONFIG_DIR for the default directory", async () => {
        const env = { HOME: dir, LAUNCHPAD_CONFIG_DIR: path.join(dir, "viaenv") };
        await seed({ ...deps(), env }, parseArgs([]));
        expect(adminPasswordFiles()[0]!.startsWith(path.join(dir, "viaenv"))).toBe(true);
    });

    it("rejects an output directory that is a link or open to others", async () => {
        mkdirSync(path.join(dir, "real"), { mode: 0o700 });
        symlinkSync(path.join(dir, "real"), path.join(dir, "link"));
        expect(
            await failure(() => seed(deps(), parseArgs(["--out", path.join(dir, "link")]))),
        ).toMatch(/not a link/);
        mkdirSync(path.join(dir, "open"));
        chmodSync(path.join(dir, "open"), 0o777);
        expect(
            await failure(() => seed(deps(), parseArgs(["--out", path.join(dir, "open")]))),
        ).toMatch(/chmod 700/);
        expect(fake.adminCalls).toHaveLength(0);
    });

    it("creates a missing output directory mode 700", async () => {
        await seed(deps(), options());
        expect(statSync(path.join(dir, "cfg")).mode & 0o777).toBe(0o700);
    });
});

describe("the key", () => {
    const failure = async (run: () => Promise<unknown>) => {
        try {
            await run();
        } catch (error) {
            return (error as Error).message;
        }
        throw new Error("did not fail");
    };

    it("asks only for the scopes the guide uses", async () => {
        await seed(deps(), options());
        expect(fake.keyBodies[0]!.scopes).toEqual(KEY_SCOPES);
        for (const wide of ["app:delete", "project:delete", "app:deploy", "app:promote"]) {
            expect(KEY_SCOPES).not.toContain(wide);
        }
    });

    it("leaves no pending file when issuing fails", async () => {
        fake.keyStatus = 500;
        expect(await failure(() => seed(deps(), options()))).toMatch(/Issuing the API key failed/);
        expect(existsSync(path.join(dir, "cfg", "local-api-key.local.pending"))).toBe(false);
    });

    it("says a key was issued when it cannot be stored, naming it", async () => {
        const pending = path.join(dir, "cfg", "local-api-key.local.pending");
        fake.onKeyIssue = () => {
            rmSync(pending);
            mkdirSync(pending);
        };
        const text = await failure(() => seed(deps(), options()));
        expect(text).toMatch(/key named "local-quickstart" was issued but could not be stored/);
        expect(text).toMatch(/Revoke it in the dashboard/);
        expect(text).not.toContain([...fake.keys.keys()][0]!);
    });

    it.skipIf(process.getuid?.() === 0)(
        "issues no key when the file cannot be created",
        async () => {
            await seed(deps(), options());
            const keys = fake.keys.size;
            chmodSync(path.join(dir, "cfg"), 0o500);
            try {
                expect(await failure(() => seed(deps(), options(["--new-key"])))).toMatch(
                    /no key was issued/,
                );
            } finally {
                chmodSync(path.join(dir, "cfg"), 0o700);
            }
            expect(fake.keys.size).toBe(keys);
        },
    );

    it("does not call an unrelated timeout a database failure", () => {
        expect(() => classifyAdmin("migrate", { code: 1, output: "request timeout" })).toThrow(
            /migrate failed \(exit 1\)/,
        );
        expect(() =>
            classifyAdmin("migrate", { code: 1, output: 'database "x" does not exist' }),
        ).toThrow(/PostgreSQL is running/);
    });
});

describe("review fixes", () => {
    const failure = async (run: () => Promise<unknown>) => {
        try {
            await run();
        } catch (error) {
            return (error as Error).message;
        }
        throw new Error("did not fail");
    };

    it("calls a 409 a taken slug only for the organization and project", async () => {
        fake.projectStatus = 409;
        expect(await failure(() => seed(deps(), options()))).toMatch(/slug is already taken/);
        fake.projectStatus = 201;
        fake.keyStatus = 409;
        const text = await failure(() => seed(deps(), options()));
        expect(text).toMatch(/Issuing the API key failed with 409/);
        expect(text).not.toMatch(/slug/);
    });

    it("checks the parent of a custom password file like --out", async () => {
        mkdirSync(path.join(dir, "real"), { mode: 0o700 });
        symlinkSync(path.join(dir, "real"), path.join(dir, "link"));
        const text = await failure(() =>
            seed(deps(), options(["--owner-password-file", path.join(dir, "link", "o.pw")])),
        );
        expect(text).toMatch(/not a link/);
        mkdirSync(path.join(dir, "open"));
        chmodSync(path.join(dir, "open"), 0o777);
        expect(
            await failure(() =>
                seed(deps(), options(["--operator-password-file", path.join(dir, "open", "p.pw")])),
            ),
        ).toMatch(/chmod 700/);
        expect(fake.adminCalls).toHaveLength(0);
    });

    it("creates a missing parent mode 700 and rechecks it", async () => {
        await seed(deps(), options(["--owner-password-file", path.join(dir, "sub", "o.pw")]));
        expect(statSync(path.join(dir, "sub")).mode & 0o777).toBe(0o700);
        await expect(
            ensureOutDirectory(path.join(dir, "cfg", "local-operator.password")),
        ).rejects.toThrow(/real directory/);
    });

    it("refuses a relative or ~ config directory from the environment", async () => {
        for (const bad of [{ LAUNCHPAD_CONFIG_DIR: "cfg" }, { XDG_CONFIG_HOME: "~/x" }]) {
            expect(await failure(() => seed({ ...deps(), env: bad }, parseArgs([])))).toMatch(
                /not an absolute path/,
            );
        }
        expect(fake.adminCalls).toHaveLength(0);
    });

    it("expands only ~ and ~/..., not ~user", async () => {
        expect(() => resolvePath("~bob/x", "/home/u")).toThrow(/not ~user/);
        expect(resolvePath("~", "/home/u")).toBe("/home/u");
        expect(await failure(() => seed(deps(), parseArgs(["--out", "~bob/x"])))).toMatch(
            /not ~user/,
        );
    });
});
