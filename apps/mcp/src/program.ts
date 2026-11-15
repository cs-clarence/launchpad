import { Command } from "@commander-js/extra-typings";

/** Parse startup only. Deploy options are deliberately absent until slice 2. */
export function startupOptions(argv: string[], write: (text: string) => void) {
    const program = new Command()
        .name("launchpad-mcp")
        .description("Read-only local stdio MCP server. Shared mode takes working_dir per call.")
        .option("--shared", "no implicit working directory; serve multiple project contexts")
        .option("--working-dir <directory>", "absolute default directory for tool calls")
        .option("--profile <name>", "default credential profile")
        .exitOverride()
        .configureOutput({ writeOut: write, writeErr: write });
    program.parse(argv, { from: "user" });
    return program.opts();
}
