# @launchpad-kit/client-core

Profiles, credentials and operations shared by the CLI and the local MCP server. Node (`>=22.12`) and Bun, ESM only, **POSIX only** (the permission and owner checks are skipped on Windows, which is unsupported and untested).

This is a public package so the CLI and the MCP server can import it instead of bundling it, but
it is not a general client: other users should use `@launchpad-kit/sdk`. Every name in the
[Public API](#public-api) is part of the package's interface under the `0.x` rule in
[docs/releasing.md](../../docs/releasing.md), and the files it writes (`credentials.json`,
`session.json`, format `version: 1`) are never rewritten in another format. Nothing is published
yet, and publishing waits for a security review of this package.

- `CredentialStore` keeps profiles in `credentials.json` under `$LAUNCHPAD_CONFIG_DIR`, `$XDG_CONFIG_HOME/launchpad` or `~/.config/launchpad`: a mode-700 directory, a mode-600 file replaced atomically under a lock. It refuses a symlink, a file others can read or a file of another owner, and never rewrites a corrupt or newer-format file, so credentials are not lost silently.
- Operations (`login`, `logout`, `whoami`, `useProfile`, `useOrganization`, `listProjects`, ...) take a `Context` and return plain data. `login` verifies the key with the controller before saving it; a key belongs to one organization, which login selects.
- Credential resolution: explicit profile, then `LAUNCHPAD_PROFILE`, then the current profile. Without an explicit profile, `LAUNCHPAD_CONTROLLER` plus `LAUNCHPAD_API_KEY` (and optional `LAUNCHPAD_ORG`, an org ID, not a slug) bypass the file for CI. A partial pair is an error, never a fallback to saved credentials. Project listing discovers the key's org if none is selected.
- `redact` hides anything shaped like a key, for text that reaches a terminal, a log or an MCP response.

Depends on `@launchpad-kit/contracts`, `@launchpad-kit/sdk`, `picomatch`, `tar` and `zod`.

## Public API

The interface is exactly the names exported by `src/index.ts`; `src/index.spec.ts` fails if the
list changes by accident.

- Errors and redaction: `ClientCoreError`, `ClientCoreErrorCode`, `redact`, `redactSecrets`, `safeOutput`.
- Stores: `CredentialStore`, `SessionStore`, `configDirectory`, `normalizeEmail`, types `Config`, `Profile`, `SessionEntry`.
- Operations: `createContext`, `login`, `logout`, `listProfiles`, `useProfile`, `whoami`, `useOrganization`, `listOrganizations`, `listProjects`, `resolveProject`, type `Context`.
- Packing: `packDirectory`, `readArchive`, `checkLocation`, `compileSelection`, `DEFAULT_PACK_LIMITS`, types `FileSelection`, `PackLimits`, `Packed`.
- Workspace and apps: `readWorkspace`, `workspaceContext`, `appClient`, `checkedApp`, `requireConfirmation`, type `AppClient`.
- Fields: `parseFields`, `fieldsToQuery`, types `FieldInput`, `FieldSources`.

**Internal, unstable:** `resolve`, `clientFor` and type `Resolved` are exported only because the
CLI needs them. They are marked `@internal`, may change in any release, and their results hold
the raw API key: never log, print or serialize them. Other helpers (for example
`MAX_WORKSPACE_CONFIG_BYTES`, `ownedByCurrentUser`) are not exported.

## Lock recovery

Updates wait briefly for the current writer, then fail with `store-busy` rather
than assuming an old lock means the owner is dead. Only the matching ownership
token is released, and failed writes clean up their temporary credential file.
After a crashed writer, remove `credentials.json.lock` manually **only after
confirming that no Launchpad client is writing**. Never remove a live writer's lock.
This deliberately trades automatic crash recovery for preserving profile changes.
