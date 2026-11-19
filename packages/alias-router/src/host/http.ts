import { RouterError, type RouterErrorCode } from "../protocol";

const STATUS: Record<RouterErrorCode, number> = {
    invalid: 400,
    unauthorized: 401,
    conflict: 409,
    unavailable: 503,
};

const BASE = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

// Bodies are fixed text, never built from input, paths, SQLite messages or credentials.
export function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...BASE, "content-type": "application/json", ...extra },
    });
}

export function text(status: number, body: string, extra: Record<string, string> = {}): Response {
    return new Response(body, {
        status,
        headers: { ...BASE, "content-type": "text/plain; charset=utf-8", ...extra },
    });
}

export function errorStatus(error: unknown): number {
    return error instanceof RouterError ? STATUS[error.code] : 500;
}

export function errorName(error: unknown): string {
    return error instanceof RouterError ? error.code : "internal";
}
