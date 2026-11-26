# Fixes for the defects found in the DB, worker and restore rehearsals

Status: **first PR (#2, #4, #6, #7) implemented on `fix/rehearsal-defects-first`; second PR is still sketches.**
The independent review's findings and the user's decisions are folded into "Decisions and review findings" below; where they
differ from the sections after it, they win. Source: the "Defects and follow-ups" table in
`docs/plans/evidence/rehearsal-db-worker-restore-20261126/README.md` (on the rehearsal branch, not yet
on `main`), with transcripts `02`, `08`, `10`, `01`. Planned against `origin/main` at `9071223`.

## Assessment

- **Kind: medium.** Four independent, bounded fixes in three places (`apps/controller/src/admin`,
  `tooling/local-seed.ts` and `tooling/local-deploy.ts`, docs). No schema change, no API change.
- **Risk tier: medium.** #2 and #4 are in the operator recovery path (`migrate`, `check-restore`, `drift`),
  which people run when something is already wrong; a wrong refusal would block a real recovery. #6 and #7
  touch credentials (key scopes, replacing a CLI profile) of a local-only tool. Nothing changes data,
  and every change is easy to revert. Independent review is required (medium and above).
- Four questions: change is small (about 300 lines with tests); unknowns are low (all four reproduced in the
  transcripts, code read); easy to undo; one person, one PR. If #1, #3, #5 or #8 are pulled in, reassess
  (they change API contracts or health semantics: large, medium to high risk).
- Execution: solo. Checks: `omni run check test build` for the touched packages, plus
  `omni -i run test:db:up`, `test:integration -p @launchpad-kit/controller`, `test:db:down` for the DB tests.

## Decisions and review findings (first PR)

Decided with the user (questions 1 to 4):

1. #2 trigger is zero applied migrations plus an archive in `artifacts/`; override is `migrate --allow-orphaned-data`.
2. #4 exit 2 for "could not check" from `check-restore` and `drift`.
3. #6 a profile of a different controller still needs `--force` (and `launchpad logout` for `up`).
4. #7 scopes come from `compose.env` `LAUNCHPAD_ALIASES=on` only; no `--aliases` flag, defaults unchanged.

Review findings, all applied:

1. `assertReadyForCheck` runs inside `drift`'s existing `try`; its `catch` prints the message only for
   `SchemaMismatchError` (other errors keep the generic text, which may otherwise leak connection details). The
   database check runs before any Dokku settings are read. `check-restore` has its own catch that sets exit 2.
2. #6: only HTTP 401/403 make a profile `"stale"` (dead key). `ClientCoreError` (insecure or corrupt store, store busy)
   and a key of another organization stay `"other"`, so they are never papered over by `--new-key`.
3. The `"other"` refusal throws before `keyIssued` is computed, so `--new-key` cannot overwrite a foreign
   profile; covered by a test.
4. `tooling/compose-production.spec.ts` asserts the admin service has `LAUNCHPAD_DATA_DIR=/data` (it comes from the
   shared settings), so `migrate` checks the real archive volume.
5. `countOrphanedArchives` stops at the first match (the result means "at least N"); a symlinked or non-directory
   `artifacts/` or owner directory throws (fails closed).
6. Docs: flipping `LAUNCHPAD_ALIASES` after the first `up` needs `up --new-key` to get the wider key.

## First PR: defects #2, #4, #6, #7

### #2 `migrate` over a lost database with an orphaned data directory

Evidence (`10`): empty Postgres volume, intact `/data` and Dokku; `migrate` exit 0, "ready" empty instance, no
marker, `drift` lists seven orphan apps. The existing 503 after a controller restart is only an accident
of the schema being behind; once `migrate` ran, nothing warns.

Behavior:

- `launchpad-admin migrate` (apply mode only; `--status` unchanged apart from a one-line note) refuses when
  **both** hold: no migration is applied yet (`migrationStatus(db).applied.length === 0`, so the database is
  empty or unmigrated) **and** the data directory already holds archives (a file under `<dataDir>/artifacts/`).
  A first install has an empty or absent data dir, so `local:deploy up` and the production Compose first
  install are unaffected; an upgrade has applied migrations, so it is unaffected.
- Refusal text: names the data dir and the number of archives found, says the database looks lost or replaced,
  points to `docs/restore.md` (restore with `--replace` from a backup), and names the override.
- Override: `migrate --allow-orphaned-data` (explicit, no env variable) migrates anyway and prints a warning
  once; there is no silent path. The override is for deliberately reusing a data directory with a fresh database.
- Not checked: Dokku apps. `migrate` runs with no Dokku settings, and requiring SSH there would break first
  install ordering (`docs/production-compose.md` step 3 migrates before Dokku is registered with the worker).
  The archive check is a sufficient and local signal; `drift` stays the tool that finds orphan apps. State this
  in the docs.

Files:

- New `apps/controller/src/admin/preflight.ts` (pure, testable; `main.ts` is a top-level commander script
  and has no unit tests):
    - `countOrphanedArchives(dataDir): Promise<number>`: `lstat`/`readdir` of `artifacts/` and its owner
      directories, counting files that match the storage-key shape of `resolveArtifactPath`/`STORAGE_KEY` in
      `packages/services/src/artifacts.ts` (export a small matcher from there rather than copying the regex).
      A missing directory counts 0; anything unreadable other than ENOENT throws (fail closed: do not migrate
      on an unreadable data dir).
    - `assertMigrateSafe({ db, dataDir, allowOrphanedData })` using `migrationStatus` from
      `@launchpad-kit/database`; throws `PreflightError` (plain `Error` subclass with the message above).
- `apps/controller/src/admin/main.ts`, the `migrate` command (about lines 119 to 140): add
  `.option("--allow-orphaned-data", ...)`; compute `dataDir` as the other commands do
  (`path.resolve(process.env.LAUNCHPAD_DATA_DIR ?? ".data/controller")`); call `assertMigrateSafe` before
  `migrateToLatest`. In the admin container `LAUNCHPAD_DATA_DIR` is the `launchpad-data:/data` mount
  (`docker-compose.yaml`, admin service), so the check sees the real archives; verify the env is set for the
  admin service in the compose file and in `tooling/local-deploy.ts` (`adminArgs`) while implementing, because
  an unset variable would check the wrong directory and silently pass. If it is not set there, add it.

### #4 `check-restore` and `drift` on an unmigrated database

Evidence (`10`): `check-restore` exit 1 with `relation "artifact" does not exist`; `drift` prints only
"Drift check failed; no complete report was produced." (its `catch` swallows the cause).

Behavior:

- Both commands first call `assertSchemaCurrent(db)` (already exported by `@launchpad-kit/database`;
  throws `SchemaMismatchError` with "The database schema is behind: N migration(s) pending ... run
  `launchpad-admin migrate`" or the unknown-migrations text). Nothing is written.
- `check-restore` prints that message to stderr and exits 2 (exit 1 stays "findings"; 2 means "could not
  check", the same meaning `drift` already gives it). Check how the top-level error handler in `main.ts`
  exits for thrown errors and keep that convention instead of adding a new path; if it exits 1, catch
  `SchemaMismatchError` in the command and set `process.exitCode = 2`.
- `drift`: keep the generic message for other failures but, in its `catch`, print the message of a
  `SchemaMismatchError` (and nothing else; other messages may carry connection details), exit 2.
- A fully empty database gets one extra sentence in the message from `check-restore`/`drift`: "If the
  database was lost, restore a backup (`docs/restore.md`); do not run `migrate` while the data directory
  holds archives" (links #2 to #4; plain text built in `preflight.ts`, `assertSchemaCurrent` untouched).

Files: `apps/controller/src/admin/main.ts` (`drift` ~528, `check-restore` ~601); `preflight.ts` gets
`assertReadyForCheck(db)` wrapping `assertSchemaCurrent` and the added sentence.

### #6 `up --new-key` against a stale `local-deploy` profile

Evidence (`02`, `08`): after a manual teardown or a revoked key the saved profile is not a working key, and
`up --new-key` ends in "pass --force". `--force` is not accepted by `local-deploy` (`up --force` is "Unknown
argument", `tooling/local-deploy-arguments.spec.ts`), so the only route is `launchpad logout` first.

Design: in `tooling/local-seed.ts` `profileIsReady` splits the current `"other"` state: same controller URL
but the key does not work (401/403, other organization, `ClientCoreError`) becomes a new state `"stale"`;
a different controller stays `"other"`. In `seedWith`, `--new-key` (or `--force`) may replace a `"stale"`
profile; `"other"` still needs `--force`, so a profile that belongs to another stack is never overwritten
by `--new-key` alone. Without `--new-key`, a stale profile is refused as today, with a message that names
`--new-key`: "The saved key of the profile ... is not a working key for this controller. Pass --new-key
to issue a replacement, or choose another --profile." `keyIssued` becomes
`absent || newKey || (force && state !== "ready")`. No change in `local-deploy.ts` options (its message
text comes from `seed`, already surfaced).

Files: `tooling/local-seed.ts` (`profileIsReady` ~771, `seedWith` ~901 to 917); help text for `--new-key` in
`tooling/local-deploy.ts` (~1961) and `docs/local-deploy.md` (~63) to say it also replaces a revoked or stale
saved key of the same controller.

Open point inside this item: when the controller URL differs (stack recreated on other ports, so the saved
profile points at the old port), the profile is `"other"`, and the user still gets "pass --force". That is
the case after `down` plus `up` on different ports, but `down` deletes its own profile, so it arises only
after a manual teardown. Decision needed (question 3).

### #7 default `local-deploy` key lacks `app:alias:manage` and `app:promote`

Design: add `ALIAS_KEY_SCOPES = [...DEPLOY_KEY_SCOPES, "app:promote", "app:alias:manage"]` next to
`DEPLOY_KEY_SCOPES` in `tooling/local-seed.ts` (scope names exist in `packages/contracts/src/index.ts`
lines 22 to 23). `local-deploy up` picks the scope list from the project's own `compose.env`: when
`LAUNCHPAD_ALIASES` is `on` it passes `ALIAS_KEY_SCOPES`, else `DEPLOY_KEY_SCOPES` (decided in the one place
that already reads `compose.env`: `parseEnv(await d.fs.readFile(...))` as at `tooling/local-deploy.ts` ~1311
and ~1505; a small `scopesFor(env)` exported for tests). Least privilege is kept (a default stack still has
six scopes), and a user who switched aliases on by hand gets a key that works. An existing six-scope key is
reported by the existing "lacks the scopes ... pass --new-key" path, which #6 makes reliable.

Files: `tooling/local-seed.ts` (new constant), `tooling/local-deploy.ts` (~1423 `scopes: DEPLOY_KEY_SCOPES`),
`docs/local-deploy.md` (line ~59 says "six scopes"; add the alias variant and the `compose.env` switch,
~186 notes aliases are off). Aliases remain off by default (`LAUNCHPAD_ALIASES: "off"`, ~182); this PR does
not add a way to switch them on.

Alternative (question 4): an opt-in `up --aliases` flag that writes `LAUNCHPAD_ALIASES=on` and the wider scopes.
Bigger (it needs the router-side setup the pilot did by hand), so not proposed here.

### Tests

Unit (no database), `omni run test`:

- `tooling/local-seed.spec.ts`: stale same-controller profile + `--new-key` issues a key and replaces the
  profile; the same without `--new-key` is refused naming `--new-key`; different controller + `--new-key`
  is still refused naming `--force`; `--force` unchanged; the `scopes` state unchanged. Add an
  `ALIAS_KEY_SCOPES` shape test beside the existing `DEPLOY_KEY_SCOPES` one (~884; `toHaveLength(8)`).
- `tooling/local-deploy-up.spec.ts` (~168 asserts `seedDeps.scopes`): `LAUNCHPAD_ALIASES=off` gives
  `DEPLOY_KEY_SCOPES`, `on` gives `ALIAS_KEY_SCOPES`; an `up` re-run with a changed `compose.env` is covered by
  the existing key-state path.
- `apps/controller/src/admin/preflight.spec.ts` (no database; temp directories): `countOrphanedArchives`
  with missing dir, empty dir, a valid key path, junk files (ignored), a symlinked `artifacts` (refused,
  matches the repo's plain-directory convention in `deployment-recovery.ts`), unreadable dir (throws).

DB integration (`apps/controller/src/admin/__tests__/restore.spec.ts` style, `createTestDatabase`, needs
`test:db:up`); a new `preflight.spec.ts` under `__tests__`:

- empty database + data dir with an archive: `assertMigrateSafe` refuses, nothing created (no
  `launchpad_migration` table); with the override it passes; empty database + empty data dir passes;
  migrated database + archives passes (upgrade case).
- `check-restore` and `drift` preflight on an empty database: throws the schema-behind message, and no tables are
  created; on a migrated one passes.
- One test on the real end state of #2: after the refusal `migrationStatus` still reports all pending.

Not tested in the PR: the compose/admin wiring (no containers). The implementer checks the admin service env
by reading the files and says so in the PR description.

### Docs to update (same PR, per AGENTS.md)

- `docs/restore.md`: step 3 area and the database-lost section: "`migrate` refuses an empty database next to
  existing archives; restore instead; `--allow-orphaned-data` is deliberate reuse"; `check-restore`/`drift`
  exit 2 on an unmigrated database.
- `docs/production-compose.md` step 3 (line ~110): one sentence that first-install `migrate` expects an empty
  data volume.
- `docs/local-deploy.md`: `--new-key` wording (#6), scopes (#7), `LAUNCHPAD_ALIASES` note.
- `apps/controller/README.md` if it lists admin command flags (grep `migrate` there while implementing).
- `docs/plans/production-rehearsals-db-worker-restore.md` and the evidence README: mark #2, #4, #6, #7 as
  fixed with the PR number once merged (the evidence file itself is on another branch; do not edit it here).

### Risks

- #2 false positive blocks a legitimate flow: e.g. a deliberately reused volume, or an operator who restored
  files by hand. Mitigation: explicit flag, message names it; only applies when zero migrations are applied.
- #2 false negative if the admin container does not see the data dir (env or mount): check wiring (above).
- #4 hides nothing: only the cause of a failure changes; exit code for "findings" is untouched. Scripts that
  treated exit 1 from `check-restore` as "unmigrated" would now see 2; the runbook and `tooling/experiments/*`
  call sites (`restore.ts`, `scenarios.ts`) must be grepped for exit-code assumptions.
- #6 relaxing `--new-key` to replace a stale profile replaces a credential the user could still want;
  limited to the same controller URL, where the old key is already dead.
- #7 widens a local key's powers, only when the user turned aliases on.

### Slices (one PR, reviewable commits when asked to commit)

1. `preflight.ts` + `migrate`/`check-restore`/`drift` wiring + tests + docs (#2, #4).
2. `local-seed.ts` stale state + tests; `ALIAS_KEY_SCOPES` + `local-deploy.ts` wiring + tests; docs (#6, #7).

Both slices are independent; no agent split is needed.

## Second PR: needs product decisions (design sketches only)

Recommendation: **#1 and #3 together in a second PR** (observability of controller vs. worker state, one design),
#5 as a small follow-up after the semantics are decided, **#8 not as code**: documentation only.

### #1 no surface shows a dead worker or a running-out lease

Sketch: the worker already writes a heartbeat marker (the container healthcheck reads it, "marker age 1 to 2 s").
Options: (a) the worker writes a heartbeat row (`worker_heartbeat`: worker id, `seen_at`, claimed deployment) every
few seconds, and `/api/v1/status` (operator view) reports `worker: { lastSeenAt, state: "ok" | "stale" |
"missing" }` plus, per deployment in `deploying` state, a derived `leaseExpiresAt`/`stalled` flag; (b)
no schema change: derive staleness only from `deployment.lease_expires_at` (if present) and report "N deployments
past their lease" in status. (b) is cheaper, but cannot say "no worker is running" when nothing is claimed. Needs a
migration for (a) (forward-only, schema_version bump) and a contract change in `packages/contracts` (additive).
Also: nothing restarts a killed worker; `restart: unless-stopped` behaves as Docker defines it, so the fix is
to document it and surface it, not to change compose.

### #3 controller keeps running healthy after its database is replaced

Sketch: store an `instance_id` row (generated at the first migration) and have the controller read it at start
and re-check it cheaply (every N seconds, or on the `/api/health` path): if it changed or the table is missing,
`/api/health` returns 503 `database-replaced` and API calls answer a clear 503 instead of "Internal Server
Error". Today the 503 `schema-mismatch` only appears after a restart because the check runs at start. Smaller
variant: re-run `assertSchemaCurrent` on a timer / on a query error of class `42P01` (undefined table) and map
those errors to the same typed 503. Needs care: a restore legitimately changes the instance id, and
a controller must not serve in between (the controller is stopped during restore by the runbook).

### #5 worker healthcheck `unhealthy` during DB outage and recovery blocked

This is a semantics decision, not a bug as built (documented "does not prove progress"). Options: keep
(unhealthy = cannot do work), or split "alive" from "can work" (healthcheck on liveness; progress shown on the
#1 status surface). Nothing restarts an `unhealthy` container under Compose, so neither choice changes
behavior; it changes what operators see in `docker ps` and what an orchestrator would do later.

### #8 some single-byte dump corruptions pass `pg_restore`

Sketch: the manifest already records size and SHA-256 of the dump, and `verify-backup` and `restore` check them.
The remaining gap is only a forged manifest (the manifest is not itself checksummed or signed), and
`pg_restore --list` does not read data blocks. Real fix options: sign/HMAC the manifest (needs a key to manage:
product decision) or document the limit. Recommend documenting in `docs/restore.md` and accepting.

## Questions for the user

Questions 1 to 4 are decided (see "Decisions and review findings"); 5 to 8 belong to the second PR and are open.

1. #2: is "zero applied migrations plus archives in `artifacts/`" the right trigger, and is a CLI flag
   `--allow-orphaned-data` the right override (versus no override: always restore)? Should Dokku apps also count when
   Dokku settings happen to be present (not proposed)?
2. #4: exit code 2 for "unmigrated, could not check" from `check-restore`: acceptable (it is 1 today for a raw
   error)?
3. #6: should `--new-key` also replace a profile that points at a _different_ controller URL (stack recreated on other
   ports, after a manual teardown), or is `launchpad logout` the right thing to require there? (The plan keeps
   it refused.)
4. #7: derive scopes from `compose.env` (`LAUNCHPAD_ALIASES=on`; proposed), or add an explicit
   `up --aliases` opt-in flag, or both? Also: should the alias scopes be added to the default key outright?
5. Second PR: is a worker heartbeat table (#1a, new migration) acceptable, or only the lease-derived signal (#1b)?
   Is the operator status the right surface, and should it be reported to every authenticated user or the instance
   operator only?
6. #3: is a periodic or on-error check in the controller wanted at all, or is "restart after any DB replacement" the
   documented procedure (docs only)?
7. #5: keep the worker healthcheck as is, or split liveness from progress?
8. #8: accept documentation only, or sign the manifest?
