import { ClientCoreError } from "@launchpad-kit/client-core";
import {
    LaunchpadApiError,
    type LaunchpadSessionClient,
    type RawOptions,
    type RawResponse,
} from "@launchpad-kit/sdk";
import { ExitWith } from "./errors";
import type { Io, SecretFile } from "./io";
import { SessionFlow, SignalGuard, withSession } from "./session-flow";
import { checkEmail, resolveSessionTarget } from "./session-target";

const FRESH_MS = 15 * 60 * 1000;

const bad = (message: string) => new ClientCoreError("bad-input", message);

export interface SessionRunOptions {
    io: Io;
    remember: (secret: string) => void;
    // The caller's guard, installed for the whole run (it also covers a `--secret-file`).
    guard?: SignalGuard;
    controller?: string;
    // The global `--profile`, else the profile named by launchpad.json.
    profile?: string;
    // `--email` as typed; checked here, and compared with a saved session's account.
    email?: string;
    passwordFile?: string;
    verbose?: boolean;
    keep?: boolean;
    // Warn when a saved session is older than 15 minutes and the call is one the controller
    // allows only after a recent sign-in. A function decides per request.
    needsFresh: boolean | ((method: string, path: string) => boolean);
    // Print `Acting as ...` on stderr once, after sign-in and before the first request. With
    // `chooseOrganization` the line names the organization it returns.
    acting?: boolean;
    // Picks the organization from the profile's or LAUNCHPAD_ORG (null if none) before any
    // sign-in; throwing here means nothing was asked or sent.
    chooseOrganization?: (fromTarget: string | null) => string;
    // Wording for a missing `--email` when no session is saved.
    missingEmail?: string;
}

// What a call is made through. Signing in happens at the first call, never before.
export interface SessionCaller {
    raw(method: string, path: string, rawOptions: RawOptions): Promise<RawResponse>;
    // Runs one typed SDK call with the signed-in client and a signal that a SIGINT aborts.
    use<T>(
        method: string,
        path: string,
        call: (client: LaunchpadSessionClient, signal: AbortSignal) => Promise<T>,
    ): Promise<T>;
}

export interface OpenSession {
    caller: SessionCaller;
    // What `chooseOrganization` returned, if given.
    organization: string | null;
    controller: string;
    // The account that signs in, or the saved session's.
    email: string;
    // From the profile or LAUNCHPAD_ORG, never from a key.
    organizationId: string | null;
}

// Resolves the target and the account (no prompt, no request) and prepares a session that signs
// in at its first call. `holder` lets `withSession` sign it out whatever happens.
export async function openSession(
    options: SessionRunOptions,
    holder: { flow?: SessionFlow },
): Promise<OpenSession> {
    const { io, guard } = options;
    const email = options.email === undefined ? null : checkEmail(options.email);
    const target = await resolveSessionTarget(io.context, {
        controller: options.controller,
        profile: options.profile,
    });
    // `--keep` always signs in again; otherwise a saved session for this controller is used.
    const saved = options.keep ? null : await io.context.sessions.get(target.controller);
    if (saved && email !== null && email !== saved.email) {
        throw bad(
            "--email differs from the saved session's account. Use `launchpad login --session` to switch, or `launchpad logout --session` first.",
        );
    }
    if (!saved && email === null) {
        throw bad(options.missingEmail ?? "--session needs --email <address> to sign in.");
    }
    const organization = options.chooseOrganization
        ? options.chooseOrganization(target.organizationId)
        : null;
    const actingEmail = saved?.email ?? email!;
    const flow = new SessionFlow({
        io,
        controller: target.controller,
        email: actingEmail,
        passwordFile: options.passwordFile,
        verbose: options.verbose,
        keep: options.keep,
        guard,
        remember: options.remember,
    });
    holder.flow = flow;
    if (saved) flow.attach(saved.cookie);
    let announced = false;
    const prepare = async (method: string, path: string) => {
        const client = await flow.signIn();
        if (options.acting && !announced) {
            announced = true;
            io.err(
                `Acting as ${actingEmail} on ${target.controller}${
                    organization === null ? "" : `, organization ${organization}`
                }`,
            );
        }
        const fresh =
            typeof options.needsFresh === "function"
                ? options.needsFresh(method, path)
                : options.needsFresh;
        if (saved && fresh && Date.now() - Date.parse(saved.savedAt) > FRESH_MS) {
            io.err(
                "Warning: this saved session is older than 15 minutes, and issuing a key needs a sign-in from the last 15 minutes. Run `launchpad login --session` again if the controller refuses.",
            );
        }
        return client;
    };
    const guarded = async <T>(work: () => Promise<T>): Promise<T> => {
        try {
            return await work();
        } catch (error) {
            if (saved && error instanceof LaunchpadApiError && error.status === 401) {
                await io.context.sessions.remove(target.controller, saved.cookie);
                throw new ClientCoreError(
                    "not-logged-in",
                    "The saved session is no longer valid and was removed. Sign in again with `launchpad login --session`.",
                );
            }
            throw error;
        }
    };
    const caller: SessionCaller = {
        raw: async (method, path, rawOptions) => {
            const client = await prepare(method, path);
            return guarded(() =>
                client.raw(method, path, {
                    ...rawOptions,
                    signal: rawOptions.signal
                        ? AbortSignal.any([flow.signal, rawOptions.signal])
                        : flow.signal,
                }),
            );
        },
        use: async (method, path, call) => {
            const client = await prepare(method, path);
            return guarded(() => call(client, flow.signal));
        },
    };
    return {
        caller,
        controller: target.controller,
        email: actingEmail,
        organization,
        organizationId: target.organizationId,
    };
}

// Opens a session, runs the callback and always closes the session (signing out unless kept);
// a signal that interrupted it becomes the matching exit code.
export function runWithSession<T>(
    options: SessionRunOptions,
    body: (session: {
        client: SessionCaller;
        email: string;
        controller: string;
        organization: string | null;
    }) => Promise<T>,
): Promise<T> {
    let result!: T;
    return withSession(options.io, async (holder) => {
        const open = await openSession(options, holder);
        result = await body({
            client: open.caller,
            email: open.email,
            controller: open.controller,
            organization: open.organization,
        });
    }).then(() => result);
}

// Runs `body` under one guard (when a secret file is wanted) that is installed before the file
// exists, so a signal at any point removes an empty secret file instead of leaving it to make
// the next run fail with "already exists". The file is created before anything is sent, and
// removed on any failure; a signal becomes its exit code.
export async function withSecretFile(
    io: Io,
    path: string | undefined,
    body: (context: { guard?: SignalGuard; secretFile?: SecretFile }) => Promise<void>,
): Promise<void> {
    const guard = path !== undefined ? new SignalGuard(io) : undefined;
    guard?.install();
    let secretFile: SecretFile | undefined;
    try {
        if (path !== undefined) {
            try {
                secretFile = await io.createSecretFile(path);
            } catch (error) {
                throw bad(
                    error instanceof Error ? error.message : "The secret file cannot be created.",
                );
            }
        }
        await body({ guard, secretFile });
        if (guard?.interruptedWith != null) throw new ExitWith(guard.interruptedWith);
    } catch (error) {
        await secretFile?.remove().catch(() => {});
        if (guard?.interruptedWith != null) {
            if (!(error instanceof ExitWith)) io.err("Interrupted.");
            throw new ExitWith(guard.interruptedWith);
        }
        throw error;
    } finally {
        guard?.uninstall();
    }
}
