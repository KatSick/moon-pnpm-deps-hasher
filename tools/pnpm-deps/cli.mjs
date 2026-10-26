#!/usr/bin/env node

import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { delimiter, dirname, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";
import { changedImporters, projectSnapshot } from "./lock-graph.mjs";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const lockfilePath = "pnpm-lock.yaml";
const usage = `Usage:
  pnpm-deps fingerprint [--project <importer>]
  pnpm-deps affected --base <ref> [--head <ref>] [--dry-run] -- <targets...> [execution options] [-- <task args...>]

fingerprint uses the current task directory, or a workspace-relative --project.
affected includes the working tree and nonignored untracked files by default.
--head compares commits; execution requires that head is the clean checked-out HEAD.
Use --dry-run to plan against any head without executing tasks.

Targets: :task, project:task, or '#tag:task', expanded by moon.
Targets must be contiguous, before execution options. Default-project, ~, task-tag,
and glob selectors are not supported.

Supported execution options:
  --force/-f, --interactive/-i, --no-actions
  --output-style <style>, --job <index>, --job-total <total>, --summary/-s [level]
Value-taking options also accept =value. A second -- forwards all remaining task
arguments verbatim; selection-looking arguments after it are task arguments.

Affected selection is managed by this adapter. After the first --, do not pass:
  --affected, --base, --head, --status, --stdin, --include-relations/-g
  --upstream/--dependencies, --downstream/--dependents
--query and --plan/-p are not supported.
`;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return JSON.stringify(value);
  }
  throw new Error("Lockfile snapshots must contain only JSON-compatible values.");
}

export function parseLockfile(text, label = lockfilePath) {
  const documents = parseAllDocuments(text);
  for (const document of documents) {
    if (document.errors.length > 0) {
      throw new Error(`Cannot parse ${label}: ${document.errors[0].message}`);
    }
  }
  const values = documents.map((document) => document.toJS());
  const lockfile = values.at(-1);
  if (!isObject(lockfile) || !isObject(lockfile.importers)) {
    throw new Error(`${label} must end with a pnpm project lockfile containing importers.`);
  }
  return { lockfile, bootDocuments: values.slice(0, -1) };
}

