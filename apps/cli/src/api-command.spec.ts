import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createContext, CredentialStore } from "@launchpad-kit/client-core";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT } from "./errors";
import type { Io } from "./io";
import { findOnPath } from "./jq";
import { run } from "./program";

const KEY = "lp_" + "a".repeat(43);
const CONTROLLER = "https://control.example.com";
const ORG = "org-one";
const base = `${CONTROLLER}/api/v1`;
let dir = "";

interface Call {
    url: string;
    init: RequestInit;
}

type Responder = (call: Call) => Response | Promise<Response>;
const json = (body: unknown, init: ResponseInit = {}) =>
    new Response(JSON.stringify(body), {
        ...init,
        headers: { "content-type": "application/json", ...init.headers },
    });

async function api(
    args: string[],
    options: {
        respond?: Responder;
        stdin?: string;
        files?: Record<string, string | Uint8Array>;
        env?: Record<string, string | undefined>;
        jq?: string | null;
        onLookup?: () => Promise<void>;
    } = {},
) {
    // Every fetch, including the organization lookup; `calls` is only the target requests.
    const requests: Call[] = [];
    const calls: Call[] = [];
    const out: string[] = [];
    const err: string[] = [];
    const reads: string[] = [];
    const respond: Responder = options.respond ?? (() => json({ ok: true }));
    const fetchImpl = (async (url: string, init: RequestInit) => {
        const call = { url, init };
        requests.push(call);
        if (new URL(url).pathname === "/api/v1/organizations") {
            await options.onLookup?.();
            return json([{ id: ORG, name: "Acme", slug: "acme", role: "admin" }]);
        }
        calls.push(call);
        return respond(call);
    }) as unknown as typeof fetch;
    const io: Io = {
        context: createContext(
            {
                LAUNCHPAD_CONFIG_DIR: dir,
                LAUNCHPAD_CONTROLLER: CONTROLLER,
                LAUNCHPAD_API_KEY: KEY,
                LAUNCHPAD_ORG: ORG,
                ...options.env,
            },
            { fetch: fetchImpl },
        ),
        workingDir: dir,
        out: (t) => void out.push(t),
        err: (t) => void err.push(t),
        interactive: false,
        readSecret: async () => "",
        readStdin: async () => "",
        readFile: async () => ({ text: "", mode: 0o600 }),
        findExecutable: () => options.jq ?? null,
        readData: async (source) => {
            reads.push(source);
            if (source === "-") return new TextEncoder().encode(options.stdin ?? "");
            const found = options.files?.[source];
            if (found === undefined) throw new Error("ENOENT");
            return typeof found === "string" ? new TextEncoder().encode(found) : found;
        },
    };
    const code = await run(args, io);
    const result = { code, calls, requests, reads, out: out.join("\n"), err: err.join("\n") };
    // The key must never be printed, whatever happened.
    expect(result.out + result.err).not.toContain(KEY);
    return result;
}

beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "lp-api-"));
});
afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
});

