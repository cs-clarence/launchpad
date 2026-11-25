import { Command, CommanderError } from "@commander-js/extra-typings";
import {
    listOrganizations,
    listProfiles,
    listProjects,
    login,
    logout,
    useOrganization,
    useProfile,
    whoami,
} from "@launchpad-kit/client-core";
import { addApiCommand } from "./api-command";
import { addAppCommands } from "./app-commands";
import { describe, EXIT, ExitWith } from "./errors";
import type { Io } from "./io";
import { safeOutput } from "./output";

const text = (rows: string[][]) => {
    const widths = rows[0]!.map((_, column) =>
        Math.max(...rows.map((row) => (row[column] ?? "").length)),
    );
    return rows
        .map((row) =>
            row
                .map((cell, i) => cell.padEnd(widths[i]!))
                .join("  ")
                .trimEnd(),
        )
        .join("\n");
};

// Where a key comes from. Never a command-line value: that lands in shell history and
// in the process list.
async function readKey(io: Io, options: { keyFile?: string; keyStdin?: boolean }): Promise<string> {
    let raw: string;
    if (options.keyFile) {
        const file = await io.readFile(options.keyFile);
        if (file.regular !== false && process.platform !== "win32" && (file.mode & 0o077) !== 0) {
            io.err(
                `Warning: ${options.keyFile} is readable by others; restrict it with chmod 600.`,
            );
        }
        raw = file.text;
    } else if (options.keyStdin) {
        if (io.stdinIsTTY ?? io.interactive) {
            throw new CommanderError(
                EXIT.usage,
                "commander.interactiveStdin",
                "error: --key-stdin requires redirected input; omit it to use the hidden terminal prompt",
            );
        }
        raw = await io.readStdin();
    } else if (io.interactive) {
        raw = await io.readSecret("API key: ");
    } else {
        throw new CommanderError(
            EXIT.usage,
            "commander.missingKey",
            "error: provide the key with --key-file <path> or --key-stdin, or run in a terminal",
        );
    }
    const key = raw.trim();
    if (!key) {
        throw new CommanderError(EXIT.usage, "commander.emptyKey", "error: the API key is empty");
    }
    return key;
}

