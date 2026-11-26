import { readFileSync } from "node:fs";
import { ERROR_CODES } from "@launchpad-kit/contracts";
import { describe, expect, it } from "vitest";

// A guard, not a proof: every `code: "..."` literal and every key of the service-error STATUS
// map in the files that answer the API must be a documented error code. It catches a new literal
// nobody added to the enum (as `schema-mismatch` once was). The behavioral tests parse real
// bodies with errorSchema.
const FILES = [
    "./api.ts",
    "../routes/api.$.ts",
    "./runtime.ts",
    "./database-problem.ts",
    "./admission.ts",
    "./body-framing.ts",
];
const source = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");

describe("emitted error codes", () => {
    it("are all in ERROR_CODES", () => {
        const found = new Set<string>();
        for (const file of FILES) {
            const text = source(file);
            for (const match of text.matchAll(/\bcode:\s*"([a-z-]+)"/g)) found.add(match[1]!);
        }
        const status = /const STATUS = \{([^}]*)\}/.exec(source("./api.ts"))![1]!;
        for (const match of status.matchAll(/^\s*"?([a-z-]+)"?:\s*\d+/gm)) found.add(match[1]!);
        expect(found.size).toBeGreaterThan(8);
        for (const code of found) {
            expect(ERROR_CODES as readonly string[], code).toContain(code);
        }
    });
});
