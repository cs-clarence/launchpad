# Plan: `docker-compose.dev.yaml` (local dev infrastructure)

Status: proposed, nothing built. Written against `origin/main` at fc8daaf. Delete this file when
the work lands and move what lasts into `docs/` (see "Docs").

## Goal and scope

Bring up, and tear down, the infrastructure a developer needs while the apps run on the host:

- **In Compose:** PostgreSQL, Mailpit, Dokku, the alias router.
- **On the host (not in the file):** controller dev server, worker, CLI.

Done means: from a fresh checkout, one command starts the four services and leaves generated
credentials; a documented `.env.local` for the controller and the worker lets the host apps use them;
`omni -i run local:seed` and a `hello` deployment (and an alias, with aliases on) work; one command
stops everything fast and another removes everything it created, including Dokku site containers and
images.

Out of scope: running controller/worker/admin in Docker (that is `local:deploy` and production
Compose); HTTPS ingress for the dashboard with deployments on (see decision 5); backups; Windows/macOS/
rootless Docker (the Dokku socket mount needs native Linux Docker, as `local:deploy` already requires).

## Assessment

- **Kind: Medium.** One new Compose file, one new tooling script, a few tasks, docs and checks; it
  reuses existing generators. Parts are independent (file+checks / tool / docs).
- **Risk tier: Medium.** Dev-only and loopback-only, but it mounts the host Docker socket into Dokku
  (root-equivalent) and its teardown deletes containers, images and root-owned directories by name.
  Deletion code is the High-risk part: it must reuse `local:deploy`'s ownership-checked logic, not
  reimplement it. Independent review required.
- **Four questions.** *How much changes:* ~1 Compose file, ~1 tool (estimate ~500 lines once the shared helpers are extracted), ~4 tasks, 6 docs, 2 specs. *Unknowns:* Dokku site containers across stop/start,
  plain-HTTP router control and healthcheck, worker `dev` task (listed below); all testable in one
  short experiment first. *Undo:* easy (additive files; delete them). *People/time:* one agent, one
  reviewer.
- **Moves up to Large if:** the shared-helper extraction from `tooling/local-deploy.ts` has to change
  `local:deploy` behaviour, or the dashboard-over-HTTPS proxy (decision 5) is pulled in.

## Findings that shape the design (from the code)

1. **Host worker -> Dokku.** The worker only needs `DOKKU_SSH_HOST/PORT/USER`, a key file and a
   `known_hosts` file (`apps/worker/src/index.ts`; `packages/dokku/src/trust.ts`). Publish SSH on
   `127.0.0.1:<port>`; `known_hosts` must name the server as `[127.0.0.1]:<port> ssh-ed25519 ...`
   (`knownHostsName`: bare host only on port 22). Plain explicit entries only. The worker builds with
   the host `docker` CLI and streams `docker save`, so it needs no engine socket mount and no
   `group_add`; the developer's own Docker access is used. Dokku does **not** call the host: the
   worker's site probe is an HTTP GET to `LAUNCHPAD_APPS_PROXY_URL` with the site's name as `Host`
   (`apps/worker/src/verify.ts`), so `http://127.0.0.1:<dokku-http-port>` works. Nothing in the
   stack connects to the host controller.
2. **Host -> router control plane.** Rule is `assertPrivateControlUrl`
   (`packages/services/src/router-credentials.ts`): `https`, **or `http` to the literal `127.0.0.1` or
   `[::1]`** (`localhost` is refused). The worker and the controller admin both apply it. So a
   published loopback port with plain HTTP is allowed: `LAUNCHPAD_ALIAS_CONTROL_URL=http://127.0.0.1:<p>`.
   `LAUNCHPAD_ALIAS_CONTROL_CA_FILE` is rejected with an http URL, so it stays unset. The router
   side needs `LAUNCHPAD_ROUTER_CONTROL_LISTEN=0.0.0.0:3081` inside the container, which
   `parseRouterHostConfig` accepts only with `LAUNCHPAD_ROUTER_CONTROL_PRIVATE_NETWORK=1`; control TLS
   is optional (all four TLS settings or none). **Dev drops the throwaway CA and server certificate**
   that `local:deploy` generates, so `openssl` is not needed. The token then crosses plain HTTP on the
   loopback interface only; acceptable and documented. Token files are read by the host worker as the
   invoking user (owner and mode 0600 required), so **no chown to 10001** is needed for credentials
   (the router only needs its state volume; the token is used once by `router init`).
   Router -> Dokku: `LAUNCHPAD_APPS_PROXY_URL=http://dokku:80` on the compose network.
3. **Apps domain.** `apps.localhost` as in `local:deploy`. `*.localhost` resolves to loopback in
   browsers and curl >= 7.78, but Dokku HTTP is on an unprivileged port, so URLs carry the port
   (`http://hello-xxx-preview.apps.localhost:33181/`); `curl -H "Host: ..."` always works. The
   dashboard preview link has no port, so it does not work (same limit as `local:deploy`).
