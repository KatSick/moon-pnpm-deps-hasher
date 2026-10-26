import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
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
const projectTaskIds = ["build", "test", "lint", "format-check"];
const allProjectTargets = Object.keys(projects)
  .flatMap((project) => projectTaskIds.map((task) => `${project}:${task}`))
  .sort();
const rootTargets = [
  "root:deps-update",
  "root:deps-check",
  "root:verify-deps",
  "root:test-extension",
  "root:typecheck",
];
const generatedPaths = [".", ...Object.values(projects)]
  .map((importer) => join(importer, ".moon-deps.json"))
  .sort();
const nativeOptions = ["--output-style", "buffer-only-failure"];
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

// Keep every Git, moon, and CI operation inside the disposable fixture. In
// particular, never inherit the caller's index, remote revisions, or hooks.
for (const key of Object.keys(environment)) {
  if (
    /^(GIT_|MOON_|GITHUB_|GITLAB_|BUILDKITE_|CIRCLE_|TRAVIS_|BITBUCKET_|JENKINS_)/.test(key) ||
    [
      "CI",
      "CONTINUOUS_INTEGRATION",
      "BUILD_NUMBER",
      "RUN_ID",
      "TF_BUILD",
      "TEAMCITY_VERSION",
    ].includes(key)
  ) {
    delete environment[key];
  }
}
environment.GIT_CONFIG_GLOBAL = "/dev/null";
environment.GIT_CONFIG_SYSTEM = "/dev/null";
environment.GIT_CONFIG_NOSYSTEM = "1";

function invoke(root, executable, args, { input, env = {} } = {}) {
  const result = spawnSync(executable, args, {
    cwd: root,
    env: {
      ...environment,
      PATH: `${join(root, "node_modules/.bin")}${delimiter}${environment.PATH ?? ""}`,
      ...env,
    },
    input,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 300_000,
  });

  if (result.error) {
    throw new Error(`${executable} ${args.join(" ")} could not start: ${result.error.message}`);
  }

  return result;
}

