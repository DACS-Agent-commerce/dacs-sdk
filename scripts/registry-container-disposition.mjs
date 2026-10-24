#!/usr/bin/env node
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { runtimeImageInventory, RUNTIME_IMAGE_INVENTORY_SCHEMA } from "./runtime-image-inventory.mjs";
import { pathToFileURL } from "node:url";
import { join, posix } from "node:path";
import { createHash } from "node:crypto";
// Pure classification of observed advisory IDs against the curated baseline.
const advisoryId = /^GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}$/;

function validIds(ids) {
  return Array.isArray(ids) && [...ids].every(id => typeof id === "string" && advisoryId.test(id)) &&
    new Set(ids).size === ids.length;
}

// Each assessment names where its reachability assessment is recorded.
const validAssessments = entries => Array.isArray(entries) && [...entries].every(entry => typeof entry === "object" &&
  entry !== null && typeof entry.id === "string" && advisoryId.test(entry.id) && typeof entry.assessment === "string" &&
  entry.assessment.trim() !== "") && new Set(entries.map(entry => entry.id)).size === entries.length;

/** Classifies advisory IDs into sorted observed, unlisted, assessed and direct arrays.
 * Direct IDs are high/critical advisories on direct consumer dependencies.
 * Throws if the baseline, observed IDs or direct IDs are malformed or inconsistent. */
export function classifyRegistryAudit(observedAdvisories, baseline, directAdvisories = []) {
  const assessments = baseline?.assessedAdvisories;
  if (baseline?.schema !== "dacs-registry-audit-baseline/v1" ||
      typeof baseline.source?.commit !== "string" || !/^[a-f0-9]{40}$/.test(baseline.source.commit) ||
      typeof baseline.source?.job !== "string" || !/^[1-9][0-9]*$/.test(baseline.source.job) ||
      baseline.source?.url !== `https://github.com/DACS-Agent-commerce/dacs-sdk/runs/${baseline.source.job}` ||
      typeof baseline.source?.evidence !== "string" || !baseline.source.evidence.trim() ||
      !validIds(baseline.advisoryIds) || !validAssessments(assessments) ||
      assessments.some(({ id }) => baseline.advisoryIds.includes(id)) || !validIds(observedAdvisories) ||
      !validIds(directAdvisories) || directAdvisories.some(id => !observedAdvisories.includes(id))) {
    throw new Error("malformed registry audit baseline or observed advisory IDs");
  }
  const known = new Set(baseline.advisoryIds);
  const assessed = new Set(assessments.map(({ id }) => id));
  return { observedAdvisories: [...observedAdvisories].sort(),
    unlistedAdvisories: observedAdvisories.filter(id => !known.has(id) && !assessed.has(id)).sort(),
    assessedAdvisories: observedAdvisories.filter(id => assessed.has(id)).sort(),
    directAdvisories: [...directAdvisories].sort() };
}


// The consumer installs registry packages only. This is an allowlist: every
// installed (non-root) lock entry resolves to a tarball under the configured
// registry's origin and path and carries an integrity, and every dependency
// spec in the manifest and the lock is a registry spec (a version, range or
// tag, or an npm: alias of one) in a plain-object dependency map. Anything else
// is a violation: dependency maps that are arrays, strings or null, Git URLs and
// GitHub/GitLab shorthands with or without a ref, tarballs on any other host
// (codeload.github.com included), file:, link:, paths, entries without
// `resolved` or `integrity`, and `overrides`.
const digestBytes = { sha1: 20, sha256: 32, sha384: 48, sha512: 64 };
function validIntegrity(value) {
  return typeof value === "string" && value.trim() !== "" && value.trim().split(/\s+/).every(token => {
    const match = /^(sha1|sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})(?:\?[!-~]+)?$/.exec(token);
    if (!match) return false;
    const bytes = Buffer.from(match[2], "base64");
    return bytes.length === digestBytes[match[1]] && bytes.toString("base64") === match[2];
  });
}
const specFields = ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"];
const isPlainObject = value => typeof value === "object" && value !== null && !Array.isArray(value);

