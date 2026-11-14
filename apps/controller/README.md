# Controller

For contributors to the TanStack Start dashboard and Elysia HTTP adapter.
Keep this page current when the entry points or runtime change.

- `src/routes/api.$.ts` mounts `src/server/api.ts` without starting another server.
- Services live in `@launchpad/services`, outside HTTP and UI frameworks.
- `src/styles.css` installs Skeleton 5, Tailwind 4, and the Cerberus theme.
- `Dockerfile` produces a non-root Bun runtime from Nitro's build output.
- `.env.local.example` lists future PostgreSQL and Dokku SSH settings. They are
  placeholders, not working connection configuration.

Only scaffold metadata is exposed at `/api/health`. No authentication,
deployments, SSH connection, or database integration is enabled.

Run checks from the repository root as described in
[CONTRIBUTING.md](../../CONTRIBUTING.md). Do not expose this scaffold as a
management service.
