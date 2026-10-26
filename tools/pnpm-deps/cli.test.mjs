import { afterEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import {
  collectAffected,
  fingerprint,
  parseArguments,
  parseLockfile,
  parseNativeSelectionArguments,
  projectAffectedFiles,
  runCli,
  selectAffectedTargets,
} from "./cli.mjs";

const temporaryRoots = [];
const importerIds = [
  ".",
  "apps/dashboard",
  "packages/colors",
  "packages/numbers",
  "packages/reports",
];
const packagePaths = [
  "package.json",
  ...importerIds.filter((id) => id !== ".").map((id) => `${id}/package.json`),
].sort();

function lockFixture() {
  return {
    lockfileVersion: "9.0",
    settings: { autoInstallPeers: true, excludeLinksFromLockfile: false },
    importers: {
      ".": { devDependencies: { tool: { specifier: "1.0.0", version: "1.0.0" } } },
      "packages/numbers": { dependencies: { "is-odd": { specifier: "3.0.1", version: "3.0.1" } } },
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
      "packages/colors": { dependencies: { picocolors: { specifier: "1.1.1", version: "1.1.1" } } },
    },
    packages: {
      "tool@1.0.0": { resolution: { integrity: "sha512-tool" } },
      "is-odd@3.0.1": { resolution: { integrity: "sha512-odd" } },
      "is-number@6.0.0": { resolution: { integrity: "sha512-number" } },
      "picocolors@1.1.1": { resolution: { integrity: "sha512-color" } },
    },
    snapshots: {
      "tool@1.0.0": {},
      "is-odd@3.0.1": { dependencies: { "is-number": "6.0.0" } },
      "is-number@6.0.0": {},
      "picocolors@1.1.1": {},
    },
  };
}

function put(root, path, content) {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function writeLock(root, lockfile, bootDocuments = []) {
  put(
    root,
    "pnpm-lock.yaml",
    [...bootDocuments, lockfile].map((document) => stringify(document)).join("---\n"),
  );
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "pnpm-deps-cli-"));
  temporaryRoots.push(root);
  const lockfile = lockFixture();
  writeLock(root, lockfile);
  for (const importer of importerIds) {
    const path = importer === "." ? "package.json" : `${importer}/package.json`;
    put(root, path, JSON.stringify({ name: importer, private: true }));
  }
  put(root, ".gitignore", "ignored.txt\nnode_modules/\n");
  put(root, "root.config.mjs", "export default {};\n");
  put(root, "packages/numbers/src/index.ts", "export const n = 1;\n");
  put(root, "packages/reports/src/index.ts", "export const report = 1;\n");
  return { root, lockfile };
}

function parsed(lockfile, bootDocuments = []) {
  return parseLockfile(
    [...bootDocuments, lockfile].map((document) => stringify(document)).join("---\n"),
  );
}