// Use the executing npm's parser, including loose semver and alias-name rules.
// Acceptance pins npm; this keeps dependency grammar separate from engine ranges.
let npmPackageArg;
function registrySourceSpec(value) {
  if (typeof value !== "string") return false;
  if (!npmPackageArg) {
    const npmEntry = process.env.npm_execpath ?? join(execFileSync("npm", ["root", "--global"],
      { encoding: "utf8" }).trim(), "npm/bin/npm-cli.js");
    npmPackageArg = createRequire(npmEntry)("npm-package-arg");
  }
  try {
    const parsed = npmPackageArg.resolve("dependency", value);
    // Older npm parsers (npm 10.8) read `npm:node_modules` as an alias with no
    // package name instead of refusing it.
    return parsed.registry === true && (parsed.type !== "alias" || typeof parsed.subSpec?.name === "string");
  } catch { return false; }
}

// The run's own registry: HTTPS, or the loopback Verdaccio the acceptance
// script starts (reached as host.docker.internal from a non-Linux container).
export function consumerRegistry(value) {
  const registry = new URL(value);
  if (!(registry.protocol === "https:" || (registry.protocol === "http:" &&
      ["127.0.0.1", "localhost", "host.docker.internal"].includes(registry.hostname)))) {
    throw new Error(`registry dependency policy needs an HTTPS or loopback registry, not ${value}`);
  }
  return { origin: registry.origin, path: registry.pathname.endsWith("/") ? registry.pathname : registry.pathname + "/" };
}

export function registryDependencyViolations({ manifest, lock, registry }) {
  const { origin, path } = consumerRegistry(registry);
  const violations = [];
  if (!isPlainObject(manifest)) violations.push({ location: "package.json", field: "manifest", value: null });
  if (isPlainObject(lock?.packages) && !isPlainObject(lock.packages[""])) violations.push({ location: "package-lock.json", field: "root", value: null });
  const specs = (location, owner) => {
    for (const field of specFields) {
      // A present map that is not a plain object (an array, a string, null)
      // has no specs to check, so it is a violation itself.
      if (owner?.[field] !== undefined && !isPlainObject(owner[field])) {
        violations.push({ location, field, value: JSON.stringify(owner[field]) });
        continue;
      }
      for (const [name, value] of Object.entries(owner?.[field] ?? {})) {
        if (!registrySourceSpec(value)) {
          violations.push({ location, field: `${field}.${name}`, value });
        }
      }
    }
  };
  specs("package.json", manifest);
  for (const [location, owner] of [["package.json", manifest], ["", lock?.packages?.[""]]]) {
    if (owner?.overrides !== undefined) violations.push({ location, field: "overrides", value: JSON.stringify(owner.overrides) });
  }
  if (!isPlainObject(lock?.packages)) return [...violations, { location: "package-lock.json", field: "packages", value: null }];
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (!isPlainObject(entry)) { violations.push({ location, field: "entry", value: JSON.stringify(entry) }); continue; }
    specs(location, entry);
    if (location === "") continue;
    let url = null;
    try { url = typeof entry.resolved === "string" ? new URL(entry.resolved) : null; } catch { /* not a URL */ }
    const invalidLink = entry.link !== undefined && entry.link !== false;
    if (invalidLink || url === null || url.origin !== origin || !url.pathname.startsWith(path)) {
      violations.push({ location, field: invalidLink ? "link" : "resolved", value: entry.resolved ?? null });
    }
    if (!validIntegrity(entry.integrity)) {
      violations.push({ location, field: "integrity", value: entry.integrity ?? null });
    }
  }
  return violations;
}