describe("api: requests", () => {
    it("prints the key's JSON for a plain GET", async () => {
        const { code, calls, out } = await api(["api", "key"]);
        expect(code).toBe(EXIT.ok);
        expect(calls[0]!.url).toBe(`${base}/key`);
        expect(calls[0]!.init.method).toBe("GET");
        expect(out).toBe(JSON.stringify({ ok: true }, null, 2));
    });

    it("creates a project from fields with {org}, once confirmed", async () => {
        const { code, calls } = await api([
            "api",
            "organizations/{org}/projects",
            "-f",
            "name=Demo",
            "-f",
            "slug=demo",
            "--confirm",
        ]);
        expect(code).toBe(EXIT.ok);
        expect(calls[0]!.url).toBe(`${base}/organizations/${ORG}/projects`);
        expect(calls[0]!.init.method).toBe("POST");
        expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ name: "Demo", slug: "demo" });
    });

    it("sends --input as the body, with fields in the query", async () => {
        const { code, calls } = await api(
            ["api", "-X", "POST", "x/y", "--input", "body.json", "-F", "n=1", "--confirm"],
            { files: { "body.json": '{"a":1}' } },
        );
        expect(code).toBe(EXIT.ok);
        expect(calls[0]!.url).toBe(`${base}/x/y?n=1`);
        expect(new TextDecoder().decode(calls[0]!.init.body as Uint8Array)).toBe('{"a":1}');
        const stdin = await api(["api", "x", "--input", "-", "--confirm"], { stdin: "[1]" });
        expect(new TextDecoder().decode(stdin.calls[0]!.init.body as Uint8Array)).toBe("[1]");
    });

    it("turns fields into the query string with --method GET", async () => {
        const { calls } = await api([
            "api",
            "--method",
            "GET",
            "organizations/{org}/deployments/d1/events",
            "-F",
            "after=12",
            "-F",
            "limit=500",
        ]);
        expect(calls[0]!.url).toBe(
            `${base}/organizations/${ORG}/deployments/d1/events?after=12&limit=500`,
        );
        expect(calls[0]!.init.body).toBeUndefined();
    });

    it("builds typed and nested bodies and reads @file values", async () => {
        const { calls } = await api(
            [
                "api",
                "x",
                "-F",
                "n=3",
                "-f",
                "s=3",
                "-f",
                "k[]=a",
                "-f",
                "k[]=b",
                "-F",
                "t=@t.txt",
                "--confirm",
            ],
            { files: { "t.txt": "text" } },
        );
        expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
            n: 3,
            s: "3",
            k: ["a", "b"],
            t: "text",
        });
    });

    it("passes headers and the idempotency key, and sets the content type", async () => {
        const { calls } = await api([
            "api",
            "x",
            "-X",
            "DELETE",
            "-H",
            "X-Trace: t1",
            "--idempotency-key",
            "k-1",
            "--confirm",
        ]);
        expect(calls[0]!.init.headers).toMatchObject({
            "x-trace": "t1",
            "idempotency-key": "k-1",
            authorization: `Bearer ${KEY}`,
        });
    });

    it("takes {project} from launchpad.json and still requires --confirm for a change", async () => {
        await fs.writeFile(
            path.join(dir, "launchpad.json"),
            JSON.stringify({ organization: ORG, project: "proj-1" }),
        );
        const read = await api(["api", "organizations/{org}/projects/{project}/apps"]);
        expect(read.calls[0]!.url).toBe(`${base}/organizations/${ORG}/projects/proj-1/apps`);
        const write = await api(["api", "-X", "POST", "p/{project}"]);
        expect(write.code).toBe(EXIT.usage);
        expect(write.requests).toEqual([]);
    });

    it("refuses a placeholder without a value, before any request", async () => {
        const { code, requests, err } = await api(["api", "p/{project}"]);
        expect(code).toBe(EXIT.usage);
        expect(err).toContain("{project}");
        expect(requests).toEqual([]);
    });

    it("encodes a placeholder value as one path segment", async () => {
        const { calls } = await api(["api", "o/{org}"], { env: { LAUNCHPAD_ORG: "a b" } });
        expect(calls[0]!.url).toBe(`${base}/o/a%20b`);
        const slash = await api(["api", "o/{org}"], { env: { LAUNCHPAD_ORG: "a/b" } });
        expect(slash.code).toBe(EXIT.usage);
        expect(slash.requests).toEqual([]);
        const dots = await api(["api", "o/{org}"], { env: { LAUNCHPAD_ORG: ".." } });
        expect(dots.code).toBe(EXIT.usage);
        expect(dots.requests).toEqual([]);
    });
});

describe("api: refusals (exit 2, nothing sent)", () => {
    const refused = [
        ["https://evil.example/x"],
        ["//evil/x"],
        ["a/../b"],
        ["x#y"],
        ["a\nb"],
        ["x", "-H", "authorization: Bearer z"],
        ["x", "-H", "Cookie: a=b"],
        ["x", "-H", "host: evil"],
        ["x", "-H", "content-length: 1"],
        ["x", "-H", "origin: https://evil"],
        ["x", "-H", "novalue"],
        ["x", "-X", "POST"],
        ["x", "-X", "POST", "--confirm", "--input", "bad.json"],
        ["x", "-X", "POST", "--confirm", "--input", "missing.json"],
        ["x", "-F", "k=@missing", "--confirm"],
        ["x", "-X", "TRACE", "--confirm"],
        ["x", "--slurp"],
        ["x", "-X", "POST", "--confirm", "--paginate"],
        ["x", "--idempotency-key", "bad key"],
    ];
    it.each(refused)("%s", async (...args) => {
        const result = await api(["api", ...args], { files: { "bad.json": "{nope" } });
        expect(result.code).toBe(EXIT.usage);
        expect(result.requests).toEqual([]);
    });

    it("refuses an over-size input body", async () => {
        const result = await api(["api", "x", "-X", "POST", "--confirm", "--input", "big"], {
            files: { big: JSON.stringify("x".repeat(1024 * 1024)) },
        });
        expect(result.code).toBe(EXIT.usage);
        expect(result.requests).toEqual([]);
    });

    it("reads standard input once", async () => {
        const result = await api(["api", "x", "--input", "-", "-F", "a=@-", "--confirm"], {
            stdin: "{}",
        });
        expect(result.code).toBe(EXIT.usage);
        expect(result.requests).toEqual([]);
    });
});