function git(root, ...args) {
  const result = spawnSync(
    "git",
    ["-C", root, "-c", "user.name=CLI fixture", "-c", "user.email=cli@example.invalid", ...args],
    { encoding: "utf8" },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args[0]} exited ${result.status}`);
  }
  return result.stdout.trim();
}

function commitFixture(root) {
  git(root, "init", "--quiet");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "fixture");
  return git(root, "rev-parse", "HEAD");
}

function captureOutput() {
  let text = "";
  return {
    stdout: {
      write(chunk) {
        text += chunk;
      },
    },
    value: () => text,
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("executable entrypoint", () => {
  it("runs the actual CLI through a symlink directory", () => {
    const { root } = createFixture();
    const linkedTools = join(root, "linked-tools");
    symlinkSync(fileURLToPath(new URL(".", import.meta.url)), linkedTools, "dir");
    const result = spawnSync(process.execPath, [join(linkedTools, "cli.mjs"), "--help"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/^Usage:\n  pnpm-deps fingerprint \[--project <importer>\]\n/);
    expect(result.stdout).toContain("pnpm-deps affected --base <ref>");
  });
});

describe("fingerprint", () => {
  it("hashes the project closure but not an unrelated package resolution", () => {
    const { root, lockfile } = createFixture();
    const original = new Map(
      importerIds.map((project) => [project, fingerprint({ root, project })]),
    );
    lockfile.packages["is-number@6.0.0"].resolution.integrity = "sha512-number-changed";
    writeLock(root, lockfile);

    for (const project of ["packages/numbers", "packages/reports", "apps/dashboard"]) {
      expect(fingerprint({ root, project })).not.toBe(original.get(project));
    }
    expect(fingerprint({ root, project: "packages/colors" })).toBe(original.get("packages/colors"));
    expect(fingerprint({ root, project: "." })).toBe(original.get("."));
    expect(fingerprint({ root, cwd: join(root, "packages/numbers") })).toBe(
      fingerprint({ root, project: "packages/numbers" }),
    );
    expect(fingerprint({ root, project: "packages/numbers" })).toMatch(/^[a-f0-9]{64}$/);
  });

  it("includes shared root tooling for every project", () => {
    const { root, lockfile } = createFixture();
    const original = importerIds.map((project) => fingerprint({ root, project }));
    lockfile.packages["tool@1.0.0"].resolution.integrity = "sha512-new-tool";
    writeLock(root, lockfile);
    importerIds.forEach((project, index) => {
      expect(fingerprint({ root, project })).not.toBe(original[index]);
    });
  });

  it("parses all YAML documents and hashes boot semantics, not formatting or key order", () => {
    const { root, lockfile } = createFixture();
    const boot = {
      lockfileVersion: "9.0",
      importers: {
        ".": { packageManagerDependencies: { pnpm: { version: "12.15.0", specifier: "12.15.0" } } },
      },
      settings: { first: true, second: false },
    };
    writeLock(root, lockfile, [boot]);
    const original = fingerprint({ root, project: "packages/colors" });
    const reorderedBoot = {
      settings: { second: false, first: true },
      importers: boot.importers,
      lockfileVersion: "9.0",
    };
    const reorderedLock = Object.fromEntries(Object.entries(lockfile).reverse());
    writeLock(root, reorderedLock, [reorderedBoot]);
    put(
      root,
      "pnpm-lock.yaml",
      `# Formatting is not a dependency change.\n${readFileSync(join(root, "pnpm-lock.yaml"), "utf8")}`,
    );
    expect(fingerprint({ root, project: "packages/colors" })).toBe(original);

    reorderedBoot.importers["."].packageManagerDependencies.pnpm.version = "12.16.0";
    writeLock(root, lockfile, [reorderedBoot]);
    expect(fingerprint({ root, project: "packages/colors" })).not.toBe(original);
    expect(
      parseLockfile(readFileSync(join(root, "pnpm-lock.yaml"), "utf8")).bootDocuments,
    ).toHaveLength(1);
  });

  it("rejects missing importers, outside directories, malformed documents, and a missing lockfile", () => {
    const { root } = createFixture();
    expect(() => fingerprint({ root, project: "packages/absent" })).toThrow(/missing importer/);
    expect(() => fingerprint({ root, project: "../outside" })).toThrow(/inside the workspace/);
    expect(() => parseLockfile("lockfileVersion: [")).toThrow(/Cannot parse/);
    expect(() => parseLockfile("lockfileVersion: 9.0\n")).toThrow(/containing importers/);
    expect(() => parseLockfile(`${stringify(lockFixture())}---\ninvalid: [\n`)).toThrow(
      /Cannot parse/,
    );
    unlinkSync(join(root, "pnpm-lock.yaml"));
    expect(() => fingerprint({ root, project: "." })).toThrow(/Cannot fingerprint without/);
  });
});

