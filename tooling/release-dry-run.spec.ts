import { describe, expect, it } from "bun:test";
import { checksumLines } from "./release-dry-run";

describe("checksumLines", () => {
    it("writes sha256sum format, sorted by name", () => {
        expect(
            checksumLines([
                { name: "b.tgz", digest: "bb" },
                { name: "a.tgz", digest: "aa" },
            ]),
        ).toBe("aa  a.tgz\nbb  b.tgz\n");
    });
});