describe("api: output", () => {
    it("prints non-JSON text as it is, nothing for 204, and nothing with --silent", async () => {
        const text = await api(["api", "x"], { respond: () => new Response("plain\n") });
        expect(text.out).toBe("plain");
        const empty = await api(["api", "x"], {
            respond: () => new Response(null, { status: 204 }),
        });
        expect(empty.out).toBe("");
        const silent = await api(["api", "x", "--silent"]);
        expect(silent.out).toBe("");
    });

    it("prints the status line and headers with -i, hiding cookies", async () => {
        const { out } = await api(["api", "x", "-i"], {
            respond: () => json({ a: 1 }, { headers: { "x-id": "7", "set-cookie": "sid=secret" } }),
        });
        expect(out).toContain("HTTP 200");
        expect(out).toContain("x-id: 7");
        expect(out).toContain("set-cookie: [redacted]");
        expect(out).not.toContain("sid=secret");
    });

    it("strips terminal escape sequences from the response", async () => {
        const { out } = await api(["api", "x"], {
            respond: () => new Response("hi \u001b[31mred\u001b[0m \u001b]0;title\u0007 end"),
        });
        expect(out).toBe("hi red  end");
        expect(out).not.toContain("\u001b");
    });

    it("strips C1 control characters from a JSON string after re-indenting", async () => {
        const { out } = await api(["api", "x"], {
            respond: () => new Response('{"a":"x\u009b31my\u007fz"}'),
        });
        expect(out).toContain("xy");
        expect(out).not.toContain("\u009b");
        expect(out).not.toContain("\u007f");
    });

    it("shows the request and response under --verbose without the key or cookies", async () => {
        const { err } = await api(["api", "x", "--verbose", "-H", "x-a: b"], {
            respond: () => json({ a: 1 }, { headers: { "set-cookie": "sid=secret" } }),
        });
        expect(err).toContain("> GET /api/v1/x");
        expect(err).toContain("> authorization: [redacted]");
        expect(err).toContain("< HTTP 200");
        expect(err).toContain("set-cookie: [redacted]");
        expect(err).not.toContain("sid=secret");
    });

    it("maps controller errors to the existing exit codes and JSON shape, without the body", async () => {
        const forbidden = await api(["api", "x", "--json"], {
            respond: () =>
                json({ code: "forbidden", title: "No access", detail: KEY }, { status: 403 }),
        });
        expect(forbidden.code).toBe(EXIT.unauthorized);
        expect(JSON.parse(forbidden.err)).toEqual({
            error: { code: "forbidden", message: "No access", status: 403 },
        });
        expect((await api(["api", "x"], { respond: () => json({}, { status: 404 }) })).code).toBe(
            EXIT.notFound,
        );
        expect(
            (
                await api(["api", "x"], {
                    respond: () => {
                        throw new TypeError("fetch failed");
                    },
                })
            ).code,
        ).toBe(EXIT.transport);
        const big = await api(["api", "x"], {
            respond: () => new Response("x".repeat(1024 * 1024 + 1)),
        });
        expect(big.code).toBe(EXIT.transport);
    });
});

