import { ClientCoreError } from "@launchpad-kit/client-core";
import { createSessionClient, LaunchpadApiError } from "@launchpad-kit/sdk";
import { describe } from "./errors";
import type { Io } from "./io";
import { SessionFlow, withSession } from "./session-flow";
import { checkEmail, refuseWithKey, resolveSessionTarget } from "./session-target";

export interface SessionOptions {
    email?: string;
    passwordFile?: string;
    controller?: string;
    profile?: string;
    json?: boolean;
}

const bad = (message: string) => new ClientCoreError("bad-input", message);

// `launchpad login --session`: sign in and keep the session, with no call. An existing entry for
// the controller is signed out and replaced, whatever its account.
export async function sessionLogin(
    io: Io,
    options: SessionOptions,
    remember: (secret: string) => void,
): Promise<void> {
    refuseWithKey(io.context, "--session");
    if (options.email === undefined) throw bad("--session needs --email <address> to sign in.");
    const email = checkEmail(options.email);
    await withSession(io, async (holder) => {
        const target = await resolveSessionTarget(io.context, {
            controller: options.controller,
            profile: options.profile,
        });
        const flow = new SessionFlow({
            io,
            controller: target.controller,
            email,
            passwordFile: options.passwordFile,
            keep: true,
            remember,
        });
        holder.flow = flow;
        await flow.signIn();
        io.out(
            options.json
                ? JSON.stringify({ controller: target.controller, email }, null, 2)
                : `Signed in to ${target.controller} as ${email}.`,
        );
    });
}

// `launchpad logout --session`: revoke the saved session, then delete the entry even if the
// controller could not be reached. `--email` is not needed and not used.
export async function sessionLogout(
    io: Io,
    options: SessionOptions,
    remember: (secret: string) => void,
): Promise<void> {
    refuseWithKey(io.context, "--session");
    const target = await resolveSessionTarget(io.context, {
        controller: options.controller,
        profile: options.profile,
    });
    const saved = await io.context.sessions.get(target.controller);
    if (!saved) {
        io.out(
            options.json
                ? JSON.stringify(
                      { controller: target.controller, signedOut: false, localEntryRemoved: false },
                      null,
                      2,
                  )
                : `No saved session for ${target.controller}.`,
        );
        return;
    }
    remember(saved.cookie);
    remember(saved.cookie.slice(saved.cookie.indexOf("=") + 1));
    // Confirmed only if the controller signed it out, or says it was already over.
    let revoked = true;
    try {
        await createSessionClient({
            baseUrl: target.controller,
            cookie: saved.cookie,
            fetch: io.context.fetch,
        }).signOut();
    } catch (error) {
        // A 401 means the server already ended it, which is what was asked for.
        if (!(error instanceof LaunchpadApiError && error.status === 401)) {
            revoked = false;
            io.err(
                `Warning: could not sign out of ${target.controller} (${describe(error).message}). The session ends on its own, at most 7 days after its last use.`,
            );
        }
    }
    await io.context.sessions.remove(target.controller, saved.cookie);
    io.out(
        options.json
            ? JSON.stringify(
                  {
                      controller: target.controller,
                      email: saved.email,
                      signedOut: revoked,
                      localEntryRemoved: true,
                  },
                  null,
                  2,
              )
            : revoked
              ? `Signed ${saved.email} out of ${target.controller} and removed the saved session.`
              : `Removed the saved session for ${saved.email} at ${target.controller}, but the controller did not confirm the sign-out: it may still accept the old cookie until it expires (at most 7 days after its last use).`,
    );
}
