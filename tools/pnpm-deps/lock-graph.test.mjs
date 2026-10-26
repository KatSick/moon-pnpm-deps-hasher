import { describe, expect, it } from "vitest";
import { changedImporters, projectSnapshot } from "./lock-graph.mjs";

const integrity = "sha512-Zml4dHVyZQ==";
const reference = (specifier, version) => ({ specifier, version });
const metadata = (extra = {}) => ({ resolution: { integrity }, ...extra });
const lockfile = (fields = {}) => ({
  lockfileVersion: "9.0",
  settings: { autoInstallPeers: true, excludeLinksFromLockfile: false },
  importers: {},
  packages: {},
  snapshots: {},
  ...fields,
});

function registryGraph() {
  return lockfile({
    importers: {
      "apps/web": { dependencies: { alpha: reference("^1.0.0", "1.0.0") } },
      "apps/other": { dependencies: { alpha: reference("^2.0.0", "2.0.0") } },
    },
    packages: {
      "alpha@1.0.0": metadata(),
      "alpha@2.0.0": metadata(),
      "leaf@1.0.0": metadata(),
      "leaf@2.0.0": metadata(),
      "optional-leaf@1.0.0": metadata({ optional: true }),
    },
    snapshots: {
      "alpha@1.0.0": {
        dependencies: { leaf: "1.0.0" },
        optionalDependencies: { "optional-leaf": "1.0.0" },
      },
      "alpha@2.0.0": { dependencies: { leaf: "2.0.0" } },
      "leaf@1.0.0": {},
      "leaf@2.0.0": {},
      "optional-leaf@1.0.0": {},
    },
  });
}

function workspaceGraph() {
  return lockfile({
    importers: {
      ".": { devDependencies: { tooling: reference("^1.0.0", "1.0.0") } },
      "apps/web": {
        dependencies: { "@repo/ui": reference("workspace:*", "link:../../packages/ui") },
      },
      "packages/ui": {
        dependencies: { "@repo/util": reference("workspace:*", "link:../util") },
        devDependencies: { checker: reference("^1.0.0", "1.0.0") },
        optionalDependencies: { platform: reference("^1.0.0", "1.0.0") },
      },
      "packages/util": {
        devDependencies: { "@repo/ui": reference("workspace:*", "link:../ui") },
      },
    },
    packages: {
      "tooling@1.0.0": metadata(),
      "checker@1.0.0": metadata(),
      "platform@1.0.0": metadata(),
    },
    snapshots: {
      "tooling@1.0.0": {},
      "checker@1.0.0": {},
      "platform@1.0.0": {},
    },
  });
}

function tarballGraph(withIntegrity = true) {
  const id = "archive@file:vendor/archive.tgz";
  return lockfile({
    importers: {
      ".": {
        dependencies: { archive: reference("file:vendor/archive.tgz", "file:vendor/archive.tgz") },
      },
    },
    packages: {
      [id]: {
        resolution: {
          tarball: "file:vendor/archive.tgz",
          ...(withIntegrity ? { integrity } : {}),
        },
      },
    },
    snapshots: { [id]: {} },
  });
}

function injectedWorkspaceGraph() {
  const graph = workspaceGraph();
  const id = "@repo/ui@file:packages/ui";
  graph.importers["apps/web"].dependencies["@repo/ui"] = reference(
    "file:../../packages/ui",
    "file:packages/ui",
  );
  graph.packages[id] = {
    resolution: { type: "directory", directory: "packages/ui" },
  };
  graph.snapshots[id] = {
    dependencies: { "@repo/util": "link:../util" },
  };
  return graph;
}

function freezeRecursively(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeRecursively(child);
    Object.freeze(value);
  }
  return value;
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

