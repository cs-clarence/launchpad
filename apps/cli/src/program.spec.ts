import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createContext } from "@launchpad/client-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "./errors";
import type { Io } from "./io";
import { run } from "./program";

const KEY = "lp_" + "a".repeat(43);
const KEY2 = "lp_" + "b".repeat(43);
const CONTROLLER = "https://control.example.com";
const ORG = "org-one";
let dir = "";

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const PID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const PREVIEW = {
    id: PID,
    projectId: PID,
    slug: "review",
    hostname: "review-a1b2c3.previews.example.com",
    state: "active",
    activeDeploymentId: null,
    expiresAt: "2026-11-20T00:00:00.000Z",
    createdAt: "2026-11-15T00:00:00.000Z",
};
const DELETION = {
    id: PID,
    previewId: PID,
    status: "reconciliation-needed",
    reason: "expired",
    failure: { code: "destroy-uncertain", message: "Destroying the app did not finish clearly." },
    createdAt: "2026-11-15T00:00:00.000Z",
    finishedAt: null,
};
let sent: { method: string; path: string; body: unknown; key: string | null }[] = [];
let controllerDown = false;
const controller = (async (url: string, init: RequestInit) => {
    if (controllerDown) throw new TypeError("fetch failed");
    const auth = (init.headers as Record<string, string>).authorization;
    if (auth !== `Bearer ${KEY}` && auth !== `Bearer ${KEY2}`) {
        return json({ code: "unauthenticated", status: 401, title: "Unauthorized" }, 401);
    }
    const route = new URL(url).pathname;
    if (route === "/api/v1/key") {
        return json({
            id: crypto.randomUUID(),
            name: "ci",
            organizationId: ORG,
            scopes: ["project:read"],
            projectIds: null,
            expiresAt: "2027-01-01T00:00:00.000Z",
        });
    }
    if (route === "/api/v1/organizations")
        return json([{ id: ORG, name: "Acme", slug: "acme", role: "admin" }]);
    if (route === `/api/v1/organizations/${ORG}/projects`) {
        return json([
            {
                id: crypto.randomUUID(),
                slug: "site",
                name: "Site",
                createdAt: "2026-01-01T00:00:00.000Z",
            },
        ]);
    }
    const previews = `/api/v1/organizations/${ORG}/previews`;
    const method = init.method ?? "GET";
    const headers = init.headers as Record<string, string>;
    if (route.startsWith(previews)) {
        sent.push({
            method,
            path: route,
            body: init.body ? JSON.parse(init.body as string) : undefined,
            key: headers["idempotency-key"] ?? null,
        });
    }
    if (route === previews && method === "GET") {
        return json({
            items: [
                PREVIEW,
                { ...PREVIEW, id: crypto.randomUUID(), slug: "old", expiresAt: null },
                { ...PREVIEW, id: crypto.randomUUID(), slug: "going", state: "deleting" },
            ],
            nextCursor: null,
        });
    }
    if (route === `${previews}/${PID}/extend`) {
        return json({ ...PREVIEW, expiresAt: "2026-11-27T00:00:00.000Z" });
    }
    if (route === `${previews}/${PID}/deletion`) return json(DELETION);
    if (route === `${previews}/${PID}` && method === "DELETE") {
        return json({ operationId: PID, state: "deleting" }, 202);
    }
    return json({ code: "not-found", status: 404, title: "Not Found" }, 404);
}) as unknown as typeof fetch;

function fakeIo(
    options: {
        stdin?: string;
        interactive?: boolean;
        stdinIsTTY?: boolean;
        secret?: string;
        files?: Record<string, { text: string; mode: number; regular?: boolean }>;
    } = {},
) {
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = {
        context: createContext({ LAUNCHPAD_CONFIG_DIR: dir }, { fetch: controller }),
        out: (t) => void out.push(t),
        err: (t) => void err.push(t),
        interactive: options.interactive ?? false,
        stdinIsTTY: options.stdinIsTTY,
        readSecret: async () => options.secret ?? "",
        readStdin: async () => options.stdin ?? "",
        readFile: async (file) => {
            const found = options.files?.[file];
            if (!found) throw new Error("ENOENT");
            return found;
        },
    };
    return { io, out, err, all: () => [...out, ...err].join("\n") };
}

async function cli(args: string[], options: Parameters<typeof fakeIo>[0] = {}) {
    const fake = fakeIo(options);
    const code = await run(args, fake.io);
    return { code, out: fake.out.join("\n"), err: fake.err.join("\n"), all: fake.all() };
}
const loggedIn = () =>
    cli(["login", "--controller", CONTROLLER, "--key-stdin"], { stdin: `${KEY}\n` });

