import type { DokkuConnection } from "./connection";
import { DokkuError, sanitizeDetail } from "./errors";
import { SshTransport, type Transport, type TransportResult } from "./transport";
import { verifyConnectionShape, verifyHostKeys, verifyPrivateKey } from "./trust";
import {
    appName,
    assertSafeArguments,
    DEFAULT_APP_NAME,
    hostname,
    imageTag,
    portMapping,
} from "./validate";

export interface DokkuClientOptions {
    transport?: Transport;
    // Tests of the real SSH transport substitute a stand-in executable.
    sshBinary?: string;
    // Defaults to the controller's generated names. Live tests widen it deliberately.
    appNamePattern?: RegExp;
    timeoutsMs?: Partial<Record<"quick" | "mutate" | "load", number>>;
    maxOutputBytes?: number;
}

const DEFAULT_TIMEOUTS = { quick: 15_000, mutate: 60_000, load: 10 * 60_000 };

// ssh's own diagnostics for a failure before any session existed. Remote output shares
// the same stream, so a mere substring is no evidence: a line counts only when it has
// ssh's exact form, anchored at both ends.
const DECISIVE = [
    /^Host key verification failed\.$/,
    /^ssh: connect to host \S+ port \d+: (Connection refused|Connection timed out|No route to host|Network is unreachable)$/,
    /^ssh: Could not resolve hostname \S+: .+$/,
    /^\S+@\S+: Permission denied \(.+\)\.?$/,
    /^Unable to negotiate with \S+ port \d+: no matching host key type found\..*$/,
    /^Load key ".+": .+$/,
    /^ssh could not be started$/,
];
// The rest of the warning ssh prints when a pinned key no longer matches.
const BANNER = [
    /^@+.*@+$/,
    /^IT IS POSSIBLE THAT/,
    /^Someone could be eavesdropping/,
    /^It is also possible that/,
    /^The fingerprint for the \S+ key sent by the remote host is/,
    /^SHA256:\S+\.?$/,
    /^Please contact your system administrator\.$/,
    /^Add correct host key in \S+ to get rid of this message\.$/,
    /^Offending \S+ key in \S+:\d+$/,
    /^Host key for \S+ has changed and you have requested strict checking\.$/,
    /^The \S+ host key for \S+ has changed/,
];

// True only when the command certainly never ran: ssh reported a local connection
// failure in its exact words, said nothing else, and the remote produced no output
// and received no input.
export function failedBeforeConnecting(result: TransportResult): boolean {
    if (result.stdout !== "" || result.stdinBytes > 0 || result.truncated) return false;
    const lines = result.stderr
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
    return (
        lines.some((l) => DECISIVE.some((p) => p.test(l))) &&
        lines.every((l) => DECISIVE.some((p) => p.test(l)) || BANNER.some((p) => p.test(l)))
    );
}

// Decides what a finished run means. ssh itself exits 255 for its own failures, which
// is the only exit status that is not the remote command's.
export function classify(
    operation: string,
    mutating: boolean,
    result: TransportResult,
): "ok" | DokkuError {
    const detail = sanitizeDetail(result.stderr || result.stdout);
    const fail = (kind: "not-started" | "failed" | "uncertain", message: string): DokkuError =>
        new DokkuError({
            kind,
            operation,
            mutating,
            exitCode: result.exitCode,
            detail,
            message,
        });
    if (result.timedOut) return fail("uncertain", `Dokku ${operation} timed out.`);
    if (result.aborted) return fail("uncertain", `Dokku ${operation} was cancelled.`);
    if (result.exitCode === 0) return "ok";
    if (result.exitCode === null) {
        return fail("uncertain", `Dokku ${operation} ended without an exit status.`);
    }
    if (result.exitCode === 255) {
        return failedBeforeConnecting(result)
            ? fail("not-started", `Dokku ${operation} could not connect.`)
            : fail("uncertain", `The connection for Dokku ${operation} was lost.`);
    }
    return fail("failed", `Dokku ${operation} failed.`);
}

