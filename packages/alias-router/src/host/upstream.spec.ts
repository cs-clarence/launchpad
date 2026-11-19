import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpUpstream } from "./upstream";

// Configuration only: no listener and no request.
let directory = "";
afterEach(() => directory && rmSync(directory, { recursive: true, force: true }));
const ca = (content: string) => {
    directory = mkdtempSync(path.join(realpathSync(tmpdir()), "launchpad-router-ca-"));
    const file = path.join(directory, "ca.pem");
    writeFileSync(file, content);
    return file;
};
const origin = new URL("https://dokku.internal");

describe("createHttpUpstream configuration", () => {
    it.each([
        ["an empty bundle", ""],
        ["whitespace", "\n  \n"],
        ["text with no certificate", "not a certificate"],
        ["a private key instead", "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n"],
    ])(
        "refuses %s as the private CA, rather than falling back to the default trust",
        (_name, content) => {
            expect(() => createHttpUpstream({ origin, caFile: ca(content) })).toThrow(
                "no certificate",
            );
        },
    );

    it("accepts a bundle that holds a certificate, and none at all (default trust)", () => {
        const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
        expect(typeof createHttpUpstream({ origin, caFile: ca(pem) })).toBe("function");
        expect(typeof createHttpUpstream({ origin })).toBe("function");
    });

    it("refuses a missing CA file and an origin with a path or a non-http scheme", () => {
        expect(() => createHttpUpstream({ origin, caFile: "/nonexistent/ca.pem" })).toThrow();
        expect(() => createHttpUpstream({ origin: new URL("https://x/base") })).toThrow("no path");
        expect(() => createHttpUpstream({ origin: new URL("ftp://x") })).toThrow();
    });
});
