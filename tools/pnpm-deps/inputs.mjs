#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";
import { changedImporters, projectSnapshot } from "./lock-graph.mjs";

const modulePath = realpathSync(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(dirname(modulePath), "../..");
const lockfilePath = "pnpm-lock.yaml";
const snapshotName = ".moon-deps.json";
const generatedBy = "tools/pnpm-deps/inputs.mjs";
const snapshotVersion = 1;
const usage = `Usage:
  pnpm-deps update
  pnpm-deps check [--staged]

update writes changed per-project .moon-deps.json files and removes owned orphans.
check validates the working tree without writing any files.
check --staged validates the Git index, not the working tree, without staging files.

After installing dependencies, run moon run root:deps-update and stage
pnpm-lock.yaml together with all .moon-deps.json changes.
`;

function isObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}

function canonicalJson(value, ancestors = new Set()) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || (!Array.isArray(value) && !isObject(value))) {
    throw new Error("Dependency inputs must contain only JSON-compatible values.");
  }
  if (ancestors.has(value)) {
    throw new Error("Dependency inputs cannot contain cyclic YAML values.");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error("Dependency inputs must contain only string map keys.");
  }
  ancestors.add(value);
  const result = Array.isArray(value)
    ? `[${value.map((entry) => canonicalJson(entry, ancestors)).join(",")}]`
    : `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], ancestors)}`)
        .join(",")}}`;
  ancestors.delete(value);
  return result;
}

function parseLockfile(text) {
  const documents = parseAllDocuments(text);
  for (const document of documents) {
    if (document.errors.length > 0) {
      throw new Error(`Cannot parse ${lockfilePath}: ${document.errors[0].message}`);
    }
  }
  const values = documents.map((document) => document.toJS());
  const lockfile = values.at(-1);
  if (!isObject(lockfile) || !isObject(lockfile.importers)) {
    throw new Error(`${lockfilePath} must end with a pnpm project lockfile containing importers.`);
  }
  return { lockfile, bootDocuments: values.slice(0, -1) };
}

function assertImporter(importer) {
  if (
    typeof importer !== "string" ||
    importer.length === 0 ||
    importer.includes("\0") ||
    importer.includes("\\") ||
    /^[a-z]:/i.test(importer) ||
    posix.isAbsolute(importer) ||
    importer === ".." ||
    importer.startsWith("../") ||
    importer.endsWith("/") ||
    posix.normalize(importer) !== importer ||
    importer.split("/").some((part) => part === ".git" || part === "node_modules")
  ) {
    throw new Error(`Unsafe importer path: ${JSON.stringify(importer)}.`);
  }
  return importer;
}

function snapshotPath(importer) {
  assertImporter(importer);
  return importer === "." ? snapshotName : `${importer}/${snapshotName}`;
}

function snapshotImporter(path) {
  if (path === snapshotName) return ".";
  if (!path.endsWith(`/${snapshotName}`)) {
    throw new Error(`Not a dependency input path: ${JSON.stringify(path)}.`);
  }
  return assertImporter(path.slice(0, -snapshotName.length - 1));
}

/** Compute stable, tracked native moon inputs from the complete pnpm lockfile. */
export function expectedDependencyInputs(lockfileText) {
  const { lockfile, bootDocuments } = parseLockfile(lockfileText);
  const importers = Object.keys(lockfile.importers).sort();
  for (const importer of importers) assertImporter(importer);
  // Even an empty workspace must not silently accept an unsupported lock schema.
  if (importers.length === 0) changedImporters(lockfile, lockfile);
  const rootTooling = Object.hasOwn(lockfile.importers, ".")
    ? projectSnapshot(lockfile, ".")
    : null;
  const expected = new Map();
  for (const importer of importers) {
    const project = importer === "." ? rootTooling : projectSnapshot(lockfile, importer);
    const hash = createHash("sha256")
      .update(canonicalJson({ project, rootTooling, bootDocuments }))
      .digest("hex");
    const snapshot = { generatedBy, version: snapshotVersion, importer, hash };
    expected.set(snapshotPath(importer), `${JSON.stringify(snapshot, null, 2)}\n`);
  }
  return expected;
}

function workspaceDirectory(root) {
  const directory = realpathSync(root);
  if (!lstatSync(directory).isDirectory()) {
    throw new Error(`Workspace root is not a directory: ${root}.`);
  }
  return directory;
}

function maybeStat(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// Refuse every symlink component, even one that currently resolves inside the
// workspace. Neither writes nor orphan cleanup may cross a redirected boundary.
function workspaceFile(root, path) {
  const parts = path.split("/");
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]);
    const stat = maybeStat(current);
    if (!stat) return join(root, ...parts);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing symlink in dependency input path: ${path}.`);
    }
    if (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) {
      throw new Error(`Dependency input path is not a regular file: ${path}.`);
    }
  }
  return current;
}

