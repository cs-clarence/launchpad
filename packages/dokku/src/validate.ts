import { DokkuError } from "./errors";

// Everything that can reach the remote command line is checked here, against the
// narrowest pattern that serves the operation. Nothing is escaped or quoted:
// anything outside these shapes is refused.

// The only names the controller creates: `lp-` and ten lowercase letters or digits.
export const DEFAULT_APP_NAME = /^lp-[a-z0-9]{10}$/;

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const IMAGE_TAG =
    /^[a-z0-9][a-z0-9._-]{0,60}(\/[a-z0-9][a-z0-9._-]{0,60}){0,2}:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const PORT_MAPPING = /^(http|https):([0-9]{1,5}):([0-9]{1,5})$/;
// The last line of defence for every argument, including fixed literals: a plain
// word, or a long flag. Whitespace, quotes, `$`, `;`, `|`, `&`, backticks, newlines
// and a leading `-` on a value can never appear.
const SAFE_WORD = /^[A-Za-z0-9][A-Za-z0-9._:/@=,-]*$/;
const FIXED_FLAG = /^--[a-z][a-z-]*$/;

function refuse(operation: string, what: string): never {
    throw new DokkuError({
        kind: "invalid-argument",
        operation,
        message: `Refused: ${what} is not allowed.`,
    });
}

// A global or sticky expression remembers where its last match ended, which would make
// the same valid name pass once and fail the next time. Each check uses a fresh,
// stateless copy.
const stateless = (pattern: RegExp) =>
    new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ""));

export function appName(operation: string, value: unknown, pattern = DEFAULT_APP_NAME): string {
    if (typeof value !== "string" || !stateless(pattern).test(value))
        refuse(operation, "that app name");
    return value as string;
}

export function hostname(operation: string, value: unknown): string {
    if (typeof value !== "string" || !HOSTNAME.test(value)) refuse(operation, "that hostname");
    return value as string;
}

export function imageTag(operation: string, value: unknown): string {
    if (typeof value !== "string" || !IMAGE_TAG.test(value)) refuse(operation, "that image tag");
    return value as string;
}

export function portMapping(operation: string, value: unknown): string {
    const match = typeof value === "string" ? PORT_MAPPING.exec(value) : null;
    const ok = match && [match[2], match[3]].every((p) => Number(p) >= 1 && Number(p) <= 65535);
    if (!ok) refuse(operation, "that port mapping");
    return value as string;
}

// Applied to the finished command, so a mistake in a builder cannot reach ssh.
export function assertSafeArguments(operation: string, args: readonly string[]): void {
    if (args.length === 0 || args.length > 8) refuse(operation, "an empty or long command");
    args.forEach((arg, index) => {
        const ok = index === 0 ? SAFE_WORD.test(arg) : SAFE_WORD.test(arg) || FIXED_FLAG.test(arg);
        if (!ok) refuse(operation, "an argument");
    });
}