// The `npm:` aliases declared for a candidate, with the location of the
// package declaring each ("" for the root manifest).
const moduleFileExtensions = [".js", ".json", ".node"];
function candidateAliases(manifest, packages, candidate) {
  const aliases = [];
  for (const [ownerLocation, owner] of [["", manifest], ...Object.entries(packages)]) {
    for (const field of specFields) {
      for (const [alias, spec] of Object.entries(isPlainObject(owner?.[field]) ? owner[field] : {})) {
        if (typeof spec === "string" && /^npm:/i.test(spec) && registrySourceSpec(spec) &&
            npmPackageArg.resolve(alias, spec).subSpec?.name === candidate) aliases.push({ ownerLocation, alias });
      }
    }
  }
  return aliases;
}

// Resolve declared candidate aliases with Node's nearest node_modules lookup,
// including hoisting. Installed identity cannot identify a substituted alias.
function candidateAliasLocations(manifest, packages, inventory, candidate) {
  const available = new Set(inventory ? inventory.map(item => item.location) : Object.keys(packages));
  const locations = new Set();
  for (const { ownerLocation, alias } of candidateAliases(manifest, packages, candidate)) {
    const parts = ownerLocation ? ownerLocation.split("/") : [];
    for (;;) {
      if (parts.at(-1) !== "node_modules") {
        const location = [...parts, "node_modules", alias].join("/");
        const found = [location, ...moduleFileExtensions.map(extension => location + extension)]
          .filter(path => available.has(path));
        if (found.length) { for (const path of found) locations.add(path); break; }
      }
      if (parts.length === 0) break;
      parts.pop();
    }
  }
  return [...locations];
}

// Node resolves a package from any node_modules directory above the importing
// file, so a copy below a package's own files (`dist/node_modules`) is used by
// that package. The inventory lists only `<package>/node_modules`, so this
// returns every other node_modules entry inside an installed package directory,
// as paths relative to it. With `names`, it returns only those entries holding
// a module of one of those names or a file shadowing one. Links are not
// followed, except a scope directory that is a link, which Node does follow; a
// missing directory has none.
export function nestedModuleRoots(directory, names) {
  const roots = [];
  const list = current => {
    try { return readdirSync(current, { withFileTypes: true }); }
    catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return [];
      throw error;
    }
  };
  const holdsNamedModule = root => list(root).some(entry => {
    const found = entry.name.startsWith("@") && (entry.isDirectory() || entry.isSymbolicLink())
      ? list(join(root, entry.name)).map(inner => `${entry.name}/${inner.name}`) : [entry.name];
    return found.some(module => names.has(module) ||
      moduleFileExtensions.some(extension => module.endsWith(extension) && names.has(module.slice(0, -extension.length))));
  });
  const visit = (current, prefix) => {
    for (const entry of list(current)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.name === "node_modules") {
        if (prefix && (!names || holdsNamedModule(join(current, entry.name)))) roots.push(path);
        // Packages inside a nested root may hold further roots of their own.
        if (prefix && entry.isDirectory()) visit(join(current, entry.name), path);
      } else if (entry.isDirectory()) visit(join(current, entry.name), path);
    }
  };
  visit(directory, "");
  return roots;
}