describe("projectSnapshot", () => {
  it("selects only the requested importer and its exact reachable package versions", () => {
    const snapshot = projectSnapshot(registryGraph(), "apps/web");

    expect(Object.keys(snapshot).sort()).toEqual([
      "catalogs",
      "globals",
      "importers",
      "lockfileVersion",
      "packages",
      "snapshots",
      "time",
    ]);
    expect(snapshot.lockfileVersion).toBe("9.0");
    expect(Object.keys(snapshot.importers)).toEqual(["apps/web"]);
    expect(Object.keys(snapshot.packages)).toEqual([
      "alpha@1.0.0",
      "leaf@1.0.0",
      "optional-leaf@1.0.0",
    ]);
    expect(Object.keys(snapshot.snapshots)).toEqual(Object.keys(snapshot.packages));
    expect(snapshot.globals.settings).toEqual({
      autoInstallPeers: true,
      excludeLinksFromLockfile: false,
    });
  });

  it("ignores unrelated graph mutations, including another version of the same package", () => {
    const before = registryGraph();
    const after = structuredClone(before);
    after.packages["alpha@2.0.0"].deprecated = "Only the other project uses this version";
    after.snapshots["alpha@2.0.0"].dependencies.leaf = "3.0.0";
    after.packages["leaf@3.0.0"] = metadata();
    after.snapshots["leaf@3.0.0"] = {};

    expect(projectSnapshot(after, "apps/web")).toEqual(projectSnapshot(before, "apps/web"));
    expect(changedImporters(before, after)).toEqual(["apps/other"]);
  });

  it("follows a transitive-only reference change without changing the importer", () => {
    const before = registryGraph();
    const after = structuredClone(before);
    after.snapshots["alpha@1.0.0"].dependencies.leaf = "3.0.0";
    after.packages["leaf@3.0.0"] = metadata();
    after.snapshots["leaf@3.0.0"] = {};

    const snapshot = projectSnapshot(after, "apps/web");
    expect(snapshot.importers).toEqual(projectSnapshot(before, "apps/web").importers);
    expect(snapshot.snapshots["alpha@1.0.0"].dependencies.leaf).toBe("3.0.0");
    expect(Object.hasOwn(snapshot.packages, "leaf@3.0.0")).toBe(true);
    expect(Object.hasOwn(snapshot.packages, "leaf@1.0.0")).toBe(false);
    expect(changedImporters(before, after)).toEqual(["apps/web"]);
  });

  it.each(["leaf@1.0.0", "optional-leaf@1.0.0"])(
    "includes metadata-only changes in a reached transitive package: %s",
    (id) => {
      const before = registryGraph();
      const after = structuredClone(before);
      after.packages[id].resolution.integrity = "sha512-Y2hhbmdlZA==";

      expect(projectSnapshot(after, "apps/web")).not.toEqual(projectSnapshot(before, "apps/web"));
      expect(changedImporters(before, after)).toEqual(["apps/web"]);
    },
  );

  it("traverses optional snapshot edges and notices their replacement and removal", () => {
    const before = registryGraph();
    const replaced = structuredClone(before);
    replaced.snapshots["alpha@1.0.0"].optionalDependencies["optional-leaf"] = "2.0.0";
    replaced.packages["optional-leaf@2.0.0"] = metadata({ optional: true });
    replaced.snapshots["optional-leaf@2.0.0"] = {};

    expect(Object.keys(projectSnapshot(replaced, "apps/web").snapshots)).toContain(
      "optional-leaf@2.0.0",
    );
    expect(changedImporters(before, replaced)).toEqual(["apps/web"]);

    const removed = structuredClone(before);
    delete removed.snapshots["alpha@1.0.0"].optionalDependencies;
    expect(Object.keys(projectSnapshot(removed, "apps/web").snapshots)).not.toContain(
      "optional-leaf@1.0.0",
    );
    expect(changedImporters(before, removed)).toEqual(["apps/web"]);
  });

  it("keeps full nested peer and patch contexts while using base package metadata", () => {
    const context = "widget@1.0.0(@scope/peer@2.0.0(other@3.0.0))(patch_hash=abc)";
    const otherContext = "widget@1.0.0(@scope/peer@4.0.0)(patch_hash=abc)";
    const graph = lockfile({
      importers: {
        "apps/web": { dependencies: { widget: reference("^1.0.0", context) } },
        "apps/other": { dependencies: { widget: reference("^1.0.0", otherContext) } },
      },
      packages: {
        "widget@1.0.0": metadata({ peerDependencies: { "@scope/peer": "*" } }),
        "@scope/peer@2.0.0": metadata(),
        "@scope/peer@4.0.0": metadata(),
      },
      snapshots: {
        [context]: { dependencies: { "@scope/peer": "2.0.0" } },
        [otherContext]: { dependencies: { "@scope/peer": "4.0.0" } },
        "@scope/peer@2.0.0": {},
        "@scope/peer@4.0.0": {},
      },
    });
    graph.time = {
      "widget@1.0.0": "2026-01-01T00:00:00.000Z",
      [context]: "2026-01-02T00:00:00.000Z",
      [otherContext]: "2026-01-03T00:00:00.000Z",
    };

    const snapshot = projectSnapshot(graph, "apps/web");
    expect(Object.keys(snapshot.snapshots)).toEqual(["@scope/peer@2.0.0", context]);
    expect(Object.keys(snapshot.packages)).toEqual(["@scope/peer@2.0.0", "widget@1.0.0"]);
    expect(Object.hasOwn(snapshot.snapshots, otherContext)).toBe(false);
    expect(snapshot.time).toEqual({
      "widget@1.0.0": graph.time["widget@1.0.0"],
      [context]: graph.time[context],
    });

    const after = structuredClone(graph);
    after.importers["apps/web"].dependencies.widget.version = otherContext;
    expect(changedImporters(graph, after)).toEqual(["apps/web"]);
  });

  it("prefers metadata for the exact snapshot ID before stripping peer context", () => {
    const id = "widget@1.0.0(peer@2.0.0)";
    const graph = lockfile({
      importers: { ".": { dependencies: { widget: reference("^1.0.0", id) } } },
      packages: {
        [id]: metadata({ cpu: ["arm64"] }),
        "widget@1.0.0": metadata({ cpu: ["x64"] }),
      },
      snapshots: { [id]: {} },
    });

    expect(projectSnapshot(graph, ".").packages).toEqual({ [id]: graph.packages[id] });
  });

  it("resolves bare versions with scoped peer references without confusing peer @ signs for aliases", () => {
    const id = "widget@1.0.0(@scope/peer@2.0.0)";
    const graph = lockfile({
      importers: {
        ".": { dependencies: { widget: reference("^1.0.0", "1.0.0(@scope/peer@2.0.0)") } },
      },
      packages: { "widget@1.0.0": metadata() },
      snapshots: { [id]: {} },
    });

    expect(Object.keys(projectSnapshot(graph, ".").snapshots)).toEqual([id]);
  });

  it.each([
    ["actual@2.0.0", "npm:actual@^2.0.0", "actual@2.0.0"],
    ["@scope/actual@2.0.0", "npm:@scope/actual@^2.0.0", "@scope/actual@2.0.0"],
    ["2.0.0", "npm:@scope/actual@^2.0.0", "@scope/actual@2.0.0"],
  ])("resolves npm aliases using the real package: %s", (version, specifier, id) => {
    const graph = lockfile({
      importers: { ".": { dependencies: { friendly: reference(specifier, version) } } },
      packages: { [id]: metadata() },
      snapshots: { [id]: {} },
    });

    const snapshot = projectSnapshot(graph, ".");
    expect(Object.keys(snapshot.packages)).toEqual([id]);
    expect(Object.keys(snapshot.snapshots)).toEqual([id]);
    expect(snapshot.importers["."].dependencies.friendly).toEqual(reference(specifier, version));
  });

  it.each(["https://host.test/package.tgz", "git+ssh://git@host.test/repository#0123456789abcdef"])(
    "qualifies opaque locators without mistaking URL userinfo for an alias: %s",
    (locator) => {
      const id = `archive@${locator}`;
      const graph = lockfile({
        importers: {
          ".": { dependencies: { archive: reference(locator, locator) } },
        },
        packages: {
          [id]: { resolution: { tarball: locator, integrity } },
        },
        snapshots: { [id]: {} },
      });

      const snapshot = projectSnapshot(graph, ".");
      expect(Object.keys(snapshot.packages)).toEqual([id]);
      expect(Object.keys(snapshot.snapshots)).toEqual([id]);
      expect(snapshot.packages[id].resolution).toEqual({ tarball: locator, integrity });
    },
  );

  it("resolves full npm alias IDs on transitive snapshot edges", () => {
    const graph = registryGraph();
    graph.snapshots["alpha@1.0.0"].dependencies.friendly = "@scope/actual@3.0.0";
    graph.packages["@scope/actual@3.0.0"] = metadata();
    graph.snapshots["@scope/actual@3.0.0"] = {};

    expect(Object.keys(projectSnapshot(graph, "apps/web").snapshots)).toContain(
      "@scope/actual@3.0.0",
    );
  });

  it("closes workspace dependency chains and cycles across all importer dependency sections", () => {
    const graph = workspaceGraph();
    const snapshot = projectSnapshot(graph, "apps/web");

    expect(Object.keys(snapshot.importers)).toEqual(["apps/web", "packages/ui", "packages/util"]);
    expect(Object.keys(snapshot.packages)).toEqual(["checker@1.0.0", "platform@1.0.0"]);
    expect(snapshot.importers["packages/util"]).toEqual(graph.importers["packages/util"]);

    const after = structuredClone(graph);
    after.packages["checker@1.0.0"].engines = { node: ">=22" };
    expect(changedImporters(graph, after)).toEqual(["apps/web", "packages/ui", "packages/util"]);
  });

  it("includes injected directory metadata, workspace importers and links relative to that directory", () => {
    const graph = injectedWorkspaceGraph();
    const snapshot = projectSnapshot(graph, "apps/web");

    expect(Object.keys(snapshot.importers)).toEqual(["apps/web", "packages/ui", "packages/util"]);
    expect(Object.keys(snapshot.packages)).toEqual([
      "@repo/ui@file:packages/ui",
      "checker@1.0.0",
      "platform@1.0.0",
    ]);
    expect(snapshot.snapshots["@repo/ui@file:packages/ui"]).toEqual({
      dependencies: { "@repo/util": "link:../util" },
    });

    const after = structuredClone(graph);
    after.importers["packages/util"].optionalDependencies = {
      platform: reference("~1.0.0", "1.0.0"),
    };
    expect(changedImporters(graph, after)).toEqual(["apps/web", "packages/ui", "packages/util"]);
  });

  it("handles a root self-link without automatically merging root tooling into other projects", () => {
    const graph = workspaceGraph();
    graph.importers["."].dependencies = { self: reference("workspace:*", "link:") };

    expect(Object.keys(projectSnapshot(graph, ".").importers)).toEqual(["."]);
    expect(Object.keys(projectSnapshot(graph, "apps/web").importers)).not.toContain(".");
    expect(Object.keys(projectSnapshot(graph, "apps/web").packages)).not.toContain("tooling@1.0.0");

    const after = structuredClone(graph);
    after.packages["tooling@1.0.0"].engines = { node: ">=22" };
    expect(changedImporters(graph, after)).toEqual(["."]);
  });

  it("includes only time entries matching reached metadata or full snapshot IDs", () => {
    const graph = registryGraph();
    graph.time = {
      "alpha@1.0.0": "2026-01-01T00:00:00.000Z",
      "leaf@1.0.0": "2026-01-02T00:00:00.000Z",
      "alpha@2.0.0": "2026-01-03T00:00:00.000Z",
      created: "2025-01-01T00:00:00.000Z",
    };

    expect(projectSnapshot(graph, "apps/web").time).toEqual({
      "alpha@1.0.0": graph.time["alpha@1.0.0"],
      "leaf@1.0.0": graph.time["leaf@1.0.0"],
    });
    const after = structuredClone(graph);
    after.time["alpha@2.0.0"] = "2026-02-01T00:00:00.000Z";
    expect(changedImporters(graph, after)).toEqual(["apps/other"]);
  });

  it("canonicalizes nested maps while preserving arrays and leaving frozen input unchanged", () => {
    const graph = registryGraph();
    graph.packages["leaf@1.0.0"].os = ["linux", "darwin"];
    graph.packages["leaf@1.0.0"].engines = { pnpm: ">=9", node: ">=20" };
    graph.importers["apps/web"].dependenciesMeta = {
      alpha: { injected: false, custom: { z: 2, a: 1 } },
    };
    graph.snapshots["alpha@1.0.0"].transitivePeerDependencies = ["z-peer", "a-peer"];
    const original = structuredClone(graph);
    const reordered = reverseMaps(graph);
    freezeRecursively(graph);
    freezeRecursively(reordered);

    const snapshot = projectSnapshot(graph, "apps/web");
    expect(JSON.stringify(snapshot)).toBe(JSON.stringify(projectSnapshot(reordered, "apps/web")));
    expect(changedImporters(graph, reordered)).toEqual([]);
    expect(snapshot.packages["leaf@1.0.0"].os).toEqual(["linux", "darwin"]);
    expect(snapshot.snapshots["alpha@1.0.0"].transitivePeerDependencies).toEqual([
      "z-peer",
      "a-peer",
    ]);
    expect(Object.keys(snapshot.packages["leaf@1.0.0"].engines)).toEqual(["node", "pnpm"]);
    expect(Object.keys(snapshot.importers["apps/web"].dependenciesMeta.alpha.custom)).toEqual([
      "a",
      "z",
    ]);
    expect(graph).toEqual(original);
  });

  it("preserves and detects raw importer, snapshot and metadata fields", () => {
    const before = registryGraph();
    const after = structuredClone(before);
    after.importers["apps/web"].dependenciesMeta = { alpha: { injected: true } };
    after.snapshots["alpha@1.0.0"].transitivePeerDependencies = ["peer"];
    after.packages["leaf@1.0.0"].engines = { node: ">=22" };

    const snapshot = projectSnapshot(after, "apps/web");
    expect(snapshot.importers["apps/web"].dependenciesMeta).toEqual({ alpha: { injected: true } });
    expect(snapshot.snapshots["alpha@1.0.0"].transitivePeerDependencies).toEqual(["peer"]);
    expect(snapshot.packages["leaf@1.0.0"].engines).toEqual({ node: ">=22" });
    expect(changedImporters(before, after)).toEqual(["apps/web"]);
  });

  it("supports local file tarballs when package metadata provides integrity", () => {
    const graph = tarballGraph();
    const snapshot = projectSnapshot(graph, ".");

    expect(Object.keys(snapshot.packages)).toEqual(["archive@file:vendor/archive.tgz"]);
    expect(snapshot.packages["archive@file:vendor/archive.tgz"].resolution.integrity).toBe(
      integrity,
    );
    expect(Object.keys(snapshot.snapshots)).toEqual(["archive@file:vendor/archive.tgz"]);

    const after = structuredClone(graph);
    after.packages["archive@file:vendor/archive.tgz"].resolution.integrity = "sha512-Y2hhbmdlZA==";
    expect(changedImporters(graph, after)).toEqual(["."]);
  });
});