function readCurrentLock(root) {
  try {
    return parseLockfile(readFileSync(resolve(root, lockfilePath), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function importerId(root, path) {
  const importer = relative(root, resolve(root, path)).split(sep).join("/");
  if (importer === ".." || importer.startsWith("../")) {
    throw new Error(`Project must be inside the workspace: ${path}`);
  }
  return importer || ".";
}

function rootSnapshot(state) {
  return Object.hasOwn(state.lockfile.importers, ".") ? projectSnapshot(state.lockfile, ".") : null;
}

export function fingerprint({ root = workspaceRoot, project, cwd = process.cwd() } = {}) {
  const state = readCurrentLock(root);
  if (!state) {
    throw new Error(`Cannot fingerprint without ${resolve(root, lockfilePath)}.`);
  }
  const projectId = importerId(root, project ?? cwd);
  const snapshot = {
    project: projectSnapshot(state.lockfile, projectId),
    rootTooling: rootSnapshot(state),
    bootDocuments: state.bootDocuments,
  };
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}

function existingPackagePath(root, importer) {
  const normalized = importerId(root, importer);
  const path = normalized === "." ? "package.json" : `${normalized}/package.json`;
  try {
    return statSync(resolve(root, path)).isFile() ? path : null;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      return null;
    }
    throw error;
  }
}

export function projectAffectedFiles({ files, before, after, root = workspaceRoot }) {
  const projected = new Set(files);
  const lockChanged = projected.delete(lockfilePath);
  if (!lockChanged && before && after) {
    return { files: [...projected].sort(), dependencyImporters: [] };
  }

  const rootChanged =
    !before ||
    !after ||
    canonicalJson(before.bootDocuments) !== canonicalJson(after.bootDocuments) ||
    canonicalJson(rootSnapshot(before)) !== canonicalJson(rootSnapshot(after));
  // Root package.json is an implicit input for all tasks, including when pnpm's
  // project document omits the root importer and puts tooling in a boot document.
  const dependencyImporters = rootChanged
    ? [
        ...new Set([
          ".",
          ...Object.keys(before?.lockfile.importers ?? {}),
          ...Object.keys(after?.lockfile.importers ?? {}),
        ]),
      ].sort()
    : changedImporters(before.lockfile, after.lockfile);

  for (const importer of dependencyImporters) {
    const path = existingPackagePath(root, importer);
    if (path) {
      projected.add(path);
    }
  }
  return { files: [...projected].sort(), dependencyImporters };
}

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
  }
  return result.stdout;
}

function resolveRevision(root, revision) {
  return git(root, ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`]).trim();
}

function nulPaths(output) {
  return output.split("\0").filter((path) => path.length > 0);
}

function workingTreeFiles(root, base) {
  return [
    ...nulPaths(
      git(root, ["diff", "--no-ext-diff", "--name-only", "--no-renames", "-z", base, "--"]),
    ),
    ...nulPaths(git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--"])),
  ];
}

function readRevisionLock(root, revision) {
  const present = git(root, ["ls-tree", "--name-only", "-z", revision, "--", lockfilePath]);
  if (!present) {
    return null;
  }
  return parseLockfile(
    git(root, ["show", `${revision}:${lockfilePath}`]),
    `${revision}:${lockfilePath}`,
  );
}

export function collectAffected({ root = workspaceRoot, base, head } = {}) {
  if (!base) {
    throw new Error("affected requires --base <ref>.");
  }
  const baseCommit = resolveRevision(root, base);
  const headCommit = head === undefined ? null : resolveRevision(root, head);
  const files = headCommit
    ? nulPaths(
        git(root, [
          "diff",
          "--no-ext-diff",
          "--name-only",
          "--no-renames",
          "-z",
          baseCommit,
          headCommit,
          "--",
        ]),
      )
    : workingTreeFiles(root, baseCommit);
  return projectAffectedFiles({
    root,
    files,
    before: readRevisionLock(root, baseCommit),
    after: headCommit ? readRevisionLock(root, headCommit) : readCurrentLock(root),
  });
}

function assertExecutionHead(root, head) {
  if (resolveRevision(root, head) !== resolveRevision(root, "HEAD")) {
    throw new Error(
      "--head execution must use checked-out HEAD; use --dry-run for historical comparisons.",
    );
  }
  if (workingTreeFiles(root, "HEAD").length > 0) {
    throw new Error(
      "--head execution requires a clean working tree; omit --head or use --dry-run.",
    );
  }
}

function optionValue(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

export function parseArguments(args) {
  const [command, ...rest] = args;
  if (command === "--help" || command === "-h") {
    if (rest.length > 0) {
      throw new Error(`Unexpected argument: ${rest[0]}`);
    }
    return { command: "help" };
  }
  if (command !== "fingerprint" && command !== "affected") {
    throw new Error("Expected fingerprint or affected. Use --help for usage.");
  }
  if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) {
    return { command: "help" };
  }
  const options = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--" && command === "affected") {
      options.moonArgs = rest.slice(index + 1);
      break;
    }
    if (arg === "--dry-run" && command === "affected" && !options.dryRun) {
      options.dryRun = true;
      continue;
    }
    const name = arg.split("=", 1)[0];
    const key =
      command === "fingerprint" && name === "--project"
        ? "project"
        : command === "affected" && (name === "--base" || name === "--head")
          ? name.slice(2)
          : null;
    if (!key || Object.hasOwn(options, key)) {
      throw new Error(`Unexpected or repeated argument: ${arg}`);
    }
    if (arg.includes("=")) {
      options[key] = arg.slice(arg.indexOf("=") + 1);
      if (!options[key]) {
        throw new Error(`${name} requires a value.`);
      }
    } else {
      options[key] = optionValue(rest, index, name);
      index += 1;
    }
  }
  if (command === "affected") {
    if (!options.base) {
      throw new Error("affected requires --base <ref>.");
    }
    if (!options.moonArgs?.[0] || options.moonArgs[0].startsWith("-")) {
      throw new Error("affected requires explicit targets after --, for example: -- :build :test");
    }
  }
  return options;
}

const nativeSelectionOptions = new Set([
  "--affected",
  "--base",
  "--head",
  "--status",
  "--stdin",
  "--include-relations",
  "-g",
  "--upstream",
  "--dependencies",
  "--downstream",
  "--dependents",
]);
const nativeExecutionFlags = new Set(["--force", "-f", "--interactive", "-i", "--no-actions"]);
const nativeRequiredValueOptions = new Set(["--output-style", "--job", "--job-total"]);
const nativeOptionalValueOptions = new Set(["--summary", "-s"]);

function isSupportedTargetForm(target) {
  const separator = target.indexOf(":");
  return (
    separator >= 0 &&
    separator === target.lastIndexOf(":") &&
    separator < target.length - 1 &&
    !target.startsWith("~") &&
    !target.startsWith("^") &&
    target.slice(0, separator) !== "#" &&
    target[separator + 1] !== "#" &&
    !/[*?[\]{}]/.test(target)
  );
}

function interleavedTargetError(arg) {
  return new Error(
    `Targets must be contiguous before moon execution options: ${arg}. ` +
      "Move targets before the options, or use a second -- to forward task arguments.",
  );
}

export function parseNativeSelectionArguments(moonArgs) {
  const firstOption = moonArgs.findIndex((arg) => arg.startsWith("-"));
  const targetCount = firstOption === -1 ? moonArgs.length : firstOption;
  const targets = moonArgs.slice(0, targetCount);
  if (targets.length === 0) {
    throw new Error("affected requires explicit targets after --, for example: -- :build :test");
  }
  // Only constrain supported forms here; moon owns Target syntax and resolution:
  // https://github.com/moonrepo/moon/blob/v2.6.4/crates/target/src/target.rs#L16-L104
  for (const target of targets) {
    if (!isSupportedTargetForm(target)) {
      throw new Error(
        `Unsupported target selector: ${target}. Use :task, project:task, or #tag:task; ` +
          "default-project, ~, task-tag, and glob selectors are not supported.",
      );
    }
  }

  const executionArgs = moonArgs.slice(targetCount);
  for (let index = 0; index < executionArgs.length; index += 1) {
    const arg = executionArgs[index];
    if (arg === "--") {
      break;
    }
    if (!arg.startsWith("-")) {
      throw interleavedTargetError(arg);
    }
    const equalsIndex = arg.indexOf("=");
    const name = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
    if (nativeSelectionOptions.has(name)) {
      throw new Error(
        `Selection option ${name} is managed by pnpm-deps affected. ` +
          "Pass adapter --base/--head before the first --; native selection cannot be overridden.",
      );
    }
    if (name === "--query" || name === "--plan" || name === "-p") {
      throw new Error(
        `Unsupported moon selection option: ${name}. Use :task, project:task, or #tag:task targets.`,
      );
    }
    if (nativeExecutionFlags.has(name)) {
      if (equalsIndex !== -1) {
        throw new Error(`${name} does not accept a value; use it as a flag.`);
      }
      continue;
    }
    if (nativeRequiredValueOptions.has(name) || nativeOptionalValueOptions.has(name)) {
      if (equalsIndex !== -1) {
        if (!arg.slice(equalsIndex + 1)) {
          throw new Error(`${name} requires a nonempty value when using =.`);
        }
      } else {
        const value = executionArgs[index + 1];
        if (value && !value.startsWith("-")) {
          if (value.includes(":")) {
            throw interleavedTargetError(value);
          }
          index += 1;
        } else if (nativeRequiredValueOptions.has(name)) {
          throw new Error(`${name} requires a value.`);
        }
      }
      continue;
    }
    throw new Error(
      `Unsupported moon execution option: ${arg}. Use --help for supported options, ` +
        "or a second -- to forward task arguments.",
    );
  }
  return { targets, executionArgs };
}

