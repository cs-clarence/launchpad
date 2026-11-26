# Local deployment quickstart: Dokku, worker and controller on your machine

Extends [the local quickstart](local-quickstart.md) (built; `docs/local-quickstart.md`,
`tooling/local-seed.ts`) so a developer can deploy `examples/hello` end to end on one machine. Builds
on [the production Compose stack](../production-compose.md), which already boots this whole topology
on disposable hosts (`tooling/experiments/compose/`).

## Assessment

- **Kind:** medium work. One new tooling script, a real refactor of the seed (its command runner gains
  stdin, the admin arguments and failure hints become mode-aware, the key scopes become a parameter), one
  new guide and a doc-drift test. No controller, worker, contract, database or `docker-compose.yaml`
  change.
- **Risk tier:** Medium to High. The tool generates SSH keys, a router token and a throwaway TLS CA, runs a
  stack in which the worker and Dokku hold the host Docker socket (root-equivalent, see
  [production Compose](../production-compose.md#what-is-not-production-ready)), and deletes containers and
  images. Treat it as High for review: an independent review of this plan precedes step 1, and of the
  script before the real run.
- **How much changes:** `tooling/` (new script, task, tests), `tooling/local-seed.ts` (the refactor
  above), `docs/` (new guide, links), `.gitignore`.
- **Unknowns:** six, each settled by step 1 (listed under Risks). None blocks it.
- **Move up a kind if:** a controller or worker change is needed (for example to serve the dashboard over
  local TLS or to relax the `https` rule), `docker-compose.yaml` itself must change, or the tool has to
  support Docker Desktop, rootless Docker or Podman.

## What was found (the facts this plan rests on)

1. **Everything can run in Compose.** `docker-compose.yaml` defines `postgres`, `controller`, `worker`,
   `dokku`, `router` and an `admin` one-off. Published ports are loopback only: controller 32180,
   Dokku SSH 32222, Dokku HTTP 32181, HTTPS 32443, router data 32182. Postgres sits on an `internal`
   network, so a host controller (`omni run dev`) could not reach it, and the worker needs the
   controller's `/data` archives (a shared volume). **Rejected:** host controller + Compose rest.
2. **The router is required even with aliases off.** The worker `depends_on` a healthy router, and Compose
   makes the router's files mandatory. The minimum is all five services; only `LAUNCHPAD_ALIASES=off`
   removes router use at runtime.
3. **Startup validation blocks plain `http` and bad domains** (`packages/services/src/app-routing-config.ts`,
   run by `apps/controller/src/server/startup-settings.ts`). With `LAUNCHPAD_APPS_DOMAIN` set,
   `LAUNCHPAD_BASE_URL` must be an `https` origin with no path, and the two must not share a registrable
   domain (public suffix list) nor nest. **Run against the real validator:** base
   `https://control.localhost:8443` with apps domain `apps.localhost` passes; `https://localhost:8443` with
   `apps.localhost` fails; `apps.localhost` with `https://control.apps.localhost` fails; `sites.localhost`
   with `https://127.0.0.1:8443` passes. The apps domain must match `APPS_DOMAIN_PATTERN` (dotted,
   alphabetic TLD), which `apps.localhost` does.
4. **The `https` rule concerns the configured origin, not what you connect to.** The controller checks only
   that a session request's `Origin` equals `LAUNCHPAD_BASE_URL`; Bearer-key requests carry no origin check.
   The shipped quickstart already seeds through `http://127.0.0.1` while sending an `https` origin
   (`--controller ... --origin ...`), and the CLI and seed accept `http` for loopback. So **no TLS proxy is
   needed for the seed, the CLI or the API**. TLS matters only for a browser: the dashboard needs the
   cookie origin to equal the base URL with `Secure` cookies, and its preview link is `https://<hostname>`
   with no port (`deployment-apps.tsx:356`), which cannot reach an unprivileged loopback port. Dashboard
   use is out of scope (a Caddy-with-local-CA follow-up, see [the ingress example](../ingress-example.md)).
5. **Reaching a deployed site.** The worker verifies a deployment itself (proxy URL `http://dokku:80` with a
   `Host` header). From the host: `curl -H "Host: <hostname>" http://127.0.0.1:32181/`, or
   `http://<hostname>:32181/` in a browser (`*.localhost` resolves to loopback in current browsers and in
   curl 7.78+). On this research host glibc resolved `*.localhost` to `::1` first while Docker publishes
   `127.0.0.1` only, so the guide leads with the `Host`-header form, offers an `/etc/hosts` line
   (`127.0.0.1 <hostname>`, needs root) for resolvers that do not map `*.localhost`, and treats the
   browser form as a bonus (Unknown 2). The alias router (32182) is not used: aliases stay off.
6. **Required variables.** `docker-compose.yaml` refuses to render unless all of these are set (`${VAR:?}`):
   `POSTGRES_PASSWORD`, `LAUNCHPAD_AUTH_SECRET`, `LAUNCHPAD_ALIAS_INSTANCE_ID`, `LAUNCHPAD_BASE_URL`,
   `LAUNCHPAD_APPS_DOMAIN`, `DOCKER_SOCKET_GID` (the worker's `group_add`), `DOKKU_DATA_DIR` (absolute
   physical path), `LAUNCHPAD_BACKUP_DIR` (the admin mount, owned by 10001),
   `LAUNCHPAD_DOKKU_SSH_KEY_FILE`, `LAUNCHPAD_DOKKU_KNOWN_HOSTS_FILE`, `LAUNCHPAD_ROUTER_TOKEN_FILE`,
   `LAUNCHPAD_ROUTER_EPOCH_FILE`, `LAUNCHPAD_ROUTER_TLS_CA_FILE`, `LAUNCHPAD_ROUTER_TLS_CERT_FILE`,
   `LAUNCHPAD_ROUTER_TLS_KEY_FILE`. Bind sources are never auto-created, so every path must exist first.
   The rehearsal runner (`tooling/experiments/compose/run.ts`, `fixture.ts`) produces them and this reuses
   its steps: the worker's ed25519 SSH key pair; Dokku's host key pinned into `known_hosts` (read from the
   running Dokku); the router token (64 hex) and, after `router init --token-stdin`, its epoch; a throwaway
   CA (private key deleted after signing), a server certificate with SAN `router` and its key; hex
   `POSTGRES_PASSWORD`, `LAUNCHPAD_AUTH_SECRET`, a lowercase-UUID instance id; `DOCKER_SOCKET_GID` from
   `stat` of `/var/run/docker.sock`. The key, token, epoch, `known_hosts`, TLS key and backup directory must
   be owned by uid 10001 (token mode 0600), which a host user cannot do, so a root helper container
   (`--network none`, `--entrypoint chown`) fixes ownership, as the runner does. All of it is generated on
   loopback with host `ssh-keygen` and `openssl`; no secret goes in an argument.
7. **Costs measured by earlier rehearsals** (production Compose, "Resource limits"): idle total about
   160 MiB; Dokku's first start on an empty state directory about 4.5 minutes, later starts about one; a
   deploy about 66 s; worker peak 35 MiB for a small site. Memory limits are 0.5 + 0.5 + 1 + 1 + 0.125 GiB
   (postgres, controller, worker, dokku, router), about 3.1 GiB, or about 3.6 GiB with the 0.5 GiB admin
   container running. Builds and app containers run in the host engine, outside those limits. Image sizes,
   first-run build time and disk are **not measured**: the real run records them (step 6).
8. **Cleanup is not just `compose down`.** Dokku's app containers and the worker's `launchpad/site:<id>`
   images live in the host engine, outside the Compose project, and the Dokku state directory is root
   owned. `LAUNCHPAD_APPS_NETWORK` defaults to the fixed name `launchpad-apps`, which would collide with a
   real install on the same host; the tool sets `<project>-apps`.
9. **Deletion rules** (`packages/services/src/deployment-deletion.ts`): `DELETE /deployments/:id` needs
   `app:delete` and is refused with 409 when the deployment is not `succeeded`, `failed` or `cancelled`
   (this includes `reconciliation-needed`), is already `deleting`, or is pinned by an alias or pending
   promotion. Shutting an app down needs `app:delete`, `app:alias:manage` and `app:promote`, which the key
   does not have. **Scopes:** artifact upload, app create and deployment create need only `app:deploy`
   (`artifacts.ts`, `apps.ts`, `deployments.ts`); reads need `app:read`. The deploy-mode key therefore
   carries six scopes: the seed's four (`organization:read project:read project:create app:read`) plus
   `app:deploy` and `app:delete`. The default seed keeps its four.
10. **The seed's current shape** (`tooling/local-seed.ts`): `Run = (args) => Promise<RunResult>`;
    `spawnRun` hard-codes `stdin: "ignore"` and `omni run` forwards no stdin; `adminArgs` always passes
    `--password-file`; `classifyAdmin` tells the user to edit `apps/controller/.env.local`. The admin
    commands accept the password on stdin or in a mode-600 file (`apps/controller/src/admin/main.ts`).

## Goal and done

A developer on a Linux machine with Docker Engine, Bun, Omni, `openssl`, `ssh-keygen` and `tar` runs a
short sequence and ends with: the five services healthy, deployments on, an organization, a project, a key
with the six scopes, the `hello` site deployed with `launchpad` and answering 200 with its page, and one
command that removes what the run created: this project's containers, volumes, network, the five images it
built, the deployed sites' Dokku apps and images, and the state directory. Pulled base images, dangling
layers and the build cache stay (the guide names `docker image prune` and `docker builder prune`).
Nothing public: every host port is loopback.

Done when (a) the worked example holds in a real run by the build task, with unique names and verified
cleanup; (b) the unit tests below pass, with `down` tested before any real run; (c) `omni -i run check test build` is green; (d) the docs below are
updated and the new drift test passes.

## Scope and out of scope

In scope: `tooling/local-deploy.ts` and task `local:deploy` (subcommands `up`, `status`, `down`); the seed
refactor; `docs/local-deploy.md`; tests; doc links; `.gitignore`.

Out of scope: `hello` and `wait` convenience subcommands (a follow-up; the guide documents the manual
`launchpad` commands and a plain shell polling loop); dashboard use and any TLS proxy (follow-up); aliases
and the router's control plane at runtime (`LAUNCHPAD_ALIASES` stays `off`); public exposure; macOS,
Windows, Docker Desktop, rootless Docker, Podman and a remote `DOCKER_HOST` (refused: bind-mount paths and
socket groups would be wrong or dangerous); more than one worker; backup and restore; changing
`docker-compose.yaml`, `docker-compose.env.example` or `tooling/compose-production.ts`; importing from the
experiments (they stay opt-in and unimported, see `docs/patterns/README.md`).

## Worked example

Happy path (what the guide says):

1. `bun install --frozen-lockfile && omni remote-sources install && omni projection sync`.
2. `omni -i run local:deploy -a options=up`. The tool: checks prerequisites, that `.local-deploy/` is
   git-ignored, and ports; writes `.local-deploy/` (mode 700) with `state.json` **first, before any Docker
   resource exists** (so an interrupted `up` always leaves a record `down` can use), then `compose.env`
   (mode 600), `override.json`, credentials and TLS files; builds the images under unique tags; starts
   `postgres` and `dokku` and waits for them healthy (about 4.5 minutes the first time); sets Dokku's
   `initial-network`; pins its host key and registers the worker's public key; runs `router init`; fixes
   ownership; runs `migrate`, `setup` (operator) and `create-user` (owner) through the `admin` service;
   starts the rest and waits for healthy; creates the organization `local`, project `demo`, and a 90-day
   key with the six scopes saved as profile `local-deploy`. It prints the ports, the profile and the next
   step. Never a secret.
3. Build the CLI once and alias it (as the quickstart does). The profile is loopback `http`, so no CA is
   needed:

    ```sh
    launchpad artifact upload "$PROJECT" examples/hello --directory   # note the artifact id
    launchpad app create "$PROJECT" hello                              # note the app id
    launchpad app deploy "$APP" --artifact "$ARTIFACT"                 # note the deployment id
    until launchpad deployment get "$DEPLOYMENT" | grep -q '"status": "succeeded"'; do sleep 3; done
    ```

    The guide's loop also stops on `failed`, `cancelled` and `reconciliation-needed`, prints
    `launchpad deployment events "$DEPLOYMENT"` then, and gives up after 10 minutes. The deployment's
    `hostname` is in the `deployment get` output. Then this returns the page (or open
    `http://<hostname>:<http-port>/`):

    ```sh
    curl -H "Host: <hostname>" http://127.0.0.1:<http-port>/
    ```

4. `omni -i run local:deploy -a options=status` prints service health, ports and the profile, and refreshes
   the recorded inventory.
5. `omni -i run local:deploy -a options=down` tears everything down (order and rules under Teardown).

Hostnames and TLS: base URL `https://control.localhost:8443` (nothing listens there; it exists to satisfy
the validator and the `Origin` rule), apps domain `apps.localhost`. Deployment hostnames look like
`hello-<10 chars>-preview.apps.localhost`. The seed and CLI use `http://127.0.0.1:<controller-port>` and the
seed sends `--origin https://control.localhost:8443`.

### Teardown (`down`): exactly what is deleted

Deployments are created later by the user's CLI, so their Dokku app names and image tags are unknown at
`up` time. `down` learns them at run time and removes things in this order, so no deploy can slip in after
discovery, Dokku cannot write into the state directory after the helper cleans it, and the files needed to
rerun survive until the end. Every step is safe to repeat: `down` can be interrupted at any point and run
again.

1. **Preflight, deleting nothing.** The Docker daemon must answer. Then, by the project label:
    - **No container carries the project label** (a previous `down` got past step 5, or `up` never started
      anything): skip steps 2 to 5 and **resume at step 6**, using `inventory.json` for the image tags and
      apps still to remove (it was written before the first destroy, see step 3).
    - **The Dokku container exists but is not running:** fail by name, delete nothing, keep `.local-deploy/`;
      the message says to run `docker compose -p <project> start dokku postgres` and `down` again.
    - Otherwise continue. If `state.json` is missing or corrupt: when the project has no labeled resources
      (no container, network or volume), the directory holds only the four fixed children plus ignored files,
      and `state.json` is absent, treat the directory as clean and proceed (so a `down` interrupted in step 9
      finishes); anything else refuses by name (see the edge cases).
2. **Stop the writers.** Resolve the controller and worker container ids at this moment from the labels
   `com.docker.compose.project=<project>` and `com.docker.compose.service=controller|worker` (never from
   `state.json`), `docker inspect` each id to confirm the project label, then `docker stop --time 30`.
   Postgres and Dokku stay up. Then wait, bounded (60 seconds), until the Dokku container has no running
   `docker build` or `dokku` process (a build the worker started over SSH can outlive it). If it does not
   settle, `down` fails by name and keeps `.local-deploy/`; a rerun resumes.
3. **Discover the sites** (the union of four sources; the image tag is always derived, never read):
    - the database: `select id, app_name, desired_state from deployment` through the still-running Postgres
      (as the rehearsal runner does); the image tag is `imageTagFor` of the id (`launchpad/site:` plus the
      id without dashes);
    - `.local-deploy/inventory.json`, last written by `status` or a previous `down`; every row is
      re-validated on read (UUID id, `NAME.app` name) and a malformed file counts as a bad row;
    - `dokku apps:list` inside the project's Dokku container (up at preflight), which needs no database and
      catches a deploy made after the last `status`;
    - containers attached to the project's `<project>-apps` network: inspect the network first and use it
      only if it carries the `com.docker.compose.project=<project>` label; keep only containers whose name
      matches `NAME.app` and that are attached to that network.

    **Unrecognized names:** a database or file row that fails validation aborts `down` with nothing removed;
    a `dokku apps:list` entry or network container whose name does not match `NAME.app` is ignored,
    reported by name, and never destroyed. If the database cannot be read, the other three sources still
    run. **The validated union is written to `inventory.json` before the first destroy**, so a rerun after
    step 5 still knows which apps and image tags to remove. The manual fallback printed if `down` cannot
    proceed is still valid: `docker compose -p <project> exec dokku dokku apps:list`, then `dokku
   apps:destroy <name> --force` and `docker image rm launchpad/site:<id>` for each `lp-` app the user
    recognizes.

4. **Destroy the sites directly.** For every app in the union, whatever its state (`succeeded`, `failed`,
   `cancelled`, unfinished, `reconciliation-needed`, `deleting`, `deleted`, alias-pinned): `dokku
   apps:destroy <app> --force` inside the Dokku container by exact name (an already absent app is fine),
   then the containers labeled `com.dokku.app-name=<app>`, then **every tag** of the exact repositories
   `dokku/<app>` and `launchpad/site:<id>`: `docker image ls --filter reference=<exact repository>` lists
   them and each listed tag or id is removed (never only `:latest`, never a prefix). Then **discover
   once more**: if a source now shows an app, container or image that was not in the union, `down` fails by
   name and keeps `.local-deploy/` (a rerun resumes). `down` never calls the API, the deployment-delete
   route or the app-shutdown path: the database and archives go in step 5, so deletion rules, pins and
   reconciliation do not matter.
5. **Remove the project.** First remove, by id, any container carrying the label
   `com.docker.compose.project=<project>` after confirming that label by inspect (this catches a one-off
   `admin run` container left by an interrupted `run --rm`). Then `docker compose -p <project> --env-file
   <state>/compose.env -f docker-compose.yaml -f <state>/override.json down --volumes --remove-orphans`
   (these files still exist; they need the `${VAR:?}` values and the override). This removes the project's
   containers, the `postgres-data`, `launchpad-data` and `router-state` volumes and its networks. Then
   inspect `<project>-apps` and remove it only if it still exists and carries the project label (normally
   `down --volumes` already removed it).
6. **Root helper.** With Dokku and Postgres gone, remove the contents of the state directory that the
   host user cannot delete (Dokku's root-owned `dokku/`, and the 10001-owned `credentials/`, `tls/` and
   `backups/`) with a helper container using the **pinned `postgres` image named in `docker-compose.yaml`**
   (`POSTGRES_IMAGE`; `up` has already pulled it, and the helper step pulls it if a partial `up` never
   did). It runs before any image removal. Safety rules:
    - The directory is derived from the repository root only, `<repo>/.local-deploy`, never read from
      `state.json`. Before mounting it, `lstat` must show a real directory (not a symlink) owned by the
      invoking user with mode 700, and `realpath` must equal `<repo>/.local-deploy`. Any mismatch refuses.
    - Only that directory is mounted, with `--network none --user 0`, and the helper removes only the fixed
      child names `dokku`, `backups`, `credentials` and `tls`, never `rm -rf` of the mount root or a path
      from outside. `compose.env`, `override.json`, `state.json` and `inventory.json` are owned by the host
      user, stay out of this list and are removed in step 9. A child that is already gone is fine.
    - If the helper cannot run (no image and no network, daemon refuses), `down` removes what the invoking
      user may remove, prints the exact manual command (`sudo rm -rf <repo>/.local-deploy/<name>` for each
      fixed name), keeps `.local-deploy/` and exits nonzero.
7. **Image tags.** Remove the five project tags (`<project>/{controller,worker,dokku,router,admin}:local`,
   derived from the project name) and, on a resumed run, any app or site image tag still listed in
   `inventory.json` (every tag of the exact repositories, as in step 4). **Pulled images (postgres, nginx,
   the Bun and Dokku bases) are never removed.**
8. **Profile and verification.** Delete the `local-deploy` CLI profile if it still names this controller.
   Proof: no container, network or volume with the label `com.docker.compose.project=<project>`; no
   container labeled for a discovered app; no discovered image tag and none of the five project tags; the
   four helper-handled directories gone. On any failure `down` prints what remains, **keeps
   `.local-deploy/` (with `compose.env`, `override.json`, `state.json` and the inventory) so it can be run
   again**, and exits nonzero.
9. **Remove the state last.** Only after step 8 passes: delete `compose.env`, `override.json`,
   `inventory.json`, then `state.json`, then `.local-deploy/` itself. `state.json` goes last so an
   interruption never leaves a directory that looks foreign.

**Why it cannot touch anything else:** every removal is by exact name or id taken from this project's own
labels and validated records (the Compose project label confirmed by inspect, the validated discovery union),
or from the five image tags derived from the project name, all checked against fixed patterns before use; a
network or container is touched only after its project label is confirmed; there is no wildcard, prefix or
`prune`; the project name must match `^launchpad-local-[a-z0-9-]{1,40}$` and carries a hash of the
repository path by default (see the edge cases) so another checkout's or the user's own stacks and images
cannot match; and the root helper mounts one directory derived from the repository root and removes four
fixed child names.

**Name patterns.** `NAME.app = /^lp-[a-z0-9]{10}$/` and `NAME.tag = /^launchpad\/site:[0-9a-f]{32}$/` are
**copied** into `tooling/local-deploy.ts` from `tooling/experiments/acceptance/harness.ts` (nothing imports
from the experiments). A test ties the copies to the real generators: names from `opaqueId(10)` behind
`lp-` (`packages/services/src/deployments.ts`, `ids.ts`) and tags from `imageTagFor` in
`apps/worker/src/template.ts` must match, so a changed generator fails the test.

Complexities and edge cases, each one message and a nonzero exit:

- **Docker missing, daemon down, or not Linux/native** (`docker version`, `docker compose version`, `docker
  buildx inspect default`, `docker info` for rootless and OS): named message; a non-default socket path,
  `DOCKER_HOST` or Docker context is refused. The tool always passes `--host unix:///var/run/docker.sock`.
- **Ports:** the five defaults are 32180 (controller), 32181 (Dokku HTTP), 32182 (router data), 32222
  (Dokku SSH) and 32443 (Dokku HTTPS). Each is probed by binding `127.0.0.1`; a busy one stops `up` naming
  it and the `--port-base <n>` option: offsets from `n` of 0, 1, 2, 42 and 263 for the controller, HTTP,
  router, SSH and HTTPS ports, so the default base 32180 reproduces the five defaults. The base must satisfy `1024 <= n` and
  `n + 263 <= 65535`, or `up` refuses before touching anything. Never stops what owns a port.
- **Ports on re-run:** chosen once and persisted in `compose.env`; `up` never changes them. A persisted
  port that is busy is checked against this project first: `docker compose ps` names the project's
  published ports and a port published by its own container is not "busy". A port busy for another reason
  stops `up`; to move, run `down` and `up --port-base` again.
- **Dokku slow to start:** waits up to 11 minutes (the runner's budget) with progress lines; on timeout
  prints `docker compose logs --tail 50 dokku` and keeps everything for inspection.
- **Compose/Buildx version problems:** no checks are loosened; the message points at the observed
  combinations in [the recovery record](production-fresh-host-recovery.md#repeat-the-rehearsal).
- **Deploy fails:** the guide's loop prints the failing status and the events and points at `docker compose
  logs --tail 50 worker`. A `reconciliation-needed` deployment is explained with a link to
  [deployments](../deployments.md#when-the-worker-cannot-confirm-something); `down` still removes it
  (Teardown step 4).
- **Stuck work:** an app has at most one unfinished deployment; the loop times out at 10 minutes, saying
  the deployment may still run.
- **Re-running `up`:** idempotent. Existing credentials, state and running services are kept; a healthy
  stack is only re-checked and re-seeded (the seed is safe to repeat). It never regenerates a file that
  exists (that would orphan Dokku's pinned host key and the router epoch).
- **`.local-deploy/` must be ignored:** the `.gitignore` entry lands with the first script step (step 2),
  and `up` also refuses to write secrets unless `git check-ignore` confirms the directory is ignored.
- **Two checkouts:** the default project name is `launchpad-local-<8 hex>`, the first eight hex characters of
  a SHA-256 of the checkout's physical repository path, so two checkouts get different projects, networks,
  volumes and image tags. Before `up` writes anything it lists containers, volumes and networks with
  `label=com.docker.compose.project=<project>`; if any exist and this checkout has no matching `state.json`
  (project name, repository path, tool version), `up` refuses. A mismatching `state.json` makes `up` and
  `down` refuse too. A directory refused this way is cleaned manually: run `down` from the checkout that
  created it, or, if that is gone, `docker compose -p <project> down --volumes --remove-orphans`, remove the
  containers and images in its `inventory.json` by exact name, and `sudo rm -rf` the directory. `down`
  cannot clean a refused directory itself. A **missing or corrupt `state.json`** is refused by name unless
  the project has no labeled resources and the directory holds only the four fixed children and ignored
  files (Teardown step 1), which is what an interrupted `down` leaves. `--project <name>` is allowed only if it matches `^launchpad-local-[a-z0-9-]{1,40}$`, so its image tags
  (`<project>/<service>:local`) cannot be a user's own (`launchpad/controller:local`, for example); `up` also
  refuses if any of the five tags, or the `<project>-apps` network, already exists and no matching
  `state.json` owns it.
- **Docker stopped or Dokku stopped during `down`:** fails by name, deletes nothing, keeps `.local-deploy/`
  (Teardown step 1).
- **Stopped machine / reboot:** `up` again starts what exists (the services restart `unless-stopped`). To
  stop without deleting use `docker compose -p <project> stop` (the guide prints it); `down` always
  deletes.
- **Controller not ready right after migrate:** it caches a failed schema check for a few seconds; the seed
  already waits (#97). The tool migrates before starting the controller.
- **Sign-in throttle:** 5 a minute per account; the quickstart's note applies.
- **https/DNS hurdles:** none for the CLI path. The guide states that the dashboard does not work in this
  setup, why (Secure cookies, origin equality, port-less preview link) and where to go.

## Approach

All services in Compose, driven by one new script with injectable seams (command runner, `fetch`, clock,
filesystem), like `local-seed.ts`:

1. `up` reuses `docker-compose.yaml` unchanged with `-p <project>` (default `launchpad-local-<8 hex>`, derived from the repository path), a generated
   `--env-file` and a generated `override.json` giving every image a unique local tag
   (`<project>/<service>:local`, only for the five images the file builds: controller, worker, dokku, router,
   admin) and nothing else; pulled images keep their names and are never removed. The env holds every required variable in Facts 6, plus
   `LAUNCHPAD_DEPLOYMENTS=on`, `LAUNCHPAD_ALIASES=off`, the hostnames above, the ports and
   `LAUNCHPAD_APPS_NETWORK=<project>-apps`. Passwords, keys and the token live only in mode-600 files in the
   state directory; Compose and Docker argv carry none.
2. The seed refactor (step 3): the runner type becomes `(args, input?) => Promise<RunResult>` with an
   optional stdin payload that `spawnRun` pipes (default `ignore` stays when absent); Compose mode runs
   `docker compose ... run --rm --no-deps -T admin <cmd> --email <e>` with the password as that stdin
   payload, never in argv or the environment, so the host needs neither database access nor a uid-10001
   password file; default mode keeps `--password-file` through `omni run admin`; `classifyAdmin` takes the
   mode and its hints name `apps/controller/.env.local` only in default mode (Compose mode points at the
   state directory's `compose.env`, the project's `docker compose logs`, and `local:deploy status`); the key
   scopes become a parameter (default the four, deploy mode six).
3. `down` follows the fixed, resumable order in Teardown: preflight (state-aware), stop the writers and
   let Dokku settle, discover sites from the database, the recorded file, Dokku and the project's apps
   network, write the validated inventory, destroy them directly (no API) and re-check, remove
   label-confirmed containers and the project, run the root helper, remove image tags, verify, and remove
   the state last (`state.json` last of all).

Rejected: a host `omni run dev` controller; a TLS proxy in v1; editing `docker-compose.yaml` or adding a
second Compose file to the repository (the production file has a shape check and the override is generated
per run); making the apps domain `localhost` (fails the registrable-domain rule); `LAUNCHPAD_DEPLOYMENTS=on`
on a host controller without a worker; adding `*.localhost` to the seed's loopback test (a resolver may map
it elsewhere and the seed sends passwords; connect to `127.0.0.1`); a shell script; importing the
experiment `fixture.ts` (guarded, unimported by design, path-locked to `/tmp/opencode`); `--allow-remote`;
deleting through the API or app shutdown, with or without a `--graceful` flag (the key lacks the scopes
for shutdown, deployment delete has refusal rules, and the volumes go anyway); using the worker image for
the root helper (it may not exist after a partial `up`, and `down` removes it); `docker image prune` or
name-prefix scans in `down`; reading the state directory path from `state.json`.

## Steps

Steps marked **[Docker]** cannot be proved without a real Docker run; the build task is authorized to run
them, with unique project name and ports, and must leave nothing behind. The rest are checkable by tests
and `omni -i run check`.

1. **Spike the riskiest unknowns [Docker].** With the recipe done by hand or a throwaway script: render
   `docker compose config --quiet` for the planned env and override; start `postgres` and `dokku` and wait
   healthy; check (a) host `ssh-keygen`/`openssl` output is accepted by Dokku and the worker, (b)
   `*.localhost` resolution and the `127.0.0.1` fallback with `curl` and Bun's `fetch`, (c) `examples/hello`
   including its `Dockerfile` passes the worker's archive rules and deploys, (d) Docker versions, timings,
   image sizes and `docker system df` before and after, (e) the root-helper chown and `rm`. Check: a result
   block in this plan's Status. Undo: `docker compose down -v` for that project, helper `rm` of its
   directory, `docker image rm` of its tags.
2. **Pure planning module (`tooling/local-deploy.ts`, tested), with the `.gitignore` entry.** Settings and
   file plan from a project name, ports and directory; the env and override content; the socket-GID read;
   the backup directory and its 10001 chown; credential generation as argument arrays; preflight decisions
   from injected command output; port probing and the `--port-base` mapping; name and path validation;
   inventory reader; hostnames. Check: unit tests, including (a) **every required variable in Facts 6 is
   rendered** (the generated env, through the existing `interpolate` in `tooling/compose-production.ts`,
   leaves no `${VAR:?}` missing) and the shape assertions hold (loopback ports only, credentials read-only),
   (b) the base URL and apps domain pass `parseAliasConfig` (the real validator) and the bad pairs fail,
   (c) the port mapping and persistence rules. Undo: revert.
3. **Seed refactor.** The changes listed in Approach 2. Check: all existing `local-seed.spec.ts` tests
   unchanged and green; new tests that the runner pipes stdin only when given; Compose-mode runs pass the
   password on stdin and never in argv, environment or output; default mode still passes `--password-file`;
   **Compose-mode failure messages never mention `apps/controller/.env.local`** and default-mode ones still
   do; the default scopes are the four and deploy mode passes the six. Undo: revert.
4. **`up` and `status` with a fake runner (4a), then `down` with its tests (4b).** `up` must not be released
   without `down`: both land in the same PR, and 4b is finished and tested before any real run.
    - **4a, `up`/`status`.** The orchestration in the worked example, idempotent re-runs, port persistence,
      the two-checkout refusal, the ignored-directory check, `state.json` written before the first Docker resource is
      created, interruption handling (`SIGINT` stops waiting and leaves it), and `status` refreshing `inventory.json`. Check: unit tests for the happy
      path and each edge case, the order (migrate before the controller starts, `router init` before the
      worker), no secret in any log or argv, `--port-base` range (below 1024 and above 65535 refused), and
      **tests that `up` refuses** when containers, volumes or networks labeled with the project exist and
      the checkout has no matching `state.json`, when `--project` does not match
      `^launchpad-local-[a-z0-9-]{1,40}$`, and when any of the five tags or the `<project>-apps` network
      already exists without a matching `state.json`; and that the default project name differs for two
      paths; **an `up` interrupted after `state.json` but before and after each resource group (images,
      Dokku, bootstrap, services) leaves a state `down` can clean.**
      Undo: revert.
    - **4b, `down`.** Check: unit tests for (a) **the order**: preflight, stop controller and worker
      (Postgres and Dokku stay up), wait for Dokku to settle, discover and write `inventory.json`, destroy
      Dokku apps and images, re-discover, label-confirmed container
      removal and `compose down --volumes --remove-orphans` (while `compose.env` and `override.json` still
      exist), root helper, five tag removals, verification, `.local-deploy/` removed last (assert on the
      recorded command sequence, including that the helper runs after `compose down` and before the tag
      removals); (b) the controller and worker ids come from the labels at `down` time and each is inspected
      for the project label before `stop`; (c) discovery: a bad database row, a malformed or tampered
      `inventory.json` row (re-validated, tag derived not read) abort before any removal, while a `dokku
      apps:list` entry or network container not matching `NAME.app` is ignored, reported and never destroyed; with the database unreachable the union of the file, `dokku apps:list` and the project's
      apps network still finds a deploy made after the last `status`; a container on a network without the
      project label, or whose name does not match `NAME.app`, is ignored; (d) **one test per deployment
      state** (unfinished, `reconciliation-needed`, `deleting`, alias-pinned, `succeeded`, `deleted`): each
      is destroyed directly by exact name and `down` makes no API request at all; (e) every tag of
      `dokku/<app>` and `launchpad/site:<id>` is listed by exact repository and removed, not only `:latest`;
      (f) Docker down, or the Dokku container present but not running: fails by name, removes nothing, keeps
      `.local-deploy/`; (f2) a fake **straggler**: a build still running in Dokku makes the settle wait time
      out and `down` fail by name keeping `.local-deploy/`, and an app, container or image that appears
      after the destroy is caught by the re-discovery and fails by name, and the rerun removes it; (g) a failed
      verification or helper keeps `.local-deploy/` with `compose.env` and `override.json`, exits nonzero,
      and a second `down` succeeds; **interrupt-and-rerun tests**: `down` interrupted after step 5 (no
      project container left: preflight skips to step 6 and `inventory.json` still drives the tag
      removals), after step 6 and after step 7 each rerun to success, and one interrupted in step 9 after
      `state.json` is the only file left is treated as clean, while a missing `state.json` with labeled
      resources, or with extra children, is refused by name; (h) the helper uses the pinned `postgres` image, removes only the four
      fixed names, and still works when the worker image was never built; (i) **helper path safety**: a
      symlinked `.local-deploy`, a wrong owner, a mode other than 700, a `realpath` that differs and a
      `state.json` naming another path are each refused; (j) only the five project tags are removed, never
      `postgres`, `nginx` or a base image, and the `<project>-apps` network is removed only with the project
      label; (k) every removal argument comes from the validated records or fixed names and none is a
      prefix, wildcard or prune; (l) the name patterns tie to the real generators (`opaqueId`,
      `imageTagFor`). Undo: revert.
5. **Task, guide and drift test.** Omni task `local:deploy` in `tooling/project.omni.yaml`;
   `docs/local-deploy.md` (the polling loop, the `/etc/hosts` and `Host`-header forms, all warnings below);
   extend `tooling/local-quickstart.spec.ts` (or a sibling spec sharing its helpers) so both guides' Omni
   tasks, flags, subcommands, CLI commands, settings and links must exist. Check: the drift test and
   `omni -i run check`. Undo: revert.
6. **Docs links, then real run and cleanup proof [Docker].** Links as listed under Docs to update. Then
   `up`, the manual deploy and polling loop, the probe, `up` again (idempotent), `status`, `down`; prove
   no container, network or volume with the project label, no recorded image tag and no state directory
   remain (pulled images and build cache are expected to remain); repeat after a deliberately failed deploy (an archive without `index.html`) and once
   with the database stopped to prove the `inventory.json` fallback. Record timings, disk, ports and Docker
   versions in the guide's cost table and this plan's Status; replace the first-run time guess. Undo: the
   tool's own `down`, then exact-name removal by hand from the inventory.

## Risks

- **Riskiest: the tool runs with the Docker socket and deletes things.** Mitigations: deletion only by exact
  names from validated records (Teardown), a state record bound to project and path, a refusal of any
  non-default Docker endpoint, loopback-only bindings (no bind-IP option), no wildcard, prefix or prune.
  Tested in step 4b, proved in step 6.
- **Secrets:** key files and `compose.env` are mode 600 in a mode-700, git-ignored directory; nothing
  secret in argv, logs or the summary; the tool prints no password. Tested with output assertions.
- **Unknowns, settled in step 1:** (1) root-owned files and the 10001 chown helper on this Docker version;
  (2) `*.localhost` IPv6-first resolution for curl and Bun; (3) host `ssh-keygen` output accepted by Dokku
  and the worker; (4) the `hello` archive with its `Dockerfile` passing the worker's rules; (5) first-run
  build time and disk; (6) whether the controller needs `HOST`/port settings beyond the Compose defaults.
- **Time:** the first run is dominated by image pulls and builds and Dokku's first start (4.5 minutes
  measured). **A guess of 10 to 20 minutes in total**, not a measurement; step 6 replaces it.
- **Drift:** the drift test guards the guide, and `check:compose` guards the Compose file's shape.
- **Supply chain on first start:** Dokku installs unpinned OS packages from the network (accepted in
  production Compose); the guide says so.
- **Port and network collisions with a real install:** unique project, network and image names; default
  ports probed first.

## Verification: without infrastructure and with it

Without live infrastructure: unit tests with a fake runner, `fetch`, clock and filesystem for steps 2 to 4;
the validator test against `parseAliasConfig`; the required-variable and shape assertions on the rendered
env; the drift test; `omni -i run check test build`. Only a real run shows: that the stack becomes healthy,
that Dokku accepts the keys, that the worker builds and loads the image, that `examples/hello` serves,
name resolution, timings, disk, and that cleanup leaves nothing. That is steps 1 and 6, by the build task
only.

## Docs to update

- New `docs/local-deploy.md`, carrying these warnings in this order: this mounts the host Docker socket into
  the worker and Dokku, which is **root-equivalent on your machine**, so run it only on a machine you would
  trust with that, never on a shared or production host, and deploy only sites you trust; everything binds
  loopback and must stay so; Dokku's first start installs unpinned packages from the internet; generated
  keys and passwords live in `.local-deploy/` and the config directory, so treat them as secrets and do not
  commit or share them; `down` deletes the database, all deployments and the key files; the dashboard does
  not work in this setup; it is not a production install and not a way to try public exposure. It also says
  what to do when `*.localhost` does not resolve (the `Host` header, or an `/etc/hosts` line) and what it
  costs (memory limits about 3.1 GiB, 3.6 GiB with the admin container; time and disk from step 6).
- `docs/local-quickstart.md` (replace "Nothing here deploys" with a pointer), `README.md` (beside the
  `examples/hello` section), `docs/tooling.md` (the task, beside "Local seed"), `docs/patterns/README.md`
  (the script and its seams), `docs/production-compose.md` (one line: the local tool is not the production
  procedure). `CONTRIBUTING.md` near line 152 only if it presents the seed as the only local path.
- Recorded follow-ups: `hello`/`wait` subcommands; dashboard over a local-CA proxy.

## Open questions

None. Decided here: Linux with native Docker only; aliases off; no dashboard or TLS proxy and no `hello` or
`wait` commands in v1; host `ssh-keygen` and `openssl` as prerequisites; default project `launchpad-local-<8 hex>`;
state in `<repo>/.local-deploy/`; six-scope key in profile `local-deploy`; the default seed keeps its four.

## Ready-to-build check

Against `docs/guidelines/planning/ready-to-build.md`: someone else can start step 1 without asking (the
recipe is the rehearsal runner and the commands are named); the goal, scope and finish line are checkable;
no open question blocks the first step; the riskiest parts are covered early: the Docker-dependent
unknowns by step 1 and the deletion safety by the step 4b tests and the step 6 run, with the six unknowns
listed so that none is postponed; every step has a check and an undo; the costly choices (all-Compose, no
proxy, no Compose change, hostnames, teardown rules) are decided with rejected options; the interfaces that
matter (seed runner and scopes, subcommands, state and inventory records) are named in Approach. Gate for
Medium-to-High: an independent review of this plan before step 1, which this revision answers.

## Status

Not started. Research done on 2026-11-26 without containers or servers; the hostname validator results
above were run against the real `assertSeparateDomains` and `parseAliasConfig`. Revised after review.