describe("catalog selection and conservative globals", () => {
  function catalogGraph() {
    const graph = registryGraph();
    graph.importers["apps/web"].dependencies.alpha.specifier = "catalog:";
    graph.importers["apps/other"].dependencies.alpha.specifier = "catalog:modern";
    graph.catalogs = {
      default: {
        alpha: reference("^1.0.0", "1.0.0"),
        unused: reference("^9.0.0", "9.0.0"),
      },
      modern: { alpha: reference("^2.0.0", "2.0.0") },
    };
    return graph;
  }

  it("selects only referenced default and named catalog entries", () => {
    const graph = catalogGraph();
    expect(projectSnapshot(graph, "apps/web").catalogs).toEqual({
      default: { alpha: reference("^1.0.0", "1.0.0") },
    });
    expect(projectSnapshot(graph, "apps/other").catalogs).toEqual({
      modern: { alpha: reference("^2.0.0", "2.0.0") },
    });

    const unrelated = structuredClone(graph);
    unrelated.catalogs.default.unused.specifier = "~9.0.0";
    expect(changedImporters(graph, unrelated)).toEqual([]);

    const referenced = structuredClone(graph);
    referenced.catalogs.default.alpha.specifier = "~1.0.0";
    expect(changedImporters(graph, referenced)).toEqual(["apps/web"]);
  });

  it("collects catalog references from reachable workspace importers", () => {
    const graph = workspaceGraph();
    graph.importers["packages/ui"].devDependencies.checker.specifier = "catalog:tools";
    graph.catalogs = { tools: { checker: reference("^1.0.0", "1.0.0") } };

    expect(projectSnapshot(graph, "apps/web").catalogs).toEqual(graph.catalogs);
    const after = structuredClone(graph);
    after.catalogs.tools.checker.specifier = "~1.0.0";
    expect(changedImporters(graph, after)).toEqual(["apps/web", "packages/ui", "packages/util"]);
  });

  it("uses an npm alias target from a referenced catalog entry", () => {
    const graph = lockfile({
      importers: { ".": { dependencies: { friendly: reference("catalog:", "2.0.0") } } },
      catalogs: { default: { friendly: reference("npm:@scope/actual@^2.0.0", "2.0.0") } },
      packages: { "@scope/actual@2.0.0": metadata() },
      snapshots: { "@scope/actual@2.0.0": {} },
    });

    expect(Object.keys(projectSnapshot(graph, ".").snapshots)).toEqual(["@scope/actual@2.0.0"]);
  });

  it.each([
    ["settings", { autoInstallPeers: false, excludeLinksFromLockfile: false }],
    ["packageExtensionsChecksum", "different-checksum"],
    ["futureResolverSetting", { nested: { z: false, a: true } }],
  ])("preserves and conservatively invalidates every importer for %s changes", (field, value) => {
    const before = registryGraph();
    const after = structuredClone(before);
    after[field] = value;

    expect(projectSnapshot(after, "apps/web").globals[field]).toEqual(value);
    expect(changedImporters(before, after)).toEqual(["apps/other", "apps/web"]);
  });

  it("excludes override declarations because the resolved graph captures their effects", () => {
    const before = registryGraph();
    const after = structuredClone(before);
    after.overrides = {
      alpha: "3.0.0",
      "not-in-this-graph": "9.0.0",
    };

    const snapshot = projectSnapshot(after, "apps/web");
    expect(Object.hasOwn(snapshot.globals, "overrides")).toBe(false);
    expect(snapshot).toEqual(projectSnapshot(before, "apps/web"));
    expect(changedImporters(before, after)).toEqual([]);
  });

  it("ignores unrelated patch declarations instead of globally invalidating importers", () => {
    const before = registryGraph();
    const after = structuredClone(before);
    after.patchedDependencies = {
      "unrelated@1.0.0": { hash: "abc", path: "patches/unrelated.patch" },
    };

    expect(projectSnapshot(after, "apps/web")).toEqual(projectSnapshot(before, "apps/web"));
    expect(changedImporters(before, after)).toEqual([]);

    const changed = structuredClone(after);
    changed.patchedDependencies["unrelated@1.0.0"].hash = "def";
    expect(changedImporters(after, changed)).toEqual([]);
  });

  it("selects patch declarations by reached package version", () => {
    const graph = registryGraph();
    graph.patchedDependencies = {
      "alpha@1.0.0": { hash: "one", path: "patches/alpha-one.patch" },
      "alpha@2.0.0": { hash: "two", path: "patches/alpha-two.patch" },
      "unrelated@1.0.0": { hash: "other", path: "patches/unrelated.patch" },
    };

    expect(projectSnapshot(graph, "apps/web").globals.patchedDependencies).toEqual({
      "alpha@1.0.0": graph.patchedDependencies["alpha@1.0.0"],
    });
    expect(projectSnapshot(graph, "apps/other").globals.patchedDependencies).toEqual({
      "alpha@2.0.0": graph.patchedDependencies["alpha@2.0.0"],
    });

    const after = structuredClone(graph);
    after.patchedDependencies["alpha@1.0.0"].hash = "changed";
    expect(changedImporters(graph, after)).toEqual(["apps/web"]);
  });

  it.each(["hash", "path"])("detects a reached optional package patch %s change", (field) => {
    const before = registryGraph();
    before.patchedDependencies = {
      "optional-leaf@1.0.0": { hash: "one", path: "patches/optional-leaf.patch" },
    };
    const after = structuredClone(before);
    after.patchedDependencies["optional-leaf@1.0.0"][field] = "changed";

    expect(changedImporters(before, after)).toEqual(["apps/web"]);
  });

  it("applies name-only patches to every reached version of that package", () => {
    const before = registryGraph();
    before.patchedDependencies = {
      alpha: { hash: "one", path: "patches/alpha.patch" },
    };
    const after = structuredClone(before);
    after.patchedDependencies.alpha.hash = "changed";

    expect(projectSnapshot(after, "apps/web").globals.patchedDependencies).toEqual(
      after.patchedDependencies,
    );
    expect(changedImporters(before, after)).toEqual(["apps/other", "apps/web"]);
  });

  it("tracks range patches through resolved snapshot hashes rather than declarations", () => {
    const before = registryGraph();
    before.patchedDependencies = {
      "alpha@^1.0.0": { hash: "one", path: "patches/alpha-range.patch" },
      "alpha@^2.0.0": { hash: "one", path: "patches/other-alpha-range.patch" },
    };
    before.importers["apps/web"].dependencies.alpha.version = "1.0.0(patch_hash=one)";
    before.snapshots["alpha@1.0.0(patch_hash=one)"] = before.snapshots["alpha@1.0.0"];
    delete before.snapshots["alpha@1.0.0"];

    const snapshot = projectSnapshot(before, "apps/web");
    expect(Object.keys(snapshot.globals.patchedDependencies ?? {})).toEqual([]);
    expect(Object.keys(snapshot.snapshots)).toContain("alpha@1.0.0(patch_hash=one)");
    expect(
      Object.keys(projectSnapshot(before, "apps/other").globals.patchedDependencies ?? {}),
    ).toEqual([]);

    const declarationsOnly = structuredClone(before);
    declarationsOnly.patchedDependencies["alpha@^1.0.0"].hash = "changed";
    expect(projectSnapshot(declarationsOnly, "apps/web")).toEqual(snapshot);
    expect(changedImporters(before, declarationsOnly)).toEqual([]);

    const after = structuredClone(before);
    after.patchedDependencies["alpha@^1.0.0"].hash = "changed";
    after.importers["apps/web"].dependencies.alpha.version = "1.0.0(patch_hash=changed)";
    after.snapshots["alpha@1.0.0(patch_hash=changed)"] =
      after.snapshots["alpha@1.0.0(patch_hash=one)"];
    delete after.snapshots["alpha@1.0.0(patch_hash=one)"];

    const updatedSnapshot = projectSnapshot(after, "apps/web");
    expect(Object.keys(updatedSnapshot.globals.patchedDependencies ?? {})).toEqual([]);
    expect(Object.keys(updatedSnapshot.snapshots)).toContain("alpha@1.0.0(patch_hash=changed)");
    expect(Object.keys(updatedSnapshot.snapshots)).not.toContain("alpha@1.0.0(patch_hash=one)");
    expect(changedImporters(before, after)).toEqual(["apps/web"]);
  });
});

