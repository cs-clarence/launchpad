import { describe, expect, it } from "vitest";
import * as core from "./index";
import type {
    AppClient,
    Config,
    Context,
    FieldInput,
    FieldSources,
    FileSelection,
    PackLimits,
    Packed,
    Profile,
    SessionEntry,
} from "./index";

// Compile-time check that the public types stay exported.
export type PublicTypes = [
    AppClient,
    Config,
    Context,
    FieldInput,
    FieldSources,
    FileSelection,
    PackLimits,
    Packed,
    Profile,
    SessionEntry,
];

describe("public surface", () => {
    it("exports exactly the documented runtime names", () => {
        expect(Object.keys(core).sort()).toEqual(
            [
                "ClientCoreError",
                "CredentialStore",
                "DEFAULT_PACK_LIMITS",
                "SessionStore",
                "appClient",
                "checkLocation",
                "checkedApp",
                "clientFor",
                "compileSelection",
                "configDirectory",
                "createContext",
                "fieldsToQuery",
                "listOrganizations",
                "listProfiles",
                "listProjects",
                "login",
                "logout",
                "normalizeEmail",
                "packDirectory",
                "parseFields",
                "readArchive",
                "readWorkspace",
                "redact",
                "redactSecrets",
                "requireConfirmation",
                "resolve",
                "resolveProject",
                "safeOutput",
                "useOrganization",
                "useProfile",
                "whoami",
                "workspaceContext",
            ].sort(),
        );
    });
});

describe("redact", () => {
    it("hides bearer tokens and secure cookies, and the key's body in any case", () => {
        expect(core.redact("a Bearer abc.def-1 b")).toBe("a Bearer [redacted] b");
        expect(core.redact("__Secure-x.y=abc%2B; Path=/")).toBe("__Secure-x.y=[redacted]; Path=/");
        expect(core.redactSecrets("got KQ7XLM2ZP9RT", ["lp_kq7xlm2zp9rt"])).toBe("got [redacted]");
        expect(core.redact("lp_abcdefgh12 stays")).toBe("lp_[redacted] stays");
    });
});

describe("redaction keeps JSON valid and prose readable", () => {
    const cases = [
        { b: 'Bearer abc"}' },
        { b: 'Bearer abcdefghij1234"; x="y' },
        { b: "Bearer abc\\u0041def and more\nBearer tok.en-1\\" },
        { nested: JSON.stringify({ h: 'Bearer abcdefghij"', c: '__Secure-a.b=v4lue; Path=/"' }) },
        { c: '__Host-sid=abc123\\"; HttpOnly; Secure' },
        { c: "set-cookie: __Secure-better-auth.session_token=tok.sig%2B; Max-Age=60; Secure" },
        { "Bearer abcdefghij": 'k="__Secure-x=y1234567"' },
    ];

    it.each(cases)("parses after safeOutput: %j", (value) => {
        const out = core.safeOutput(JSON.stringify(value), ["secretvalue1"]);
        expect(() => JSON.parse(out)).not.toThrow();
        expect(out).not.toMatch(/abcdefghij|tok\.sig|v4lue|abc123/);
    });

    it("hides double-quoted cookie values, plain and JSON-escaped, idempotently", () => {
        const plain = 'Set-Cookie: __Secure-a.b="v4lue9.sig"; Path=/';
        expect(core.redact(plain)).toBe('Set-Cookie: __Secure-a.b=[redacted]"; Path=/');
        expect(core.redact(core.redact(plain))).toBe(core.redact(plain));
        const json = JSON.stringify({ c: plain, d: '__Host-x="hh8hosted"' });
        const out = core.safeOutput(json);
        expect(() => JSON.parse(out)).not.toThrow();
        expect(out).not.toMatch(/v4lue9|hh8hosted/);
        expect(core.safeOutput(out)).toBe(out);
        expect(core.redact("__Secure-a=")).toBe("__Secure-a=");
    });

    it("is linear on adversarial input", () => {
        const start = Date.now();
        for (const unit of ['__Secure-a="', "Bearer ", '__Host-x=\\"', "Bearer a"]) {
            core.safeOutput(unit.repeat(40_000));
        }
        expect(Date.now() - start).toBeLessThan(3000);
    });

    it("leaves ordinary prose about bearer tokens alone", () => {
        for (const text of [
            "the Bearer token is invalid",
            "Bearer auth failed",
            "a bearer of news",
        ]) {
            expect(core.redact(text)).toBe(text);
        }
        expect(core.redact("Authorization: Bearer abc1")).toBe("Authorization: Bearer [redacted]");
    });
});
