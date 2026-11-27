// Replaces anything shaped like an API key, for text that may reach a terminal, a log
// or an MCP response.
export function redact(text: string): string {
    return (
        text
            .replace(/lp_[A-Za-z0-9_-]{8,}/g, "lp_[redacted]")
            // Backslash ends a token so an escaped quote in JSON text is never swallowed. A token is
            // 8 or more characters, or has a digit or . _ -, so prose ("the Bearer token") stays.
            .replace(
                /\bBearer\s+(?!\[redacted\])(?:[^\s"',;\\]{8,}|[^\s"',;\\]*[\d._-][^\s"',;\\]*)/gi,
                "Bearer [redacted]",
            )
            .replace(/__(Secure|Host)-([A-Za-z0-9._-]+)=[^\s;,"'\\]+/gi, "__$1-$2=[redacted]")
    );
}

// Values that are secret for this run only (a session cookie, a password), in the forms a server
// might echo them: as given, percent-encoded or decoded, and JSON-escaped. Short values are
// ignored so a stray word cannot blank out a whole message.
export function redactSecrets(text: string, secrets: Iterable<string>): string {
    const forms = new Set<string>();
    for (const secret of secrets) {
        if (secret.length < 8) continue;
        forms.add(secret);
        // A key echoed without its prefix.
        if (/^lp_/i.test(secret)) forms.add(secret.slice(3));
        forms.add(encodeURIComponent(secret));
        forms.add(JSON.stringify(secret).slice(1, -1));
        try {
            forms.add(decodeURIComponent(secret));
        } catch {
            // Not percent-encoded.
        }
    }
    let out = text;
    for (const form of [...forms]
        .filter((f) => f.length >= 8)
        .sort((a, b) => b.length - a.length)) {
        out = out.replace(
            new RegExp(form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
            "[redacted]",
        );
    }
    return out;
}
