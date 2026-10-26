import { posix } from "node:path";

const DEPENDENCY_GROUPS = ["dependencies", "devDependencies", "optionalDependencies"];
const GRAPH_FIELDS = new Set([
  "lockfileVersion",
  "importers",
  "packages",
  "snapshots",
  "catalogs",
  "time",
  "overrides",
  "patchedDependencies",
]);

function fail(message) {
  throw new Error(`Invalid or unsupported pnpm lockfile: ${message}`);
}

function record(value, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    fail(`${label} must be a plain object`);
  }
  return value;
}

function string(value, label, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    fail(`${label} must be ${allowEmpty ? "a string" : "a nonempty string"}`);
  }
  return value;
}

function has(object, key) {
  return Object.hasOwn(object, key);
}

// A structural value, not a digest: callers can serialize/hash it however they need.
// Sorting every map also handles metadata, without mutating the parsed YAML object.
function canonical(value, label, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object") fail(`${label} must contain only JSON-compatible values`);
  if (ancestors.has(value)) fail(`${label} contains a cyclic YAML/object value`);
  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((entry, index) => canonical(entry, `${label}[${index}]`, ancestors));
  } else {
    record(value, label);
    if (Object.getOwnPropertySymbols(value).length) {
      fail(`${label} must contain only string map keys`);
    }
    result = Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key], `${label}.${key}`, ancestors)]),
    );
  }
  ancestors.delete(value);
  return result;
}

function importerPath(value, label) {
  string(value, label);
  if (
    value.includes("\\") ||
    posix.isAbsolute(value) ||
    value === ".." ||
    value.startsWith("../") ||
    posix.normalize(value) !== value
  ) {
    fail(`${label} must be a normalized path relative to the lockfile directory`);
  }
  return value;
}

function graphFrom(lockfile) {
  record(lockfile, "lockfile");
  // Unquoted YAML 9.0 is the number 9. Other schema versions are not inferred.
  if (lockfile.lockfileVersion !== "9.0" && lockfile.lockfileVersion !== 9) {
    fail(`lockfileVersion ${JSON.stringify(lockfile.lockfileVersion)}; expected pnpm schema 9.0`);
  }
  const importers = record(lockfile.importers, "importers");
  const packages = has(lockfile, "packages") ? record(lockfile.packages, "packages") : {};
  const snapshots = has(lockfile, "snapshots") ? record(lockfile.snapshots, "snapshots") : {};
  const catalogs = has(lockfile, "catalogs") ? record(lockfile.catalogs, "catalogs") : {};
  const time = has(lockfile, "time") ? record(lockfile.time, "time") : {};
  const patchedDependencies = has(lockfile, "patchedDependencies")
    ? record(lockfile.patchedDependencies, "patchedDependencies")
    : {};
  const globals = canonical(
    Object.fromEntries(Object.entries(lockfile).filter(([key]) => !GRAPH_FIELDS.has(key))),
    "global settings",
  );
  return { importers, packages, snapshots, catalogs, time, patchedDependencies, globals };
}

// pnpm's refToRelative rules: an @ inside a peer suffix or URL is not an alias.
// https://github.com/pnpm/pnpm/blob/v9.15.9/packages/dependency-path/src/index.ts
function snapshotId(reference, dependencyName) {
  if (reference.startsWith("@")) return reference;
  const at = reference.indexOf("@");
  const colon = reference.indexOf(":");
  const bracket = reference.indexOf("(");
  if (at !== -1 && (colon === -1 || at < colon) && (bracket === -1 || at < bracket)) {
    return reference;
  }
  return `${dependencyName}@${reference}`;
}

function aliasName(specifier, dependencyName) {
  if (!specifier.startsWith("npm:")) return dependencyName;
  const target = specifier.slice(4);
  const separator = target.indexOf("@", 1);
  const name = separator === -1 ? target : target.slice(0, separator);
  if (!/^(?:@[^/@\s]+\/)?[^/@:\s]+$/.test(name)) {
    fail(`invalid npm alias specifier ${JSON.stringify(specifier)}`);
  }
  return name;
}

// Find the longest matching metadata ID, peeling only balanced trailing groups.
// This preserves nested peer contexts and paths that themselves contain parentheses.
function packageId(id, packages) {
  let candidate = id;
  while (!has(packages, candidate) && candidate.endsWith(")")) {
    let depth = 0;
    let opening = -1;
    for (let index = candidate.length - 1; index >= 0; index -= 1) {
      if (candidate[index] === ")") depth += 1;
      if (candidate[index] === "(") depth -= 1;
      if (depth === 0) {
        opening = index;
        break;
      }
    }
    if (opening <= 0) break;
    candidate = candidate.slice(0, opening);
  }
  if (!has(packages, candidate))
    fail(`missing package metadata for snapshot ${JSON.stringify(id)}`);
  return candidate;
}