describe("changedImporters", () => {
  it("returns a sorted union including new and removed importers", () => {
    const before = registryGraph();
    before.importers["z-removed"] = {};
    const after = structuredClone(before);
    delete after.importers["z-removed"];
    after.importers["a-added"] = {};
    after.importers["apps/web"].dependencies.alpha.specifier = "~1.0.0";

    expect(changedImporters(before, after)).toEqual(["a-added", "apps/web", "z-removed"]);
    expect(changedImporters(after, before)).toEqual(["a-added", "apps/web", "z-removed"]);
    expect(changedImporters(before, structuredClone(before))).toEqual([]);
  });

  it.each(["dependencies", "devDependencies", "optionalDependencies"])(
    "detects addition and removal in importer %s",
    (section) => {
      const before = registryGraph();
      const after = structuredClone(before);
      after.importers["apps/web"][section] = {
        ...after.importers["apps/web"][section],
        extra: reference("^1.0.0", "1.0.0"),
      };
      after.packages["extra@1.0.0"] = metadata();
      after.snapshots["extra@1.0.0"] = {};

      expect(Object.keys(projectSnapshot(after, "apps/web").packages)).toContain("extra@1.0.0");
      expect(changedImporters(before, after)).toEqual(["apps/web"]);
      expect(changedImporters(after, before)).toEqual(["apps/web"]);
    },
  );
});