// Every installed copy of a candidate package, top-level, nested or aliased,
// must be the packed release-set tarball that release-provenance.json records,
// at the release's version both in the lock and, when `installedManifest`
// reads it, in the installed package.json.
export function candidateIntegrityErrors({ manifest, lock, registry, candidates, installedManifest, installedInventory, installedModuleRoots }) {
  const { origin, path } = consumerRegistry(registry);
  const packages = isPlainObject(lock?.packages) ? lock.packages : {};
  const inventory = installedInventory ?? [];
  const isBinEntry = item => /\/\.bin\/[^/]+$/.test(item.location);
  const errors = inventory.filter(item => item.link === true && !isBinEntry(item))
    .map(item => "cannot inspect linked installed packages: " + item.location);
  // The inventory does not descend into `.bin`, but Node resolves packages from
  // a `node_modules` directory there. Only a link to a file is an executable;
  // an entry that may be a directory is not inspected, so it is refused.
  errors.push(...inventory.filter(item => isBinEntry(item) && item.target === undefined && item.error === undefined)
    .map(item => "cannot inspect a .bin entry that is not an executable link: " + item.location));
  errors.push(...inventory.filter(item => /(^|\/)node_modules\/(@[^/]+\/)?node_modules$/.test(item.location))
    .map(item => "cannot inspect a node_modules directory inside node_modules or a scope directory: " + item.location));
  const candidateLocations = new Set();
  const candidateNames = new Set(candidates.map(candidate => candidate.name));
  for (const { name, integrity, version } of candidates) {
    for (const { alias } of candidateAliases(manifest, packages, name)) candidateNames.add(alias);
    if (typeof version !== "string" || version === "") {
      errors.push("candidate record has no release version: " + name);
      continue;
    }
    const candidateLocation = location => typeof location === "string" &&
      (location === "node_modules/" + name || location.endsWith("/node_modules/" + name));
    const locations = [...new Set([...Object.keys(packages).filter(location => candidateLocation(location) || packages[location]?.name === name),
      ...inventory.filter(item => item.name === name || candidateLocation(item.location) ||
        (typeof item.location === "string" && moduleFileExtensions.some(extension =>
          item.location.endsWith(extension) && candidateLocation(item.location.slice(0, -extension.length)))))
        .map(item => item.location),
      ...candidateAliasLocations(manifest, packages, installedInventory, name)])];
    if (!locations.includes("node_modules/" + name)) errors.push("candidate package is not installed at the top level: " + name);
    for (const location of locations) {
      candidateLocations.add(location);
      const entry = packages[location];
      if (installedInventory && location !== "node_modules/" + name &&
          (entry?.optional === true || entry?.dev === true || entry?.devOptional === true) &&
          !inventory.some(item => item.location === location)) continue;
      for (const root of installedModuleRoots?.(location) ?? []) {
        errors.push("cannot inspect node_modules inside an installed candidate: " + location + "/" + root);
      }
      if (!entry) { errors.push("installed candidate has no lock entry: " + location); continue; }
      let url = null;
      try { url = new URL(entry?.resolved); } catch { /* not a URL */ }
      if (url === null || url.origin !== origin || !url.pathname.startsWith(path)) {
        errors.push("candidate package did not resolve through the isolated registry: " + location);
      } else if (entry.integrity !== integrity) {
        errors.push("candidate package integrity does not match the packed tarball: " + location +
          " (expected " + integrity + ", observed " + String(entry.integrity) + ")");
      }
      if (entry.name !== undefined && entry.name !== name) errors.push("candidate package lock name does not match the release: " + location);
      if (entry?.version !== version) {
        errors.push("candidate package lock version does not match the release: " + location +
          " (expected " + version + ", observed " + String(entry?.version) + ")");
      }
      if (installedManifest) {
        let manifest;
        try { manifest = installedManifest(location); }
        catch (error) {
          errors.push("installed candidate package is not the release: " + location + " (cannot read manifest: " +
            (error?.code ?? error?.name ?? "Error") + ": " + (error?.message ?? String(error)) + ")");
          continue;
        }
        if (manifest?.name !== name || manifest?.version !== version) {
          errors.push("installed candidate package is not the release: " + location + " (expected " + name + "@" +
            version + ", observed " + String(manifest?.name) + "@" + String(manifest?.version) + ")");
        }
      }
    }
  }
  // Any other installed package may hold a candidate below its own files too.
  for (const { location } of inventory.filter(item => !isBinEntry(item) && item.link !== true && !candidateLocations.has(item.location))) {
    for (const root of installedModuleRoots?.(location, candidateNames) ?? []) {
      errors.push("cannot inspect a candidate inside node_modules in an installed package: " + location + "/" + root);
    }
  }
  return errors;
}

