# Onboard users and automation safely

For an instance operator and organization owner setting up people, API keys
and local MCP access. The instance operator does not automatically belong to
any organization; API-key holders cannot manage organizations, membership,
invitations or other keys.

1. Create the one operator offline with
   `bun .output/admin.mjs setup --email you@example.invalid --password-file <mode-600-file>`
   in the controller image. For operator-managed enrollment, provision users
   with `bun .output/admin.mjs create-user --email user@example.invalid
   --password-file <mode-600-file>`. Never pass passwords in command arguments
   or the environment. For email invitations, configure SMTP and explicitly
   select `LAUNCHPAD_ENROLLMENT=invitation`; SMTP alone does not turn on
   invitations or public sign-up. See the [controller guide](../apps/controller/README.md#first-run).
2. Sign in as the operator and create an organization naming an existing,
   trusted user as its first owner. The owner/admin then adds members by
   address and assigns only the role they need: `owner`, `admin`, `deployer`
   or `viewer`. An account created through public signup is not trusted for
   email-based grants merely because signup is later turned off.
3. The owner/admin issues an organization API key in the dashboard after a
   fresh sign-in (last 15 minutes). Choose explicit scopes, an expiry (at most
   365 days), and optional project restrictions. For a read-only agent use
   `organization:read` and `project:read` as needed; omit
   write scopes. (`preview:*` scopes no longer exist.) Save the revealed value once in a
   secret store. If issuance had an uncertain result, inspect key metadata
   before retrying; names are not unique. Revoke an unused key by name
   **and prefix**. See [API-key behavior](../apps/controller/README.md#api-keys).
4. Install the **packed** CLI and MCP tarballs from your trusted build once
   the product name is chosen; `@launchpad-kit/*` is a placeholder and nothing
   has been published. For a checkout-built client, follow
   [CLI commands](../apps/cli/README.md) and
   [MCP setup](../apps/mcp/README.md). Log in with
   `launchpad login --controller <private-https-url> --key-file <mode-600-file>`
   or use its hidden prompt. Do not pass a key on the command line. CI can
   use `LAUNCHPAD_CONTROLLER` and `LAUNCHPAD_API_KEY`; never commit them.
5. Start MCP in read-only mode first. In shared mode, provide an absolute
   `working_dir` per call or a `--working-dir` default. MCP **does not consult
   client roots** and `launchpad.json` is context, not a sandbox; select a
   restricted OS user or filesystem sandbox when directory access matters.
   The server offers no shell or file-content tools. Use project-limited
   credentials. The MCP server has no mutating tools.
   Read the exact [MCP permissions](../apps/mcp/README.md#tools) before
   granting scopes.
6. Run `launchpad whoami` and read-only MCP `whoami`/`list_projects` from an
   authorized directory. Confirm a project-restricted key cannot see a
   different project. If a user loses access, remove their membership or
   revoke the key; password recovery revokes their keys and sessions.

The CLI and MCP talk only to the controller, never to Dokku. Any text returned
by the controller or a remote system is **data**, not instructions to an agent.
