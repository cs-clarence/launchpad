import { Command, CommanderError } from "@commander-js/extra-typings";

export interface DeployPolicy {
    include: string[];
    exclude: string[];
    allowProjects: string[];
}

// Deleting a preview cannot be undone, so it is offered only for projects named at startup.
export interface DeletePolicy {
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
            "Local stdio MCP server, read-only unless --allow-deploy or --allow-delete is given. Shared mode takes working_dir per call.\n\nWARNING: with --allow-deploy the client chooses working_dir and there is no list of allowed roots, so broad --include patterns let a model publish any matching file this process can read. Keep patterns narrow, and run under a restricted account or sandbox if directory isolation matters.",
        )
        .option("--shared", "no implicit working directory; serve multiple project contexts")
        .option("--working-dir <directory>", "absolute default directory for tool calls")
        .option("--profile <name>", "default credential profile")
        .option("--allow-deploy", "offer the deploy tool (needs --include and --exclude)")
        .option(
            "--allow-delete",
            "offer the delete_preview tool, for the projects given with --allow-delete-project (at least one is required)",
        )
        .option(
            "--allow-delete-project <project>",
            "allow deleting previews of this project id (repeatable); separate from --allow-project, which limits deployment",
            collect,
            [] as string[],
        )
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
    if (!options.allowDeploy && options.include.length + options.exclude.length > 0) {
        throw new CommanderError(
            2,
            "launchpad.deployPolicy",
            "error: --include and --exclude need --allow-deploy",
        );
    }
    if (!options.allowDeploy && options.allowProject.length > 0) {
        throw new CommanderError(
            2,
            "launchpad.deployPolicy",
            "error: --allow-project needs --allow-deploy",
        );
    }
    if (options.allowDelete && options.allowDeleteProject.length === 0) {
        throw new CommanderError(
            2,
            "launchpad.deletePolicy",
            "error: --allow-delete needs at least one --allow-delete-project <project-id>: deleting cannot be undone, so it is allowed only where you say",
        );
    }
    if (!options.allowDelete && options.allowDeleteProject.length > 0) {
        throw new CommanderError(
            2,
            "launchpad.deletePolicy",
            "error: --allow-delete-project needs --allow-delete",
        );
    }
    if (options.allowDeploy && (options.include.length === 0 || options.exclude.length === 0)) {
        throw new CommanderError(
            2,
            "launchpad.deployPolicy",
            "error: --allow-deploy needs at least one --include and one --exclude (excludes always win)",
        );
    }
    const notIds = [...options.allowProject, ...options.allowDeleteProject].filter(
        (p) => !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(p),
    );
    if (notIds.length > 0) {
        throw new CommanderError(
            2,
            "launchpad.deployPolicy",
            "error: --allow-project and --allow-delete-project take a project id (see: launchpad projects list)",
        );
    }
    const deploy: DeployPolicy | undefined = options.allowDeploy
        ? {
              include: options.include,
              exclude: options.exclude,
              allowProjects: options.allowProject.map((p) => p.toLowerCase()),
          }
        : undefined;
    const deletion: DeletePolicy | undefined = options.allowDelete
        ? { allowProjects: options.allowDeleteProject.map((p) => p.toLowerCase()) }
        : undefined;
    return {
        shared: options.shared,
        workingDir: options.workingDir,
        profile: options.profile,
        deploy,
        deletion,
    };
}