// npm prints `network timeout at:` (code FETCH_ERROR) for a request timeout and
// `Response timeout while trying to fetch` for a body timeout.
// npm's EBADENGINE check (npm-install-checks) tests each non-optional package's
// engines.node and engines.npm with semver.satisfies(current, range,
// { includePrerelease: true }). This is that range grammar for a release
// version. Anything else throws, so a range it cannot read never passes.
const versionId = "0|[1-9]\\d{0,15}";
const rangeId = `${versionId}|x|X|\\*`;
const prereleaseId = "(?:0|[1-9]\\d*|\\d*[a-zA-Z-][a-zA-Z0-9-]*)";
const partialVersion = `v?(${rangeId})(?:\\.(${rangeId})(?:\\.(${rangeId})(?:-(${prereleaseId}(?:\\.${prereleaseId})*))?` +
  "?)?)?(?:\\+[a-zA-Z0-9-]+(?:\\.[a-zA-Z0-9-]+)*)?";
const rangeToken = new RegExp(`^(<=|>=|<|>|=|~>|~|\\^)?${partialVersion}$`);
const hyphenRange = new RegExp(`^${partialVersion} - ${partialVersion}$`);
const MAX_SEMVER_LENGTH = 256;
const isX = id => id === undefined || id === "x" || id === "X" || id === "*";
// semver 7.8.5, which the pinned npm 11.19.0 bundles, rejects a plain
// comparator with a numeric part after an X (`1.x.0`, `>=1.x.0`, `*.1.2`), so
// npm reports EBADENGINE for it; it still reads tildes, carets and hyphen
// ranges with one (`~1.x.0`, `^x.1`, `1.x.0 - 2`).
const validVersionBound = (M, m, p, prerelease) =>
  [M, m, p].every(id => isX(id) || Number.isSafeInteger(Number(id))) &&
  `${isX(M) ? 0 : M}.${isX(m) ? 0 : m}.${isX(p) ? 0 : p}${prerelease === undefined ? "" : "-" + prerelease}`.length <= MAX_SEMVER_LENGTH;
const numericAfterX = (M, m, p) => (isX(M) && !(isX(m) && isX(p))) || (isX(m) && !isX(p));

// One token's comparators, [operator, [major, minor, patch], prerelease?], as
// semver desugars carets, tildes and X-ranges. [] is any version.
function tokenComparators(token) {
  const match = rangeToken.exec(token);
  // Concrete plain comparators retain v; expansions drop it.
  const retained = match && !match.slice(2, 5).some(isX) && !/^[~^]/.test(match[1] ?? "");
  if (!match || (retained && token.replace(/^[<>=]+/, "").length > MAX_SEMVER_LENGTH) ||
      !validVersionBound(match[2], match[3], match[4], match[5]) || (!/^[~^]/.test(match[1] ?? "") && numericAfterX(match[2], match[3], match[4]))) {
    throw new Error(`unsupported engine range token ${JSON.stringify(token)}`);
  }
  const [, operator = "", M, m, p, prerelease] = match;
  const [major, minor, patch] = [M, m, p].map(Number);
  if (isX(M)) return operator === ">" || operator === "<" ? [["none"]] : [];
  if (operator === "^" || operator === "~" || operator === "~>") {
    if (isX(m)) return [[">=", [major, 0, 0]], ["<", [major + 1, 0, 0]]];
    const upper = operator !== "^" ? [major, minor + 1, 0] : major > 0 ? [major + 1, 0, 0]
      : isX(p) || minor > 0 ? [0, minor + 1, 0] : [0, 0, patch + 1];
    return [[">=", [major, minor, isX(p) ? 0 : patch]], ["<", upper]];
  }
  if (isX(m) || isX(p)) {
    const bound = isX(m) ? [major, 0, 0] : [major, minor, 0];
    const next = isX(m) ? [major + 1, 0, 0] : [major, minor + 1, 0];
    // semver: >1 is >=2.0.0, <=1.2 is <1.3.0, and =1.2 is 1.2.x.
    if (operator === ">") return [[">=", next]];
    if (operator === "<=") return [["<", next]];
    if (operator === ">=" || operator === "<") return [[operator, bound]];
    return [[">=", bound], ["<", next]];
  }
  return [[operator || "=", [major, minor, patch], prerelease !== undefined]];
}

