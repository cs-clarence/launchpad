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

// Local ssh failures that happen before any session exists: the command did not run.
const NOT_STARTED = [
    /host key verification failed/i,
    /remote host identification has changed/i,
    /no (matching|supported) host key/i,
    /permission denied \(/i,
    /connection refused/i,
    /could not resolve hostname/i,
    /connection timed out/i,
    /no route to host/i,
    /network is unreachable/i,
    /identity file .* not accessible/i,
    /load key .*: /i,
    /ssh could not be started/i,
];

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
        return NOT_STARTED.some((pattern) => pattern.test(result.stderr))
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
                    if (
                        error instanceof DokkuError &&
                        error.kind === "failed" &&
                        /does not exist/i.test(error.detail)
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
