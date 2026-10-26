import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import {
  checkDependencyInputs,
  expectedDependencyInputs,
  updateDependencyInputs,
} from "./inputs.mjs";
import { projectSnapshot } from "./lock-graph.mjs";

const temporaryRoots = [];
const generatedBy = "tools/pnpm-deps/inputs.mjs";
const valid = { valid: true, missing: [], stale: [], unexpected: [] };
const reference = (version) => ({ specifier: version, version });
const metadata = (name) => ({ resolution: { integrity: `sha512-${name}` } });
const snapshotPath = (importer) =>
  importer === "." ? ".moon-deps.json" : `${importer}/.moon-deps.json`;

function lockFixture() {
  return {
    lockfileVersion: "9.0",
    settings: { autoInstallPeers: true, excludeLinksFromLockfile: false },
    importers: {
      ".": { devDependencies: { tool: reference("1.0.0") } },
      "packages/numbers": { dependencies: { alpha: reference("1.0.0") } },
      "packages/reports": {
        dependencies: {
          "@fixture/numbers": { specifier: "workspace:*", version: "link:../numbers" },
        },
      },
      "apps/dashboard": {
        dependencies: {
          "@fixture/reports": { specifier: "workspace:*", version: "link:../../packages/reports" },
        },
      },
      "packages/other-version": { dependencies: { alpha: reference("2.0.0") } },
    },
    packages: {
      "tool@1.0.0": metadata("tool"),
      "alpha@1.0.0": metadata("alpha-one"),
      "alpha@2.0.0": metadata("alpha-two"),
      "leaf@1.0.0": metadata("leaf-one"),
      "leaf@2.0.0": metadata("leaf-two"),
    },
    snapshots: {
      "tool@1.0.0": {},
      "alpha@1.0.0": { dependencies: { leaf: "1.0.0" } },
      "alpha@2.0.0": { dependencies: { leaf: "2.0.0" } },
      "leaf@1.0.0": {},
      "leaf@2.0.0": {},
    },
  };
}

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "pnpm-dependency-inputs-"));
  temporaryRoots.push(root);
  return root;
}

function put(root, path, content) {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function lockText(lockfile, bootDocuments = []) {
  return [...bootDocuments, lockfile].map((document) => stringify(document)).join("---\n");
}

function writeLock(root, lockfile, bootDocuments = []) {
  put(root, "pnpm-lock.yaml", lockText(lockfile, bootDocuments));
}

function createFixture() {
  const root = temporaryRoot();
  const lockfile = lockFixture();
  writeLock(root, lockfile);
  for (const importer of Object.keys(lockfile.importers)) {
    const manifest = importer === "." ? "package.json" : `${importer}/package.json`;
    put(root, manifest, JSON.stringify({ name: importer, private: true }));
  }
  return { root, lockfile };
}

function paths(lockfile) {
  return Object.keys(lockfile.importers).map(snapshotPath).sort();
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function reverseMaps(value) {
  if (Array.isArray(value)) return value.map(reverseMaps);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, child]) => [key, reverseMaps(child)]),
  );
}

function changedPaths(before, after) {
  return [...after.keys()].filter((path) => before.get(path) !== after.get(path)).sort();
}

function changeTransitiveBranch(lockfile) {
  lockfile.snapshots["alpha@1.0.0"].dependencies.leaf = "3.0.0";
  lockfile.packages["leaf@3.0.0"] = metadata("leaf-three");
  lockfile.snapshots["leaf@3.0.0"] = {};
}

const branchPaths = ["apps/dashboard", "packages/numbers", "packages/reports"]
  .map(snapshotPath)
  .sort();