function isExactTarget(target) {
  return (
    typeof target === "string" &&
    isSupportedTargetForm(target) &&
    !target.startsWith(":") &&
    !target.startsWith("#")
  );
}

export function selectAffectedTargets(actionGraph, affected) {
  // GraphCache stores action nodes in data, not graph.nodes:
  // https://github.com/moonrepo/moon/blob/v2.6.4/crates/graph-utils/src/graph_formats.rs#L54-L63
  // https://github.com/moonrepo/moon/blob/v2.6.4/crates/action/src/action_node.rs#L43-L83
  if (!isObject(actionGraph) || !isObject(actionGraph.graph) || !isObject(actionGraph.data)) {
    throw new Error("moon action-graph JSON must contain graph and data objects.");
  }
  const targets = new Set();
  for (const [id, node] of Object.entries(actionGraph.data)) {
    if (!isObject(node)) {
      throw new Error(`moon action-graph JSON contains an invalid action node: ${id}`);
    }
    switch (node.action) {
      case "run-task":
        if (!isObject(node.params) || !isExactTarget(node.params.target)) {
          throw new Error(
            `moon action-graph JSON contains an invalid RunTask target at node ${id}.`,
          );
        }
        targets.add(node.params.target);
        break;
      case "none":
      case "sync-workspace":
        break;
      case "install-dependencies":
      case "setup-environment":
      case "setup-proto":
      case "setup-toolchain":
      case "sync-project":
        if (!isObject(node.params)) {
          throw new Error(
            `moon action-graph JSON contains invalid action parameters at node ${id}.`,
          );
        }
        break;
      default:
        throw new Error(`moon action-graph JSON contains an unsupported action at node ${id}.`);
    }
  }

  // Affected omits empty maps, so {} is valid, but present maps and states must be objects:
  // https://github.com/moonrepo/moon/blob/v2.6.4/crates/affected/src/affected.rs
  if (!isObject(affected)) {
    throw new Error("moon query affected JSON must be an object.");
  }
  for (const [name, states] of Object.entries(affected)) {
    if (name !== "projects" && name !== "tasks") {
      throw new Error(`moon query affected JSON contains an unexpected field: ${name}`);
    }
    if (!isObject(states)) {
      throw new Error(`moon query affected JSON ${name} must be an object.`);
    }
    for (const [id, state] of Object.entries(states)) {
      if (!isObject(state) || !id || (name === "tasks" && !isExactTarget(id))) {
        throw new Error(`moon query affected JSON contains an invalid ${name} entry: ${id}`);
      }
    }
  }
  const affectedTasks = affected.tasks ?? {};
  return [...targets].filter((target) => Object.hasOwn(affectedTasks, target)).sort();
}

