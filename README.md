# Selective pnpm dependency updates with moon

A pnpm workspace using moon, proto, Vite, Vitest, Oxlint, and Oxfmt. Dependency updates invalidate only the projects whose **resolved dependency closures** change and their workspace consumers. Unrelated projects retain their task caches.

## Toolchain

Exact stable releases, resolved from the official release feeds and npm registry when this example was created:

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

`.prototools` owns the runtime versions; `.moon/toolchains.yml` inherits Node and pnpm versions and pins moon's proto integration. The root manifest pins JavaScript tooling, and `pnpm-lock.yaml` is committed for frozen installs. The deliberately different example dependency versions are fixtures, not recommendations for application dependencies.

## Workspace graph

Arrows mean “consumed by”:

```text
is-odd@3.0.1 → numbers → reports → dashboard
                 └── is-number@6.0.0 (external transitive dependency)

picocolors@1.1.1 → colors → palette

is-odd@2.0.0 → legacy-numbers
                 └── is-number@4.0.0 (separate resolved version)
```

All six projects have Vite library builds and Vitest tests. Shared tasks are inherited by the `example` tag; moon infers workspace dependency relationships from `workspace:*` declarations. Build tasks depend on `^:build`; tests build their workspace dependencies before importing their output.

## Setup and commands

