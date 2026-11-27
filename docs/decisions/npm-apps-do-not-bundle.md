# npm apps do not bundle their dependencies

Status: accepted. Plan: [unbundled-npm-apps](../plans/unbundled-npm-apps.md).

## Context

The rule: any app distributed on npm must not bundle its dependencies. Until now the packed CLI
and MCP server were each one file that `bun build` produced, with `client-core`, the SDK and the
contracts inlined, so the registry showed neither the code a user runs nor its real dependency
set, and a fix in a dependency needed a new bundle.

## Decision

- No package distributed on npm bundles a dependency. Every dependency is declared and imported.
- Five packages are packed in lockstep: `contracts`, `sdk`, `client-core`, `cli`, `mcp`.
  `client-core` becomes public; nothing is published by this change, and publishing it waits
  for a security review.
- The apps are built with Vite (`ts-vite-script`) into `dist/cli.mjs` and `dist/mcp.mjs`, with a
  node shebang in the source, no `exports`, no types and `generateTypes: false`.
  `src/index.ts` stays the entry.
- Source manifests reference every owned package as `workspace:^` (`check:deps` requires
  exactly that) and stay private. Packing writes `^<lockstep version>`.
- Gates on every tarball: closure, bare-import allowlist, size budgets, marker strings, and a
  real `npm install` of the five on Node, on top of the Bun install.

## Consequences

- `client-core`'s exports and on-disk formats become a `0.x` compatibility promise
  (`docs/releasing.md`); it is POSIX only.
- An install pulls five packages; a `0.x` caret allows patch differences between them.
- `thirdPartyDependencies` and the rebuild with `bun build` are gone from `package-clients.ts`.
- `client-core`'s declarations name the contracts' types, so it declares
  `@launchpad-kit/contracts`; `Packed.archive` is `Uint8Array` so they need no Node types.
- The apps' build output is `dist/cli.mjs` and `dist/mcp.mjs`, not `dist/index.js`.
- Deviation from the generator's CLI convention: one entry (`cli`/`mcp`) with no library entry
  and no `src/cli/` split, `bin` as an object, and `private` kept with `publish` disabled
  (`published: true` would make the source manifest public while no publish step exists).
  The generator now follows the rule for published scripts.

## Alternatives

- Keep bundling workspace packages into the apps: hides code and dependencies.
- Inline `client-core` into the apps only: still a bundle.
- One umbrella package: hides the dependency graph again.
- Exact internal versions (`0.1.0`): rejected; caret ranges, with the closure check pinning the
  shape.
