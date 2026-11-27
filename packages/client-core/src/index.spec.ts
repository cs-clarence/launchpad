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