Install [proto](https://moonrepo.dev/docs/proto/install), then:

```sh
# Inspect the configuration before trusting its proto self-version pin.
proto trust .prototools
proto install --config-mode local
pnpm install --frozen-lockfile

pnpm build
pnpm test
pnpm lint
pnpm format-check
pnpm exec tsc --noEmit
pnpm format
```

Normal moon commands require a Git history and a resolvable default branch. This example configures `main`; adjust `vcs.defaultBranch` in `.moon/workspace.yml` for another repository. No commits or branches are created in your checkout by the verifier below. On an unborn branch, use `pnpm verify-deps` to exercise the complete workspace in a disposable repository instead.

After updating dependencies, run:

```sh
# Compare a baseline commit with the current working tree, including untracked files.
pnpm affected --base HEAD -- :build :test

# Inspect projected changed paths and dependency importers without running moon.
pnpm affected --base HEAD --dry-run -- :build

# CI: compare two commits after checking out the head with a clean working tree.
pnpm affected --base origin/main --head HEAD -- :build :test :lint :format-check

# Inspect a project's current cache fingerprint.
node tools/pnpm-deps/cli.mjs fingerprint --project packages/numbers
```

`--base` is required. This compares the two specified trees directly, not their merge base; pass the merge-base commit explicitly if your CI needs merge-base semantics. Without `--head`, staged, unstaged, deleted, renamed, and nonignored untracked source paths are included. An explicit `--head` can reference any commit for dry runs; execution requires the checked-out `HEAD` and a clean working tree so the compared graph matches the code being built.

Install the updated lockfile before running tasks. Moon's normal toolchain integration also installs dependencies when required. Supported selectors are `:task`, `project:task`, and `#tag:task`; put all selectors before execution options. The adapter forwards `--force`/`-f`, `--interactive`/`-i`, `--no-actions`, `--output-style`, `--job`, `--job-total`, and `--summary`/`-s`. A second `--` forwards arguments to the underlying task. Globs, default/closest-project locators, task-tag locators, `--query`, execution plans, and overriding the adapter's affected/graph settings are rejected explicitly.

## How moon is extended

There is no upstream `projectsAffectedByDependencyUpdates: auto` setting added by this repository. It implements the equivalent workflow through two supported moon interfaces, without a core fork or a WASM plugin.

### 1. Precise task cache fingerprints

[Native fingerprint checks](https://moonrepo.dev/docs/config/project#fingerprint) mix a command's stdout into each task hash:

```yaml
checks:
  - check: fingerprint
    script: node ../../tools/pnpm-deps/cli.mjs fingerprint
    hash: stdout
```

The relative path is intentional: checks execute from the project directory but do not expand task tokens. All example projects are two directories below the workspace root. Root tasks use `node tools/pnpm-deps/cli.mjs fingerprint` instead.

`tools/pnpm-deps/lock-graph.mjs` follows each importer's dependency, dev-dependency, optional-dependency, and workspace-link edges. It includes complete peer/patch snapshot identities, package resolution metadata and integrity, and transitive package snapshots. Different versions of the same package remain separate graph nodes. Object-key order does not affect fingerprints.

The fingerprint also includes the root importer's closure, because Vite, Vitest, and OXC are shared root tooling. A shared tool update intentionally invalidates every project. pnpm 12 can emit two YAML documents: the final project document is traversed, and preceding boot/tooling documents are hashed separately. See [pnpm's lockfile documentation](https://github.com/pnpm/pnpm/blob/main/pnpm/docs/lockfile.md).

`.moon/workspace.yml` sets [hasher.optimization: performance](https://moonrepo.dev/docs/config/workspace#optimization). Moon still hashes manifest requirements, but its generic lockfile dependency hashing is bypassed; the fingerprint supplies the exact resolved closure, including transitive dependencies. This avoids mixing our precise result with moon's generic dependency-name matching. The shared lockfile is deliberately **not** a global file input.

Ordinary unfiltered `moon run :build` therefore also benefits from selective cache invalidation.

### 2. Precise affected-task selection

A changed task hash does **not** make a task affected. `--affected` filters tasks before their cache fingerprint can rescue an omitted task.

`tools/pnpm-deps/cli.mjs affected` compares the base and current resolved graphs. It replaces a changed root `pnpm-lock.yaml` path with only the changed importers' existing `package.json` paths, preserving ordinary source changes. Selection and execution then use separate native moon phases:

1. `moon action-graph <requested targets> --json` expands the requested selectors and required upstream tasks.
2. `moon query affected --upstream none --downstream deep` receives projected `{"files":[...]}` on stdin and computes affected tasks, including transitive consumers.
3. The adapter intersects those native task sets and executes `moon run --upstream deep --downstream none <exact affected targets>`.

This separation matters: `moon run --downstream deep` also expands its **action graph**, potentially adding dependent test tasks to a build-only request. Querying downstream affected state first preserves source-change propagation without running unrequested dependent task types. Required upstream tasks can still run or hit cache normally.

Moon owns selector expansion, affected-input matching, graph traversal, dependency ordering, execution, and caching. The adapter does not implement a second workspace/task graph. See the [action graph export](https://moonrepo.dev/docs/commands/action-graph), [moon stdin parser](https://github.com/moonrepo/moon/blob/v2.6.4/crates/app/src/queries/changed_files.rs), and [affected graph semantics](https://moonrepo.dev/docs/concepts/affected). Dry runs report the file/importer projection only; they do not execute these native planning queries.

**Use `pnpm affected`, not bare `moon run --affected`, for dependency-update selection.** Bare moon does not perform this lockfile-to-project projection. No generated marker files or tracked per-project lockfiles are required.

## Adopt this in another pnpm 12 / moon 2.6 workspace

This section covers **only the custom dependency-update integration**. Keep your existing projects, commands, toolchains, proto setup, build tools, and task dependencies; none of the demo packages or Vite/OXC configuration is required.

### 1. Copy the two runtime modules

Copy these files, preserving their location relative to the workspace root:

```text
tools/pnpm-deps/
├── cli.mjs
└── lock-graph.mjs
```

Install their only non-built-in runtime dependency in the workspace root:

```sh
pnpm add --workspace-root --save-dev --save-exact yaml@2.9.1
```

The CLI locates the workspace two directories above its own file and reads the root `pnpm-lock.yaml`. Each instrumented moon project must correspond to a pnpm importer; the importer ID is its workspace-relative directory, not its moon project ID. This implementation assumes one shared root lockfile with schema 9.0 and handles pnpm 12's separate boot document.

The two `*.test.mjs` files are optional regression coverage, not runtime dependencies. `verify.mjs` is specific to this example's six projects and dependency fixtures: do **not** copy it unchanged as a generic verifier.

### 2. Add a fingerprint to dependency-sensitive tasks

Merge this fragment into each existing task that must invalidate when its resolved dependencies change. Preserve its command, dependency edges, outputs, existing checks, and source inputs:

```yaml
# In an existing project task, or a shared inherited task definition.
tasks:
  build:
    inputs:
      - package.json
    checks:
      - check: fingerprint
        script: node ../../tools/pnpm-deps/cli.mjs fingerprint
        hash: stdout
```

Repeat the check for relevant test, lint, code-generation, or other cached tasks—not just `build`. Use your existing task inheritance rules; the demo's `example` tag is not required.

Two details are necessary for correctness:

- Include the project's `package.json` in its task inputs. The affected adapter projects a dependency change onto that path even when its file contents have not changed.
- Adjust the script's relative path for the task's working directory. The fragment assumes a depth-two project such as `packages/core`. A root task uses `node tools/pnpm-deps/cli.mjs fingerprint`. Checks do not expand `$workspaceRoot`. By default, the fingerprint derives its importer from the working directory; if that differs from the project directory, pass an explicit importer, for example `fingerprint --project packages/core`.

Merge these integration inputs into a shared `.moon/tasks/*.yml` definition inherited by the relevant tasks:

```yaml
implicitInputs:
  - /package.json
  - /pnpm-workspace.yaml
  - /.moon/**/*.yml
  - /tools/pnpm-deps/cli.mjs
  - /tools/pnpm-deps/lock-graph.mjs
```

Keep your other shared configuration inputs. Root `package.json` must affect every instrumented task because root-tooling changes are projected onto it. Changes to the custom hashing implementation must also invalidate existing caches.

Remove the **whole shared lockfile** from global/task file inputs that would invalidate every project. Audit broad root globs as well as explicit `/pnpm-lock.yaml` entries. Do not remove project source inputs or native task dependency edges.

### 3. Let the custom fingerprint own resolved dependency hashing

After all dependency-sensitive tasks have their fingerprint checks, merge this into `.moon/workspace.yml`:

```yaml
hasher:
  optimization: performance
```

This bypasses moon's generic lockfile-resolution hashing, not its manifest hashing. The custom check supplies the precise resolved closure instead. The setting is workspace-wide: applying it without instrumenting relevant tasks would weaken their dependency invalidation. In a polyglot workspace, account for its effect on other toolchains before adopting it globally.

### 4. Route dependency-aware affected runs through the CLI

Add this root manifest script:

```json
{
  "scripts": {
    "affected": "node tools/pnpm-deps/cli.mjs affected"
  }
}
```

After installing an updated lockfile, use:

```sh
pnpm affected --base HEAD --dry-run -- :build
pnpm affected --base HEAD -- :build :test
```

In CI, check out the head revision and pass the intended baseline with `--base`; add `--head HEAD` only with a clean working tree. The supported selectors and execution options are listed above.

The custom CLI performs the lockfile-to-importer projection and intersects moon's native requested-task graph with its native affected-task set. Moon still owns workspace relationships, selector expansion, source-input matching, task ordering, execution, and caching. Keep your native JavaScript/pnpm integration and task dependency edges configured; no moon plugin registration, WASM build, or generated per-project lockfile is needed.

### 5. Verify isolation with your own packages

Establish a baseline build, then check a direct update, an external transitive-only update, and a dependency version used by only one branch of your workspace. Assert both the selected tasks and native task hashes/cache statuses: unaffected projects must not execute or change hashes, while affected consumers must rebuild. A subsequent unfiltered build should hit the caches populated by the affected run. Also check a semantic lockfile no-op and a shared tooling update.

The unchanged implementation deliberately treats **every root-importer dependency** and boot-tooling document as shared by all tasks. Keep project-specific dependencies in their project importers if you need isolation. Shared configuration/settings changes remain conservative global invalidations; the other supported-input boundaries are listed below.

## End-to-end proof

```sh
pnpm verify-deps
```

The verifier copies the workspace into a temporary Git repository, installs its own dependencies without lifecycle scripts, runs actual moon/Vite builds, runs the workspace's Vitest/OXC tasks, and reads moon's task statuses and persisted hashes. It does not modify or commit your working tree. Registry access is required for the published versions used by the scenarios.

It asserts the following, then emits a JSON evidence record:

| Scenario                                           | Builds invalidated/executed |
| -------------------------------------------------- | --------------------------- |
| `is-odd` 3.0.1 → 3.0.0 using real `pnpm add`       | numbers, reports, dashboard |
| Only numbers' transitive `is-number` 6 → 7 changes | numbers, reports, dashboard |
| `picocolors` 1.1.1 → 1.1.0                         | colors, palette             |
| YAML mapping order changes, graph unchanged        | none                        |
| Shared root `yaml` tooling version changes         | all six                     |
| numbers source changes, lockfile unchanged         | numbers, reports, dashboard |

Downgrades are intentional, reproducible dependency-update fixtures. The transitive case declares a stable **scratch-only** scoped override accepting versions 6 or 7 before establishing its baseline. It then changes only the resolved transitive edge, performs a frozen install, and checks the installed version; legacy-numbers stays on version 4. The example checkout's dependency policy is untouched.

Every scenario verifies both native affected execution and a subsequent unfiltered moon build: unaffected task hashes stay identical and the unfiltered build hits all six caches. The verifier also records a native lockfile-only affected run without the adapter as a control.

The verifier's report reader targets pinned moon 2.6.4 (`.moon/cache/runReport.json` and per-task `lastRun.json`). Update it deliberately when changing moon versions.

## Boundaries

- Root tooling, boot tooling, global lockfile settings/checksums, and shared configuration changes conservatively affect every project.
- Catalog and exact/name-only patch declarations are scoped to reachable packages. Ranged patches use their resolved `patch_hash` identity. Override declarations are resolution policy; effective changes are tracked through resolved graph edges.
- Only pnpm lockfile schema 9.0 is accepted. Unknown schemas and missing graph entries fail rather than silently reuse stale caches.
- Workspace `link:` references and injected directory dependencies must map to lockfile importers. External mutable directories/links, publish-directory links that do not map to an importer, unresolved `workspace:` locators, and file tarballs without integrity are rejected.
- Lockfile snapshots do not hash mutable local source contents. Normal moon source inputs and task dependency hashes remain responsible for source changes.