describe("lockfile affected projection", () => {
  it("projects only changed dependency closures and preserves ordinary source/package changes", () => {
    const { root, lockfile } = createFixture();
    const before = parsed(lockfile);
    lockfile.packages["is-number@6.0.0"].resolution.integrity = "sha512-changed";
    const result = projectAffectedFiles({
      root,
      before,
      after: parsed(lockfile),
      files: [
        "pnpm-lock.yaml",
        "root.config.mjs",
        "packages/colors/package.json",
        "deleted source.ts",
      ],
    });
    expect(result.dependencyImporters).toEqual([
      "apps/dashboard",
      "packages/numbers",
      "packages/reports",
    ]);
    expect(result.files).toEqual([
      "apps/dashboard/package.json",
      "deleted source.ts",
      "packages/colors/package.json",
      "packages/numbers/package.json",
      "packages/reports/package.json",
      "root.config.mjs",
    ]);
    expect(result.files).not.toContain("pnpm-lock.yaml");
    expect(result.files).not.toContain("package.json");
  });

  it("drops a formatting-only lockfile path without selecting unrelated projects", () => {
    const { root, lockfile } = createFixture();
    const state = parsed(lockfile);
    expect(
      projectAffectedFiles({ root, files: ["pnpm-lock.yaml"], before: state, after: state }),
    ).toEqual({
      files: [],
      dependencyImporters: [],
    });
    expect(
      projectAffectedFiles({ root, files: ["root.config.mjs"], before: state, after: state }),
    ).toEqual({
      files: ["root.config.mjs"],
      dependencyImporters: [],
    });
  });

  it.each(["root tooling", "boot tooling"])(
    "projects every existing importer for changed %s",
    (kind) => {
      const { root, lockfile } = createFixture();
      const before = parsed(lockfile, [{ tooling: "before" }]);
      if (kind === "root tooling") {
        lockfile.packages["tool@1.0.0"].resolution.integrity = "sha512-updated";
      }
      const after = parsed(lockfile, [{ tooling: kind === "boot tooling" ? "after" : "before" }]);
      expect(projectAffectedFiles({ root, files: ["pnpm-lock.yaml"], before, after })).toEqual({
        files: packagePaths,
        dependencyImporters: importerIds,
      });
    },
  );

  it("conservatively projects all importers when a lockfile baseline is missing", () => {
    const { root, lockfile } = createFixture();
    expect(
      projectAffectedFiles({
        root,
        files: ["pnpm-lock.yaml"],
        before: null,
        after: parsed(lockfile),
      }),
    ).toEqual({
      files: packagePaths,
      dependencyImporters: importerIds,
    });
  });

  it("projects root package.json for boot changes even without a project root importer", () => {
    const { root, lockfile } = createFixture();
    delete lockfile.importers["."];
    const before = parsed(lockfile, [{ tooling: "before" }]);
    const after = parsed(lockfile, [{ tooling: "after" }]);
    expect(projectAffectedFiles({ root, files: ["pnpm-lock.yaml"], before, after })).toEqual({
      files: packagePaths,
      dependencyImporters: importerIds,
    });
    writeLock(root, lockfile, [{ tooling: "before" }]);
    const original = fingerprint({ root, project: "packages/colors" });
    writeLock(root, lockfile, [{ tooling: "after" }]);
    expect(fingerprint({ root, project: "packages/colors" })).not.toBe(original);
  });

  it("does not invent package files for removed importers, but preserves real deletions", () => {
    const { root, lockfile } = createFixture();
    const before = parsed(lockfile);
    delete lockfile.importers["packages/colors"];
    unlinkSync(join(root, "packages/colors/package.json"));
    const result = projectAffectedFiles({
      root,
      files: ["pnpm-lock.yaml", "packages/colors/package.json", "packages/colors/src/removed.ts"],
      before,
      after: parsed(lockfile),
    });
    expect(result).toEqual({
      files: ["packages/colors/package.json", "packages/colors/src/removed.ts"],
      dependencyImporters: ["packages/colors"],
    });
    expect(
      projectAffectedFiles({ root, files: ["pnpm-lock.yaml"], before, after: parsed(lockfile) })
        .files,
    ).toEqual([]);
  });
});

