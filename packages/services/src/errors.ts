export type ServiceErrorCode =
    | "not-found"
    | "forbidden"
    | "conflict"
    | "invalid"
    | "delivery-failed"
    | "too-large"
    | "timeout";

// Expected, caller-visible failures. Adapters map the code to a transport status;
// anything else is an unexpected failure and must not leak details.
export class ServiceError extends Error {
    constructor(
        readonly code: ServiceErrorCode,
        message: string,
    ) {
        super(message);
        this.name = "ServiceError";
    }
}

// Bun SQL reports the PostgreSQL SQLSTATE in `errno`; `code` is a generic label.
export function isUniqueViolation(error: unknown): boolean {
    const candidate = error as { errno?: string; code?: string };
    return candidate?.errno === "23505" || candidate?.code === "23505";
}
