// The package's public interface is exactly this list (see README "Public API"). Add a name
// here deliberately; `index.spec.ts` fails on any accidental change.
export { ClientCoreError } from "./errors";
export type { ClientCoreErrorCode } from "./errors";
export { redact, redactSecrets } from "./redact";
export { safeOutput } from "./output";
export { configDirectory, CredentialStore } from "./store";
export type { Config, Profile } from "./store";
export { normalizeEmail, SessionStore } from "./session-store";
export type { SessionEntry } from "./session-store";
export {
    createContext,
    listOrganizations,
    listProfiles,
    listProjects,
    login,
    logout,
    useOrganization,
    useProfile,
    whoami,
} from "./operations";
export type { Context } from "./operations";
export { resolveProject } from "./project";
export {
    checkLocation,
    compileSelection,
    DEFAULT_PACK_LIMITS,
    packDirectory,
    readArchive,
} from "./pack";
export type { FileSelection, PackLimits, Packed } from "./pack";
export { readWorkspace, workspaceContext } from "./workspace";
export { appClient, checkedApp, requireConfirmation } from "./app-client";
export type { AppClient } from "./app-client";
export { fieldsToQuery, parseFields } from "./fields";
export type { FieldInput, FieldSources } from "./fields";

// @internal: unstable, may change in any release, not part of the public interface. `resolve`
// and `clientFor` hand out the raw API key: never log, print or serialize their results.
export { clientFor, resolve } from "./operations";
export type { Resolved } from "./operations";