// A hyphen range, `a - b`, includes every version of a partial upper bound.
function hyphenComparators([, fM, fm, fp, , tM, tm, tp, tpr]) {
  const from = isX(fM) ? [] : [[">=", [Number(fM), isX(fm) ? 0 : Number(fm), isX(fm) || isX(fp) ? 0 : Number(fp)]]];
  const to = isX(tM) ? [] : isX(tm) ? [["<", [Number(tM) + 1, 0, 0]]] : isX(tp) ? [["<", [Number(tM), Number(tm) + 1, 0]]]
    : [["<", [Number(tM), Number(tm), Number(tp) + (tpr === undefined ? 1 : 0)]]];
  return [...from, ...to];
}

const compareVersions = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
function testComparator(version, [operator, bound, prerelease = false]) {
  if (operator === "none") return false;
  const order = compareVersions(version, bound);
  // A release is above every prerelease of its own version and equal to none.
  if (prerelease) return operator === ">" || operator === ">=" ? order >= 0 : operator === "<" || operator === "<=" ? order < 0 : false;
  return operator === "<" ? order < 0 : operator === "<=" ? order <= 0 : operator === ">" ? order > 0
    : operator === ">=" ? order >= 0 : order === 0;
}

const releaseVersion = value => {
  const match = typeof value === "string" ? new RegExp(`^v?(${versionId})\\.(${versionId})\\.(${versionId})$`).exec(value) : null;
  return match && match.slice(1).every(id => Number.isSafeInteger(Number(id))) ? match.slice(1).map(Number) : null;
};

