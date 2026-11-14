# @launchpad/client-core

Profiles, credentials and operations shared by the CLI and the local MCP server. Node/Bun only.

- `CredentialStore` keeps profiles in `credentials.json` under `$LAUNCHPAD_CONFIG_DIR`, `$XDG_CONFIG_HOME/launchpad` or `~/.config/launchpad`: a mode-700 directory, a mode-600 file replaced atomically under a lock. It refuses a symlink, a file others can read or a file of another owner, and never rewrites a corrupt or newer-format file, so credentials are not lost silently.
- Operations (`login`, `logout`, `whoami`, `useProfile`, `useOrganization`, `listProjects`, ...) take a `Context` and return plain data. `login` verifies the key with the controller before saving it; a key belongs to one organization, which login selects.
- Credential resolution: explicit profile, then `LAUNCHPAD_PROFILE`, then the current profile. Without an explicit profile, `LAUNCHPAD_CONTROLLER` plus `LAUNCHPAD_API_KEY` (and optional `LAUNCHPAD_ORG`, an org ID, not a slug) bypass the file for CI. A partial pair is an error, never a fallback to saved credentials. Project listing discovers the key's org if none is selected.
- `redact` hides anything shaped like a key, for text that reaches a terminal, a log or an MCP response.

Depends on `@launchpad/sdk` and `zod`.

## Lock recovery

Updates wait briefly for the current writer, then fail with `store-busy` rather
than assuming an old lock means the owner is dead. Only the matching ownership
token is released, and failed writes clean up their temporary credential file.
After a crashed writer, remove `credentials.json.lock` manually **only after
confirming that no Launchpad client is writing**. Never remove a live writer's lock.
This deliberately trades automatic crash recovery for preserving profile changes.
