# Plan: npm apps do not bundle their dependencies; client-core is public

Status: proposed, not started. Base: `origin/main` at `1d1da58` (re-based after the first draft, which was at
`1f9216a`; #112, #113 and #114 are merged, nothing is stacked). #114 added
`tooling/commander-imports.ts` (+ spec), `tooling/ts-scan.ts` (`SOURCE`, `scriptKind`,
`syntaxProblems`, `walkSources`), `check:imports` wired into `check`, `runtime-agnostic.ts`
refactored onto `ts-scan`, and moved `release-dry-run.ts` to extra-typings. `docs/guidelines` is projected and absent in this worktree; the rules were read from the
main checkout. There is no `docs/plans/release-0.1.0.md` on this base; release planning lives in
`docs/releasing.md`.

Rule (from the user): any app distributed on npm must not bundle its dependencies. Decisions
D1-D5 are taken as recommended in the first draft: `cli.mjs`/`mcp.mjs`; a real `npm install` smoke
on Node; client-core's `src/index.ts` published as is under the 0.x rule; Windows documented as
POSIX-only. **D3 was reversed by the user** (final): every owned package reference is
`workspace:^` in source, and the packed specifier is `^<lockstep version>` (not exact).

## Assessment

- **Kind:** Medium; sequential slices, work solo, no agent split.
- **Risk tier:** High (a new public package whose exports become a compatibility promise, a
  credential store going public, a release pipeline that cannot be undone once published).
  Independent review required. Nothing is published by this change.
- **How much changes:** `tooling/package-clients.ts`, `check-packages.ts`, `release-dry-run.ts`,
  `runtime-agnostic.ts`, the two apps' `package.json`/`vite.config.ts`/`project.omni.yaml`/entry
  shebang, client-core `package.json`/README, docs, a few references to `dist/index.js`, and a
  small generator change.
- **Unknowns:** reduced by spikes (below). Remaining: the packed form under Node was not run.
- **Hard to undo:** code is easy to revert; publishing client-core is not (out of scope).
- **People/time:** one person, about 1-2 days including review.
- **Moves up a kind if:** client-core's surface needs redesign, or the security review (slice 4)
  finds a defect that changes the credential store.

## Findings (verified in `origin/main`; builds and npm spikes ran in throwaway directories; `git

status` shows only this file)

### 1. Build and run today

- Dev: `bin` is `./src/index.ts` with `#!/usr/bin/env bun` as line 1 of
  `apps/{cli,mcp}/src/index.ts`; `build` is `bun build src/index.ts --target=bun --outdir=dist`
  (`apps/cli/package.json:8`, `apps/mcp/package.json:8`), which emits `dist/index.js`.
- `apps/{cli,mcp}/vite.config.ts` exist, import `createConfig` from
  `@launchpad-kit/vite-config/app` (`app.ts`, `script.ts` and `library.ts` are the same function:
  `app.ts:1`, `script.ts:1` re-export `./library.ts`). `library.ts` externalizes `node:`/builtins
  and every declared `dependencies`/`peerDependencies` name and subpath (`library.ts:24-34`,
  `:44-52`), workspace packages included. Nothing in the config needs to change to "externalize
  everything".
- Experiment (`bun --bun run vite build` in each app): cli -> 62,971 bytes, mcp -> 8,405 bytes,
  single `.mjs` each. cli's bare imports are exactly `@commander-js/extra-typings`,
  `@elastic/micro-jq`, `@launchpad-kit/client-core`, `@launchpad-kit/sdk`, `node:child_process`,
  `node:fs`, `node:fs/promises`, `node:path`; mcp's are `@commander-js/extra-typings`,
  `@launchpad-kit/client-core`, `@launchpad-kit/sdk`, `@modelcontextprotocol/sdk/server/mcp.js`,
  `.../server/stdio.js`, `zod`. The `#!/usr/bin/env bun` hashbang of the source is **preserved** as
  line 1; **no executable bit** (the file is mode 644).
- The vite build also runs `unplugin-dts` for the apps (about 40 `.d.ts` incl. `*.spec.d.ts`,
  3 s): useless for apps, turned off by `generateTypes: false` (`library.ts:7,35-39`).
- The output is `index.mjs` because the vite entry key is `index`. Renaming the key to
  `cli`/`mcp` gives `cli.mjs`/`mcp.mjs` (D1).
- The source has no `import.meta`, no JSON import and no dynamic `import()` (grep); `check:runtime`
  keeps it that way. A single entry yields a single file. A future dynamic import would create a
  chunk: `files` must then be `*.mjs` (the allowlist `^[A-Za-z0-9_-]+\.mjs$` already admits it).
- Run: `bun dist/index.mjs --version` works in the workspace (Bun resolves the workspace
  packages from source). Under Node the workspace build fails only because
  `@launchpad-kit/client-core` resolves to its private `src/index.ts`. The installed form uses the
  generated manifests, so Node is checked only by the installed-tarball smoke test.
- Omni: `ts-vite-app` and `ts-vite-script` are byte-identical apart from `name`
  (`omni/presets/ts-vite-{app,script}.omni.yaml`; both `extends: ["./ts.omni.yaml"]`). `build` is
  `bun run build`, depends on `^build`, cache output `dist/**/*`, cache key includes
  `packages/vite-config/src/**` (`omni/presets/ts.omni.yaml:24-35`). Switching the script to
  `vite build` keeps the same output and key. `omni run build` does not pass `bun --bun`: the
  tooling's own build does (`package-clients.ts:129-132`); same as the libraries today.

### 2. What the `ts-package` generator does for CLIs (Pureform-derived)

Read: `omni/generators/ts-package/{generator.omni.yaml,README.md,templates/*}`.

- `package_type: script` is the CLI type: `"bin": "./dist/<name>-cli.mjs"` (a **string**, so npm
  names the command after the package: `cli` / `mcp`, not `launchpad` / `launchpad-mcp`), vite
  entries `<name>-cli` -> `src/cli/index.ts` **and** `index` -> `src/index.ts`, config from
  `@launchpad-kit/vite-config/script`, `generateTypes` and `externalizeDeps` both set to
  `script_can_be_used_as_lib` (default `false`: a plain script **bundles its dependencies**, which
  breaks the rule), `exports` only when `script_can_be_used_as_lib`, shebang
  (`node`|`bun`|`deno`, default `bun`) written at the top of `src/cli/index.ts`, dependencies
  `commander` + `@commander-js/extra-typings` from the catalog.
- `src/cli/index.ts.tpl` reads `../../package.json` with a JSON import (`name`, `description`,
  `version`): rolldown inlines that JSON (including the whole object, devDependencies and all)
  into the output. Not to be copied: this repo's `--version` string is a literal that
  `tooling/versions.ts:19-20` rewrites (`apps/cli/src/program.ts:94`, `apps/mcp/src/server.ts:64`).
- `published: true` => `private: false`, `publishConfig.access`, `publish` task enabled,
  `meta.publish: true`, and `.npmignore` (the generator has no `files` field). No existing package
  in this repository is `script`-type (grep for `ts-vite-script`/`vite-config/script`: only the
  preset itself).
- `publish` in this repo: `omni/presets/ts.omni.yaml:95-96` defines `publish` with `enabled: false`
  and **no `exec`**; the apps set `publish.enabled: false` and `meta.publish: false`; nothing in
  `tooling/`, `.github/` or the root `package.json` reads `meta.publish` or runs a publish
  command (grep). Setting `published: true` on a generated package would therefore enable an empty
  task and make the **source** manifest non-private: a `bun publish`/`npm publish` in the package
  directory would ship workspace specifiers and `src`. That contradicts "nothing is published by
  this repository" and the pipeline of "generated manifest from staging". Keep `private: true`,
  `publish.enabled: false`, `meta.publish: false` for all five (as the SDK and contracts do today).
- `release_group: core` only appends the package glob to `cog.toml` (`@anchor:new-core-package`).
  `apps/**` and `packages/client-core/**` are already in the core include list, so no change.

### 3. Target shape for `apps/cli` and `apps/mcp` (decisions with evidence)

The shape follows the generator's published-CLI convention (`script` + library-style build:
externalized dependencies), with these deliberate differences:

| Aspect                                 | Generator (`script`, lib)     | Target here                                                                    | Why                                                                                                                                                                                                                   |
| -------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preset                                 | `ts-vite-script`              | **move to `ts-vite-script`**                                                   | Identical to `ts-vite-app`, so no behaviour change; it is the generator's name for a CLI. Edit `extends` in both `project.omni.yaml`. Vite config import becomes `@launchpad-kit/vite-config/script` (same function). |
| Entries                                | `<name>-cli` + `index`        | **one entry, `cli` / `mcp` -> `src/index.ts`**                                 | (c) below                                                                                                                                                                                                             |
| Output file                            | `dist/<name>-cli.mjs`         | **`dist/cli.mjs`, `dist/mcp.mjs`**                                             | (a) below                                                                                                                                                                                                             |
| Shebang                                | in source, chosen per package | **`#!/usr/bin/env node` in `src/index.ts`** (both apps)                        | Rolldown preserves it (measured), so the packed file needs no stage-time rewrite; Bun ignores the line when running source. The runtime-agnostic rule is about APIs, not shebangs. Staging still asserts line 1.      |
| `bin` (source manifest)                | string -> dist                | **`{ launchpad: "./dist/cli.mjs" }`, `{ "launchpad-mcp": "./dist/mcp.mjs" }`** | The object form names the commands; same as the packed manifest. (d) below                                                                                                                                            |
| `externalizeDeps`                      | only when lib                 | **true (default) for both**                                                    | The user's rule                                                                                                                                                                                                       |
| `generateTypes`                        | only when lib                 | **false**                                                                      | (c) below                                                                                                                                                                                                             |
| `exports` / `types`                    | only when lib                 | **none**                                                                       | Apps are executables, not libraries; `package.json` has no `exports` and the tarball has no `.d.ts` (see allowlist)                                                                                                   |
| `files` / `.npmignore`                 | `.npmignore`                  | **`files` in the generated manifest**                                          | The tarball is built from a staged directory, so an allowlist already decides; `.npmignore` would never be read.                                                                                                      |
| `private` / `publish` / `meta.publish` | `published` flag              | **private, `publish` disabled, `meta.publish: false`**                         | see section 2                                                                                                                                                                                                         |

**(a) File names.** The generator's `cli-cli.mjs` / `mcp-cli.mjs` repeats the package name and the
`-cli` suffix has no meaning here. Explicit `cli.mjs`/`mcp.mjs` keeps the names in the smoke test,
the docs and `bin` stable. Re-extending is cheap: the six references to `dist/index.js` change in
any case, because `bun build` emitted `dist/index.js` and vite emits `.mjs` (below), so the rename
adds no extra churn. Recommend `cli.mjs`/`mcp.mjs`. The generator should gain a `bin_name` input
(default: package name) and name the output after the entry key `cli`, not `<name>-cli` (slice 5).

**(b) `app` vs `script` preset and `publish`.** Move to `ts-vite-script` (no functional change,
generator-aligned). Keep the `publish` task disabled; see section 2 for why `published: true`
would be harmful in this repository today.

**(c) Library entry and types.** `src/index.ts` of the apps is the executable
(`process.exitCode = await run(...)`), and importing it as a library would run it. A second
`index` entry would publish the CLI's internals (`run`, `Io`) as an API nobody asked for, and
generate ~40 declarations. So: one entry, no `exports`, no `types`, `generateTypes: false`. This
means the apps' `src/index.ts` is **not** moved to `src/cli/index.ts` (the generator's layout
exists to separate a bin from a library entry; with no library entry the move is churn in
imports and docs without benefit). Recorded as a deliberate deviation. Tests import `./program`,
not `./index` (grep found no importer of `./index`).

**(d) Dev ergonomics.** The generator's `bin -> dist` means a linked `launchpad` needs a build.
Today's `bin: ./src/index.ts` is used by nobody in the repository: usages found by grep are
`dist/index.js` paths, not `bin`:
`apps/controller/src/__tests__/deployments-hop.spec.ts:173,218` (`bun ../cli/dist/index.js`,
`../mcp/dist/index.js`), `docs/local-quickstart.md:96`, `docs/local-deploy.md:81`
(`alias launchpad="bun $PWD/apps/cli/dist/index.js"`), `apps/mcp/README.md:19`,
`docs/tooling.md:20,179`, `CONTRIBUTING.md:28`. These already need a build and a `dist`; they
change to `dist/cli.mjs` / `dist/mcp.mjs` (no new build requirement). Running source directly
(`bun apps/cli/src/index.ts`) keeps working (Bun ignores the node shebang). The workspace
install links `node_modules/.bin/launchpad` to `dist/cli.mjs`, which exists after `build`.
Stale-`dist` caveat (`CONTRIBUTING.md:28`): the old `dist/index.js` stays beside the new files
until a `-f all` build; mention it in the docs change.