export function buildProgram(rawIo: Io) {
    // Everything that reaches the terminal passes the redactor: names and other fields
    // come from the server and may contain key-shaped text. Redacting inside a JSON
    // document keeps it valid JSON.
    const io: Io = {
        get workingDir() {
            return rawIo.workingDir;
        },
        get context() {
            return rawIo.context;
        },
        get interactive() {
            return rawIo.interactive;
        },
        get stdinIsTTY() {
            return rawIo.stdinIsTTY;
        },
        out: (t) => rawIo.out(safeOutput(t)),
        err: (t) => rawIo.err(safeOutput(t)),
        readStdin: () => rawIo.readStdin(),
        readSecret: (prompt) => rawIo.readSecret(prompt),
        readFile: (path) => rawIo.readFile(path),
        readData: (source) => rawIo.readData(source),
        findExecutable: rawIo.findExecutable?.bind(rawIo),
    };
    const program = new Command()
        .name("launchpad")
        .description("Work with a Launchpad controller using an organization API key.")
        .version("0.0.0")
        .option("--json", "print machine-readable JSON")
        .option("--profile <name>", "use this saved profile instead of the current one")
        .showHelpAfterError(false)
        .configureOutput({
            writeOut: (s) => io.out(s.replace(/\n$/, "")),
            // Parser errors are reported once, by run(), in the requested format.
            writeErr: () => {},
        })
        .exitOverride();

    const wants = (command: Command<any, any, any>) =>
        command.optsWithGlobals() as { json?: boolean; profile?: string };
    const print = (command: Command<any, any, any>, data: unknown, human: () => string) =>
        io.out(wants(command).json ? JSON.stringify(data, null, 2) : human());

    program
        .command("login")
        .description(
            "Save an API key for a controller. The key is read from a file, stdin or the terminal, never an argument.",
        )
        .requiredOption(
            "--controller <url>",
            "the controller's address, e.g. https://control.example.com",
        )
        .option("--key-file <path>", "read the key from this file")
        .option("--key-stdin", "read the key from standard input")
        .action(async (options, command) => {
            const { profile, json } = wants(command);
            const key = await readKey(io, options);
            const result = await login(io.context, {
                controller: options.controller,
                apiKey: key,
                profile,
            });
            const summary = {
                profile: result.profile,
                controller: result.controller,
                organizationId: result.key.organizationId,
                key: { id: result.key.id, name: result.key.name, expiresAt: result.key.expiresAt },
            };
            io.out(
                json
                    ? JSON.stringify(summary, null, 2)
                    : `Logged in as profile "${result.profile}" (key "${result.key.name}", expires ${result.key.expiresAt}).`,
            );
        });

    program
        .command("logout")
        .description("Forget a saved profile.")
        .action(async (_options, command) => {
            const result = await logout(io.context, wants(command).profile);
            print(command, result, () => `Logged out of profile "${result.profile}".`);
        });

    program
        .command("whoami")
        .description("Show the controller, organization and permissions of the current key.")
        .action(async (_options, command) => {
            const result = await whoami(io.context, wants(command).profile);
            print(command, result, () =>
                [
                    `Controller:   ${result.controller}`,
                    `Profile:      ${result.profile ?? "(environment)"}`,
                    `Key:          ${result.key.name}`,
                    `Organization: ${result.key.organizationId}`,
                    `Scopes:       ${result.key.scopes.join(", ")}`,
                    `Projects:     ${result.key.projectIds ? result.key.projectIds.join(", ") : "all"}`,
                    `Expires:      ${result.key.expiresAt}`,
                ].join("\n"),
            );
        });

    const profile = program.command("profile").description("Saved profiles.");
    profile
        .command("list")
        .description("List saved profiles.")
        .action(async (_options, command) => {
            const result = await listProfiles(io.context);
            print(command, result, () =>
                result.profiles.length === 0
                    ? "No profiles. Run: launchpad login"
                    : text([
                          ["", "PROFILE", "CONTROLLER"],
                          ...result.profiles.map((p) => [
                              p.name === result.current ? "*" : "",
                              p.name,
                              p.controller,
                          ]),
                      ]),
            );
        });
    profile
        .command("use")
        .argument("<name>", "the profile to make current")
        .description("Make a saved profile the current one.")
        .action(async (name, _options, command) => {
            const result = await useProfile(io.context, name);
            print(command, result, () => `Using profile "${result.profile}".`);
        });

    const org = program.command("org").description("Organizations visible to the key.");
    org.command("list")
        .description("List organizations the key can see.")
        .action(async (_options, command) => {
            const result = await listOrganizations(io.context, wants(command).profile);
            print(command, result, () =>
                text([["ID", "SLUG", "NAME"], ...result.map((o) => [o.id, o.slug, o.name])]),
            );
        });
    org.command("use")
        .argument("<organization>", "slug or id")
        .description("Select the organization for later commands.")
        .action(async (organization, _options, command) => {
            const result = await useOrganization(io.context, organization, wants(command).profile);
            print(command, result, () => `Using organization ${result.organization.slug}.`);
        });

    const projects = program
        .command("projects")
        .description("Projects of the selected organization.");
    projects
        .command("list")
        .description("List projects the key can see.")
        .action(async (_options, command) => {
            const result = await listProjects(io.context, wants(command).profile);
            print(command, result, () =>
                result.length === 0
                    ? "No projects."
                    : text([["ID", "SLUG", "NAME"], ...result.map((p) => [p.id, p.slug, p.name])]),
            );
        });

    addApiCommand(program, io);
    addAppCommands(program, io.context, io.workingDir ?? process.cwd(), io.out);
    return program;
}

// Returns the exit code; the caller exits. Failures go to stderr, as JSON with --json.
export async function run(argv: string[], io: Io): Promise<number> {
    const program = buildProgram(io);
    try {
        await program.parseAsync(argv, { from: "user" });
        return EXIT.ok;
    } catch (error) {
        if (error instanceof CommanderError && error.exitCode === 0) return EXIT.ok; // --help, --version
        // The command already printed its result and asked for this exit code.
        if (error instanceof ExitWith) return error.exitCode;
        const failure = describe(error);
        const json = argv.includes("--json");
        io.err(
            safeOutput(
                json
                    ? JSON.stringify({
                          error: {
                              code: failure.code,
                              message: failure.message,
                              ...(failure.status ? { status: failure.status } : {}),
                          },
                      })
                    : `Error: ${failure.message}`,
            ),
        );
        return failure.exitCode;
    }
}