function readWorkspaceFile(root, path) {
  const absolute = workspaceFile(root, path);
  let descriptor;
  try {
    descriptor = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fstatSync(descriptor).isFile()) {
      throw new Error(`Dependency input path is not a regular file: ${path}.`);
    }
    return readFileSync(descriptor, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function currentLockfile(root) {
  const text = readWorkspaceFile(root, lockfilePath);
  if (text === null) {
    throw new Error(`Cannot generate dependency inputs without ${join(root, lockfilePath)}.`);
  }
  return text;
}

function snapshotCandidates(root) {
  const candidates = [];
  const pending = [""];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (path === ".sc" || path === ".moon/cache" || path === ".moon/hooks") continue;
      if (entry.name === snapshotName) candidates.push(path);
      else if (entry.isDirectory()) pending.push(path);
    }
  }
  return candidates.sort();
}

function currentSnapshots(root, expected) {
  const snapshots = new Map();
  const paths = new Set([...expected.keys(), ...snapshotCandidates(root)]);
  for (const path of [...paths].sort()) {
    const text = readWorkspaceFile(root, path);
    if (text !== null) snapshots.set(path, text);
  }
  return snapshots;
}

function snapshotObject(text) {
  try {
    const value = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function hasGeneratedMarker(text) {
  return snapshotObject(text)?.generatedBy === generatedBy;
}

function assertOwnedSnapshot(path, text) {
  const value = snapshotObject(text);
  if (
    value?.generatedBy !== generatedBy ||
    value.version !== snapshotVersion ||
    value.importer !== snapshotImporter(path)
  ) {
    throw new Error(
      `Refusing to overwrite or remove an unowned dependency input: ${path}. ` +
        "Only generated files with the current version and matching importer can be changed.",
    );
  }
}

function compareSnapshots(expected, snapshots) {
  const missing = [];
  const stale = [];
  for (const [path, text] of expected) {
    if (!snapshots.has(path)) missing.push(path);
    else if (snapshots.get(path) !== text) stale.push(path);
  }
  const unexpected = [...snapshots]
    .filter(([path, text]) => !expected.has(path) && hasGeneratedMarker(text))
    .map(([path]) => path)
    .sort();
  return {
    valid: missing.length === 0 && stale.length === 0 && unexpected.length === 0,
    missing: missing.sort(),
    stale: stale.sort(),
    unexpected,
  };
}

function writeSnapshot(root, path, text) {
  const absolute = workspaceFile(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  // O_NOFOLLOW also protects the final component between inspection and open.
  const descriptor = openSync(
    absolute,
    constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
    0o666,
  );
  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new Error(`Dependency input path is not a regular file: ${path}.`);
    }
    ftruncateSync(descriptor, 0);
    writeFileSync(descriptor, text);
  } finally {
    closeSync(descriptor);
  }
}

/** Write only changed generated bytes, and prune explicitly owned orphan inputs. */
export function updateDependencyInputs({ root = workspaceRoot } = {}) {
  root = workspaceDirectory(root);
  const expected = expectedDependencyInputs(currentLockfile(root));
  const snapshots = currentSnapshots(root, expected);
  const { missing, stale, unexpected } = compareSnapshots(expected, snapshots);
  // Inspect the entire plan before changing anything, so an unrelated file is
  // never replaced just because its name happens to match a generated input.
  for (const path of [...stale, ...unexpected]) assertOwnedSnapshot(path, snapshots.get(path));
  const updated = [...missing, ...stale].sort();
  for (const path of updated) writeSnapshot(root, path, expected.get(path));
  for (const path of unexpected) unlinkSync(workspaceFile(root, path));
  return { updated, removed: unexpected };
}

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
  }
  return result.stdout;
}

