# Native moon dependency invalidation for pnpm

A pnpm 12 workspace with precise dependency-update inputs for moon 2.6. Use ordinary **moon commands** for builds, tests, affected queries, and CI. No command wrapper, affected-project adapter, or WASM plugin is required.

## Toolchain

| Tool       | Version |
| ---------- | ------- |
| moon       | 2.6.4   |
| proto      | 0.63.2  |
| Node.js    | 26.12.1 |
| pnpm       | 12.15.0 |
| Vite       | 8.3.5   |
| Vitest     | 5.0.5   |
| Oxlint     | 1.89.0  |
| Oxfmt      | 0.74.0  |
| TypeScript | 7.0.2   |

`.prototools` pins the runtime tools; `.moon/toolchains.yml` inherits Node/pnpm versions and pins proto. The manifest and committed pnpm lockfile pin JavaScript tooling. Older versions of the example dependencies are deliberate isolation fixtures, not application dependency recommendations.

## Workspace

Arrows mean “consumed by”:

```text
is-odd@3.0.1 → numbers → reports → dashboard
  └─ is-number@6.0.0

picocolors@1.1.1 → colors → palette

is-odd@2.0.0 → legacy-numbers
  └─ is-number@4.0.0
```

All six projects have Vite builds, Vitest tests, Oxlint, and Oxfmt tasks. Moon infers workspace relationships from `workspace:*` dependencies. Builds depend on `^:build`, and tests build their workspace dependencies before importing their output.

## Setup

