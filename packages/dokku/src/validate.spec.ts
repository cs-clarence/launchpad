import { describe, expect, it } from "vitest";
import { DokkuError } from "./errors";
import {
    appName,
    assertSafeArguments,
    DEFAULT_APP_NAME,
    hostname,
    imageTag,
    portMapping,
} from "./validate";

const refused = (run: () => unknown) => {
    try {
        run();
    } catch (error) {
        expect(error).toBeInstanceOf(DokkuError);
        expect((error as DokkuError).kind).toBe("invalid-argument");
        return;
    }
    expect.unreachable("was accepted");
};

describe("app names", () => {
    it("accepts only the generated shape", () => {
        expect(appName("x", "lp-abcde12345")).toBe("lp-abcde12345");
        for (const bad of [
            "",
            "lp-abcde1234",
            "lp-abcde123456",
            "LP-abcde12345",
            "lp-ABCDE12345",
            "lp_abcde12345",
            "xx-abcde12345",
            "lp-abcde12345 ",
            " lp-abcde12345",
            "lp-abcde12345\n",
            "lp-abcde1234;",
            "lp-abcde12345;id",
            "lp-$(id)1234",
            "lp-abcde1234`",
            "lp-abcde12345\u0000",
            "lp-abcdé12345",
            "--force",
            "-lp-abcde12345",
            "lp-../../etc",
        ]) {
            refused(() => appName("x", bad));
        }
        for (const notAString of [undefined, null, 1, {}, ["lp-abcde12345"]]) {
            refused(() => appName("x", notAString));
        }
    });

    it("honours a wider pattern only when it is given one", () => {
        const wide = /^lp-test-[a-z0-9]{6}$/;
        expect(appName("x", "lp-test-abc123", wide)).toBe("lp-test-abc123");
        refused(() => appName("x", "lp-test-abc123", DEFAULT_APP_NAME));
    });
});

describe("hostnames", () => {
    it("accepts lowercase DNS names and nothing else", () => {
        expect(hostname("x", "demo-a1b2c3.previews.example.com")).toBe(
            "demo-a1b2c3.previews.example.com",
        );
        for (const bad of [
            "",
            "localhost",
            "Demo.example.com",
            "-bad.example.com",
            "bad-.example.com",
            "a b.example.com",
            "a.example.com;ls",
            "a.example.com\n",
            "a..example.com",
            "a.example.com.",
            "*.example.com",
            "a.example.c",
            `${"a".repeat(64)}.example.com`,
            `${"a.".repeat(130)}com`,
            "exämple.com",
            "127.0.0.1",
        ]) {
            refused(() => hostname("x", bad));
        }
    });
});

describe("image tags and port mappings", () => {
    it("accepts well-formed values only", () => {
        expect(imageTag("x", "launchpad/site:abc123")).toBe("launchpad/site:abc123");
        expect(imageTag("x", "lp-abcde12345:20261115-1")).toBe("lp-abcde12345:20261115-1");
        for (const bad of [
            "",
            "noversion",
            "UPPER:tag",
            "a b:tag",
            "a:tag;ls",
            "a:tag\n",
            "a:",
            ":tag",
            "a:-tag",
            "../a:tag",
            "a/b/c/d:tag",
            "a:tag$(x)",
            `a:${"t".repeat(129)}`,
        ]) {
            refused(() => imageTag("x", bad));
        }
        expect(portMapping("x", "http:80:80")).toBe("http:80:80");
        expect(portMapping("x", "https:443:8080")).toBe("https:443:8080");
        for (const bad of [
            "",
            "tcp:80:80",
            "http:0:80",
            "http:80:65536",
            "http:80",
            "http:80:80;x",
            "http:80:80:1",
        ]) {
            refused(() => portMapping("x", bad));
        }
    });
});

describe("the finished command", () => {
    it("allows words and fixed long flags, never anything a shell would act on", () => {
        assertSafeArguments("x", ["apps:destroy", "lp-abcde12345", "--force"]);
        for (const bad of [
            [],
            ["apps:create", "a b"],
            ["apps:create", "a;b"],
            ["apps:create", "a|b"],
            ["apps:create", "a&b"],
            ["apps:create", "$(id)"],
            ["apps:create", "`id`"],
            ["apps:create", "a\nb"],
            ["apps:create", "'a'"],
            ["apps:create", '"a"'],
            ["apps:create", "-o"],
            ["apps:create", "-oProxyCommand=x"],
            ["--force", "apps:create"],
            ["apps:create", "--Force"],
            ["apps:create", "--force=1"],
            ["a", "b", "c", "d", "e", "f", "g", "h", "i"],
        ]) {
            refused(() => assertSafeArguments("x", bad));
        }
    });
});