describe("api: --paginate", () => {
    const apps = `/api/v1/organizations/${ORG}/apps`;
    const pager = (links: Record<string, string | null>, pages: Record<string, unknown[]>) =>
        ((call: Call) => {
            const cursor = new URL(call.url).searchParams.get("cursor") ?? "";
            const next = links[cursor];
            return json(pages[cursor], {
                headers: next ? { link: `<${next}>; rel="next"` } : {},
            });
        }) as Responder;

    it("merges the pages, or wraps them with --slurp", async () => {
        const respond = pager(
            { "": `${apps}?limit=2&cursor=c1`, c1: `${apps}?limit=2&cursor=c2`, c2: null },
            { "": [1, 2], c1: [3, 4], c2: [5] },
        );
        const merged = await api(
            ["api", "organizations/{org}/apps", "-F", "limit=2", "-X", "GET", "--paginate"],
            { respond },
        );
        expect(JSON.parse(merged.out)).toEqual([1, 2, 3, 4, 5]);
        expect(merged.calls.map((c) => c.url)).toEqual([
            `${base}/organizations/${ORG}/apps?limit=2`,
            `${base}/organizations/${ORG}/apps?limit=2&cursor=c1`,
            `${base}/organizations/${ORG}/apps?limit=2&cursor=c2`,
        ]);
        const slurped = await api(
            [
                "api",
                "organizations/{org}/apps",
                "-F",
                "limit=2",
                "-X",
                "GET",
                "--paginate",
                "--slurp",
            ],
            { respond },
        );
        expect(JSON.parse(slurped.out)).toEqual([[1, 2], [3, 4], [5]]);
    });

    it("never follows a link to another host or path, and sends the key only to the controller", async () => {
        for (const target of [
            `https://evil.example.net${apps}?cursor=c1`,
            `//evil.example.net${apps}?cursor=c1`,
            `/api/v1/other?cursor=c1`,
        ]) {
            const result = await api(["api", "organizations/{org}/apps", "--paginate"], {
                respond: () => json([1], { headers: { link: `<${target}>; rel="next"` } }),
            });
            expect(result.calls).toHaveLength(1);
            expect(JSON.parse(result.out)).toEqual([1]);
        }
    });

    it("stops a controller that pages forever", async () => {
        const result = await api(["api", "organizations/{org}/apps", "--paginate"], {
            respond: () => json([1], { headers: { link: `<${apps}?cursor=same>; rel="next"` } }),
        });
        expect(result.code).toBe(EXIT.usage);
        expect(result.calls.length).toBeLessThanOrEqual(3);
    });

    it("needs a list, and keeps events on after and limit", async () => {
        const object = await api(["api", "x", "--paginate"]);
        expect(object.code).toBe(EXIT.usage);
        const events = `/api/v1/organizations/${ORG}/deployments/d1/events`;
        const result = await api(
            [
                "api",
                "organizations/{org}/deployments/d1/events",
                "-F",
                "limit=1",
                "-X",
                "GET",
                "--paginate",
            ],
            {
                respond: (call) =>
                    new URL(call.url).searchParams.get("after")
                        ? json([2])
                        : json([1], {
                              headers: { link: `<${events}?after=1&limit=1>; rel="next"` },
                          }),
            },
        );
        expect(JSON.parse(result.out)).toEqual([1, 2]);
        expect(result.calls[1]!.url).toBe(
            `${base}/organizations/${ORG}/deployments/d1/events?after=1&limit=1`,
        );
    });
});

describe("api: --jq", () => {
    const apps = () => json([{ slug: "a" }, { slug: "b" }]);

    it("filters with the built-in engine when jq is not found", async () => {
        const result = await api(["api", "x", "--jq", ".[].slug", "--verbose"], { respond: apps });
        expect(result.out).toBe("a\nb");
        expect(result.err).toContain("built-in");
        expect((await api(["api", "x", "-q", "length"], { respond: apps })).out).toBe("2");
    });

    it.skipIf(!findOnPath("jq", process.env.PATH))("uses jq on PATH when found", async () => {
        const file = findOnPath("jq", process.env.PATH)!;
        const result = await api(["api", "x", "--jq", ".[].slug", "--verbose"], {
            respond: apps,
            jq: file,
        });
        expect(result.out).toBe("a\nb");
        expect(result.err).toContain(`> jq: ${file}`);
    });

    it("refuses an invalid expression before sending anything", async () => {
        const result = await api(["api", "x", "-X", "POST", "--confirm", "--jq", ".["]);
        expect(result.code).toBe(EXIT.usage);
        expect(result.requests).toEqual([]);
    });

    it("filters merged pages and fails with exit 1 on a runtime error", async () => {
        const merged = await api(["api", "x", "--paginate", "-q", "length"], { respond: apps });
        expect(merged.out).toBe("2");
        const failed = await api(["api", "x", "-q", ".foo"], { respond: apps });
        expect(failed.code).toBe(EXIT.failure);
    });
});

