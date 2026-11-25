# Quick local setup: guide and seed script

## Assessment

- **Kind:** medium work (a guide, one script, small doc updates; no controller change).
- **Risk tier:** Medium. The script handles passwords and an API key and talks to a controller
  with an operator session, but it is a developer tool for loopback use, changes no product
  behavior and is never run by CI.
- **Unknowns:** exact admin command flags (`setup`, `create-user`) and how the controller
  checks `Origin` on session requests; both are read from the code in step 1.
- **Move up a kind if:** the controller needs a new endpoint, or the script has to run
  anywhere but a developer's machine.

## Goal and done

A developer with Bun, Omni and a PostgreSQL server can follow `docs/local-quickstart.md` and
end with: a migrated database, an operator and an owner account, an organization, a project,
an API key, and a saved `launchpad` CLI profile, in a few commands. Done when the worked
example below holds, the script's tests pass with a fake `fetch` and a fake command runner,
and `omni -i run check test build` is green.

Out of scope: starting PostgreSQL or the controller (the guide tells the user how; the repo
rule is that agents and CI do not start them), deployments and the worker (Dokku, Compose),
production hardening, and any controller change.

## Worked example

Happy path (the guide):

1. `bun install && omni remote-sources install && omni projection sync`.
2. Start any PostgreSQL 17 (one `docker run` line is shown) and copy
   `apps/controller/.env.local.example` to `.env.local`, setting `DATABASE_URL`,
   `LAUNCHPAD_AUTH_SECRET` (`openssl rand -base64 48`) and `LAUNCHPAD_BASE_URL`.
3. `omni -i run dev -p @launchpad-kit/controller` in one terminal.
4. `omni -i run local:seed` (name to be chosen to match `docs/tooling.md`) in another. It
   prints the org, project and where the credentials were written, never a password or key.
5. `launchpad whoami` and `launchpad api organizations/{org}/projects` work.

Complexities:

- The controller refuses session requests whose `Origin` is not `LAUNCHPAD_BASE_URL`; the
  script sends it.
- Organization creation needs the operator's session; project creation and key issuance need
  the owner's session, and key issuance needs a sign-in from the last 15 minutes.
- The API key secret is shown once; the script must store it before anything can fail.
- Passwords reach the admin commands through a mode-600 file (`--password-file`), never an
  argument or the environment.

Edge cases:

- Re-running changes nothing and does not duplicate: an existing operator, user,
  organization (by slug) and project (by slug) are reused; a second API key is issued only
  with `--new-key`.
- Controller not up, wrong `LAUNCHPAD_BASE_URL` origin, migrations pending, and a wrong
  operator password each give one clear message and a nonzero exit.
- A non-loopback controller URL is refused unless `--allow-remote` is given, and `http` is
  only accepted for loopback (as the SDK already requires).
- Generated passwords and the key are written with mode 600 to
  `~/.config/launchpad/` or `--out`, never printed; an existing file is not overwritten
  without `--force`.

## Approach

A single Bun script under `tooling/` (location and Omni task name follow `docs/tooling.md`)
that:

1. runs `admin migrate`, `admin setup` and `admin create-user` through Omni without a shell
   (skipping what already exists);
2. signs in over HTTP (`/api/auth/sign-in/email`, as `tooling/experiments/acceptance/world.ts`
   does), creates the organization, project and API key;
3. stores the key through `@launchpad-kit/client-core` `login` (so the CLI profile is exactly
   what `launchpad login` would write) and records generated passwords in a 600 file.

The pure parts (argument parsing, idempotency decisions, the HTTP bootstrap against an
injected `fetch`, the command runner) are separate functions so they test without a
database or a server.

Rejected: a shell script (secrets and idempotency are awkward); starting PostgreSQL and the
controller from the script (breaks the no-live-infrastructure rule, and is the user's choice
of Docker, local install or cloud); extending the `launchpad` CLI with admin commands (keys
cannot manage organizations; the plan in `cli-api-command.md` keeps that as a separate
decision).

## Steps

1. **Read the code and settle the script's interface.** Admin command flags, origin rule,
   sign-in and the three HTTP calls, where `tooling` scripts and Omni tasks are declared.
   Check: a short written interface in this plan's Status. Undo: none (read only).
2. **The script, with tests (fake `fetch`, fake runner).** Depends on 1. Check: unit tests for
   the worked example, idempotency, each edge case, and that no password or key appears in
   any output or error. Undo: revert.
3. **Omni task wiring and docs.** `docs/local-quickstart.md` (setup, seed, daily use, the
   exposure section below), links from `README.md` and `docs/tooling.md`, and the Omni task.
   Check: `omni -i run check`; the guide's commands match the script's `--help`. Undo: revert.
4. **Exposure section.** Based on `docs/access.md`: a tunnel or Tailscale in front of
   `127.0.0.1`, `LAUNCHPAD_BASE_URL` set to the public https origin, `LAUNCHPAD_TRUSTED_PROXY`
   only behind one proxy, `LAUNCHPAD_API_DOCS=false`, `LAUNCHPAD_PUBLIC_SIGNUP=false`, and the
   warning that the controller has not had a public-exposure review. Check: every setting
   named exists in `apps/controller/README.md`. Undo: revert.

