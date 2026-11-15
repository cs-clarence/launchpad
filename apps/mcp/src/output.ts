import { ClientCoreError, safeOutput } from "@launchpad/client-core";
import { LaunchpadApiError, LaunchpadConfigError, LaunchpadTransportError } from "@launchpad/sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// Both representations (text and structuredContent) fit inside a 64 KiB result.
const MAX_PAYLOAD_BYTES = 30 * 1024;

function clean(value: unknown): unknown {
    if (typeof value === "string") return safeOutput(value);
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [safeOutput(key), clean(item)]),
        );
    }
    return value;
}

/** Controller text is untrusted data. Preserve valid JSON, redact keys and strip
 * controls; refuse oversized results rather than emit invalid or partial objects.
 */
export function toolResult(data: unknown, isError = false): CallToolResult {
    let result = { data: clean(data), truncated: false };
    let text = JSON.stringify(result);
    if (Buffer.byteLength(text) > MAX_PAYLOAD_BYTES) {
        result = {
            data: {
                code: "output-too-large",
                message: "Narrow the query or request a smaller page.",
            },
            truncated: true,
        };
        text = JSON.stringify(result);
        isError = true;
    }
    return { content: [{ type: "text", text }], structuredContent: result, isError };
}

export function toolError(error: unknown): CallToolResult {
    if (error instanceof LaunchpadApiError) {
        return toolResult({ code: error.code, message: error.title, status: error.status }, true);
    }
    if (error instanceof ClientCoreError) {
        return toolResult({ code: error.code, message: error.message }, true);
    }
    if (error instanceof LaunchpadTransportError) {
        return toolResult(
            { code: error.reason, message: "Could not get a usable controller response." },
            true,
        );
    }
    if (error instanceof LaunchpadConfigError) {
        return toolResult(
            { code: "bad-input", message: "The controller configuration is invalid." },
            true,
        );
    }
    return toolResult({ code: "internal", message: "The operation could not be completed." }, true);
}