describe("api: substituted values are data", () => {
    const withProject = (project: string) =>
        fs.writeFile(
            path.join(dir, "launchpad.json"),
            JSON.stringify({ organization: ORG, project }),
        );

    it("never reads a file or types a value from a {project} substitution", async () => {
        for (const project of ["@secret.txt", "@-", "true", "null", "42"]) {
            await withProject(project);
            const result = await api(["api", "x", "-F", "name={project}", "--confirm"], {
                files: { "secret.txt": "TOP SECRET", [project.slice(1)]: "TOP SECRET" },
                stdin: "TOP SECRET",
            });
            expect(result.code, project).toBe(EXIT.ok);
            expect(JSON.parse(String(result.calls[0]!.init.body)), project).toEqual({
                name: project,
            });
            expect(result.reads, project).toEqual([]);
        }
    });

    it("keeps a placeholder value with & or = as one query value", async () => {
        await withProject("a&b=c");
        const result = await api(["api", "x?p={project}"]);
        expect(result.calls[0]!.url).toBe(`${base}/x?p=a%26b%3Dc`);
    });
});

describe("api: validation happens before any I/O", () => {
    it("refuses a bad method before the {org} lookup and before reading stdin", async () => {
        const result = await api(
            ["api", "organizations/{org}/x", "-X", "BOGUS", "-F", "a=@-", "--confirm"],
            { env: { LAUNCHPAD_ORG: "" }, stdin: "x" },
        );
        expect(result.code).toBe(EXIT.usage);
        expect(result.requests).toEqual([]);
        expect(result.reads).toEqual([]);
    });
});

describe("api: --paginate limits", () => {
    const apps = `/api/v1/organizations/${ORG}/apps`;

    it("stops a link back to the first page without requesting it again", async () => {
        const result = await api(
            ["api", "organizations/{org}/apps", "-F", "limit=2", "-X", "GET", "--paginate"],
            {
                respond: () => json([1], { headers: { link: `<${apps}?limit=2>; rel="next"` } }),
            },
        );
        expect(result.code).toBe(EXIT.usage);
        expect(result.calls).toHaveLength(1);
    });

    it("stops after 16 MiB of pages", async () => {
        let n = 0;
        const result = await api(["api", "organizations/{org}/apps", "--paginate"], {
            respond: () =>
                json(["x".repeat(900_000)], {
                    headers: { link: `<${apps}?cursor=c${++n}>; rel="next"` },
                }),
        });
        expect(result.code).toBe(EXIT.usage);
        expect(result.err).toContain("16 MiB");
        expect(result.calls.length).toBeGreaterThan(10);
        expect(result.calls.length).toBeLessThan(25);
    });
});