// semver.satisfies for a release version; throws for a range it cannot read.
export function satisfiesEngineRange(current, range) {
  const version = releaseVersion(current);
  if (version === null || typeof range !== "string") {
    throw new Error(`unsupported engine check ${JSON.stringify(current)} against ${JSON.stringify(range)}`);
  }
  // Every set is parsed before any is tested: semver rejects the whole range.
  const sets = range.replace(/\+[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*/g, "")
    .trim().replace(/\s+/g, " ").split("||").map(part => {
    const set = part.trim();
    const hyphen = hyphenRange.exec(set);
    if (hyphen) {
      const [from, to] = set.split(" - ");
      const concreteFrom = !hyphen.slice(1, 4).some(isX);
      tokenComparators(concreteFrom ? ">=" + from + (hyphen[4] === undefined ? "-0" : "") : "~" + from);
      tokenComparators("~" + to);
      return hyphenComparators(hyphen);
    }
    // `>= 1.2` is `>=1.2`, as semver trims an operator's trailing space.
    const tokens = [];
    for (const token of set === "" ? [] : set.split(" ")) {
      if (/^(?:<=|>=|<|>|=|~>|~|\^)$/.test(tokens.at(-1) ?? "") && /^v?[0-9xX*]/.test(token)) tokens.push(tokens.pop() + token);
      else tokens.push(token);
    }
    return tokens.flatMap(tokenComparators);
  });
  if (sets.some(set => set.some(([, bound]) => bound?.some(part => !Number.isSafeInteger(part))))) {
    throw new Error(`unsupported expanded engine range bound in ${JSON.stringify(range)}`);
  }
  return sets.some(set => set.every(comparator => testComparator(version, comparator)));
}

// Lists every engine violation in the generated lock, as npm's EBADENGINE
// check would for the consumer container's Node and npm, without npm ci's
// package.json/lock sync check (which a nested Git dependency fails). The scan
// is complete only when every non-optional entry was evaluated.
export function scanLockEngines(lock, versions) {
  const packages = lock?.packages;
  const current = { node: versions?.node, npm: versions?.npm };
  const errors = [];
  if (!isPlainObject(packages) || !isPlainObject(packages[""])) errors.push("lock has no packages map");
  for (const key of ["node", "npm"]) {
    if (releaseVersion(current[key]) === null) errors.push(`no recorded ${key} release version`);
  }
  const violations = [];
  let evaluatedPackages = 0;
  for (const [location, entry] of errors.length ? [] : Object.entries(packages)) {
    if (!isPlainObject(entry)) { errors.push(`${location}: unreadable lock entry`); continue; }
    // npm checks only packages that are not optional.
    if (entry.optional === true) continue;
    const engines = entry.engines;
    try {
      const failed = engines ? ["node", "npm"].filter(key => engines[key] && !satisfiesEngineRange(current[key], engines[key])) : [];
      evaluatedPackages += 1;
      if (failed.length) {
        const name = entry.name ?? (location === "" ? lock.name : location.split(/(?:^|\/)node_modules\//).at(-1));
        violations.push({ package: `${name}@${entry.version}`, location, integrity: entry.integrity ?? null, required: engines });
      }
    } catch (error) { errors.push(`${location}: ${error.message}`); }
  }
  return { scanComplete: errors.length === 0, node: current.node ?? null, npm: current.npm ?? null,
    evaluatedPackages, errors, violations };
}

// Compares the final image's package inventory with the lock's production
// closure: every lock entry that is not dev-only, which is what `npm ci` and
// `npm prune --omit=dev` leave. An optional entry may be absent (the image
// omits optional dependencies, or the platform skips them). Each image package
// outside the closure, or at another name or version than the lock records
// there, is `unexpected`; each required closure entry the image lacks is
// `missing`. An unreadable inventory or entry leaves the scan incomplete.
// Executable links in .bin must target a file declared by a locked production package.
export function runtimeImageInventoryFindings(inventory, lock) {
  const packages = isPlainObject(lock?.packages) ? lock.packages : null;
  if (packages === null || !isPlainObject(packages[""])) {
    return { scanComplete: false, errors: ["the generated lock has no packages"], unexpected: [], missing: [] };
  }
  const malformed = Object.entries(packages).filter(([location, entry]) => !isPlainObject(entry) ||
    (location.startsWith("node_modules/") && entry.link !== true &&
      (typeof entry.version !== "string" || !entry.version.trim())));
  if (malformed.length) return { scanComplete: false,
    errors: malformed.map(([location]) => `malformed generated lock entry: ${location}`), unexpected: [], missing: [] };
  if (inventory?.schema !== RUNTIME_IMAGE_INVENTORY_SCHEMA || !Array.isArray(inventory.packages)) {
    return { scanComplete: false, errors: [`runtime-image-inventory.json is not ${RUNTIME_IMAGE_INVENTORY_SCHEMA}`],
      unexpected: [], missing: [] };
  }
  const closure = new Map(Object.entries(packages)
    .filter(([location, entry]) => location.startsWith("node_modules/") && entry?.dev !== true));
  const binTargets = new Map();
  for (const [location, entry] of closure) {
    if (!isPlainObject(entry.bin)) continue;
    const modules = location.replace(/(?:@[^/]+\/)?[^/]+$/, "");
    for (const [command, target] of Object.entries(entry.bin)) {
      if (command.includes("/") || typeof target !== "string" || !target) continue;
      const resolved = posix.join(location, target);
      if (!resolved.startsWith(`${location}/`)) continue;
      const binLocation = `${modules}.bin/${command}`;
      if (!binTargets.has(binLocation)) binTargets.set(binLocation, new Set());
      binTargets.get(binLocation).add(resolved);
    }
  }
  const errors = [];
  const unexpected = [];
  const seen = new Set();
  for (const item of inventory.packages) {
    const location = item?.location;
    if (item?.link === true && !item.error && binTargets.has(location) &&
        binTargets.get(location).has(item.target) && !seen.has(location)) {
      seen.add(location);
      continue;
    }
    const identity = typeof location === "string" && /^node_modules\/(?:.+\/node_modules\/)?((?:@[^/]+\/)?[^/@.][^/]*)$/.exec(location);
    if (!identity ||
        typeof item.name !== "string" || !item.name.trim() ||
        typeof item.version !== "string" || !item.version.trim() || seen.has(location)) {
      errors.push("unreadable runtime-image inventory entry: " + JSON.stringify(item));
      continue;
    }
    seen.add(location);
    const entry = closure.get(location);
    const name = entry?.name ?? identity[1];
    if (entry === undefined || entry.version !== item.version || name !== item.name) {
      unexpected.push({ name: item.name, location, version: item.version,
        integrity: packages[location]?.integrity ?? null });
    }
  }
  const missing = [...closure]
    .filter(([location, entry]) => !seen.has(location) && entry?.optional !== true && entry?.devOptional !== true)
    .map(([location]) => location);
  return { scanComplete: errors.length === 0, errors, unexpected, missing };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode] = process.argv.slice(2);
  if (mode === "--dependency-policy") {
    const [project, registry, report, releaseSet, version] = process.argv.slice(3);
    if (report) rmSync(report, { force: true });
    if (!project || !registry || !report || !releaseSet || !version) {
      throw new Error("usage: --dependency-policy <project> <registry> <report> <release-set> <version>");
    }
    const manifest = JSON.parse(readFileSync(join(project, "package.json"), "utf8"));
    const lock = JSON.parse(readFileSync(join(project, "package-lock.json"), "utf8"));
    for (const name of ["@kynesyslabs/dacs", "@kynesyslabs/dacs-node", "@kynesyslabs/demosdk", "@x402/core", "@x402/evm",
      "@x402/fetch", "better-sqlite3", "viem"]) {
      if (typeof manifest.dependencies?.[name] !== "string") throw new Error("dual-rail consumer is missing " + name);
    }
    // The packed tarball and its release-provenance.json record must agree
    // before either is compared with the consumer's lock.
    const provenance = JSON.parse(readFileSync(join(releaseSet, "release-provenance.json"), "utf8"));
    if (provenance?.version !== version) throw new Error(`release-provenance.json is not for version ${version}`);
    const candidates = ["@kynesyslabs/dacs", "@kynesyslabs/dacs-node"].map(name => {
      const archive = join(releaseSet, `${name.slice(1).replace("/", "-")}-${version}.tgz`);
      const integrity = "sha512-" + createHash("sha512").update(readFileSync(archive)).digest("base64");
      const recorded = provenance.packages?.[name]?.integrity;
      if (recorded !== integrity) {
        throw new Error(`release-provenance.json records ${String(recorded)} for ${name}, but the packed tarball is ${integrity}`);
      }
      return { name, integrity, version };
    });
    const errors = candidateIntegrityErrors({ manifest, lock, registry, candidates, installedInventory: runtimeImageInventory(project).packages,
      installedModuleRoots: (location, names) => nestedModuleRoots(join(project, location), names),
      installedManifest: location => JSON.parse(readFileSync(join(project, location, "package.json"), "utf8")) });
    if (errors.length) throw new Error(errors.join("\n"));
    const violations = registryDependencyViolations({ manifest, lock, registry });
    writeFileSync(report, JSON.stringify({ schema: "dacs-registry-dependency-policy/v1", passed: violations.length === 0,
      violations }, null, 2) + "\n");
  } else {
    throw new Error("unsupported registry policy mode: " + String(mode));
  }
}
