# Application settings are read through one configuration service

Date: 2026-11-28.
Status: accepted by the user, who directed it while reviewing the development-email change.

## Context

Settings arrived as environment variables parsed where they are used, so a value can only be changed
by restarting a process with a different environment. Some values are also operational choices an
operator should be able to change on a running instance without editing the deployment. The
development-email change first guessed "development" from the controller's base URL, which is a
proxy: a production instance can serve a loopback URL through a proxy, and a development instance
can use a tunnel name, so the guess is wrong in both directions.

## Decision

Add `app_setting`, one row per setting, and `ConfigurationService`
(`packages/services/src/configuration-service.ts`). A known setting resolves in this order:

1. the `app_setting` row,
2. its environment variable,
3. its built-in default.

The service holds one registry of known settings: each entry names its key, environment variable,
default and parser. Values are validated after selection, and an error names the source (`app_setting
"development"` or `LAUNCHPAD_DEVELOPMENT`). Rows whose key is not known are ignored, so a deployment
that writes a newer setting cannot stop an older binary. Nothing is cached: a command reads the
setting where it uses it, so a database change applies to the next command.

The first setting is `development` (`LAUNCHPAD_DEVELOPMENT`, default `false`). A development
controller may run the operator command that marks seeded addresses verified; production keeps the
rule that an address becomes verified only by accepting an invitation. `dev:infra:up` writes the
environment value, and an operator can override it for one instance with an `app_setting` row.

Existing settings stay on environment variables until they need the same treatment; the service is
the place a setting moves to, not a requirement to migrate everything at once.

## Consequences

- The database is now read when a setting is used, so a command that reads one needs the schema to
  be current: run `migrate` first (the development seed does; other admin commands assume it).
- A database override wins over the deployment environment. That is deliberate (an operator decides
  for the instance), but an override left behind is invisible in the environment; its row must be
  cleared to return to the environment value.
- Every new setting needs a registry entry, a `Configuration` field and a test of its precedence;
  the registry keeps the environment name and default from drifting from the documentation.
- Changing a setting takes effect on the next command or process start, not mid-flight in a running
  controller.