beforeEach(async () => {
    controllerDown = false;
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "launchpad-cli-"));
});
afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
});

describe("login", () => {
    it("preserves prototype I/O methods and their receiver", async () => {
        class Terminal implements Io {
            context = createContext({ LAUNCHPAD_CONFIG_DIR: dir }, { fetch: controller });
            interactive = true;
            key = KEY;
            output: string[] = [];
            out(text: string) {
                this.output.push(text);
            }
            err(text: string) {
                this.output.push(text);
            }
            async readStdin() {
                return this.key;
            }
            async readSecret(_prompt: string) {
                return this.key;
            }
            async readFile(_path: string) {
                return { text: this.key, mode: 0o600 };
            }
        }
        for (const source of [["--key-stdin"], ["--key-file", "/key"], []]) {
            const terminal = new Terminal();
            terminal.interactive = source.length === 0;
            expect(await run(["login", "--controller", CONTROLLER, ...source], terminal)).toBe(
                EXIT.ok,
            );
            expect(terminal.output.join("\n")).toContain("Logged in");
            expect(terminal.output.join("\n")).not.toContain(KEY);
        }
    });

    it("reads the key from stdin, a file or a prompt, and never echoes it", async () => {
        const viaStdin = await loggedIn();
        expect(viaStdin.code).toBe(EXIT.ok);
        expect(viaStdin.out).toContain('Logged in as profile "default"');
        expect(viaStdin.all).not.toContain(KEY);

        const viaFile = await cli(
            ["login", "--controller", CONTROLLER, "--profile", "file", "--key-file", "/k"],
            {
                files: { "/k": { text: KEY2 + "\n", mode: 0o600 } },
            },
        );
        expect(viaFile.code).toBe(EXIT.ok);
        expect(viaFile.err).toBe("");

        const viaPrompt = await cli(["login", "--controller", CONTROLLER, "--profile", "tty"], {
            interactive: true,
            secret: KEY,
        });
        expect(viaPrompt.code).toBe(EXIT.ok);
        expect((await cli(["profile", "list", "--json"])).out).not.toContain(KEY);
    });

    it("warns about a key file others can read", async () => {
        const result = await cli(["login", "--controller", CONTROLLER, "--key-file", "/k"], {
            files: { "/k": { text: KEY, mode: 0o644 } },
        });
        expect(result.code).toBe(EXIT.ok);
        expect(result.err).toContain("readable by others");
        const special = await cli(["login", "--controller", CONTROLLER, "--key-file", "/k"], {
            files: { "/k": { text: KEY, mode: 0o644, regular: false } },
        });
        expect(special.code).toBe(EXIT.ok);
        expect(special.err).toBe("");
    });

    it("refuses interactive --key-stdin so the terminal cannot echo the key", async () => {
        const result = await cli(["login", "--controller", CONTROLLER, "--key-stdin"], {
            interactive: true,
            stdin: KEY,
        });
        expect(result.code).toBe(EXIT.usage);
        expect(result.err).toContain("hidden terminal prompt");
        expect(result.all).not.toContain(KEY);
        expect(await fs.readdir(dir)).toEqual([]);
        // Redirecting stderr must not make an echoing stdin safe.
        const redirectedError = await cli(["login", "--controller", CONTROLLER, "--key-stdin"], {
            interactive: false,
            stdinIsTTY: true,
            stdin: KEY,
        });
        expect(redirectedError.code).toBe(EXIT.usage);
    });

    it("has no way to pass the key as an argument", async () => {
        for (const args of [
            ["login", "--controller", CONTROLLER, "--key", KEY],
            ["login", "--controller", CONTROLLER, KEY],
        ]) {
            const result = await cli(args);
            expect(result.code).toBe(EXIT.usage);
            expect(result.all).not.toContain(KEY);
        }
        expect((await cli(["profile", "list", "--json"])).out).toContain('"profiles": []');
    });

    it("needs a key source when not interactive, and rejects an empty or wrong key, saving nothing", async () => {
        expect((await cli(["login", "--controller", CONTROLLER])).code).toBe(EXIT.usage);
        expect(
            (await cli(["login", "--controller", CONTROLLER, "--key-stdin"], { stdin: "  \n" }))
                .code,
        ).toBe(EXIT.usage);
        const wrong = await cli(["login", "--controller", CONTROLLER, "--key-stdin"], {
            stdin: "lp_" + "z".repeat(43),
        });
        expect(wrong.code).toBe(EXIT.unauthorized);
        expect(
            (
                await cli(["login", "--controller", "http://control.example.com", "--key-stdin"], {
                    stdin: KEY,
                })
            ).code,
        ).toBe(EXIT.usage);
        await expect(fs.readdir(dir)).resolves.toEqual([]);
    });
});

