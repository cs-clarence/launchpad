// Raised when the database and this build disagree about the schema (as opposed to the
// database being unreachable): the one failure an operator fixes with `migrate` or a restore.
export class SchemaMismatchError extends Error {
    override name = "SchemaMismatchError";
}

export type DatabaseErrorKind = "unreachable" | "schema";

// Bun SQL puts a generic label in `code` and, for errors the server sent, the PostgreSQL
// SQLSTATE in `errno`. Only shapes seen against a real server are listed (connection refused
// and timeout from the driver; 57P01 and 57P03 while the server stopped; 42P01 and 42703 for
// a missing table or column); anything else is not classified and stays an internal error.
const UNREACHABLE_LABELS = new Set([
    "ERR_POSTGRES_CONNECTION_REFUSED",
    "ERR_POSTGRES_CONNECTION_TIMEOUT",
]);
const UNREACHABLE_SQLSTATES = new Set(["57P01", "57P03", "53300"]);
const SCHEMA_SQLSTATES = new Set(["42P01", "42703"]);

// Libraries such as Better Auth wrap a database failure in their own error and keep the original
// as `cause`, so the chain is followed (a few levels, in case it loops).
export function classifyDatabaseError(error: unknown, depth = 0): DatabaseErrorKind | null {
    const own = classifyOwn(error);
    if (own || depth >= 4 || typeof error !== "object" || error === null) return own;
    return classifyDatabaseError((error as { cause?: unknown }).cause, depth + 1);
}

function classifyOwn(error: unknown): DatabaseErrorKind | null {
    if (error instanceof SchemaMismatchError) {
        return "schema";
    }
    if (typeof error !== "object" || error === null) {
        return null;
    }
    const { code, errno } = error as { code?: unknown; errno?: unknown };
    if (typeof code === "string" && UNREACHABLE_LABELS.has(code)) {
        return "unreachable";
    }
    if (typeof errno === "string") {
        if (UNREACHABLE_SQLSTATES.has(errno) || errno.startsWith("08")) {
            return "unreachable";
        }
        if (SCHEMA_SQLSTATES.has(errno)) {
            return "schema";
        }
    }
    return null;
}