describe("api: review follow-ups", () => {
    const apps = `/api/v1/organizations/${ORG}/apps`;

    it("does not look up {org} for an @file value that merely contains it", async () => {
        const result = await api(["api", "x", "-F", "k=@{org}.json", "--confirm"], {
            env: { LAUNCHPAD_ORG: "" },
            files: { "{org}.json": "body" },
        });
        expect(result.code).toBe(EXIT.ok);
        expect(result.calls.map((c) => c.url)).toEqual([`${base}/x`]);
        expect(JSON.parse(String(result.calls[0]!.init.body))).toEqual({ k: "body" });
    });

    it("counts --paginate size in bytes, not characters", async () => {
        let n = 0;
        // 400k three-byte characters are ~1.2 MB per page but only 400k characters.
        const result = await api(["api", "organizations/{org}/apps", "--paginate"], {
            respond: () =>
                json(["€".repeat(300_000)], {
                    headers: { link: `<${apps}?cursor=c${++n}>; rel="next"` },
                }),
        });
        expect(result.code).toBe(EXIT.usage);
        expect(result.err).toContain("16 MiB");
        expect(result.calls.length).toBeLessThan(25);
    });

    it("gives --paginate an overall 5 minute deadline reported as a timeout (exit 5)", async () => {
        vi.useFakeTimers();
        try {
            let hit!: () => void;
            const second = new Promise<void>((resolve) => (hit = resolve));
            let n = 0;
            const pending = api(["api", "organizations/{org}/apps", "--paginate", "--json"], {
                respond: (call) => {
                    if (++n === 1) {
                        return json([1], { headers: { link: `<${apps}?cursor=c1>; rel="next"` } });
                    }
                    hit();
                    return new Promise<Response>((_, reject) => {
                        call.init.signal!.addEventListener("abort", () =>
                            reject(new DOMException("aborted", "AbortError")),
                        );
                    });
                },
            });
            await second;
            await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
            const result = await pending;
            expect(result.code).toBe(EXIT.transport);
            expect(JSON.parse(result.err).error.code).toBe("timeout");
            expect(result.err).toContain("5 minutes");
        } finally {
            vi.useRealTimers();
        }
    });

    it("reports a jq failure after the request as exit 1, not a usage error", async () => {
        const result = await api(["api", "x", "-X", "POST", "--confirm", "-q", ".foo"], {
            respond: () => json([1]),
        });
        expect(result.calls).toHaveLength(1);
        expect(result.code).toBe(EXIT.failure);
        expect(result.err).toContain("The request succeeded; the --jq filter failed");
    });

    it("shows the request under --verbose even when it fails", async () => {
        const result = await api(["api", "x", "--verbose"], {
            respond: () => {
                throw new TypeError("fetch failed");
            },
        });
        expect(result.code).toBe(EXIT.transport);
        expect(result.err).toContain("> GET /api/v1/x");
        expect(result.err).toContain("> authorization: [redacted]");
    });

    it("lists every refused header in the README and the plan", async () => {
        const { FORBIDDEN_RAW_HEADERS } = await import("@launchpad-kit/sdk");
        const readme = await fs.readFile(new URL("../README.md", import.meta.url), "utf8");
        const plan = await fs.readFile(
            new URL("../../../docs/plans/cli-api-command.md", import.meta.url),
            "utf8",
        );
        for (const name of FORBIDDEN_RAW_HEADERS) {
            expect(readme, name).toContain(`\`${name}\``);
            expect(plan, name).toContain(`\`${name}\``);
        }
    });
});