// The only operations the controller can ask Dokku for. There is deliberately no way
// to run another command: a new operation is a new, validated function here.
export function createDokkuClient(connection: DokkuConnection, options: DokkuClientOptions = {}) {
    verifyConnectionShape(connection);
    const transport =
        options.transport ?? new SshTransport(connection, { sshBinary: options.sshBinary });
    const pattern = options.appNamePattern ?? DEFAULT_APP_NAME;
    const timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeoutsMs };
    const maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;

    // Trust is checked before every command and a failure sends nothing. A success is
    // not remembered: the files are checked again, so a key that is replaced or loosened
    // while running is noticed.
    async function trusted(): Promise<void> {
        await verifyHostKeys(connection);
        await verifyPrivateKey(connection);
    }

    async function execute(
        operation: string,
        mutating: boolean,
        args: string[],
        timeout: keyof typeof timeouts,
        extra: { stdin?: AsyncIterable<Uint8Array>; signal?: AbortSignal } = {},
    ): Promise<TransportResult> {
        assertSafeArguments(operation, args);
        // Already told to stop: nothing is sent, so the command certainly did not run.
        if (extra.signal?.aborted) {
            throw new DokkuError({
                kind: "not-started",
                operation,
                mutating,
                message: `Dokku ${operation} was cancelled before it started.`,
            });
        }
        await trusted();
        const result = await transport.run({
            args,
            stdin: extra.stdin,
            timeoutMs: timeouts[timeout],
            maxOutputBytes,
            signal: extra.signal,
        });
        const outcome = classify(operation, mutating, result);
        if (outcome !== "ok") throw outcome;
        return result;
    }

    return {
        apps: {
            create: async (app: string, signal?: AbortSignal) => {
                const name = appName("apps:create", app, pattern);
                await execute("apps:create", true, ["apps:create", name], "mutate", { signal });
            },
            // The remote reports a missing app with exit status 1 and says so; any other
            // failure is an error, not "false".
            exists: async (app: string, signal?: AbortSignal) => {
                const name = appName("apps:exists", app, pattern);
                try {
                    await execute("apps:exists", false, ["apps:exists", name], "quick", { signal });
                    return true;
                } catch (error) {
                    // Exit status 1 and this app named in the message: other failures that
                    // happen to say "does not exist" (a missing config file, say) are errors.
                    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                    if (
                        error instanceof DokkuError &&
                        error.kind === "failed" &&
                        error.exitCode === 1 &&
                        new RegExp(`\\bApp ${escaped} does not exist`, "i").test(error.detail)
                    ) {
                        return false;
                    }
                    throw error;
                }
            },
            destroy: async (app: string, signal?: AbortSignal) => {
                const name = appName("apps:destroy", app, pattern);
                await execute("apps:destroy", true, ["apps:destroy", name, "--force"], "mutate", {
                    signal,
                });
            },
        },
        domains: {
            set: async (app: string, host: string, signal?: AbortSignal) => {
                const name = appName("domains:set", app, pattern);
                const domain = hostname("domains:set", host);
                await execute("domains:set", true, ["domains:set", name, domain], "mutate", {
                    signal,
                });
            },
        },
        ports: {
            set: async (app: string, mapping: string, signal?: AbortSignal) => {
                const name = appName("ports:set", app, pattern);
                const ports = portMapping("ports:set", mapping);
                await execute("ports:set", true, ["ports:set", name, ports], "mutate", { signal });
            },
        },
        git: {
            // Streams a `docker save` archive; Dokku deploys the app from it. The long
            // timeout covers a large image, and a dropped connection is `uncertain`.
            loadImage: async (
                app: string,
                tag: string,
                archive: AsyncIterable<Uint8Array>,
                signal?: AbortSignal,
            ) => {
                const name = appName("git:load-image", app, pattern);
                const image = imageTag("git:load-image", tag);
                await execute("git:load-image", true, ["git:load-image", name, image], "load", {
                    stdin: archive,
                    signal,
                });
            },
        },
        ps: {
            // Whether Dokku has the app's processes running / deployed.
            report: async (app: string, signal?: AbortSignal) => {
                const name = appName("ps:report", app, pattern);
                const flag = async (which: "running" | "deployed") => {
                    const result = await execute(
                        `ps:report`,
                        false,
                        ["ps:report", name, `--${which}`],
                        "quick",
                        { signal },
                    );
                    const value = result.stdout.trim().toLowerCase();
                    if (value !== "true" && value !== "false") {
                        throw new DokkuError({
                            kind: "failed",
                            operation: "ps:report",
                            message: "Dokku ps:report returned an unexpected answer.",
                            detail: sanitizeDetail(result.stdout),
                        });
                    }
                    return value === "true";
                };
                return { running: await flag("running"), deployed: await flag("deployed") };
            },
        },
    };
}

export type DokkuClient = ReturnType<typeof createDokkuClient>;
