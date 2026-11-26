import { describe, expect, it } from "bun:test";
import { DeployError, HELP, OPTIONS, parseArgs, SWITCH_FLAGS, VALUE_FLAGS } from "./local-deploy";

const message = (argv: string[]) => {
    try {
        parseArgs(argv);
    } catch (error) {
        expect(error).toBeInstanceOf(DeployError);
        return (error as Error).message;
    }
    return undefined;
};

describe("local-deploy arguments (worked examples)", () => {
    it("takes up, status and down", () => {
        for (const command of ["up", "status", "down"] as const) {
            expect(parseArgs([command])).toEqual({ command, help: false });
        }
    });

    it("takes the flags with up", () => {
        expect(parseArgs(["up", "--port-base", "40000", "--project", "launchpad-local-x"])).toEqual(
            { command: "up", portBase: 40000, project: "launchpad-local-x", help: false },
        );
        expect(parseArgs(["up", "--new-key"])).toEqual({
            command: "up",
            newKey: true,
            help: false,
        });
    });

    it("takes --help without a command", () => {
        expect(parseArgs(["--help"])).toEqual({ command: null, help: true });
        expect(HELP).toContain("--help");
    });

    it("accepts a flag before the command", () => {
        expect(parseArgs(["--new-key", "up"])).toEqual({
            command: "up",
            newKey: true,
            help: false,
        });
        expect(parseArgs(["--port-base", "40000", "up"]).portBase).toBe(40000);
    });

    it("says what to do when there is no command", () => {
        expect(message([])).toBe("Say what to do: up, status or down (see --help).");
    });

    it("refuses an unknown word, option or second command", () => {
        const tail = "Run with --help to list the commands.";
        expect(message(["wipe"])).toBe(`Unknown argument wipe. ${tail}`);
        expect(message(["up", "status"])).toBe(`Unknown argument status. ${tail}`);
        expect(message(["up", "--force"])).toBe(`Unknown argument --force. ${tail}`);
        expect(message(["up", "-h"])).toBe(`Unknown argument -h. ${tail}`);
        expect(message(["--"])).toBe(`Unknown argument --. ${tail}`);
        expect(message(["up", "--", "--new-key"])).toBe(`Unknown argument --. ${tail}`);
    });

    it("refuses a missing value", () => {
        expect(message(["up", "--port-base"])).toBe("--port-base needs a value.");
        expect(message(["up", "--project"])).toBe("--project needs a value.");
        expect(message(["up", "--project", "--new-key"])).toBe("--project needs a value.");
    });

    it("validates values", () => {
        expect(message(["up", "--port-base", "x"])).toBe("--port-base must be a number.");
        expect(message(["up", "--port-base", "-5"])).toBe("--port-base must be a number.");
        expect(message(["up", "--port-base", "80"])).toBeDefined();
        expect(message(["up", "--project", "Mine"])).toBeDefined();
    });

    it("lets the last value win", () => {
        expect(parseArgs(["up", "--port-base", "40000", "--port-base", "41000"]).portBase).toBe(
            41000,
        );
    });

    it("limits --port-base and --new-key to up", () => {
        const text = "--port-base and --new-key only apply to up.";
        expect(message(["down", "--new-key"])).toBe(text);
        expect(message(["status", "--port-base", "40000"])).toBe(text);
        expect(message(["--new-key", "--help"])).toBe(text);
    });

    it("accepts --flag=value", () => {
        expect(parseArgs(["up", "--port-base=40000"]).portBase).toBe(40000);
        expect(message(["up", "--port-base="])).toBe("--port-base must be a number.");
    });
});

describe("local-deploy process", () => {
    const run = (...args: string[]) => {
        const proc = Bun.spawnSync(["bun", `${import.meta.dirname}/local-deploy.ts`, ...args], {
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

    it("exits 1 for an unknown command", () => {
        const result = run("wipe");
        expect(result.code).toBe(1);
        expect(result.err.trim()).toBe(
            "Unknown argument wipe. Run with --help to list the commands.",
        );
        expect(result.out).toBe("");
    });
});

// The option block of HELP as it was written by hand, before it was generated.
const OLD_OPTION_BLOCK = `  --project <name>    project name (default launchpad-local-<8 hex of this checkout's path>;
                      must match ^launchpad-local-[a-z0-9-]{1,40}$)
  --port-base <n>     first of the five host ports (default 32180; offsets 0, 1, 2, 42, 263; up only)
  --new-key           up only: issue a replacement key for the local-deploy profile (needed if its
                      saved key lacks the scopes deploying needs, or was revoked)
  --help              show this text`;

describe("local-deploy HELP", () => {
    it("lists the option block exactly as the hand-written text did", () => {
        expect(HELP).toContain(`\n${OLD_OPTION_BLOCK}\n`);
    });

    it("lists every table option, and the flag lists come from the table", () => {
        for (const option of OPTIONS) expect(HELP).toContain(option.flag);
        expect([...VALUE_FLAGS, ...SWITCH_FLAGS].toSorted()).toEqual(
            OPTIONS.map((o) => o.flag).toSorted(),
        );
    });
});
