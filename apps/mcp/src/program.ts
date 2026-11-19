import { Command } from "@commander-js/extra-typings";

/** Parse startup only. The server is read-only until the app model adds tools that change things;
 * those will have their own explicit startup opt-ins, fixed here and not widenable by a tool call.
 */
export function startupOptions(argv: string[], write: (text: string) => void) {
    const program = new Command()
        .name("launchpad-mcp")
        .description("Local stdio MCP server, read-only. Shared mode takes working_dir per call.")
        .option("--shared", "no implicit working directory; serve multiple project contexts")
        .option("--working-dir <directory>", "absolute default directory for tool calls")
        .option("--profile <name>", "default credential profile")
        .exitOverride()
        .configureOutput({ writeOut: write, writeErr: write });
    program.parse(argv, { from: "user" });
    const options = program.opts();
    return {
        shared: options.shared,
        workingDir: options.workingDir,
        profile: options.profile,
    };
}