function selectedPatches(declarations, packages) {
  const selected = new Map();
  for (const [id, metadata] of packages) {
    const separator = id.indexOf("@", 1);
    const name = typeof metadata.name === "string" ? metadata.name : id.slice(0, separator);
    const version =
      typeof metadata.version === "string" ? metadata.version : id.slice(separator + 1);
    for (const selector of [name, `${name}@${version}`]) {
      if (has(declarations, selector)) selected.set(selector, declarations[selector]);
    }
  }
  // Ranged patch selectors need no semver reimplementation: their installed
  // content identity is already in the complete snapshot's (patch_hash=...) suffix.
  // In particular, identical hashes shared by unrelated ranges are not extra inputs.
  return Object.fromEntries(selected);
}

function buildSnapshot(graph, importerId) {
  importerPath(importerId, "importer ID");
  if (!has(graph.importers, importerId)) fail(`missing importer ${JSON.stringify(importerId)}`);

  const importers = new Map();
  const packages = new Map();
  const snapshots = new Map();
  const catalogs = new Map();
  const pending = [{ kind: "importer", id: importerId }];

  function linkedImporter(owner, reference, label) {
    if (owner === null) {
      fail(
        `${label}: link: references inside non-workspace package snapshots have no supported base directory`,
      );
    }
    const relative = reference.slice(5);
    if (relative.includes("\\") || posix.isAbsolute(relative)) {
      fail(
        `${label}: external link: references are unsupported; target must be a workspace importer`,
      );
    }
    const target = posix.normalize(posix.join(owner, relative));
    importerPath(target, `${label} link: target`);
    if (!has(graph.importers, target)) {
      fail(`${label}: link: target ${JSON.stringify(target)} has no workspace importer`);
    }
    pending.push({ kind: "importer", id: target });
  }

  function edge(name, reference, owner, label, specifier = "") {
    string(name, `${label} dependency name`);
    string(reference, `${label} version`);
    if (reference.startsWith("link:")) {
      linkedImporter(owner, reference, label);
    } else {
      if (reference.startsWith("workspace:")) {
        fail(
          `${label}: unresolved workspace: version; expected a resolved link: or file: reference`,
        );
      }
      pending.push({ kind: "snapshot", id: snapshotId(reference, aliasName(specifier, name)) });
    }
  }

  function catalogSpecifier(name, specifier, label) {
    if (!specifier.startsWith("catalog:")) return specifier;
    const catalogName = specifier.slice(8) || "default";
    if (!has(graph.catalogs, catalogName))
      fail(`${label}: missing catalog ${JSON.stringify(catalogName)}`);
    const catalog = record(graph.catalogs[catalogName], `catalogs.${catalogName}`);
    if (!has(catalog, name)) fail(`${label}: missing catalog entry ${catalogName}.${name}`);
    const entry = record(catalog[name], `catalogs.${catalogName}.${name}`);
    string(entry.specifier, `catalogs.${catalogName}.${name}.specifier`, true);
    string(entry.version, `catalogs.${catalogName}.${name}.version`);
    if (entry.specifier.startsWith("catalog:")) {
      fail(`${label}: nested catalog: entries are unsupported`);
    }
    if (!catalogs.has(catalogName)) catalogs.set(catalogName, new Map());
    catalogs.get(catalogName).set(name, entry);
    return entry.specifier;
  }

  function includeImporter(id) {
    if (importers.has(id)) return;
    importerPath(id, "importer ID");
    const importer = record(graph.importers[id], `importers.${id}`);
    if (has(importer, "configDependencies") || has(importer, "packageManagerDependencies")) {
      fail(
        `importers.${id} belongs to a boot/tooling document; pass the final project document and hash boot tooling separately`,
      );
    }
    if (has(importer, "specifiers")) {
      fail(
        `importers.${id} uses an unsupported schema; expected serialized v9 { specifier, version } dependency entries`,
      );
    }
    importers.set(id, importer);
    for (const group of DEPENDENCY_GROUPS) {
      if (!has(importer, group)) continue;
      const dependencies = record(importer[group], `importers.${id}.${group}`);
      for (const [name, value] of Object.entries(dependencies)) {
        const label = `importers.${id}.${group}.${name}`;
        const dependency = record(value, label);
        string(dependency.specifier, `${label}.specifier`, true);
        const specifier = catalogSpecifier(name, dependency.specifier, label);
        edge(name, dependency.version, id, label, specifier);
      }
    }
  }

  function includeSnapshot(id) {
    if (snapshots.has(id)) return;
    if (!has(graph.snapshots, id)) fail(`missing dependency snapshot ${JSON.stringify(id)}`);
    const snapshot = record(graph.snapshots[id], `snapshots.${id}`);
    const baseId = packageId(id, graph.packages);
    const metadata = record(graph.packages[baseId], `packages.${baseId}`);
    const resolution = record(metadata.resolution, `packages.${baseId}.resolution`);
    snapshots.set(id, snapshot);
    packages.set(baseId, metadata);

    let localImporter = null;
    if (resolution.type === "directory") {
      const directory = string(resolution.directory, `packages.${baseId}.resolution.directory`);
      localImporter = importerPath(posix.normalize(directory), `packages.${baseId} directory`);
      if (!has(graph.importers, localImporter)) {
        fail(
          `local directory ${JSON.stringify(directory)} has no workspace importer; external file: directories require source hashing outside this lockfile-only API`,
        );
      }
      pending.push({ kind: "importer", id: localImporter });
    } else if (
      baseId.includes("@file:") ||
      baseId.startsWith("file:") ||
      (typeof resolution.tarball === "string" && resolution.tarball.startsWith("file:"))
    ) {
      if (typeof resolution.integrity !== "string" || resolution.integrity.length === 0) {
        fail(
          `file: tarball ${JSON.stringify(baseId)} needs resolution.integrity; mutable local archives cannot be tracked from the lockfile alone`,
        );
      }
    }

    for (const group of ["dependencies", "optionalDependencies"]) {
      if (!has(snapshot, group)) continue;
      const dependencies = record(snapshot[group], `snapshots.${id}.${group}`);
      for (const [name, reference] of Object.entries(dependencies)) {
        edge(name, reference, localImporter, `snapshots.${id}.${group}.${name}`);
      }
    }
  }

  // Iteration avoids call-stack limits; the maps also terminate package/workspace cycles.
  while (pending.length) {
    const { kind, id } = pending.pop();
    if (kind === "importer") includeImporter(id);
    else includeSnapshot(id);
  }

  const time = new Map();
  for (const id of new Set([...packages.keys(), ...snapshots.keys()])) {
    if (has(graph.time, id)) time.set(id, graph.time[id]);
  }
  return canonical(
    {
      lockfileVersion: "9.0",
      globals: {
        ...graph.globals,
        patchedDependencies: selectedPatches(graph.patchedDependencies, packages),
      },
      catalogs: Object.fromEntries(
        [...catalogs].map(([name, entries]) => [name, Object.fromEntries(entries)]),
      ),
      importers: Object.fromEntries(importers),
      packages: Object.fromEntries(packages),
      snapshots: Object.fromEntries(snapshots),
      time: Object.fromEntries(time),
    },
    "project snapshot",
  );
}

