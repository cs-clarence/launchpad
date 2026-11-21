import { Command } from "@commander-js/extra-typings";

/** Mutation policy is fixed at startup and cannot be widened by a tool call. */
export function startupOptions(argv: string[], write: (text: string) => void) {
    const program = new Command()
        .name("launchpad-mcp")
        .description("Local stdio MCP server. Shared mode takes working_dir per call.")
        .option("--shared", "no implicit working directory; serve multiple project contexts")
        .option("--working-dir <directory>", "absolute default directory for tool calls")
        .option("--profile <name>", "default credential profile")
        .option("--allow-deploy", "enable deploying already uploaded artifacts")
        .option("--allow-promote", "enable pointing aliases at deployments")
        .option("--allow-alias-manage", "enable creating and withdrawing aliases")
        .option("--allowed-projects <ids...>", "exact project UUIDs allowed for mutations")
        .exitOverride()
        .configureOutput({ writeOut: write, writeErr: write });
    program.parse(argv, { from: "user" });
    const options = program.opts();
    return {
        shared: options.shared,
        workingDir: options.workingDir,
        profile: options.profile,
        allowDeploy: options.allowDeploy,
        allowPromote: options.allowPromote,
        allowAliasManage: options.allowAliasManage,
        allowedProjects: options.allowedProjects,
    };
}