describe("commands", () => {
    it("shows who the key is, as text and as JSON", async () => {
        await loggedIn();
        const text = await cli(["whoami"]);
        expect(text.out).toContain("Organization: org-one");
        expect(text.out).toContain("Scopes:       project:read");
        const data = JSON.parse((await cli(["whoami", "--json"])).out);
        expect(data).toMatchObject({
            controller: CONTROLLER,
            key: { organizationId: ORG, name: "ci" },
        });
        expect(JSON.stringify(data)).not.toContain(KEY);
    });

    it("selects an organization and lists projects", async () => {
        await loggedIn();
        expect((await cli(["org", "list"])).out).toContain("acme");
        expect((await cli(["org", "use", "acme"])).out).toBe("Using organization acme.");
        expect((await cli(["projects", "list"])).out).toContain("site");
        expect(JSON.parse((await cli(["projects", "list", "--json"])).out)).toMatchObject([
            { slug: "site" },
        ]);
        expect((await cli(["org", "use", "beta"])).code).toBe(EXIT.local);
    });

    it("switches and removes profiles", async () => {
        await loggedIn();
        await cli(["login", "--controller", CONTROLLER, "--profile", "two", "--key-stdin"], {
            stdin: KEY2,
        });
        expect((await cli(["profile", "list"])).out).toMatch(/\* +default/);
        await cli(["profile", "use", "two"]);
        expect(JSON.parse((await cli(["profile", "list", "--json"])).out).current).toBe("two");
        expect((await cli(["whoami", "--profile", "default", "--json"])).code).toBe(EXIT.ok);
        expect((await cli(["logout"])).out).toContain('"two"');
        expect((await cli(["logout", "--profile", "nope"])).code).toBe(EXIT.unauthorized);
    });
});

describe("redaction", () => {
    it("hides key-shaped text in anything the server sends, in text and in JSON", async () => {
        const leaky = "lp_" + "q".repeat(30);
        const fetchLeaky = (async (url: string, init: RequestInit) => {
            const route = new URL(url).pathname;
            if (route === "/api/v1/key") {
                return json({
                    id: crypto.randomUUID(),
                    name: leaky,
                    organizationId: ORG,
                    scopes: ["project:read"],
                    projectIds: null,
                    expiresAt: "2027-01-01T00:00:00.000Z",
                });
            }
            if (route.endsWith("/projects")) {
                return json([
                    {
                        id: crypto.randomUUID(),
                        slug: "site",
                        name: leaky,
                        createdAt: "2026-01-01T00:00:00.000Z",
                    },
                ]);
            }
            return controller(url, init);
        }) as unknown as typeof fetch;
        const fake = fakeIo();
        fake.io.context = createContext({ LAUNCHPAD_CONFIG_DIR: dir }, { fetch: fetchLeaky });
        for (const args of [
            ["login", "--controller", CONTROLLER, "--key-stdin"],
            ["whoami"],
            ["whoami", "--json"],
            ["projects", "list", "--json"],
            ["projects", "list"],
        ]) {
            const io = { ...fake.io, readStdin: async () => KEY };
            await run(args, io);
        }
        expect(fake.all()).not.toContain(leaky);
        expect(fake.all()).toContain("lp_[redacted]");
        const documents = fake.out.filter(
            (line) => line.trim().startsWith("{") || line.trim().startsWith("["),
        );
        for (const doc of documents) expect(() => JSON.parse(doc)).not.toThrow();
    });
});

describe("failures", () => {
    it("uses stable exit codes", async () => {
        expect((await cli(["whoami"])).code).toBe(EXIT.unauthorized); // not logged in
        await loggedIn();
        controllerDown = true;
        expect((await cli(["whoami"])).code).toBe(EXIT.transport);
        controllerDown = false;
        expect((await cli(["nonsense"])).code).toBe(EXIT.usage);
        expect((await cli(["projects", "list", "extra"])).code).toBe(EXIT.usage);
        await fs.writeFile(path.join(dir, "credentials.json"), "{broken", { mode: 0o600 });
        expect((await cli(["whoami"])).code).toBe(EXIT.local);
    });

    it("prints errors as JSON on stderr with --json, and never contains a key", async () => {
        const result = await cli(["whoami", "--json"]);
        expect(result.out).toBe("");
        expect(JSON.parse(result.err)).toEqual({
            error: { code: "not-logged-in", message: expect.any(String) },
        });
        const leaking = await cli(["login", "--controller", CONTROLLER, "--json", "--key", KEY]);
        expect(leaking.all).not.toContain(KEY);
    });

    it("writes exactly one JSON document for a usage error, and none for help", async () => {
        const result = await cli(["nonsense", "--json"]);
        expect(result.code).toBe(EXIT.usage);
        expect(JSON.parse(result.err)).toMatchObject({ error: { code: "usage" } });
        expect(result.out).toBe("");
    });

    it.skipIf(process.getuid?.() === 0)(
        "maps an unreadable credential file to the local-error exit code",
        async () => {
            await loggedIn();
            await fs.chmod(path.join(dir, "credentials.json"), 0o000);
            const result = await cli(["whoami"]);
            expect(result.code).toBe(EXIT.local);
            await fs.chmod(path.join(dir, "credentials.json"), 0o600);
        },
    );

    it("prints help and version successfully", async () => {
        const help = await cli(["--help"]);
        expect(help.code).toBe(EXIT.ok);
        expect(help.out).toContain("login");
        expect((await cli(["--version"])).code).toBe(EXIT.ok);
    });
});

