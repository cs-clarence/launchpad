import { describe, expect, it } from "bun:test";
import { HELP, parseArgs, SeedError } from "./local-seed";

const message = (argv: string[]) => {
    try {
        parseArgs(argv);
    } catch (error) {
        expect(error).toBeInstanceOf(SeedError);
        return (error as Error).message;
    }
    return undefined;
};

describe("local-seed arguments (worked examples)", () => {
    it("defaults without flags", () => {
        const o = parseArgs([]);
        expect([o.org, o.project, o.profile, o.help]).toEqual(["local", "demo", "local", false]);
        expect(o.controller).toBe("http://127.0.0.1:3000");
        expect(o.origin).toBe(o.controller);
    });

    it("sets org, project and profile", () => {
        const o = parseArgs(["--org", "acme", "--project", "site", "--profile", "acme"]);
        expect([o.org, o.project, o.profile]).toEqual(["acme", "site", "acme"]);
    });

    it("sets controller, origin and profile as the quickstart shows", () => {
        const o = parseArgs([
            "--controller",
            "http://127.0.0.1:3000",
            "--origin",
            "https://control.example.com",
            "--profile",
            "tunnel",
        ]);
        expect([o.controller, o.origin, o.profile]).toEqual([
            "http://127.0.0.1:3000",
            "https://control.example.com",
            "tunnel",
        ]);
    });

    it("reads switches", () => {
        const o = parseArgs(["--new-key", "--force", "--allow-remote"]);
        expect([o.newKey, o.force, o.allowRemote]).toEqual([true, true, true]);
    });

    it("answers --help without validating the rest", () => {
        expect(parseArgs(["--help"]).help).toBe(true);
        expect(parseArgs(["--org", "Not A Slug", "--help"]).help).toBe(true);
        expect(HELP).toContain("--help");
    });

    it("rejects an unknown option", () => {
        expect(message(["--nope"])).toBe(
            "Unknown option --nope. Run with --help to list the options.",
        );
        expect(message(["bare"])).toBe("Unknown option bare. Run with --help to list the options.");
        expect(message(["--password", "x"])).toBe(
            "Unknown option --password. Run with --help to list the options.",
        );
        expect(message(["--api-key", "x"])).toContain("Unknown option --api-key.");
        expect(message(["-h"])).toContain("Unknown option -h.");
    });

    it("rejects a missing value", () => {
        expect(message(["--org"])).toBe("--org needs a value.");
        expect(message(["--org", "--project"])).toBe("--org needs a value.");
        expect(message(["--new-key", "--out"])).toBe("--out needs a value.");
    });

    it("lets the last value win", () => {
        expect(parseArgs(["--org", "a", "--org", "b"]).org).toBe("b");
    });

    it("accepts a value that starts with a single dash, then validates it", () => {
        expect(message(["--org", "-x"])).toBe(
            "--org must be lowercase letters, digits and hyphens (40 at most).",
        );
    });

    it("rejects the -- terminator", () => {
        expect(message(["--"])).toBe("Unknown option --. Run with --help to list the options.");
        expect(message(["--org", "a", "--", "--new-key"])).toContain("Unknown option --.");
    });

    it("does not accept --flag=value yet", () => {
        expect(message(["--org=a"])).toBe(
            "Unknown option --org=a. Run with --help to list the options.",
        );
    });
});

describe("local-seed process", () => {
    const run = (...args: string[]) => {
        const proc = Bun.spawnSync(["bun", `${import.meta.dirname}/local-seed.ts`, ...args], {
            stdout: "pipe",
            stderr: "pipe",
            stdin: "ignore",
        });
        return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
    };

    it("prints HELP and exits 0 for --help", () => {
        const result = run("--help");
        expect(result.code).toBe(0);
        expect(result.out).toBe(`${HELP}\n`);
    });

    it("exits 1 with the old wording for an unknown option", () => {
        const result = run("--nope");
        expect(result.code).toBe(1);
        expect(result.err.trim()).toBe(
            "Unknown option --nope. Run with --help to list the options.",
        );
        expect(result.out).toBe("");
    });
});