function requireSuccess(result, executable, args) {
  if (result.status !== 0) {
    throw new Error(
      `${executable} ${args.join(" ")} failed${result.signal ? ` (${result.signal})` : ""}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }

  return result.stdout;
}

function command(root, executable, args, options) {
  return requireSuccess(invoke(root, executable, args, options), executable, args);
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
        !(parts[0] === ".moon" && ["cache", "hooks"].includes(parts[1]))
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

// moon 2.6 uses the same action schema for ciReport.json and runReport.json.
// Task hashes live separately in states/<project>/<task>/lastRun.json.
function readReport(root, kind) {
  const path = `.moon/cache/${kind}Report.json`;
  const result = {
    path,
    actions: [],
    tasks: [],
    targets: [],
    run: [],
    cached: [],
    skipped: [],
    failed: [],
  };
  if (!existsSync(join(root, path))) return { ...result, noActionGraph: true };

  const report = JSON.parse(readFileSync(join(root, path), "utf8"));
  assert.equal(typeof report.status, "string", "Unsupported moon pipeline-status schema");
  assert.ok(Array.isArray(report.actions), "Unsupported moon action-report schema");
  result.status = report.status;
  const seen = new Set();

  for (const action of report.actions) {
    if (action.node?.action !== "run-task") continue;
    const target = action.node.params?.target;
    assert.equal(typeof target, "string", "Unsupported moon task-target report schema");
    assert.ok(
      allProjectTargets.includes(target) || rootTargets.includes(target),
      `Unexpected native task ${target}`,
    );
    assert.ok(!seen.has(target), `Duplicate native task ${target}`);
    seen.add(target);
    result.actions.push({ target, status: action.status });
    if (action.status === "passed") result.run.push(target);
    else if (cacheStatuses.has(action.status)) result.cached.push(target);
    else if (action.status === "skipped") result.skipped.push(target);
    else result.failed.push(target);
  }

  result.actions.sort((left, right) => left.target.localeCompare(right.target));
  for (const field of ["run", "cached", "skipped", "failed"]) result[field].sort();
  result.tasks = result.actions.map((action) => action.target).sort();
  result.targets = [...result.run, ...result.cached].sort();
  return result;
}

function moon(root, args, options) {
  const kind = args[0] === "ci" ? "ci" : "run";
  rmSync(join(root, `.moon/cache/${kind}Report.json`), { force: true });
  const result = invoke(root, "moon", args, options);
  return {
    command: ["moon", ...args],
    exitCode: result.status,
    signal: result.signal,
    ...readReport(root, kind),
    ...(result.status === 0 ? {} : { stdout: result.stdout, stderr: result.stderr }),
  };
}

function assertSucceeded(result, label) {
  assert.equal(
    result.exitCode,
    0,
    `${label}: command failed\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  );
  if (!result.noActionGraph) {
    assert.equal(result.status, "completed", `${label}: native pipeline did not complete`);
  }
  assert.deepEqual(result.failed, [], `${label}: native task failed`);
}

function assertRejected(result, label) {
  assert.equal(typeof result.exitCode, "number", `${label}: command did not exit normally`);
  assert.notEqual(result.exitCode, 0, `${label}: stale inputs were accepted`);
  assert.equal(result.signal, null, `${label}: command was terminated instead of rejecting inputs`);
}

function job(root, id, passthrough = []) {
  return moon(root, [
    ...(id === "deps-update" ? ["exec", "--ci=false"] : ["run"]),
    `root:${id}`,
    ...nativeOptions,
    "--no-actions",
    ...(passthrough.length ? ["--", ...passthrough] : []),
  ]);
}

function nativeBuild(root) {
  return moon(root, ["run", ...allTargets, ...nativeOptions, "--no-actions"]);
}

function nativeCI(root, base, head, normalActions = false) {
  return moon(
    root,
    [
      "ci",
      "--include-relations",
      "--downstream",
      "deep",
      "--base",
      base,
      "--head",
      head,
      ...nativeOptions,
      ...(normalActions ? [] : ["--no-actions"]),
    ],
    { env: { CI: "true" } },
  );
}

function queryTasks(root, files) {
  const args = ["query", "tasks", "--affected", "--downstream", "deep"];
  const query = JSON.parse(
    command(root, "moon", args, {
      input: JSON.stringify({ files }),
      env: { CI: "true" },
    }),
  );
  assert.ok(query.tasks && typeof query.tasks === "object", "Unsupported native task-query schema");
  const targets = [];
  for (const [project, tasks] of Object.entries(query.tasks)) {
    assert.ok(tasks && typeof tasks === "object", `Invalid queried tasks for ${project}`);
    for (const id of Object.keys(tasks)) targets.push(`${project}:${id}`);
  }
  return { command: ["moon", ...args], files, targets: targets.sort() };
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
  assertSucceeded(result, label);
  assert.deepEqual(result.tasks, targets, `${label}: native task selection differs`);
  assert.deepEqual(result.run, [], `${label}: unexpected cache miss`);
  assert.deepEqual(result.cached, targets, `${label}: every task must be cached`);
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

function inputState(root, paths = ["pnpm-lock.yaml", ...generatedPaths]) {
  return Object.fromEntries(
    paths.map((path) => {
      const absolute = join(root, path);
      return [
        path,
        existsSync(absolute)
          ? {
              text: readFileSync(absolute, "utf8"),
              modifiedNs: statSync(absolute, { bigint: true }).mtimeNs.toString(),
            }
          : null,
      ];
    }),
  );
}

function generatedContents(root) {
  return Object.fromEntries(
    generatedPaths.map((path) => [path, readFileSync(join(root, path), "utf8")]),
  );
}

function rawDiff(root, base, head) {
  return command(root, "git", ["diff", "--name-only", "-z", base, head, "--"])
    .split("\0")
    .filter(Boolean)
    .sort();
}

function commit(root, message, hooks = false) {
  command(root, "git", [
    ...(hooks ? [] : ["-c", "core.hooksPath=/dev/null"]),
    "commit",
    "-m",
    message,
  ]);
  return command(root, "git", ["rev-parse", "HEAD"]).trim();
}

function disableRecursiveVerification(root) {
  const path = join(root, "moon.yml");
  const documents = parseAllDocuments(readFileSync(path, "utf8"));
  assert.equal(documents.length, 1, "Expected one root moon configuration document");
  const document = documents[0];
  assert.equal(document.errors.length, 0, document.errors.map((error) => error.message).join("\n"));
  const option = ["tasks", "verify-deps", "options", "runInCI"];
  assert.equal(document.getIn(option), "always", "The real E2E job must be mandatory in CI");
  assert.equal(
    document.getIn(["tasks", "deps-check", "options", "runInCI"]),
    "always",
    "The fixture must retain the mandatory native checker",
  );
  document.setIn(option, false);
  writeFileSync(path, document.toString());
}

function changeTransitive(root, metadata) {
  const lock = readLock(root);
  const importerBefore = canonical(lock.project.importers);
  const odd = dependency(lock.project.importers[projects.numbers], "is-odd").version;
  const legacyOdd = dependency(
    lock.project.importers[projects["legacy-numbers"]],
    "is-odd",
  ).version;
  const oddSnapshot = snapshot(lock.project, "is-odd", odd).value;
  const legacyReference = snapshot(lock.project, "is-odd", legacyOdd).value.dependencies[
    "is-number"
  ];
  const before = oddSnapshot.dependencies["is-number"];
  assert.equal(before, "6.0.0");
  assert.equal(legacyReference, "4.0.0");
  oddSnapshot.dependencies["is-number"] = addLeafVersion(
    lock.project,
    "is-number",
    before,
    metadata,
  );
  writeLock(root, lock);
  assert.deepEqual(canonical(readLock(root).project.importers), importerBefore);
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
}

function expectedTasks(buildTargets, { sourceOnly = false, tooling = false } = {}) {
  const targets = buildTargets.flatMap((target) => {
    const project = target.split(":")[0];
    const ids = sourceOnly && project !== "numbers" ? ["build", "test"] : projectTaskIds;
    return ids.map((id) => `${project}:${id}`);
  });
  targets.push("root:deps-check");
  if (buildTargets.length) targets.push("root:typecheck");
  if (tooling) targets.push("root:test-extension");
  return targets.sort();
}

async function verify(root, evidence) {
  copySources(root);
  disableRecursiveVerification(root);
  prepareTransitiveOverride(root);
  command(root, "git", ["init", "--initial-branch=main"]);
  command(root, "git", ["config", "--local", "user.name", "Dependency scenario verifier"]);
  command(root, "git", ["config", "--local", "user.email", "dependency-verifier@example.invalid"]);
  command(root, "git", ["config", "--local", "commit.gpgSign", "false"]);
  command(root, "git", [
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--allow-empty",
    "-m",
    "Initialize disposable native moon history",
  ]);
  assert.equal(
    realpathSync(command(root, "git", ["rev-parse", "--show-toplevel"]).trim()),
    realpathSync(root),
  );
  assert.equal(command(root, "git", ["rev-parse", "--is-shallow-repository"]).trim(), "false");

  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  evidence.moonVersion = command(root, "moon", ["--version"]).trim();
  evidence.pnpmVersion = command(root, "pnpm", ["--version"]).trim();
  assert.ok(
    evidence.moonVersion.includes(manifest.devDependencies["@moonrepo/cli"]),
    `Expected pinned moon, received ${evidence.moonVersion}`,
  );
  assert.equal(
    evidence.pnpmVersion,
    manifest.packageManager.slice("pnpm@".length),
    "Expected pinned pnpm on PATH",
  );
  evidence.scratchOverride = { [transitiveOverride]: transitiveOverrideRange };
  install(root);

  assert.deepEqual(
    Object.keys(readLock(root).project.importers).sort(),
    [".", ...Object.values(projects)].sort(),
    "The fixture importer map differs from its project tasks",
  );
  for (const path of generatedPaths) rmSync(join(root, path), { force: true });
  let beforeCheck = inputState(root);
  evidence.checks.missing = job(root, "deps-check");
  assertRejected(evidence.checks.missing, "Native missing-input check");
  assert.deepEqual(inputState(root), beforeCheck, "The missing-input check wrote to its inputs");
  evidence.checks.bootstrap = job(root, "deps-update");
  assertSucceeded(evidence.checks.bootstrap, "Native snapshot bootstrap");
  for (const importer of [".", ...Object.values(projects)]) {
    const path = join(root, importer, ".moon-deps.json");
    const text = readFileSync(path, "utf8");
    const value = JSON.parse(text);
    assert.equal(value.version, 1);
    assert.equal(value.importer, importer);
    assert.match(value.hash, /^[a-f0-9]{64}$/);
    assert.equal(text, `${JSON.stringify(value, null, 2)}\n`, `Unstable generated JSON at ${path}`);
  }
  const freshContents = generatedContents(root);
  const stalePath = join(root, projects.numbers, ".moon-deps.json");
  const stale = JSON.parse(readFileSync(stalePath, "utf8"));
  stale.hash = "0".repeat(64);
  writeFileSync(stalePath, `${JSON.stringify(stale, null, 2)}\n`);
  beforeCheck = inputState(root);
  evidence.checks.stale = job(root, "deps-check");
  assertRejected(evidence.checks.stale, "Native stale-input check");
  assert.deepEqual(inputState(root), beforeCheck, "The stale-input check wrote to its inputs");
  evidence.checks.repair = job(root, "deps-update");
  assertSucceeded(evidence.checks.repair, "Native stale-input update");
  assert.deepEqual(
    generatedContents(root),
    freshContents,
    "Native update did not repair the snapshot",
  );
  beforeCheck = inputState(root);
  evidence.checks.fresh = job(root, "deps-check");
  assertSucceeded(evidence.checks.fresh, "Native fresh-input check");
  assert.deepEqual(inputState(root), beforeCheck, "The fresh-input check wrote to its inputs");
  evidence.checks.idempotent = job(root, "deps-update");
  assertSucceeded(evidence.checks.idempotent, "Native unchanged-input update");
  assert.deepEqual(
    inputState(root),
    beforeCheck,
    "Native update rewrote unchanged generated bytes",
  );

  command(root, "moon", ["sync", "vcs-hooks"]);
  const hook = resolve(
    root,
    command(root, "git", ["rev-parse", "--git-path", "hooks/pre-commit"]).trim(),
  );
  assert.ok(existsSync(hook), `Native pre-commit hook was not installed at ${hook}`);
  const hookFromRoot = relative(realpathSync(root), realpathSync(hook));
  assert.ok(
    !isAbsolute(hookFromRoot) && hookFromRoot !== ".." && !hookFromRoot.startsWith(`..${sep}`),
    "Native pre-commit hook resolves outside the disposable fixture",
  );
  command(root, "git", ["add", "--all"]);
  const base = commit(root, "Disposable native dependency-input baseline");
  const baselineFiles = new Map(
    [
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "package.json",
      ...Object.values(projects).map((directory) => `${directory}/package.json`),
      "packages/numbers/src/index.ts",
    ].map((path) => [path, readFileSync(join(root, path))]),
  );
  const baselineLock = readLock(root);
  const baselineBoot = canonical(baselineLock.boot);
  const baselineProject = canonical(baselineLock.project);
  const baselineContents = generatedContents(root);
  const baselineInstalled = {
    numbers: installedVersion(root, projects.numbers, "is-odd"),
    numbersTransitive: installedVersion(root, projects.numbers, "is-number", "is-odd"),
    legacy: installedVersion(root, projects["legacy-numbers"], "is-odd"),
    legacyTransitive: installedVersion(root, projects["legacy-numbers"], "is-number", "is-odd"),
  };
  assert.equal(baselineInstalled.numbers, "3.0.1");
  assert.equal(baselineInstalled.numbersTransitive, "6.0.0");
  assert.equal(baselineInstalled.legacyTransitive, "4.0.0");
  const baselineRun = nativeBuild(root);
  evidence.baseline = { base, installed: baselineInstalled, run: baselineRun };
  assertSucceeded(baselineRun, "Native baseline builds");
  assert.deepEqual(
    baselineRun.run,
    allTargets,
    "Fresh scratch baseline must execute all six builds",
  );
  const baselineHashes = hashes(root);
  evidence.baseline.hashes = baselineHashes;
  const baselineCached = nativeBuild(root);
  evidence.baseline.warm = baselineCached;
  assertCached(baselineCached, allTargets, "Second native baseline run");
  assert.deepEqual(hashes(root), baselineHashes, "Repeated baseline changed native hashes");

  const transitiveMetadata = await registryPackage("is-number", "7.0.0");
  command(root, "git", ["switch", "--create", "verify-staged-hook", base]);
  changeTransitive(root, transitiveMetadata);
  command(root, "git", ["add", "--", "pnpm-lock.yaml"]);
  const stagedBefore = command(root, "git", ["show", `:${projects.numbers}/.moon-deps.json`]);
  evidence.hook = { path: hookFromRoot, freshWorktree: job(root, "deps-update") };
  assertSucceeded(evidence.hook.freshWorktree, "Fresh worktree update before staged hook");
  assert.equal(
    command(root, "git", ["show", `:${projects.numbers}/.moon-deps.json`]),
    stagedBefore,
    "Native update unexpectedly staged generated inputs",
  );
  assert.notEqual(
    readFileSync(join(root, projects.numbers, ".moon-deps.json"), "utf8"),
    stagedBefore,
    "Hook fixture needs fresh unstaged generated inputs",
  );
  evidence.hook.worktreeCheck = job(root, "deps-check");
  assertSucceeded(evidence.hook.worktreeCheck, "Fresh unstaged worktree check");
  evidence.hook.stagedCheck = job(root, "deps-check", ["--staged"]);
  assertRejected(evidence.hook.stagedCheck, "Stale index with a fresh worktree");
  const rejectedHook = invoke(root, hook, []);
  evidence.hook.rejected = {
    exitCode: rejectedHook.status,
    signal: rejectedHook.signal,
    stdout: rejectedHook.stdout,
    stderr: rejectedHook.stderr,
  };
  assertRejected(evidence.hook.rejected, "Installed native pre-commit hook");
  command(root, "git", ["add", "--", "pnpm-lock.yaml", ...generatedPaths]);
  evidence.hook.consistentStage = job(root, "deps-check", ["--staged"]);
  assertSucceeded(evidence.hook.consistentStage, "Consistent staged inputs");
  evidence.hook.commit = commit(root, "Exercise the actual native pre-commit hook", true);
  assert.equal(command(root, "git", ["rev-parse", "HEAD^"]).trim(), base);

  command(root, "git", ["switch", "--create", "verify-mandatory-native-ci", base]);
  changeTransitive(root, transitiveMetadata);
  command(root, "git", ["add", "--", "pnpm-lock.yaml"]);
  const staleHead = commit(root, "Intentionally stale dependency inputs for native CI rejection");
  const staleFiles = rawDiff(root, base, staleHead);
  assert.deepEqual(staleFiles, ["pnpm-lock.yaml"]);
  evidence.mandatoryCI = {
    files: staleFiles,
    query: queryTasks(root, staleFiles),
  };
  assert.deepEqual(
    evidence.mandatoryCI.query.targets,
    ["root:deps-check"],
    "Stale lock-only fixture must omit every project task before native CI",
  );
  rmSync(join(root, ".moon/cache"), { recursive: true, force: true });
  evidence.mandatoryCI.ci = nativeCI(root, base, staleHead);
  assertRejected(evidence.mandatoryCI.ci, "Mandatory native CI freshness check");
  assert.deepEqual(
    evidence.mandatoryCI.ci.tasks,
    ["root:deps-check"],
    "Stale native CI unexpectedly selected project tasks",
  );
  assert.deepEqual(evidence.mandatoryCI.ci.failed, ["root:deps-check"]);

  const sourceFile = "packages/numbers/src/index.ts";
  async function scenario(name, buildTargets, mutate, options = {}) {
    command(root, "git", ["switch", "--create", `verify-${name}`, base]);
    install(root);
    const restored = nativeBuild(root);
    assertSucceeded(restored, `${name}: restored baseline builds`);
    assert.deepEqual(hashes(root), baselineHashes, `${name}: restored baseline hashes differ`);
    const entry = { scenario: name };
    evidence.scenarios.push(entry);
    entry.mutation = await mutate();
    assert.deepEqual(
      canonical(readLock(root).boot),
      baselineBoot,
      `${name}: modified pnpm boot documents`,
    );
    install(root);
    if (entry.mutation.package) {
      const mutation = entry.mutation;
      entry.installedVersion = installedVersion(
        root,
        mutation.importer,
        mutation.package,
        mutation.via,
      );
      assert.equal(entry.installedVersion, mutation.after, `${name}: wrong installed dependency`);
      if (mutation.unchangedLegacyVersion) {
        assert.equal(
          installedVersion(root, projects["legacy-numbers"], "is-number", "is-odd"),
          mutation.unchangedLegacyVersion,
          `${name}: changed legacy's installed dependency`,
        );
      }
    }

    entry.update = job(root, "deps-update");
    assertSucceeded(entry.update, `${name}: native dependency-input update`);
    entry.check = job(root, "deps-check");
    assertSucceeded(entry.check, `${name}: native dependency-input check`);
    const contents = generatedContents(root);
    entry.changedGeneratedInputs = generatedPaths.filter(
      (path) => contents[path] !== baselineContents[path],
    );
    const expectedGenerated = buildTargets
      .filter(() => !options.sourceOnly)
      .map((target) => join(projects[target.split(":")[0]], ".moon-deps.json"));
    if (options.tooling) expectedGenerated.push(".moon-deps.json");
    assert.deepEqual(
      entry.changedGeneratedInputs,
      expectedGenerated.sort(),
      `${name}: native update changed the wrong importer inputs`,
    );
    command(root, "git", ["add", "--all"]);
    entry.head = commit(root, `Native dependency-input scenario: ${name}`);
    entry.files = rawDiff(root, base, entry.head);
    if (options.sourceOnly) assert.deepEqual(entry.files, [sourceFile]);
    if (!buildTargets.length) assert.deepEqual(entry.files, ["pnpm-lock.yaml"]);
    const expected = expectedTasks(buildTargets, options);
    entry.query = queryTasks(root, entry.files);
    assert.deepEqual(entry.query.targets, expected, `${name}: native affected task query differs`);

    // Selection must be correct with no local task hashes, reports, or outputs
    // cache. Keep this distinct from the subsequent ordinary-run hash checks.
    rmSync(join(root, ".moon/cache"), { recursive: true, force: true });
    entry.coldCI = nativeCI(root, base, entry.head, options.normalActions);
    assertSucceeded(entry.coldCI, `${name}: cold native CI`);
    assert.deepEqual(entry.coldCI.tasks, expected, `${name}: cold native CI selected wrong tasks`);
    assert.deepEqual(
      entry.coldCI.run,
      expected,
      `${name}: cold native CI did not execute selected tasks`,
    );
    assert.deepEqual(
      entry.coldCI.cached,
      [],
      `${name}: cold native CI unexpectedly reused a cache`,
    );
    assert.deepEqual(entry.coldCI.skipped, [], `${name}: cold native CI skipped selected tasks`);

    // Run all builds normally, then repeat them. A cold CI deliberately has no
    // cache for unrelated builds, so only this second ordinary run must be warm.
    entry.normal = nativeBuild(root);
    assertSucceeded(entry.normal, `${name}: ordinary native build`);
    assert.deepEqual(entry.normal.tasks, allTargets, `${name}: ordinary build scope differs`);
    const currentHashes = hashes(root);
    entry.hashChangedTargets = allTargets.filter(
      (target) => currentHashes[target] !== baselineHashes[target],
    );
    assert.deepEqual(
      entry.hashChangedTargets,
      buildTargets,
      `${name}: native build hashes invalidated the wrong projects`,
    );
    entry.hashes = currentHashes;
    entry.warm = nativeBuild(root);
    assertCached(entry.warm, allTargets, `${name}: repeated ordinary native build`);
    assert.deepEqual(hashes(root), currentHashes, `${name}: warm native build changed hashes`);

    // Explicitly disable downstream expansion for this build-only request.
    // Dependency updates select consumers through their own changed inputs;
    // source propagation (including consumer tests) is proven by native CI.
    entry.affectedBuild = moon(
      root,
      [
        "run",
        ":build",
        "--affected",
        "--stdin",
        "--downstream",
        "none",
        ...nativeOptions,
        "--no-actions",
      ],
      { input: JSON.stringify({ files: entry.files }) },
    );
    assertCached(
      entry.affectedBuild,
      options.sourceOnly ? ["numbers:build"] : buildTargets,
      `${name}: native requested build-only scope`,
    );
    entry.status = "passed";
  }

  await scenario(
    "direct-version-and-same-name-isolation",
    numberTargets,
    async () => {
      const before = dependency(
        readLock(root).project.importers[projects.numbers],
        "is-odd",
      ).version;
      assert.equal(before, "3.0.1");
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
      assert.equal(after, "3.0.0");
      const changedManifest = JSON.parse(
        readFileSync(join(root, projects.numbers, "package.json"), "utf8"),
      );
      assert.equal(changedManifest.dependencies["is-odd"], "3.0.0");
      assert.equal(
        installedVersion(root, projects["legacy-numbers"], "is-odd"),
        baselineInstalled.legacy,
        "Direct dependency update changed legacy's same-name package",
      );
      return {
        package: "is-odd",
        importer: projects.numbers,
        before,
        after,
        generatedBy: "pnpm add with isolated install",
      };
    },
    { normalActions: true },
  );

  await scenario("transitive-only-version", numberTargets, async () =>
    changeTransitive(root, transitiveMetadata),
  );

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

  await scenario(
    "shared-root-tooling",
    allTargets,
    async () => {
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
    },
    { tooling: true },
  );

  await scenario(
    "source-only-with-consumers",
    numberTargets,
    async () => {
      const original = baselineFiles.get(sourceFile).toString();
      writeFileSync(join(root, sourceFile), `${original}\n// Native source-input verification.\n`);
      return {
        mutation: sourceFile,
        semantics: "Equivalent parity classification; consumer tests execute in CI",
      };
    },
    { sourceOnly: true },
  );
}

function reportArgument(args) {
  if (args.length === 0) return null;
  if (args.length === 2 && args[0] === "--report" && args[1]) return resolve(args[1]);
  throw new Error("Usage: node tools/pnpm-deps/verify.mjs [--report <path>]");
}

const evidence = { version: 1, status: "running", checks: {}, scenarios: [] };
let temporary;
let reportPath;
try {
  reportPath = reportArgument(process.argv.slice(2));
  temporary = mkdtempSync(join(tmpdir(), "moon-pnpm-deps-verify-"));
  await verify(join(temporary, "workspace"), evidence);
  evidence.status = "passed";
} catch (error) {
  evidence.status = "failed";
  evidence.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(evidence.error);
  process.exitCode = 1;
} finally {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
  if (reportPath) {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(evidence, null, 2)}\n`);
  }
  console.log(JSON.stringify(evidence));
}
