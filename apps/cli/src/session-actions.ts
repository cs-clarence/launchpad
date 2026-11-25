import type { Command } from "@commander-js/extra-typings";
import { ClientCoreError, readWorkspace, requireConfirmation } from "@launchpad-kit/client-core";
import { ORGANIZATION_ROLES, type OrganizationRoleName } from "@launchpad-kit/sdk";
import type { Io } from "./io";
import { refuseWithKey } from "./session-target";
import { runWithSession, withSecretFile, type SessionCaller } from "./session-run";
import type { SignalGuard } from "./session-flow";
import type { SecretFile } from "./io";

const bad = (message: string) => new ClientCoreError("bad-input", message);

export interface ActionDeps {
    io: Io;
    remember: (secret: string) => void;
}

export interface SharedOptions {
    email?: string;
    passwordFile?: string;
    controller?: string;
    keep?: true;
    org?: string;
    confirm?: true;
}

export const LOCKOUT_NOTE =
    "Every run without --keep or a saved session is a new sign-in, and sign-ins are throttled: " +
    "more than 5 a minute are refused and also block that account's dashboard sign-in. For " +
    "batches use --keep, then `launchpad logout --session`. A kept session goes stale for " +
    "`key issue` after 15 minutes (sign in again then).";

// The description every command carries: what it does, the one API call it makes, the lockout note.
export const describeAction = (summary: string, call: string, extra = "") =>
    `${summary} Calls ${call}, with your own account's session (an email and password sign-in). ${extra}${LOCKOUT_NOTE}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string) => UUID.test(value);

// An ID typed as an argument: what the `list` verbs print. Only path-safety is checked here;
// the controller decides whether it exists.
export function checkPathId(value: string, what: string, uuid: boolean): string {
    if (
        value.length === 0 ||
        value.length > 256 ||
        value === "." ||
        value === ".." ||
        /[\u0000-\u001f\u007f]/.test(value) ||
        (uuid && !isUuid(value))
    ) {
        throw bad(
            `<${what}> must be ${uuid ? "an ID (a UUID) as the list command prints it" : "a valid ID"}.`,
        );
    }
    return value;
}

// Prints a result as a table or sentence, or as pretty JSON with `--json`.
export function printer(io: Io, wants: (command: Command<any, any, any>) => { json?: boolean }) {
    return (command: Command<any, any, any>, data: unknown, human: () => string) =>
        io.out(wants(command).json ? JSON.stringify(data, null, 2) : human());
}

export function checkRole(value: string): OrganizationRoleName {
    if (!(ORGANIZATION_ROLES as readonly string[]).includes(value)) {
        throw bad(`--role must be one of ${ORGANIZATION_ROLES.join(", ")}.`);
    }
    return value as OrganizationRoleName;
}

export function collect(value: string, previous: string[] = []) {
    return [...previous, value];
}

// The options every command shares, with the meaning `api --session` gives them.
export function addSessionOptions<C extends Command<any, any, any>>(
    command: C,
    kinds: { org: boolean; write: boolean },
): C {
    command
        .option(
            "--email <address>",
            "the account that signs in (optional with a saved session; a different one is refused)",
        )
        .option(
            "--password-file <path>",
            "read the password from this private file, not the prompt",
        )
        .option(
            "--keep",
            "save the session (session.json, owner-only) instead of signing out; later commands reuse it until `launchpad logout --session`",
        )
        .option(
            "--controller <url>",
            "the controller (else the selected profile's, else LAUNCHPAD_CONTROLLER)",
        );
    if (kinds.org) {
        command.option(
            "--org <id>",
            "the organization's ID (a UUID, not a slug; else launchpad.json, LAUNCHPAD_ORG, the profile)",
        );
    }
    if (kinds.write) command.option("--confirm", "confirm this change");
    return command;
}

export interface ActionSpec {
    // Shown nowhere; the commander command name is used for messages.
    write: boolean;
    org: boolean;
    needsFresh: boolean;
    // Checked after the key and --confirm refusals and before anything is asked or sent.
    validate?: () => void;
    secretFile?: string;
}

export interface ActionContext {
    client: SessionCaller;
    email: string;
    controller: string;
    organization: string;
    secretFile?: SecretFile;
    guard?: SignalGuard;
}

const ORG_HINT =
    "Use the organization's ID: find it in the dashboard or with `launchpad api --session organizations`.";

// Runs one session-only command. Everything that can be refused is refused first, so a refusal
// means no prompt, no sign-in and no request: a key in the environment, a missing --confirm,
// bad input, and an organization that is not an ID.
export async function runAction(
    deps: ActionDeps,
    command: Command<any, any, any>,
    spec: ActionSpec,
    options: SharedOptions,
    body: (context: ActionContext) => Promise<void>,
): Promise<void> {
    const { io, remember } = deps;
    refuseWithKey(io.context, "This command");
    if (spec.write) requireConfirmation(options.confirm);
    spec.validate?.();
    const { profile } = command.optsWithGlobals() as { profile?: string };
    let named: { value: string; source: string } | null = null;
    let workspaceProfile: string | undefined;
    if (spec.org) {
        if (options.org !== undefined) named = { value: options.org, source: "--org" };
        const workspace = await readWorkspace(io.workingDir ?? process.cwd());
        workspaceProfile = workspace.config?.profile;
        if (!named && workspace.config?.organization) {
            named = { value: workspace.config.organization, source: "launchpad.json" };
        }
        if (named && !isUuid(named.value)) {
            throw bad(
                `${named.source} must be an organization ID (a UUID), not a slug. ${ORG_HINT}`,
            );
        }
    }
    await withSecretFile(io, spec.secretFile, ({ guard, secretFile }) =>
        runWithSession(
            {
                io,
                remember,
                guard,
                controller: options.controller,
                profile: profile ?? workspaceProfile,
                email: options.email,
                passwordFile: options.passwordFile,
                keep: options.keep,
                needsFresh: spec.needsFresh,
                acting: true,
                missingEmail: "--email <address> is needed to sign in (no saved session).",
                chooseOrganization: spec.org
                    ? (fromTarget) => {
                          if (named) return named.value;
                          if (fromTarget === null) {
                              throw bad(
                                  "No organization: use --org <id>, launchpad.json, LAUNCHPAD_ORG or a profile's organization.",
                              );
                          }
                          if (!isUuid(fromTarget)) {
                              throw bad(
                                  `The organization from LAUNCHPAD_ORG or the profile must be an organization ID (a UUID), not a slug. ${ORG_HINT}`,
                              );
                          }
                          return fromTarget;
                      }
                    : undefined,
            },
            ({ client, email, controller, organization }) =>
                body({
                    client,
                    email,
                    controller,
                    organization: organization ?? "",
                    secretFile,
                    guard,
                }),
        ),
    );
}