describe("preview lifetimes", () => {
    beforeEach(() => {
        sent = [];
    });

    it("shows when previews expire, and that one is going away", async () => {
        await loggedIn();
        const result = await cli(["previews", "list"]);
        expect(result.code).toBe(EXIT.ok);
        expect(result.out).toContain("EXPIRES");
        expect(result.out).toContain("2026-11-20T00:00:00.000Z");
        expect(result.out).toMatch(/old .* never/);
        expect(result.out).toMatch(/going .* deleting/);
    });

    it("extends with one idempotency key and reports the new expiry", async () => {
        await loggedIn();
        const result = await cli(["previews", "extend", PID, "--ttl", "7d"]);
        expect(result.code).toBe(EXIT.ok);
        expect(result.out).toContain("now expires 2026-11-27T00:00:00.000Z");
        const call = sent.find((s) => s.path.endsWith("/extend"))!;
        expect(call).toMatchObject({ method: "POST", body: { ttl: "7d" } });
        expect(call.key).toMatch(/^extend-/);
        expect((await cli(["previews", "extend", PID])).code).toBe(EXIT.usage);
    });

    it("refuses to delete without --yes, sending nothing", async () => {
        await loggedIn();
        const result = await cli(["previews", "delete", PID]);
        expect(result.code).toBe(EXIT.usage);
        expect(result.all).toContain("--yes");
        expect(sent.filter((s) => s.method === "DELETE")).toEqual([]);
    });

    it("queues a deletion with --yes and says how to follow it", async () => {
        await loggedIn();
        const result = await cli(["previews", "delete", PID, "--yes"]);
        expect(result.code).toBe(EXIT.ok);
        expect(result.out).toContain("Deletion queued");
        expect(result.out).toContain(`launchpad previews deletion '${PID}'`);
        expect(sent.filter((s) => s.method === "DELETE")).toHaveLength(1);
        // The follow-up names the profile, or it could ask another controller.
        const profiled = await cli(["--profile", "default", "previews", "delete", PID, "--yes"]);
        expect(profiled.out).toContain(`launchpad --profile 'default' previews deletion '${PID}'`);
    });

    it("reports a missing confirmation as JSON, and rejects a bad lifetime with a usage code", async () => {
        await loggedIn();
        const missing = await cli(["previews", "delete", PID, "--json"]);
        expect(missing.code).toBe(EXIT.usage);
        expect(sent.filter((s) => s.method === "DELETE")).toEqual([]);
        // --ttl on deploy reaches the library, which refuses it before sending anything.
        const site = await fs.mkdtemp(path.join(dir, "site-"));
        await fs.writeFile(path.join(site, "index.html"), "<p>hi</p>");
        const badDeploy = await cli([
            "deploy",
            site,
            "--project",
            "site",
            "--name",
            "review",
            "--ttl",
            "soon",
        ]);
        expect(badDeploy.code).toBe(EXIT.usage);
        expect(sent).toEqual([]);
        const bad = await cli(["previews", "extend", PID, "--ttl", "soon"]);
        expect(bad.code).toBe(EXIT.usage);
        expect(sent.filter((s) => s.path.endsWith("/extend"))).toEqual([]);
    });

    it("shows a deletion's status and its note, and when a person is needed", async () => {
        await loggedIn();
        const result = await cli(["previews", "deletion", PID]);
        expect(result.code).toBe(EXIT.ok);
        expect(result.out).toContain("reconciliation-needed");
        expect(result.out).toContain("[destroy-uncertain]");
        expect(result.out).toContain("An administrator must check the host");
        const asJson = JSON.parse((await cli(["previews", "deletion", PID, "--json"])).out);
        expect(asJson.status).toBe("reconciliation-needed");
    });
});