describe("api: CodeRabbit follow-ups", () => {
    const apps = `/api/v1/organizations/${ORG}/apps`;
    const text = (body: string, init: ResponseInit = {}) => new Response(body, init);

    it("prints numbers exactly as the controller wrote them", async () => {
        const body = '{"id":9007199254740993,"f":1.0,"e":1E2,"s":"\\u00e9","a":[],"o":{}}';
        const result = await api(["api", "x"], { respond: () => text(body) });
        expect(result.out).toContain('"id": 9007199254740993');
        expect(result.out).toContain('"f": 1.0');
        expect(result.out).toContain('"e": 1E2');
        expect(result.out).toContain('"a": []');
        expect(result.out).toContain('"o": {}');
        expect(result.out).toContain("\\u00e9");
    });

    it("merges pages as text so numbers are not rounded", async () => {
        const pages: Record<string, string> = {
            "": "[9007199254740993, 1.50]",
            c1: "[18014398509481985]",
        };
        const respond = (call: Call) => {
            const cursor = new URL(call.url).searchParams.get("cursor") ?? "";
            return text(pages[cursor]!, {
                headers: cursor ? {} : { link: `<${apps}?cursor=c1>; rel="next"` },
            });
        };
        const merged = await api(["api", "organizations/{org}/apps", "--paginate"], { respond });
        expect(merged.out).toContain("9007199254740993");
        expect(merged.out).toContain("1.50");
        expect(merged.out).toContain("18014398509481985");
        const slurped = await api(["api", "organizations/{org}/apps", "--paginate", "--slurp"], {
            respond,
        });
        expect(slurped.out).toContain("9007199254740993");
        expect(JSON.parse(slurped.out)).toHaveLength(2);
    });

    it("sends --input bytes unchanged, such as a gzip file", async () => {
        const bytes = new Uint8Array(gzipSync("hello world"));
        expect(bytes[1]).toBe(0x8b);
        const result = await api(
            ["api", "x", "--input", "a.gz", "-H", "Content-Type: application/gzip", "--confirm"],
            { files: { "a.gz": bytes } },
        );
        expect(result.code).toBe(EXIT.ok);
        const sent = result.calls[0]!.init.body as Uint8Array;
        expect([...sent]).toEqual([...bytes]);
        expect((result.calls[0]!.init.headers as Record<string, string>)["content-type"]).toBe(
            "application/gzip",
        );
        // Without a content type the body must still be JSON text.
        const notJson = await api(["api", "x", "--input", "a.gz", "--confirm"], {
            files: { "a.gz": bytes },
        });
        expect(notJson.code).toBe(EXIT.usage);
        expect(notJson.requests).toEqual([]);
    });

    it("refuses an explicitly empty --jq before anything is sent", async () => {
        const result = await api(["api", "x", "-X", "POST", "--confirm", "--jq", ""]);
        expect(result.code).toBe(EXIT.usage);
        expect(result.requests).toEqual([]);
        // Omitting --jq is not validated.
        expect((await api(["api", "x"])).code).toBe(EXIT.ok);
    });

    it("checks --jq before the {org} lookup", async () => {
        await fs.writeFile(
            path.join(dir, "launchpad.json"),
            JSON.stringify({ organization: "acme", project: "p" }),
        );
        const bad = await api(["api", "organizations/{org}/apps", "--jq", ".["]);
        expect(bad.code).toBe(EXIT.usage);
        expect(bad.requests).toEqual([]);
        const good = await api(["api", "organizations/{org}/apps", "--jq", "length"]);
        expect(good.requests.map((r) => new URL(r.url).pathname)).toEqual([
            "/api/v1/organizations",
            `/api/v1/organizations/${ORG}/apps`,
        ]);
    });

    it("uses one launchpad.json snapshot for {org} and {project}", async () => {
        await fs.writeFile(
            path.join(dir, "launchpad.json"),
            JSON.stringify({ organization: "acme", project: "proj-9" }),
        );
        const result = await api(["api", "organizations/{org}/projects/{project}"]);
        expect(result.calls[0]!.url).toBe(`${base}/organizations/${ORG}/projects/proj-9`);
        expect(result.requests).toHaveLength(2);
    });

    it("keeps one identity when the saved profile changes during the lookup", async () => {
        const store = new CredentialStore(dir);
        const profile = (apiKey: string) => ({
            controller: CONTROLLER,
            apiKey,
            organizationId: null,
            savedAt: "2026-01-01T00:00:00.000Z",
        });
        await store.update((config) => {
            config.profiles.default = profile(KEY);
            config.currentProfile = "default";
        });
        await fs.writeFile(
            path.join(dir, "launchpad.json"),
            JSON.stringify({ organization: ORG, project: "p" }),
        );
        const result = await api(["api", "organizations/{org}/apps"], {
            env: {
                LAUNCHPAD_CONTROLLER: undefined,
                LAUNCHPAD_API_KEY: undefined,
                LAUNCHPAD_ORG: undefined,
            },
            onLookup: () =>
                store.update((config) => {
                    config.profiles.default = profile("lp_" + "b".repeat(43));
                }),
        });
        expect(result.code).toBe(EXIT.ok);
        const sent = result.calls[0]!.init.headers as Record<string, string>;
        expect(sent.authorization).toBe(`Bearer ${KEY}`);
        const lookup = result.requests[0]!.init.headers as Record<string, string>;
        expect(lookup.authorization).toBe(`Bearer ${KEY}`);
    });

    it("never prints the value of a refused header under --verbose", async () => {
        const result = await api([
            "api",
            "x",
            "--verbose",
            "-H",
            "Cookie: sid=topsecret",
            "-H",
            "x-a: visible",
        ]);
        expect(result.code).toBe(EXIT.usage);
        expect(result.err).toContain("> cookie: [redacted]");
        expect(result.err).not.toContain("topsecret");
        expect(result.err).toContain("> x-a: visible");
    });

    it("has no shell redirection characters in README sh examples", async () => {
        const readme = await fs.readFile(new URL("../README.md", import.meta.url), "utf8");
        const blocks = [...readme.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1]!);
        expect(blocks.length).toBeGreaterThan(0);
        for (const block of blocks) {
            for (const line of block.split("\n")) {
                expect(line.replace(/"[^"]*"|'[^']*'/g, ""), line).not.toMatch(/[<>]/);
            }
        }
    });
});