4. **Mailpit.** `LAUNCHPAD_SMTP_URL=smtp://127.0.0.1:<port>`: `smtp://` is accepted, STARTTLS is
   required unless the host is `localhost`/`127.0.0.1`/`::1` (`packages/auth/src/mailer.ts`), no query
   string allowed, and `LAUNCHPAD_EMAIL_FROM` must be set with it. Mailpit accepts unauthenticated
   plain SMTP by default. Web UI/API on its own loopback port. Setting `LAUNCHPAD_ENROLLMENT=invitation`
   is how mail actually gets sent (invitations).
5. **Base URL conflict.** With `LAUNCHPAD_DEPLOYMENTS=on` or an apps domain set, the controller
   requires an `https` `LAUNCHPAD_BASE_URL` (`managementOrigin`) with a different registrable domain.
   So the host controller cannot serve a working dashboard on `http://127.0.0.1:3000` *and* deploy.
   Two modes follow (decision 5): **app mode** (deployments off, http base URL, dashboard and Mailpit
   invitations work) and **deploy mode** (deployments on, `https://control.localhost:8443`, CLI/API
   only, exactly as `local:deploy`).
6. **Worker has no `dev` task** (only the controller does) and `.env.local` is documented only for the
   controller; `apps/worker/.env.local.example` exists but nothing says how to run it on the host.
   `LAUNCHPAD_DATA_DIR` must be the **same directory** for the controller and the worker, but a
   relative path resolves against each app's cwd, so dev must set an absolute path.
7. **`tooling/local-deploy.ts` is 2,126 lines** of bespoke up/down logic (state record, port check, Dokku
   bootstrap, site discovery and destruction, root-owned state removal). Raw `docker compose` cannot
   do: generate credentials, pin Dokku's host key, `ssh-keys:add`, `network:set --global
   initial-network`, `router init` (prints the epoch the worker needs), or destroy Dokku site
   containers/images/root-owned state on teardown. That is why raw commands alone are not enough.

## Structure: standalone file, reusing by build context and by test, not by `extends`/`include`

Evaluated against `docker-compose.yaml` (production):

| Option | What it would reuse | Why it does not fit well |
| --- | --- | --- |
| `include: docker-compose.yaml` | everything | Pulls in controller, worker and admin (not wanted); cannot remove services; every `${VAR:?}` (auth secret, socket gid, backup dir, key files) must be supplied; hardening, mem limits and networks come with it. |
| `extends` of `postgres`/`dokku`/`router` | images, build, healthchecks | `${VAR:?}` is evaluated on load, so dev must still set `POSTGRES_PASSWORD`, `LAUNCHPAD_ROUTER_TLS_*` files etc. even where dev does not use them. `ports`, `networks` and `environment` entries merge rather than replace, so removing router TLS env/mounts, moving postgres off the internal `database` network and publishing router control needs `!reset`/`!override` on most fields. Prod's `x-` anchors and top-level networks/volumes are not inherited. Net: more override than reuse, and prod edits silently change dev. |
| `-f docker-compose.yaml -f docker-compose.dev.yaml` | same as include | Same, plus the prod services still exist unless profiled. |
| **Standalone `docker-compose.dev.yaml`** | Dockerfiles and digests by reference | Duplicates ~60 lines (healthchecks, pins), but each dev service reads naturally and prod's required-variable discipline is untouched. |

**Recommendation: standalone**, with the genuinely shared parts kept in step mechanically:
`build:` points at the same `containers/dokku` and `apps/router` Dockerfiles (so Dokku version, digests,
plugin commit and router code are the single source); the Dokku healthcheck/start_period, the
PostgreSQL image reference and the Dokku environment are copied and a unit spec asserts they equal
the production file's values (`loadRaw()` of both). Prod stays untouched. Dev gets its own image
tags (below) so `destroy` can remove exactly those, as `local:deploy` does.

**Project name and image tags (one definition).** `<project> = launchpad-dev-<hash8>` where
`<hash8> = sha256(absolute checkout path)` as lowercase hex, first 8 characters (the same derivation as
`projectNameFor` in `tooling/local-deploy.ts`, with a different prefix, so the same checkout never
collides with `local:deploy`). Every image is `<project>/<service>:local` (`dokku`, `router`), written
to `compose.env` as `DEV_PROJECT=<project>` and referenced in the file as
`image: ${DEV_PROJECT:?}/dokku:local`. Different checkouts have different paths and so different
projects and tags; `--project` is accepted only if it matches `^launchpad-dev-[a-z0-9-]{1,40}$`, so a
tag can never be a developer's own. Hash collisions (32 bits) are not relied on: the build adds the
label `com.launchpad.dev-project=<project>` (compose `build.labels`), and `destroy` removes an image
only after `docker image inspect` shows that label equal to the recorded project and the name equals
the exact tag built from `state.json`. `<project>` is never derived from user input at removal time.

Dev deliberately differs from prod: no `restart` policy, no hardening/`read_only`, `mem_limit` only on
Dokku and PostgreSQL (kept for parity and to stop a runaway Dokku), the same `json-file` log rotation.
Variables the tool always generates (`POSTGRES_PASSWORD`, `LAUNCHPAD_ALIAS_INSTANCE_ID`,
`DOKKU_DATA_DIR`, `DEV_PROJECT`) stay `${VAR:?}` in the dev file, so a raw `docker compose config`
without the tool's `compose.env` fails loudly instead of rendering empty values; values with
defaults (ports, `DOKKU_VERSION`) use `${VAR:-default}`.

## Services (all published ports on `127.0.0.1` only; defaults chosen not to collide)

Ports avoid `local:deploy` (32180-32443), `test:db:up` (55432) and the quickstart's 5432.
All are `${VAR:-default}`; the tool checks they are free before `up`.

| Service | Image / build | Published | Notes |
| --- | --- | --- | --- |
| `postgres` | `postgres:17-alpine@sha256:526f86d9...` (same as prod) | `127.0.0.1:35432 -> 5432` | Named volume `postgres-data`; `pg_isready` healthcheck as prod; user/db `launchpad`; password from generated env. Not on an `internal` network (the host must reach it). |
| `mailpit` | `axllent/mailpit:v1.29@sha256:757f22b5...` (digest read 2026-11-27; re-verify when written) | SMTP `127.0.0.1:31025 -> 1025`, UI `127.0.0.1:38025 -> 8025` | `MP_MAX_MESSAGES` bounded; no persistence by default (mail vanishes on `down`; optional volume is not worth it). Healthcheck `/readyz` (Mailpit image has a `healthcheck` subcommand; pick the one that exists in the pinned version). |
| `dokku` | build `containers/dokku`, image `<project>/dokku:local` (build arg `DOKKU_VERSION`) | SSH `127.0.0.1:33222 -> 22`, HTTP `127.0.0.1:33181 -> 80` | HTTPS 443 not published (nothing uses it in dev). Bind `DOKKU_DATA_DIR` -> `/mnt/dokku`; Docker socket bind; `DOKKU_HOST_ROOT`/`DOKKU_LIB_HOST_ROOT` as prod; networks `backend` and `apps`. First start is minutes (unpinned package install, accepted for prod too). |
| `router` | build `apps/router`, image `<project>/router:local` | data `127.0.0.1:33182 -> 3080`, control `127.0.0.1:33183 -> 3081` | Plain-HTTP control, `PRIVATE_NETWORK=1`, no TLS files; volume `router-state`; `LAUNCHPAD_APPS_PROXY_URL=http://dokku:80`; `depends_on` none (needs Dokku only at request time). Healthcheck as prod. |

