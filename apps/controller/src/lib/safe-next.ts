// Only same-site paths are honoured after sign-in. The value is resolved the way a
// browser would (backslashes and stripped tabs included) and must stay on this
// origin, so `/\evil.com`, `/%09/evil.com` or `//evil.com` cannot leave the site.
export function safeNext(value: unknown): string | undefined {
    if (typeof value !== "string" || !value.startsWith("/")) {
        return undefined;
    }
    try {
        const resolved = new URL(value, "http://launchpad.invalid");
        if (resolved.origin !== "http://launchpad.invalid") {
            return undefined;
        }
        // `/a/..//evil.com` normalizes to `//evil.com`, a protocol-relative reference.
        if (resolved.pathname.startsWith("//")) {
            return undefined;
        }
        return resolved.pathname + resolved.search + resolved.hash;
    } catch {
        return undefined;
    }
}
