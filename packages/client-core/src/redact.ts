// Replaces anything shaped like an API key, for text that may reach a terminal, a log
// or an MCP response.
export function redact(text: string): string {
    return text.replace(/lp_[A-Za-z0-9_-]{8,}/g, "lp_[redacted]");
}
