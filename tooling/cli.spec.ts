import { describe, expect, it } from "bun:test";
import { flagsOf, keyOf, optionHelp, parseOrFail, toolCommand, type Opt, type Policy } from "./cli";

class Failure extends Error {}
const fail = (message: string) => new Failure(message);
const policy: Policy = {
    unknownOption: (token) => `Unknown option ${token}. Run with --help to list the options.`,
    rejectDashValues: "--",
};

const options: Opt[] = [
    { flag: "--org", arg: "slug", help: "organization slug" },
    { flag: "--database-url-file", arg: "f", help: "first line\nsecond line" },
    { flag: "--force", help: "replace it" },
    { flag: "--help", help: "show this text" },
];

function parse(argv: string[], p: Policy = policy) {
    const program = toolCommand("tool", options).argument("[command]");
    return { opts: parseOrFail(program, argv, fail, p), program };
}
const message = (argv: string[], p: Policy = policy) => {
    try {
        parse(argv, p);
    } catch (error) {
        expect(error).toBeInstanceOf(Failure);
        return (error as Error).message;
    }
    return undefined;
};

describe("tables", () => {
    it("splits value options from switches", () => {
        expect(flagsOf(options)).toEqual({
            value: ["--org", "--database-url-file"],
            switch: ["--force", "--help"],
        });
    });

    it("names values as commander does", () => {
        expect(keyOf("--org")).toBe("org");
        expect(keyOf("--database-url-file")).toBe("databaseUrlFile");
        expect(keyOf("--port-base")).toBe("portBase");
    });

    it("lists the options aligned, continuation lines under the text", () => {
        expect(optionHelp(options, 26)).toBe(
            [
                "  --org <slug>              organization slug",
                "  --database-url-file <f>   first line",
                "                            second line",
                "  --force                   replace it",
                "  --help                    show this text",
            ].join("\n"),
        );
    });
});

describe("parseOrFail", () => {
    it("reads values and switches", () => {
        expect(parse(["--org", "acme", "--force"]).opts).toEqual({ org: "acme", force: true });
        expect(parse(["--database-url-file", "/u"]).opts).toEqual({ databaseUrlFile: "/u" });
        expect(parse([]).opts).toEqual({});
    });

    it("declares --help as a switch of its own, and no -h", () => {
        expect(parse(["--help"]).opts).toEqual({ help: true });
        expect(message(["-h"])).toBe("Unknown option -h. Run with --help to list the options.");
    });

    it("lets the last value win", () => {
        expect(parse(["--org", "a", "--org", "b"]).opts.org).toBe("b");
    });

    it("accepts --flag=value", () => {
        expect(parse(["--org=a"]).opts.org).toBe("a");
        expect(parse(["--org="]).opts.org).toBe("");
    });

    it("says an unknown option in the script's words", () => {
        expect(message(["--nope"])).toBe(
            "Unknown option --nope. Run with --help to list the options.",
        );
        expect(message(["--nope=1"])).toBe(
            "Unknown option --nope=1. Run with --help to list the options.",
        );
        expect(message(["--force=1"])).toContain("Unknown option");
    });

    it("rejects the -- terminator as an unknown option", () => {
        expect(message(["--"])).toBe("Unknown option --. Run with --help to list the options.");
        expect(message(["--org", "a", "--", "--force"])).toContain("Unknown option --.");
    });

    it("says a missing value", () => {
        expect(message(["--org"])).toBe("--org needs a value.");
        expect(message(["--force", "--database-url-file"])).toBe(
            "--database-url-file needs a value.",
        );
    });

    it("treats a value starting with -- as missing, but accepts -x", () => {
        expect(message(["--org", "--force"])).toBe("--org needs a value.");
        expect(message(["--force", "--org", "--database-url-file", "x"])).toBe(
            "--org needs a value.",
        );
        expect(parse(["--org", "-x"]).opts.org).toBe("-x");
    });

    it("treats a joined value starting with -- as missing too", () => {
        expect(message(["--org=--force"])).toBe("--org needs a value.");
        expect(message(["--database-url-file=--x"])).toBe("--database-url-file needs a value.");
        expect(parse(["--org=-x"]).opts.org).toBe("-x");
        expect(parse(["--org=a=b"]).opts.org).toBe("a=b");
        expect(message(["--org=-x"], { ...policy, rejectDashValues: "-" })).toBe(
            "--org needs a value.",
        );
    });

    it("can reject any dash-leading value", () => {
        expect(message(["--org", "-x"], { ...policy, rejectDashValues: "-" })).toBe(
            "--org needs a value.",
        );
        expect(parse(["--org", "x"], { ...policy, rejectDashValues: "-" }).opts.org).toBe("x");
    });

    it("keeps positionals for the script, wherever they stand", () => {
        for (const argv of [
            ["up", "--force"],
            ["--force", "up"],
        ]) {
            const { program, opts } = parse(argv);
            expect(opts.force).toBe(true);
            expect(program.processedArgs).toEqual(["up"]);
        }
        const { program } = parse(["up", "status", "--org", "a"]);
        expect(program.args).toEqual(["up", "status"]);
    });

    it("never reports commander's own text for the known codes", () => {
        for (const argv of [["--nope"], ["--org"], ["--org", "--force"]]) {
            expect(message(argv)).not.toMatch(/^error:|did you mean/i);
        }
    });
});
