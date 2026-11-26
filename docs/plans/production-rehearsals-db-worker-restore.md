# Production rehearsals: database loss, worker liveness and failed restore

Plan only, written 2026-11-26 and revised after independent review. It closes the last open items of the
[production Compose follow-up](production-compose-follow-up.md#outstanding-follow-ups-after-the-bundled-p7-pr):
the capacity gate ("database loss and worker liveness are not rehearsed") and the recovery gate ("a failed
restore is not rehearsed on the Compose topology and schema rollback is untested"). Nothing here has been run.
Writing this plan does not authorize starting any container; the user approves the run (see
[open questions](#open-questions-and-user-checkpoints)).

## Assessment

- **Kind:** medium. Three independent, bounded drills on one disposable stack. No product code changes: the
  output is evidence files and documentation corrections. A new scenario runner is a follow-up, not part of
  this work (see [the harness decision](#harness-decision)).
- **Risk tier:** **High.** The drills are destructive (a Postgres volume is deleted, a worker is killed with
  work in flight, restores are run against a populated database), they run on a stack in which the worker and
  Dokku mount the host Docker socket (root-equivalent), and their results feed production decisions. A wrong
  conclusion is as dangerous as a wrong action, so independent review of this plan comes before the first live
  step, and of the evidence before the follow-up table is edited.
- **How much changes:** `docs/plans/evidence/` (one new directory), edits to
  `production-compose-follow-up.md`, `production-compose.md`, possibly `restore.md`, `deployments.md`,
  `upgrade.md`. No code, no `docker-compose.yaml`.
- **How much is unknown:** a lot, on purpose. Each drill exists to replace a guess with an observation; the
  guesses are listed as hypotheses H1 to H10 below.
- **How hard to undo:** the drills are undone by the exact-name teardown of the disposable project
  (`local:deploy down`), which is proven to leave nothing behind by before/after Docker snapshots. Nothing
  outside the project is touched. The evidence is only files.
- **People and time:** one agent plus a reviewer. The drills need about **7 to 9 hours** of wall time (estimate:
  about 8), most of it waiting. There are **seven restores in five recovery cycles** (pilot R0; D1c R1; V8 failed R2
  and its recovery R3; V9 killed R4 and its recovery R5; D1d R6). Each cycle needs the writer settlement wait
  (about 10 minutes), a router rotation, the 25-minute `recovery-clear` gate and a re-key, about 45 minutes, and V8
  and V9 add about 10 minutes for their second restore; that is about 4 hours. W0 to W7 and D1b each wait out a
  300 s lease (about 90 minutes), and the rest is the cold `up`, the refusal scenarios, write-up and teardown.
- **Move up a kind if:** a drill needs a code change to the worker, controller or Compose file (that becomes a
  separate Medium change with its own plan), or the aliases-on pilot ([S2](#steps)) shows the harness cannot
  carry a promotion drill and the user wants it anyway (then the existing aliases-on runner must be extended).

## What is already known (so the drills do not repeat it)

| Topic                                                            | Already observed, where                                                                                                                                                 | Still open                                                                                                                                                            |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker stopped (`docker stop`) mid-deploy                        | The run ends `authority-lost`, the deployment becomes `reconciliation-needed` about 170 s later ([2026-11-21 record](evidence/p7-compose-20261121/README.md)).          | `kill -9`, a frozen worker, a kill at each step, the restart policy, a kill mid-**deletion**, what an operator or the API sees while the lease runs, a dead database. |
| Stale worker (S12)                                               | `docker pause` past the 300 s lease on the aliases-on stack: the delayed router write is refused, the worker ends `authority-lost` ([P7](deployment-p7-acceptance.md)). | The same for the deployment and deletion paths, and the healthcheck's view of it.                                                                                     |
| Backup, `verify-backup`, restore into a fresh database           | Passed from the stack, and the whole runbook including the 25-minute gate passed on QEMU guests and on the aliases-on Compose rehearsal.                                | Restore after **database loss**, restore into a populated database on Compose, every **failed** restore.                                                              |
| Restore failure handling                                         | Unit and PostgreSQL integration tests in `apps/controller/src/admin/__tests__/restore.spec.ts`: put-back after a failing `pg_restore`, killed importer, refusals.       | The same on real volumes and the real `pg_restore` in the admin image, and what the running controller and worker do afterwards.                                      |
| Dokku and router state backups, whole-host recovery, TLS options | Passed ([state backup](production-state-backup-rehearsal.md), [fresh host](production-fresh-host-recovery.md)).                                                         | Not part of this plan. They enter only where a failed restore leaves Dokku ahead of the database (an orphan app); `restore` never contacts Dokku, which D3 confirms.  |
| Schema rollback                                                  | Forward-only by design: rollback means restoring the pre-upgrade backup ([upgrade](../upgrade.md)). There is one migration (`20261124_001_initial_schema`).             | A real downgrade needs a second migration, which does not exist. Only the refusals can be rehearsed (D3, V6).                                                         |

## Facts this plan rests on (from reading the code, not from a run)

1. **Compose and the stack.** `postgres` has `restart: unless-stopped`, the named volume `postgres-data`, and a
   `pg_isready` healthcheck. The controller, worker and router have `restart: unless-stopped`; the worker's
   `stop_grace_period` is 25 minutes. `depends_on: service_healthy` only orders the first start. Nothing
   restarts a container because it is `unhealthy`.
2. **Controller.** `/api/health` does not touch PostgreSQL. A schema check that passed is cached for the process
   (`apps/controller/src/server/runtime.ts`); one that failed is repeated every three seconds. The operator-only
   `GET /api/v1/status` reads the database but "reports nothing about workers, queues and deployments yet"
   (`packages/services/src/status.ts`), and its `warnings` is always empty.
3. **Worker.** The health marker file is touched after each successful claim query and each lease renewal (and by
   a timer when deployments are off). The Compose and image healthcheck is "file modified in the last minute"
   (interval 15 s, 3 retries, 30 s start period). Every database call has an 8 s wall-clock budget; exceeding it
   aborts the worker, which exits and relies on the restart policy. Other errors are logged as
   `deployment-worker-error` and retried after 2 s. The healthcheck therefore proves the process is alive and
   its database queries succeed; it does not prove Docker, Dokku, the router or progress on a deployment.
4. **Leases.** Deployment, promotion and deletion leases are 300 s on the database clock, renewed every 2 s.
   A **claim** is what turns an expired lease into `reconciliation-needed`: if a step was pending
   (`step_pending` set, other than `verify`) the work is held and never re-dispatched; with no pending step the
   next claim resumes it. With no worker running, an interrupted deployment stays in its in-flight status
   forever and nothing reports it.
5. **Recovery gate.** After a restore, `deployment-recovery-blocked` (in `$LAUNCHPAD_DATA_DIR/maintenance/`) blocks
   every model mutation, including the worker's claims, until `recovery-clear` succeeds, which needs 25 minutes
   from the recorded restore start. Sign-in and organization/key administration stay available. A database with
   no `instance_state` row `deployment_recovery = ready` also blocks; the initial migration inserts that row, so
   a freshly migrated empty database is **ready**.
6. **Restore order** (`restore.ts`): verify the manifest and every file, check `pg_restore` can read the dump
   (`--list`, which reads the table of contents only), refuse a populated target without the exact `--replace`
   address, refuse unknown migrations, check archive collisions, write the recovery marker, copy archives,
   write the importer record, move `public` aside (or create it), run `pg_restore --single-transaction
   --exit-on-error`, verify migrations and archive keys, block the model, drop the old schema. On failure with a
   proven-exited importer it puts the old schema back; otherwise it keeps the importer record and the
   `launchpad_replaced_*` schema. The manifest is not itself checksummed, so a dump replaced together with its
   manifest entry verifies.
7. **Local deploy** (`tooling/local-deploy.ts`): project `launchpad-local-<8 hex of the checkout path>`, state in
   `.local-deploy/` (ignored by git), five services, deployments on, **aliases off**, admin commands run as
   `docker compose ... run --rm --no-deps -T admin <command>` with `.local-deploy/backups` mounted at `/backups`.
   `down` is resumable, finds sites from the database, its own inventory file, Dokku and the apps network (so it
   works with an unreadable or empty database), removes only labelled resources and exact image tags, and
   refuses if the Dokku container exists but is not running (a **paused** Dokku blocks it: undo pauses first).

## Goal and done

**Goal.** Know, from recorded observation on the Compose topology, what happens when Postgres loses data, when
the worker dies or hangs mid-work, and when a restore fails, and whether the documented procedures bring the
instance back to a safe state, or which documents and behaviors must change.

**Done when:**

1. Each scenario in D1, D2 and D3 has a recorded run with commands, outputs, timings and logs under
   `docs/plans/evidence/rehearsal-db-worker-restore-<date>/`, scrubbed of secrets, with a verdict from the
   [pass criteria](#how-a-scenario-is-judged).
2. The documented recovery for database loss (restore runbook, from `verify-backup` to a successful new
   deployment) was executed end to end and its elapsed times are recorded.
3. After the final teardown the before/after Docker snapshots differ only by this project's resources being
   absent, and the three protected containers are unchanged (see [safety](#safety-rules-and-abort-conditions)).
4. The follow-up table rows, `production-compose.md` ("not rehearsed" lines) and any wrong procedure text are
   corrected in the same change; every defect is a listed follow-up with a reproduction, not a fix.
5. The honest residual is written down: schema rollback with a real migration delta, promotion drills if the
   aliases pilot fails, and the real dashboard are still untested if so.

## Scope and out of scope

**In scope:** the three drills on one disposable `local:deploy` stack; reading code and docs; a before/after
snapshot of Docker; evidence files; documentation corrections.

**Out of scope:**

- Production, any existing container, volume, network or image, `docker system prune`, `docker volume prune`,
  `docker compose down` against any project but this one. The `launchpad-test-db`, `cloudflare-connector` and
  `playit-connector` containers and the user's images are never named by a drill command.
- Product fixes (drain on shutdown, a worker staleness signal in `/api/v1/status`, a database-aware controller
  health check, refusing `migrate` over an orphaned data directory). They become issues.
- Dokku and router **state backups**, whole-host recovery, TLS options, upgrade/rollback of images (already
  rehearsed).
- Load, large archives, host reboot (capacity gate items that are not database loss or worker liveness).
- A reusable scenario runner (follow-up, see [harness](#harness-decision)).
- The dashboard: `local:deploy` cannot serve it ([limits](../local-deploy.md#limits)). What the dashboard would
  show is read from the API fields it renders and from its source; it is not exercised.
- Pushing, committing evidence from the drill checkout, or opening a PR unless asked.

## Harness decision

| Option                                                           | Covers                                                                                                                                                                                                                                                                                                                                           | Teardown guarantee                                                                                                                                                                                                                                                                                                           | Verdict                                                                                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Extend `tooling/experiments/compose/run.ts`                      | Aliases-on, a verified bootstrap, an `extra` hook after the alias flow, strong preflight and namespace verification.                                                                                                                                                                                                                             | Very strong, but built for one straight run: `verifyNamespace`, `readDeployments` and the inventory check assume the database and the recorded containers survive. Deleting the volume or killing Postgres makes its own cleanup refuse and keep everything. A run is 6+ minutes and cannot pause for an operator or resume. | Rejected for these drills. Candidate for the follow-up once they pass.                                                        |
| `tooling/experiments/acceptance` (`restore.ts`, `world.ts`)      | A restore drill and a full-stack world with a fault proxy on a QEMU/KVM-style fixture.                                                                                                                                                                                                                                                           | Own resource records, tied to that harness and its fixture.                                                                                                                                                                                                                                                                  | Rejected: different topology, heavy, not the Compose stack.                                                                   |
| **Drive the `local:deploy` stack by hand with a written script** | The exact production `docker-compose.yaml`, the same images, deployments on, a seeded organization/project/key and the `launchpad` CLI, `up` is idempotent (about a minute warm), the admin service with a backup mount, **teardown by exact label and name that also works when the database is gone** and can be re-run after an interruption. | `down` is unit-tested including interruption and an unreadable database; refuses on anything it cannot attribute; ends with a leftovers check.                                                                                                                                                                               | **Chosen.**                                                                                                                   |
| A new small scenario runner                                      | Repeatable assertions.                                                                                                                                                                                                                                                                                                                           | Would need its own proven teardown and review before use.                                                                                                                                                                                                                                                                    | Rejected now (more code than the drills are worth until they have run once); follow-up if the user wants the drills repeated. |

Consequences of the choice, stated so they are not surprises:

- **Aliases are off** in `local:deploy`. The promotion drill (W6) runs only if a pilot (S2) shows that setting
  `LAUNCHPAD_ALIASES=on` in the project's own `.local-deploy/compose.env` and recreating the controller and
  worker works (the router is already initialized with its token, epoch and control TLS). That edit is made by
  hand, recorded, and discarded by `down`. If the pilot fails, W6 is recorded as not rehearsed on this
  topology and the follow-up row says so; promotion lease expiry stays covered by the S12 evidence.
- **Evidence is captured by a shell session script**, not by assertions in code. Each scenario therefore has a
  written pass/fail rule, and the transcript is the evidence.
- The drills run from a **separate checkout** of `main` (`/tmp/opencode/wt-rehearsal-run`), not this plan's
  worktree, so the project name (derived from the checkout path) is unique to the drill and `git status` of the
  plan branch stays clean.

## Safety rules and abort conditions

**Rules (apply to every step):**

1. One project, `launchpad-local-<8 hex>`, read from `.local-deploy/state.json` and re-read and compared at every
   shell start. Every fault is aimed at a container **id** resolved by the project and service labels and
   re-verified by `guard` (project label **and** expected service label, one non-empty id) immediately before the
   command. Volumes go through `volguard`. A destructive command (`docker kill`, `stop`, `pause`, `rm`,
   `volume rm`, `restart`) is never typed bare: it is `inject ... && docker kill "$W"`, `volrm <name>` for the one
   volume removal, or a function from the prelude (`rotate_router`). No name pattern,
   no `$(docker ps -q)`.
2. All ports are loopback (`local:deploy` has no option otherwise). Nothing is published beyond what `up` prints.
3. No prune of any kind. No `docker compose down` outside `local:deploy down`, except the single-container
   `rm -f` and `volume rm` of D1d, by guarded id and through `volguard`/`volrm`, and `rotate_rm`'s guarded
   `docker rm -f` of the labelled rotate container.
4. The protected containers (`launchpad-test-db`, `cloudflare-connector`, `playit-connector`) and every image
   the project did not build are only **read** (`docker inspect` before and after, to prove they did not
   change).
5. Secrets (`.local-deploy/compose.env`, `credentials/`, the CLI profile, passwords, keys, `docker compose
   config` output) never enter the evidence (see S8 for the scan).
6. Faults are written to a ledger **before** they are injected and the undo is written after; an unpaired
   `INJECT` line is what a resumed session reads first.
7. The Docker environment is pinned: `docker context show` is `default`, `DOCKER_HOST` is unset, and `dc` runs
   under `env -i PATH HOME` like `tooling/local-deploy.ts` (`spawnExec`), so nothing in the caller's environment
   (`COMPOSE_*`, `DOCKER_*`, `POSTGRES_*`) reaches Compose.

**Abort (stop injecting, undo what the ledger says, run `down`) if:**

- the prelude's `P` check fails (`pcheck`, at source time and inside every function), a target id is empty, has
  more than one match, or its project or service label is not the expected one;
- a protected container's id or `StartedAt` differs from the baseline in a way the drill did not cause (the user
  starting `launchpad-test-db` or building their own images during the run is **not** an abort: only the three
  protected containers' ids and `StartedAt` values, and resources named by this stack, count);
- a port, volume or network of a pre-existing resource is in use by the stack (`up` refuses; do not override);
- the Docker daemon, the host disk (less than 5 GB free on the Docker root) or memory (less than 2 GB available)
  is short;
- a command prints an error naming a resource outside the project;
- an undo fails twice, a `down` reports leftovers it cannot attribute, or the user says stop.

**`down` needs Dokku running.** `local:deploy down` refuses whenever the Dokku container exists but is not
`running` (stopped, killed, exited or paused, not only paused: `tooling/local-deploy.ts`). Every scenario that
pauses, stops or kills Dokku ends with `docker unpause`/`docker start` of the **guarded** Dokku id before anything
else.

**Interrupted drill (session lost, timeout, crash):** the stack is a labelled Compose project plus
`.local-deploy/`. On resume: `source` the prelude file (it re-validates `P`, and `lpdeploy` runs `omni` in `$REPO` after re-checking it); read the ledger tail; `docker ps -a --filter
label=com.docker.compose.project=$P` to see states; `docker unpause` and `docker start` by guarded id only for ids
in the ledger, **Dokku first** (check `state` of the Dokku container is `running`); run `rotate_cleanup` (removes `/backups/.rotate-db-url` and a leftover `$P-rotate` container, guarded); then either continue at the last
completed step or run `lpdeploy down` (resumable; it states what it could not remove and
keeps `.local-deploy/`). If `down` cannot finish, use the by-hand fallback printed in its message and in
[local-deploy](../local-deploy.md#what-down-removes-and-what-stays); nothing else may be removed.

## Shell prelude and router rotation

### Why a router step exists even though aliases are off

`docker-compose.yaml` gives the admin service `LAUNCHPAD_ALIAS_CONTROL_URL` (and the token, epoch and CA files)
whatever `LAUNCHPAD_ALIASES` says, and `local:deploy` supplies the apps domain, so `routerSessionFromEnv` returns
a session. Consequently:

- `restore` reads the live router epoch before it changes anything and records it in the recovery marker
  (`routerAnchorFromEnv`, `apps/controller/src/admin/router-view.ts`);
- `recovery-clear` reads the router again and **refuses while the epoch equals that anchor** ("Stop the router,
  rotate its epoch and credentials (docs/restore.md), update the epoch and token files, then retry",
  `deployment-recovery.ts`), and refuses if a router was configured but cannot be read;
- `docs/restore.md` step 6 requires the rotation, and the P7 rehearsal passed only because it rotated
  (`tooling/experiments/acceptance/restore.ts`, `rotate()`: stop the router, `rotate --token-stdin
  --database-url-file`, write the new token and epoch, start it).

`local:deploy` has no rotation command. `--router-epoch-unrecorded` confirms a rotation the operator **did**
make; it is never a workaround for not rotating, and this plan never uses it except where a rotation was done and
the marker had no anchor (a scenario that deliberately has none is not in this plan). **Every restore on this stack
therefore ends with a router rotation before `recovery-clear`.** Hypothesis H11 covers it.

### The rotation, for the `local:deploy` stack

`rotate` has two modes (`apps/router/src/index.ts`): `--standalone` ("only if the router has no model users")
and `--database-url-file <file>`, which takes the model maintenance lock in the **restored** database. The stack
has a model, so the managed mode is used. The router state is the volume `<P>_router-state` (mounted at `/state`),
the credentials are the bind-mounted files `.local-deploy/credentials/token` and `epoch` (owned by uid 10001,
mode 0600, mounted read-only into the worker and the admin one-off only; the router and the controller do not mount them), and the router container sits on the
`backend` network only, while Postgres is on the internal `database` network. `rotate_router` (in the prelude file
below) therefore:

1. stops the guarded router (writers are already stopped by the restore procedure);
2. has a one-off admin container write its own `DATABASE_URL` to `/backups/.rotate-db-url` (mode 0600, uid 10001,
   never printed), so no secret is typed by the operator or written as the host user. This file holds the Postgres
   password, so **every exit path removes it** (`rotate_fail`, and the resume procedure and S8/S9 look for it);
3. runs the router image once (`--pull never`, labelled `com.docker.compose.project=$P`,
   `com.docker.compose.service=rotate`, `com.docker.compose.oneoff=True`, named `$P-rotate`) with
   `--volumes-from <router id>` (the same state volume and TLS mounts), the router's own
   `LAUNCHPAD_ROUTER_*`/`LAUNCHPAD_APPS_*` environment copied from `docker inspect` (no secrets in it),
   `--network <P>_database`, the backups directory read-only, `rotate --token-stdin --database-url-file
   /rot/.rotate-db-url`, and a new 64-hex token on stdin; it prints the new epoch, which must be a UUID and must
   differ from the marker's anchor. The anchor is read from the marker through a one-off admin **before the router
   is stopped** and must be a real epoch; a marker without one (null, unreachable, not-configured, history-unknown,
   unreadable) stops the step with the router untouched, and the operator reads `docs/restore.md` step 6 instead;
4. writes the new token and epoch **in place** into the two credential files through the same root helper shape
   `local:deploy` uses for ownership (`--network none`, `--pull never`, project worker image, bind of
   `.local-deploy`, stdin; labelled `project=$P`, `service=rotate-helper`, `oneoff=True`, so `down`'s sweep, which
   removes every container carrying the project label whatever its service, would remove a killed one), so inodes, owner and mode are unchanged. **Each write is checked**, and both files are
   **read back through the helper and compared** with the new token and epoch; any failure removes the temporary
   file and the rotate container and returns failure **without** starting the router;
5. only then starts the router, waits (up to 60 s) until `docker inspect` reports it `healthy`, and runs
   `admin drift --no-dokku`, whose router source reads the live epoch with the files just written (an outdated
   epoch file makes it `unavailable`, exit 2); exit 0 or 1 passes. If the router has alias rows to reconcile, the
   procedure then runs `recovery-raise-counters` (and `recovery-withdraw-unknown` for routes the restored database
   does not know) with workers still stopped.

**Piloted before the first fault** (step S2b): a restore of the first backup into the stack followed by this
rotation, `recovery-raise-counters`, and `recovery-clear` after the 25-minute gate. The pilot records exactly how
rotation was done, every flag, the environment the rotate container needed (the router configuration may also
validate the TLS paths), and whether the `--volumes-from` shape works. **If rotation cannot be made to work on
`local:deploy`** (for example the rotate container cannot reach the database, or the config refuses), the
restore-based drills D1c, D1d, V8 and V9 are recorded as **blocked** with the reason and the observations up to
that point; the stack is then restored by recreating it (`down`, `up`) rather than by weakening a check. The
refusal-only scenarios (V1 to V7) and D2, D1a and D1b do not need rotation and still run.

**Counters and aliases after the S2 pilot.** The S2 pilot creates an alias, so every backup taken afterwards holds
an alias row, and the router holds its counters and tombstone. `recovery-clear` then reads the router
(`recovery-raise-counters`, `recovery-withdraw-unknown` and, if the router disagrees with a restored alias,
`recovery-republish-alias`; `docs/restore.md` step 6). Rule: take every backup after the last alias or promotion
operation; if an alias operation happened after the backup being restored (W6 promotions), the restore procedure
runs `recovery-raise-counters` and reviews `recovery-clear`'s findings. If the aliases pilot fails and no alias
row exists, the router still has to be rotated, and there are no counters to raise.

### The prelude file

Save it as `/tmp/opencode/rehearsal-evidence/prelude.sh` and **`source` it in a dedicated shell started for the drill** (`bash` or `zsh -f`, exited afterwards): it turns on `set -u` and defines functions, so it is never sourced into your main shell. Do not paste it. `return` only works in
a sourced file or a function; pasted at an interactive zsh prompt it would print an error and carry on, so every
check would fail open. Every function also re-checks `P` itself. Nothing here prints a secret.

```sh
set -u
export REPO=/tmp/opencode/wt-rehearsal-run                      # the drill checkout
cd "$REPO" || return 1
P_NOW=$(grep -m1 '"project"' "$REPO/.local-deploy/state.json" | cut -d'"' -f4)
[[ $P_NOW =~ ^launchpad-local-[0-9a-f]{8}$ ]] || { echo "bad project name: '$P_NOW'"; return 1; }
if [ -n "${P:-}" ] && [ "$P" != "$P_NOW" ]; then echo "P changed ($P vs $P_NOW)"; return 1; fi
export P=$P_NOW
[ -z "${DOCKER_HOST:-}" ] && [ "$(docker context show)" = default ] || { echo "DOCKER_HOST/context not plain local"; return 1; }
LABEL=com.docker.compose
export EV=/tmp/opencode/rehearsal-evidence/current             # fixed: a resume after midnight finds the same ledger
[ -d "$EV" ] || mkdir -p -m 700 "$EV"
pcheck() { [[ ${P:-} =~ ^launchpad-local-[0-9a-f]{8}$ ]] && [ "$(grep -m1 '"project"' "$REPO/.local-deploy/state.json" | cut -d'"' -f4)" = "$P" ]; }
note() { echo "$(date -u +%FT%TZ) $*" | tee -a "$EV/log.txt"; }
dc() { pcheck || return 1; env -i PATH="$PATH" HOME="$HOME" docker --host unix:///var/run/docker.sock compose -p "$P" --env-file "$REPO/.local-deploy/compose.env" -f "$REPO/docker-compose.yaml" -f "$REPO/.local-deploy/override.json" "$@"; }
# lpdeploy <up|status|down|"up --new-key">: omni resolves the checkout from the working directory, so always run it in $REPO.
lpdeploy() { pcheck || return 1; ( cd "$REPO" && omni -i run local:deploy -a options="$*" ); }
rekey() { lpdeploy up --new-key; }   # only after recovery-clear; builds, migrates and starts services, about a minute
# cid <service>: the one non-run container id of a service; the message goes to stderr (command substitution would eat it).
cid() {
  pcheck || return 1
  local ids; ids=$(docker ps -a --no-trunc --filter "label=$LABEL.project=$P" --filter "label=$LABEL.service=$1" --filter "label=$LABEL.oneoff=False" --format '{{.ID}}')
  [ -n "$ids" ] && [ "$(printf '%s\n' "$ids" | wc -l)" = 1 ] || { note "ABORT: not exactly one $1 container" >&2; return 1; }
  printf '%s\n' "$ids"
}
# guard <64-hex id> <service>: project AND service labels must be the expected ones.
guard() {
  pcheck || return 1
  [ "$#" = 2 ] && [[ $1 =~ ^[0-9a-f]{64}$ ]] || { note "ABORT: guard needs <64-hex id> <service>" >&2; return 1; }
  [ "$(docker inspect --type container -f '{{index .Config.Labels "'$LABEL'.project"}}/{{index .Config.Labels "'$LABEL'.service"}}' "$1")" = "$P/$2" ] || { note "ABORT: $1 is not $P/$2" >&2; return 1; }
}
# volguard <name> <service>: a project volume used only by the guarded container. Run it BEFORE the container is removed.
volguard() {
  pcheck || return 1
  local name=$1 svc=$2 owner users
  [ "$(docker volume inspect -f '{{index .Labels "'$LABEL'.project"}}/{{index .Labels "'$LABEL'.volume"}}' "$name")" = "$P/postgres-data" ] || { note "ABORT: volume $name is not $P/postgres-data" >&2; return 1; }
  owner=$(cid "$svc") || return 1; guard "$owner" "$svc" || return 1
  users=$(docker ps -a --no-trunc --filter "volume=$name" -q)
  [ "$users" = "$owner" ] || { note "ABORT: volume $name is used by '$users', not only $owner" >&2; return 1; }
}
# volrm <name>: remove the (container-less) project Postgres volume; the ledger line names the volume itself.
volrm() {
  pcheck || return 1
  local name=$1
  [ "$(docker volume inspect -f '{{index .Labels "'$LABEL'.project"}}/{{index .Labels "'$LABEL'.volume"}}' "$name")" = "$P/postgres-data" ] || { note "ABORT: volume $name is not $P/postgres-data" >&2; return 1; }
  [ -z "$(docker ps -a --no-trunc --filter "volume=$name" -q)" ] || { note "ABORT: volume $name still has users" >&2; return 1; }
  echo "$(date -u +%FT%TZ) INJECT volume rm $name" >> "$EV/ledger.txt" && docker volume rm "$name"
}
# inject <label> <id> <service>: guard, then the ledger line BEFORE the fault. undo after.
inject() { guard "$2" "$3" && echo "$(date -u +%FT%TZ) INJECT $1 $2 $3" >> "$EV/ledger.txt"; }
undo() { echo "$(date -u +%FT%TZ) UNDO   $1 $2 $3" >> "$EV/ledger.txt"; }
sql() { dc exec -T postgres psql -U launchpad -d launchpad -AtF'|' -c "$1"; }
admin() { dc run --rm --no-deps --pull never -T admin "$@"; }   # V9 adds --name, see there
snap() { { docker ps -a --format '{{.ID}} {{.Names}} {{.Image}}'; echo ---; docker volume ls -q; echo ---; docker network ls --format '{{.ID}} {{.Name}}'; echo ---; docker image ls --format '{{.ID}} {{.Repository}}:{{.Tag}}'; } | sort; }
protected() { docker inspect -f '{{.Name}} {{.Id}} {{.State.StartedAt}}' launchpad-test-db cloudflare-connector playit-connector 2>&1 | sort; }
state() { docker inspect -f '{{.Name}} status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{end}} restarts={{.RestartCount}} exit={{.State.ExitCode}} started={{.State.StartedAt}}' "$1"; }
# rotate_router: the five steps above. Needs controller and worker stopped and the restored database in place.
# rotate_rm: remove the labelled rotate container by exact name, if it is there (guarded).
rotate_rm() {
  pcheck || return 1
  local id; id=$(docker ps -a --no-trunc --filter "name=^/${P}-rotate\$" --filter "label=$LABEL.project=$P" --filter "label=$LABEL.service=rotate" -q)
  [ -z "$id" ] && return 0
  guard "$id" rotate && docker rm -f "$id" >/dev/null
}
# rotate_cleanup: safe to run again; removes the password-bearing file and the rotate container, and says so when it cannot.
rotate_cleanup() {
  pcheck || return 1
  local rc=0
  rotate_rm || rc=1
  dc run --rm --no-deps --pull never -T --entrypoint rm admin -f /backups/.rotate-db-url || rc=1
  [ $rc = 0 ] || note "WARNING: .rotate-db-url or the rotate container may remain; rerun rotate_cleanup"
  return $rc
}
rotate_fail() { note "ROTATION FAILED: $1; the router is left stopped"; rotate_cleanup; return 1; }
rotate_fail_creds() { rotate_fail "$1; credentials may be half-written, rerun rotate_router"; }
rotate_fail_early() { note "ROTATION NOT STARTED: $1; the router was not stopped"; return 1; }
# rotate_router: needs controller and worker stopped, the restored database in place and a recovery marker with a router anchor.
rotate_router() {
  pcheck || return 1
  local R W img helper tok epoch anchor back i rc
  R=$(cid router) && guard "$R" router || return 1
  W=$(cid worker) && guard "$W" worker || return 1
  img=$(docker inspect --type container -f '{{.Config.Image}}' "$R") && helper=$(docker inspect --type container -f '{{.Config.Image}}' "$W") || return 1
  # The marker's anchor must be a real epoch; an empty one would make "differs from the anchor" meaningless.
  anchor=$(dc run --rm --no-deps --pull never -T --entrypoint cat admin /data/maintenance/deployment-recovery-blocked 2>/dev/null | grep -o '"routerEpoch": *"[^"]*"' | cut -d'"' -f4)
  [[ $anchor =~ ^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$ ]] || rotate_fail_early "the marker has no readable router anchor (routerEpoch null, unreachable, not-configured, history-unknown or unreadable): stop and read docs/restore.md step 6 before going on" || return 1
  inject "stop router (rotation)" "$R" router && docker stop --time 30 "$R" >/dev/null || return 1
  dc run --rm --no-deps --pull never -T --entrypoint sh admin -c 'umask 077; printf %s "$DATABASE_URL" > /backups/.rotate-db-url' || rotate_fail "writing the database URL file" || return 1
  tok=$(openssl rand -hex 32) || rotate_fail "no token" || return 1
  rotate_rm || rotate_fail "a leftover rotate container could not be removed" || return 1
  epoch=$(printf '%s\n' "$tok" | docker run --rm -i --pull never --name "$P-rotate" \
      --label "$LABEL.project=$P" --label "$LABEL.service=rotate" --label "$LABEL.oneoff=True" \
      --network "${P}_database" --cap-drop ALL --security-opt no-new-privileges \
      --volumes-from "$R" -v "$REPO/.local-deploy/backups:/rot:ro" \
      $(docker inspect --type container -f '{{range .Config.Env}}{{println .}}{{end}}' "$R" | grep -E '^LAUNCHPAD_(ROUTER|APPS)_' | sed 's/^/-e /' | tr '\n' ' ') \
      "$img" rotate --token-stdin --database-url-file /rot/.rotate-db-url) || rotate_fail "router rotate" || return 1
  [[ $epoch =~ ^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$ ]] || rotate_fail "unexpected epoch output" || return 1
  [ "$epoch" != "$anchor" ] || rotate_fail "epoch equals the marker anchor" || return 1
  local helperrun=(docker run --rm --pull never --network none --user 0 --label "$LABEL.project=$P" --label "$LABEL.service=rotate-helper" --label "$LABEL.oneoff=True")
  printf '%s\n' "$tok"   | "${helperrun[@]}" -i -v "$REPO/.local-deploy:/state" --entrypoint sh "$helper" -c 'cat > /state/credentials/token' || rotate_fail_creds "credential write failed (token)" || return 1
  printf '%s\n' "$epoch" | "${helperrun[@]}" -i -v "$REPO/.local-deploy:/state" --entrypoint sh "$helper" -c 'cat > /state/credentials/epoch' || rotate_fail_creds "credential write failed (epoch)" || return 1
  back=$("${helperrun[@]}" -v "$REPO/.local-deploy:/state:ro" --entrypoint cat "$helper" /state/credentials/token) && [ "$back" = "$tok" ] || rotate_fail_creds "token read-back differs" || return 1
  back=$("${helperrun[@]}" -v "$REPO/.local-deploy:/state:ro" --entrypoint cat "$helper" /state/credentials/epoch) && [ "$back" = "$epoch" ] || rotate_fail_creds "epoch read-back differs" || return 1
  rotate_cleanup || { note "router is stopped and .rotate-db-url may remain; rerun rotate_cleanup, then start the router by guarded id"; return 1; }
  docker start "$R" >/dev/null || { note "router start failed"; return 1; }
  for i in $(seq 1 30); do
    [ "$(docker inspect --type container -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$R")" = healthy ] && break
    sleep 2
  done
  [ "$(docker inspect --type container -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$R")" = healthy ] || { note "router not healthy after rotation"; return 1; }
  dc run --rm --no-deps --pull never -T admin drift --no-dokku >/dev/null; rc=$?
  [ $rc -le 1 ] || { note "drift failed (exit $rc)"; return 1; }
  undo "stop router (rotation)" "$R" router && note "router rotated to $epoch (read-back, health and drift checked)"
}
```

(The sketch is the intent; the pilot finalizes the exact flags. The one-off containers use only the project's own
images and the project's own volumes and networks.)

In the tables below `$DC ...` means `dc ...` and `admin <command>` is the function above. Destructive commands
always have this shape, never a bare `docker kill <something>`:

```sh
W=$(cid worker) && inject "kill worker (W1)" "$W" worker && docker kill "$W"
```

Read-only `docker exec`, `docker top` and `docker logs` use `"$(cid <service>)"`, which relies on `cid`'s project
and service label filter and on its refusal of zero or several matches; they change nothing.

`CLI` use follows [local-deploy](../local-deploy.md) (build the CLI once, `LAUNCHPAD_PROFILE=local-deploy`).
For session-only calls (reconciliation requests) sign in with `curl` against `http://127.0.0.1:<controller port>`
with `Origin: https://control.localhost:8443`, as `tooling/experiments/compose/scenario.ts` does; the owner
password is in the CLI configuration directory (`local-deploy-owner.password`), read into a variable, never echoed.

**Re-key.** `revoke-all-credentials` (restore step 4) revokes the API key behind the `local-deploy` profile and every
session. `rekey` is `up --new-key`, which also builds images (cached), runs `migrate`, starts the controller, router
and worker and re-saves the profile, so it costs about a minute per call and must not touch a half-restored
database. It is therefore allowed **only after `recovery-clear` has succeeded**. A V8 or V9 put-back (old data
back, no `revoke-all-credentials`) needs no `rekey`. Its first use is proven in S2b; if `up` refuses on a revoked
key, the fallback is to sign in as the owner with `curl` (passwords are unchanged) and
`POST /api/v1/organizations/{org}/api-keys`, then `launchpad login`.

## How a scenario is judged

Each scenario gets one verdict, recorded in the evidence README:

- **Matches docs:** behavior equals the "expected" text below (which quotes the document it comes from).
- **Doc gap/wrong:** the system behaved sensibly but the document is missing or contradicts it. Fixed in this
  change (docs only).
- **Defect:** the system did something unsafe or misleading (a credential valid when it should not be, a gate
  open when it should be closed, work lost silently, a surface that says healthy while broken, a second writer).
  Recorded as an issue with a minimal reproduction; **not** fixed here.
- **Not run / inconclusive:** with the reason. Never silently skipped.

A drill passes when every scenario in it has a verdict, no step needed an undocumented manual fix to recover, and
no verdict is "Defect" with a safety consequence that is not in the follow-up list.

## Hypotheses to confirm or kill

| #   | Hypothesis (from the code)                                                                                                                                                                                                                                                                                                                                                       | Drill  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| H1  | Nothing in the API (`/api/v1/status`, deployment fields) tells an operator that the worker is dead or that a lease is running out; an interrupted deployment looks like it is progressing until a claim.                                                                                                                                                                         | D2     |
| H2  | The controller's `/api/health` and its container stay healthy through a database outage and through total data loss; a controller that passed its schema check keeps answering with raw errors.                                                                                                                                                                                  | D1     |
| H3  | When the database is stopped, the worker's behavior depends on how the failure shows up. A fast connection refusal is retried (`deployment-worker-error`, no abort); a hang beyond the 8 s database budget aborts the worker and restarts it. Either way the worker is **not** restarted merely for being `unhealthy`. D1a records which one `docker stop` of Postgres produces. | D1     |
| H4  | A database that dies mid-deploy ends the run `authority-lost` and leaves the deployment held after its lease; whether the worker aborts and restarts or only retries is recorded, not assumed (see H3).                                                                                                                                                                          | D1     |
| H5  | A new empty Postgres volume starts silently with a valid `launchpad` role; `migrate` on it yields a **ready** empty instance over an intact `/data`, Dokku apps and archives, and nothing refuses it.                                                                                                                                                                            | D1     |
| H6  | The documented restore runbook works end to end on the Compose stack, and a deployment made after the backup becomes an orphan Dokku app that `drift` reports and nothing deletes.                                                                                                                                                                                               | D1     |
| H7  | `docker kill` of the worker is restarted by `unless-stopped`; `docker stop` is not; a restarted worker leaves a held deployment held and a between-steps one resumed.                                                                                                                                                                                                            | D2     |
| H8  | The worker health marker is fresh while Dokku is down, and a `docker pause`d worker turns `unhealthy` through the stale file, but only after the lease has already started to run.                                                                                                                                                                                               | D2     |
| H9  | A failed restore that rolls back leaves the old data and **valid credentials** in place, the file marker blocking deployment writes only, a controller that serves sign-in, and a `recovery-clear` that still demands 25 minutes. The docs do not say what to do next.                                                                                                           | D3     |
| H10 | A truncated dump with a matching manifest passes `verify-backup` and the `--list` preflight, fails inside `pg_restore`, and is put back; the interrupted-importer path in `restore.md` and the controller README works as written.                                                                                                                                               | D3     |
| H11 | Even with aliases off, every restore anchors the live router epoch and `recovery-clear` refuses until the router is rotated; `local:deploy` has no rotation command, and the managed `rotate` can be done on the stack with the shape in [the rotation](#the-rotation-for-the-localdeploy-stack).                                                                                | D1, D3 |

## The drills

All three run on one stack, in the order in [Steps](#steps). The sizes below assume the `examples/hello` site
(about 55 s per deployment).

### Common preconditions

- Linux with native Docker Engine and Compose v2 (not Docker Desktop, rootless, Podman or a remote
  `DOCKER_HOST`), Bun 1.4.4, Omni, `openssl`, `ssh-keygen`, `tar`, `curl`.
- At least 8 GB free in the Docker root and 4 GB of free memory; no other process using 32180 to 32443 (`up`
  checks and names a conflict; use `--port-base` only for a conflict). `docker context show` is `default` and
  `DOCKER_HOST` is unset.
- Fresh checkout of `main` in `/tmp/opencode/wt-rehearsal-run` after this plan is merged (or this plan's commit),
  `bun install --frozen-lockfile && omni remote-sources install && omni projection sync`, CLI built.
- A Docker snapshot (`snap`) and `protected` output saved **before** `up`.

### D1. Database loss

**Question.** What do the controller, worker and clients do when PostgreSQL stops, loses its data, or comes
back as an empty volume, how does an operator find out, and does the documented restore runbook return the
instance to service?

**Scenarios and fault injection** (each destructive scenario starts from a **fresh** verified backup taken just before it: `b0-a` before D1a to D1c, `b0-d` before D1d; one deployed site `A`):

| Id  | Fault                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Observe                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Expected (source)                                                                                                                                                                                                                                                                                                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1a | `docker stop` the Postgres container (guarded id) for 150 s, then `docker start` it (undo). Data intact.                                                                                                                                                                                                                                                                                                                                                                          | Every minute: `state` of controller, worker, postgres; `/api/health`; `GET /api/v1/status` with the operator key if any, else a signed-in call; worker log events and exit code; the health marker age (`docker exec <worker> sh -c 'stat -c %Y $LAUNCHPAD_WORKER_HEALTH_FILE'`); site `A` over Dokku HTTP. **First question: does the stopped database give the worker a fast connection refusal (retry loop, `deployment-worker-error` lines, no abort) or a hang past the 8 s budget (abort, exit, restart)?** | Open, to be recorded. Site `A` keeps serving (the data plane never touches the database). Controller health `healthy` (H2). Worker `unhealthy` about 1 to 2 minutes after the first failed claim and not restarted for that; healthy again once the database is back. API errors, then recovery without restarting anything (a failed schema check is repeated every 3 s). |
| D1b | A new deployment `B` is dispatched; when its status is `building` or `deploying`, `docker kill` the Postgres container (id), wait 60 s, `docker start` it.                                                                                                                                                                                                                                                                                                                        | Worker exit code and `RestartCount`; `deployment` and `deployment_deletion_operation` rows (`status`, `step_pending`, `lease_expires_at`) once the database is back; events for `B`; time to `reconciliation-needed`; Dokku app `B` by exact name.                                                                                                                                                                                                                                                                | H4: `authority-lost`, worker aborts and is restarted, `B` held as `reconciliation-needed` after its lease with `lease-expired-with-pending-step`, or resumed if no step was pending. Record which, and the elapsed time from the kill.                                                                                                                                     |
| D1c | While everything runs, `sql 'drop schema public cascade'` (partial data loss, "someone dropped the tables").                                                                                                                                                                                                                                                                                                                                                                      | Same panel as D1a; what the CLI/API return (status codes and error shape); controller log lines; whether anything restarts.                                                                                                                                                                                                                                                                                                                                                                                       | H2: health stays `healthy`, API calls fail with errors that do not name the cause; the controller does not recheck because its check passed; the worker goes `unhealthy`. Recovery: restore into the now-empty database (`restore.ts` handles a missing `public`).                                                                                                         |
| D1d | **Fresh backup `b0-d` first.** Through the guards: `PG=$(cid postgres)`, `volguard "<P>_postgres-data" postgres` (labels read `$P/postgres-data` **and** the container is the only user), `inject "rm postgres" "$PG" postgres && docker rm -f "$PG"`, then `volrm "<P>_postgres-data"` (re-checks the label and that no container uses it, writes the volume name to the ledger, then removes it). Then `dc up -d --no-deps postgres` while the controller and worker still run. | A fresh empty `launchpad` database; controller and worker behavior against it for 5 minutes; then `docker restart` of the controller alone, by guarded id; what `check-restore` and `drift` say; a **wrong** recovery (`migrate`) and its result; then the **documented** recovery including the router rotation.                                                                                                                                                                                                 | H5: silent empty database, valid role. `migrate` succeeds and creates `deployment_recovery = ready` over `/data` with the old `model-writer-seen` file and `A` still in Dokku: no refusal. `restore` into that now-populated database is refused without `--replace` and succeeds with the printed address.                                                                |

**D1d documented recovery** (exactly `restore.md` steps 1 to 6, run as written, each timed):

1. Stop the controller and worker (`inject ... && docker stop` by guarded id), verify exit, wait the settlement time the runbook
   states (a deployment worker: stop grace, then longer than 290 s and the five-minute lease); verify no
   worker-started process is left on Dokku (`docker top <dokku id>`).
2. `admin verify-backup /backups/b0-d`, then `admin restore /backups/b0-d --i-have-stopped-the-workers`
   (`--replace <address printed>` if `migrate` was run).
3. `admin migrate --status` (`pending: 0`, exit 0), `admin check-restore`, `admin drift`.
4. `admin revoke-all-credentials --i-understand-this-signs-everyone-out` with the controller stopped; then start
   only the controller; confirm the CLI key from before the backup is refused and sign-in still works; after the gate is cleared, `rekey`.
5. Reconcile: **rotate the router** (`rotate_router`, with controller and worker stopped; restore.md step 6; the
   restore anchored the pre-restore epoch, and `recovery-clear` refuses until it has changed). Then, if an alias
   operation happened after the backup, `admin recovery-raise-counters` and review the withdraw/republish findings.
   `drift` lists the sites deployed **after** the backup as orphan Dokku apps. **Do not delete them by hand**
   (step 5); `down` removes them by exact name.
6. Wait 25 minutes from the recorded restore start (read from the marker with `docker exec <controller> sh -c
   'cat $LAUNCHPAD_DATA_DIR/maintenance/deployment-recovery-blocked'`; its contents are not secret), then
   `admin recovery-clear --i-have-checked-the-dokku-host` (never with `--router-epoch-unrecorded`: the marker has
   an anchor), `rekey` (which also starts the worker), deploy `hello`,
   fetch it, and delete it through the API.

**Record:** the time from fault to first alert-able signal (what can be seen from outside), restore duration,
time to green excluding the 25-minute wait, the recovery point (what the fresh backup lacked), `drift` output, the
`maintenance/` directory listing before and after (names and modes only).

**Pass:** every documented step succeeds as written; credentials from before the backup are refused after step 4;
no model mutation succeeds before step 6; the deployment after step 6 reaches `succeeded` and serves; after
step 6 the orphans `drift` reports are exactly the apps created since the backup (by exact name). Any deviation is a doc gap or a defect with a
reproduction.

**Undo and cleanup:** D1a to D1c leave the stack as it was (the volume is intact). D1d replaces the volume; the
restore rebuilds it. If the recovery cannot be completed, `down` still works (database unreadable fallback).

### D2. Worker liveness

**Question.** When the worker dies, hangs or is killed, is the deployment safe, is the state visible, does
Docker bring the worker back, what does the healthcheck prove, and does the operator procedure
(`deployment-reconcile`, `reconciliation-requests`, `drift`) put things right?

**Scenarios** (each with a fresh deployment so that history does not blur; `W` ids are the scenario ids):

| Id  | Fault                                                                                                                                                                                                                           | Observe                                                                                                                                                                                                                                                                                       | Expected (source)                                                                                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| W0  | None. Idle worker, deployments on.                                                                                                                                                                                              | `state`, health marker age over 3 minutes.                                                                                                                                                                                                                                                    | Healthy, marker refreshed continuously.                                                                                                                                                                                                                                                                                                                      |
| W1  | `docker kill` the worker when the deployment shows `building` (poll every second; retry with a new deployment if the window is missed).                                                                                         | Worker `state` and `RestartCount`; `docker events` timing; `status` of the deployment every 10 s until it changes; `step_pending`, `lease_owner`, `lease_expires_at` by SQL; events; whether a dispatched build or Dokku command keeps running (`docker top`, `docker ps` for build helpers). | H7: the run is abandoned, the container restarts under `unless-stopped`, the deployment keeps its in-flight status until the lease (≤ 300 s) lapses, then the new worker's claim holds it `reconciliation-needed` (a pending `build` step). H1: the status shown meanwhile does not say the worker died.                                                     |
| W2  | Deterministic pending step: `docker pause` the guarded Dokku container, create a deployment, wait until `sql` shows `step_pending = app`, kill the worker (guarded), `docker unpause` Dokku.                                    | Dokku app by exact name (`docker exec <dokku id> dokku apps:exists <name>`); the held deployment; then `deployment-reconcile` with the outcome the observation justifies; then a new deployment to the same app; then the deletion of the held one.                                           | Held `reconciliation-needed` with `lease-expired-with-pending-step`; `deployment-reconcile --outcome failed-clean`, `failed-owned`, `succeeded` or `abandon` per the observation (each tried on a different held deployment where the app state allows), **after** checking by exact name; "blocks its app" until reconciled; the command never calls Dokku. |
| W3  | `docker stop` (not kill) the worker during `deploying`; compare with W1.                                                                                                                                                        | Exit code, time to exit, `RestartCount` (a manual stop must not restart), the 2026-11-21 behavior reproduced, then `docker start`.                                                                                                                                                            | Run ends `authority-lost` at once, no restart (manual stop), held after the lease (170 to 300 s). Confirms the documented "stop-and-reconcile".                                                                                                                                                                                                              |
| W4  | `docker pause` the worker (frozen process, no heartbeat) during `deploying`, hold it **past the lease**, then `docker unpause`.                                                                                                 | `state` health transitions (a paused container's healthcheck), marker age, lease columns, what the resumed process does (its next renew), whether the old process writes anything after the lease (compare `xmin`/`updated_at` of the row before and after), final status.                    | H8: `unhealthy` through the stale marker; on unpause the worker discovers it lost authority and stops that run (`authority-lost`, fence); no stale write; the row is held after the next claim.                                                                                                                                                              |
| W5  | Deletion mid-flight: pause Dokku, `DELETE` a succeeded deployment, wait until `deployment_deletion_operation.step_pending = destroy`, `docker kill` the worker, unpause Dokku.                                                  | The operation row and `deployment.desired_state` (`deleting`), the `deletion-reconciliation-needed` event, Dokku app by exact name, `deployment-reconcile` (`succeeded` or `failed-clean`), the worker's continuation (image removal), final `deleted`, `drift`.                              | Held deletion, never retried by hand; after `deployment-reconcile`, the worker continues; hostname and Dokku name stay reserved. An image removal interrupted instead of a destroy resumes on the next claim (`upgrade.md`).                                                                                                                                 |
| W6  | **Only if the aliases pilot passed.** Pause the router, request a promotion, wait for `promotion_operation` pending, kill the worker, unpause the router.                                                                       | Operation row, `promotion-reconcile --operation <id> --target                                                                                                                                                                                                                                 | --withdraw --i-have-verified-the-router-by-exact-route`, pins held, a new promotion refused until resolved.                                                                                                                                                                                                                                                  | Held `reconciliation-needed`, pins kept, `promotion-reconcile` queues a higher-generation correction ([deployments](../deployments.md)). |
| W7  | Health semantics: `docker stop` the guarded Dokku container for 3 minutes with the worker idle. **Undo: `docker start` the guarded Dokku id and wait for `healthy`**; `local:deploy down` refuses while Dokku is not `running`. | Worker `state` and marker age while Dokku is down; a new deployment queued meanwhile and how the worker reports its failure.                                                                                                                                                                  | The worker stays `healthy` (it proves liveness and database access only, as the code comment says). This is the evidence for the `production-compose.md` wording.                                                                                                                                                                                            |

**Operator surfaces for D2** (checked in W1, W2, W5): `launchpad deployment get/events`,
`GET /api/v1/status`, `reconciliation-requests` (after `POST .../deployments/{id}/reconciliation-requests` with an
owner session within 15 minutes; confirm it records and changes nothing else), `drift` with Dokku and `--probe`.
What the dashboard shows is read from `apps/controller/src/routes` and the API fields it renders.

**Pass:** each scenario has a recorded timeline; no deployment or deletion is left in a state the documented
commands cannot resolve; no run is re-dispatched after a pending step; no second writer; and H1, H3, H7, H8
each end as "confirmed" or "killed" with the observation. **Defect examples:** a held operation never
detected because no worker is running and no surface says so (expected, H1: record as a follow-up, not a
failure of the drill); a stale write after the lease; the worker restarting into a hold that `deployment-reconcile`
cannot clear.

**Undo and cleanup:** unpause and start by exact id (ledger); reconcile or delete the leftovers through the
documented commands; `down` removes any remaining sites by exact name.

### D3. Failed restore and schema rollback

**Question.** For every way a restore can fail or be refused, what state is the instance left in, can a failed
restore leave credentials valid or the controller serving, and does the documented follow-up (`recovery-ack-import`,
`recovery-clear`, `revoke-all-credentials`) work? What is the rollback story, and what does a downgrade do?

**Preparation.** Take a fresh `b0-v` (good, a deployed site and one uploaded artifact). **At the start of S6,
immediately before V8/V9** (so that S5's backups and the D1c restore do not carry it), add a 150 MB filler table to
`public` in the disposable database so that an import takes long enough to interrupt, then take `b1` (large
dump). Make working copies of backups **inside the admin container** (the backup directory is owned by the
service user): `dc run --rm --no-deps --pull never -T --entrypoint sh admin -c 'cp -a /backups/b0-v /backups/<copy>'`;
rewrite a manifest with `--entrypoint bun admin -e '<script>'`. Copies are named `v1` to `v8`; originals are never
modified. The filler table is dropped after D3 (the restore itself removes it).

**Scenarios.** Every row first records `sql` counts (users, sessions, API keys, deployments), the `maintenance/`
listing, `docker top <dokku id>` and `dokku apps:list`; and after the attempt records the same plus the exit code
and message.

| Id  | Corruption or condition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Expected                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1  | `database.dump` truncated to half, manifest untouched.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `verify-backup` exit 1 ("does not match its recorded size and checksum"); `restore` refuses before changing anything: no marker created, database unchanged, archives untouched.                                                                                                                                                                                                                                              |
| V2  | One byte flipped in the middle of the dump.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Same as V1.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| V3  | An artifact file deleted from the backup; an extra file added; a symlink in place of the manifest.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `verify-backup` reports missing / "not in the manifest" / "not a plain file"; restore refuses.                                                                                                                                                                                                                                                                                                                                |
| V4  | Partial backup: no `manifest.json` (a killed `backup`), and an empty directory.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | "`manifest.json` is missing or unreadable"; restore refuses. (`backup` itself, killed mid-run, is also injected once: `docker kill` the admin container during `backup`, confirm the partial directory never verifies.)                                                                                                                                                                                                       |
| V5  | `manifest.json` `format` changed to 2; `launchpadVersion` changed to a different value.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Format: "unsupported backup format". Version string: **not checked** (document it; the manifest and dump are what count).                                                                                                                                                                                                                                                                                                     |
| V6  | **Schema rollback simulation.** Manifest `migrations` extended with `29990101_001_future` (a backup from a newer build); and, separately, a row `29990101_001_future` inserted into `launchpad_migration` of a scratch copy (a database from a newer build, i.e. a downgrade attempt).                                                                                                                                                                                                                                                                                           | `restore`: "The backup holds migrations this version does not know ... restore it with a compatible version", nothing changed. With the database one: `migrate --status` exit 1 with `unknown`, `migrate` refuses, the controller returns the "database has migrations this version does not know" error; none of them write. The row is removed afterwards.                                                                  |
| V7  | Populated target without `--replace`; with a wrong `--replace`; with the right address; archive collision (a different file already at an archive's path in `/data`).                                                                                                                                                                                                                                                                                                                                                                                                            | Refusals name the exact target address and change nothing (no marker). A collision: "exists with different content", nothing restored. The right address proceeds (that is V9).                                                                                                                                                                                                                                               |
| V8  | **Truncated dump with a forged manifest** (size and sha256 rewritten so `verify-backup` passes) restored with the right `--replace`. Writers stopped as in the runbook.                                                                                                                                                                                                                                                                                                                                                                                                          | H10: `verify-backup` passes, `pg_restore --list` preflight passes (table of contents), `pg_restore` fails mid-import in its single transaction, the old schema is put back, the marker stays, the importer record is removed, no `launchpad_replaced_*` is left; archives already copied stay.                                                                                                                                |
| V9  | **Interrupted restore:** restore the large backup `b1` with the right `--replace`, starting the admin as a **named** one-off: `dc run --rm --no-deps --pull never -T --name "$P-v9-restore" admin restore ... --replace <address>`. Capture its id with `ID=$(docker inspect --type container -f '{{.Id}}' "$P-v9-restore")` (never `cid admin`, which excludes one-off run containers). When `pg_stat_activity` shows a `launchpad-restore-*` backend, `guard "$ID" admin` (project and `admin` service labels), then `inject "kill restore" "$ID" admin && docker kill "$ID"`. | The importer record `maintenance/deployment-import-in-progress` and the marker remain; `launchpad_replaced_*` may exist; `restore` and `recovery-clear` refuse; `recovery-ack-import` refuses while a backend is visible, then succeeds; the controller README's manual recovery (`drop schema if exists public cascade; alter schema launchpad_replaced_<ts> rename to public;`) or a repeated restore brings the data back. |

**After V8 and V9 the drill answers the questions that matter** (all from the instance, not from the restore
command's message):

- **State left behind:** database counts equal the pre-restore counts (put-back) or are empty/partial (V9); the
  marker and importer files; `launchpad_replaced_*` schemas; stray `*.restore-*` files; archives copied.
- **Credentials:** with writers started again (deliberately, on the disposable stack): is the pre-restore CLI key
  accepted; do sessions and password sign-in work; what does `POST .../deployments` answer (expected: refused
  by the gate, with the documented 503); what does the worker log (`deployment-recovery-blocked`) and does its
  healthcheck stay healthy (it will: claims fail, see the marker comment in `health.ts`).
- **Does a failed restore leave the controller serving?** Yes for sign-in and key administration by design
  (`restore.md`: "the marker is not an access-control substitute"). The drill records exactly which routes work,
  and whether any credential that **should** have been revoked by the restore is valid (a defect only if the old
  data was supposed to be replaced and was not, which put-back says it is not).
- **Recovery gate:** with the put-back state, run `revoke-all-credentials` (is it needed after a _failed_
  restore? the runbook does not say), **rotate the router** (the failed restore already anchored the epoch, so
  `recovery-clear` demands it too), and then `recovery-clear` before and after 25 minutes from the recorded restore
  start. The marker keeps the **first** restore's start time (`existing?.restoreStartedAt ?? now`) and anchor, so
  a prompt second (recovery) restore does not restart the 25 minutes: one wait per recovery cycle; record which succeeds, and what `recovery-clear` says when Dokku apps and archives match the
  database. This is the missing "what to do after a failed restore" procedure; the evidence decides the text.
- **Rollback:** after V8, restore a **fresh** `b0-v2` (taken before V8) correctly with `--replace` to prove the instance is recoverable (this
  is restore R3, in the same recovery cycle and gate as R2), then run the rest of the documented recovery (revoke,
  rotate the router, `recovery-clear`, `rekey`) and one new deployment. The restore never touches Dokku:
  `dokku apps:list` and `docker ps` (names, ids, images of the project's Dokku) are equal before and after every
  scenario.

**Pass:** V1 to V7 change nothing (database counts, marker, files, Dokku identical before and after, exit codes
non-zero, messages name the problem without echoing secrets); V8 is put back with the marker held and the
documented next step works; V9's documented recovery works as written, or the doc is corrected; the restore of
the good backup after V8/V9 completes through `recovery-clear` and a `rekey`. A defect is any case where a restore reports success with
data that does not match the backup, leaves the gate open over restored data, leaves the importer record absent
while an importer may commit, or leaves valid a credential the runbook says must not survive.

**Schema rollback status (stated now so nobody overstates it later).** With one migration, rollback cannot be
rehearsed as an upgrade followed by a restore of the pre-upgrade backup. V6 proves the two refusals (a backup
from a newer build; an older build against a newer database). A real two-revision rehearsal remains open until
a second migration exists, and the follow-up table must keep saying so.

**Undo and cleanup:** the filler and copies are in the project's volumes/backup directory and go with `down`;
nothing is written outside `.local-deploy/` and the project's volumes.

## Steps

Ordered safest first. Every step that touches Docker is marked **[Docker]** and needs the user's go-ahead to
start; the rest are reading and writing files. Each has a check and an undo.

| #   | Step                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Check                                                                                                                                                                                                                                                                   | Undo                                                                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S0  | **C0 checkpoint.** Independent review of this plan; the user answers the two [open questions](#open-questions-and-user-checkpoints) (socket scope; one session or several). Create the drill checkout and evidence directory. No Docker. Take the `snap`, `protected` and `docker ps -a` baselines (read-only Docker queries only).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Reviewer signs off; baselines saved; ports 32180 to 32443 free; disk, memory and Docker context checks met.                                                                                                                                                             | Delete the evidence directory and the checkout.                                                                                                                                |
| S1  | **[Docker]** `lpdeploy up` in the drill checkout; `source` the prelude file. Deploy `hello` once (site `A`). Save the status output, `docker inspect` health of all five services, volume names (confirm `<P>_postgres-data`, `<P>_router-state` and their labels) and a first `snap`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Five services `healthy`, `A` serves 200 with its page, the `snap` diff vs S0 contains only `$P` resources and the five tagged images.                                                                                                                                   | `lpdeploy down`, then the post-teardown proof in S9.                                                                                                                           |
| S2  | **[Docker]** Aliases pilot (decides W6): set `LAUNCHPAD_ALIASES=on` in `.local-deploy/compose.env`, `dc up -d --no-deps controller worker`, create an alias, promote `A`, read it back through the router data port, withdraw. Record result.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Promotion `succeeded` and the alias serves `A`'s identity header, or a recorded reason it cannot.                                                                                                                                                                       | Set the variable back to `off` and recreate the two services. If the pilot is interrupted or breaks the stack, run `local:deploy down` (Dokku is running here) and `up` again. |
| S2b | **[Docker]** **Restore and router-rotation pilot** (recovery cycle R0): take `b0-a` (`admin backup`, `verify-backup`), stop controller and worker by guarded id, wait the settlement time, `admin restore /backups/b0-a --i-have-stopped-the-workers --replace <address>`, `admin migrate --status`, `admin check-restore`, `admin revoke-all-credentials ...`, `rotate_router`, start the controller, wait the 25 minutes from the marker's start, `admin recovery-clear --i-have-checked-the-dokku-host`, `rekey`, deploy and fetch `hello`. Record the exact rotation flags and environment that worked, how long each part took, and every refusal. If rotation cannot be made to work, D1c, D1d, V8 and V9 are **blocked** (see the rotation section); the rest runs. **Then C1: stop and ask before any fault.**                                                                                    | `recovery-clear` succeeds, the epoch file equals the rotated epoch and differs from the marker's anchor, the CLI key from before is refused and `rekey` yields a working one, a new deployment succeeds.                                                                | Restore again or `lpdeploy down` and `up`.                                                                                                                                     |
| S3  | **[Docker]** D3, V1 to V7 (refusals; nothing changes), from a fresh `b0-v` taken after the last alias operation. Also kill one `backup` run mid-way (V4), as a named one-off killed through `guard` and `inject`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Counts, marker listing, Dokku and archive state identical before and after each scenario; exit codes and messages recorded.                                                                                                                                             | Remove the copies inside the admin container (`rm -rf /backups/<copy>` by exact name).                                                                                         |
| S4  | **[Docker]** D2 (worker): W0, W1, W3, W2, W4, W5, W7, and W6 if S2 passed. Each followed by its reconcile/cleanup and a check that the stack is idle and healthy (Dokku `running`) before the next. **Then C2.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Per scenario: the recorded timeline and the verdict; before the next, `status` shows all `healthy` and no deployment or deletion in flight (SQL).                                                                                                                       | Ledger `UNDO` lines: `docker unpause`/`start` by guarded id (Dokku first); `deployment-reconcile`; delete leftover sites through the API.                                      |
| S5  | **[Docker]** Fresh `b0-a`, then D1a, D1b, D1c (database stopped, killed mid-deploy, schema dropped). Recover D1c with the documented runbook (recovery cycle R1): settlement wait, restore, revoke, `rotate_router`, `recovery-raise-counters` if an alias operation followed the backup, 25-minute gate, `recovery-clear`, `rekey`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Each scenario's panel recorded; after D1c the documented recovery reaches `recovery-clear`, `rekey` works and a new deployment succeeds.                                                                                                                                | Restore the fresh backup again (documented) or `lpdeploy down`.                                                                                                                |
| S6  | **[Docker]** First add the 150 MB filler table and take `b1` (see D3 preparation). D3, V8 then V9, each from a fresh backup. V8: failed restore R2, observations, then the recovery restore R3 of `b0-v2` in the same cycle. V9: killed restore R4, `recovery-ack-import`, recovery restore R5. Each cycle: settlement wait, revoke, `rotate_router`, one 25-minute gate from the first restore's marker, `recovery-clear`, `rekey` (put-back states need no `rekey` until after the clear). D1d may not start until the V9 cycle is cleared.                                                                                                                                                                                                                                                                                                                                                             | The credentials/serving/gate questions of D3 answered with recorded outputs; `recovery-clear` succeeds; one new deployment succeeds.                                                                                                                                    | Restore the fresh good backup and clear, or `lpdeploy down`.                                                                                                                   |
| S7  | **C3 checkpoint first** (destructive volume loss). **[Docker]** D1d from a fresh `b0-d`: `volguard`, guarded `docker rm -f`, `volrm`, bring Postgres up empty, observe, wrong recovery (`migrate`), then the documented recovery (R6: settlement wait, restore with `--replace`, revoke, `rotate_router`, gate, clear) and `rekey`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | H5, H6 and H11 answered; the documented recovery works or the deviation is a recorded doc gap/defect.                                                                                                                                                                   | `lpdeploy down` (works with an unreadable database; Dokku must be `running`); the volume is recreated by Compose or removed by `down`.                                         |
| S8  | Stop `docker events` (the one background PID noted in the ledger). Copy **only curated transcripts** (the ledger, `log.txt`, timing tables, snapshot diffs, per-scenario outputs; never raw `docker logs`, backups or the CLI profile) to `docs/plans/evidence/rehearsal-db-worker-restore-<date>/` in the plan branch (not the drill checkout). Scrub: build the secret list (every value in `compose.env`, the generated passwords, API key strings, session cookies, SSH/TLS key material from `credentials/` and the CLI profile) into a mode 0600 file **outside the repo**; then `grep -rF -f` that file over the evidence, plus pattern scans: `lp_`, `Set-Cookie`, `cookie:`, `DATABASE_URL=`, `-----BEGIN`, `password=`, `.rotate-db-url` (must not exist anywhere in the copy), and runs of 32 or more hex or base64 characters (each hit reviewed; container and deployment ids are expected). | All scans empty or reviewed; no `.env`, `compose.env`, `credentials/`, `tls/` file or `docker compose config` output; total size within a budget of 200 KB (existing evidence directories are 50 to 200 KB); the secret-list file deleted afterwards.                   | Delete the copied files and the secret list.                                                                                                                                   |
| S9  | **C4 checkpoint first.** **[Docker]** Confirm Dokku is `running` (start it by guarded id if not), then `lpdeploy down` (it re-checks `$P` against `$REPO/.local-deploy/state.json` and runs `omni` inside `$REPO`). Proof of absence: `snap` again and diff against S0; `protected` equal to S0; `docker ps -a --filter label=com.docker.compose.project=$P`, `docker volume ls`, `docker network ls` for `$P`, the project's five image tags, the `$P-rotate` container, any `.rotate-db-url` under the backups directory and `.local-deploy/` all absent; `docker events` stopped.                                                                                                                                                                                                                                                                                                                      | The diff vs S0 is empty except for the pulled/base images and build cache `down` documents as staying, and anything the user started in the meantime (not an abort); protected containers' ids and `StartedAt` unchanged; no `launchpad/site:*` left from this project. | If `down` reports a leftover, follow its message; never prune. Report anything that remains and stop.                                                                          |
| S10 | Write the documentation changes below, one commit per concern, after the evidence is reviewed. Run `omni -i run format`, `omni -i run check` (and `test`, `build` if any code-adjacent file was touched, which none should be).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `omni -i run check` green; the doc drift tests (`local-deploy-docs`, compose docs) still pass; links resolve.                                                                                                                                                           | `git revert` the doc commits.                                                                                                                                                  |
| S11 | Independent review of the evidence and the doc edits; then open an issue per defect (follow-up list) with its reproduction. A PR only if the user asks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Reviewer confirms each verdict is supported by a recorded observation.                                                                                                                                                                                                  | Close the issues, revert the commits.                                                                                                                                          |

**Riskiest part first:** the plan orders by blast radius, not by importance. The destructive D1d is last because
it needs a good backup, a working stack and a cleared recovery gate, and because a failure there is still
covered by `down`. The first live step (S1) is the single largest unknown for the harness (the stack and a
backup from it); the first drill step (S3) changes nothing.

## Worked example: W1, a worker killed mid-build

Starting state: S1 to S2b done, `A` serving, a fresh backup verified, `$EV`, the prelude loaded (it passed its `P` check), the CLI profile set with `$APP`, `$ARTIFACT` and `$PROJECT_ID` from the last (re-)key. After any restore run `rekey` (see S5) before using `launchpad` again: `revoke-all-credentials` invalidates the old key and sessions.

Save it as `w1.sh` and `source` it (it uses the prelude functions; `return`-style checks are written as `&& ... || false` so a paste cannot continue past a failure).

```sh
note "W1 start"; snap > "$EV/w1-before.txt"; protected > "$EV/w1-protected-before.txt"
W=$(cid worker) && guard "$W" worker || { note "stop: no guarded worker"; false; }
state "$W" | tee -a "$EV/w1.txt"

# A new deployment of the example (artifact and app from S1 are reused)
DEPLOYMENT=$(launchpad app deploy "$APP" --artifact "$ARTIFACT" | grep -m1 '"id"' | cut -d'"' -f4)
note "deployment $DEPLOYMENT created"

# Wait for the step we want, polling once a second
for i in $(seq 1 120); do
  S=$(launchpad deployment get "$DEPLOYMENT" | grep -m1 '"status"' | cut -d'"' -f4)
  [ "$S" = building ] && break; sleep 1
done
[ "$S" = building ] || { note "window missed (status $S); retry with a new deployment"; false; }
sql "select status,step_pending,lease_owner,lease_expires_at from deployment where id='$DEPLOYMENT'" | tee -a "$EV/w1.txt"

# Fault: SIGKILL the worker container by exact, label-verified id
inject "kill worker (W1)" "$W" worker && docker kill "$W"; note "worker killed"

# Observe every 10 s until the deployment leaves its in-flight status or 8 minutes pass
for i in $(seq 1 48); do
  echo "$(date -u +%T) $(state "$W") | $(launchpad deployment get "$DEPLOYMENT" | grep -m1 '"status"' | cut -d'"' -f4) | $(sql "select step_pending,lease_expires_at from deployment where id='$DEPLOYMENT'")" | tee -a "$EV/w1.txt"
  sleep 10
done
launchpad deployment events "$DEPLOYMENT" | tee "$EV/w1-events.txt"
docker logs --since 10m "$(cid worker)" 2>&1 | grep -E 'worker-started|reconciliation|run-ended' | tee "$EV/w1-worker-log.txt"
docker exec "$(cid dokku)" dokku apps:list | tee "$EV/w1-dokku-apps.txt"
```

What the evidence must show to pass: the container's `restarts` count and the time it took to return; the
deployment's `status` string for each sample (H1: unchanged until the claim); the lease expiry time and the
sample at which `reconciliation-needed` first appears (should be about 300 s after the last renewal, at most
five minutes after the kill plus a poll); the `lease-expired-with-pending-step` event; and `drift` output that
lists the held deployment as in flight and the app by exact name if Dokku has it.

Then the recovery: check Dokku **by exact name**, record the outcome the observation justifies, and run
`admin deployment-reconcile --deployment "$DEPLOYMENT" --outcome <observed> --i-have-verified-dokku-by-exact-name`.
Check the deployment settled, that the app accepts a new deployment, and that deleting the held one works.

```sh
undo "kill worker (W1)" "$W" worker; snap > "$EV/w1-after.txt"; protected > "$EV/w1-protected-after.txt"
diff "$EV/w1-protected-before.txt" "$EV/w1-protected-after.txt" && note "protected unchanged"
diff "$EV/w1-before.txt" "$EV/w1-after.txt" | tee -a "$EV/w1.txt"      # only project resources may differ
note "W1 done"
```

Verdict for this scenario: "Matches docs" if the hold occurs within the lease and the worker returned; "Doc gap"
if the restart policy or the visible status differs from `production-compose.md`; "Defect" if the deployment was
re-dispatched, left in an unresolvable state, or never held with a worker running.

## What gets written afterwards

- **Evidence:** `docs/plans/evidence/rehearsal-db-worker-restore-<date>/README.md` (summary, the three tables of
  verdicts, commands, timings, versions and revision, the aliases pilot result, the Docker snapshot diffs, the
  cleanup proof) plus the scrubbed transcripts, ledger, event log and timing tables. Style of
  [`p7-compose-20261121/README.md`](evidence/p7-compose-20261121/README.md).
- **`production-compose-follow-up.md`:** the **Capacity gate** row ("database loss and worker liveness are not
  rehearsed") and the **Recovery gate** row ("a failed restore is not rehearsed ... schema rollback is untested")
  get the date and a link, and still say what remains (schema rollback with a real migration delta; W6 if it was
  not run; large-database restore time); the "Still open" status bullet and the 2026-11-24 summary are updated;
  the defect issues are listed.
- **`production-compose.md`:** the two "not rehearsed" lines (around the measurement list and the
  "What is NOT production-ready" list) and the "Stopping and restarting the worker" section (kill versus stop,
  restart policy, what the healthcheck proves, what is visible while a lease runs).
- **`restore.md` / controller README:** a "After a failed restore" section if D3 shows the runbook is silent
  (what the marker, the unchanged credentials and the 25-minute clearing mean), and any step that did not work
  as written. **`upgrade.md`:** the rollback paragraph if V6 shows a difference. **`deployments.md`:** how a held
  deployment looks while no worker runs.
- **Issues, not fixes:** for each defect (candidates: no staleness signal in `/api/v1/status`; a database-blind
  controller health check; `migrate` accepted over an orphaned data directory; an unhealthy worker is never
  restarted; no documented step after a failed restore).

## Risks

| Risk                                                                                                                             | Likelihood                           | Impact                                                                       | Handling                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A fault command hits the wrong container or volume.                                                                              | Low                                  | **Very high** (the host also runs `launchpad-test-db` and tunnel connectors) | `P` validated against `^launchpad-local-[0-9a-f]{8}$` and `set -u`; `guard` needs one id with the project **and** expected service label; `volguard` for the volume; every destructive command goes through them; ledger; protected-container diff; abort rules. |
| The mounted Docker socket gives the worker, Dokku and every deployed build root-equivalent control of this host's Docker daemon. | Low (only `examples/hello` is built) | **Very high** (host compromise or loss of unrelated containers and images)   | Explicit user approval of the socket scope (C0), deploy only the repository example, loopback only, `dc` runs under a clean environment, no prune, and the scope is repeated at C0 and C3.                                                                       |
| The stack becomes unrecoverable mid-drill (volume gone, writers unpaired).                                                       | Medium                               | Low                                                                          | `down` works without a database; the stack is disposable; evidence already copied out of `.local-deploy/`.                                                                                                                                                       |
| The kill window is missed (build too short, step too fast).                                                                      | High                                 | Low                                                                          | Retry with a new deployment; deterministic pauses (Dokku or router) for pending steps (W2, W5, W6).                                                                                                                                                              |
| 25-minute waits and 300 s leases stretch the session.                                                                            | Certain                              | Low                                                                          | Order the work so waits overlap with write-up (S5, S6); the ledger and `state` make a session resumable.                                                                                                                                                         |
| `docker pause` of Dokku blocks `down` (not `running`).                                                                           | Medium                               | Low                                                                          | Unpause is in every pause scenario's undo; `down` states the exact command if it still happens.                                                                                                                                                                  |
| Secrets leak into evidence (backup directories, `compose.env`, session cookies).                                                 | Medium                               | High                                                                         | Only curated transcripts are copied (never raw `docker logs`); secret list built outside the repo; literal and pattern scans plus a size budget (S8); reviewer check before commit; backup directories never copied.                                             |
| Conclusions overreach: aliases off, one worker, tiny database, no real dashboard, one migration.                                 | Certain                              | Medium                                                                       | The evidence README states these limits next to each verdict; the follow-up rows keep what remains open.                                                                                                                                                         |
| The `LAUNCHPAD_ALIASES=on` pilot is unsupported by the tool.                                                                     | Medium                               | Low                                                                          | It is an experiment on a disposable project; failure is recorded and W6 becomes a stated gap.                                                                                                                                                                    |

## Check against the ready-to-build gate

- Someone else could start: the prelude, the steps and the worked example are concrete; the first live step is S1.
- Goal, scope and finish line are checkable (done list above); the worked example covers a hard case.
- The open questions (socket scope, one session or several) block S1 and are for the user; five checkpoints stop the run.
- The riskiest part is deliberately last and covered by `down`; the first step changes nothing.
- Every step has a check and an undo; costly choices (harness, order, aliases pilot) are decided above.
- Interfaces are existing ones (admin commands, `launchpad` CLI, Docker); no new code.

## Open questions and user checkpoints

Everything else is decided above. These are for the user, and the run stops and waits at each checkpoint.

**Open questions (needed before S1):**

1. **Approve the Docker socket scope.** The worker and Dokku mount the host's Docker socket, so a deployed build
   runs with root-equivalent access to this host's Docker daemon. The drills deploy only `examples/hello`, bind
   loopback only and never touch the protected containers, but the scope is yours to accept.
2. **One session or several.** The run takes 7 to 9 hours (about 8) of wall clock. It can run in one sitting or be split at
   the checkpoints below (the stack, ledger and evidence survive between sessions; resume with the
   [interrupted-drill procedure](#safety-rules-and-abort-conditions)).

**User checkpoints (stop and ask):**

- **C0, before S1:** the two questions above, and this plan's independent review.
- **C1, after S2b and before any fault:** the stack is up, the aliases pilot and the restore/rotation pilot are recorded; confirm that
  fault injection may begin.
- **C2, after S4:** the worker-liveness verdicts; confirm that the database drills (S5) may begin.
- **C3, before S7:** the destructive volume loss. Confirm the stack state, the fresh backup and the guarded
  commands about to run.
- **C4, before S9:** evidence copied and scrubbed; confirm teardown (`down`), which removes the project.
