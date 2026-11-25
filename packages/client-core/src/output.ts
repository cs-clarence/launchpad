import { stripVTControlCharacters } from "node:util";
import { redact, redactSecrets } from "./redact";

// Redact before and after escape removal: escapes can split key prefixes.
// Conservatively absorb any key-body suffix adjacent to a redacted placeholder.
// `secrets` are the values to hide for this run, such as a session cookie or a password.
export function safeOutput(text: string, secrets: Iterable<string> = []): string {
    const held = [...secrets];
    const hide = (value: string) => redact(redactSecrets(value, held));
    return hide(
        stripVTControlCharacters(hide(text))
            // Controls and invisible format characters (bidi overrides, zero-width and tag
            // characters, which can carry hidden text) go; newline and tab stay for layout.
            // The two joiners are real text (emoji sequences, Persian spelling) but can also
            // hide data, so they are shown as visible escapes instead of being deleted.
            .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, (c) =>
                c === "\n" || c === "\t"
                    ? c
                    : c === "\u200c" || c === "\u200d"
                      ? `\\u${c.codePointAt(0)!.toString(16)}`
                      : "",
            )
            .replace(/(\[redacted\])[A-Za-z0-9_-]+/g, "$1"),
    );
}