Install [proto](https://moonrepo.dev/docs/proto/install), inspect the repository configuration, then:

```sh
proto trust .prototools
proto install --config-mode local
pnpm install --frozen-lockfile
moon run root:deps-check
moon sync vcs-hooks
```

`moon sync vcs-hooks` installs the configured pre-commit hook using moon's native hook integration. Generated `.moon/hooks/` scripts are ignored; the hook definition is committed in `.moon/workspace.yml`. Integrate any existing custom Git hooks before changing their routing.

Moon needs Git history and a resolvable default branch (`main` here). CI must fetch the relevant base and head history; shallow checkouts cannot reliably determine affected tasks.

## Native jobs and dependency updates

| Job                   | Purpose                                                                            | Runs automatically in CI? |
| --------------------- | ---------------------------------------------------------------------------------- | ------------------------- |
| `root:deps-update`    | Update changed `.moon-deps.json` files and prune owned files for removed importers | No                        |
| `root:deps-check`     | Read-only validation against the current lockfile                                  | Always; not cached        |
| `root:test-extension` | Graph-engine and generated-input regression tests                                  | When affected             |
| `root:typecheck`      | TypeScript checking across the workspace                                           | When affected             |
| `root:verify-deps`    | Disposable native moon E2E scenarios and hook checks                               | Always; not cached        |

After changing dependencies:

1. Update/install dependencies with pnpm.
2. Run `moon run root:deps-update`.
3. Review and stage the changed manifests, `pnpm-lock.yaml`, and generated `.moon-deps.json` files, including deletions.
4. Commit normally. The native pre-commit hook checks the **Git index**.

```sh
moon run root:deps-update
moon run root:deps-check
moon run root:deps-check -- --staged
```

`deps-update` never stages files. `deps-check` never rewrites them. A fresh working-tree snapshot does **not** make a stale staged snapshot valid: the hook reads the staged lockfile and staged generated files, not their working-tree replacements.

The updater is intentionally excluded from CI. For an explicitly requested maintenance update in a shell that already sets `CI=true`, use the native override `moon exec --ci=false root:deps-update`; CI itself must check committed inputs, not silently repair them.

## Normal moon commands

```sh
moon run :build
moon run :test root:test-extension root:typecheck
moon run :lint :format-check
moon run :build --affected
moon query affected
moon ci --include-relations --downstream deep
```

Dependency snapshots include workspace dependency closures, so a dependency update changes the snapshots of transitive workspace consumers as well. These are ordinary changed inputs to moon, including in explicit base/head comparisons.

The CI command includes native relation tracking and deep downstream traversal to cover source changes through task dependencies too. These flags have moon's normal graph semantics: a focused build request with downstream expansion may also include dependent test tasks. There is no custom target filtering here.

Bare `moon ci` also includes the mandatory freshness check and E2E task. The GitHub workflow runs the freshness check **separately first**, ensuring stale metadata fails before affected CI work starts. The independent checker is deliberately not a dependency of every project task, which would broaden dependency-based affected selection.

## How generated inputs work

Each pnpm importer, including the workspace root, has a tracked `.moon-deps.json` containing a generator marker, schema version, importer ID, and SHA-256 hash. The hash identifies:

- Its complete resolved package closure: direct, dev, optional, transitive, and workspace dependencies.
- Full peer/patch snapshot identities and package resolution/integrity metadata.
- The root importer's dependency closure, treated as shared tooling.
- Any preceding boot/tooling YAML documents in pnpm 12's lockfile.

Mapping order and YAML formatting do not affect the generated hash. Different versions of the same package remain separate graph nodes. An unrelated dependency update leaves a project's generated file unchanged.

The custom implementation is limited to:

- `tools/pnpm-deps/lock-graph.mjs`: selects canonical resolved closures from pnpm schema 9.0.
- `tools/pnpm-deps/inputs.mjs`: generates files or checks the working tree/Git index.

Neither module chooses moon targets or invokes moon. Moon owns affected-input matching, graph traversal, task ordering, hashing, execution, and caching.

The example-tag task configuration requires each project's generated file as a [native file input](https://moonrepo.dev/docs/config/project#inputs). `.moon/workspace.yml` keeps `hasher.optimization: performance`, so moon hashes manifest requirements rather than adding generic lockfile-resolution matching to the precise generated input. The **whole shared lockfile is not a global project-task input**.

This gives exact affected-task selection even with empty caches. It is not a “consider every task and hope unrelated tasks hit cache” workaround. Root-level freshness checking intentionally reads the whole lockfile; workspace-wide type checking and shared tooling checks have their own broader inputs.

Do not edit generated files manually. Updates only replace recognized generated files and prune recognized orphan files; unowned/corrupt files and symlink paths are rejected rather than overwritten.

## GitHub Actions CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on pull requests, pushes to `main`, and manual dispatch:

1. Full-history checkout.
2. Official [`moonrepo/setup-toolchain`](https://github.com/moonrepo/setup-toolchain) with `auto-install: true`, using the repository's pinned versions.
3. `pnpm install --frozen-lockfile`.
4. Unconditional `moon run root:deps-check`.
5. `moon ci --include-relations --downstream deep`, including native E2E verification.
6. Upload current successful CI and E2E reports.

Actions use immutable commit pins with release comments. The setup action caches **proto tools**, not moon task state, so GitHub runners do not rely on a warm moon task cache. Repository permissions are read-only; no PR-comment or repository-write token is required.

The native CI report is `.moon/cache/ciReport.json`. E2E evidence is `.moon/cache/dependency-inputs-e2e.json`; both are uploaded as workflow artifacts after successful verification.

## End-to-end verification

```sh
moon run root:verify-deps
```

The verifier creates its own Git repository and private dependency installation, invokes the real native check/update tasks, installs and exercises the native pre-commit hook, and reads actual moon reports, installed package versions, and persisted hashes. It cleans its temporary workspace in `finally` and does not commit or change your checkout's Git hook routing.

It covers:

- Missing, stale, fresh, and idempotent generated-input transitions.
- A stale staged snapshot rejected despite fresh unstaged working-tree data; a coherent staged commit accepted by the actual hook.
- Native CI rejecting an intentionally stale lockfile-only commit even when project tasks would otherwise be omitted.
- Direct, transitive-only, different-version, and separate-branch dependency updates.
- Cold-cache native affected queries and CI selection; unaffected project tasks must be absent, not just cached.
- Semantic lockfile no-ops, shared root tooling updates, ordinary source changes, and selective warm-cache reuse.

| Dependency scenario                          | Relevant project tasks                         |
| -------------------------------------------- | ---------------------------------------------- |
| `is-odd` 3.0.1 → 3.0.0                       | numbers, reports, dashboard                    |
| Only numbers' transitive `is-number` 6 → 7   | numbers, reports, dashboard; legacy stays on 4 |
| `picocolors` 1.1.1 → 1.1.0                   | colors, palette                                |
| YAML key reordering without semantic changes | No project tasks                               |
| Shared root `yaml` tooling update            | All six projects                               |

Root bookkeeping checks are accounted for separately. The fixture disables only its own `verify-deps` job to prevent recursive E2E execution; the mandatory freshness checker remains enabled. The transitive case predeclares a scratch-only scoped override accepting versions 6 or 7, then performs a real frozen install of the changed graph. Downgrades are reproducible version-change fixtures.

Registry access is required. The report parser targets pinned moon 2.6.4: CI uses `ciReport.json`, other executions use `runReport.json`, and task hashes live in per-task `lastRun.json` files. A root project can appear as ancestor metadata in native affected queries without having affected task commands.

## Adopt this in another pnpm 12 / moon 2.6 workspace

Only the custom integration is needed; keep your existing applications, build commands, proto setup, and native JavaScript/pnpm toolchains.

1. Copy `lock-graph.mjs` and `inputs.mjs` into `tools/pnpm-deps/` and install `yaml` in the workspace root. The module location defines the workspace root two directories above it.
2. Define native root `deps-update` and `deps-check` tasks as in `moon.yml`: both uncached, updater excluded from CI, checker `runInCI: always` with the raw lockfile and generated files as its own inputs.
3. Add the generated input to dependency-consuming tasks, preserving their existing commands, inputs, outputs, and dependency edges:

   ```yaml
   implicitInputs:
     - file: .moon-deps.json
       optional: false
   ```

   Scope this inherited configuration to the relevant projects/tasks. **Do not require the generated file on maintenance jobs**: they must be able to detect or repair missing files. This example scopes it using the `example` tag and gives root test/typecheck tasks explicit inputs.

4. Keep `hasher.optimization: performance`. Remove any whole-lockfile input or broad root glob that would invalidate every project. Keep root manifest/shared configuration and generator source files as appropriate inputs.
5. Run the native update job, review the output, and commit all generated files with the lockfile. The importer ID is a workspace-relative directory, not a moon project ID.
6. Merge the staged pre-commit check into your native `vcs.hooks`, enable `vcs.sync`, and install with `moon sync vcs-hooks`. Do not replace unrelated existing hook commands.
7. In CI, install frozen dependencies, run the native freshness checker unconditionally **before** `moon ci`, and fetch enough Git history. Do not auto-update generated files in CI to hide stale commits.
8. Adapt behavioral E2E scenarios to your own dependency branches. This example's `verify.mjs` intentionally knows its six fixture projects and is not a generic drop-in workspace runner. The two unit-test modules are regression coverage, not runtime dependencies.

Generated inputs must reflect the **final** lockfile and be included in the compared Git revisions. Generating ignored files during a moon graph/sync hook is not equivalent: changed-file collection may already have happened, graph hooks may be cached, and revision comparisons do not include arbitrary worktree-only generation. See the [affected model](https://moonrepo.dev/docs/concepts/affected) and [graph extension contract](https://github.com/moonrepo/moon/blob/v2.6.4/crates/pdk-api/src/common.rs#L58-L110).

## Boundaries

- One shared root pnpm lockfile, schema 9.0. All YAML documents are parsed; the final document is the project graph.
- Every root-importer dependency is shared tooling. Put project-specific dependencies in project importers if you need isolation. Boot/tooling and global settings/checksums conservatively affect all projects.
- Catalog and exact/name-only patches are reachability-scoped; ranged patches use resolved `patch_hash` identities. Overrides are resolution policy; effective changes are tracked through resolved edges.
- External mutable directory/link dependencies, unresolved workspace references, unsupported publish-directory links, and file tarballs without integrity fail explicitly.
- Lockfile fingerprints do not replace normal source inputs or native task dependency hashes.
- Generated files are required tracked inputs. Missing/stale inputs are errors, not an invitation for CI or hooks to mutate the commit automatically.
