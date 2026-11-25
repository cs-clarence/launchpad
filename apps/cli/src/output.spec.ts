import { describe, expect, it } from "vitest";
import { safeOutput } from "./output";

describe("terminal output", () => {
    it("redacts keys before an escape can consume their prefix", () => {
        const body = "AbC123xyZ_-9";
        for (const prefix of ["\u001b", "\u001b[", "\u009b"]) {
            const printed = safeOutput(`token: ${prefix}lp_${body}`);
            expect(printed).not.toContain(body);
            expect(printed).toContain("[redacted]");
        }
    });

    it("redacts keys reassembled by stripping escape sequences", () => {
        const body = "AbC123xyZ_-9";
        const printed = safeOutput(`token: lp_Ab\u001b[31mC123xyZ_-9`);
        expect(printed).not.toContain(body);
        expect(printed).toContain("[redacted]");
    });

    it("does not expose the suffix of a partially redacted, control-split key", () => {
        const body = "a".repeat(8) + "b".repeat(35);
        for (const split of [8, 9, 16, 32, 42]) {
            for (const control of ["\u0007", "\u001b[31m", "\u009b31m"]) {
                const value = `lp_${body.slice(0, split)}${control}${body.slice(split)}`;
                expect(safeOutput(`token: ${value}`)).toBe("token: lp_[redacted]");
            }
        }
    });

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

    it("hides the secrets of this run in the forms a server may echo them", () => {
        const cookie = "better-auth.session_token=tok.sig%2Bvalue";
        const password = 'pa"ss word 1234';
        const printed = safeOutput(
            [cookie, "tok.sig+value", JSON.stringify(password), "tok.sig%2Bvalue"].join(" "),
            [cookie, "tok.sig%2Bvalue", password],
        );
        for (const secret of ["tok.sig", 'pa\\"ss', "session_token"]) {
            expect(printed).not.toContain(secret);
        }
        expect(safeOutput("a short word", ["short"])).toBe("a short word");
    });
});
