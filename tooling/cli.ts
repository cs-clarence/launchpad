// Shared argument parsing for the tooling scripts: commander does the parsing, the script keeps
// its own error class, wording and exit codes. Each script declares one option table; the same
// table feeds commander, the flag lists the documentation tests read and the option list in HELP.
import { Command, CommanderError } from "commander";

// `arg` set means the option takes a value; the rest are switches.
export interface Opt {
    flag: string;
    arg?: string;
    help: string;
}

export interface Policy {
    // The script's own wording for an option commander does not know ("--" included).
    unknownOption: (token: string) => string;
    // A separate value starting with this prefix is a missing value, as the hand parsers had it.
    rejectDashValues: "--" | "-";
}

export type Parsed = Record<string, string | boolean | undefined>;

export function toolCommand(name: string, options: Opt[]): Command {
    const program = new Command(name)
        .exitOverride()
        .helpOption(false)
        .allowExcessArguments()
        .configureOutput({ writeOut: () => {}, writeErr: () => {}, outputError: () => {} });
    for (const option of options) {
        program.option(option.arg ? `${option.flag} <${option.arg}>` : option.flag, option.help);
    }
    return program;
}

export function flagsOf(options: Opt[]): { value: string[]; switch: string[] } {
    return {
        value: options.filter((o) => o.arg).map((o) => o.flag),
        switch: options.filter((o) => !o.arg).map((o) => o.flag),
    };
}

// Commander's name for the option's value: --database-url-file -> databaseUrlFile.
export function keyOf(flag: string): string {
    return flag
        .replace(/^--/, "")
        .replace(/-([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());
}

// The option lines of HELP: two spaces, the flag and value name padded to `column`, the text.
// Further lines of a text are indented to the text's column.
export function optionHelp(options: Opt[], column: number): string {
    const indent = " ".repeat(2 + column);
    return options
        .map((option) => {
            const left = option.arg ? `${option.flag} <${option.arg}>` : option.flag;
            const [first, ...rest] = option.help.split("\n");
            return [`  ${left.padEnd(column)}${first}`, ...rest.map((line) => indent + line)].join(
                "\n",
            );
        })
        .join("\n");
}

export function parseOrFail(
    program: Command,
    argv: string[],
    fail: (message: string) => Error,
    policy: Policy,
): Parsed {
    if (argv.includes("--")) throw fail(policy.unknownOption("--"));
    try {
        program.parse(argv, { from: "user" });
    } catch (error) {
        if (!(error instanceof CommanderError)) throw error;
        if (error.code === "commander.optionMissingArgument") {
            const flag = /option '(--[^\s']+)/.exec(error.message)?.[1];
            throw fail(`${flag ?? "An option"} needs a value.`);
        }
        if (error.code === "commander.unknownOption") {
            const token = /unknown option '([^']+)'/.exec(error.message)?.[1] ?? "";
            throw fail(policy.unknownOption(token));
        }
        throw fail(error.message.replace(/^error: /, ""));
    }
    const valueFlags = new Set(
        program.options.filter((o) => o.required).map((o) => o.long ?? o.flags),
    );
    for (let i = 0; i < argv.length; i++) {
        if (!valueFlags.has(argv[i]!)) continue;
        const value = argv[++i];
        if (value !== undefined && value.startsWith(policy.rejectDashValues)) {
            throw fail(`${argv[i - 1]} needs a value.`);
        }
    }
    return program.opts<Parsed>();
}
