import type { Command } from "@commander-js/extra-typings";
import {
    appClient,
    checkLocation,
    packDirectory,
    readArchive,
    requireConfirmation,
    workspaceContext,
    type Context,
} from "@launchpad-kit/client-core";
import { realpath } from "node:fs/promises";
import path from "node:path";

export function addAppCommands(
    program: Command<any, any, any>,
    context: Context,
    workingDir: string,
    out: (text: string) => void,
) {
    const open = async (command: Command<any, any, any>) => {
        const { profile } = command.optsWithGlobals() as { profile?: string };
        const workspace = await workspaceContext(context, { workingDir, profile });
        return appClient(workspace.context, workspace.profile);
    };
    // Pretty JSON is human-readable and preserves exact IDs, generations and statuses.
    const show = (value: unknown) => out(JSON.stringify(value, null, 2));

    const app = program.command("app").description("Manage apps and immutable deployments.");
    app.command("list").action(async (_options, command) => {
        const { client, organizationId } = await open(command);
        show(await client.apps.list(organizationId));
    });
    app.command("create <project-id> <slug>").action(async (projectId, slug, _options, command) => {
        const { client, organizationId } = await open(command);
        show(await client.apps.create(organizationId, projectId, { slug }));
    });
    app.command("deploy <app-id>")
        .description("Deploy an uploaded archive to its own URL. Never promotes.")
        .requiredOption("--artifact <id>", "uploaded artifact ID")
        .option("--spa", "enable single-page application fallback")
        .option("--ttl <duration>", "retention deadline, such as 7d")
        .action(async (appId, options, command) => {
            const { client, organizationId } = await open(command);
            show(
                await client.deployments.create(organizationId, appId, {
                    artifactId: options.artifact,
                    spa: options.spa,
                    ttl: options.ttl,
                }),
            );
        });
    app.command("deployments <app-id>").action(async (appId, _options, command) => {
        const { client, organizationId } = await open(command);
        show(await client.deployments.list(organizationId, appId));
    });
    app.command("shutdown <app-id>")
        .description(
            "Withdraw all aliases before deleting the app's deployments; repeat to resume.",
        )
        .option("--confirm", "confirm destructive shutdown")
        .action(async (appId, options, command) => {
            requireConfirmation(options.confirm);
            const { client, organizationId } = await open(command);
            show(await client.apps.shutdown(organizationId, appId));
        });

    const artifacts = program.command("artifact").description("Upload static site archives.");
    artifacts
        .command("upload <project-id> <path>")
        .description("Upload a .tar.gz file or pack a static output directory.")
        .option("--directory", "pack the given directory rather than reading a .tar.gz")
        .action(async (projectId, source, options, command) => {
            const file = path.resolve(workingDir, source);
            const store = await realpath(context.store.directory).catch(
                () => context.store.directory,
            );
            const location = await realpath(file);
            checkLocation(location, [store]);
            const packed = options.directory
                ? await packDirectory(file, undefined, {
                      include: ["**/*"],
                      exclude: ["**/launchpad.json"],
                      prefix: "",
                      protectedPaths: [store],
                  })
                : await readArchive(file);
            const { client, organizationId } = await open(command);
            const archive = new Blob([new Uint8Array(packed.archive)]);
            show(await client.artifacts.upload(organizationId, projectId, archive));
        });

    const deployment = program.command("deployment").description("Inspect or delete deployments.");
    deployment.command("get <deployment-id>").action(async (id, _options, command) => {
        const { client, organizationId } = await open(command);
        show(await client.deployments.get(organizationId, id));
    });
    deployment
        .command("events <deployment-id>")
        .option("--after <seq>", "read after this event sequence")
        .action(async (id, options, command) => {
            const { client, organizationId } = await open(command);
            show(await client.deployments.events(organizationId, id, { after: options.after }));
        });
    deployment
        .command("delete <deployment-id>")
        .option("--confirm", "confirm deletion")
        .action(async (id, options, command) => {
            requireConfirmation(options.confirm);
            const { client, organizationId } = await open(command);
            show(await client.deployments.delete(organizationId, id));
        });

    const alias = program
        .command("alias")
        .description("Read and explicitly change stable aliases.");
    alias.command("list <app-id>").action(async (appId, _options, command) => {
        const { client, organizationId } = await open(command);
        show(await client.aliases.list(organizationId, appId));
    });
    alias.command("create <app-id> <slug>").action(async (appId, slug, _options, command) => {
        const { client, organizationId } = await open(command);
        show(await client.aliases.create(organizationId, appId, { slug }));
    });
    alias.command("operations <alias-id>").action(async (id, _options, command) => {
        const { client, organizationId } = await open(command);
        show(await client.aliases.operations(organizationId, id));
    });
    alias
        .command("promote <alias-id> <deployment-id>")
        .description("Point an alias at a deployment, including rollback to a retained deployment.")
        .requiredOption(
            "--expected-generation <generation>",
            "alias's last read reserved generation",
        )
        .requiredOption(
            "--idempotency-key <key>",
            "reuse the same key when retrying this exact request",
        )
        .option("--confirm", "confirm changing the live alias target")
        .action(async (id, targetDeploymentId, options, command) => {
            requireConfirmation(options.confirm);
            const { client, organizationId } = await open(command);
            show(
                await client.aliases.promote(
                    organizationId,
                    id,
                    {
                        targetDeploymentId,
                        expectedGeneration: options.expectedGeneration,
                    },
                    { idempotencyKey: options.idempotencyKey },
                ),
            );
        });
    alias
        .command("withdraw <alias-id>")
        .description("Permanently withdraw an alias hostname.")
        .requiredOption(
            "--expected-generation <generation>",
            "alias's last read reserved generation",
        )
        .requiredOption(
            "--idempotency-key <key>",
            "reuse the same key when retrying this exact request",
        )
        .option("--confirm", "confirm permanent withdrawal")
        .action(async (id, options, command) => {
            requireConfirmation(options.confirm);
            const { client, organizationId } = await open(command);
            show(
                await client.aliases.withdraw(
                    organizationId,
                    id,
                    {
                        expectedGeneration: options.expectedGeneration,
                    },
                    { idempotencyKey: options.idempotencyKey },
                ),
            );
        });
}
