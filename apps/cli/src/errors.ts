import { ClientCoreError, redact } from "@launchpad/client-core";
import { LaunchpadApiError, LaunchpadConfigError, LaunchpadTransportError } from "@launchpad/sdk";
import { CommanderError } from "@commander-js/extra-typings";

// Stable exit codes, for scripts and CI.
export const EXIT = {
    ok: 0,
    failure: 1, // unexpected, or an error status not listed below
    usage: 2, // bad arguments or options
    unauthorized: 3, // not logged in, or the key is invalid, expired, revoked or lacks permission
    notFound: 4,
    transport: 5, // the controller could not be reached, or timed out, or sent something unexpected
    local: 6, // the credential file, or a profile, is unusable
} as const;

export interface Failure {
    exitCode: number;
    code: string;
    message: string;
    status?: number;
}

export function describe(error: unknown): Failure {
    if (error instanceof CommanderError) {
        return {
            exitCode: EXIT.usage,
            code: "usage",
            message: redact(error.message.replace(/^error: /, "")),
        };
    }
    if (error instanceof LaunchpadApiError) {
        const exitCode =
            error.status === 401 || error.status === 403
                ? EXIT.unauthorized
                : error.status === 404
                  ? EXIT.notFound
                  : EXIT.failure;
        return { exitCode, code: error.code, message: redact(error.title), status: error.status };
    }
    if (error instanceof LaunchpadTransportError) {
        return { exitCode: EXIT.transport, code: error.reason, message: redact(error.message) };
    }
    if (error instanceof LaunchpadConfigError) {
        return { exitCode: EXIT.usage, code: "bad-input", message: redact(error.message) };
    }
    if (error instanceof ClientCoreError) {
        return {
            exitCode:
                error.code === "not-logged-in"
                    ? EXIT.unauthorized
                    : error.code === "bad-input"
                      ? EXIT.usage
                      : EXIT.local,
            code: error.code,
            message: redact(error.message),
        };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: EXIT.failure, code: "failure", message: redact(message) };
}