Networks: `backend` (Dokku, router) and `apps` with a fixed per-project name (Dokku's
`initial-network` refers to it). Volumes: `postgres-data`, `router-state`. Project name
`launchpad-dev-<hash8 of checkout path>` supplied by the tool (like `local:deploy`'s
`launchpad-local-<hash8>`); the file's own `name: launchpad-dev` covers raw use.

Not included: `admin` profile, controller, worker, TLS certs, Docker socket in anything but Dokku.

## State, secrets and credentials

New ignored directory **`.dev-infra/`** (add to `.gitignore` and to the three
`apps/*/Dockerfile.dockerignore` next to `.local-deploy`; the router build context is the repo root,
and a root-owned `dokku/` subtree would otherwise break `docker build`). Mode 700, record
`state.json` with the tool version, project name and ports (same "refuse a foreign directory" check as
`local:deploy`).

| Path | Owner / mode | Content |
| --- | --- | --- |
| `compose.env` | user 0600 | `POSTGRES_PASSWORD`, `LAUNCHPAD_ALIAS_INSTANCE_ID` (uuid), `LAUNCHPAD_APPS_DOMAIN=apps.localhost`, ports, `DOKKU_DATA_DIR`, `LAUNCHPAD_APPS_NETWORK`, `DEV_PROJECT` (`launchpad-dev-<hash8>`, which fixes every image tag `<project>/<service>:local`) |
| `dokku/` | root-owned contents, dir 0755 | Dokku state (SSH host key survives `down`, so `known_hosts` stays valid) |
| `credentials/` | user 0700 | `id_ed25519(.pub)` (via `ssh-keygen`), `known_hosts` (written after first Dokku start: `[127.0.0.1]:33222 ssh-ed25519 ...`), `token` (64 hex), `epoch` (from `router init`), all files 0600 |
| `data/` | user | `LAUNCHPAD_DATA_DIR` shared by host controller and worker |
| `env/controller.env`, `env/worker.env` | user 0600 | the generated app settings, each a complete list for its app (see below) |

### Helper extraction (slice 1), exactly

Verified in `tooling/local-deploy.ts`: the teardown and state code is parameterised only by
`Ctx = { d, layout, project }` plus module constants (`FIXED_CHILDREN`, `STATE_FILES`, `OWNED_BY_SERVICE`,
`SERVICES`, `IMAGE_SERVICES`, `projectImages`, `appsNetwork`, `postgresImage`). Extraction therefore
turns those constants into a small **profile** object passed in, with `local:deploy`'s profile equal to
today's values (its specs must pass unchanged):

