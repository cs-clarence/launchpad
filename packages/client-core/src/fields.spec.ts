import { describe, expect, it } from "vitest";
import { ClientCoreError } from "./errors";
import { fieldsToQuery, parseFields, type FieldInput } from "./fields";

const sources = {
    readFile: async (path: string) => {
        if (path === "note.txt") return "from file";
        throw new Error("ENOENT");
    },
    readStdin: async () => "from stdin",
};
const f = (text: string): FieldInput => ({ typed: false, text });
const F = (text: string): FieldInput => ({ typed: true, text });
const parse = async (...inputs: FieldInput[]) =>
    JSON.parse(JSON.stringify(await parseFields(inputs, sources)));

describe("parseFields", () => {
    it("types -F values and keeps -f values as strings", async () => {
        expect(await parse(F("n=3"), f("s=3"), F("t=true"), F("z=null"), F("w=hello"))).toEqual({
            n: 3,
            s: "3",
            t: true,
            z: null,
            w: "hello",
        });
        expect(await parse(f("t=true"))).toEqual({ t: "true" });
        expect(await parse(F("big=99999999999999999999"))).toEqual({
            big: "99999999999999999999",
        });
    });

    it("builds the worked example's body", async () => {
        expect(await parse(F("n=3"), f("s=3"), f("k[]=a"), f("k[]=b"))).toEqual({
            n: 3,
            s: "3",
            k: ["a", "b"],
        });
    });

    it("nests keys and builds arrays", async () => {
        expect(await parse(f("a[b]=c"), f("a[d][e]=1"), F("a[d][g]=2"), f("e[]"))).toEqual({
            a: { b: "c", d: { e: "1", g: 2 } },
            e: [],
        });
        expect(await parse(f("x[]"), f("x[]=1"))).toEqual({ x: ["1"] });
        expect(await parse(f("v=a=b"))).toEqual({ v: "a=b" });
    });

    it("reads @file and @- only for -F", async () => {
        expect(await parse(F("a=@note.txt"), F("b=@-"), f("c=@note.txt"))).toEqual({
            a: "from file",
            b: "from stdin",
            c: "@note.txt",
        });
        await expect(parse(F("a=@missing"))).rejects.toThrow("ENOENT");
        await expect(parse(F("a=@"))).rejects.toBeInstanceOf(ClientCoreError);
    });

    it("refuses malformed, conflicting and hostile fields", async () => {
        for (const bad of [
            f("novalue"),
            f("=x"),
            f("a[=x"),
            f("a[b]c=x"),
            f("a[][b]=x"),
            f("__proto__[x]=1"),
            f("a[constructor]=1"),
            f("prototype=1"),
            f("a[b[c]]=1"),
            f("a[1][2][3][4][5][6][7][8]=x"),
        ]) {
            await expect(parse(bad), bad.text).rejects.toBeInstanceOf(ClientCoreError);
        }
        await expect(parse(f("a=1"), f("a=2"))).rejects.toBeInstanceOf(ClientCoreError);
        await expect(parse(f("a=1"), f("a[b]=2"))).rejects.toBeInstanceOf(ClientCoreError);
        await expect(parse(f("a[b]=2"), f("a=1"))).rejects.toBeInstanceOf(ClientCoreError);
        await expect(parse(f("a[]=1"), f("a=1"))).rejects.toBeInstanceOf(ClientCoreError);
        await expect(parse(f("a=1"), f("a[]=1"))).rejects.toBeInstanceOf(ClientCoreError);
        await expect(
            parse(...Array.from({ length: 201 }, (_, i) => f(`k${i}=1`))),
        ).rejects.toBeInstanceOf(ClientCoreError);
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
});

describe("fieldsToQuery", () => {
    it("flattens as gh does", async () => {
        const fields = await parseFields(
            [F("after=12"), F("limit=500"), f("a[b]=c"), f("k[]=1"), f("k[]=2")],
            sources,
        );
        expect(fieldsToQuery(fields)).toEqual([
            ["after", "12"],
            ["limit", "500"],
            ["a[b]", "c"],
            ["k[]", "1"],
            ["k[]", "2"],
        ]);
    });
});
