import type { Command } from "@commander-js/extra-typings";
import { ORGANIZATION_ROLES, type OrganizationRoleName } from "@launchpad-kit/sdk";
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

export function addInviteCommands(
    program: Command<any, any, any>,
    deps: ActionDeps,
    wants: (command: Command<any, any, any>) => { json?: boolean },
) {
    const print = printer(deps.io, wants);
    const invite = program
        .command("invite")
        .description(
            "Email invitations to an organization (your own account's session, not a key).",
        );

    addSessionOptions(
        invite
            .command("create")
            .description(
                describeAction(
                    'Invite someone by email (owner or admin). Needs invitation enrollment and SMTP on the controller (else 404 "Invitations are not enabled."); if the mail cannot be sent the controller answers 502 and has already revoked the invitation. The token is emailed and never shown.',
                    "POST /organizations/:org/invitations",
                ),
            )
            .requiredOption("--to <address>", "the address to invite")
            .requiredOption("--role <role>", `their role (${ORGANIZATION_ROLES.join(", ")})`),
        { org: true, write: true },
    ).action(async (options: SharedOptions & { to: string; role: string }, command) => {
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
                    email = checkEmail(options.to, "--to");
                    role = checkRole(options.role);
                },
            },
            options,
            async ({ client, organization }) => {
                const created = await client.use("POST", "/invitations", (c, signal) =>
                    c.invitations.create(organization, { email, role }, { signal }),
                );
                // Only the documented fields: never anything else the controller might send.
                const shown = { id: created.id, email: created.email, role: created.role };
                print(
                    command,
                    shown,
                    () =>
                        `Invited ${shown.email} as ${shown.role} (${shown.id}). The invitation was emailed.`,
                );
            },
        );
    });

    addSessionOptions(
        invite
            .command("list")
            .description(
                describeAction(
                    "List the organization's pending invitations (owner or admin).",
                    "GET /organizations/:org/invitations",
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
                const found = await client.use("GET", "/invitations", (c, signal) =>
                    c.invitations.list(organization, { signal }),
                );
                const shown = found.map((i) => ({
                    id: i.id,
                    email: i.email,
                    role: i.role,
                    createdAt: i.createdAt,
                    expiresAt: i.expiresAt,
                }));
                print(command, shown, () =>
                    shown.length === 0
                        ? "No invitations."
                        : text([
                              ["ID", "EMAIL", "ROLE", "CREATED", "EXPIRES"],
                              ...shown.map((i) => [
                                  i.id,
                                  i.email,
                                  i.role,
                                  i.createdAt,
                                  i.expiresAt,
                              ]),
                          ]),
                );
            },
        );
    });

    addSessionOptions(
        invite
            .command("revoke")
            .description(
                describeAction(
                    "Revoke a pending invitation (owner or admin).",
                    "DELETE /organizations/:org/invitations/:id",
                ),
            )
            .argument("<invitation-id>", "the invitation's ID, as `invite list` prints it"),
        { org: true, write: true },
    ).action(async (invitationId: string, options: SharedOptions, command) => {
        await runAction(
            deps,
            command,
            {
                write: true,
                org: true,
                needsFresh: false,
                validate: () => void checkPathId(invitationId, "invitation-id", true),
            },
            options,
            async ({ client, organization }) => {
                const result = await client.use("DELETE", "/invitations/:id", (c, signal) =>
                    c.invitations.revoke(organization, invitationId, { signal }),
                );
                print(command, result, () => `Revoked invitation ${invitationId}.`);
            },
        );
    });
}
