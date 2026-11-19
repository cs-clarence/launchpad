import { Command, CommanderError } from "@commander-js/extra-typings";
import {
    deletePreview,
    effectiveProfile,
    deploy,
    deploymentEvents,
    extendPreview,
    getDeployment,
    getPreview,
    listDeployments,
    listPreviews,
    listOrganizations,
    listProfiles,
    listProjects,
    login,
    previewDeletion,
    logout,
    useOrganization,
    useProfile,
    whoami,
    workspaceContext,
    ClientCoreError,
    checkLifetime,
} from "@launchpad-kit/client-core";
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

// "never" is a preview with no expiry; a preview that is going away says so instead.
const expiry = (p: { state: string; expiresAt: string | null }) =>
    p.state !== "active" ? p.state : (p.expiresAt ?? "never");

const shellArg = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

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

    program
        .command("deploy")
        .argument("<source>", "a built directory, or a .tar.gz of one")
        .description(
            "Deploy a built static site to a preview. The directory is packed here (links, secrets and version-control data are refused), uploaded, and followed until it is live.",
        )
        .option("--project <project>", "the project's slug or id (or launchpad.json)")
        .option("--name <name>", "the preview's name (or launchpad.json)")
        .option("--spa", "serve index.html for unknown paths, for single-page apps")
        .option(
            "--ttl <duration>",
            "lifetime of a new preview, such as 24h or 7d (the server's default if omitted; an existing preview keeps its own)",
        )
        .option("--no-wait", "return as soon as the deployment is queued")
        .option("--timeout <seconds>", "stop waiting after this long (default 900)", "900")
        .action(async (source, options, command) => {
            const { json, profile } = wants(command);
            const seconds = Number(options.timeout);
            if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86_400) {
                throw new CommanderError(
                    EXIT.usage,
                    "commander.invalidArgument",
                    "error: --timeout is a whole number of seconds, from 1 to 86400",
                );
            }
            // A mistake in the command itself is reported as one, before credentials are looked at.
            if (options.ttl !== undefined) checkLifetime(options.ttl);
            const workspace = await workspaceContext(io.context, {
                workingDir: io.workingDir ?? process.cwd(),
                profile,
                project: options.project,
            });
            const project = workspace.project;
            const name = options.name ?? workspace.name;
            if (!project || !name) {
                throw new ClientCoreError(
                    "bad-input",
                    "Set --project and --name, or configure them in launchpad.json.",
                );
            }
            // The saved profile is settled once, before the work: the operation and its
            // follow-up command must name the same one, whatever happens to the current
            // profile while it runs.
            const usedProfile = await effectiveProfile(workspace.context, workspace.profile);
            const result = await deploy(workspace.context, {
                source,
                project,
                name,
                spa: options.spa,
                ttl: options.ttl,
                wait: options.wait,
                waitTimeoutMs: seconds * 1000,
                profile: usedProfile,
                // Progress goes to stderr so stdout stays the result; none with --json.
                onProgress: json
                    ? undefined
                    : (p) =>
                          io.err(
                              p.kind === "step"
                                  ? p.message
                                  : p.kind === "status"
                                    ? `Status: ${p.status}`
                                    : p.kind === "queued"
                                      ? `Queued deployment ${p.deploymentId}`
                                      : `  [${p.phase}] ${p.message}`,
                          ),
            });
            const organization = workspace.organization;
            const follow = (id: string) =>
                [
                    "launchpad",
                    ...(usedProfile ? ["--profile", shellArg(usedProfile)] : []),
                    "deployments",
                    "status",
                    id,
                    ...(organization ? ["--organization", shellArg(organization)] : []),
                ].join(" ");
            print(command, result, () => {
                const id = result.deployment.id;
                switch (result.outcome) {
                    case "succeeded":
                        return `Deployed ${result.preview.hostname} (deployment ${id}).`;
                    case "queued":
                        return `Queued deployment ${id} for ${result.preview.hostname}. Check it with: ${follow(id)}`;
                    case "timeout":
                        return `Still ${result.deployment.status} after ${seconds}s; it was not cancelled. Check it with: ${follow(id)}`;
                    case "reconciliation-needed":
                        return `Deployment ${id} needs an administrator: the host must be checked before ${result.preview.hostname} can be deployed again.`;
                    default: {
                        const failure = (
                            result.deployment as { failure?: { message: string } | null }
                        ).failure;
                        return `Deployment ${id} ${result.outcome}${failure ? `: ${failure.message}` : "."}`;
                    }
                }
            });
            if (result.outcome === "timeout") throw new ExitWith(EXIT.waiting);
            if (!["succeeded", "queued"].includes(result.outcome)) {
                throw new ExitWith(EXIT.deployment);
            }
        });

    const previews = program
        .command("previews")
        .description("Previews of the selected organization.");
    previews
        .command("list")
        .description("List previews.")
        .option("--project <project>", "only this project's previews (slug or id)")
        .action(async (options, command) => {
            const workspace = await workspaceContext(io.context, {
                workingDir: io.workingDir ?? process.cwd(),
                profile: wants(command).profile,
                project: options.project,
            });
            const result = await listPreviews(workspace.context, {
                project: workspace.project,
                profile: workspace.profile,
            });
            print(command, result, () =>
                result.items.length === 0
                    ? "No previews."
                    : text([
                          ["ID", "NAME", "HOSTNAME", "ACTIVE", "EXPIRES"],
                          ...result.items.map((p) => [
                              p.id,
                              p.slug,
                              p.hostname,
                              p.activeDeploymentId ?? "-",
                              expiry(p),
                          ]),
                      ]) +
                      (result.truncated ? "\n(more previews exist; narrow with --project)" : ""),
            );
        });
    previews
        .command("get")
        .argument("<previewId>", "the preview's id")
        .description("Show a preview and its recent deployments.")
        .action(async (previewId, _options, command) => {
            const workspace = await workspaceContext(io.context, {
                workingDir: io.workingDir ?? process.cwd(),
                profile: wants(command).profile,
            });
            const [preview, recent] = await Promise.all([
                getPreview(workspace.context, previewId, workspace.profile),
                listDeployments(workspace.context, previewId, workspace.profile),
            ]);
            print(command, { preview, deployments: recent.items }, () =>
                [
                    `Preview:  ${preview.slug} (${preview.id})`,
                    `Hostname: ${preview.hostname}`,
                    `Active:   ${preview.activeDeploymentId ?? "none"}`,
                    `Expires:  ${expiry(preview)}`,
                    "",
                    recent.items.length === 0
                        ? "No deployments."
                        : text([
                              ["DEPLOYMENT", "STATUS", "CREATED"],
                              ...recent.items.map((d) => [d.id, d.status, d.createdAt]),
                          ]),
                ].join("\n"),
            );
        });

    previews
        .command("extend")
        .argument("<previewId>", "the preview's id")
        .requiredOption("--ttl <duration>", "how much longer, such as 24h or 7d")
        .description(
            "Give a preview more time. It never shortens a lifetime and is capped at the server's maximum from now; a preview that never expired gets an expiry.",
        )
        .action(async (previewId, options, command) => {
            checkLifetime(options.ttl);
            const workspace = await workspaceContext(io.context, {
                workingDir: io.workingDir ?? process.cwd(),
                profile: wants(command).profile,
            });
            const preview = await extendPreview(workspace.context, previewId, {
                ttl: options.ttl,
                profile: workspace.profile,
            });
            print(command, preview, () => `${preview.slug} now expires ${expiry(preview)}.`);
        });
    previews
        .command("delete")
        .argument("<previewId>", "the preview's id")
        .option("--yes", "confirm: the preview and its site are removed for good")
        .description(
            "Delete a preview. This cannot be undone. It is queued and carried out by the worker; follow it with `previews deletion`.",
        )
        .action(async (previewId, options, command) => {
            if (!options.yes) {
                throw new CommanderError(
                    EXIT.usage,
                    "commander.missingConfirmation",
                    "error: deleting cannot be undone; pass --yes to confirm",
                );
            }
            const workspace = await workspaceContext(io.context, {
                workingDir: io.workingDir ?? process.cwd(),
                profile: wants(command).profile,
            });
            const profile = await effectiveProfile(workspace.context, workspace.profile);
            const result = await deletePreview(workspace.context, previewId, profile);
            print(
                command,
                result,
                () =>
                    `Deletion queued (operation ${result.operationId}). Follow it with: launchpad ${
                        profile ? `--profile ${shellArg(profile)} ` : ""
                    }previews deletion ${shellArg(previewId)}`,
            );
        });
    previews
        .command("deletion")
        .argument("<previewId>", "the preview's id")
        .description("Show a preview's latest deletion (by you or by expiry).")
        .action(async (previewId, _options, command) => {
            const workspace = await workspaceContext(io.context, {
                workingDir: io.workingDir ?? process.cwd(),
                profile: wants(command).profile,
            });
            const deletion = await previewDeletion(workspace.context, previewId, workspace.profile);
            print(command, deletion, () =>
                [
                    `Deletion: ${deletion.id} (${deletion.reason})`,
                    `Status:   ${deletion.status}`,
                    ...(deletion.failure
                        ? [`Note:     ${deletion.failure.message} [${deletion.failure.code}]`]
                        : []),
                    ...(deletion.status === "reconciliation-needed"
                        ? ["An administrator must check the host and resolve it in the dashboard."]
                        : []),
                ].join("\n"),
            );
        });

    const deployments = program.command("deployments").description("Deployments of a preview.");
    deployments
        .command("status")
        .argument("<deploymentId>", "the deployment's id")
        .option(
            "--organization <organization>",
            "organization id or slug, overriding launchpad.json",
        )
        .description("Show a deployment's status and failure.")
        .action(async (deploymentId, options, command) => {
            const workspace = await workspaceContext(io.context, {
                workingDir: io.workingDir ?? process.cwd(),
                profile: wants(command).profile,
                organization: options.organization,
            });
            const result = await getDeployment(workspace.context, deploymentId, workspace.profile);
            print(command, result, () =>
                [
                    `Deployment: ${result.id}`,
                    `Status:     ${result.status}`,
                    ...(result.failure
                        ? [`Failure:    ${result.failure.code}: ${result.failure.message}`]
                        : []),
                    `Created:    ${result.createdAt}`,
                    `Finished:   ${result.finishedAt ?? "-"}`,
                ].join("\n"),
            );
        });
    deployments
        .command("events")
        .argument("<deploymentId>", "the deployment's id")
        .option("--after <seq>", "only events after this sequence number", "0")
        .option(
            "--organization <organization>",
            "organization id or slug, overriding launchpad.json",
        )
        .description("Show a deployment's progress events.")
        .action(async (deploymentId, options, command) => {
            const after = Number(options.after);
            if (!Number.isInteger(after) || after < 0) {
                throw new CommanderError(
                    EXIT.usage,
                    "commander.invalidArgument",
                    "error: --after is a sequence number (0 or more)",
                );
            }
            const workspace = await workspaceContext(io.context, {
                workingDir: io.workingDir ?? process.cwd(),
                profile: wants(command).profile,
                organization: options.organization,
            });
            const result = await deploymentEvents(workspace.context, deploymentId, {
                after,
                profile: workspace.profile,
            });
            print(command, result, () =>
                result.items.length === 0
                    ? "No events."
                    : result.items.map((e) => `${e.seq}  [${e.phase}] ${e.message}`).join("\n"),
            );
        });

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
