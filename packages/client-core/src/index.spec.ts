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
