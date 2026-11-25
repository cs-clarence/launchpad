import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createContext } from "@launchpad-kit/client-core";
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
        readPasswordFile: async () => "",
        readStdin: async () => options.stdin ?? "",
        readFile: async (file) => {
            const found = options.files?.[file];
            if (!found) throw new Error("ENOENT");
            return found;
        },
        readData: async (source) => {
            if (source === "-") return new TextEncoder().encode(options.stdin ?? "");
            const found = options.files?.[source];
            if (!found) throw new Error("ENOENT");
            return new TextEncoder().encode(found.text);
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

it("rejects destructive app and routing commands without explicit confirmation", async () => {
    for (const args of [
        ["app", "shutdown", "app-id"],
        ["deployment", "delete", "deployment-id"],
        [
            "alias",
            "promote",
            "alias-id",
            "deployment-id",
            "--expected-generation",
            "0",
            "--idempotency-key",
            "r1",
        ],
        ["alias", "withdraw", "alias-id", "--expected-generation", "0", "--idempotency-key", "r2"],
    ]) {
        // This happens before credential resolution, let alone a network request.
        const result = await cli(args);
        expect(result.code).toBe(EXIT.usage);
        expect(result.err).toContain("Confirm");
    }
});

it.skipIf(process.platform === "win32")(
    "protects the credential directory when an output path has a symlinked parent",
    async () => {
        const absolute = path.join(dir, "site", "out");
        const store = path.join(absolute, "state");
        const linkedParent = path.join(dir, "site-link");
        await fs.mkdir(store, { recursive: true });
        await fs.writeFile(path.join(absolute, "index.html"), "<p>Fixture site</p>");
        await fs.writeFile(path.join(store, "credentials.json"), "{}");
        await fs.symlink(path.join(dir, "site"), linkedParent, "dir");
        const fake = fakeIo();
        let uploads = 0;
        fake.io.workingDir = dir;
        fake.io.context = createContext(
            {
                LAUNCHPAD_CONFIG_DIR: store,
                LAUNCHPAD_CONTROLLER: CONTROLLER,
                LAUNCHPAD_API_KEY: KEY,
                LAUNCHPAD_ORG: ORG,
            },
            {
                fetch: (async (_url: string, init: RequestInit) => {
                    uploads++;
                    expect(init.body).toBeInstanceOf(Blob);
                    return json(
                        {
                            id: crypto.randomUUID(),
                            digest: "a".repeat(64),
                            sizeBytes: 10,
                            expandedBytes: 20,
                            entryCount: 1,
                            createdAt: "2026-11-21T00:00:00Z",
                            reused: false,
                        },
                        201,
                    );
                }) as typeof fetch,
            },
        );
        const upload = (source: string) =>
            run(["artifact", "upload", "project", source, "--directory"], fake.io);
        expect(await upload("site-link/out")).toBe(EXIT.usage);
        expect(fake.err.join("\n")).toContain("credential store");
        expect(uploads).toBe(0);

        await fs.unlink(path.join(store, "credentials.json"));
        await fs.symlink(absolute, path.join(dir, "out-link"), "dir");
        expect(await upload("out-link")).toBe(EXIT.usage);
        expect(uploads).toBe(0);
        expect(await upload("site-link/out")).toBe(EXIT.ok);
        expect(uploads).toBe(1);
    },
);

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
            async readData(_source: string) {
                return new Uint8Array();
            }
            async readPasswordFile(_path: string) {
                return "";
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
