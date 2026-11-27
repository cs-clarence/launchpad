# Check deployment drift

For instance operators comparing recorded deployments and aliases with the host.
This command is advisory and read-only: it never deletes, repairs, deploys or
changes the recovery gate. Continue to follow the [restore runbook](restore.md)
before reopening after a restore.

1. On the admin host, load `DATABASE_URL`, `LAUNCHPAD_DATA_DIR`, the pinned
   `DOKKU_SSH_*` settings and the worker's `LAUNCHPAD_APPS_*` / `LAUNCHPAD_ALIAS_*`
   router settings. The admin user needs its own readable credential files;
   do not put secrets on the command line.
2. Run:

    ```sh
    omni -i run admin -p @launchpad-kit/controller -a command=drift
    ```

    With the packaged controller, use `bun .output/admin.mjs drift`.

3. Read the JSON report's `sources` first. `unavailable` means a requested source
   could not be read completely; fix its connectivity, settings, pinned keys or
   file access and repeat. Missing settings are not an empty inventory.
4. Investigate each finding by exact resource identity and its suggested action.
   Orphan app names are observations, never proof of ownership or permission to
   delete them. `inFlight` lists unsettled resources excluded from external
   comparisons; a report without findings is not proof that in-flight work settled.

## Options and exit statuses

- `--no-dokku` / `--no-router`: explicitly skip that source. It remains `skipped`
  in the report, not `ok`.
- `--probe`: also read served deployment identities through
  `LAUNCHPAD_APPS_PROXY_URL` and alias identities through
  `LAUNCHPAD_ALIAS_PROBE_URL`. Probes send each recorded hostname as `Host`,
  follow no redirects, and discard response bodies. An unreachable endpoint or
  unexpected HTTP status makes this source unavailable; an HTTP 404 means no
  deployment is served. Without the option, probes are reported as skipped.
- `--format <json|text>`: output format, default `json`. `json` is the full
  report and stays the default; `text` prints a human-readable summary (sources
  with their status, findings by severity, then in-flight and ignored counts).
  The text form shows source statuses only, not their reasons, and never changes
  exit statuses. Any other value is a usage error with exit **2**.
- Exit **0**: no stable findings among the sources read; inspect skipped and
  in-flight sources before interpreting it.
- Exit **1**: stable findings.
- Exit **2**: a requested source or either database snapshot was unavailable
  (takes precedence over findings).

The command takes a consistent read-only database snapshot, reads external
sources, then takes another snapshot. Findings that disappeared or whose database
resource changed are dropped. This is not an atomic cross-system snapshot.
Router pages include tombstones and each page must match the configured instance
and epoch. An outdated epoch file makes the router source unavailable, not clean.
Each database table read is capped at 100,000 rows; exceeding a bound fails the
read rather than silently truncating it. Remote inventories and probes also have
time and output bounds; a large or slow host may require separate investigation.
Dokku inventory/domain reads share a 120-second total budget; all probes share
another 120-second budget. Individual Dokku reads have a 15-second timeout and
individual probes have a 5-second deadline.

A missing data directory makes the archive source unavailable. A present data
directory with missing `artifacts/` or organization directories yields
`archive-missing` findings for retained deployments. If those directories are
separate mounts, verify the mounts before treating those findings as data loss.
