import { describe, expect, it } from "vitest";
import {
    MAX_ALLOCATION_ATTEMPTS,
    allocateHostname,
    newHostnameId,
    parseHostnameTemplate,
    renderHostname,
} from "./hostname-template";

const DOMAIN = "sites.example.net";
const parse = (source: string) => parseHostnameTemplate(source, DOMAIN);

describe("parseHostnameTemplate", () => {
    it("renders the examples from the design, with segments rearranged", () => {
        const input = { slug: "my-site", id: "a1b2c3d4e5" };
        expect(renderHostname(parse("{slug}-{id}-preview"), input)).toBe(
            "my-site-a1b2c3d4e5-preview.sites.example.net",
        );
        expect(renderHostname(parse("{slug}-{id}-view"), input)).toBe(
            "my-site-a1b2c3d4e5-view.sites.example.net",
        );
        expect(renderHostname(parse("view-{slug}-{id}"), input)).toBe(
            "view-my-site-a1b2c3d4e5.sites.example.net",
        );
        expect(renderHostname(parse("{id}-{slug}"), input)).toBe(
            "a1b2c3d4e5-my-site.sites.example.net",
        );
    });

    it("needs both tokens, each exactly once, and no others", () => {
        expect(() => parse("{slug}")).toThrow("needs both");
        expect(() => parse("{id}")).toThrow("needs both");
        expect(() => parse("{slug}-{slug}-{id}")).toThrow("exactly once");
        expect(() => parse("{slug}-{id}-{org}")).toThrow("Unknown token");
        expect(() => parse("{slug}-{id}-{")).toThrow();
        expect(() => parse("")).toThrow("empty");
    });

    it("allows only plain DNS label characters in the literal text", () => {
        for (const bad of [
            "{slug}.{id}",
            "{slug}_{id}",
            "{slug}-{id}-V",
            "{slug} {id}",
            "{slug}/{id}",
        ]) {
            expect(() => parse(bad), bad).toThrow();
        }
        expect(() => parse("{slug}--{id}")).toThrow("single hyphens");
        expect(() => parse("-{slug}-{id}")).toThrow("start with a hyphen");
        expect(() => parse("{slug}-{id}-")).toThrow("end with a hyphen");
        expect(() => parse("xn-{slug}-{id}")).toThrow("reserved");
    });

    it("refuses a template whose worst case exceeds a DNS label, rather than truncating", () => {
        // 40 (slug) + 10 (id) leaves 13 characters of literal text, two of them hyphens.
        expect(() => parse(`{slug}-{id}-${"a".repeat(12)}`)).toThrow("63");
        expect(() => parse(`{slug}-{id}-${"a".repeat(11)}`)).not.toThrow();
        const worst = renderHostname(parse(`{slug}-{id}-${"a".repeat(11)}`), {
            slug: "a".repeat(40),
            id: "z".repeat(10),
        });
        expect(worst.split(".")[0]!.length).toBe(63);
    });

    it("refuses a domain that is not a valid lowercase name, and a total that is too long", () => {
        expect(() => parseHostnameTemplate("{slug}-{id}", "Example.com")).toThrow("domain");
        expect(() => parseHostnameTemplate("{slug}-{id}", "localhost")).toThrow("domain");
        const long = `${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.com`;
        expect(() => parseHostnameTemplate("{slug}-{id}", long)).toThrow();
    });
});

describe("renderHostname", () => {
    it("refuses a slug or id that would break the label", () => {
        const template = parse("{slug}-{id}");
        const good = { slug: "site", id: "abcdefghij" };
        expect(() => renderHostname(template, { ...good, slug: "Site" })).toThrow();
        expect(() => renderHostname(template, { ...good, slug: "-site" })).toThrow();
        expect(() => renderHostname(template, { ...good, slug: "a".repeat(41) })).toThrow();
        expect(() => renderHostname(template, { ...good, id: "abc" })).toThrow();
        expect(() => renderHostname(template, { ...good, id: "ABCDEFGHIJ" })).toThrow();
    });

    it("refuses a slug that would make a reserved or malformed label, on either side of the template", () => {
        const id = "abcdefghij";
        // The contract allows "--" inside a slug; the finished label must not.
        expect(() => renderHostname(parse("{slug}-{id}-preview"), { slug: "xn--foo", id })).toThrow(
            "cannot be used",
        );
        expect(() => renderHostname(parse("{slug}-{id}-preview"), { slug: "ab--cd", id })).toThrow(
            "cannot be used",
        );
        expect(() => renderHostname(parse("view-{slug}-{id}"), { slug: "a--b", id })).toThrow(
            "cannot be used",
        );
        expect(() => renderHostname(parse("{id}-{slug}"), { slug: "a--b", id })).toThrow(
            "cannot be used",
        );
        expect(renderHostname(parse("{slug}-{id}-preview"), { slug: "xnoise", id })).toBe(
            "xnoise-abcdefghij-preview.sites.example.net",
        );
    });

    it("uses the domain the worst case was checked against, and no other", () => {
        expect(parse("{slug}-{id}").domain).toBe(DOMAIN);
        expect(renderHostname(parse("{slug}-{id}"), { slug: "a", id: "abcdefghij" })).toBe(
            `a-abcdefghij.${DOMAIN}`,
        );
    });

    it("makes ten lowercase base36 characters, never a UUID", () => {
        for (let i = 0; i < 20; i++) expect(newHostnameId()).toMatch(/^[a-z0-9]{10}$/);
    });
});

describe("allocateHostname", () => {
    const template = parse("{slug}-{id}-preview");
    const ids = (...values: string[]) => {
        let n = 0;
        return () => values[n++] ?? "zzzzzzzzzz";
    };

    it("returns the first free hostname", async () => {
        const result = await allocateHostname({
            template,
            slug: "site",
            isTaken: () => false,
            makeId: ids("aaaaaaaaaa"),
        });
        expect(result).toEqual({
            id: "aaaaaaaaaa",
            hostname: "site-aaaaaaaaaa-preview.sites.example.net",
        });
    });

    it("retries a taken hostname with a fresh id, then gives up with a conflict", async () => {
        const taken = new Set(["site-aaaaaaaaaa-preview.sites.example.net"]);
        const second = await allocateHostname({
            template,
            slug: "site",
            isTaken: (hostname) => taken.has(hostname),
            makeId: ids("aaaaaaaaaa", "bbbbbbbbbb"),
        });
        expect(second.id).toBe("bbbbbbbbbb");

        let calls = 0;
        await expect(
            allocateHostname({
                template,
                slug: "site",
                isTaken: async () => {
                    calls++;
                    return true;
                },
            }),
        ).rejects.toMatchObject({ code: "conflict" });
        expect(calls).toBe(MAX_ALLOCATION_ATTEMPTS);
    });
});
