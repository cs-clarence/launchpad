// What a caller must be able to tell apart, because the right response differs:
//
//   invalid-argument  nothing was sent; the input was refused locally
//   trust             the host key or credentials could not be trusted; nothing was sent
//   not-started       the connection failed before a session existed; the command did
//                     not run, so retrying is safe
//   failed            the remote command ran and reported failure
//   uncertain         the outcome is unknown (timeout, cancellation, dropped
//                     connection): the command may or may not have run. A mutating
//                     operation must be reconciled, never blindly retried.
export type DokkuErrorKind = "invalid-argument" | "trust" | "not-started" | "failed" | "uncertain";

export class DokkuError extends Error {
    readonly kind: DokkuErrorKind;
    readonly operation: string;
    // Whether the operation changes Dokku state. An uncertain read is harmless to retry.
    readonly mutating: boolean;
    readonly exitCode: number | null;
    // Bounded, sanitized remote output for operator logs. It is never part of `message`
    // and must not be returned to API clients.
    readonly detail: string;

    constructor(init: {
        kind: DokkuErrorKind;
        operation: string;
        message: string;
        mutating?: boolean;
        exitCode?: number | null;
        detail?: string;
    }) {
        super(init.message);
        this.name = "DokkuError";
        this.kind = init.kind;
        this.operation = init.operation;
        this.mutating = init.mutating ?? false;
        this.exitCode = init.exitCode ?? null;
        this.detail = init.detail ?? "";
    }
}

// True when a mutating operation may have taken effect and must be reconciled.
export const needsReconciliation = (error: unknown): boolean =>
    error instanceof DokkuError && error.kind === "uncertain" && error.mutating;

// Remote output as a single printable line, for logs.
export function sanitizeDetail(text: string, limit = 500): string {
    return [...text.slice(0, limit * 2)]
        .map((c) => (/[\p{Cc}\p{Cf}]/u.test(c) && c !== "\n" ? "?" : c))
        .join("")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, limit);
}
