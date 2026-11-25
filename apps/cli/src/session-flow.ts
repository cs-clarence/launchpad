import { createSessionClient, type LaunchpadSessionClient } from "@launchpad-kit/sdk";
import { describe, ExitWith } from "./errors";
import type { Io } from "./io";
import { readPassword } from "./password";

// Shell convention: 128 plus the signal number.
const SIGNALS = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;

export interface SessionFlowOptions {
    io: Io;
    // Normalized controller URL and normalized email.
    controller: string;
    email: string;
    passwordFile?: string;
    verbose?: boolean;
    // Keep the session in session.json instead of signing out (`--keep`, `login --session`).
    keep?: boolean;
    // Called with every secret the flow learns, so the output filter can hide it.
    remember(secret: string): void;
}

// One in-memory session for one command: signs in when first needed, signs out in `close`,
// and on SIGINT, SIGTERM or SIGHUP aborts what is running so the caller unwinds into `close`.
// A second signal leaves at once. Handlers exist only between the first sign-in step and `close`.
export class SessionFlow {
    private readonly abort = new AbortController();
    private client: LaunchpadSessionClient | null = null;
    private signingIn: Promise<LaunchpadSessionClient> | null = null;
    private listeners: Array<[NodeJS.Signals, () => void]> = [];
    // A session that is not ours to sign out: kept earlier, or kept just now.
    private kept = false;
    // The exit code of the signal that interrupted the command, if any.
    interruptedWith: number | null = null;

    constructor(private readonly options: SessionFlowOptions) {}

    get controller() {
        return this.options.controller;
    }

    get signal() {
        return this.abort.signal;
    }

    private install() {
        const hooks = this.options.io.signals;
        if (!hooks || this.listeners.length > 0) return;
        for (const [name, code] of Object.entries(SIGNALS) as Array<[NodeJS.Signals, number]>) {
            const listener = () => {
                if (this.interruptedWith !== null) return hooks.exit(code);
                this.interruptedWith = code;
                this.abort.abort();
            };
            hooks.on(name, listener);
            this.listeners.push([name, listener]);
        }
    }

    private uninstall() {
        const hooks = this.options.io.signals;
        for (const [name, listener] of this.listeners) hooks?.off(name, listener);
        this.listeners = [];
    }

    // Uses a session kept earlier: no prompt, no sign-out, no signal handlers.
    attach(cookie: string): LaunchpadSessionClient {
        const client = createSessionClient({
            baseUrl: this.options.controller,
            cookie,
            fetch: this.options.io.context.fetch,
        });
        this.options.remember(cookie);
        this.options.remember(cookie.slice(cookie.indexOf("=") + 1));
        this.client = client;
        this.kept = true;
        this.signingIn = Promise.resolve(client);
        return client;
    }

    // Signs in once; later callers share the result.
    signIn(): Promise<LaunchpadSessionClient> {
        this.signingIn ??= this.start();
        return this.signingIn;
    }

    private async start(): Promise<LaunchpadSessionClient> {
        const { io, controller, email } = this.options;
        this.install();
        io.err(`Signing in to ${controller} as ${email}.`);
        const password = await readPassword(io, {
            passwordFile: this.options.passwordFile,
            prompt: `Password for ${email}: `,
            signal: this.abort.signal,
        });
        this.options.remember(password);
        const client = createSessionClient({ baseUrl: controller, fetch: io.context.fetch });
        this.client = client;
        if (this.options.verbose) {
            io.err("> POST /api/auth/sign-in/email (the email and password are not shown)");
        }
        const { cookie } = await client.signIn(email, password, { signal: this.abort.signal });
        this.options.remember(cookie);
        this.options.remember(cookie.slice(cookie.indexOf("=") + 1));
        if (this.options.keep) await this.keep(cookie);
        return client;
    }

    // Replaces the saved session for this controller, then signs the one it replaced out, so no
    // old server session is orphaned. If saving fails the new session is signed out by `close`.
    private async keep(cookie: string) {
        const { io, controller, email } = this.options;
        const previous = await io.context.sessions.put({ controller, email, cookie });
        this.kept = true;
        io.err(
            "Session saved. It lasts until `launchpad logout --session`, or 7 days after its last use.",
        );
        if (!previous) return;
        this.options.remember(previous.cookie);
        try {
            const old = createSessionClient({
                baseUrl: controller,
                cookie: previous.cookie,
                fetch: io.context.fetch,
            });
            await old.signOut();
        } catch (error) {
            io.err(
                `Warning: could not sign the previous session out (${describe(error).message}). It ends on its own, at most 7 days after its last use.`,
            );
        }
    }

    // Revokes the session, best effort, and removes the signal handlers. A failure is a warning:
    // the session then ends on its own, at most 7 days after its last use.
    async close(): Promise<void> {
        const { io, controller } = this.options;
        try {
            const client = this.client;
            this.client = null;
            if (client?.cookie() && !this.kept) {
                if (this.options.verbose) io.err("> POST /api/auth/sign-out");
                try {
                    await client.signOut();
                } catch (error) {
                    io.err(
                        `Warning: could not sign out of ${controller} (${describe(error).message}). The session ends on its own, at most 7 days after its last use.`,
                    );
                }
            }
        } finally {
            this.uninstall();
        }
    }
}

// Runs a command that may start a session: whatever happens, the session is closed, and a
// signal that interrupted it becomes the matching exit code.
export async function withSession(
    io: Io,
    body: (holder: { flow?: SessionFlow }) => Promise<void>,
): Promise<void> {
    const holder: { flow?: SessionFlow } = {};
    try {
        await body(holder);
    } catch (error) {
        await holder.flow?.close();
        if (holder.flow?.interruptedWith != null) {
            io.err("Interrupted.");
            throw new ExitWith(holder.flow.interruptedWith);
        }
        throw error;
    }
    await holder.flow?.close();
    if (holder.flow?.interruptedWith != null) throw new ExitWith(holder.flow.interruptedWith);
}
