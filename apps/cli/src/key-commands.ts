import type { Command } from "@commander-js/extra-typings";
import { ClientCoreError } from "@launchpad-kit/client-core";
import {
    API_KEY_SCOPES,
    type ApiKeyScopeName,
    LaunchpadApiError,
    LaunchpadConfigError,
    LaunchpadTransportError,
    MAX_KEY_LIFETIME_DAYS,
} from "@launchpad-kit/sdk";
import type { Io } from "./io";
import {
    type ActionDeps,
    addSessionOptions,
    checkPathId,
    collect,
    describeAction,
    isUuid,
    runAction,
    type SharedOptions,
} from "./session-actions";
import { text } from "./table";

const bad = (message: string) => new ClientCoreError("bad-input", message);

const MAY_EXIST = 'The key may exist: run "launchpad key list" and revoke it.';

// After the key request was sent without a usable answer, the key may exist: the message says so
// and the exit code stays the underlying error's.
function ambiguous(error: unknown, io: Io): unknown {
    if (error instanceof LaunchpadApiError) {
        return new LaunchpadApiError({
            status: error.status,
            code: error.code,
            title: `${error.title} ${MAY_EXIST}`,
            retryAfterSeconds: error.retryAfterSeconds ?? undefined,
        });
    }
    if (error instanceof LaunchpadTransportError) {
        return new LaunchpadTransportError(error.reason, `${error.message} ${MAY_EXIST}`);
    }
    io.err(MAY_EXIST);
    return error;
}

// The controller refused with an answer that says no key exists (400 to 499 but not a timeout or
// throttle, which say nothing about whether the request was processed).
const refused = (error: unknown) =>
    error instanceof LaunchpadApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429;