describe("real git changes", () => {
  it("combines staged, unstaged, untracked, rename endpoints and deletions using NUL-safe paths", () => {
    const { root, lockfile } = createFixture();
    commitFixture(root);
    put(root, "root.config.mjs", "export default { changed: true };\n");
    put(root, "packages/reports/src/index.ts", "export const report = 2;\n");
    git(root, "add", "packages/reports/src/index.ts");
    const renamed = "packages/numbers/src/new name\nline.ts";
    renameSync(join(root, "packages/numbers/src/index.ts"), join(root, renamed));
    put(root, "new source.ts", "export const source = true;\n");
    put(root, "ignored.txt", "ignored\n");
    lockfile.packages["is-number@6.0.0"].resolution.integrity = "sha512-changed";
    writeLock(root, lockfile);

    const result = collectAffected({ root, base: "HEAD" });
    expect(result.dependencyImporters).toEqual([
      "apps/dashboard",
      "packages/numbers",
      "packages/reports",
    ]);
    expect(result.files).toEqual([
      "apps/dashboard/package.json",
      "new source.ts",
      "packages/numbers/package.json",
      "packages/numbers/src/index.ts",
      renamed,
      "packages/reports/package.json",
      "packages/reports/src/index.ts",
      "root.config.mjs",
    ]);
    expect(result.files).not.toContain("ignored.txt");
  });

  it("compares explicit revisions without mixing in working-tree files", () => {
    const { root, lockfile } = createFixture();
    const base = commitFixture(root);
    lockfile.packages["picocolors@1.1.1"].resolution.integrity = "sha512-new-color";
    writeLock(root, lockfile);
    git(root, "add", "pnpm-lock.yaml");
    git(root, "commit", "--quiet", "-m", "color resolution");
    put(root, "untracked.ts", "export {};\n");
    put(root, "root.config.mjs", "export default { dirty: true };\n");
    expect(collectAffected({ root, base, head: "HEAD" })).toEqual({
      files: ["packages/colors/package.json"],
      dependencyImporters: ["packages/colors"],
    });
    const output = captureOutput();
    expect(
      runCli(["affected", "--base", base, "--head", "HEAD", "--dry-run", "--", ":build"], {
        root,
        stdout: output.stdout,
      }),
    ).toBe(0);
    expect(JSON.parse(output.value())).toEqual(collectAffected({ root, base, head: "HEAD" }));
    expect(() =>
      runCli(["affected", "--base", base, "--head", "HEAD", "--", ":build"], { root }),
    ).toThrow(/clean working tree/);
    expect(() =>
      runCli(["affected", "--base", base, "--head", base, "--", ":build"], { root }),
    ).toThrow(/checked-out HEAD/);
  });

  it("uses a conservative projection for a revision without a lockfile", () => {
    const { root, lockfile } = createFixture();
    unlinkSync(join(root, "pnpm-lock.yaml"));
    commitFixture(root);
    writeLock(root, lockfile);
    expect(collectAffected({ root, base: "HEAD" })).toEqual({
      files: packagePaths,
      dependencyImporters: importerIds,
    });
    expect(() => collectAffected({ root, base: "not-a-real-ref" })).toThrow(/git rev-parse failed/);
  });

  it("preserves real manifest/config edits without requiring a lockfile change", () => {
    const { root } = createFixture();
    commitFixture(root);
    put(root, "packages/colors/package.json", JSON.stringify({ name: "colors", version: "2.0.0" }));
    put(root, "root.config.mjs", "export default { changed: true };\n");
    expect(collectAffected({ root, base: "HEAD" })).toEqual({
      files: ["packages/colors/package.json", "root.config.mjs"],
      dependencyImporters: [],
    });
  });

  it("conservatively projects a deleted current lockfile", () => {
    const { root } = createFixture();
    commitFixture(root);
    unlinkSync(join(root, "pnpm-lock.yaml"));
    expect(collectAffected({ root, base: "HEAD" })).toEqual({
      files: packagePaths,
      dependencyImporters: importerIds,
    });
  });

  it("reports no work without finding or invoking moon", () => {
    const { root } = createFixture();
    commitFixture(root);
    const output = captureOutput();
    expect(
      runCli(["affected", "--base", "HEAD", "--", ":build"], {
        root,
        stdout: output.stdout,
        environment: { PATH: "" },
      }),
    ).toBe(0);
    expect(output.value()).toBe("No changed files; no tasks to run.\n");
    const dry = captureOutput();
    expect(
      runCli(["affected", "--base", "HEAD", "--dry-run", "--", ":build"], {
        root,
        stdout: dry.stdout,
      }),
    ).toBe(0);
    expect(JSON.parse(dry.value())).toEqual({ files: [], dependencyImporters: [] });
  });
});

describe("native affected selection", () => {
  it("intersects native task actions with affected tasks without adding dependent task types", () => {
    const graph = {
      graph: {},
      data: {
        0: { action: "setup-toolchain", params: {} },
        1: { action: "run-task", params: { target: "numbers:build" } },
        2: { action: "run-task", params: { target: "reports:build" } },
        3: { action: "run-task", params: { target: "dashboard:build" } },
        4: { action: "run-task", params: { target: "colors:build" } },
        5: { action: "run-task", params: { target: "numbers:build", args: ["--mode=test"] } },
      },
    };
    const affected = {
      projects: {},
      tasks: {
        "numbers:build": { files: ["packages/numbers/src/index.ts"] },
        "reports:build": { upstream: ["numbers:build"] },
        "dashboard:build": { upstream: ["reports:build"] },
        "reports:test": { upstream: ["reports:build"] },
        "palette:build": { files: ["apps/palette/src/index.ts"] },
      },
    };
    expect(selectAffectedTargets(graph, affected)).toEqual([
      "dashboard:build",
      "numbers:build",
      "reports:build",
    ]);
  });

  it("retains affected upstream requirements already included by the native action graph", () => {
    const graph = {
      graph: {},
      data: {
        0: { action: "run-task", params: { target: "reports:test" } },
        1: { action: "run-task", params: { target: "reports:build" } },
        2: { action: "run-task", params: { target: "numbers:build" } },
      },
    };
    expect(
      selectAffectedTargets(graph, {
        tasks: { "numbers:build": {}, "reports:build": {}, "reports:test": {} },
      }),
    ).toEqual(["numbers:build", "reports:build", "reports:test"]);
    expect(selectAffectedTargets(graph, { tasks: {} })).toEqual([]);
    expect(selectAffectedTargets(graph, {})).toEqual([]);
    expect(
      selectAffectedTargets({ graph: {}, data: {} }, { tasks: { "reports:test": {} } }),
    ).toEqual([]);
  });

  it.each([
    [null, { tasks: {} }],
    [{}, { tasks: {} }],
    [{ graph: {}, data: [] }, { tasks: {} }],
    [{ graph: {}, data: {} }, { tasks: [] }],
    [{ graph: {}, data: { 0: { action: "run-task", params: {} } } }, { tasks: {} }],
    [{ graph: {}, data: { 0: { action: "run-task", params: { target: 42 } } } }, { tasks: {} }],
  ])(
    "rejects malformed native output instead of reporting no affected work: %j",
    (graph, affected) => {
      expect(() => selectAffectedTargets(graph, affected)).toThrow();
    },
  );
});