function git(root, args, input) {
  const result = spawnSync(
    "git",
    [
      "-C",
      root,
      "-c",
      "user.name=Dependency fixture",
      "-c",
      "user.email=deps@example.invalid",
      ...args,
    ],
    { encoding: "utf8", input },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args[0]} exited ${result.status}`);
  }
  return result.stdout;
}

function commitFixture(root) {
  git(root, ["init", "--quiet"]);
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "dependency inputs fixture"]);
}

function assertReadOnly(root, action) {
  const before = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const index = git(root, ["ls-files", "--stage", "-z"]);
  try {
    return action();
  } finally {
    expect(git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).toBe(before);
    expect(git(root, ["ls-files", "--stage", "-z"])).toBe(index);
  }
}

function generatedPayload(importer, extra = {}) {
  return `${JSON.stringify({ generatedBy, version: 1, importer, hash: "0".repeat(64), ...extra }, null, 2)}\n`;
}

function runEntry(entry, cwd, args) {
  const result = spawnSync(process.execPath, [entry, ...args], { cwd, encoding: "utf8" });
  expect(result.error).toBeUndefined();
  return result;
}

function copiedRuntime(root) {
  const sourceDirectory = fileURLToPath(new URL(".", import.meta.url));
  const destination = join(root, "tools/pnpm-deps");
  mkdirSync(destination, { recursive: true });
  for (const name of ["inputs.mjs", "lock-graph.mjs"]) {
    copyFileSync(join(sourceDirectory, name), join(destination, name));
  }
  symlinkSync(
    fileURLToPath(new URL("../../node_modules", import.meta.url)),
    join(root, "node_modules"),
    "dir",
  );
  return join(destination, "inputs.mjs");
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("expectedDependencyInputs", () => {
  it("returns sorted per-importer paths and the documented canonical SHA256 payload", () => {
    const lockfile = lockFixture();
    const bootDocuments = [
      { settings: { z: false, a: true }, packageManagerDependencies: { pnpm: "12.15.0" } },
      { metadata: { sequence: ["first", "second"] } },
    ];
    const expected = expectedDependencyInputs(lockText(lockfile, bootDocuments));
    expect(expected).toBeInstanceOf(Map);
    expect([...expected.keys()]).toEqual(paths(lockfile));
    for (const [importer] of Object.entries(lockfile.importers)) {
      const text = expected.get(snapshotPath(importer));
      const payload = JSON.parse(text);
      const hash = createHash("sha256")
        .update(
          canonicalJson({
            project: projectSnapshot(lockfile, importer),
            rootTooling: projectSnapshot(lockfile, "."),
            bootDocuments,
          }),
        )
        .digest("hex");
      expect(payload).toEqual({ generatedBy, version: 1, importer, hash });
      expect(payload.hash).toMatch(/^[a-f0-9]{64}$/);
      expect(text).toBe(`${JSON.stringify(payload, null, 2)}\n`);
    }
  });

  it("isolates transitive branches and separate exact versions of the same package", () => {
    const lockfile = lockFixture();
    const original = expectedDependencyInputs(lockText(lockfile));
    changeTransitiveBranch(lockfile);
    const changedBranch = expectedDependencyInputs(lockText(lockfile));
    expect(changedPaths(original, changedBranch)).toEqual(branchPaths);
    lockfile.packages["leaf@2.0.0"].resolution.integrity = "sha512-other-version-only";
    expect(changedPaths(changedBranch, expectedDependencyInputs(lockText(lockfile)))).toEqual([
      "packages/other-version/.moon-deps.json",
    ]);
  });

  it("includes root tooling and every preceding YAML document in all importer hashes", () => {
    const lockfile = lockFixture();
    const bootDocuments = [{ settings: { first: true } }, { manager: { version: "12.15.0" } }];
    const original = expectedDependencyInputs(lockText(lockfile, bootDocuments));
    lockfile.packages["tool@1.0.0"].resolution.integrity = "sha512-tool-upgraded";
    const newTooling = expectedDependencyInputs(lockText(lockfile, bootDocuments));
    expect(changedPaths(original, newTooling)).toEqual(paths(lockfile));
    bootDocuments[0].settings.first = false;
    const firstBootChange = expectedDependencyInputs(lockText(lockfile, bootDocuments));
    expect(changedPaths(newTooling, firstBootChange)).toEqual(paths(lockfile));
    bootDocuments[1].manager.version = "12.16.0";
    expect(
      changedPaths(firstBootChange, expectedDependencyInputs(lockText(lockfile, bootDocuments))),
    ).toEqual(paths(lockfile));
  });

  it("ignores deep YAML map order, comments, indentation, and whitespace", () => {
    const lockfile = lockFixture();
    const bootDocuments = [{ nested: { z: { second: false, first: true }, a: ["x", "y"] } }];
    const before = expectedDependencyInputs(lockText(lockfile, bootDocuments));
    const reordered = [...bootDocuments, lockfile]
      .map((document) => stringify(reverseMaps(document), { indent: 4 }))
      .join("\n---\n\n");
    expect(
      expectedDependencyInputs(`# Same semantics, different bytes.\n\n${reordered}\n`),
    ).toEqual(before);
  });

  it("supports a graph without a root importer and hashes null root tooling", () => {
    const lockfile = lockFixture();
    delete lockfile.importers["."];
    const expected = expectedDependencyInputs(lockText(lockfile));
    expect([...expected.keys()]).toEqual(paths(lockfile));
    const importer = "packages/numbers";
    const hash = createHash("sha256")
      .update(
        canonicalJson({
          project: projectSnapshot(lockfile, importer),
          rootTooling: null,
          bootDocuments: [],
        }),
      )
      .digest("hex");
    expect(JSON.parse(expected.get(snapshotPath(importer))).hash).toBe(hash);
  });

  it("accepts a valid empty-importer graph but still validates its schema", () => {
    expect(expectedDependencyInputs(lockText({ lockfileVersion: "9.0", importers: {} }))).toEqual(
      new Map(),
    );
    for (const graph of [
      { lockfileVersion: "8.0", importers: {} },
      { lockfileVersion: "9.0", importers: {}, packages: [] },
      { lockfileVersion: "9.0", importers: {}, snapshots: [] },
      { lockfileVersion: "9.0", importers: {}, settings: { invalid: Number.NaN } },
    ]) {
      expect(() => expectedDependencyInputs(lockText(graph))).toThrow();
    }
  });

  it.each([
    ["malformed YAML", "lockfileVersion: [\n"],
    ["missing graph", "settings: {}\n"],
    ["scalar document", "null\n"],
    ["invalid trailing document", `${lockText(lockFixture())}---\nbroken: [\n`],
  ])("rejects %s rather than returning partial inputs", (_label, text) => {
    expect(() => expectedDependencyInputs(text)).toThrow();
  });

  it.each(["metadata", "snapshot"])("propagates missing resolved package %s", (kind) => {
    const lockfile = lockFixture();
    delete lockfile[kind === "metadata" ? "packages" : "snapshots"]["leaf@1.0.0"];
    expect(() => expectedDependencyInputs(lockText(lockfile))).toThrow(/missing/i);
  });

  it.each([
    "../outside",
    "/absolute",
    "packages/../outside",
    "packages/./item",
    "packages//item",
    "packages/item/",
    "C:/outside",
    "C:outside",
    "packages\\item",
    "packages/\0item",
    "node_modules/item",
    "packages/node_modules/item",
    ".git/item",
    "packages/.git/item",
  ])("rejects unsafe importer path %j", (importer) => {
    const lockfile = { lockfileVersion: "9.0", importers: { [importer]: {} } };
    expect(() => expectedDependencyInputs(lockText(lockfile))).toThrow();
  });
});

