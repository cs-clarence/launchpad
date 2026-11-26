import { spawn } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempState, type TempState } from "../test-support";

// Pins the command-line surface (usage, exit codes, exact messages). Every argv here is refused or
// printed before any state, database or listener is touched: no case starts `serve`, opens the
// state file or reaches a database.

const ENTRY = path.resolve(__dirname, "../index.ts");
const TOKEN_TEXT = "expected exactly one of --token-file <path> or --token-stdin";
const DATABASE_TEXT = "expected exactly one of --database-url-file <path> or --standalone";

let state: TempState | undefined;
afterEach(() => {
    state?.cleanup();
    state = undefined;
});

function environment(overrides: Record<string, string | undefined> = {}) {
    state ??= tempState();
    return {
        LAUNCHPAD_ROUTER_STATE_FILE: state.stateFile,
        LAUNCHPAD_ROUTER_INSTANCE_ID: state.config.instanceId,
        LAUNCHPAD_APPS_DOMAIN: state.config.appsDomain,
        LAUNCHPAD_ROUTER_CONTROL_LISTEN: "127.0.0.1:1",
        LAUNCHPAD_ROUTER_DATA_LISTEN: "127.0.0.1:2",
        LAUNCHPAD_APPS_PROXY_URL: "http://127.0.0.1:3",
        ...overrides,
    };
}

function run(args: string[], env: Record<string, string | undefined>, stdin = "") {
    return new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
        const child = spawn("bun", [ENTRY, ...args], {
            env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } as NodeJS.ProcessEnv,
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (c) => (out += c));
        child.stderr.on("data", (c) => (err += c));
        child.on("close", (code) => resolve({ code, out, err }));
        child.stdin.end(stdin);
    });
}

describe("launchpad-router usage", () => {
    it.each(
        ["serve", "healthcheck", "init", "rotate"].flatMap((c) => [
            [c, "--help"],
            [c, "-h"],
        ]),
    )(
        "%s %s prints the usage on stdout and exits 0, before reading the environment",
        async (...args) => {
            const result = await run(args, {});
            expect(result.code).toBe(0);
            expect(result.err).toBe("");
            expect(result.out).toMatch(/^Usage: launchpad-router <command>\n/);
        },
    );

    it.each([[[]], [["-h"]], [["--help"]]] as [string[]][])(
        "prints the usage on stdout and exits 0 for %j, before reading the environment",
        async (args) => {
            const result = await run(args, {});
            expect(result.code).toBe(0);
            expect(result.err).toBe("");
            expect(result.out).toMatch(/^Usage: launchpad-router <command>\n\nCommands:\n/);
            expect(result.out).toContain("  serve ");
            expect(result.out).toContain("  healthcheck ");
            expect(result.out.endsWith("never from an argument or the environment.\n")).toBe(true);
        },
    );

    const refused: [string[], string, Record<string, string | undefined>?][] = [
        [["unknown"], 'unknown command "unknown"; see --help'],
        [["--bogus"], 'unknown command "--bogus"; see --help'],
        [["-x"], 'unknown command "-x"; see --help'],
        [["Serve"], 'unknown command "Serve"; see --help'],
        [["x".repeat(60)], `unknown command "${"x".repeat(40)}"; see --help`],
        // The command is checked before the environment is read.
        [["--bogus"], 'unknown command "--bogus"; see --help', { LAUNCHPAD_APPS_DOMAIN: "" }],
        // serve/healthcheck take no arguments of any kind.
        [["serve", "x"], "serve takes no arguments"],
        [["serve", "--", "x"], "serve takes no arguments"],
        [["serve", "--token-file", "x"], "serve takes no arguments"],
        [["serve", "--bogus"], "serve takes no arguments"],
        [["healthcheck", "x"], "healthcheck takes no arguments"],
        [["healthcheck", "--bogus"], "healthcheck takes no arguments"],
        // The environment is read before the arguments of serve/healthcheck.
        [
            ["serve", "x"],
            "LAUNCHPAD_ROUTER_INSTANCE_ID is required.",
            { LAUNCHPAD_ROUTER_INSTANCE_ID: undefined },
        ],
        [
            ["healthcheck", "x"],
            "LAUNCHPAD_ROUTER_INSTANCE_ID is required.",
            { LAUNCHPAD_ROUTER_INSTANCE_ID: undefined },
        ],
        // init and rotate: any parse problem gives the token text.
        [["init"], TOKEN_TEXT],
        [["init", "x"], TOKEN_TEXT],
        [["init", "--"], TOKEN_TEXT],
        [["init", "--", "x"], TOKEN_TEXT],
        [["init", "--bogus"], TOKEN_TEXT],
        [["init", "--token-file"], TOKEN_TEXT],
        [["init", "--token-file", "--token-stdin"], TOKEN_TEXT],
        [["init", "--token-file", "-x"], TOKEN_TEXT],
        [["init", "--token-stdin", "--token-file"], TOKEN_TEXT],
        [["init", "--token-file", "x", "--token-stdin"], TOKEN_TEXT],
        [["init", "--token-stdin", "--token-file=x"], TOKEN_TEXT],
        [["init", "--token-stdin=x"], TOKEN_TEXT],
        [["rotate"], TOKEN_TEXT],
        [["rotate", "--standalone"], TOKEN_TEXT],
        [["rotate", "--database-url-file", "x"], TOKEN_TEXT],
        [["rotate", "--bogus", "--standalone"], TOKEN_TEXT],
        [["rotate", "--token-stdin", "--database-url-file"], TOKEN_TEXT],
        [["rotate", "--token-stdin", "--database-url-file", "--standalone"], TOKEN_TEXT],
        [["rotate", "--token-stdin", "--database-url-file", "-x"], TOKEN_TEXT],
        // init does not take the rotate options.
        [
            ["init", "--token-stdin", "--standalone"],
            "database and standalone options are for rotate only",
        ],
        [
            ["init", "--token-stdin", "--database-url-file", "x"],
            "database and standalone options are for rotate only",
        ],
        [["rotate", "--token-stdin"], DATABASE_TEXT],
        [["rotate", "--token-file=x"], DATABASE_TEXT],
        [["rotate", "--token-stdin", "--standalone", "--database-url-file", "x"], DATABASE_TEXT],
        [["rotate", "--token-stdin", "--standalone", "--database-url-file=x"], DATABASE_TEXT],
        // Accepted by the parser; the path is then refused before anything is read.
        [["init", "--token-file=x"], "The secret file must be a plain absolute path."],
        [["init", "--token-file=-x"], "The secret file must be a plain absolute path."],
        [
            ["init", "--token-file", "a", "--token-file", "b"],
            "The secret file must be a plain absolute path.",
        ],
        [["init", "--token-file", "relative"], "The secret file must be a plain absolute path."],
        [
            ["init", "--token-stdin", "--token-stdin"],
            "The secret must be 64 lowercase hexadecimal characters.",
        ],
    ];

    it.each(refused)("%j fails with a fixed message", async (args, message, overrides) => {
        const result = await run(args, environment(overrides), "short");
        expect(result.code, args.join(" ")).toBe(1);
        expect(result.out).toBe("");
        expect(result.err).toBe(`error: ${message}\n`);
    });
});
