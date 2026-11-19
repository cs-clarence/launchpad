// Exact lists, so every rule is testable (docs/plans/production-alias-router.md, R2 amendments).

const HOP_BY_HOP = new Set([
    "connection",
    "keep-alive",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
]);

const REQUEST_DROPPED = new Set([
    ...HOP_BY_HOP,
    "host",
    "content-length",
    "authorization",
    "forwarded",
    "via",
    "x-real-ip",
]);

// Headers a client sent that the upstream may see. `Host` is replaced by the caller and the
// router adds no forwarding headers of its own; `Cookie` passes through.
export function forwardableRequestHeaders(headers: Headers): Record<string, string> {
    const connection = connectionNames(headers.get("connection") ?? undefined);
    const result: Record<string, string> = {};
    headers.forEach((value, rawName) => {
        const name = rawName.toLowerCase();
        if (
            REQUEST_DROPPED.has(name) ||
            connection.has(name) ||
            name.startsWith("proxy-") ||
            name.startsWith("x-forwarded-") ||
            name.startsWith("x-launchpad-")
        ) {
            return;
        }
        result[name] = value;
    });
    return result;
}

// `Location` and `Set-Cookie` pass through unchanged (a known leak of the immutable hostname that
// the alias model must record, not something this layer rewrites).
export function isResponseHeaderForwarded(name: string, connection: Set<string>): boolean {
    const lower = name.toLowerCase();
    return !HOP_BY_HOP.has(lower) && !connection.has(lower);
}

export function connectionNames(value: string | undefined): Set<string> {
    const names = new Set<string>();
    for (const part of (value ?? "").split(",")) {
        const name = part.trim().toLowerCase();
        if (name) names.add(name);
    }
    return names;
}
