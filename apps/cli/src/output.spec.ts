import { describe, expect, it } from "vitest";
import { safeOutput } from "./output";

describe("terminal output", () => {
    it("removes escape sequences and control bytes but preserves newlines and tabs", () => {
        expect(safeOutput("\u001b[31mname\u001b[0m\u0007\r\n\tvalue\u009b")).toBe("name\n\tvalue");
        expect(safeOutput("\u001b]8;;https://evil.example.com\u0007label\u001b]8;;\u0007")).toBe(
            "label",
        );
    });

    it("redacts keys and leaves serialized JSON valid", () => {
        const key = `lp_${"a".repeat(43)}`;
        const printed = safeOutput(JSON.stringify({ title: "\u001b[31mname", code: key }));
        expect(JSON.parse(printed)).toMatchObject({ code: "lp_[redacted]" });
        expect(printed).not.toContain(key);
        expect(printed).not.toContain("\u001b");
    });
});