**(e) Generator change** (slice 5, minimal): in `generator.omni.yaml` and templates

- `externalizeDeps` becomes `script_can_be_used_as_lib or published` (a published CLI never
  bundles; a private throw-away script may). Keep `generateTypes` tied to the lib flag.
- `bin` becomes an object `{ "<bin_name>": "./dist/<entry>.mjs" }`; new input `bin_name`
  (default: package name); the entry key is `cli` (`dist/cli.mjs`), not `<name>-cli`.
- A non-lib script drops the stray `index` -> `src/index.ts` entry (it emits an unused,
  bundled `index.mjs`).
- README of the generator: one sentence recording that "a published CLI never bundles its
  dependencies" and that `published` is private-by-default in this repository (see section 2),
  plus the JSON-import warning from section 2. Update `tooling/*.spec.ts` only if a test reads
  the generator (grep: none does).

**Commander rule (user rule: `@commander-js/extra-typings`, never untyped `commander`).** The
published `cli` and `mcp` already comply: they import only `@commander-js/extra-typings`
(`apps/mcp/src/index.ts:8`, `program.ts:1`; cli likewise). They keep `commander` declared **only**
because extra-typings has it as a peer dependency; it is never imported directly. The closure and
bare-import checks therefore treat `commander` as an allowed declared peer (not required to be
imported, and a direct `import "commander"` in a built file would still be legal for the allowlist
but is forbidden by source guards). `tooling/declared-deps.spec.ts` guards the declaration. This
plan does not add or duplicate a guard against direct `commander` imports: it is **already in
`origin/main` (#114)**: `omni -i run check:imports` (`tooling/commander-imports.ts`, part of
`check`) scans `apps`, `packages` and `tooling` for any import, `require` or `import()` of bare
`commander` or `commander/*`, so it also covers the apps' entry points and any new CLI entry point
or generator output placed under those roots. In slice 5, `src/cli/index.ts.tpl` already imports only
`@commander-js/extra-typings` (line 9) and the template declares both packages; keep it that way
(extra-typings as the only imported entry, `commander` as its declared peer) and add a comment-free
README line saying so.

**(f) `cog.toml`/release group.** No change. `apps/**` and `packages/client-core/**` are in the
`core` list; `release_group` has no effect on existing packages. `tooling/versions.ts` discovers
workspace packages and `versions.spec.ts` stays as is; check with `omni -i run check:versions`.

### 4. Staging (`tooling/package-clients.ts`) and what changes

Today: `TARGETS` (`:29-34`) has contracts and sdk as `library`, cli/mcp as `bundle`.
Libraries copy `dist` through `copyLibraryDist` and get a generated manifest where a workspace
dependency is `^<version>` (`:207`). Bundles re-run `bun build --target=node` with the third-party
closure external (`thirdPartyDependencies` `:80-103`, `externalsFor` `:173`), rewrite the shebang
and `chmod 755` (`:236-267`). `build()` runs `bun --bun run build` (`:128-132`), so for the apps it
runs the `bun build` build and discards it.

Note on the size of the slice-1 diff: `TARGETS` **already** carries `bin: { name: "launchpad",
file: "cli.mjs" }` and `{ name: "launchpad-mcp", file: "mcp.mjs" }` (`package-clients.ts:29-34`),
because the bundles are written with `--outfile=<stageDir>/cli.mjs`; so D1 is partly in place.
What D1 changes is the _vite entry key_ (output `index.mjs` -> `cli.mjs`), the `dist` paths in
docs/tests, and the removal of the rebuild; the smoke test's `cli.mjs`/`mcp.mjs` paths do not move.

