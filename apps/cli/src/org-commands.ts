import type { Command } from "@commander-js/extra-typings";
import { ClientCoreError } from "@launchpad-kit/client-core";
import { ORGANIZATION_ROLES, type OrganizationRoleName, slugSchema } from "@launchpad-kit/sdk";
import {
    type ActionDeps,
    addSessionOptions,
    checkPathId,
    checkRole,
    describeAction,
    printer,
    runAction,
    type SharedOptions,
} from "./session-actions";
import { checkEmail } from "./session-target";
import { text } from "./table";

const bad = (message: string) => new ClientCoreError("bad-input", message);

// `org create` joins the existing `org` group; `member` is a group of its own.
export function addOrgCommands(
    program: Command<any, any, any>,
    org: Command<any, any, any>,
    deps: ActionDeps,
    wants: (command: Command<any, any, any>) => { json?: boolean },
) {
    const { io } = deps;
    const print = printer(io, wants);

    addSessionOptions(
        org
            .command("create")
            .description(
                describeAction(
                    "Create an organization with an existing user as its first owner (the instance operator only; the operator gets no membership).",
                    "POST /organizations",
                ),
            )
            .requiredOption("--name <name>", "the organization's name")
            .requiredOption("--slug <slug>", "the organization's slug")
            .requiredOption("--owner-email <address>", "the existing user who becomes the owner"),
        { org: false, write: true },
    ).action(
        async (
            options: SharedOptions & { name: string; slug: string; ownerEmail: string },
            command,
        ) => {
            let ownerEmail = "";
            await runAction(
                deps,
                command,
                {
                    write: true,
                    org: false,
                    needsFresh: false,
                    validate: () => {
                        if (options.name.trim().length === 0)
                            throw bad("--name must not be empty.");
                        if (!slugSchema.safeParse(options.slug).success) {
                            throw bad(
                                "--slug must be a valid slug (lowercase letters, digits and hyphens).",
                            );
                        }
                        ownerEmail = checkEmail(options.ownerEmail, "--owner-email");
                    },
                },
                options,
                async ({ client }) => {
                    const created = await client.use("POST", "/organizations", (c, signal) =>
                        c.organizations.create(
                            { name: options.name, slug: options.slug, ownerEmail },
                            { signal },
                        ),
                    );
                    print(
                        command,
                        created,
                        () =>
                            `Created organization ${created.slug} (${created.id}) with owner ${ownerEmail}.`,
                    );
                },
            );
        },
    );

    const member = program
        .command("member")
        .description("Members of an organization (your own account's session, not a key).");

    addSessionOptions(
        member
            .command("list")
            .description(
                describeAction(
                    "List the organization's members; their user IDs are what `member remove` takes.",
                    "GET /organizations/:org/members",
                ),
            ),
        { org: true, write: false },
    ).action(async (options: SharedOptions, command) => {
        await runAction(
            deps,
            command,
            { write: false, org: true, needsFresh: false },
            options,
            async ({ client, organization }) => {
                const members = await client.use("GET", "/members", (c, signal) =>
                    c.members.list(organization, { signal }),
                );
                print(command, members, () =>
                    members.length === 0
                        ? "No members."
                        : text([
                              ["USER ID", "EMAIL", "NAME", "ROLE"],
                              ...members.map((m) => [m.userId, m.email, m.name, m.role]),
                          ]),
                );
            },
        );
    });

    addSessionOptions(
        member
            .command("add")
            .description(
                describeAction(
                    "Add an existing user to the organization (owner or admin; an admin may assign only deployer and viewer, which the controller decides).",
                    "POST /organizations/:org/members",
                ),
            )
            .requiredOption("--user-email <address>", "the existing user to add")
            .requiredOption("--role <role>", `their role (${ORGANIZATION_ROLES.join(", ")})`),
        { org: true, write: true },
    ).action(async (options: SharedOptions & { userEmail: string; role: string }, command) => {
        let email = "";
        let role: OrganizationRoleName = "viewer";
        await runAction(
            deps,
            command,
            {
                write: true,
                org: true,
                needsFresh: false,
                validate: () => {
                    email = checkEmail(options.userEmail, "--user-email");
                    role = checkRole(options.role);
                },
            },
            options,
            async ({ client, organization }) => {
                const added = await client.use("POST", "/members", (c, signal) =>
                    c.members.add(organization, { email, role }, { signal }),
                );
                print(command, added, () => `Added ${email} to ${organization} as ${added.role}.`);
            },
        );
    });

    addSessionOptions(
        member
            .command("remove")
            .description(
                describeAction(
                    "Remove a member, or leave by removing yourself (owner or admin; the last owner cannot be removed).",
                    "DELETE /organizations/:org/members/:userId",
                ),
            )
            .argument("<user-id>", "the user ID, as `member list` prints it"),
        { org: true, write: true },
    ).action(async (userId: string, options: SharedOptions, command) => {
        await runAction(
            deps,
            command,
            {
                write: true,
                org: true,
                needsFresh: false,
                validate: () => void checkPathId(userId, "user-id", false),
            },
            options,
            async ({ client, organization }) => {
                const result = await client.use("DELETE", "/members/:userId", (c, signal) =>
                    c.members.remove(organization, userId, { signal }),
                );
                print(command, result, () => `Removed ${userId} from ${organization}.`);
            },
        );
    });
}
