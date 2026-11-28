# Risk overrides

## Scope

Repository-specific additions to the risk tiers for this repository. They follow
[precedence](guidelines/core/precedence.md#overriding-rules) and are referenced
from `AGENTS.md` and `CONTRIBUTING.md`. The baseline tiers are in
[core/risk-tiers.md](guidelines/core/risk-tiers.md#tiers).

Keep this file up to date when one of these paths moves or a new always-High
area appears.

## Always High risk

Each entry adds a criterion: a change touching the scope is High risk, even when
the diff looks small. "Change" includes source, tests, defaults and dependency
changes inside the scope. Documentation elsewhere is not affected.

### Authentication and sessions

- rule: `core/risk-tiers.md#tiers`
- action: add
- scope: `packages/auth/**`, `apps/controller/src/server/auth-session.ts`, `apps/controller/src/server/session.ts`, `apps/controller/src/lib/auth-client.ts`, `apps/cli/src/session-*.ts`
- effective: every change is High risk
- reason: session or credential handling can grant account access; small defects
  are hard to detect and expensive to reverse.

### Authorization and access control

- rule: `core/risk-tiers.md#tiers`
- action: add
- scope: `packages/services/src/authorization.ts`, `packages/services/src/api-keys.ts`, `packages/services/src/invitations.ts`, `packages/services/src/organizations.ts`
- effective: every change is High risk
- reason: the role matrix and key or membership rules decide who can read and
  mutate organization data; a small widening is a security incident.

### Schema, migrations and deletion

- rule: `core/risk-tiers.md#tiers`
- action: add
- scope: `packages/database/src/migrations/**`, `packages/database/src/auth-schema.ts`, `packages/database/src/migrate.ts`, `packages/alias-router/src/schema.ts`, `packages/services/src/deployment-deletion.ts`, `packages/services/src/app-shutdown.ts`
- effective: every change is High risk
- reason: schema, forward-only migrations and deletion paths change persistent
  data and are hard or impossible to undo after they run.

### Secrets and production configuration

- rule: `core/risk-tiers.md#tiers`
- action: add
- scope: `docker-compose.yaml`, `docker-compose.env.example`, `packages/services/src/controller-config.ts`, `apps/controller/src/server/startup-settings.ts`, `packages/auth/src/config.ts`
- effective: every change is High risk
- reason: a wrong default, mount or validation rule can expose secrets or stop a
  production deployment; the effect appears only on real infrastructure.

### Deployment execution

- rule: `core/risk-tiers.md#tiers`
- action: add
- scope: `packages/dokku/**`, `apps/worker/**`, `packages/alias-router/src/control-client.ts`, `packages/alias-router/src/host/config.ts`, `apps/router/src/serve.ts`
- effective: every change is High risk
- reason: these paths run remote commands, gate deployments and verify control
  trust; a defect can affect running applications or an external host.
