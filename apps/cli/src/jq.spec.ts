import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClientCoreError } from "@launchpad-kit/client-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { applyJq, candidateNames, checkJq, chooseJq, findOnPath, type JqEngine } from "./jq";

const system = findOnPath("jq", process.env.PATH);
const builtin: JqEngine = { kind: "builtin" };
const APPS = JSON.stringify([{ slug: "a" }, { slug: "b" }]);
let dir = "";
beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "lp-jq-"));
});
afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
});

const script = async (body: string) => {
    const file = path.join(dir, "jq");
    await fs.writeFile(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return { kind: "system", file } as const;
};

describe("engine choice", () => {
    it("prefers jq on PATH and falls back to the built-in engine", async () => {
        const file = (await script("exit 0")).file;
        expect(chooseJq(dir, findOnPath)).toEqual({ kind: "system", file });
        expect(chooseJq("", findOnPath)).toEqual(builtin);
        expect(chooseJq("/x", () => null)).toEqual(builtin);
        expect(chooseJq("relative:", findOnPath)).toEqual(builtin);
        await fs.rm(file);
        await fs.mkdir(file);
        expect(chooseJq(dir, findOnPath)).toEqual(builtin);
    });
});

describe("built-in engine", () => {
    it("prints a stream one result per line and strings raw", async () => {
        expect(await applyJq(builtin, ".[].slug", APPS)).toBe("a\nb");
        expect(await applyJq(builtin, "length", APPS)).toBe("2");
        expect(await applyJq(builtin, ".[0]", APPS)).toBe('{\n  "slug": "a"\n}');
        expect(await applyJq(builtin, ".a", '{"a":[1]}')).toBe("[\n  1\n]");
        expect(await applyJq(builtin, ".a | .[]", '{"a":["p","q"]}')).toBe("p\nq");
    });

    it("refuses an invalid expression and non-JSON input as usage errors", async () => {
        await expect(checkJq(builtin, ".[")).rejects.toBeInstanceOf(ClientCoreError);
        await expect(applyJq(builtin, ".foo", "[]")).rejects.toBeInstanceOf(ClientCoreError);
        await expect(applyJq(builtin, ".", "not json")).rejects.toBeInstanceOf(ClientCoreError);
        await expect(applyJq(builtin, "", "{}")).rejects.toBeInstanceOf(ClientCoreError);
    });
});

describe.skipIf(!system || process.platform === "win32")("system jq", () => {
    const engine = (): JqEngine => ({ kind: "system", file: system! });

    it("matches jq's output", async () => {
        expect(await applyJq(engine(), ".[].slug", APPS)).toBe("a\nb");
        expect(await applyJq(engine(), "map(.slug)", APPS)).toBe('[\n  "a",\n  "b"\n]');
    });

    it("takes the expression as an argument, not an option, and sees no environment", async () => {
        expect(await applyJq(engine(), "-1", "{}")).toBe("-1");
        expect(await applyJq(engine(), "$ENV | length", "{}")).toBe("0");
    });

    it("refuses an invalid expression before the request, and reports a runtime error", async () => {
        await expect(checkJq(engine(), ".[")).rejects.toBeInstanceOf(ClientCoreError);
        await expect(checkJq(engine(), ".foo[]")).resolves.toBeUndefined();
        await expect(applyJq(engine(), ".a[]", "{}")).rejects.toBeInstanceOf(ClientCoreError);
    });
});

describe.skipIf(process.platform === "win32")("system jq limits", () => {
    it("stops a jq that runs too long", async () => {
        const engine = await script("sleep 30");
        await expect(
            applyJq(engine, ".", "{}", { timeoutMs: 100, maxOutputBytes: 1024 }),
        ).rejects.toThrow("too long");
    });

    it("stops a jq that prints too much", async () => {
        const engine = await script("yes x | head -c 100000");
        await expect(
            applyJq(engine, ".", "{}", { timeoutMs: 5000, maxOutputBytes: 1024 }),
        ).rejects.toThrow("too much");
    });

    it("reports a failing jq without its exit details leaking the environment", async () => {
        const engine = await script('echo "boom" >&2; exit 2');
        await expect(applyJq(engine, ".", "{}")).rejects.toThrow("jq: boom");
    });
});

describe.skipIf(process.platform === "win32")("system jq arguments", () => {
    it("passes the program without `--`, guarding a leading dash with a space", async () => {
        const log = path.join(dir, "args");
        const engine = await script(`printf '%s\\n' "$@" > '${log}'; cat >/dev/null; echo ok`);
        await applyJq(engine, "-1", "{}");
        expect((await fs.readFile(log, "utf8")).split("\n").slice(0, 3)).toEqual(["-r", " -1", ""]);
        await applyJq(engine, ".a", "{}");
        expect((await fs.readFile(log, "utf8")).split("\n").slice(0, 3)).toEqual(["-r", ".a", ""]);
    });
});

describe("windows executable names", () => {
    it("also tries name.exe on win32 only", async () => {
        expect(candidateNames("jq", "win32")).toEqual(["jq", "jq.exe"]);
        expect(candidateNames("jq", "linux")).toEqual(["jq"]);
        await fs.writeFile(path.join(dir, "jq.exe"), "x", { mode: 0o755 });
        expect(findOnPath("jq", dir, "win32")).toBe(path.join(dir, "jq.exe"));
        expect(findOnPath("jq", dir, "linux")).toBeNull();
        await fs.mkdir(path.join(dir, "sub"));
        await fs.mkdir(path.join(dir, "sub", "jq.exe"));
        expect(findOnPath("jq", path.join(dir, "sub"), "win32")).toBeNull();
    });
});

describe.skipIf(process.platform === "win32")("system jq cleanup", () => {
    it("does not stay alive for a grandchild that holds the pipes", async () => {
        const engine = await script("sleep 8 &\nsleep 8");
        const runner = path.join(dir, "run.ts");
        await fs.writeFile(
            runner,
            `import { applyJq } from ${JSON.stringify(path.resolve(import.meta.dirname, "jq.ts"))};
await applyJq(${JSON.stringify(engine)}, ".", "{}", { timeoutMs: 100, maxOutputBytes: 1024 }).catch(() => {});
`,
        );
        const started = Date.now();
        const result = spawnSync(process.execPath, [runner], { timeout: 4000, stdio: "ignore" });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(Date.now() - started).toBeLessThan(4000);
    });
});

describe("numbers", () => {
    it.skipIf(
        !system ||
            !/jq-1\.(?:[7-9]|\d\d)/.test(
                spawnSync(system!, ["--version"]).stdout?.toString() ?? "",
            ),
    )("system jq keeps a large integer literal", async () => {
        expect(await applyJq({ kind: "system", file: system! }, ".[0]", "[9007199254740993]")).toBe(
            "9007199254740993",
        );
    });

    it("documents that the built-in engine rounds it", async () => {
        expect(await applyJq(builtin, ".[0]", "[9007199254740993]")).toBe("9007199254740992");
    });
});