| Parameter | `local:deploy` profile (unchanged) | Dev profile |
| --- | --- | --- |
| state directory name | `.local-deploy` | `.dev-infra` |
| child list (`FIXED_CHILDREN`; the helper container's `rm -rf /state/<name>` list and the "no state.json" strange-children check) | `dokku`, `backups`, `credentials`, `tls` | `dokku`, `credentials`, `data`, `env` |
| state files (`STATE_FILES`/unlink list at the end of `down`) | `compose.env`, `override.json`, `state.json`, `inventory.json` | `compose.env`, `state.json`, `inventory.json` (no override file: tags come from `DEV_PROJECT`) |
| project pattern and prefix | `launchpad-local-` | `launchpad-dev-` |
| images (`projectImages`, rm and "image exists" checks) | five services under `<project>/<s>:local` | `dokku`, `router` under `<project>/<s>:local`, plus the `com.launchpad.dev-project` label check |
| services list (health, `ps` format) | postgres, dokku, controller, worker, router | postgres, mailpit, dokku, router |
| files chowned to uid 10001 (`OWNED_BY_SERVICE`, `ownedByServiceUser`) | six paths via the worker image | none: the host worker reads credentials as the invoking user and the router needs only its named volume |
| root helper image (`removeStateChildren`) | the pinned PostgreSQL image from `docker-compose.yaml` | same (`--network none`, `--user 0`, `--mount type=bind,src=<dir>,dst=/state`, `--entrypoint rm`) |
| compose argument prefix (`composePrefix`/`composeHint`) | `-f docker-compose.yaml -f .local-deploy/override.json` | `-f docker-compose.dev.yaml` |
| ports and `portsFor` | base 32180 with offsets | the dev port block (fixed defaults, env-overridable) |

**Moved to the shared module, behaviour unchanged:** `Ctx`/`Deps`/`Fs`/`RunResult` types and `spawnExec`/
`realFs`, `compose()`/`docker()`/`must()` wrappers, labelled listing (`labeledContainers`, `labeledNames`,
`projectResources`, `networkOwner`, `confirmed`, `inspectLabel`), site discovery (`discover`,
`parseInventory`, `mergeSites`, `siteFromRow`, `checkSiteName` with the `lp-` and `launchpad/site:<32 hex>`
name patterns), `destroySite`/`siteContainers`/`siteImages`/`removeImages`, `waitForDokkuToSettle`,
`checkDirectory`/`checkOwnDirectory`/`ensureDirectory`, `removeStateChildren`, `probePort`/`freePorts`,
`generateSecrets` (generalised), `parseSocketGid`, `projectNameFor` (prefix parameter).

**Retained, not weakened:** every removal is still gated by (a) the Compose project label on containers,
networks and volumes (`confirmed`), (b) exact names derived from the recorded project and validated
patterns (`PROJECT_PATTERN`, `NAME.app`, `NAME.tag`), never wildcards or `prune`, (c) `lstat`-based
refusal of a symlinked or foreign-owned state directory and of children that are not real directories
(`checkDirectory`, `checkOwnDirectory`: uid, mode 700, realpath equals the path), (d) the root helper only
removing the named children under a bind of the verified directory, and (e) the `state.json` record
check (`checkRecord`) so one checkout cannot act on another's resources. The uid-10001 ownership code
(`ownedByServiceUser`) is **moved but unused in dev**, because dev has no 10001-owned files; the dev
tool must not chown anything, and a spec asserts that no `chown` command is issued.

**Copied, not shared:** the dev-specific `up`/`down` orchestration (service list and order, Mailpit,
no TLS generation, host-key pin as `[127.0.0.1]:<port>`, env-file rendering) lives in `dev-infra.ts`; the
TLS and CA generation (`credentialCommands`'s openssl commands), the CLI profile handling, `local-seed`
invocation and `override.json` stay in `local-deploy.ts` only. Dev copies the five-line `known_hosts`
writer rather than parameterising it, since its host name format differs.

Alternative of a mode flag on `local:deploy` is rejected: it would entangle two different lifecycles
(all-in-Docker vs infra-only).

## Host app configuration (generated, never committed)

`dev:infra:up` prints, and writes to `.dev-infra/env/*.env`, these; the developer copies them into
`apps/controller/.env.local` and `apps/worker/.env.local` (the tool does not overwrite existing
files; decision 4). Both apps pick up `.env.local` through `omni -i run dev` / Bun's cwd loading.

Common: `DATABASE_URL=postgresql://launchpad:<pw>@127.0.0.1:35432/launchpad`,
`LAUNCHPAD_DATA_DIR=<repo>/.dev-infra/data` (absolute, shared).

Verified against the parsers: the controller **server** (`apps/controller/src/server/runtime.ts`) calls
`parseDeploymentConfig` and `parseAliasConfig`, which need only the base URL, the apps domain and the
switches. `parseAppRoutingConfig` (`packages/services/src/app-routing-config.ts`, ~242-310) is called by the
**worker** (only when `LAUNCHPAD_ALIASES=on`, `apps/worker/src/index.ts:76`) and by the controller's
**admin** commands (`promotion-reconcile`, router views, `drift`; the router view parses it whenever
`LAUNCHPAD_ALIAS_CONTROL_URL` is set, and then every router setting is mandatory). `local:seed` runs the
admin task with the controller's environment, so `controller.env` carries the complete routing list
in deploy mode, not only what the server needs.

Controller **app mode** (default; dashboard works), `env/controller.env`:
`DATABASE_URL`, `LAUNCHPAD_DATA_DIR`, `LAUNCHPAD_AUTH_SECRET=<generated>`,
`LAUNCHPAD_BASE_URL=http://127.0.0.1:3000`, `LAUNCHPAD_DEPLOYMENTS=off`,
`LAUNCHPAD_ENROLLMENT=invitation`, `LAUNCHPAD_SMTP_URL=smtp://127.0.0.1:31025`,
`LAUNCHPAD_EMAIL_FROM=Launchpad <launchpad@localhost>`, `HOST=127.0.0.1`, `PORT=3000`.
No apps domain is set, so no routing settings are needed.

Controller **deploy mode** (CLI/API only), `env/controller.env` is the app-mode list with
`LAUNCHPAD_BASE_URL=https://control.localhost:8443` and these added; the six routing names are exactly the
ones `parseAppRoutingConfig` reads through `required(...)`, in addition to the apps domain and base URL:

| Setting | Value |
| --- | --- |
| `LAUNCHPAD_APPS_DOMAIN` | `apps.localhost` |
| `LAUNCHPAD_DEPLOYMENTS` / `LAUNCHPAD_ALIASES` | `on` / `on` or `off` |
| `LAUNCHPAD_ALIAS_INSTANCE_ID` | the uuid in `compose.env` (lowercase UUID) |
| `LAUNCHPAD_ALIAS_CONTROL_URL` | `http://127.0.0.1:33183` (not `localhost`) |
| `LAUNCHPAD_APPS_PROXY_URL` | `http://127.0.0.1:33181` (origin, no path) |
| `LAUNCHPAD_ALIAS_PROBE_URL` | `http://127.0.0.1:33182` |
| `LAUNCHPAD_ALIAS_CONTROL_TOKEN_FILE` | absolute `.dev-infra/credentials/token` |
| `LAUNCHPAD_ALIAS_ROUTER_EPOCH_FILE` | absolute `.dev-infra/credentials/epoch` |

`LAUNCHPAD_ALIAS_CONTROL_CA_FILE` stays unset (rejected with an http URL). The CLI/API use
`http://127.0.0.1:3000` as `local:deploy` does: `local:seed --controller http://127.0.0.1:3000 --origin
https://control.localhost:8443`.

**What deploy mode exercises about Mailpit/SMTP:** nothing user-visible. The SMTP and enrollment settings are
copied into the deploy-mode file unchanged, so one file shape works in both modes, and the controller
only validates them at start. Mail is sent only from dashboard flows (invitations), and the dashboard
does not work in deploy mode (https base URL with nothing listening). Mailpit is therefore verified in
app mode only, and neither the docs nor the manual check claim otherwise.

`env/worker.env` (deploy mode), a complete list for the worker: `LAUNCHPAD_DEPLOYMENTS=on`,
`LAUNCHPAD_ALIASES` (same value as the controller), `DATABASE_URL`, `LAUNCHPAD_DATA_DIR`,
`LAUNCHPAD_BASE_URL`, `LAUNCHPAD_APPS_DOMAIN`, `LAUNCHPAD_APPS_PROXY_URL=http://127.0.0.1:33181`,
`DOKKU_SSH_HOST=127.0.0.1`, `DOKKU_SSH_PORT=33222`, `DOKKU_SSH_USER=dokku`,
`DOKKU_SSH_KEY_PATH=<abs>/credentials/id_ed25519`, `DOKKU_SSH_KNOWN_HOSTS_PATH=<abs>/credentials/known_hosts`,
the same five router settings as the table above (instance id, control URL, probe URL, token file,
epoch file; the worker reads them only with aliases on, but they are always written so flipping the
switch needs no new file), and `LAUNCHPAD_BASE_IMAGE` (nginx pin from prod). Lifecycle and limit settings
the controller overrides (stale-after, archive limits) must be copied to both by hand; the docs say so.

**Parser test (required, in `tooling/dev-infra.spec.ts`).** Render both env files for deploy mode with
aliases on and off and assert, using the real exports of `@launchpad-kit/services` and
`@launchpad-kit/auth`: `parseDeploymentConfig`, `parseAliasConfig` and `parseAppRoutingConfig` all report
`enabled: true` for controller.env and worker.env; `loadAuthConfig` accepts the app-mode controller.env;
`assertPrivateControlUrl` accepts the control URL; removing any one of the six routing settings makes
`parseAppRoutingConfig` throw (so the list cannot silently shrink). The same specs run in app mode:
`loadAuthConfig` yields `smtp` set and a URL `createSmtpMailer` accepts.

Worker run command: needs a `dev` task (finding 6). Add `dev` to `apps/worker/project.omni.yaml`
(`bun --watch src/index.ts`, `persistent: true`, `cache.enabled: false`); verify that workspace
packages resolve from source (the controller's dev server already does) before relying on it. The CLI
is `bun apps/cli/dist/index.js` after `omni -i run build -p @launchpad-kit/cli`, as the quickstart says.

## Tasks (Omni) vs raw `docker compose`

Add to `tooling/project.omni.yaml`, each `cd "$(git rev-parse --show-toplevel)" && bun tooling/dev-infra.ts ...`
(same shape as `local:deploy`), uncached:

| Task | Does |
| --- | --- |
| `dev:infra:up` | Preflight (Docker native, `DOCKER_HOST` unset, `.dev-infra/` ignored, ports free), create state, build router and Dokku images, start postgres + mailpit + dokku, wait healthy, bootstrap Dokku and router once (idempotent: skipped when already done), start router, print endpoints and the env blocks. Idempotent and quick when warm. |
| `dev:infra:down` | Stop everything but **keep** data (database, Dokku state, credentials, images): fast restart path. Stops Dokku site containers by label too (finding: they live outside the project and outlive `compose down`). |
| `dev:infra:destroy` | Remove everything it created: sites (destroy Dokku apps, remove containers and `launchpad/site:*` images by exact validated name), project containers/volumes/networks, its images, root-owned `dokku/` via helper container, then `.dev-infra/`. Same safety rules as `local:deploy down` (labels and records only, no prune, no wildcards). |
| `dev:infra:status` | Per-service health, ports, URLs, deployed sites. |
| `dev:infra:logs` | `docker compose ... logs -f [service]` (thin wrapper so the project name and env file are right). |

Raw `docker compose -p <p> --env-file .dev-infra/compose.env -f docker-compose.dev.yaml up -d` works
after the first `dev:infra:up` for ad-hoc use, and is documented as such, but the tasks are the
supported path (first start needs the bootstrap; teardown needs the site cleanup).
Plain `docker compose down` would fail to remove the `apps` network while site containers are attached,
so the docs say to use `dev:infra:down`.

## Coexistence

- **`local:deploy`:** different project prefix (`launchpad-dev-` vs `launchpad-local-`), directory,
  images, `apps` network and port block; they can be configured side by side, but two Dokku instances
  are heavy and the docs say to run one at a time. To verify in slice 1: Dokku's own container cleanup
  does not touch the other stack's site containers.
- **`test:db:up`:** `launchpad-test-db` on 55432, independent. Integration tests keep using it;
  the dev database is separate (35432).
- **Quickstart's `docker run ... launchpad-dev-db` on 5432:** replaced in `docs/local-quickstart.md`
  by `dev:infra:up` (see Docs); the old container name must not clash (the new project name differs).

## Docs to update (same change, per AGENTS.md)

- `docs/local-quickstart.md`: step 2 (Postgres) points to `dev:infra:up` as the easy path, keeps "any
  server works"; `.env.local` block now generated; seed unchanged.
- `docs/local-deploy.md`: one paragraph "Developing the apps themselves? use dev infra" and the
  contrast (all in Docker vs infra only).
- New `docs/local-dev-infra.md` (how-to, with the read-this-first warnings in the same order the
  `local-deploy` guide uses: root-equivalent Dokku socket, loopback only, unpinned Dokku packages, state
  directory, `destroy` deletes data, mode limits, not production).
- `README.md` (local development pointer), `CONTRIBUTING.md` (task table and "Local services"),
  `docs/tooling.md` (tool, `.dev-infra/`, the new check), `docs/patterns/README.md` (compose dev file
  next to the production one), `apps/worker/README.md` (host `dev` task), `apps/controller/.env.local.example`
  (SMTP lines already present; add the Mailpit hint).
- `docs/production-compose.md`: one line saying dev Compose is separate and not a production template.

## Checks and tests

- **`tooling/compose-dev.ts` + `compose-dev.spec.ts`** (model the production pair; export
  `checkRendered()` and keep `if (import.meta.main)`): unit-render the raw YAML with an example env and
  `docker compose config` it; assert: services are exactly postgres, mailpit, dokku, router; every published
  port is bound to `127.0.0.1`; no controller/worker/admin; no `env_file`; every external image carries a
  `@sha256:` digest (the production check lives inside `assertProduction`, lines ~173-184 and ~290 of
  `compose-production.ts`; it does not scan another file, so the dev module carries its own copy of the
  digest assertion); every `image:` of a built service is `${DEV_PROJECT:?}/<service>:local`; the Dokku
  block, PostgreSQL image reference and Dokku healthcheck equal the production file's; the Docker socket
  is mounted only into Dokku; router control is published only on loopback; the file fails to render
  with an empty env. It also asserts `.dev-infra` is a line of `.gitignore` and of each of
  `apps/{controller,worker,router}/Dockerfile.dockerignore` (a new test, so the existing
  `compose-production.spec.ts` assertion for `.local-deploy` is untouched).
- **Repo pin and consistency checks, verified:** `check:deps`, `check:versions` (`tooling/versions.ts`,
  `cog.toml`) and `tooling/check-images.ts` do not read any Compose file, and `check-images` builds only
  the controller, worker and router images by their Dockerfiles, so none needs a change for the new file
  or the Mailpit image (`release-dry-run.ts` also does not read compose). External-image pinning is
  enforced only in `compose-production.ts` (prod file) and, for Dockerfiles, in `assertDockerfiles`.
  What must change: the new `compose-dev.ts` pin assertion above; the Mailpit digest comment style
  (tag, digest, date read) as in the Dokku Dockerfile; and `docs/production-compose.md` "Images and
  pins" gets one line saying the dev file's pins are asserted by `compose-dev.ts`. The Mailpit tag/digest
  and its healthcheck command are **verified in slice 0** (the plan's `v1.29` / `sha256:757f22b5...` was read
  from the registry on 2026-11-27 and is not yet proven to start or to ship a healthcheck binary).
- **`check:compose` wiring (exact change).** `tooling/project.omni.yaml` line 60 runs only
  `bun tooling/compose-production.ts`. Change that `exec` to
  `sh -c 'cd "$(git rev-parse --show-toplevel)" && bun tooling/compose-production.ts && bun tooling/compose-dev.ts'`
  and update its `description` to mention both files. No wrapper script (each module keeps its own
  `import.meta.main` entry and clean-environment renderer). Unaffected, verified by reading them:
  `ci.spec.ts` lines ~86 and 96-99 test only that CI runs the task name `check:compose` and that `check` does
  not satisfy it, and `.github/workflows/ci.yaml:55` already runs `check check:compose`;
  `local-deploy-docs.spec.ts` reads `docker-compose.yaml` only (the new docs spec reads
  `docker-compose.dev.yaml` and `docker-compose.yaml` separately); `compose-production.spec.ts` is not edited.
- **`tooling/dev-infra.spec.ts`**: arguments, port planning, env/`known_hosts` rendering
  (`[127.0.0.1]:<port>`), generated app env passes the real parsers (`parseAppRoutingConfig`,
  `parseAuthConfig`, `assertPrivateControlUrl`) so drift between docs and code fails a test; fake-host
  scenario for `up`/`down`/`destroy` using the existing `local-deploy-fake.ts` harness.
- **`tooling/dev-infra-docs.spec.ts`**: copy the `local-deploy-docs.spec.ts` approach: tasks and
  projects named exist, settings named exist, default ports in the guide equal the code, warnings in order.
- Existing: `local-deploy*.spec.ts` must pass unchanged after the helper extraction;
  `omni -i run check test build` and `check:compose` locally; CI covers `check:compose`.
- Manual, once, recorded in the PR (not a test in CI; the repo does not start Docker in CI for this):
  `dev:infra:up` cold and warm timings, `local:seed`, a `hello` deploy, an alias promotion, a Mailpit
  invitation, `down` then `up` (state kept, site restarts or is reported), `destroy` leaves no
  container/network/volume/image/dir.

## Risks

1. **Dokku site containers vs `down`.** They sit outside the project; after `down` they keep running
   (or are not restored) and block removal of the `apps` network. Mitigation: label-based stop in
   `down`, existing destroy logic in `destroy`; first thing to test.
2. **Teardown deletes things.** Highest risk: reuse the existing ownership/label-checked code, no
   new wildcard or prune; independent review.
3. **Plain-HTTP router control** untested here: verify the router healthcheck and published control
   listener work without TLS (finding 2) before building more. Fallback: keep TLS with the
   existing generator (adds `openssl` and the CA file; control URL `https://127.0.0.1` then fails the
   cert name `router`, so it would need `LAUNCHPAD_ROUTER_CONTROL_TLS_SERVER_NAME` / SAN for `127.0.0.1`
   and a SAN IP; not recommended).
4. **Root-equivalence** of the Docker socket in Dokku (documented, loopback-only).
5. **Mode confusion** (app vs deploy base URL): a wrong value makes the controller refuse to start with
   a clear message; documented as two env presets.
6. **Drift** between prod and dev Dokku/PostgreSQL/router: covered by the equality spec.
7. **Mailpit pin** needs a digest and a policy for bumping (mirrors the Dokku pin comment).
8. **State dir inside the checkout and Docker build contexts** (root-owned `dokku/`): the
   `.dockerignore` additions are required, and a spec should assert `.dev-infra` appears in every
   `Dockerfile.dockerignore` and `.gitignore`.
9. `apps/worker` `dev` under Bun source-resolution is unverified.

## Slices (in order; each leaves the repo green)

0. **Experiment (no code kept):** confirm router plain-HTTP control + healthcheck, Dokku site container
   behaviour across `stop`/`start`, worker `bun src/index.ts` with `.env.local`, and:
   - **Mailpit:** the tag/digest starts, accepts plain `smtp://127.0.0.1` from the controller's mailer, and which
     healthcheck command the pinned image provides (record the digest and the date read).
   - **Root-owned state vs builds:** with a root-owned `dokku/` subtree present at `<repo>/.dev-infra/`, run
     `docker build` for the controller, worker and router contexts (repo root) with and without the
     `.dockerignore` entries; the entries must make it succeed, and show what fails without them.
   - **`docker compose down` and the `apps` network:** with a deployed site container attached, plain
     `down` (with and without `--volumes`) and what it leaves; confirm the plan's claim that the label-based
     stop is needed, and that `destroy` order (sites, project, network) works.
   Any "no" changes the plan.
1. **Extract shared helpers** from `tooling/local-deploy.ts` into `tooling/local-docker.ts`; `local:deploy`
   specs unchanged and green.
2. **`docker-compose.dev.yaml`** + `compose-dev.ts/spec` + `check:compose` extension + ignore entries.
3. **`tooling/dev-infra.ts`** (`up/down/destroy/status/logs`) + specs + Omni tasks + worker `dev` task.
4. **Docs** (new guide, edits above) + docs spec.
5. **Manual verification** on a Linux host, recorded; independent review (Medium risk).
Slices 2 and 4's drafts can run in parallel after 0; 1 -> 3 is sequential. One agent owns integration.

Undo: all changes are additive except the helper extraction (revert the commit) and doc edits; `destroy`
removes runtime state.

## Open decisions (with recommendations)

1. **Structure:** standalone file (recommended) vs `extends`/`include` (rejected above).
2. **Teardown semantics:** `down` keeps data and stops sites, `destroy` wipes (recommended) vs a single
   `down` that wipes like `local:deploy`. Recommend two commands: fast cycles are the point.
3. **Tool shape:** new `dev-infra.ts` reusing extracted helpers (recommended) vs a mode of
   `local:deploy` vs raw compose only (insufficient: bootstrap and site cleanup).
4. **Writing `.env.local`:** print and write `.dev-infra/env/*.env` only (recommended; never touch a
   developer's files) vs write the apps' `.env.local` when absent.
5. **Dashboard with deployments on:** accept the `local:deploy` limit and offer the two presets
   (recommended) vs add a local-TLS proxy service (Caddy) later as a follow-up.
6. **Router control TLS:** plain HTTP on loopback (recommended; no `openssl`, no CA) vs keep TLS parity.
7. **Ports:** the 31025/38025/33xxx/35432 block (recommended; env-overridable) vs a single
   `--port-base` like `local:deploy`.
8. **Mailpit persistence:** none (recommended).
9. **Publish Dokku HTTPS (443):** no (recommended).
10. **Image names:** `launchpad-dev-<hash8>/<svc>:local`, hash of the checkout path, with a build label checked
    before removal (decided in the revision; sharing prod's `launchpad/dokku:<ver>` tag is rejected because
    one checkout's `destroy` could remove another stack's image).
11. **Docker group:** host worker uses the developer's own Docker access; acceptable, since the
    developer already has it. Confirm.
12. **Controller env in deploy mode:** write the full routing list into `controller.env` (recommended: the admin
    task that `local:seed` and recovery use needs it) even though the server itself needs only the apps
    domain and switches. Alternative: a minimal controller file and a separate admin file; rejected as
    more to explain.
13. **`check:compose` wiring:** chain the two scripts in the existing `exec` line (recommended) vs a new
    wrapper script or a separate `check:compose:dev` task (would need a CI and `ci.spec.ts` change).
14. **Helper extraction style:** a profile object passed to shared functions (recommended) vs copying the
    teardown into `dev-infra.ts` (duplicates the deletion code that most needs review).

## Revision log

Revised after independent review (nine findings), each checked against code: finding 1 refined (the server
needs only the apps domain/switches; the worker with aliases on and the admin task need the full list, so
controller.env carries it); 2 adopted (`launchpad-dev-<hash8>` tags plus a label check); 3 verified (no repo
pin check reads Compose except `compose-production.ts`; the dev module needs its own); 4 specified (profile
table); 5 specified (chain in the `exec` line); 6 stated (Mailpit is app-mode only); 7, 8 reworded; 9 added to
slice 0 and to the checks.

## Slice 0 results (2026-11-27, throwaway project `launchpad-dev-exp-1`, all removed afterwards)

No result contradicts the plan.

- **Mailpit:** `axllent/mailpit:v1.29@sha256:757f22b5...` (index digest, read and pulled 2026-11-27) starts and
  its image has `/mailpit readyz`; the container reports `healthy`. The controller started with
  `LAUNCHPAD_SMTP_URL=smtp://127.0.0.1:31025` in the same run.
- **Plain-HTTP router control:** `router init` ran with no TLS settings, `LAUNCHPAD_ROUTER_CONTROL_LISTEN=0.0.0.0:3081`
  and `PRIVATE_NETWORK=1`; the router is `healthy`; `curl http://127.0.0.1:33183/healthz` answers `{"status":"ok"}`.
  The host worker with aliases on accepted the `http://127.0.0.1` control URL.
- **Host worker:** `bun src/index.ts` in `apps/worker` reads `.env.local` and starts with workspace packages
  resolved from source. A `hello` deployment through it (host `docker` build, SSH to `127.0.0.1:33222`, pinned
  `[127.0.0.1]:33222` host key) reached `succeeded`, and `curl -H "Host: ..." http://127.0.0.1:33181/` answered.
  `local:seed` against the deploy-mode controller env worked, but it issues a key with only four scopes: deploying
  needs the deploy scopes, so `dev-infra` gets a `seed` command that passes `scopesFor(...)` (a small addition to the plan).
- **Site containers across stop/start:** `docker compose stop` leaves the site container running; Dokku is killed
  (exit 137, 10 s grace). After `docker compose start` a site container that had been stopped was restarted by Dokku
  within 60 s and answered 200. So `down` stops sites by label and `up` needs no extra step (it reports them).
- **Plain `docker compose down`** removes the services and the project network but prints "Resource is still in use"
  for the `apps` network and leaves the site container (and, after a restore, a renamed exited twin
  `lp-<id>.web.1.<n>`). `down --volumes` additionally removes the volumes and still leaves `apps`. The label-based
  stop in `down` and the exact-name site removal in `destroy` are therefore needed, and `destroy` must handle the exited twin.
- **Root-owned `dokku/` vs builds:** with `.dev-infra/dokku` root-owned in the repo, `docker build` of the router,
  controller and worker contexts all fail with `error from sender: open .dev-infra/dokku/home/dokku: permission denied`;
  with `.dev-infra` in the three `Dockerfile.dockerignore` files all three build.