function findMoon(root, environment) {
  const executable = process.platform === "win32" ? "moon.exe" : "moon";
  const candidates = [
    resolve(root, "node_modules", ".bin", executable),
    ...(environment.PATH ?? "").split(delimiter).map((path) => resolve(root, path, executable)),
  ];
  for (const candidate of new Set(candidates)) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR" && error.code !== "EACCES") {
        throw error;
      }
    }
  }
  throw new Error(
    "Cannot find moon. Install workspace dependencies or expose an installed moon on PATH.",
  );
}

function nativeExitStatus(result) {
  if (result.error) {
    throw result.error;
  }
  return result.status ?? (result.signal ? 128 + (osConstants.signals[result.signal] ?? 0) : 1);
}

function parseNativeJson(output, command) {
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`${command} returned invalid JSON: ${error.message}`);
  }
}

export function runCli(
  args,
  {
    root = workspaceRoot,
    cwd = process.cwd(),
    stdout = process.stdout,
    environment = process.env,
  } = {},
) {
  const options = parseArguments(args);
  if (options.command === "help") {
    stdout.write(usage);
    return 0;
  }
  if (options.command === "fingerprint") {
    stdout.write(`${fingerprint({ root, cwd, project: options.project })}\n`);
    return 0;
  }
  const { targets, executionArgs } = parseNativeSelectionArguments(options.moonArgs);
  if (options.head !== undefined && !options.dryRun) {
    assertExecutionHead(root, options.head);
  }
  const affected = collectAffected({ root, base: options.base, head: options.head });
  if (options.dryRun) {
    stdout.write(`${JSON.stringify(affected)}\n`);
    return 0;
  }
  if (affected.files.length === 0) {
    stdout.write("No changed files; no tasks to run.\n");
    return 0;
  }

  const moon = findMoon(root, environment);
  const queryOptions = {
    cwd: root,
    env: environment,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  };
  // Expand all requested selectors together, including their required upstream tasks.
  const graphResult = spawnSync(moon, ["action-graph", ...targets, "--json"], {
    ...queryOptions,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const graphStatus = nativeExitStatus(graphResult);
  if (graphStatus !== 0) {
    return graphStatus;
  }
  const actionGraph = parseNativeJson(graphResult.stdout, "moon action-graph");

  // Propagate source changes to consumers in moon's affected tracker, not the run graph.
  // Upstream none avoids making unaffected requirements into affected roots; the exact
  // action-graph intersection then excludes unrequested downstream task types.
  // https://github.com/moonrepo/moon/blob/v2.6.4/crates/app/src/commands/query/affected.rs#L12-L46
  // query affected enables stdin internally and parses QueryChangedFilesResult {files}:
  // https://github.com/moonrepo/moon/blob/v2.6.4/crates/app/src/queries/changed_files.rs#L185-L247
  const affectedResult = spawnSync(
    moon,
    ["query", "affected", "--upstream", "none", "--downstream", "deep"],
    {
      ...queryOptions,
      input: `${JSON.stringify({ files: affected.files })}\n`,
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
  const affectedStatus = nativeExitStatus(affectedResult);
  if (affectedStatus !== 0) {
    return affectedStatus;
  }
  const selectedTargets = selectAffectedTargets(
    actionGraph,
    parseNativeJson(affectedResult.stdout, "moon query affected"),
  );
  if (selectedTargets.length === 0) {
    stdout.write("No affected tasks among requested targets; no tasks to run.\n");
    return 0;
  }

  // Restore required upstream work without expanding to unrequested dependents.
  return nativeExitStatus(
    spawnSync(
      moon,
      ["run", "--upstream", "deep", "--downstream", "none", ...selectedTargets, ...executionArgs],
      {
        cwd: root,
        env: environment,
        stdio: "inherit",
      },
    ),
  );
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`pnpm-deps: ${error.message}\n`);
    process.exitCode = 1;
  }
}