**Slice-1 invariant: builds keep running under Bun regardless of the Node on the `PATH`.**
`build()` keeps `bun --bun run build` (`:128-132`; the apps' `build` script becomes `vite build`
and is run through it). Reason (#113): the vite config is TypeScript, which Node before 22.18
cannot load, and the CI Packages job runs Node 22.12 and current; only the _runs of the packed
files_ use the selected Node. A test or comment must keep this explicit.

Changes:

1. One kind: every target is a library-style package; a target with a `bin` is an _executable_:
   manifest `{ name, version, description, type: "module", engines, bin: { <name>: "./<file>" },
   files: [<file>, "README.md"], dependencies }`, **no** `main`, `types`, `exports` or
   `sideEffects`. Delete the `bundle` kind, `thirdPartyDependencies`, `externalsFor`, the `bun build`
   call and the shebang rewrite. The staged file is `dist/<file>` copied byte for byte; staging
   `chmod 755`s it (vite writes mode 644).
2. `TARGETS` order: contracts, sdk, client-core, cli, mcp (`kind` library for the first three;
   `bin` on the last two).
3. Workspace dependencies in generated manifests stay **caret** (D3, final):
   `"@launchpad-kit/sdk": "^0.1.0"`, as `:207` already writes
   (`dependencies[name] = \`^${byName(name).version}\``); no change there. Bun's own pack step
   also rewrites `workspace:^`to`^<version>`and`catalog:`to the exact catalog version
   (verified with Bun 1.4.4), so the closure gate below is a tripwire on the produced tarball
   manifest. The generated-manifest pipeline stays for 0.1.0 because`publishConfig.exports`/
   `main` overrides are **not** applied by Bun (verified). Third-party ranges come from the
   catalog (`:210`). Dependencies come only from each package's own `package.json`; a workspace
   dependency not in `TARGETS` still throws (`:200-206`), now with client-core included.
4. `engines.node` `>=22.12` is declared for all five (comment `:188` updated: commander 15, and
   client-core's `tar`).
5. `ALLOWED_PATH` (`:282-287`) is unchanged (an app tarball holds `package.json`, `README.md` and
   `cli.mjs`/`mcp.mjs`; no `.d.ts`). `FORBIDDEN_PATH` (`:288`) gains `\.map$` and
   `(^|\/)node_modules\/` so those two are **explicitly** rejected, not only unlisted. Apps ship
   no `exports` and no `types`; a test asserts the packed manifest of an app has neither.
6. Stale comments: `tooling/package-clients.ts:1-3` ("the CLI and the MCP server as one bundled
   file each") and `:5-7`; `tooling/runtime-agnostic.ts:1-4` ("plus client-core, which is bundled
   into the CLI and the MCP server"); `PUBLISHED_DIRS` (`:14`) becomes
   `TARGETS.map(dir)` (client-core is in `TARGETS`, so no special case or duplicate).
7. `release-dry-run.ts:143` loops over `TARGETS`; it packs five tarballs and `SHA256SUMS` gains
   two lines with no code change. Text that says "four" is updated.

### 5. client-core as a public package

- Surface: `src/index.ts` is 13 lines; `export *` from `errors`, `operations`, `redact`,
  `workspace`, `app-client`, `fields`, plus named exports. D4: published as is; every exported name
  is part of the 0.x compatibility rule below. The README says so and says other users should use
  `@launchpad-kit/sdk`.
- Node: `dist/index.mjs` imports `@launchpad-kit/sdk`, `node:crypto`, `node:fs`, `node:os`,
  `node:path`, `node:util`, `picomatch`, `tar`, `zod` (measured). Declarations import only
  `@launchpad-kit/sdk` and `zod`. `check:runtime` already scans it. `copyLibraryDist` works
  unchanged.
- On-disk formats: `credentials.json` (`store.ts:13`) and `session.json` (`session-store.ts:16`)
  are `version: 1`; a different format is refused and never rewritten (`secure-file.ts:146-150`).
  Compatibility rule to add: a format change needs a reader for the previous version, since the
  CLI and MCP share the files.
- POSIX-only (D5): the permission checks (mode 700/600, owner via `process.getuid`,
  `O_NOFOLLOW ?? 0`) are skipped when `process.platform === "win32"` (`secure-file.ts:49`,
  `:118`). The README and `docs/releasing.md` say Windows is unsupported and untested.
- **Pre-publish security gate (slice 4).** A package that handles API keys and session cookies
  becomes a public library. Before it is publishable, a threat review of:
    - `redact.ts`: `redact` hides only `lp_[A-Za-z0-9_-]{8,}` (`redact.ts:4`); `redactSecrets` covers
      run-specific secrets in several encodings. What reaches `console`/MCP/error messages
      from `client-core` (grep for `console.` in `src` found none outside specs: verify again).
    - `secure-file.ts`: modes 0o700/0o600, `O_NOFOLLOW`, owner check, atomic replace, the lock file
      and its recovery rule, and what happens on win32 (skipped checks: fail closed or document).
    - Error messages: do they echo paths, keys, cookies or server bodies?
    - What an embedder can do wrongly with the public exports (e.g. `CredentialStore` with a
      chosen directory) and whether the README warns.
      Output: a short review note in the PR (or `docs/decisions/`), fixes as separate commits, and the
      0.x compatibility paragraph in `docs/releasing.md` (surface, on-disk formats, POSIX-only,
      Node range). Publishing client-core is blocked until it is done.

### 6. Gates

All are pure, unit-tested functions in `tooling/package-clients.ts`
(`package-clients.spec.ts`, bun:test), called from `check-packages.ts` and `release-dry-run.ts`
beside `checkManifest`.

**Closure (`checkClosure(manifests)`).**

- Covers `dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies`, and
  `bundledDependencies`/`bundleDependencies` (the key must not exist at all, nor
  `devDependencies`). No `workspace:`, `catalog:`, `file:`, `link:`, git or URL specifier in any
  of them (extends `checkManifest` `:310-320`, which today checks only three keys).
- Every `@launchpad-kit/*` name in any dependency section is one of the five published packages
  and its packed specifier is exactly `^<lockstep version>` (the caret form of the one shared version).
- **All five carry the identical `version`.** Within 0.x, `^0.1.0` means `>=0.1.0 <0.2.0`: a
  caret allows only patch drift, never a new minor. Patch drift between the five is acceptable:
  lockstep releases publish all five together, so a normal install resolves matching versions,
  and a user who holds cli 0.1.2 next to sdk 0.1.1 still has a compatible set by the 0.x rule
  (patches are fixes; any breaking change is a minor and cannot satisfy the caret). The cost: a
  patch fix in client-core reaches an installed cli only when the user updates or reinstalls
  (npm may keep an older satisfying copy), and the single-copy assertion in the smoke test
  guards against two copies in one tree. From 1.0.0 the caret allows minors, which the
  compatibility rules already treat as non-breaking.
- `publishConfig` must be absent from every packed manifest (a leak of a source `publishConfig`,
  e.g. `access`, `exports` or `main` overrides, into the tarball would change resolution; the
  generated manifest drops it today and the gate keeps it that way), as must `private`, `scripts`,
  `workspaces` and `overrides`.
- **Tripwire:** Bun's pack step rewrites the protocols itself; this gate reads the produced
  tarball manifest and fails if a specifier is anything else.
- A **third-party dependency shared by several published manifests has the same range in each**
  (zod in sdk, client-core and mcp, from the catalog).
- Direction "declared workspace dependency, never imported": allowed. `check:deps` already forbids
  dead dependencies in source, with an exemption for peers of declared dependencies
  (`tooling/check-deps.ts:315-334`, `peerNames`), which is what lets `commander` (a peer of
  `@commander-js/extra-typings`) stay declared though the apps import only the latter
  (`apps/mcp/src/index.ts:8`, `program.ts:1`; `tooling/declared-deps.spec.ts` guards that
  `commander` and the extra-typings package are declared by the manifest that imports them).
  The closure check therefore does **not** require that every declared dependency is imported.
- Direction "imported but not declared" is the bare-import check below.

**No bundled dependencies (`checkUnbundled`).** Applied to every `.mjs` **and** every `.d.ts` of
the five tarballs, all packages (not only apps):

- (a) _Bare-import allowlist_ (implemented with `tooling/ts-scan.ts`, not a new parser:
  `scriptKind` (`.mjs` -> JS, `.d.ts` -> TS), `syntaxProblems` for the fail-closed parse rule and
  the TypeScript 6 syntax tree, as `commander-imports.ts` and `runtime-agnostic.ts` do; `walkSources`
  is for directories and the tarball files are listed explicitly): every bare specifier of `import ... from`, `import "x"`,
  `import("x")`, `export ... from`, `import x = require("x")` and `/// <reference types>` is
  `node:*`, a Node builtin, or a **declared dependency of that package** (or a subpath of one). A
  type-only import in a `.d.ts` needs the dependency declared too (client-core's declarations
  import `@launchpad-kit/sdk` and `zod`, both declared).
- (b) _Size budgets,_ per package, derived from the current builds: cli 62,971 bytes, mcp
  8,405 bytes. Rule: budget = measured size rounded up by 25 % (cli 80 kB, mcp 12 kB) kept in a
  table in `package-clients.ts`; a legitimate growth raises the number in review. Inlining a
  dependency (zod alone is far larger than mcp's headroom; the MCP SDK, tar and commander
  larger than cli's) fails the budget.
- (c) _Marker strings:_ a unique string of each externalized package must be **absent** from
  the cli and mcp tarball files. The markers are derived from the published packages at check time,
  not hand-written where possible (for each workspace dependency: a string only its built `dist`
  contains, such as one of its error-code literals or the `name` of an export chosen once in the
  spec; for each third-party dependency: a stable string in its own `package.json`
  "name" field's module text such as `"@modelcontextprotocol/sdk"` is not enough, so the spec
  pins one literal per package, found by `grep` when written: zod, commander, tar, picomatch, the MCP SDK,
  micro-jq). The spec verifies each marker is present in the installed
  dependency (so a stale marker fails loudly) and absent from the app's file.
- (d) _Vite config test_ in `tooling/vite-config.spec.ts` style: the two apps' configs, with their
  real `package.json`, make `isExternal` true for `@launchpad-kit/client-core`,
  `@launchpad-kit/sdk`, a third-party name with a subpath
  (`@modelcontextprotocol/sdk/server/mcp.js`) and `node:fs`; `externalizeDeps` is not set to `false`;
  the entry keys are exactly `cli` / `mcp` (so the output is `cli.mjs` / `mcp.mjs`).
- (e) `bundledDependencies`/`bundleDependencies` absent (closure above).

**Bin.** Unit tests on the stage function: the staged executable has mode 755 and line 1 is
exactly `#!/usr/bin/env node` (a missing or `bun` shebang fails); the packed manifest's `bin` is
the object form and points at an existing packed file. Evidence: in a spike, `bun pm pack` kept
mode 755 on a `bin` file and also made a 644 `bin` file executable in the tarball, and
`npm install` of the tarball left `node_modules/.bin/<name>` a link to an executable
file. So a 644 bin becomes 755 under `bun pm pack` (already verified), and the mode is also normalized
by the tools; the check is still on what we stage and pack.

**Runtime-agnostic guard.** Unchanged in behaviour; the package list is `TARGETS`-derived and
includes client-core (it already did).

**Node smoke test with real npm (`check-packages.ts`).** Two spikes, run by me in throwaway
directories under `/tmp/opencode` (deleted afterwards) with an isolated `HOME`, `NPM_CONFIG_CACHE`,
`npm_config_userconfig` and `NPM_CONFIG_PREFIX`, on npm 10.9.0 (Node 22.12.0) and npm 11.20.0
(Node 26.13.1):

_Spike 1_ (four fixture packages, nested dependencies pinned `0.1.0`, a registry dependency
`zod`, scope redirected to a dead address):

- **A.** `npm install ./a.tgz ./b.tgz ...` (one command, no overrides) succeeded; `zod` came from
  the registry.
- **B.** Direct `file:<abs>.tgz` dependencies plus `overrides` of `"$<name>"` references succeeded.
- **C.** An override that differs from the direct specifier (`"0.1.0"` vs `file:...tgz`) fails with
  `EOVERRIDE`.
- **D.** `--offline` works only with a warm cache; with a cold cache it fails `ENOTCACHED` for
  `zod`, so offline is not an option: the registry is needed for third-party packages (as
  `test:packages` already says: "needs the network").

_Spike 2, with the real caret form_ (`^0.1.0` between `@lk/contracts`, `sdk`, `core`, `cli`;
`zod` from the registry) and a **loopback fake registry** for the `@lk` scope: it serves a
packument for `@lk/sdk` listing `0.1.0` and a **poisoned `0.1.9`** (a satisfying, higher patch
whose tarball prints "POISON") and logs every request. Each row: exit code, wall time, installed
`@lk/sdk` version, registry requests, and the `package-lock.json` entry:

| Mode                                                 | Node 22.12 / npm 10.9                         | Node 26.13 / npm 11.20               |
| ---------------------------------------------------- | --------------------------------------------- | ------------------------------------ |
| A, registry reachable (fake, serving 0.1.9)          | rc 0, 1 s, sdk 0.1.0, **5 registry requests** | rc 0, 1 s, sdk 0.1.0, **8 requests** |
| A, scope redirected to a dead port (default retries) | rc 0, **71 s**, 0 requests                    | rc 0, **71 s**                       |
| A, dead port + `fetch-retries=0`                     | rc 0, 2 s                                     | rc 0, 1 s                            |
| **B**, `$name` overrides, registry reachable         | rc 0, 1 s, sdk 0.1.0, **0 requests**          | rc 0, 1 s, 0 requests                |
| **B**, overrides, `fetch-retries=0`                  | rc 0, 1 s, 0 requests                         | rc 0, 1 s, 0 requests                |

Every run left `@lk/sdk` at `0.1.0`, its lock entry `resolved` ending in the local tarball name,
and its `integrity` (`sha512-1S2dl...`) equal to the SHA-512 of the packed tarball (computed
with `openssl`; compared in full for one run, by prefix for the others). Findings:

- **The re-review's observation is confirmed:** with carets, install A consults the scope registry
  (5-8 requests, about a minute of retries when it is unreachable). In my reachable-registry
  simulation npm still kept the local tarball because the tarball named on the command line is
  already a direct dependency satisfying `^0.1.0`, but the behaviour relies on npm's resolution
  order, not on a guarantee.
- **B never consults the registry for owned packages** (0 requests, reachable or not), so a newer
  satisfying patch cannot win, and an unreachable registry costs nothing.

**Chosen design: B plus belts** (decision made with this evidence):

- The consumer `package.json` has `dependencies` of `"@launchpad-kit/<name>":
  "file:<abs tarball>"` for all five, and `overrides` of `"$@launchpad-kit/<name>"` for all five (the
  `$name` form: identical `file:` strings also work, differing ones raise `EOVERRIDE`). Install with
  `npm install --no-audit --no-fund --ignore-scripts` (a lockfile is written: the assertion below
  reads it).
- Tripwire `.npmrc` in the isolated userconfig: `@launchpad-kit:registry=http://127.0.0.1:9/` (a
  lookup for an owned name would fail instead of resolving someone else's package) with
  `fetch-retries=0`, so a regression costs seconds, not 71 s of retries. The step has a
  **time budget**: 120 s for the install (the step timeout of `check-packages.ts` is 5 min), a
  cold registry fetch of the third-party packages being the dominant cost; the owned packages add
  about 1 s.
- Isolated environment: `HOME`, `NPM_CONFIG_CACHE`, `npm_config_userconfig`, `NPM_CONFIG_PREFIX`
  inside the temp `work` dir, `NPM_CONFIG_UPDATE_NOTIFIER=false`; never `~/.npmrc` or global state.
- **Provenance assertion (stronger than `npm ls`):** after the install, for each of the five
  packages: `node_modules/@launchpad-kit/<name>/package.json` has the packed version **and** equals
  the manifest in the tarball; the lockfile entry `packages["node_modules/@launchpad-kit/<name>"]`
  has `resolved` naming the local tarball (`file:` path) and `integrity` equal to
  `sha512-<base64 SHA-512 of the tarball>`. `npm ls --all --json` is read as well (parsed even
  when it exits non-zero; no `invalid`/`missing`), plus a `node_modules` walk asserting exactly
  one `package.json` per `@launchpad-kit/*` name.
- Optional extra (cheap, not required): a unit-level test of the poisoned-registry case is **not**
  added to the repository; the spike is the evidence and the assertions above would catch the
  result of a regression.
- npm is found beside the selected Node (same directory as the resolved `node` executable), else
  on the `PATH`, else the step **fails** (CI) or is skipped with a message (local), mirroring
  `findNode`/`resolveNode`. No path to a particular Node manager appears in the code or docs; a
  developer picks the Node with `LAUNCHPAD_NODE` as today. CI runs Node 22.12 and the current
  release only (`tooling/ci.spec.ts:108-110`); other versions are for local runs.
- Then, under that Node: `node_modules/.bin/launchpad --version` (must equal the packed version),
  `--help`, the `launchpad-mcp` handshake (the existing `mcp-handshake.mjs`), the SDK smoke, an
  import of `@launchpad-kit/client-core` that creates a `CredentialStore` in a temp
  `LAUNCHPAD_CONFIG_DIR` and reads an empty config, and the TypeScript check (add a client-core
  import to `types.ts`).
- _Why a real npm run at all:_ Bun's installer and resolver, and npm's, are different
  implementations (layout, hoisting, bin links, `exports` handling); the installed files are what
  users run. The determinism caveat that remains is the third-party range: a newer satisfying
  patch of `zod` etc. may be installed, as for a user; the closure check pins the ranges.
- The existing Bun consumer is kept (the packages must also run on Bun).

`ci.spec.ts`: the Packages job matrix and steps need no change as long as the job runs
`test:packages` (setup-node supplies npm: 10.9 with Node 22.12). No new CI task or job is added;
the new checks live in `test:packages` and the dry run.

### 7. Docs and records

- `docs/decisions/npm-apps-do-not-bundle.md` (new): context (the rule; the current bundles inline
  client-core, sdk and contracts), decision (no npm-distributed app bundles dependencies; every
  declared dependency is external; client-core is public; five lockstep packages; `workspace:^`
  in source and `^<lockstep>` packed), consequences (a new public API, install pulls five packages, closure and
  no-bundle gates, `thirdPartyDependencies` removed), the generator-convention deviations of
  section 3, alternatives (keep bundling workspace packages; inline client-core; an umbrella
  package; `^` ranges).
- `docs/releasing.md`: "What a release contains" row -> five packages; the "stay runtime agnostic"
  paragraph at **lines 48-49** ("`contracts`, `sdk`, `cli` and `mcp` are published ... and
  `client-core` is bundled into the CLI and the MCP server") -> five published, none bundled;
  the "development entry points" paragraph at **lines 87-89** (`bun build --target=bun` and
  "rebuilds with `--target=node`") -> the packed file is the vite build with a node shebang in
  source; the dry-run paragraph at **line 99** ("packs the four client packages") -> five; the
  Compatibility rules gain a **client-core** paragraph (surface = `src/index.ts`, 0.x rule,
  on-disk formats `credentials.json`/`session.json` version 1 and the reader rule, POSIX-only,
  Node `>=22.12`) and a sentence that all five carry one version with caret internal
  specifiers (`^0.1.0` allows patch drift only in 0.x). **Confirmed:** `docs/releasing.md:77-78` repeats the sentence tail ("these in a
  published package means changing the rule here, in review.", then "for one of these in a
  published package means changing the rule here, in review."): remove line 78 in the docs slice.
- `docs/tooling.md:20,58-65,179` (line numbers re-checked on `1d1da58`; the commander/`check:imports`
  text at `:145` is already current and stays): `dist/index.js` -> `dist/mcp.mjs`/`cli.mjs`; the Packaging
  bullet (five packages, executables with external dependencies, the two new checks, the npm
  install); a sentence on the generator change.
- `docs/patterns/README.md` (the CLI row at `:25` and the commander paragraph at `:96`, already
  mentioning `check:imports`, stay): published packages and how an app becomes a published CLI.
- `CONTRIBUTING.md:28`: the `dist/index.js` example. `docs/local-quickstart.md:96`,
  `docs/local-deploy.md:81`, `apps/mcp/README.md:19`: `dist/index.js` -> the new names (the
  `tooling/local-quickstart.spec.ts` guide checks should be re-run).
- `apps/controller/src/__tests__/deployments-hop.spec.ts:173,218`: the two paths (not docs; part
  of slice 1 and checked by `omni -i run test:integration -p @launchpad-kit/controller` if the
  environment allows, otherwise reviewed by reading: **not verified here**, needs Docker/DB).
- READMEs of `apps/cli`, `apps/mcp`, `packages/client-core` (install line, public status, surface,
  POSIX-only, Node range); `packages/sdk/README.md` only if it calls client-core internal (grep
  first).
- `omni/generators/ts-package/README.md` (slice 5).
- `cog.toml`, `tooling/versions.ts`: no change (section 3, (f)).

### 8. Risks

| #   | Risk                                                                                                                                                                                                                                                                             | Mitigation                                                                                                                                                                                                                                                                                                                                                                              |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Dev ergonomics: `dist` names change (`dist/index.js` -> `cli.mjs`/`mcp.mjs`); the stale old file survives a cached build (`CONTRIBUTING.md:28`)                                                                                                                                  | Update the six references in slice 1; note in the docs; `-f all`                                                                                                                                                                                                                                                                                                                        |
| R2  | Shebang/exec bit: source shebang moves to `node`; vite writes mode 644                                                                                                                                                                                                           | Staging chmod 755; unit tests on mode and line 1; smoke runs `node_modules/.bin/*`                                                                                                                                                                                                                                                                                                      |
| R3  | `omni run build` runs `bun run build` without `--bun` (Node <22.18 cannot load the TS vite config)                                                                                                                                                                               | Same as the libraries today; the tooling uses `bun --bun`                                                                                                                                                                                                                                                                                                                               |
| R4  | ESM-only packages                                                                                                                                                                                                                                                                | Already true for sdk/contracts; stated in the client-core README                                                                                                                                                                                                                                                                                                                        |
| R5  | Version skew across the five packages (caret allows patch drift in 0.x)                                                                                                                                                                                                          | Closure check (identical versions, packed `^<lockstep>`, same third-party ranges); single-copy assertion; drift is patch-only by the 0.x rule                                                                                                                                                                                                                                           |
| R6  | Different resolvers and installers (Bun vs npm: layout, bin links, `exports`)                                                                                                                                                                                                    | A real npm install under Node; the Bun consumer stays                                                                                                                                                                                                                                                                                                                                   |
| R7  | client-core API and on-disk formats become promises                                                                                                                                                                                                                              | D4, README, compatibility rules, slice 4                                                                                                                                                                                                                                                                                                                                                |
| R8  | Declarations leak `@types/node` types                                                                                                                                                                                                                                            | Strict `--types ""` smoke uses `CredentialStore`                                                                                                                                                                                                                                                                                                                                        |
| R9  | **npm resolution of nested `^` workspace dependencies that are not on the registry** (npm consults the scope registry: 5-8 requests and ~71 s of retries when unreachable; a higher satisfying patch could win with a reachable registry; `EOVERRIDE` with a differing override) | Spike 2 (section 6): `file:` direct dependencies plus `$name` overrides (0 registry requests, reachable or not), tripwire `.npmrc` with `fetch-retries=0`, lockfile `resolved`/`integrity` and version assertions, isolated env; the registry is still needed for third-party packages (no offline mode; `ENOTCACHED`), so the step is network-dependent and a registry outage fails it |
| R10 | **Closure check false positive on `commander`** (declared, imported only through `@commander-js/extra-typings`)                                                                                                                                                                  | The closure check does not require declared dependencies to be imported; only the bare-import allowlist (imported => declared); peers of declared dependencies stay allowed, as in `check:deps`                                                                                                                                                                                         |
| R11 | An inlined dependency leaves no `import`, so the allowlist cannot see it                                                                                                                                                                                                         | Size budgets and absent-marker checks (section 6) plus the vite config test                                                                                                                                                                                                                                                                                                             |
| R12 | Generator change breaks other scaffolds                                                                                                                                                                                                                                          | Only `script` scaffolds change (none exist); dry-run the generator with `omni gen run ... -d` if available; otherwise review                                                                                                                                                                                                                                                            |
| R13 | Credential store security as a public package                                                                                                                                                                                                                                    | Slice 4 gate before publishing                                                                                                                                                                                                                                                                                                                                                          |
| R14 | Local Node versions in this plan are not CI                                                                                                                                                                                                                                      | CI covers Node 22.12 and current only (`ci.spec.ts:108-110`); other Node versions are for local runs via `LAUNCHPAD_NODE`                                                                                                                                                                                                                                                               |

## Slices

Each slice is one conventional commit; `omni -i run check test` is green after each.

1. **`feat(release): build the apps as unbundled executables`**: both apps: preset
   `ts-vite-script`, `build` -> `vite build`, vite config (`/script`, entry keys `cli`/`mcp`,
   `generateTypes: false`), `#!/usr/bin/env node` in `src/index.ts`, `bin` object -> `dist`;
   `package-clients.ts`: one kind, `TARGETS` with client-core, caret (unchanged) workspace specifiers, stage
   without a rebuild, chmod 755, `PUBLISHED_DIRS` from `TARGETS`, `FORBIDDEN_PATH` additions;
   update the six `dist/index.js` references and stale comments. **Includes a minimal bare-import
   allowlist check** (built on `tooling/ts-scan.ts`, no new parser) (the `.mjs` imports of each tarball must be declared dependencies or `node:*`)
   and the mode/shebang unit tests, so the "unbundled" claim is tested from this slice. Gates:
   `check`, `bun test tooling`, `test:packages` locally (network), the dry run's pack step.
2. **`feat(release): check the published set is closed and unbundled`**: `checkClosure` (all
   sections, identical versions, shared third-party ranges), the allowlist extended to `.d.ts`,
   size budgets, absent markers, the vite config test, unit tests, wired into `check-packages.ts`
   and `release-dry-run.ts`. **Also tighten `tooling/check-deps.ts`** (lines 283-311 accept any
   `workspace:` spec and reject only non-workspace pins) and `tooling/check-deps.spec.ts`: an owned
   package reference must be exactly `workspace:^`; `workspace:*`, `workspace:~`,
   `workspace:^1.2.3` and the like fail with a clear message. The current error text at
   `check-deps.ts:311` ("is pinned to ..., use catalog: or workspace:^") only fires for non-workspace
   specs and, for an **owned** package, wrongly offers `catalog:`; rewrite it per case: an owned
   package with a `workspace:` spec other than `workspace:^` -> "use `workspace:^`"; an owned package
   with `catalog:` (or any non-workspace pin) -> "owned packages are referenced as `workspace:^`,
   not `catalog:` or a version"; a third-party package with `workspace:` -> "is not a workspace
   package". **Specs** in `check-deps.spec.ts` (which today builds throwaway workspaces, e.g. `:169`):
   `workspace:*`, `workspace:~`, `workspace:^1.2.3` each fail; a `catalog:` reference to an owned
   package fails with the new text; `workspace:^` passes; a third-party `catalog:` still passes. All 63
   current references already comply; the generator template (`package.json.tpl`) already emits
   `workspace:^` and stays as is.
3. **`test(release): install the five tarballs with npm and run them on Node`**: the npm
   consumer (B: `file:` + `$name` overrides, tripwire `.npmrc`, 120 s budget), client-core smoke
   and types, lockfile `resolved`/`integrity` + version + single-copy assertions. Local runs on
   several Node versions through `LAUNCHPAD_NODE`; CI on 22.12 and current.
4. **`docs(release): security review and compatibility rules for the public client-core`** (the
   pre-publish security gate): threat review note, any fixes as separate commits, README, the
   client-core compatibility paragraph; blocks publishing, not slices 1-3.
5. **`chore(generator): a published CLI never bundles its dependencies`**: the template changes
   of section 3(e) and the generator README; a generator dry run.
6. **`docs: npm apps do not bundle their dependencies`**: decision record, `releasing.md`,
   `tooling.md`, `patterns`, READMEs, and the removal of the duplicated line.

Review gates: independent review after slices 1, 2 and 4 (High); `swe-self-review` before handing
back; the full local gate `omni -i run check test build --force all` once at the end, plus
`test:packages` on Node 22.12 and a current Node (what CI runs). CI is the backstop for the
Packages matrix.

## Changes after review

Findings of the first independent review (1-10), then the addendum (generator convention):

1. **`commander` false positive:** the positive "every declared dependency is imported" check is
   dropped. Verified: `commander` is a peer of `@commander-js/extra-typings`; both apps import only
   the latter (`apps/mcp/src/index.ts:8`). Corrected my earlier claim: `check:deps` allows a
   declared dependency that is a peer of another declared one (`check-deps.ts:315-334`), and
   `tooling/declared-deps.spec.ts` (not an `apps/*` spec) guards that commander is declared where
   imported. The gate is the bare-import allowlist plus budgets and markers.
2. **npm design (revised after the re-review):** a second spike with the real caret form and a
   loopback fake registry (poisoned 0.1.9) chose B (`$name` overrides, 0 registry requests) with
   a tripwire `.npmrc`, `fetch-retries=0` and lockfile/integrity assertions (section 6). Earlier: A works, B works with `$name`, C fails
   with `EOVERRIDE`, D `--offline` only with a warm cache; network and determinism caveats stated;
   tripwire `.npmrc`; "npm beside the selected Node, else PATH, else fail" rule with no Node-manager
   paths; single-copy via `npm ls --all --json` with a `node_modules` walk fallback; the
   unsubstantiated "bun ignores exports" claim removed and replaced with the real reason
   (different resolvers/installers).
3. **Versions (D3 reversed by the user):** packed specifier `^<lockstep>`, source `workspace:^`;
   closure asserts that exact packed form, identical version across the five and identical
   third-party
   ranges across published manifests.
4. **Closure sections:** all dependency kinds incl. bundled; reverse direction decided (declared
   but unimported: allowed); the bare-import allowlist also covers `.d.ts`.
5. **No-bundle false negatives:** per-package budgets from measured sizes (cli 62,971 B, mcp
   8,405 B, +25 %), absent markers, vite config test; the 200 kB budget and `node_modules/` text
   search are removed.
6. **Bin tests:** mode 755 and line 1 exactly `#!/usr/bin/env node`; verified that `bun pm pack`
   keeps 755 and even makes a 644 bin file executable, and that `npm install` links an executable.
7. **Explicit statements:** apps ship no `exports`/`types` (`generateTypes: false`); `.map` and
   `node_modules/` are in `FORBIDDEN_PATH`.
8. **Security gate:** slice 4 (credential store, `redact.ts:4` covers only `lp_`, win32 branches
   `secure-file.ts:49,118`, messages, compatibility rules incl. on-disk formats).
9. **Docs:** the duplicate line is **confirmed** at `docs/releasing.md:77-78` (remove 78); stale
   comments listed (`package-clients.ts:1-7`, `runtime-agnostic.ts:1-4`); the `releasing.md`
   paragraphs are at 48-49, 87-89, 99 (the first draft's "88-89" was corrected).
10. **Slices and risks:** slice 1 carries the minimal allowlist check; risks R9 (npm resolution)
    and R10 (commander) added; CI covers only Node 22.12 and current.

Addendum (generator convention, verified in `omni/generators/ts-package`):

- Target shape for the apps follows the generator's published-CLI shape (script preset, node
  shebang in source, `bin` -> dist, deps external) with deliberate deviations (section 3 table).
  The stage-time shebang rewrite is dropped (rolldown preserves the source shebang).
- (a) `cli.mjs`/`mcp.mjs` over `<name>-cli.mjs`; (b) `ts-vite-script` preset (identical to the app
  preset), `publish` stays disabled: it has no command in this repository and `published: true`
  would make the source manifest public; (c) one entry, no library entry, no types, no
  `src/cli/` move; (d) `bin` -> `dist` costs nothing new (all current users already use `dist`),
  six references updated; (e) generator slice 5; (f) `cog.toml`/`versions.ts` unchanged.
- Found: the generator's string `bin` would name the commands `cli`/`mcp`; its `package.json` JSON
  import inlines the whole manifest into the bundle; a plain script bundles its dependencies and
  emits a stray `index.mjs`.

Re-review (7 findings): (1) caret smoke re-spiked with a poisoned-0.1.9 fake registry: design B
with provenance assertions and a time budget; (2) closure also rejects `publishConfig` (and
`private`, `scripts`, `workspaces`, `overrides`), and a 644 bin becomes 755 under `bun pm pack`
(verified); (3) re-based on `1d1da58` (#114 merged): `check:imports` covers apps/packages/tooling,
`checkUnbundled` reuses `ts-scan.ts`, "separate PR" wording dropped, doc line refs re-checked;
(4) base restated; (5) `TARGETS` already has `bin.file` `cli.mjs`/`mcp.mjs`, slice-1 diff not
overstated; (6) slice-1 invariant: builds run under Bun (`bun --bun run build`), with the CI
matrix reason (#113); (7) `check-deps` tightening gains a `catalog:`-on-owned-package spec and a
rewritten error text (`check-deps.ts:311`).

Third addendum (D3 reversed): all owned references are `workspace:^`; packed `^<lockstep>`; no
exact specifiers; closure gate and a `check-deps.ts` tightening (slice 2) added.

Second addendum (commander rule): published cli/mcp already import only
`@commander-js/extra-typings`; `commander` stays declared as its peer and is an allowed peer in the
closure/bare-import checks; no duplicate guard here (`check:imports`, merged in #114, covers
`apps`, `packages` and `tooling`, new CLI entries included); the generator template keeps extra-typings as the only
import (section 3, "Commander rule"). No new decision.

## New decisions needed

- **D6 (generator):** apply the section 3(e) template change (externalize when `published`, `bin`
  object with `bin_name`, entry key `cli`) as slice 5, or only document the rule in the generator
  README. Recommended: change it.
- **D7 (client-core security review):** block publishing client-core on slice 4 (recommended), or
  publish with a documented caveat.
- **D8 (`src/cli/index.ts`):** keep `src/index.ts` as the apps' entry (recommended) or move it to
  match the generator layout.
- **D9 (budget headroom):** +25 % over the measured sizes (recommended) or a fixed number of kB.

## Could not verify

- A packed-and-installed run of the real five tarballs (needs the network and the build; the spike
  used fixture tarballs, and the vite builds were run, not packed).
- `deployments-hop.spec.ts` after the rename (needs Docker/DB, not started).
- That `omni gen run` accepts the template change (slice 5 dry-run).
- npm behaviour of other versions than 10.9 (Node 22.12) and 11.20 (Node 26.13.1).
- Registry ownership of `@launchpad-kit/*`.