describe("native selection arguments", () => {
  it("separates contiguous native targets from execution flags and nested task arguments", () => {
    const args = [
      ":build",
      "reports:test",
      "#apps:build",
      "--no-actions",
      "--output-style",
      "buffer-only-failure",
      "--job=0",
      "--job-total",
      "2",
      "--summary",
      "minimal",
      "--",
      "--runInBand",
      ":not-a-target",
    ];
    expect(parseNativeSelectionArguments(args)).toEqual({
      targets: [":build", "reports:test", "#apps:build"],
      executionArgs: args.slice(3),
    });
    expect(parseNativeSelectionArguments([":build", "-f", "-i", "-s"])).toEqual({
      targets: [":build"],
      executionArgs: ["-f", "-i", "-s"],
    });
  });

  it.each([
    [":build", "--no-actions", ":test"],
    [":build", "--output-style"],
    [":build", "--job", "--no-actions"],
    [":build", "--unknown"],
    [":build", "--query", "task=build"],
    [":build", "--query=task=build"],
    [":build", "--plan=plan.json"],
    [":build", "-p", "plan.json"],
    [":build", "--affected"],
    [":build", "--stdin"],
    [":build", "-g"],
    [":build", "--downstream", "deep"],
    [":build", "--dependencies=none"],
    ["build"],
    ["~:build"],
    ["*:build"],
    ["numbers:*"],
  ])("rejects ambiguous or selection-changing arguments: %j", (...args) => {
    expect(() => parseNativeSelectionArguments(args)).toThrow();
  });
});

describe("dry-run native argument validation", () => {
  it("rejects unsupported selection flags before querying a repository", () => {
    const { root } = createFixture();
    expect(() =>
      runCli(["affected", "--base", "HEAD", "--dry-run", "--", ":build", "--query", "task=build"], {
        root,
      }),
    ).toThrow(/--query/);
  });
});

describe("CLI arguments", () => {
  it("preserves native moon arguments after the separator", () => {
    expect(
      parseArguments([
        "affected",
        "--base=HEAD",
        "--head",
        "HEAD",
        "--dry-run",
        "--",
        ":build",
        ":test",
        "--no-actions",
        "--output-style",
        "buffer-only-failure",
      ]),
    ).toEqual({
      command: "affected",
      base: "HEAD",
      head: "HEAD",
      dryRun: true,
      moonArgs: [":build", ":test", "--no-actions", "--output-style", "buffer-only-failure"],
    });
    expect(parseArguments(["fingerprint", "--project=packages/numbers"])).toEqual({
      command: "fingerprint",
      project: "packages/numbers",
    });
  });

  it.each([
    ["affected", "--", ":build"],
    ["affected", "--base", "HEAD"],
    ["affected", "--base", "HEAD", "--", "--no-actions"],
    ["affected", "--base", "HEAD", "--unknown", "--", ":build"],
    ["affected", "--base", "HEAD", "--base", "HEAD", "--", ":build"],
    ["affected", "--base", "--dry-run", "--", ":build"],
    ["fingerprint", "--project"],
    ["fingerprint", "--project="],
    ["fingerprint", "--unknown"],
  ])("rejects incomplete or unknown arguments: %j", (...args) => {
    expect(() => parseArguments(args)).toThrow();
  });
});
