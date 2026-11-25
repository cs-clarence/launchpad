import { describe, expect, it } from "vitest";
import { arrayItems, prettyJson } from "./json-text";

describe("prettyJson", () => {
    it("matches JSON.stringify layout for ordinary values", () => {
        const value = { a: [1, 2, { b: null }], c: "x", d: [], e: {}, f: true };
        expect(prettyJson(JSON.stringify(value))).toBe(JSON.stringify(value, null, 2));
        expect(prettyJson(" [ ] ")).toBe("[]");
    });

    it("keeps number and string tokens as written", () => {
        expect(prettyJson('[9007199254740993,1.0,-0,1E+2,"\\u00e9\\n"]')).toBe(
            '[\n  9007199254740993,\n  1.0,\n  -0,\n  1E+2,\n  "\\u00e9\\n"\n]',
        );
    });

    it("refuses text that is not JSON", () => {
        for (const bad of [
            "",
            "{",
            "[1,]",
            "01",
            "1.",
            '{"a":1,}',
            '"\\x"',
            "nul",
            "[1] 2",
            "'a'",
        ]) {
            expect(() => prettyJson(bad), bad).toThrow(SyntaxError);
        }
        expect(() => prettyJson("[".repeat(600))).toThrow(SyntaxError);
    });
});

describe("arrayItems", () => {
    it("returns the original text of each element, or null for a non-array", () => {
        expect(arrayItems('[ 9007199254740993 , {"a": 1.0}, "x" ]')).toEqual([
            "9007199254740993",
            '{"a": 1.0}',
            '"x"',
        ]);
        expect(arrayItems("[]")).toEqual([]);
        expect(arrayItems("{}")).toBeNull();
    });
});