describe("worktree dependency inputs", () => {
  it("reports missing paths, updates every importer, and preserves unchanged bytes and mtimes", () => {
    const { root, lockfile } = createFixture();
    expect(checkDependencyInputs({ root })).toEqual({
      valid: false,
      missing: paths(lockfile),
      stale: [],
      unexpected: [],
    });
    expect(paths(lockfile).every((path) => !existsSync(join(root, path)))).toBe(true);
    expect(updateDependencyInputs({ root })).toEqual({ updated: paths(lockfile), removed: [] });
    expect(checkDependencyInputs({ root })).toEqual(valid);
    const expected = expectedDependencyInputs(lockText(lockfile));
    const mtimes = new Map();
    for (const [path, text] of expected) {
      expect(readFileSync(join(root, path), "utf8")).toBe(text);
      utimesSync(
        join(root, path),
        new Date("2001-01-01T00:00:00Z"),
        new Date("2001-01-01T00:00:00Z"),
      );
      mtimes.set(path, statSync(join(root, path)).mtimeMs);
    }
    expect(updateDependencyInputs({ root })).toEqual({ updated: [], removed: [] });
    for (const path of expected.keys())
      expect(statSync(join(root, path)).mtimeMs).toBe(mtimes.get(path));
    put(
      root,
      "pnpm-lock.yaml",
      `# Formatting-only change.\n${stringify(reverseMaps(lockfile), { indent: 4 })}\n`,
    );
    expect(checkDependencyInputs({ root })).toEqual(valid);
    expect(updateDependencyInputs({ root })).toEqual({ updated: [], removed: [] });
    for (const path of expected.keys())
      expect(statSync(join(root, path)).mtimeMs).toBe(mtimes.get(path));
    changeTransitiveBranch(lockfile);
    writeLock(root, lockfile);
    expect(checkDependencyInputs({ root })).toEqual({
      valid: false,
      missing: [],
      stale: branchPaths,
      unexpected: [],
    });
    expect(updateDependencyInputs({ root })).toEqual({ updated: branchPaths, removed: [] });
    for (const path of paths(lockfile).filter((path) => !branchPaths.includes(path))) {
      expect(statSync(join(root, path)).mtimeMs).toBe(mtimes.get(path));
    }
    expect(checkDependencyInputs({ root })).toEqual(valid);
  });

  it("adds importers and prunes owned orphan snapshots even outside the remaining importer tree", () => {
    const { root, lockfile } = createFixture();
    updateDependencyInputs({ root });
    delete lockfile.importers["packages/other-version"];
    lockfile.importers["new/deep/project"] = {};
    const orphan = "abandoned/nested/.moon-deps.json";
    put(root, orphan, generatedPayload("abandoned/nested"));
    writeLock(root, lockfile);
    const removed = [orphan, "packages/other-version/.moon-deps.json"].sort();
    expect(checkDependencyInputs({ root })).toEqual({
      valid: false,
      missing: ["new/deep/project/.moon-deps.json"],
      stale: [],
      unexpected: removed,
    });
    expect(removed.every((path) => existsSync(join(root, path)))).toBe(true);
    expect(updateDependencyInputs({ root })).toEqual({
      updated: ["new/deep/project/.moon-deps.json"],
      removed,
    });
    expect(removed.every((path) => !existsSync(join(root, path)))).toBe(true);
    expect(checkDependencyInputs({ root })).toEqual(valid);
  });

  it("does not write snapshots or stage files during missing, stale, or unexpected checks", () => {
    const { root, lockfile } = createFixture();
    commitFixture(root);
    expect(assertReadOnly(root, () => checkDependencyInputs({ root })).missing).toEqual(
      paths(lockfile),
    );
    updateDependencyInputs({ root });
    git(root, ["add", "."]);
    const stalePath = "packages/numbers/.moon-deps.json";
    put(root, stalePath, generatedPayload("packages/numbers"));
    const orphan = "abandoned/.moon-deps.json";
    put(root, orphan, generatedPayload("abandoned"));
    const before = readFileSync(join(root, stalePath), "utf8");
    expect(assertReadOnly(root, () => checkDependencyInputs({ root }))).toEqual({
      valid: false,
      missing: [],
      stale: [stalePath],
      unexpected: [orphan],
    });
    expect(readFileSync(join(root, stalePath), "utf8")).toBe(before);
    expect(existsSync(join(root, orphan))).toBe(true);
  });

  it.each([
    ["unrelated text", "hand-authored configuration\n"],
    ["wrong generator", generatedPayload(".", { generatedBy: "somewhere/else.mjs" })],
    ["wrong version", generatedPayload(".", { version: 2 })],
    ["wrong importer", generatedPayload("packages/not-root")],
    ["missing importer", `${JSON.stringify({ generatedBy, version: 1, hash: "old" })}\n`],
  ])("refuses to overwrite %s at an expected snapshot path", (_label, content) => {
    const { root } = createFixture();
    put(root, ".moon-deps.json", content);
    expect(() => updateDependencyInputs({ root })).toThrow();
    expect(readFileSync(join(root, ".moon-deps.json"), "utf8")).toBe(content);
  });

  it("recognizes ownership independently of a stale hash", () => {
    const { root } = createFixture();
    updateDependencyInputs({ root });
    put(root, ".moon-deps.json", generatedPayload(".", { hash: "outdated" }));
    expect(updateDependencyInputs({ root })).toEqual({ updated: [".moon-deps.json"], removed: [] });
    expect(checkDependencyInputs({ root })).toEqual(valid);
  });

  it("does not delete an obsolete snapshot with a mismatched ownership importer", () => {
    const { root } = createFixture();
    updateDependencyInputs({ root });
    const path = "orphan/.moon-deps.json";
    const content = generatedPayload("not-orphan");
    put(root, path, content);
    expect(() => updateDependencyInputs({ root })).toThrow();
    expect(readFileSync(join(root, path), "utf8")).toBe(content);
  });

  it("ignores excluded directories and never traverses unrelated directory symlinks", () => {
    const { root } = createFixture();
    updateDependencyInputs({ root });
    const outside = temporaryRoot();
    put(outside, ".moon-deps.json", generatedPayload("outside"));
    put(root, "node_modules/hidden/.moon-deps.json", generatedPayload("node_modules/hidden"));
    put(root, ".git/hidden/.moon-deps.json", generatedPayload(".git/hidden"));
    symlinkSync(outside, join(root, "linked-outside"), "dir");
    expect(checkDependencyInputs({ root })).toEqual(valid);
    expect(updateDependencyInputs({ root })).toEqual({ updated: [], removed: [] });
    expect(existsSync(join(outside, ".moon-deps.json"))).toBe(true);
  });

  it.each(["importer directory", "snapshot file", "lockfile"])(
    "rejects a symlink %s boundary",
    (kind) => {
      const { root } = createFixture();
      updateDependencyInputs({ root });
      const outside = temporaryRoot();
      const original = "outside bytes must remain unchanged\n";
      put(outside, "untouched", original);
      if (kind === "importer directory") {
        rmSync(join(root, "packages/numbers"), { recursive: true });
        symlinkSync(outside, join(root, "packages/numbers"), "dir");
      } else if (kind === "snapshot file") {
        unlinkSync(join(root, "packages/numbers/.moon-deps.json"));
        symlinkSync(join(outside, "untouched"), join(root, "packages/numbers/.moon-deps.json"));
      } else {
        copyFileSync(join(root, "pnpm-lock.yaml"), join(outside, "pnpm-lock.yaml"));
        unlinkSync(join(root, "pnpm-lock.yaml"));
        symlinkSync(join(outside, "pnpm-lock.yaml"), join(root, "pnpm-lock.yaml"));
      }
      expect(() => checkDependencyInputs({ root })).toThrow(/symlink|symbolic/i);
      expect(() => updateDependencyInputs({ root })).toThrow(/symlink|symbolic/i);
      expect(readFileSync(join(outside, "untouched"), "utf8")).toBe(original);
    },
  );

  it("propagates malformed and missing lockfiles without creating snapshots", () => {
    const { root, lockfile } = createFixture();
    put(root, "pnpm-lock.yaml", "broken: [\n");
    expect(() => updateDependencyInputs({ root })).toThrow();
    expect(() => checkDependencyInputs({ root })).toThrow();
    unlinkSync(join(root, "pnpm-lock.yaml"));
    expect(() => updateDependencyInputs({ root })).toThrow();
    expect(() => checkDependencyInputs({ root })).toThrow();
    expect(paths(lockfile).every((path) => !existsSync(join(root, path)))).toBe(true);
  });
});