describe("invalid or unresolved lockfile graphs", () => {
  it("rejects unsupported lockfile versions", () => {
    const graph = registryGraph();
    graph.lockfileVersion = "6.0";
    expect(() => projectSnapshot(graph, "apps/web")).toThrow(/version|schema|pnpm.*9/i);
  });

  it("rejects a missing requested importer", () => {
    expect(() => projectSnapshot(registryGraph(), "apps/missing")).toThrow(/importer/i);
  });

  it.each(["configDependencies", "packageManagerDependencies"])(
    "rejects a boot/tooling importer containing %s",
    (field) => {
      const graph = lockfile({ importers: { ".": { [field]: {} } } });
      expect(() => projectSnapshot(graph, ".")).toThrow(/boot|tooling/i);
    },
  );

  it.each([
    [
      "direct snapshot",
      (graph) => {
        delete graph.snapshots["alpha@1.0.0"];
      },
      /snapshot/i,
    ],
    [
      "transitive snapshot",
      (graph) => {
        delete graph.snapshots["leaf@1.0.0"];
      },
      /snapshot/i,
    ],
    [
      "optional snapshot",
      (graph) => {
        delete graph.snapshots["optional-leaf@1.0.0"];
      },
      /snapshot/i,
    ],
    [
      "package metadata",
      (graph) => {
        delete graph.packages["leaf@1.0.0"];
      },
      /package|metadata/i,
    ],
    [
      "optional package metadata",
      (graph) => {
        delete graph.packages["optional-leaf@1.0.0"];
      },
      /package|metadata/i,
    ],
    [
      "direct dependency object",
      (graph) => {
        graph.importers["apps/web"].dependencies.alpha = "1.0.0";
      },
      /dependency|specifier|version|object/i,
    ],
    [
      "boot-document dependency",
      (graph) => {
        graph.importers["apps/web"].dependencies.alpha = { specifier: "^1.0.0" };
      },
      /boot|version|resolved|dependency/i,
    ],
    [
      "dependency without a specifier",
      (graph) => {
        graph.importers["apps/web"].dependencies.alpha = { version: "1.0.0" };
      },
      /specifier/i,
    ],
    [
      "legacy importer schema",
      (graph) => {
        graph.importers["apps/web"].specifiers = { alpha: "^1.0.0" };
      },
      /schema|specifier|v9/i,
    ],
    [
      "unresolved workspace protocol",
      (graph) => {
        graph.importers["apps/web"].dependencies.alpha = reference("workspace:*", "workspace:*");
      },
      /workspace|unresolved/i,
    ],
    [
      "external workspace link",
      (graph) => {
        graph.importers["apps/web"].dependencies.alpha = reference(
          "workspace:*",
          "link:../../../outside",
        );
      },
      /link|workspace|importer/i,
    ],
    [
      "snapshot-level workspace link",
      (graph) => {
        graph.snapshots["alpha@1.0.0"].dependencies.leaf = "link:../leaf";
      },
      /link|snapshot|unsupported|ambiguous/i,
    ],
  ])("rejects a missing or unsupported %s", (_label, mutate, category) => {
    const graph = registryGraph();
    mutate(graph);
    expect(() => projectSnapshot(graph, "apps/web")).toThrow(category);
  });

  it.each(["catalog:", "catalog:missing"])(
    "rejects a missing referenced catalog or catalog entry: %s",
    (specifier) => {
      const graph = registryGraph();
      graph.importers["apps/web"].dependencies.alpha.specifier = specifier;
      graph.catalogs = { default: {} };
      expect(() => projectSnapshot(graph, "apps/web")).toThrow(/catalog/i);
    },
  );

  it("rejects a local directory with no corresponding workspace importer", () => {
    const graph = injectedWorkspaceGraph();
    graph.packages["@repo/ui@file:packages/ui"].resolution.directory = "external/ui";

    expect(() => projectSnapshot(graph, "apps/web")).toThrow(/directory|workspace|importer/i);
  });

  it("rejects file tarballs without content integrity", () => {
    expect(() => projectSnapshot(tarballGraph(false), ".")).toThrow(/integrity|tarball/i);
  });
});
