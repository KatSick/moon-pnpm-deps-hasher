import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";

const sourceRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
const projects = {
  numbers: "packages/numbers",
  reports: "packages/reports",
  dashboard: "apps/dashboard",
  colors: "packages/colors",
  palette: "apps/palette",
  "legacy-numbers": "packages/legacy-numbers",
};
const allTargets = Object.keys(projects)
  .map((id) => `${id}:build`)
  .sort();
const numberTargets = ["numbers:build", "reports:build", "dashboard:build"].sort();
const colorTargets = ["colors:build", "palette:build"].sort();
const transitiveOverride = "is-odd@3>is-number";
const transitiveOverrideRange = "^6.0.0 || ^7.0.0";
const nativeOptions = ["--no-actions", "--output-style", "buffer-only-failure"];
const isolatedInstallOptions = [
  "--ignore-scripts",
  "--prefer-offline",
  "--config.package-import-method=copy",
  "--config.enable-global-virtual-store=false",
  "--config.virtual-store-dir=node_modules/.pnpm",
  "--config.node-linker=isolated",
];
const cacheStatuses = new Set(["cached", "cached-from-remote"]);
const environment = { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" };

// Never inherit a caller's git/workspace overrides into the disposable repository.
for (const key of [
  "GIT_DIR",
  "GIT_COMMON_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "MOON_WORKSPACE_ROOT",
  "MOON_PROJECT_ROOT",
  "MOON_WORKING_DIR",
  "MOON_CACHE_DIR",
]) {
  delete environment[key];
}

function command(root, executable, args, input) {
  const result = spawnSync(executable, args, {
    cwd: root,
    env: {
      ...environment,
      PATH: `${join(root, "node_modules/.bin")}${delimiter}${environment.PATH ?? ""}`,
    },
    input,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 300_000,
  });

  if (result.error || result.status !== 0) {
    throw new Error(
      `${executable} ${args.join(" ")} failed${result.signal ? ` (${result.signal})` : ""}\n${result.error?.message ?? ""}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }

  return result.stdout;
}

function copySources(root) {
  cpSync(sourceRoot, root, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    filter(source) {
      const parts = relative(sourceRoot, source).split(sep);
      return (
        !parts.some((part) => [".git", ".sc", "node_modules", "dist"].includes(part)) &&
        !(parts[0] === ".moon" && parts[1] === "cache")
      );
    },
  });
}

// Install into a private virtual store, copying package contents rather than
// linking the user's node_modules or hardlinking mutable files from its store.
function install(root) {
  command(root, "pnpm", ["install", "--frozen-lockfile", ...isolatedInstallOptions]);
}

function installedVersion(root, importer, name, via) {
  let modules = join(root, importer, "node_modules");
  if (via) modules = dirname(realpathSync(join(modules, via)));
  const path = realpathSync(join(modules, name, "package.json"));
  const pathFromRoot = relative(realpathSync(root), path);
  assert.ok(
    !isAbsolute(pathFromRoot) && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`),
    `${name} resolves outside scratch: ${path}`,
  );
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(manifest.name, name, `Installed package name differs at ${path}`);
  return manifest.version;
}

// is-number has no newer 6.x release. Declare a stable, scratch-only scoped
// override before the baseline so both 6 and 7 are valid for is-odd@3, without
// changing global configuration during the transitive-only scenario. pnpm 12
// records this map at project-document top-level, not in settings or boot docs.
// Frozen installs validate that this map matches pnpm-workspace.yaml.
function prepareTransitiveOverride(root) {
  const path = join(root, "pnpm-workspace.yaml");
  const documents = parseAllDocuments(readFileSync(path, "utf8"));
  assert.equal(documents.length, 1, "Expected one pnpm workspace configuration document");
  const document = documents[0];
  assert.equal(document.errors.length, 0, document.errors.map((error) => error.message).join("\n"));
  const workspace = document.toJS();
  assert.ok(
    !workspace.overrides?.[transitiveOverride],
    "Scratch fixture already declares the transitive override",
  );
  workspace.overrides = { ...workspace.overrides, [transitiveOverride]: transitiveOverrideRange };
  document.contents = document.createNode(workspace);
  writeFileSync(path, document.toString());

  const lock = readLock(root);
  const odd = dependency(lock.project.importers[projects.numbers], "is-odd").version;
  assert.equal(
    snapshot(lock.project, "is-odd", odd).value.dependencies["is-number"],
    "6.0.0",
    "Expected the real fixture's is-number 6 baseline",
  );
  lock.project.overrides = {
    ...lock.project.overrides,
    [transitiveOverride]: transitiveOverrideRange,
  };
  writeLock(root, lock);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function readLock(root) {
  const documents = parseAllDocuments(readFileSync(join(root, "pnpm-lock.yaml"), "utf8"));
  assert.ok(documents.length > 0, "pnpm-lock.yaml must contain at least one YAML document");
  for (const document of documents) {
    assert.equal(
      document.errors.length,
      0,
      document.errors.map((error) => error.message).join("\n"),
    );
  }
  const values = documents.map((document) => document.toJS());
  const project = values.at(-1);
  assert.equal(
    String(project?.lockfileVersion),
    "9.0",
    "Expected pnpm's v9 project lockfile schema",
  );
  assert.ok(
    project.importers && project.packages && project.snapshots,
    "Missing pnpm v9 project graph",
  );
  return { documents, project, boot: values.slice(0, -1) };
}

function writeLock(root, lock) {
  const projectDocument = lock.documents.at(-1);
  projectDocument.contents = projectDocument.createNode(lock.project);
  const text = lock.documents
    .map((document, index) => {
      if (index > 0) document.directives.docStart = true;
      return document.toString();
    })
    .join("");
  writeFileSync(join(root, "pnpm-lock.yaml"), text);
}

function dependency(importer, name) {
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const entry = importer?.[field]?.[name];
    if (entry) {
      assert.equal(typeof entry, "object", `Expected v9 dependency record for ${name}`);
      assert.equal(typeof entry.version, "string", `Missing resolved version for ${name}`);
      return entry;
    }
  }
  throw new Error(`Missing dependency ${name}`);
}

function snapshot(lock, name, reference) {
  const key = `${name}@${reference}`;
  assert.ok(lock.snapshots[key], `Missing resolved snapshot ${key}`);
  assert.ok(lock.packages[key], `Missing resolved package ${key}`);
  return { key, value: lock.snapshots[key] };
}

async function registryPackage(name, version) {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`,
    {
      signal: AbortSignal.timeout(30_000),
    },
  );
  assert.ok(response.ok, `Registry returned ${response.status} for ${name}@${version}`);
  const metadata = await response.json();
  assert.equal(metadata.name, name);
  assert.equal(metadata.version, version);
  assert.equal(
    typeof metadata.dist?.integrity,
    "string",
    `Missing registry integrity for ${name}@${version}`,
  );
  // These three fixture packages are leaves; never invent a dependency closure.
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    assert.equal(
      Object.keys(metadata[field] ?? {}).length,
      0,
      `${name}@${version} is no longer a leaf (${field})`,
    );
  }
  return metadata;
}

function addLeafVersion(lock, name, oldReference, metadata) {
  const old = snapshot(lock, name, oldReference);
  assert.equal(
    Object.keys(old.value.dependencies ?? {}).length,
    0,
    `${old.key} is not a dependency leaf`,
  );
  assert.equal(
    Object.keys(old.value.optionalDependencies ?? {}).length,
    0,
    `${old.key} has optional dependencies`,
  );
  const key = `${name}@${metadata.version}`;
  assert.notEqual(key, old.key, `Scenario did not change ${name}'s resolved version`);

  if (!lock.packages[key]) {
    const record = { resolution: { integrity: metadata.dist.integrity } };
    if (metadata.engines) record.engines = metadata.engines;
    if (metadata.bin) record.hasBin = true;
    if (metadata.deprecated) record.deprecated = metadata.deprecated;
    lock.packages[key] = record;
  }
  if (!lock.snapshots[key]) lock.snapshots[key] = {};
  return metadata.version;
}

// moon 2.6.4 schema: runReport.actions[].node is tagged as
// {action: "run-task", params: {target: "project:task"}}. No task hash is
// present in this report. Actual hashes are flat lastRun.json state fields at
// .moon/cache/states/<project>/<task>/lastRun.json (simple IDs need no encoding).
// Sources: moon v2.6.4 action_node.rs, reports_subscriber.rs, run_state.rs,
// cache/src/state_engine.rs, and cache-item/src/cache_item.rs.
function readRun(root) {
  const path = join(root, ".moon/cache/runReport.json");
  if (!existsSync(path)) {
    // moon does not emit a report for an empty action graph. The caller removes
    // the previous report first, and exact target assertions reject this for
    // every non-empty expected run.
    return { targets: [], run: [], cached: [], skipped: [], noActionGraph: true };
  }

  const report = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(report.status, "completed", "Native moon pipeline did not complete");
  assert.ok(Array.isArray(report.actions), "Unsupported moon run-report actions schema");
  const result = { targets: [], run: [], cached: [], skipped: [] };
  const seen = new Set();

  for (const action of report.actions) {
    if (action.node?.action !== "run-task") continue;
    const target = action.node.params?.target;
    assert.equal(typeof target, "string", "Unsupported moon task-target report schema");
    assert.ok(allTargets.includes(target), `Unexpected native task ${target}`);
    assert.ok(!seen.has(target), `Duplicate native task ${target}`);
    seen.add(target);
    if (action.status === "passed") result.run.push(target);
    else if (cacheStatuses.has(action.status)) result.cached.push(target);
    else if (action.status === "skipped") result.skipped.push(target);
    else throw new Error(`${target} has unsuccessful native status ${action.status}`);
  }

  for (const field of ["run", "cached", "skipped"]) result[field].sort();
  result.targets = [...result.run, ...result.cached].sort();
  return result;
}

function executeMoon(root, executable, args, input) {
  rmSync(join(root, ".moon/cache/runReport.json"), { force: true });
  command(root, executable, args, input);
  return readRun(root);
}

function nativeBuild(root) {
  return executeMoon(root, "moon", ["run", ...allTargets, ...nativeOptions]);
}

function adapter(root, dryRun) {
  const args = [
    join(root, "tools/pnpm-deps/cli.mjs"),
    "affected",
    "--base",
    "HEAD",
    ...(dryRun ? ["--dry-run"] : []),
    "--",
    ...allTargets,
    ...nativeOptions,
  ];
  if (dryRun) return JSON.parse(command(root, process.execPath, args));
  return executeMoon(root, process.execPath, args);
}

function hashes(root) {
  return Object.fromEntries(
    allTargets.map((target) => {
      const [project, task] = target.split(":");
      const path = join(root, ".moon/cache/states", project, task, "lastRun.json");
      const state = JSON.parse(readFileSync(path, "utf8"));
      assert.equal(state.target, target, `Wrong native state at ${path}`);
      assert.equal(state.exitCode, 0, `Native task ${target} did not succeed`);
      assert.equal(typeof state.hash, "string", `Missing native task hash for ${target}`);
      assert.ok(state.hash.length > 0, `Empty native task hash for ${target}`);
      return [target, state.hash];
    }),
  );
}

function assertCached(result, targets, label) {
  assert.deepEqual(result.targets, targets, `${label}: native target selection differs`);
  assert.deepEqual(result.run, [], `${label}: unexpected cache miss`);
  assert.deepEqual(result.cached, targets, `${label}: every target must be cached`);
}

function reversedKeys(value) {
  if (Array.isArray(value)) return value.map(reversedKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .reverse()
        .map((key) => [key, reversedKeys(value[key])]),
    );
  }
  return value;
}

