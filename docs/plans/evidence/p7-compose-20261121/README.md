# Production Compose disposable rehearsal, 2026-11-21

The user authorized one disposable instance of `compose.production.yaml` on 2026-11-21: unique project
`lpc-54e9c3`, loopback host ports 42180/42181/42182/42222/42443 (checked free first), run directory
`/tmp/opencode/lpc-54e9c3/` (keys and secrets only there, deleted afterwards), no DNS, no ingress, nothing
published. `resources.json` was written before anything was created. `cleanup.log` is the verified end state.
The run was driven by hand (`docker compose -p lpc-54e9c3 --env-file ... -f compose.production.yaml -f override.yaml`);
no reusable task was added. The override file only set `image: lpc-54e9c3/dokku:test`, so the existing
`launchpad/dokku:0.38.34` tag was not moved. The fixture app name is chosen by the product (`lp-<10 chars>`),
not `lp-test-`; it exists only in this run's Dokku.

## Results

| Step                                                                                                                                                      | Result                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build of all images (digest-pinned bases; Dokku plugin pinned)                                                                                            | pass, after fixing the plugin install syntax (bug 1)                                                                                                                                                                                                  |
| Start order, `up -d postgres dokku`, health                                                                                                               | pass after bug 2 and bug 3                                                                                                                                                                                                                            |
| Pin Dokku host key, register worker key, `network:set --global initial-network`                                                                           | pass                                                                                                                                                                                                                                                  |
| `admin migrate`, `migrate --status` (applied 19, pending 0), `admin setup`                                                                                | pass (password file must be mode 0600 and owned by 10001: bug 4, docs)                                                                                                                                                                                |
| `router init --token-stdin` via `compose run -T router`                                                                                                   | pass; state volume writable by uid 10001                                                                                                                                                                                                              |
| `up -d`: controller, worker, router, dokku, postgres all `healthy`                                                                                        | pass                                                                                                                                                                                                                                                  |
| `cap_drop: ALL`: `CapEff` 0 in controller, worker, router, uid 10001                                                                                      | pass                                                                                                                                                                                                                                                  |
| Credential mounts read-only (`RW=false`), socket mounted in worker and Dokku only                                                                         | pass                                                                                                                                                                                                                                                  |
| Controller `/api/health` on 127.0.0.1:42180; only the five loopback ports listen                                                                          | pass                                                                                                                                                                                                                                                  |
| Worker SSH to `dokku@dokku` with pinned known_hosts; worker used the host Docker socket (group 988)                                                       | pass                                                                                                                                                                                                                                                  |
| Fixture deploy (deployments on, aliases off): upload, app, deploy, `succeeded` in 60 s, probe 200 through Dokku's HTTP port with `X-Launchpad-Deployment` | pass                                                                                                                                                                                                                                                  |
| Fixture delete (`desiredState` deleted): Dokku app, container and images gone                                                                             | pass                                                                                                                                                                                                                                                  |
| `admin backup /backups/b1`, `verify-backup`                                                                                                               | pass (1 archive, 19 migrations)                                                                                                                                                                                                                       |
| Restore into a fresh database and fresh data volume, `migrate --status`, `check-restore` (0 missing archives, 0 missing apps)                             | pass                                                                                                                                                                                                                                                  |
| `down` (no `-v`) then `up -d`: artifact file and deployment row kept; stack healthy                                                                       | pass                                                                                                                                                                                                                                                  |
| Resource limits applied; second fixture deploy and delete under them; no OOM, no restarts                                                                 | pass                                                                                                                                                                                                                                                  |
| Graceful worker stop, idle: 0.6 s, exit 0                                                                                                                 | pass                                                                                                                                                                                                                                                  |
| Worker stop while deploying                                                                                                                               | worker ended the run `authority-lost` at once (exit 0); the deployment stayed `deploying`, became `reconciliation-needed` (`lease-expired-with-pending-step`) 170 s later. Documented product behavior; **not** "stop within grace finishes the work" |
| `LAUNCHPAD_ALIASES=on`                                                                                                                                    | **fails**: worker and controller refuse `http://router:3081` (bug 5, product)                                                                                                                                                                         |

## Bugs found

1. `plugin:install <url> <commit>` treats the commit as a plugin name and fails; the form that works is
   `--committish <commit>`. Fixed in `containers/dokku/Dockerfile`; the installed plugin reports
   `9c3e2636eda583ac667fbdca2b565b3dd6e8107e`.
2. **Compose cannot attach a service to the engine's default bridge**: it sends network-scoped aliases and the
   engine answers `network-scoped aliases are only supported for user-defined networks`. Fixed by a dedicated
   `apps` network (name `LAUNCHPAD_APPS_NETWORK`, default `launchpad-apps`) and the one-time
   `dokku network:set --global initial-network <name>`. Verified: the app container, Dokku's nginx proxy and the
   probe all work on it. Unlike the default bridge, app containers cannot reach the database, worker or router
   networks.
3. The Dokku healthcheck passed on the first seconds of a recreated container because the host key persists in the
   state bind, while nginx was not yet listening (probe returned `000` for about 60 s). The healthcheck now also
   requires port 80 to listen, and `start_period` is 6 m (a first start with an empty state directory took about
   4.5 minutes).
4. `setup --password-file` requires mode 0600 and readability by uid 10001; a bind-mounted file therefore needs
   `chown 10001` on the host. The docs now say so.
5. **Product/topology**: with `LAUNCHPAD_ALIASES=on` the worker and controller reject
   `LAUNCHPAD_ALIAS_CONTROL_URL=http://router:3081` ("must be https, or http to 127.0.0.1 or [::1]",
   `packages/services/src/router-credentials.ts`). The router speaks plain HTTP, so this Compose file cannot enable
   aliases. Not fixed (needs a decision: TLS on the router control plane, or a loopback path such as a shared network
   namespace). Aliases stayed off in this rehearsal.

## Measured resources

`peaks.txt` and the `*-stats.jsonl` files (`docker stats --no-stream`, about every 2 s). Docker builds and Dokku's
`docker` commands run in the host engine, outside these containers' cgroups, so their cost is not in these numbers.

| Container   | Idle memory | Peak memory (deploy) | Peak CPU                                 |
| ----------- | ----------- | -------------------- | ---------------------------------------- |
| postgres    | 53 MiB      | 62 MiB               | 22 % of one core                         |
| controller  | 49 MiB      | 56 MiB               | 12 %                                     |
| worker      | 23 MiB      | 39 MiB               | 26 %                                     |
| dokku       | 22 MiB      | 74 MiB               | 171 % (about 2 cores, during the deploy) |
| router      | 11 MiB      | 15 MiB               | 12 %                                     |
| app (nginx) | -           | 6 MiB                | 0 %                                      |

Not measured: the admin container during a backup (the 12-second sample missed it; the database held a few rows),
large uploads, many apps, Dokku's first-start package installation, concurrent deployments.

## Not exercised

Aliases and the router data/control path after init (blocked by bug 5), `restore` followed by starting a controller
and `recovery-clear`, TLS options to PostgreSQL clients, a rollback to a previous image, an upgrade, Dokku state and
router-state backup, deployment `reconciliation-needed` recovery (the interrupted app was destroyed by exact name
instead), a worker stop that waits out the 25-minute grace, host reboot behavior, public/ingress access.

> Note: the files were later renamed: `compose.production.yaml` became `docker-compose.yaml` and `compose.production.env.example` became `docker-compose.env.example`. This record describes the original names.