function stagedFiles(root) {
  // Read object IDs rather than :path expressions, so tabs/newlines and linked
  // worktree index locations do not require quoting or .git layout assumptions.
  const prefix = git(root, ["rev-parse", "--show-prefix"]).replace(/\n$/, "");
  const records = git(root, ["ls-files", "--stage", "-z", "--full-name", "--", ":/"]);
  const entries = new Map();
  for (const record of records.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    const metadata = record.slice(0, tab).split(" ");
    if (tab === -1 || metadata.length !== 3 || !/^[0-3]$/.test(metadata[2])) {
      throw new Error("Cannot read the Git index: malformed ls-files entry.");
    }
    const [mode, object, stage] = metadata;
    const path = record.slice(tab + 1);
    if (stage !== "0") {
      throw new Error(`Cannot check staged dependency inputs with an unmerged Git index: ${path}.`);
    }
    if (path.startsWith(prefix)) entries.set(path.slice(prefix.length), { mode, object });
  }
  return entries;
}

function stagedText(root, path, entry) {
  if (entry.mode !== "100644" && entry.mode !== "100755") {
    throw new Error(`Staged dependency input path is not a regular file: ${path}.`);
  }
  return git(root, ["cat-file", "blob", entry.object]);
}

function checkStaged(root) {
  const entries = stagedFiles(root);
  const lockfile = entries.get(lockfilePath);
  if (!lockfile) {
    throw new Error(
      `The Git index has no ${lockfilePath}. Stage the lockfile together with its dependency inputs.`,
    );
  }
  const expected = expectedDependencyInputs(stagedText(root, lockfilePath, lockfile));
  const snapshots = new Map();
  for (const [path, entry] of entries) {
    if (path === snapshotName || path.endsWith(`/${snapshotName}`)) {
      snapshots.set(path, stagedText(root, path, entry));
    }
  }
  return compareSnapshots(expected, snapshots);
}

/** Check exact generated bytes against either the working tree or Git index. */
export function checkDependencyInputs({ root = workspaceRoot, staged = false } = {}) {
  root = workspaceDirectory(root);
  if (staged) return checkStaged(root);
  const expected = expectedDependencyInputs(currentLockfile(root));
  return compareSnapshots(expected, currentSnapshots(root, expected));
}

function main(args) {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    process.stdout.write(usage);
    return 0;
  }
  if (args.length === 1 && args[0] === "update") {
    const { updated, removed } = updateDependencyInputs();
    process.stdout.write(
      `Dependency inputs updated: ${updated.length} written, ${removed.length} removed.\n`,
    );
    return 0;
  }
  if (args[0] === "check" && (args.length === 1 || (args.length === 2 && args[1] === "--staged"))) {
    const staged = args.length === 2;
    const result = checkDependencyInputs({ staged });
    if (result.valid) {
      process.stdout.write(
        `${staged ? "Staged dependency" : "Dependency"} inputs are up to date.\n`,
      );
      return 0;
    }
    process.stderr.write(
      `${staged ? "Staged dependency" : "Dependency"} inputs do not match ${staged ? "staged " : ""}${lockfilePath}.\n`,
    );
    for (const kind of ["missing", "stale", "unexpected"]) {
      for (const path of result[kind]) process.stderr.write(`  ${kind}: ${JSON.stringify(path)}\n`);
    }
    process.stderr.write(
      "After installing dependencies, run moon run root:deps-update and stage " +
        "pnpm-lock.yaml together with all .moon-deps.json changes.\n",
    );
    return 1;
  }
  throw new Error(`Unsupported command or arguments.\n\n${usage}`);
}

function isEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === modulePath;
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`pnpm-deps: ${error.message}\n`);
    process.exitCode = 1;
  }
}