export function addKeyCommands(
    program: Command<any, any, any>,
    deps: ActionDeps,
    wants: (command: Command<any, any, any>) => { json?: boolean },
) {
    const { io, remember } = deps;
    const print = (command: Command<any, any, any>, data: unknown, human: () => string) =>
        io.out(wants(command).json ? JSON.stringify(data, null, 2) : human());

    const key = program
        .command("key")
        .description("API keys of an organization (your own account's session, not a key).");

    addSessionOptions(
        key
            .command("list")
            .description(
                describeAction(
                    "List the organization's API keys, never their secrets.",
                    "GET /organizations/:org/api-keys",
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
                const keys = await client.use("GET", "/api-keys", (c, signal) =>
                    c.apiKeys.list(organization, { signal }),
                );
                print(command, keys, () =>
                    keys.length === 0
                        ? "No API keys."
                        : text([
                              [
                                  "ID",
                                  "NAME",
                                  "PREFIX",
                                  "STATUS",
                                  "SCOPES",
                                  "PROJECTS",
                                  "EXPIRES",
                                  "LAST USED",
                              ],
                              ...keys.map((k) => [
                                  k.id,
                                  k.name,
                                  k.prefix,
                                  k.status,
                                  k.scopes.join(","),
                                  k.projectIds ? k.projectIds.join(",") : "all",
                                  k.expiresAt,
                                  k.lastUsedAt ?? "never",
                              ]),
                          ]),
                );
            },
        );
    });

    addSessionOptions(
        key
            .command("issue")
            .description(
                describeAction(
                    "Issue an API key and write its secret to a new file; the screen never shows it.",
                    "POST /organizations/:org/api-keys",
                    "Needs an owner or admin signed in within the last 15 minutes. If the request fails without a clear answer the key may exist: run `launchpad key list` and revoke it. ",
                ),
            )
            .requiredOption("--name <name>", "the key's name")
            .option(
                "--scope <scope>",
                `a scope to grant (repeatable; one of ${API_KEY_SCOPES.join(", ")})`,
                collect,
                [] as string[],
            )
            .option(
                "--project <id>",
                "limit the key to this project (repeatable; not with project:create)",
                collect,
                [] as string[],
            )
            .requiredOption(
                "--expires-in-days <n>",
                `lifetime in days, 1 to ${MAX_KEY_LIFETIME_DAYS}`,
            )
            .requiredOption(
                "--secret-file <path>",
                "create this new file (mode 0600) before the request and write the secret to it",
            ),
        { org: true, write: true },
    ).action(
        async (
            options: SharedOptions & {
                name: string;
                scope: string[];
                project: string[];
                expiresInDays: string;
                secretFile: string;
            },
            command,
        ) => {
            let scopes: ApiKeyScopeName[] = [];
            let days = 0;
            await runAction(
                deps,
                command,
                {
                    write: true,
                    org: true,
                    needsFresh: true,
                    secretFile: options.secretFile,
                    validate: () => {
                        if (options.name.trim().length === 0)
                            throw bad("--name must not be empty.");
                        if (options.scope.length === 0) {
                            throw bad(`Give at least one --scope (${API_KEY_SCOPES.join(", ")}).`);
                        }
                        for (const scope of options.scope) {
                            if (!(API_KEY_SCOPES as readonly string[]).includes(scope)) {
                                throw bad(`--scope must be one of ${API_KEY_SCOPES.join(", ")}.`);
                            }
                        }
                        scopes = options.scope as ApiKeyScopeName[];
                        if (!/^\d{1,4}$/.test(options.expiresInDays)) {
                            throw bad(
                                `--expires-in-days must be a whole number from 1 to ${MAX_KEY_LIFETIME_DAYS}.`,
                            );
                        }
                        days = Number(options.expiresInDays);
                        if (days < 1 || days > MAX_KEY_LIFETIME_DAYS) {
                            throw bad(
                                `--expires-in-days must be a whole number from 1 to ${MAX_KEY_LIFETIME_DAYS}.`,
                            );
                        }
                        for (const project of options.project) {
                            if (!isUuid(project))
                                throw bad("--project must be a project ID (a UUID).");
                        }
                        if (options.project.length > 0 && scopes.includes("project:create")) {
                            throw bad("A project-limited API key cannot create projects.");
                        }
                    },
                },
                options,
                async ({ client, organization, secretFile }) => {
                    let sent = false;
                    let captured = false;
                    try {
                        const created = await client.use("POST", "/api-keys", (c, signal) => {
                            sent = true;
                            return c.apiKeys.issue(
                                organization,
                                {
                                    name: options.name,
                                    scopes,
                                    ...(options.project.length > 0
                                        ? { projectIds: options.project }
                                        : {}),
                                    expiresInDays: days,
                                },
                                {
                                    signal,
                                    // Written before the answer is parsed, so a parse problem
                                    // cannot lose the only copy of the secret.
                                    onSecret: async (secret) => {
                                        if (!secret.startsWith("lp_")) remember(secret);
                                        captured = true;
                                        try {
                                            await secretFile!.write(`${secret}\n`);
                                        } catch {
                                            throw new ClientCoreError(
                                                "store-unavailable",
                                                `The key was created but could not be written to ${options.secretFile}. It exists: run "launchpad key list" and revoke it.`,
                                            );
                                        }
                                    },
                                },
                            );
                        });
                        if (!captured) {
                            throw new LaunchpadTransportError(
                                "invalid-response",
                                "The controller's answer had no secret.",
                            );
                        }
                        print(
                            command,
                            { ...created, secret: `[written to ${options.secretFile}]` },
                            () =>
                                `Issued key ${created.name} (${created.id}), expires ${created.expiresAt}. The secret is in ${options.secretFile}.`,
                        );
                    } catch (error) {
                        if (!sent || error instanceof LaunchpadConfigError) throw error;
                        if (captured) {
                            if (error instanceof ClientCoreError) throw error;
                            io.err(
                                `Warning: the key was issued and its secret is in ${options.secretFile}, but the controller's answer could not be read. Run "launchpad key list" to see it.`,
                            );
                            throw error;
                        }
                        if (refused(error)) throw error;
                        throw ambiguous(error, io);
                    }
                },
            );
        },
    );

    addSessionOptions(
        key
            .command("revoke")
            .description(
                describeAction(
                    "Revoke an API key (revoking it again is fine).",
                    "DELETE /organizations/:org/api-keys/:id",
                ),
            )
            .argument("<key-id>", "the key's ID, as `key list` prints it"),
        { org: true, write: true },
    ).action(async (keyId: string, options: SharedOptions, command) => {
        await runAction(
            deps,
            command,
            {
                write: true,
                org: true,
                needsFresh: false,
                validate: () => void checkPathId(keyId, "key-id", true),
            },
            options,
            async ({ client, organization }) => {
                const result = await client.use("DELETE", "/api-keys/:id", (c, signal) =>
                    c.apiKeys.revoke(organization, keyId, { signal }),
                );
                print(command, result, () => `Revoked key ${keyId}.`);
            },
        );
    });
}