describe("Git index dependency inputs", () => {
  it("rejects staged stale snapshots despite a fresh worktree, then accepts a fresh index despite a broken worktree", () => {
    const { root, lockfile } = createFixture();
    updateDependencyInputs({ root });
    commitFixture(root);
    changeTransitiveBranch(lockfile);
    writeLock(root, lockfile);
    updateDependencyInputs({ root });
    git(root, ["add", "pnpm-lock.yaml"]);
    expect(checkDependencyInputs({ root })).toEqual(valid);
    expect(assertReadOnly(root, () => checkDependencyInputs({ root, staged: true }))).toEqual({
      valid: false,
      missing: [],
      stale: branchPaths,
      unexpected: [],
    });
    git(root, ["add", "--", ...branchPaths]);
    put(root, "pnpm-lock.yaml", "malformed worktree: [\n");
    for (const path of paths(lockfile)) unlinkSync(join(root, path));
    expect(assertReadOnly(root, () => checkDependencyInputs({ root, staged: true }))).toEqual(
      valid,
    );
    expect(readFileSync(join(root, "pnpm-lock.yaml"), "utf8")).toBe("malformed worktree: [\n");
    expect(paths(lockfile).every((path) => !existsSync(join(root, path)))).toBe(true);
  });

  it("requires coherent staged importer additions and removals with NUL-safe unusual paths", () => {
    const { root, lockfile } = createFixture();
    updateDependencyInputs({ root });
    commitFixture(root);
    const unusualImporter = "packages/space tab\tline\n雪";
    const added = snapshotPath(unusualImporter);
    const removed = snapshotPath("packages/other-version");
    delete lockfile.importers["packages/other-version"];
    lockfile.importers[unusualImporter] = {};
    writeLock(root, lockfile);
    updateDependencyInputs({ root });
    git(root, ["add", "pnpm-lock.yaml"]);
    expect(assertReadOnly(root, () => checkDependencyInputs({ root, staged: true }))).toEqual({
      valid: false,
      missing: [added],
      stale: [],
      unexpected: [removed],
    });
    git(root, ["add", "-A", "--", added, removed]);
    expect(checkDependencyInputs({ root, staged: true })).toEqual(valid);
    git(root, ["rm", "--cached", "--", added]);
    expect(existsSync(join(root, added))).toBe(true);
    expect(assertReadOnly(root, () => checkDependencyInputs({ root, staged: true }))).toEqual({
      valid: false,
      missing: [added],
      stale: [],
      unexpected: [],
    });
  });

  it("uses only the index inventory for unexpected snapshots, not untracked or deleted worktree files", () => {
    const { root } = createFixture();
    updateDependencyInputs({ root });
    commitFixture(root);
    const orphan = "untracked project\nwith newline/.moon-deps.json";
    put(root, orphan, generatedPayload("untracked project\nwith newline"));
    expect(checkDependencyInputs({ root, staged: true })).toEqual(valid);
    git(root, ["add", "--", orphan]);
    unlinkSync(join(root, orphan));
    expect(assertReadOnly(root, () => checkDependencyInputs({ root, staged: true }))).toEqual({
      valid: false,
      missing: [],
      stale: [],
      unexpected: [orphan],
    });
  });

  it("fails on an unmerged entry anywhere in the index", () => {
    const { root } = createFixture();
    updateDependencyInputs({ root });
    commitFixture(root);
    const blob = git(root, ["hash-object", "-w", "--stdin"], "unmerged fixture\n").trim();
    git(root, ["update-index", "-z", "--index-info"], `100644 ${blob} 1\tunrelated/conflict.txt\0`);
    expect(() => assertReadOnly(root, () => checkDependencyInputs({ root, staged: true }))).toThrow(
      /unmerged|conflict/i,
    );
  });

  it("rejects staged symlink snapshot entries without reading their worktree targets", () => {
    const { root } = createFixture();
    updateDependencyInputs({ root });
    commitFixture(root);
    const target = "untouched symlink target\n";
    put(root, "outside-target", target);
    const snapshot = readFileSync(join(root, ".moon-deps.json"));
    const blob = git(root, ["hash-object", "-w", "--stdin"], "outside-target").trim();
    git(root, ["update-index", "--cacheinfo", "120000", blob, ".moon-deps.json"]);
    expect(() =>
      assertReadOnly(root, () => checkDependencyInputs({ root, staged: true })),
    ).toThrow();
    expect(readFileSync(join(root, "outside-target"), "utf8")).toBe(target);
    expect(readFileSync(join(root, ".moon-deps.json"))).toEqual(snapshot);
  });

  it("rejects a missing staged lockfile instead of falling back to the worktree", () => {
    const { root } = createFixture();
    updateDependencyInputs({ root });
    commitFixture(root);
    git(root, ["rm", "--cached", "pnpm-lock.yaml"]);
    expect(existsSync(join(root, "pnpm-lock.yaml"))).toBe(true);
    expect(() => checkDependencyInputs({ root, staged: true })).toThrow(/lockfile|pnpm-lock/i);
  });

  it("reads the linked worktree index when .git is a file", () => {
    const { root } = createFixture();
    updateDependencyInputs({ root });
    commitFixture(root);
    const linkedRoot = join(temporaryRoot(), "linked");
    git(root, ["worktree", "add", "--quiet", "--detach", linkedRoot, "HEAD"]);
    expect(statSync(join(linkedRoot, ".git")).isFile()).toBe(true);
    expect(checkDependencyInputs({ root: linkedRoot, staged: true })).toEqual(valid);
    git(linkedRoot, ["rm", "--cached", ".moon-deps.json"]);
    expect(checkDependencyInputs({ root: linkedRoot, staged: true })).toEqual({
      valid: false,
      missing: [".moon-deps.json"],
      stale: [],
      unexpected: [],
    });
    expect(checkDependencyInputs({ root, staged: true })).toEqual(valid);
  });
});

