import { describe, expect, it } from "vitest";
import { safeNext } from "./safe-next";

describe("safeNext", () => {
    it("keeps same-site paths", () => {
        expect(safeNext("/")).toBe("/");
        expect(safeNext("/orgs/abc?x=1#top")).toBe("/orgs/abc?x=1#top");
        expect(safeNext("/accept-invitation?token=abc_-")).toBe("/accept-invitation?token=abc_-");
    });

    it("rejects anything that could leave the site", () => {
        for (const bad of [
            "//evil.com",
            "/\\evil.com",
            "/\\/evil.com",
            "/\t/evil.com",
            "/\n/evil.com",
            "https://evil.com",
            "javascript:alert(1)",
            "evil.com",
            "",
            undefined,
            42,
        ]) {
            expect(safeNext(bad), JSON.stringify(bad)).toBeUndefined();
        }
    });

    it("never returns a protocol-relative result, even for encoded slashes", () => {
        const result = safeNext("/%2F%2Fevil.com/");
        expect(result === undefined || !result.startsWith("//")).toBe(true);
    });
});