## Risks

- Riskiest (step 1, then 2): the script prints or stores a secret wrongly. Mitigate with the
  output assertions and mode 600 writes, and by never accepting a password as an argument.
- Drift: the guide's commands go stale. A test checks the guide's code blocks name only
  existing Omni tasks and script flags.

## Verification and undo

`omni -i run check test build`. Nothing here touches the controller, database schema or CI;
reverting the commit removes everything. A developer undoes a seed by dropping their local
database; the script never deletes anything.

## Open questions

- None blocking. Name of the Omni task and the script path are decided in step 1 by
  following `docs/tooling.md`.

## Status

All four steps built; `omni -i run check test build` is green. Not run against a real controller,
PostgreSQL or Docker (repo rule); the nested `omni run admin` call was only checked with
`-a command=--help`, and the dev server's port was read from the code, not observed.

**Step 1: settled interface (read from the code).**

- Script `tooling/local-seed.ts`, Omni task `local:seed` in `tooling/project.omni.yaml`
  (`omni -i run local:seed -a "options=<flags>"`). Flags: `--controller` (default
  `http://127.0.0.1:5173`), `--origin`, `--org` (`local`), `--project` (`demo`), `--operator-email`,
  `--owner-email`, `--profile` (`local`), `--out`, `--operator-password-file`,
  `--owner-password-file`, `--new-key`, `--force`, `--allow-remote`, `--help`.
- Admin commands (`apps/controller/src/admin/main.ts`): `migrate`, `setup --email --password-file`,
  `create-user --email --password-file`. A repeat prints `An operator already exists` or
  `A user with that email already exists.` and exits 1, which the script reads as "exists". `admin`
  runs as `omni -i run admin -p @launchpad-kit/controller -a command=X -a "options=..."`; Omni
  forwards no stdin, so passwords go through mode-600 files (the command refuses looser modes).
- HTTP, as `world.ts`: `POST /api/auth/sign-in/email` (200 plus cookie; 401 wrong password; 403
  wrong `Origin`), then with the cookie and `Origin`: `GET/POST /api/v1/organizations` (create is
  operator-only, 409 on a taken slug; the owner's list finds an existing org by slug),
  `GET/POST /organizations/{id}/projects`, `POST /organizations/{id}/api-keys` (session at most 15
  minutes old; reply `secret` shown once). The operator password is needed only when the
  organization must be created.
- Origin rule: session requests outside `/api/auth` must send `Origin` equal to
  `LAUNCHPAD_BASE_URL`'s origin (`api.ts`). `loadAuthConfig` accepts an `http` origin and sets
  secure cookies only for `https`; `https` is required only when `LAUNCHPAD_APPS_DOMAIN` is set
  (`managementOrigin`) or `LAUNCHPAD_DEPLOYMENTS=on`. So `http://127.0.0.1:5173` works with both off.
- Key storage: `login` from `@launchpad-kit/client-core` (verifies the key, then saves it).

**Deviations from the plan.**

- Default controller is `http://127.0.0.1:5173`, not `:3000`: `omni -i run dev` is `vite dev --host
  127.0.0.1` with no port (Vite's default), and `PORT` is read only by the built server. The guide
  says the origin must match the address in use, and shows port 3000 only for the built server.
- The script imports workspace sources by relative path (`../packages/client-core/src/index`,
  as `tooling/vite-config.spec.ts` does): `tooling` has no package and root `node_modules` does not
  link workspace packages.
- Password files are reused when present and never overwritten (stricter than "without --force").
  `--force` replaces a profile that is not this controller's working key; `--new-key` replaces a
  working one. The key is written to a mode-600 `local-api-key.<profile>.pending` file before `login`
  and removed after, so a failed save cannot lose it; a leftover blocks the next key issue.
- The profile-check path found that `whoami` throws `LaunchpadApiError` (not `ClientCoreError`) for a
  dead key; handled and tested.
- Guide includes a `docker run` line for PostgreSQL and the exposure steps; the exposure steps
  (built server, tunnel, `LAUNCHPAD_*` settings) are written from `docs/access.md` and the
  controller README and have not been run.

**Review fixes.** Every path (`--out`, the password-file flags and the default config directory)
is resolved to an absolute path, `~` is expanded by the script, and the resolved path is validated
and is the one passed to `admin`. The output directory must be a real directory you own, not
writable by others (created mode 700). The `.pending` file is claimed before a key is issued, and a
failure to store a key names it for revocation. The key's scopes are narrowed to
`organization:read`, `project:read`, `project:create` and `app:read` (what the guide uses). The
database-failure match no longer includes a bare `timeout`.

**Second review fixes.** A 409 reads as a taken slug only for the organization and project creates.
The parent of a custom password file gets the same directory checks as `--out`, and every directory
is re-checked after creation. A relative or `~` value of `LAUNCHPAD_CONFIG_DIR` or `XDG_CONFIG_HOME`
is refused (the CLI reads them verbatim), and `~user` paths are refused.