describe("dependency input executable", () => {
  it("checks read-only, updates, and checks again using the copied module's realpath default root", () => {
    const { root, lockfile } = createFixture();
    copiedRuntime(root);
    const unrelatedCwd = temporaryRoot();
    const aliasDirectory = join(unrelatedCwd, "alias");
    symlinkSync(join(root, "tools/pnpm-deps"), aliasDirectory, "dir");
    const entry = join(aliasDirectory, "inputs.mjs");
    const missing = runEntry(entry, unrelatedCwd, ["check"]);
    expect(missing.status).toBe(1);
    expect(paths(lockfile).every((path) => !existsSync(join(root, path)))).toBe(true);
    expect(existsSync(join(unrelatedCwd, ".moon-deps.json"))).toBe(false);
    const update = runEntry(entry, unrelatedCwd, ["update"]);
    expect(update.status).toBe(0);
    expect(update.stderr).toBe("");
    for (const [path, text] of expectedDependencyInputs(lockText(lockfile))) {
      expect(readFileSync(join(root, path), "utf8")).toBe(text);
    }
    const check = runEntry(entry, unrelatedCwd, ["check"]);
    expect(check.status).toBe(0);
    expect(check.stderr).toBe("");
    expect(existsSync(join(unrelatedCwd, ".moon-deps.json"))).toBe(false);
    commitFixture(root);
    put(root, "pnpm-lock.yaml", "worktree must not be parsed: [\n");
    unlinkSync(join(root, ".moon-deps.json"));
    const staged = runEntry(entry, unrelatedCwd, ["check", "--staged"]);
    expect(staged.status).toBe(0);
    expect(staged.stderr).toBe("");
    expect(existsSync(join(root, ".moon-deps.json"))).toBe(false);
  });

  it.each([
    { args: ["affected"] },
    { args: ["fingerprint"] },
    { args: ["update", "--staged"] },
    { args: ["check", "--unknown"] },
    { args: ["check", "extra"] },
    { args: [] },
  ])("rejects unsupported command arguments $args", ({ args }) => {
    const root = temporaryRoot();
    const entry = fileURLToPath(new URL("./inputs.mjs", import.meta.url));
    const result = runEntry(entry, root, args);
    expect(result.status).not.toBe(0);
    expect(existsSync(join(root, ".moon-deps.json"))).toBe(false);
  });
});
