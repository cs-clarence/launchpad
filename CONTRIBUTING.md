# Contributing

For contributors working on the Launchpad controller and CLI.
Keep this document current when commands or workflow change.

## Checks

Use Bun 1.4.4 and Omni. Install dependencies and projected agent context:

```sh
bun install --frozen-lockfile
bun run setup:agents
```

On a fresh checkout, build first to generate TanStack's ignored route tree.
These commands do not start a server or require Docker, PostgreSQL, or Dokku:

| Command                                                       | Coverage                                                                 | Cost / location                  |
| ------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------- |
| `bun run build`                                               | Controller's production Bun output, CLI, library builds and declarations | Broadest check, local            |
| `bun run check:types`                                         | All app/library sources and shared tooling                               | Fast, local; build first         |
| `bun run check:lint`                                          | App/package TypeScript                                                   | Fast, local                      |
| `bun run check:format`                                        | Hand-maintained repository files                                         | Fast, local                      |
| `bun run test`                                                | Services and in-memory Elysia adapter tests                              | Fast, local; no listeners        |
| `docker compose --env-file .env.local.example config --quiet` | Existing Dokku Compose syntax                                            | Fast, local; optional Docker CLI |

No CI-only checks have been configured. Install the Cocogitto commit-msg hook
locally with `cog install-hook --all`; it validates Conventional Commit messages
and checks existing history once the repository has a first commit. Browser tests, live
database/SSH tests, image builds and deployment tests are not part of bootstrap.
See [tooling](docs/tooling.md) and [patterns](docs/patterns/README.md).

## Git

This repository was initialized on `main` with no commits, so no established
commit or merge convention was detected. The approved starting convention is:
short-lived `<type>/<short-slug>` branches, focused Conventional Commit messages
(for example `feat: add a preview`), as configured in `cog.toml`,
PRs and squash merges, and no force-pushes to shared branches or committed
secrets. Passing checks and one review are recommended before merging, but
branch protections and remote settings have not been configured.