/**
 * Select the complete dependency closure of one importer from a parsed pnpm v9
 * project document, including workspace links, peer instances and resolution metadata.
 *
 * pnpm 12 still writes schema 9.0, but may prepend a separate boot/tooling YAML
 * document: callers must parse all documents and pass the last one here.
 * https://pnpm.io/lockfile
 * https://github.com/pnpm/spec/blob/master/lockfile/9.0.md
 *
 * Root tooling is deliberately not merged. Global settings/checksums are conservative
 * inputs; catalogs/publication times and exact/name-only patches are reachability
 * scoped. Ranged patches use installed snapshot patch_hash identity. Overrides are
 * resolution policy, not installed content: effective changes appear in resolved refs.
 * Workspace local-directory sources are NOT read/hashed here. External links and
 * directory sources, unpinned file tarballs and unresolved workspace: locators fail
 * instead of pretending their contents can be identified by a lockfile snapshot.
 */
export function projectSnapshot(lockfileObject, importerId) {
  return buildSnapshot(graphFrom(lockfileObject), importerId);
}

/** Return sorted importer IDs whose dependency closures differ, including added/removed IDs. */
export function changedImporters(before, after) {
  const previous = graphFrom(before);
  const next = graphFrom(after);
  return [...new Set([...Object.keys(previous.importers), ...Object.keys(next.importers)])]
    .sort()
    .filter((id) => {
      const beforeSnapshot = has(previous.importers, id) ? buildSnapshot(previous, id) : undefined;
      const afterSnapshot = has(next.importers, id) ? buildSnapshot(next, id) : undefined;
      return JSON.stringify(beforeSnapshot) !== JSON.stringify(afterSnapshot);
    });
}
