import { stripVTControlCharacters } from "node:util";
import { redact } from "@launchpad/client-core";

// Redact first: an escape may consume the "l" of "lp_", hiding the prefix from
// the matcher. Redact again after stripping to catch escape-split key tokens.
// Strip escape sequences (including OSC hyperlinks) before remaining controls.
// Keep newline/tab for human layout. JSON's escaped values stay valid JSON and
// cannot execute terminal controls while being printed as serialized text.
export function safeOutput(text: string): string {
    return redact(
        stripVTControlCharacters(redact(text)).replace(/[\p{Cc}]/gu, (c) =>
            c === "\n" || c === "\t" ? c : "",
        ),
    );
}
