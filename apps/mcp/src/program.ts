import { Command, CommanderError } from "@commander-js/extra-typings";

export interface DeployPolicy {
    include: string[];
    exclude: string[];
    allowProjects: string[];
}

const collect = (value: string, previous: string[]) => [...previous, value];

/** Parse startup only. Deployment is off unless `--allow-deploy` is given together
 * with explicit include and exclude lists; those lists are fixed here and cannot be
 * widened by a tool call or by launchpad.json.
 */
export function startupOptions(argv: string[], write: (text: string) => void) {
    const program = new Command()
        .name("launchpad-mcp")
        .description(
            "Local stdio MCP server, read-only unless --allow-deploy is given. Shared mode takes working_dir per call.\n\nWARNING: with --allow-deploy the client chooses working_dir and there is no list of allowed roots, so broad --include patterns let a model publish any matching file this process can read. Keep patterns narrow, and run under a restricted account or sandbox if directory isolation matters.",
        )
        .option("--shared", "no implicit working directory; serve multiple project contexts")
        .option("--working-dir <directory>", "absolute default directory for tool calls")
        .option("--profile <name>", "default credential profile")
        .option("--allow-deploy", "offer the deploy tool (needs --include and --exclude)")
        .option(
            "--include <glob>",
            "files that may be deployed, relative to working_dir (repeatable)",
            collect,
            [] as string[],
        )
        .option(
            "--exclude <glob>",
            "files never deployed, relative to working_dir; always wins over --include (repeatable)",
            collect,
            [] as string[],
        )
        .option(
            "--allow-project <project>",
            "restrict deployment to this project id (repeatable); a slug is not accepted, as it can name another project under another profile or organization",
            collect,
            [] as string[],
        )
        .exitOverride()
        .configureOutput({ writeOut: write, writeErr: write });
    program.parse(argv, { from: "user" });
    const options = program.opts();
    const wanted = options.include.length + options.exclude.length + options.allowProject.length;
    if (!options.allowDeploy && wanted > 0) {
        throw new CommanderError(
            2,
            "launchpad.deployPolicy",
            "error: --include, --exclude and --allow-project need --allow-deploy",
        );
    }
    if (options.allowDeploy && (options.include.length === 0 || options.exclude.length === 0)) {
        throw new CommanderError(
            2,
            "launchpad.deployPolicy",
            "error: --allow-deploy needs at least one --include and one --exclude (excludes always win)",
        );
    }
    const notIds = options.allowProject.filter(
        (p) => !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(p),
    );
    if (notIds.length > 0) {
        throw new CommanderError(
            2,
            "launchpad.deployPolicy",
            "error: --allow-project takes a project id (see: launchpad projects list)",
        );
    }
    const deploy: DeployPolicy | undefined = options.allowDeploy
        ? {
              include: options.include,
              exclude: options.exclude,
              allowProjects: options.allowProject.map((p) => p.toLowerCase()),
          }
        : undefined;
    return {
        shared: options.shared,
        workingDir: options.workingDir,
        profile: options.profile,
        deploy,
    };
}