async function verify(root) {
  copySources(root);

  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const moonVersion = command(root, "moon", ["--version"]).trim();
  const pnpmVersion = command(root, "pnpm", ["--version"]).trim();
  assert.ok(
    moonVersion.includes(manifest.devDependencies["@moonrepo/cli"]),
    `Expected pinned moon, received ${moonVersion}`,
  );
  assert.equal(
    pnpmVersion,
    manifest.packageManager.slice("pnpm@".length),
    "Expected pinned pnpm on PATH",
  );
  prepareTransitiveOverride(root);
  install(root);

  command(root, "git", ["init", "--initial-branch=main"]);
  assert.equal(
    realpathSync(command(root, "git", ["rev-parse", "--show-toplevel"]).trim()),
    realpathSync(root),
  );
  command(root, "git", ["add", "--all"]);
  command(root, "git", [
    "-c",
    "user.name=Dependency scenario verifier",
    "-c",
    "user.email=dependency-verifier@example.invalid",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "commit.gpgSign=false",
    "commit",
    "--no-verify",
    "-m",
    "Disposable dependency verification baseline",
  ]);

  const sourceFile = "packages/numbers/src/index.ts";
  const restoredFiles = [
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "package.json",
    ...Object.values(projects).map((directory) => `${directory}/package.json`),
    sourceFile,
  ];
  const baselineFiles = new Map(
    restoredFiles.map((path) => [path, readFileSync(join(root, path))]),
  );
  const baselineLock = readLock(root);
  const baselineBoot = canonical(baselineLock.boot);
  const baselineProject = canonical(baselineLock.project);
  const baselineInstalled = {
    numbers: installedVersion(root, projects.numbers, "is-odd"),
    numbersTransitive: installedVersion(root, projects.numbers, "is-number", "is-odd"),
    legacy: installedVersion(root, projects["legacy-numbers"], "is-odd"),
    legacyTransitive: installedVersion(root, projects["legacy-numbers"], "is-number", "is-odd"),
  };
  assert.equal(baselineInstalled.numbersTransitive, "6.0.0");
  assert.equal(baselineInstalled.legacyTransitive, "4.0.0");
  const baselineRun = nativeBuild(root);
  assert.deepEqual(
    baselineRun.targets,
    allTargets,
    "Fresh native baseline did not select all six builds",
  );
  assert.deepEqual(baselineRun.run, allTargets, "Fresh scratch baseline must execute real builds");
  const baselineHashes = hashes(root);
  const baselineCached = nativeBuild(root);
  assertCached(baselineCached, allTargets, "Second baseline run");
  assert.deepEqual(hashes(root), baselineHashes, "Repeated baseline changed native hashes");
  const toolingTargets = [":test", "root:test-extension", ":lint", ":format-check"];
  command(root, "moon", ["run", ...toolingTargets, ...nativeOptions]);
  const evidence = {
    moonVersion,
    pnpmVersion,
    scratchOverride: { [transitiveOverride]: transitiveOverrideRange },
    toolingTargets,
    baseline: {
      run: baselineRun.run,
      cached: baselineCached.cached,
      hashes: baselineHashes,
      installed: baselineInstalled,
    },
    scenarios: [],
  };

  function restore() {
    for (const [path, bytes] of baselineFiles) writeFileSync(join(root, path), bytes);
  }

  async function scenario(
    name,
    expectedTargets,
    mutate,
    { sourceOnly = false, control = false } = {},
  ) {
    restore();
    install(root);
    const restored = nativeBuild(root);
    assertCached(restored, allTargets, `${name}: restored baseline`);
    assert.deepEqual(hashes(root), baselineHashes, `${name}: restored baseline hashes differ`);
    const mutation = await mutate();
    assert.deepEqual(
      canonical(readLock(root).boot),
      baselineBoot,
      `${name}: modified pnpm boot documents`,
    );
    install(root);
    let installed;
    if (mutation?.package) {
      installed = installedVersion(root, mutation.importer, mutation.package, mutation.via);
      assert.equal(
        installed,
        mutation.after,
        `${name}: installed dependency does not match the changed lockfile`,
      );
      if (mutation.unchangedLegacyVersion) {
        assert.equal(
          installedVersion(root, projects["legacy-numbers"], "is-number", "is-odd"),
          mutation.unchangedLegacyVersion,
          `${name}: changed legacy's installed dependency`,
        );
      }
    }
    const projection = adapter(root, true);
    assert.ok(
      Array.isArray(projection.files) && Array.isArray(projection.dependencyImporters),
      `${name}: invalid adapter dry-run JSON`,
    );
    if (sourceOnly) {
      assert.deepEqual(
        projection.dependencyImporters,
        [],
        `${name}: source edit must not claim a dependency change`,
      );
      assert.deepEqual(
        projection.files,
        [sourceFile],
        `${name}: source path was not forwarded unchanged`,
      );
    } else if (expectedTargets.length === 0) {
      assert.deepEqual(
        projection,
        { files: [], dependencyImporters: [] },
        `${name}: semantic lockfile no-op affected tasks`,
      );
    } else {
      const expectedImporters = expectedTargets.map((target) => projects[target.split(":")[0]]);
      if (expectedTargets.length === allTargets.length) expectedImporters.push(".");
      assert.deepEqual(
        projection.dependencyImporters,
        expectedImporters.sort(),
        `${name}: dependency importer projection differs`,
      );
    }

    const affected = adapter(root, false);
    assert.deepEqual(
      affected.targets,
      expectedTargets,
      `${name}: adapter selected the wrong native build targets`,
    );
    assert.deepEqual(
      affected.run,
      expectedTargets,
      `${name}: dependency/source changes used a stale cache`,
    );
    assert.deepEqual(affected.cached, [], `${name}: changed targets unexpectedly hit cache`);

    // An ordinary, unfiltered moon invocation must now hit every cache. This
    // independently catches broad fingerprint invalidation outside the adapter.
    const normal = nativeBuild(root);
    assertCached(normal, allTargets, `${name}: normal native run after affected run`);
    const currentHashes = hashes(root);
    const hashChangedTargets = allTargets.filter(
      (target) => currentHashes[target] !== baselineHashes[target],
    );
    assert.deepEqual(
      hashChangedTargets,
      expectedTargets,
      `${name}: native hashes invalidated the wrong projects`,
    );
    const entry = {
      scenario: name,
      ...mutation,
      ...(installed ? { installedVersion: installed } : {}),
      files: projection.files,
      dependencyImporters: projection.dependencyImporters,
      affectedTargets: affected.targets,
      run: affected.run,
      cached: affected.cached,
      normalCached: normal.cached,
      hashChangedTargets,
      hashes: Object.fromEntries(
        hashChangedTargets.map((target) => [target, currentHashes[target]]),
      ),
    };

    if (control) {
      const manifestPath = join(root, projects.numbers, "package.json");
      const changedManifest = readFileSync(manifestPath);
      writeFileSync(manifestPath, baselineFiles.get(`${projects.numbers}/package.json`));
      const rawFiles = command(root, "git", ["diff", "--name-only", "-z", "HEAD", "--"])
        .split("\0")
        .filter(Boolean)
        .sort();
      assert.deepEqual(
        rawFiles,
        ["pnpm-lock.yaml"],
        "Native control must contain only a lockfile change",
      );
      const nativeControl = executeMoon(
        root,
        "moon",
        [
          "run",
          ...allTargets,
          ...nativeOptions,
          "--affected",
          "--stdin",
          "--include-relations",
          "--downstream",
          "deep",
        ],
        JSON.stringify({ files: rawFiles }),
      );
      entry.nativeLockfileOnlyControl = {
        files: rawFiles,
        affectedTargets: nativeControl.targets,
        run: nativeControl.run,
        cached: nativeControl.cached,
        matchesExpectedBranch:
          JSON.stringify(nativeControl.targets) === JSON.stringify(expectedTargets),
        ...(nativeControl.noActionGraph ? { noActionGraph: true } : {}),
      };
      writeFileSync(manifestPath, changedManifest);
    }
    evidence.scenarios.push(entry);
  }

  await scenario(
    "direct-version-and-same-name-isolation",
    numberTargets,
    async () => {
      const before = dependency(
        readLock(root).project.importers[projects.numbers],
        "is-odd",
      ).version;
      command(root, "pnpm", [
        "--filter",
        "@example/numbers",
        "add",
        "is-odd@3.0.0",
        "--save-exact",
        ...isolatedInstallOptions,
      ]);
      const after = dependency(
        readLock(root).project.importers[projects.numbers],
        "is-odd",
      ).version;
      assert.notEqual(after, before, "pnpm did not update numbers' actual locked package version");
      assert.equal(after, "3.0.0");
      const changedManifest = JSON.parse(
        readFileSync(join(root, projects.numbers, "package.json"), "utf8"),
      );
      assert.equal(
        changedManifest.dependencies["is-odd"],
        "3.0.0",
        "Direct scenario must retain pnpm's manifest update",
      );
      return {
        package: "is-odd",
        importer: projects.numbers,
        before,
        after,
        generatedBy: "pnpm add with isolated install",
        excludes: ["legacy-numbers:build", ...colorTargets].sort(),
      };
    },
    { control: true },
  );

  await scenario("transitive-only-version", numberTargets, async () => {
    const lock = readLock(root);
    const odd = dependency(lock.project.importers[projects.numbers], "is-odd").version;
    const legacyOdd = dependency(
      lock.project.importers[projects["legacy-numbers"]],
      "is-odd",
    ).version;
    const oddSnapshot = snapshot(lock.project, "is-odd", odd).value;
    const legacySnapshot = snapshot(lock.project, "is-odd", legacyOdd).value;
    const before = oddSnapshot.dependencies["is-number"];
    const legacyReference = legacySnapshot.dependencies["is-number"];
    assert.notEqual(before, legacyReference, "Fixture must contain isolated is-number versions");
    const metadata = await registryPackage("is-number", "7.0.0");
    oddSnapshot.dependencies["is-number"] = addLeafVersion(
      lock.project,
      "is-number",
      before,
      metadata,
    );
    writeLock(root, lock);
    assert.equal(
      snapshot(readLock(root).project, "is-odd", legacyOdd).value.dependencies["is-number"],
      legacyReference,
    );
    return {
      package: "is-number",
      importer: projects.numbers,
      via: "is-odd",
      before,
      after: metadata.version,
      unchangedLegacyVersion: legacyReference,
      generatedBy:
        "registry metadata and lock snapshot edge update under stable scoped override, followed by frozen install",
    };
  });

  await scenario("other-dependency-branch", colorTargets, async () => {
    const before = dependency(
      readLock(root).project.importers[projects.colors],
      "picocolors",
    ).version;
    command(root, "pnpm", [
      "--filter",
      "@example/colors",
      "add",
      "picocolors@1.1.0",
      "--save-exact",
      ...isolatedInstallOptions,
    ]);
    const after = dependency(
      readLock(root).project.importers[projects.colors],
      "picocolors",
    ).version;
    assert.equal(after, "1.1.0");
    assert.notEqual(after, before);
    return {
      package: "picocolors",
      importer: projects.colors,
      before,
      after,
      generatedBy: "pnpm add with isolated install",
    };
  });

  await scenario("semantic-no-op-reorder", [], async () => {
    const lock = readLock(root);
    lock.project = reversedKeys(lock.project);
    writeLock(root, lock);
    assert.deepEqual(canonical(readLock(root).project), baselineProject);
    assert.notEqual(
      readFileSync(join(root, "pnpm-lock.yaml"), "utf8"),
      baselineFiles.get("pnpm-lock.yaml").toString(),
      "No-op scenario must change lockfile text",
    );
    return { mutation: "Reordered YAML mapping keys without changing any parsed value" };
  });

  await scenario("shared-root-tooling", allTargets, async () => {
    const before = dependency(readLock(root).project.importers["."], "yaml").version;
    command(root, "pnpm", [
      "add",
      "--workspace-root",
      "--save-dev",
      "yaml@2.8.1",
      "--save-exact",
      ...isolatedInstallOptions,
    ]);
    const after = dependency(readLock(root).project.importers["."], "yaml").version;
    assert.equal(after, "2.8.1");
    assert.notEqual(after, before);
    return {
      package: "yaml",
      importer: ".",
      before,
      after,
      generatedBy: "pnpm add with isolated install",
    };
  });

  await scenario(
    "source-only-with-consumers",
    numberTargets,
    async () => {
      writeFileSync(
        join(root, sourceFile),
        `${baselineFiles.get(sourceFile).toString()}\n// Scratch-only source change for native affected verification.\n`,
      );
      return { mutation: sourceFile };
    },
    { sourceOnly: true },
  );

  restore();
  return evidence;
}

const temporary = mkdtempSync(join(tmpdir(), "moon-pnpm-deps-verify-"));
try {
  const evidence = await verify(join(temporary, "workspace"));
  console.log(JSON.stringify(evidence));
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
