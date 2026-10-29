#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, appendFileSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
import { join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectAuditVersions } from "./check-npm-advisories.mjs";
import { cachedArchive, packedFileSets } from "./installation-closure.mjs";
import { referenceInstallation, installationDifferences, npmInstallContract } from "./reference-installation.mjs";
import { RUNTIME_IMAGE_INVENTORY_SCHEMA } from "./runtime-image-inventory.mjs";
// Pure classification of observed advisory IDs against the curated baseline.
export const ACCEPTANCE_SUMMARY_SCHEMA = "dacs-registry-container-acceptance/v1";
export const RUNTIME_IMAGE_POLICY_SCHEMA = "dacs-runtime-image-policy/v1";
export const POLICY_FINDINGS_SCHEMA = "dacs-registry-policy-findings/v1";
export const RELEASE_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const baselinePath = new URL("./registry-container-audit-baseline.json", import.meta.url);
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

// npm audit's JSON report, read through a closed shape. npm aggregates the
// installed versions of a package by name, so a package's severity need not
// equal any one advisory's: its own advisories bound it below, and every
// advisory reachable through its `via` names bounds it above. For the same
// reason its `isDirect` says only that some copy of the name is direct.
export const AUDIT_POLICY_SCHEMA = "dacs-registry-audit-policy/v1";
const AUDIT_SEVERITIES = ["info", "low", "moderate", "high", "critical"];
const DIRECT_BLOCKING_SEVERITIES = ["high", "critical"];
const MAX_AUDIT_PACKAGES = 100_000;
const MAX_ADVISORY_EDGES = 1000;
// How npm tests an installed version against an advisory's range
// (@npmcli/metavuln-calculator).
const NPM_ADVISORY_SEMVER = { includePrerelease: true, loose: true };
const ROOT_FIELDS_AUDITED_AS_DIRECT = ["dependencies", "optionalDependencies", "devDependencies", "peerDependencies"];
const severityRank = severity => AUDIT_SEVERITIES.indexOf(severity);
const advisoryUrlId = url => url.replace(/^https:\/\/github\.com\/advisories\//, "");

function validateAuditCounts(counts) {
  const valid = isPlainObject(counts) &&
    [...AUDIT_SEVERITIES, "total"].every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0) &&
    AUDIT_SEVERITIES.reduce((sum, key) => sum + counts[key], 0) === counts.total;
  if (!valid) throw new Error("inconsistent npm audit vulnerability counts");
}

// An advisory edge (a `via` object) names its package, URL, severity and the
// vulnerable range npm computed for it.
function auditAdvisory(via, packageName) {
  if (typeof via.url !== "string" || severityRank(via.severity) < 0 || via.name !== packageName ||
      typeof via.range !== "string") {
    throw new Error("incomplete npm audit advisory for " + packageName);
  }
  return via;
}

// Raises each package to the highest severity reachable from it through the
// reverse `via` edges; a package no advisory reaches is an ungrounded cycle.
function checkReachableSeverities(entries, own, dependents) {
  const reached = new Map(own);
  const queue = [...own.keys()];
  for (let index = 0; index < queue.length; index++) {
    const rank = reached.get(queue[index]);
    for (const parent of dependents.get(queue[index]) ?? []) {
      if ((reached.get(parent) ?? -1) < rank) {
        reached.set(parent, rank);
        queue.push(parent);
      }
    }
  }
  if (reached.size !== entries.length) throw new Error("incomplete npm audit advisory graph");
  for (const [name, value] of entries) {
    const rank = severityRank(value.severity);
    if (rank < (own.get(name) ?? -1) || rank > reached.get(name)) {
      throw new Error("npm audit package severity disagrees with reachable advisories");
    }
  }
}

// The advisory edges of a report whose counts, references and severities agree.
function auditAdvisories(audit) {
  const counts = audit?.metadata?.vulnerabilities;
  validateAuditCounts(counts);
  if (!isPlainObject(audit.vulnerabilities)) throw new Error("npm audit vulnerability graph missing");
  const entries = Object.entries(audit.vulnerabilities);
  if (entries.length > MAX_AUDIT_PACKAGES || entries.length !== counts.total || AUDIT_SEVERITIES.some(severity =>
    entries.filter(([, value]) => value?.severity === severity).length !== counts[severity])) {
    throw new Error("npm audit graph disagrees with vulnerability counts");
  }
  const advisories = [];
  const own = new Map();
  const dependents = new Map();
  for (const [name, value] of entries) {
    if (typeof value.isDirect !== "boolean") throw new Error("npm audit directness must be an explicit boolean");
    if (!Array.isArray(value.via) || value.via.length === 0 || value.via.length > MAX_ADVISORY_EDGES) {
      throw new Error("incomplete npm audit advisory graph");
    }
    for (const via of value.via) {
      if (typeof via === "string" && Object.hasOwn(audit.vulnerabilities, via)) {
        if (!dependents.has(via)) dependents.set(via, []);
        dependents.get(via).push(name);
      } else if (isPlainObject(via)) {
        const advisory = auditAdvisory(via, name);
        advisories.push(advisory);
        own.set(name, Math.max(own.get(name) ?? -1, severityRank(advisory.severity)));
      } else throw new Error("incomplete npm audit advisory graph");
    }
  }
  checkReachableSeverities(entries, own, dependents);
  return advisories;
}

const unevaluated = reason => new Error("advisory applicability unevaluated: " + reason);

// The exact versions each package name is installed at as a direct dependency
// of the lock root, aliases resolved to the installed name, as the CI audit
// gate collects them. Every root field npm can audit counts. Only a single
// registry project is read: workspaces and links have other direct copies.
function directVersions(lock) {
  const root = lock?.packages?.[""];
  if (!isPlainObject(root)) throw unevaluated("the lock has no root package");
  const nonRegistry = Object.entries(lock.packages).filter(([location, entry]) => location !== "" &&
    (!location.startsWith("node_modules/") || entry?.link === true));
  if (root.workspaces !== undefined || nonRegistry.length > 0) {
    throw unevaluated("workspaces and linked packages are unsupported");
  }
  const fields = ROOT_FIELDS_AUDITED_AS_DIRECT.filter(field => root[field] !== undefined);
  if (fields.some(field => !isPlainObject(root[field]))) throw unevaluated("a root dependency map is not an object");
  const dependencies = Object.assign({}, ...fields.map(field => root[field]));
  try {
    return collectAuditVersions({ packages: { ...lock.packages, "": { dependencies } } }, { scope: "direct" });
  } catch (error) { throw unevaluated(error.message); }
}

// The high/critical advisory IDs whose range, as npm reads it, covers a
// direct version of their package.
function directAdvisoryIds(advisories, lock) {
  const semver = npmModule("semver");
  const versions = directVersions(lock);
  const direct = new Set();
  for (const advisory of advisories) {
    if (semver.validRange(advisory.range, NPM_ADVISORY_SEMVER) === null) {
      throw unevaluated(`unreadable range ${JSON.stringify(advisory.range)} for ${advisory.name}`);
    }
    const installed = versions[advisory.name] ?? [];
    const unreadable = installed.find(version => semver.valid(version, NPM_ADVISORY_SEMVER) === null);
    if (unreadable !== undefined) throw unevaluated(`unreadable version ${JSON.stringify(unreadable)} of ${advisory.name}`);
    if (DIRECT_BLOCKING_SEVERITIES.includes(advisory.severity) &&
        installed.some(version => semver.satisfies(version, advisory.range, NPM_ADVISORY_SEMVER))) {
      direct.add(advisoryUrlId(advisory.url));
    }
  }
  return [...direct];
}

/** The audit policy of an `npm audit --json` report and the lock it audited:
 * its counts and observed advisory IDs classified against `baseline`, with the
 * high/critical IDs whose range covers a direct dependency's locked version.
 * `passed` when every observed ID is an assessed transitive one. Throws when
 * the report is malformed, or ("advisory applicability unevaluated") when the
 * lock, a range or a version cannot be read. */
export function registryAuditPolicy(audit, lock, baseline) {
  const advisories = auditAdvisories(audit);
  const policy = classifyRegistryAudit([...new Set(advisories.map(advisory => advisoryUrlId(advisory.url)))], baseline,
    directAdvisoryIds(advisories, lock));
  const passed = policy.assessedAdvisories.length === policy.observedAdvisories.length && policy.directAdvisories.length === 0;
  return { schema: AUDIT_POLICY_SCHEMA, observed: audit.metadata.vulnerabilities, ...policy, passed };
}

/** npm audit's exit code for `counts` at its default audit level, low: 1 when
 * any advisory is low or above, otherwise 0. Throws on inconsistent counts. */
export function expectedAuditExitCode(counts) {
  validateAuditCounts(counts);
  return AUDIT_SEVERITIES.some(severity => severity !== "info" && counts[severity] > 0) ? 1 : 0;
}

/** Re-reads the audit evidence an acceptance summary recorded: its counts and
 * its observed, unlisted and direct advisory IDs. Returns their classification
 * against `baseline`; throws when they are missing or disagree. */
export function summaryAudit(summary, baseline) {
  const audit = summary?.audit;
  if (!validIds(audit?.directAdvisories)) throw new Error("summary has no valid direct-advisory evidence");
  const policy = classifyRegistryAudit(audit.observedAdvisories, baseline, audit.directAdvisories);
  if (JSON.stringify(policy.unlistedAdvisories) !== JSON.stringify(audit.unlistedAdvisories)) {
    throw new Error("summary advisory classification does not match baseline");
  }
  validateAuditCounts(audit);
  if ((audit.total === 0) !== (policy.observedAdvisories.length === 0)) {
    throw new Error("audit totals disagree with advisory evidence");
  }
  return policy;
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
const DEPENDENCY_POLICY_SCHEMA = "dacs-registry-dependency-policy/v1";
const specFields = ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"];
const isPlainObject = value => typeof value === "object" && value !== null && !Array.isArray(value);

// A module of the executing npm. Acceptance pins npm, so dependency grammar
// and advisory ranges are read exactly as it reads them.
let npmRequire;
function npmModule(name) {
  if (!npmRequire) {
    const npmEntry = process.env.npm_execpath ?? join(execFileSync("npm", ["root", "--global"],
      { encoding: "utf8" }).trim(), "npm/bin/npm-cli.js");
    npmRequire = createRequire(npmEntry);
  }
  return npmRequire(name);
}

// Use the executing npm's parser, including loose semver and alias-name rules.
// This keeps dependency grammar separate from engine ranges.
let npmPackageArg;
function registrySourceSpec(value) {
  if (typeof value !== "string") return false;
  npmPackageArg ??= npmModule("npm-package-arg");
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

// The release candidates. A consumer of both rails also depends on the rest.
const CANDIDATE_NAMES = ["@kynesyslabs/dacs", "@kynesyslabs/dacs-node"];
const DUAL_RAIL_DEPENDENCIES = [...CANDIDATE_NAMES, "@kynesyslabs/demosdk", "@x402/core", "@x402/evm", "@x402/fetch",
  "better-sqlite3", "viem"];
// npm runs these when it installs a package. A candidate declaring one would
// run its own code before this check, so it is refused.
const INSTALL_LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall"];
// require() loads a module root that is a file with one of these extensions.
const MODULE_FILE_EXTENSIONS = [".js", ".json", ".node"];
const MAX_LISTED_DIFFERENCES = 20;

// The release candidates in `releaseSet`, as `{ name, integrity, version,
// files }`: each packed tarball must be the one release-provenance.json
// records for `version` before either is compared with the consumer's lock.
function releaseCandidates(releaseSet, version) {
  const provenance = JSON.parse(readFileSync(join(releaseSet, "release-provenance.json"), "utf8"));
  if (provenance?.version !== version) throw new Error(`release-provenance.json is not for version ${version}`);
  const candidates = CANDIDATE_NAMES.map(name => {
    const bytes = readFileSync(join(releaseSet, `${name.slice(1).replace("/", "-")}-${version}.tgz`));
    const integrity = "sha512-" + createHash("sha512").update(bytes).digest("base64");
    const recorded = provenance.packages?.[name]?.integrity;
    if (recorded !== integrity) {
      throw new Error(`release-provenance.json records ${String(recorded)} for ${name}, but the packed tarball is ${integrity}`);
    }
    return { name, integrity, version, bytes };
  });
  const fileSets = packedFileSets(new Map(candidates.map(({ name, bytes }) => [name, bytes])));
  return candidates.map(({ name, integrity, version }) => {
    const files = fileSets.get(name);
    const manifest = JSON.parse(files.get("package.json").toString("utf8"));
    if (manifest?.name !== name || manifest?.version !== version) {
      throw new Error(`packed candidate manifest does not match the release: ${name}@${version}`);
    }
    return { name, integrity, version, files };
  });
}

function declaredInstallScripts(files) {
  const scripts = JSON.parse(files.get("package.json").toString("utf8"))?.scripts;
  return [...INSTALL_LIFECYCLE_SCRIPTS.filter(script => isPlainObject(scripts) && script in scripts),
    ...(files.has("binding.gyp") ? ["binding.gyp"] : [])];
}

// The candidates `owner` (a manifest or lock entry) declares under another
// name, as `{ specifier, name }` for each `npm:` alias of one.
function candidateAliases(owner, candidates) {
  const aliases = [];
  for (const field of specFields) {
    for (const [specifier, spec] of Object.entries(isPlainObject(owner?.[field]) ? owner[field] : {})) {
      const name = typeof spec === "string" && /^npm:/i.test(spec) && registrySourceSpec(spec)
        ? npmPackageArg.resolve(specifier, spec).subSpec?.name : specifier;
      if (name !== specifier && candidates.some(candidate => candidate.name === name)) aliases.push({ specifier, name });
    }
  }
  return aliases;
}

// Whether the top-level object of `text`, which JSON.parse accepted, repeats a
// key once escapes are decoded. JSON.parse keeps the last `name`, while some
// supported Node versions use the first for package scope identity. Refuse
// repeated keys regardless of which value the runtime selects.
function repeatsTopLevelKey(text) {
  const keys = new Set();
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '"') {
      let end = index + 1;
      while (text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      const afterString = /\s*:/y;
      afterString.lastIndex = end + 1;
      if (depth === 1 && afterString.test(text)) {
        const key = JSON.parse(text.slice(index, end + 1));
        if (keys.has(key)) return true;
        keys.add(key);
      }
      index = end;
    } else if (text[index] === "{" || text[index] === "[") depth++;
    else if (text[index] === "}" || text[index] === "]") depth--;
  }
  return false;
}

// Whether a package scope or module named `name` is how require() reaches the
// candidate `candidateName`. Node matches a scope by prefix, so a scope named
// for the candidate's own scope or a subpath of it captures the candidate too.
function namesCandidate(name, candidateName) {
  return typeof name === "string" &&
    (name === candidateName || candidateName.startsWith(name + "/") || name.startsWith(candidateName + "/"));
}

// The name require() reaches the entry `item` of `directory` by, or null when
// it is no module root: a scope folder, or a path inside a package.
function moduleRootName(directory, item) {
  const parent = posix.basename(directory);
  if (parent === "node_modules") return item.startsWith("@") ? null : item;
  return parent.startsWith("@") && posix.basename(posix.dirname(directory)) === "node_modules" ? `${parent}/${item}` : null;
}

// Called only after the entire installed namespace matches its archive closure,
// so this reads every module root and package.json scope there is. The closure
// admits npm-generated command links to archive files only: a link named
// package.json is a scope, and no link is a module root.
function installedCandidateModules(project, closure) {
  const modules = new Map();
  const visit = (directory, owner) => {
    for (const item of readdirSync(join(project, directory), { withFileTypes: true })) {
      const path = `${directory}/${item.name}`;
      const record = closure.entries.get(path);
      const archiveOwner = record ? record.bundledBy ?? path : owner;
      const name = moduleRootName(directory, item.name);
      if (name) modules.set(path, { owner: archiveOwner, name });
      if (item.isDirectory()) visit(path, archiveOwner);
      else if (item.name === "package.json") {
        const scope = { ...modules.get(directory), owner, generated: item.isSymbolicLink() };
        try {
          const text = readFileSync(join(project, path), "utf8");
          scope.manifest = JSON.parse(text);
          scope.unreadable = !isPlainObject(scope.manifest) || repeatsTopLevelKey(text);
        } catch { scope.unreadable = true; }
        modules.set(directory, scope);
      }
    }
  };
  visit("node_modules", "npm");
  return modules;
}

// A closed inventory of physical module roots and EVERY package.json scope,
// including scopes outside module roots. Only the verified final namespace
// contributes manifests; opaque registry entries cannot pass.
// Hoisted, nested and shallow installs use lock locations as installed paths.
function candidateInventory(closure, installed, registry) {
  const modules = new Map();
  const errors = [];
  const { origin, path } = consumerRegistry(registry);
  for (const [location, record] of closure.entries) {
    if (!record.present) continue;
    modules.set(location, { owner: record.bundledBy ?? location, entry: record.entry,
      name: location.replace(/^.*node_modules\//, ""), manifest: record.manifest });
    if (record.unverified || (record.files === null && record.entry.inBundle !== true)) {
      let url;
      try { url = new URL(record.entry.resolved); } catch { /* source policy refuses non-registry entries */ }
      if (url?.origin === origin && url.pathname.startsWith(path)) {
        errors.push("cannot authenticate an unverified registry archive: " + location);
      }
    }
  }
  for (const [location, module] of installed) modules.set(location, { ...modules.get(location), ...module });
  return { modules, errors };
}

// A candidate is declared under its own name only, by the project, every
// installed lock entry and every scope in the inventory. Node then reaches it
// only through a module root or scope of that name, all of which the inventory
// holds, so no other name needs following through Node's resolver.
function candidateAliasErrors(manifest, lock, inventory, candidates) {
  const owners = [["", manifest], ["", lock?.packages?.[""]]];
  for (const [location, module] of inventory.modules) {
    owners.push([location, module.entry], [location, module.manifest]);
  }
  const errors = new Set();
  for (const [location, owner] of owners) {
    for (const { specifier, name } of candidateAliases(owner, candidates)) {
      errors.add(`${location || "the project"} declares ${name} under another name: ${specifier}`);
    }
  }
  return [...errors];
}

// Node resolves a package's own name to its own folder before any
// node_modules, so the project's package.json is a scope like an installed
// one: it may not name a candidate, nor repeat a key a runtime may read instead.
function projectScopeErrors(manifestText, manifest, candidates) {
  if (repeatsTopLevelKey(manifestText)) return ["cannot read the project package.json: it repeats a top-level key"];
  return candidates.filter(({ name }) => namesCandidate(manifest.name, name))
    .map(({ name }) => "the project is named for candidate package " + name);
}

// Certify a location from its independently verified closure archive, never
// from lock claims alone. Bundles and opaque entries have no such files.
function releaseCopyErrors(location, record, { name, integrity, version }, registry) {
  const entry = record?.entry ?? {};
  const { origin, path } = consumerRegistry(registry);
  const errors = [];
  if (!record?.files || record.unverified || entry.inBundle === true) {
    errors.push("candidate package has no independently verified release archive: " + location);
  }
  let url = null;
  try { url = new URL(entry.resolved); } catch { /* not a URL */ }
  if (url === null || url.origin !== origin || !url.pathname.startsWith(path)) {
    errors.push("candidate package did not resolve through the isolated registry: " + location);
  } else if (entry.integrity !== integrity) {
    errors.push(`candidate package integrity does not match the packed tarball: ${location} ` +
      `(expected ${integrity}, observed ${String(entry.integrity)})`);
  }
  if (entry.name !== undefined && entry.name !== name) errors.push("candidate package lock name does not match the release: " + location);
  if (entry.version !== version) {
    errors.push(`candidate package lock version does not match the release: ${location} (expected ${version}, observed ${String(entry.version)})`);
  }
  return errors;
}

// Why an acceptance run stopped.
export const FAILURE_CLASSES = ["network", "policy", "functional"];
const MAX_FAILURE_EVIDENCE_ENTRIES = 5;
const MAX_FAILURE_EVIDENCE_BYTES = 8192;
// Transient transport failures as npm, Docker, Git, curl and the registry
// ping report them; any one of them in a diagnostic is network evidence.
const NETWORK_FAILURE_SIGNATURES = [
  /\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ESOCKETTIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)\b/,
  /\bE(?:5\d\d|408|429)\b/,
  /socket hang up/,
  // npm's request timeout (code FETCH_ERROR) and body timeout.
  /network timeout at: /,
  /Response timeout while trying to fetch/,
  /TLS handshake timeout/,
  /i\/o timeout/,
  /toomanyrequests/,
  /curl: \((?:6|7|28|35|52|56)\)/,
  /dial tcp: lookup .+: (?:no such host|server misbehaving|temporary failure)/,
  /Could not resolve (?:host|proxy):/,
  /Failed to connect to .+ port \d+/,
  /Connection (?:timed out|refused)/,
  /connect: (?:connection refused|network is unreachable)/,
  /\b(?:408|429|5\d\d) [^\r\n]+ - (?:GET|POST) https?:\/\//,
  /invalid json response body at /,
  /Invalid response body while trying to fetch /,
  // The whole entry the acceptance script records when Verdaccio never answers.
  /^registry ping did not succeed within 30 attempts$/,
];
const networkSignature = new RegExp(NETWORK_FAILURE_SIGNATURES.map(signature => signature.source).join("|"));
const firstNpmErrorCode = text => /^npm error code (\S+)$/m.exec(text ?? "")?.[1] ?? null;
// Fields of an audit report; npm's audit error object has none of them.
const AUDIT_REPORT_FIELDS = ["auditReportVersion", "vulnerabilities", "metadata"];
const retryableStatus = status => status === 408 || status === 429 || (status >= 500 && status <= 599);

// Whether one saved diagnostic shows a transient network failure: npm's audit
// error object with a retryable status (or none, with a network message), or
// other output whose npm error code, if any, is a network one.
function retryableFailureEvidence(text) {
  let endpoint;
  try { endpoint = JSON.parse(text); } catch {
    const code = firstNpmErrorCode(text);
    return (code === null || code === "FETCH_ERROR" || networkSignature.test(code)) && networkSignature.test(text);
  }
  if (typeof endpoint?.message !== "string" || AUDIT_REPORT_FIELDS.some(key => Object.hasOwn(endpoint, key))) return false;
  if (endpoint.statusCode === undefined) return networkSignature.test(endpoint.message);
  return Number.isInteger(endpoint.statusCode) && retryableStatus(endpoint.statusCode);
}

const boundedEvidenceList = evidence => Array.isArray(evidence) && evidence.length <= MAX_FAILURE_EVIDENCE_ENTRIES &&
  [...evidence].every(line => typeof line === "string" && Buffer.byteLength(line) <= MAX_FAILURE_EVIDENCE_BYTES);

// The class an interrupted run's own record supports: the recorded one when
// the stage is named and any evidence is a bounded list of strings, and for
// network only when every entry is retryable evidence. Otherwise functional.
function interruptedFailureClass(summary) {
  const evidence = summary.failureEvidence;
  const supported = typeof summary.failedStage === "string" && summary.failedStage.trim() !== "" &&
    FAILURE_CLASSES.includes(summary.failureClass) && (evidence === undefined || boundedEvidenceList(evidence)) &&
    (summary.failureClass !== "network" || (evidence?.length > 0 && evidence.every(retryableFailureEvidence)));
  return supported ? summary.failureClass : "functional";
}

// The one admission every reading of a summary shares: `interrupted` with the
// failure class its evidence supports, `complete`, or `refused` with why a
// summary is neither. The release version and embedded schemas are checked
// before a complete run is classified.
function admitAcceptanceRun(summary, packageVersion) {
  if (summary?.schema !== ACCEPTANCE_SUMMARY_SCHEMA) {
    return { state: "refused", message: "registry/container acceptance summary has an unexpected schema" };
  }
  if (summary.complete === false) return { state: "interrupted", failureClass: interruptedFailureClass(summary) };
  if (summary.complete !== true) return { state: "refused", message: "acceptance is not complete" };
  // A complete run has no failure of its own. A top-level failure class is
  // only the copy --record writes of the disposition, which is recomputed.
  if (Object.hasOwn(summary, "failedStage") || Object.hasOwn(summary, "failureEvidence") ||
      (Object.hasOwn(summary, "failureClass") && summary.failureClass !== summary.disposition?.failureClass)) {
    return { state: "refused", message: "complete acceptance summary records a failure: failedStage, failureEvidence " +
      "or a failureClass its disposition does not record" };
  }
  if (summary.docker?.policy?.schema !== RUNTIME_IMAGE_POLICY_SCHEMA ||
      summary.securityGate?.findings?.schema !== POLICY_FINDINGS_SCHEMA) {
    return { state: "refused", message: "registry/container acceptance summary embeds evidence with an unexpected schema" };
  }
  // A summary for another (or no) version says nothing about this release:
  // its candidates were checked against the version it names.
  if (typeof packageVersion !== "string" || packageVersion === "" || summary.packageVersion !== packageVersion) {
    return { state: "refused", message: "registry/container acceptance summary is for package " +
      `version ${JSON.stringify(summary.packageVersion)}, not the release version ${JSON.stringify(packageVersion)}` };
  }
  return { state: "complete" };
}

const stoppedAt = summary => `stage ${String(summary.failedStage || "unknown")}`;

// The text's every `npm error code`, or null for none. Repeated or differing
// codes come back joined by a space, which no single code equals, so a log that
// names a second failure never reads as the first one alone.
const npmErrorCode = text => {
  const codes = Array.from((text ?? "").matchAll(/^npm error code (\S+)$/gm), match => match[1]);
  return codes.length === 0 ? null : codes.join(" ");
};

// Every module root and package scope in the closed inventory that names a
// candidate, by its location, lock entry or package.json, must be an
// independently locked release archive at the candidate's own name. Nested
// scopes, carried modules and file shadows have no such archive.
function authenticateCandidateInventory(closure, inventory, candidates, registry) {
  const errors = [...inventory.errors];
  for (const candidate of candidates) {
    if (!closure.entries.get("node_modules/" + candidate.name)?.present) {
      errors.push("candidate package is not installed at the top level: " + candidate.name);
    }
  }
  for (const [location, module] of inventory.modules) {
    const names = [module.name, module.entry?.name, module.manifest?.name,
      ...MODULE_FILE_EXTENSIONS.filter(extension => module.name?.endsWith(extension))
        .map(extension => module.name.slice(0, -extension.length))];
    const identities = candidates.filter(candidate => names.some(name => namesCandidate(name, candidate.name)));
    if (!module.entry && (identities.length || module.unreadable)) {
      errors.push(module.generated ? `cannot authenticate an npm-generated package scope: ${location}`
        : `cannot authenticate a candidate copy carried in the archive of ${module.owner}: ${location}`);
    } else {
      if (module.unreadable) errors.push("cannot read an archive package scope: " + location);
      for (const candidate of identities) {
        errors.push(...module.name === candidate.name
          ? releaseCopyErrors(location, closure.entries.get(location), candidate, registry)
          : [`candidate package ${candidate.name} is installed under another name: ${location}`]);
      }
    }
  }
  return errors;
}

// What keeps the installation from holding only release copies of
// `candidates`, given its closure: candidates that run install code, candidate
// identities anywhere in it that are not the release at its own name, and
// candidates declared under another name or by the project's own name.
function candidateIntegrityErrors({ manifestText, manifest, lock, registry, candidates, closure, installed }) {
  const inventory = candidateInventory(closure, installed, registry);
  return [
    ...projectScopeErrors(manifestText, manifest, candidates),
    ...candidates.flatMap(({ name, files }) => {
      const scripts = declaredInstallScripts(files);
      return scripts.length ? [`candidate package runs code when installed (${scripts.join(", ")}): ${name}`] : [];
    }),
    ...authenticateCandidateInventory(closure, inventory, candidates, registry),
    ...candidateAliasErrors(manifest, lock, inventory, candidates),
  ];
}

// Checks the consumer at `projectPath`, installed by npm ci --ignore-scripts
// and unused by any package code so far (such code could change the tree
// after extraction), and writes its registry dependency report. Every
// installed path must be its locked archive's and every candidate copy the
// release in `releaseSet`; otherwise it throws listing each difference.
function writeDependencyPolicyReport({ projectPath, registry, report, releaseSet, version }) {
  const project = realpathSync(projectPath);
  // npm reads both files as UTF-8 text and ignores a leading byte-order mark.
  const npmText = bytes => bytes.toString("utf8").replace(/^\uFEFF/, "");
  const manifestBytes = readFileSync(join(project, "package.json"));
  const manifestText = npmText(manifestBytes);
  const manifest = JSON.parse(manifestText);
  const lock = JSON.parse(npmText(readFileSync(join(project, "package-lock.json"))));
  const missing = DUAL_RAIL_DEPENDENCIES.filter(name => typeof manifest.dependencies?.[name] !== "string");
  if (missing.length) throw new Error("dual-rail consumer is missing " + missing.join(", "));
  const candidates = releaseCandidates(releaseSet, version);
  const installer = npmInstallContract(project);
  if (installer.config["install-strategy"] === "linked") {
    throw new Error("cannot authenticate candidate copies under install-strategy=linked: lock locations are not installed paths");
  }
  const closure = referenceInstallation({ manifest: manifestBytes, lock, installer,
    readArchive: (_location, entry) => cachedArchive(installer.config.cache, entry.integrity) });
  // A failed replay publishes no entries or inventory, so no candidate rule can be judged.
  if (closure.errors.length) throw new Error(closure.errors.join("\n"));
  const differences = installationDifferences(project, closure).map(line => "installed tree is not the locked archives: " + line);
  const installed = differences.length === 0 &&
    [...closure.entries.values()].every(record => !record.present || !record.unverified)
    ? installedCandidateModules(project, closure) : new Map();
  const errors = [...differences.slice(0, MAX_LISTED_DIFFERENCES),
    ...(differences.length > MAX_LISTED_DIFFERENCES ? [`and ${differences.length - MAX_LISTED_DIFFERENCES} more differences`] : []),
    ...candidateIntegrityErrors({ manifestText, manifest, lock, registry, candidates, closure, installed })];
  if (errors.length) throw new Error(errors.join("\n"));
  const violations = registryDependencyViolations({ manifest, lock, registry });
  writeFileSync(report, JSON.stringify({ schema: DEPENDENCY_POLICY_SCHEMA, passed: violations.length === 0,
    violations }, null, 2) + "\n");
}

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

function resolveLockedDependency(packages, location, name) {
  let directory = location;
  for (;;) {
    const candidate = posix.join(directory, "node_modules", name);
    if (posix.basename(directory) !== "node_modules" && Object.hasOwn(packages, candidate)) return candidate;
    if (!directory) return null;
    const parent = posix.dirname(directory);
    directory = parent === "." ? "" : parent;
  }
}

function requiredRuntimePackages(packages) {
  const required = new Set();
  const errors = [];
  const pending = [""];
  for (let index = 0; index < pending.length; index++) {
    const location = pending[index];
    const entry = packages[location];
    const dependencies = entry.dependencies === undefined ? {} : entry.dependencies;
    const optional = entry.optionalDependencies === undefined ? {} : entry.optionalDependencies;
    if (!isPlainObject(dependencies) || !isPlainObject(optional)) {
      errors.push(`malformed generated lock dependencies: ${location || "<root>"}`);
      continue;
    }
    for (const [name, specifier] of Object.entries(dependencies)) {
      if (!/^(?:@[^/\\\s]+\/)?[^/@.\\\s][^/\\\s]*$/.test(name) ||
          typeof specifier !== "string" || !specifier.trim()) {
        errors.push(`malformed required dependency ${name} from ${location || "<root>"}`);
        continue;
      }
      // npm lets optionalDependencies override a same-named dependencies entry.
      if (Object.hasOwn(optional, name)) continue;
      const target = resolveLockedDependency(packages, location, name);
      if (target === null || packages[target].dev === true || packages[target].link === true) {
        errors.push(`unresolved required dependency ${name} from ${location || "<root>"}`);
        continue;
      }
      if (!required.has(target)) {
        required.add(target);
        pending.push(target);
      }
    }
  }
  return { required, errors };
}

// Compares the final image's package inventory with the lock's production
// entries. Only entries reachable from the root through non-dev dependencies
// edges are required; entries reached only through optional dependencies or
// peers may be absent, regardless of their lock flags. Each image package
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
  const { required, errors } = requiredRuntimePackages(packages);
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
    .filter(([location]) => !seen.has(location) && required.has(location))
    .map(([location]) => location);
  return { scanComplete: errors.length === 0, errors, unexpected, missing };
}

// The closed list of acceptance sources, by the policy gate each one feeds.
// Each gate has one producer: these findings. The composer's booleans in a
// summary (securityGate.*Passed, securityGate.passed, the docker.policy flags)
// repeat them for people to read and decide nothing here.
const GATE_SOURCES = {
  registryDependency: ["generated-package-lock.json", "dependency-policy.json"],
  // The image policy is required so an uninspected image cannot pass; only
  // the inventory decides which packages the image holds.
  productionImage: ["generated-package-lock.json", "runtime-image-policy.json", "runtime-image-inventory.json"],
  engineStrict: ["generated-package-lock.json", "engine-versions.json", "engine-strict.log", "engine-strict.exit-code"],
  lockSbom: ["consumer-lock-sbom.err", "consumer-lock-sbom.exit-code"],
  physicalSbom: ["consumer-physical-sbom.err", "consumer-physical-sbom.exit-code"],
};
/** Every source extractPolicyFindings reads, in a fixed order. */
export const POLICY_SOURCES = [...new Set(Object.values(GATE_SOURCES).flat())];
// The gate each recorded finding belongs to.
const FINDING_GATES = { gitDependencies: "registryDependency", engine: "engineStrict", lockSbom: "lockSbom",
  physicalSbom: "physicalSbom", productionImageDependencies: "productionImage", productionImageInventory: "productionImage" };
// Packages the production image may not hold anywhere, whatever the lock says.
const PROHIBITED_IMAGE_PACKAGES = ["typescript", "rubic-sdk"];

// Reads each source once; a missing, unparsable or wrong-schema one is
// recorded as incomplete rather than read as empty.
function policySourceReader(read) {
  const incomplete = new Set();
  const text = name => {
    const value = read(name);
    if (value === undefined) incomplete.add(name);
    return value;
  };
  const json = (name, valid = () => true) => {
    const value = text(name);
    if (value === undefined) return null;
    try {
      const parsed = JSON.parse(value);
      if (valid(parsed)) return parsed;
    } catch { /* unparsable */ }
    incomplete.add(name);
    return null;
  };
  const exitCode = name => {
    const value = text(name)?.trim();
    if (value === undefined) return null;
    if (/^\d{1,3}$/.test(value) && Number(value) <= 255) return Number(value);
    incomplete.add(name);
    return null;
  };
  return { text, json, exitCode, incomplete };
}

// A generated lock names its packages, with the root project's entry; one
// without them describes no installation for any gate it feeds.
const generatedLock = lock => isPlainObject(lock?.packages) && isPlainObject(lock.packages[""]);
const closedDependencyPolicy = report => report?.schema === DEPENDENCY_POLICY_SCHEMA && Array.isArray(report.violations) &&
  report.passed === (report.violations.length === 0);
// The problems an `npm sbom` error log reports: every `npm error` line except
// the first error code, empty lines and the log-location footer. A line outside
// the missing/invalid/extraneous grammar stays in the list, so it can match no
// baseline problem and blocks the gate instead of being dropped.
function sbomProblems(errors) {
  let codeSeen = false;
  const problems = [];
  for (const [, line = ""] of (errors ?? "").matchAll(/^npm error(?: (.*))?$/gm)) {
    if (!codeSeen && /^code \S+$/.test(line)) codeSeen = true;
    else if (line.trim() !== "" && !line.startsWith("A complete log of this run can be found in: ")) problems.push(line);
  }
  return problems;
}
const prohibitedLocation = (location, name) => typeof location === "string" &&
  (location === `node_modules/${name}` || location.endsWith(`/node_modules/${name}`));

/** Records the observed identities in the closed list of acceptance sources,
 * read by name through `read` (undefined for a missing source), for the
 * baseline rules below. A gate with a missing, unparsable or wrong-schema
 * source records `{ incomplete: [sources] }` in place of its findings. */
export function extractPolicyFindings(read) {
  const source = policySourceReader(read);
  const lock = source.json("generated-package-lock.json", generatedLock);
  const packages = lock?.packages ?? {};
  const identity = location => ({ version: packages[location]?.version ?? null, integrity: packages[location]?.integrity ?? null });
  const dependencyPolicy = source.json("dependency-policy.json", closedDependencyPolicy);
  const strictLog = source.text("engine-strict.log");
  const { scanComplete, violations, ...scan } = scanLockEngines(lock, source.json("engine-versions.json"));
  const sbom = name => {
    const errors = source.text(`${name}.err`);
    return { exitCode: source.exitCode(`${name}.exit-code`), code: npmErrorCode(errors), problems: sbomProblems(errors) };
  };
  source.json("runtime-image-policy.json", policy => policy?.schema === RUNTIME_IMAGE_POLICY_SCHEMA);
  const inventory = source.json("runtime-image-inventory.json");
  const { unexpected, ...imageInventory } = runtimeImageInventoryFindings(inventory, lock);
  // Prohibited packages are findings by name or location, even when they
  // match the production closure.
  const prohibited = (Array.isArray(inventory?.packages) ? inventory.packages : [])
    .filter(item => PROHIBITED_IMAGE_PACKAGES.some(name => item?.name === name || prohibitedLocation(item?.location, name)))
    .map(item => ({ name: item.name, location: item.location, ...identity(item.location), version: item.version }));
  const findings = {
    gitDependencies: dependencyPolicy?.violations.map(violation => ({ location: violation.location,
      field: violation.field ?? null, value: violation.value, ...identity(violation.location) })),
    engine: { exitCode: source.exitCode("engine-strict.exit-code"), code: npmErrorCode(strictLog),
      // npm stops at the first incompatible package, so a log naming several is
      // not one a listed violation can account for (the joined name matches none).
      // npm names that package on both its `engine` and `notsup` lines.
      reportedPackage: [...new Set(Array.from((strictLog ?? "").matchAll(/Not compatible with your version of node\/npm: (\S+)/g),
        match => match[1]))].join(" ") || null,
      scan, scanComplete, violations },
    lockSbom: sbom("consumer-lock-sbom"),
    physicalSbom: sbom("consumer-physical-sbom"),
    productionImageDependencies: [...prohibited, ...unexpected.filter(item =>
      !prohibited.some(known => known.location === item.location && known.name === item.name))],
    productionImageInventory: imageInventory,
  };
  return { schema: POLICY_FINDINGS_SCHEMA, ...Object.fromEntries(Object.entries(findings).map(([key, value]) => {
    const missing = GATE_SOURCES[FINDING_GATES[key]].filter(name => source.incomplete.has(name));
    return [key, missing.length ? { incomplete: missing } : value];
  })) };
}

// Baseline Git, engine and image identities pin archive version and integrity;
// engine ones also pin the required range. An SBOM rule elides the installed
// and required versions after `invalid:`/`extraneous:` and after `required by`,
// which npm prints from the tree, so a rule matches the same package pair.
const sameIdentity = (keys) => (item, known) => keys.every(key => JSON.stringify(item?.[key]) === JSON.stringify(known?.[key]));
const gitIdentity = sameIdentity(["location", "field", "value", "version", "integrity"]);
const engineIdentity = sameIdentity(["package", "location", "integrity", "required"]);
const imageIdentity = sameIdentity(["name", "location", "version", "integrity"]);
const sbomProblemRule = (line) => typeof line === "string" ? line
  .replace(/^((?:invalid|extraneous): (?:@[^\s@/]+\/)?[^\s@]+)@[^\s,]+/, "$1@*")
  .replace(/( required by (?:@[^\s@/]+\/)?[^\s@]+)@\S+$/, "$1@*") : line;
const sbomIdentity = (item, known) => typeof item === "string" && sbomProblemRule(item) === sbomProblemRule(known);
const allListed = (items, known, same) => Array.isArray(known) && items.every(item => known.some(entry => same(item, entry)));
const listedState = (items, known, same) => !Array.isArray(items) ? "blocked" : items.length === 0 ? "passed"
  : allListed(items, known, same) ? "baseline" : "blocked";

// npm ci --engine-strict exits 0 with no violation, or 1 (EBADENGINE) naming
// one of the violations the complete lock scan lists.
function engineState(engine, known) {
  if (engine?.scanComplete !== true || !Array.isArray(engine.violations)) return "blocked";
  if (engine.exitCode === 0) return engine.code === null && engine.violations.length === 0 ? "passed" : "blocked";
  const reported = engine.exitCode === 1 && engine.code === "EBADENGINE" &&
    engine.violations.some(violation => violation?.package === engine.reportedPackage);
  return reported ? listedState(engine.violations, known, engineIdentity) : "blocked";
}

// npm sbom exits 0 with no problem, or 1 (ESBOMPROBLEMS) listing at least one;
// an exit 1 that lists none is incomplete evidence, not a clean run.
function sbomState(sbom, known) {
  if (!Array.isArray(sbom?.problems)) return "blocked";
  if (sbom.exitCode === 0) return sbom.code === null && sbom.problems.length === 0 ? "passed" : "blocked";
  const listed = sbom.exitCode === 1 && sbom.code === "ESBOMPROBLEMS" && sbom.problems.length > 0;
  return listed ? listedState(sbom.problems, known, sbomIdentity) : "blocked";
}

const completeInventory = inventory => inventory?.scanComplete === true && Array.isArray(inventory.missing) &&
  inventory.missing.length === 0 && Array.isArray(inventory.errors) && inventory.errors.length === 0;

/** Classifies each policy gate of a summary as "passed", "baseline" (only
 * findings the #191 baseline records) or "blocked", from its recorded
 * findings alone. Missing, malformed or incomplete findings block. */
export function classifyPolicyChecks(summary, baseline) {
  const findings = isPlainObject(summary?.securityGate?.findings) ? summary.securityGate.findings : {};
  const known = baseline?.policyFindings ?? {};
  return {
    registryDependency: listedState(findings.gitDependencies, known.gitDependencies, gitIdentity),
    productionImage: completeInventory(findings.productionImageInventory)
      ? listedState(findings.productionImageDependencies, known.productionImageDependencies, imageIdentity) : "blocked",
    engineStrict: engineState(findings.engine, known.engineViolations),
    lockSbom: sbomState(findings.lockSbom, known.lockSbomProblems),
    physicalSbom: sbomState(findings.physicalSbom, known.physicalSbomProblems),
  };
}

/** The findings of each blocked gate in `blocked` that the #191 baseline does
 * not record, and the sources it lacks, so a blocked run's log names them.
 * Diagnostic only: it decides nothing. */
export function unlistedPolicyFindings(summary, baseline, blocked) {
  const findings = summary?.securityGate?.findings ?? {};
  const known = baseline?.policyFindings ?? {};
  const incomplete = value => Array.isArray(value?.incomplete) ? value.incomplete.map(name => `incomplete evidence: ${name}`) : [];
  const outside = (items, knownItems, same) => (Array.isArray(items) ? items : [])
    .filter(item => !(Array.isArray(knownItems) && knownItems.some(entry => same(item, entry))));
  const inventory = findings.productionImageInventory ?? {};
  const named = {
    registryDependency: () => [...incomplete(findings.gitDependencies),
      ...outside(findings.gitDependencies, known.gitDependencies, gitIdentity)],
    productionImage: () => [...incomplete(inventory),
      ...(inventory.scanComplete === true ? [] : ["image inventory scan incomplete"]),
      ...(Array.isArray(inventory.errors) ? inventory.errors.map(error => `inventory error: ${String(error)}`) : []),
      ...(Array.isArray(inventory.missing) ? inventory.missing.map(item => `missing: ${JSON.stringify(item)}`) : []),
      ...outside(findings.productionImageDependencies, known.productionImageDependencies, imageIdentity)],
    engineStrict: () => [...incomplete(findings.engine),
      ...outside(findings.engine?.violations, known.engineViolations, engineIdentity)],
    lockSbom: () => [...incomplete(findings.lockSbom), ...outside(findings.lockSbom?.problems, known.lockSbomProblems, sbomIdentity)],
    physicalSbom: () => [...incomplete(findings.physicalSbom),
      ...outside(findings.physicalSbom?.problems, known.physicalSbomProblems, sbomIdentity)],
  };
  return Object.fromEntries(blocked.filter(name => name in named).map(name => [name, named[name]()]));
}

// "fail" (the default) or "warn": what an advisory ID outside the baseline does.
export const UNLISTED_ADVISORY_POLICIES = ["fail", "warn"];

// The audit gate, from the recorded audit evidence and npm's exit code. A
// high/critical advisory on a direct version blocks whichever list records
// it; an unlisted one is "unlisted" under the warn policy and blocks otherwise.
function auditCheck(summary, baseline, unlistedAdvisories) {
  let policy;
  try { policy = summaryAudit(summary, baseline); } catch (error) { return { state: "blocked", reason: String(error) }; }
  const exitCode = summary.securityGate?.auditExitCode;
  const expected = expectedAuditExitCode(summary.audit);
  if (exitCode !== expected) {
    return { state: "blocked", policy, reason: `npm audit exited ${JSON.stringify(exitCode)} for these counts, not ${expected}` };
  }
  if (policy.directAdvisories.length > 0) return { state: "blocked", policy };
  if (policy.unlistedAdvisories.length > 0) return { state: unlistedAdvisories === "warn" ? "unlisted" : "blocked", policy };
  return { state: policy.observedAdvisories.length > policy.assessedAdvisories.length ? "baseline" : "passed", policy };
}

// Exit 0 when every gate passed, 4 when the rest are baseline-only or
// (warn) unlisted, otherwise 3.
const gatesExitCode = states => states.every(state => state === "passed") ? 0
  : states.some(state => state === "blocked") ? 3 : 4;

// The message of a complete run's security result, built after the decision.
function securityMessage(exitCode, checks, audit, summary, baseline) {
  const named = state => Object.keys(checks).filter(name => checks[name] === state);
  const policy = audit.policy;
  if (exitCode === 0) return "registry/container acceptance passed";
  if (exitCode === 4) {
    return "functional registry/container rehearsal passed; production publication remains blocked" +
      (named("baseline").length ? ` by #191 baseline findings (${named("baseline").join(", ")})` : "") +
      (checks.audit === "unlisted" ? "; advisory IDs not in the #191 baseline (a pull-request warning; the scheduled " +
        `drift job and release paths fail on them): ${policy.unlistedAdvisories.join(", ")}` : "");
  }
  const outside = Object.entries(unlistedPolicyFindings(summary, baseline, named("blocked")))
    .map(([name, items]) => `${name}: ${items.length ? items.map(item =>
      typeof item === "string" ? item : JSON.stringify(item)).join("; ") : "no finding recorded"}`);
  const direct = list => (list ?? []).filter(id => policy.directAdvisories.includes(id));
  const clause = (ids, text) => ids.length ? `; ${text}: ${ids.join(", ")}` : "";
  return "functional registry/container rehearsal passed, but the #191 security gate is blocked beyond the recorded " +
    `baseline (${named("blocked").join(", ")})` +
    (outside.length ? `; findings outside the #191 baseline: ${outside.join(" | ")}` : "") +
    (audit.reason ? `; ${audit.reason}` : "") +
    (policy?.unlistedAdvisories.length ? `; advisory IDs not in the #191 baseline: ${policy.unlistedAdvisories.join(", ")}. ` +
      "Review them, then add them to scripts/registry-container-audit-baseline.json and .md in a PR under CODEOWNERS review" : "") +
    (policy ? clause(direct(policy.unlistedAdvisories), "of those, high or critical on a direct dependency, which fail " +
      "pull requests too") +
      clause(direct(policy.assessedAdvisories), "assessed advisories that are high or critical on a direct dependency, " +
        "which an assessment cannot accept") +
      clause(direct(baseline.advisoryIds), "#191 baseline advisories that are high or critical on a direct dependency, " +
        "which the baseline cannot waive") : "");
}

/** Classifies an acceptance summary into an exit code: 0 passed, 1 functional
 * failure or interrupted run (with its failure class), 3 a blocked or
 * malformed security result, 4 only #191 baseline findings or, under the
 * "warn" policy, unlisted transitive advisory IDs. Returns the exit code,
 * failure class, message, gate states and audit classification. Throws for an
 * unknown unlisted-advisory policy. */
export function registryContainerDisposition(summary, baseline = JSON.parse(readFileSync(baselinePath, "utf8")),
  { unlistedAdvisories = "fail", packageVersion = RELEASE_VERSION } = {}) {
  if (!UNLISTED_ADVISORY_POLICIES.includes(unlistedAdvisories)) {
    throw new Error(`unknown unlisted-advisory policy ${JSON.stringify(unlistedAdvisories)}`);
  }
  const run = admitAcceptanceRun(summary, packageVersion);
  if (run.state === "refused") return { exitCode: 1, failureClass: "functional", message: run.message };
  if (run.state === "interrupted") {
    return { exitCode: 1, failureClass: run.failureClass,
      message: `registry/container acceptance stopped at ${stoppedAt(summary)} (${run.failureClass} failure)` };
  }
  if (summary.functionalPassed !== true || summary.generatedTestsPassed !== true) {
    return { exitCode: 1, failureClass: "functional", message: "functional registry/container rehearsal failed" };
  }
  const audit = auditCheck(summary, baseline, unlistedAdvisories);
  const checks = { ...classifyPolicyChecks(summary, baseline), audit: audit.state };
  const exitCode = gatesExitCode(Object.values(checks));
  return { exitCode, failureClass: exitCode === 0 ? null : "policy", checks,
    message: securityMessage(exitCode, checks, audit, summary, baseline), ...audit.policy };
}

/** Compares a summary's advisory IDs with the baseline: exit 0 with none
 * unlisted, 3 with unlisted IDs or unreadable evidence, and 1 (evaluated:
 * false) for an interrupted run, which has no IDs to compare. */
export function registryAuditDriftDisposition(summary, baseline = JSON.parse(readFileSync(baselinePath, "utf8"))) {
  const run = admitAcceptanceRun(summary, RELEASE_VERSION);
  if (run.state === "refused") return { exitCode: 3, message: run.message };
  if (run.state === "interrupted") {
    return { exitCode: 1, evaluated: false, failureClass: run.failureClass, message: "Advisory-ID drift was not evaluated: " +
      `acceptance stopped at ${stoppedAt(summary)} (${run.failureClass} failure` +
      `${run.failureClass === "network" ? "; rerun the workflow" : ""})` };
  }
  try {
    const policy = summaryAudit(summary, baseline);
    return { exitCode: policy.unlistedAdvisories.length ? 3 : 0, message: policy.unlistedAdvisories.length
      ? `Unlisted advisory IDs: ${policy.unlistedAdvisories.join(", ")}` : "No advisory-ID drift", ...policy };
  } catch (error) { return { exitCode: 3, message: String(error) }; }
}

// Removes a previous report before its inputs are read, so a failed repeat
// leaves no stale result; an output naming an input is refused first.
function invalidateReport(output, inputs) {
  if (inputs.some(input => resolve(input) === resolve(output))) throw new Error("evidence input and output must differ");
  rmSync(output, { force: true });
}

// Replaces a JSON result by sibling rename, removing the temporary file even on failure.
function atomicWriteJson(path, value) {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

function annotate(result) {
  if (result.exitCode !== 0 && result.exitCode !== 4) {
    process.stdout.write(`::error title=Registry/container acceptance ${result.failureClass} failure::${result.message}\n`);
  }
}

// The modes that read an acceptance summary; a bare path classifies one.
const SUMMARY_MODES = ["--record", "--audit-drift"];

// Node runs the main module by its real path, or by its linked path under
// --preserve-symlinks-main, so compare real paths. An entry that is not a file
// (stdin "-", or none) means this module was imported.
const entryPath = (() => { try { return realpathSync(process.argv[1]); } catch { return null; } })();
if (entryPath !== null && entryPath === realpathSync(fileURLToPath(import.meta.url))) {
  const [mode] = process.argv.slice(2);
  if (mode === "--audit-policy") {
    const [auditPath, lockPath, output] = process.argv.slice(3);
    if (!auditPath || !lockPath || !output) {
      throw new Error("usage: --audit-policy <npm-audit.json> <generated-package-lock.json> <output>");
    }
    invalidateReport(output, [auditPath, lockPath]);
    const audit = JSON.parse(readFileSync(auditPath, "utf8"));
    let lock = null;
    try { lock = JSON.parse(readFileSync(lockPath, "utf8")); } catch { /* unreadable: applicability is unevaluated */ }
    const policy = registryAuditPolicy(audit, lock, JSON.parse(readFileSync(baselinePath, "utf8")));
    writeFileSync(output, JSON.stringify(policy, null, 2) + "\n");
    process.stdout.write(JSON.stringify(policy.observed) + "\n");
  } else if (mode === "--dependency-policy") {
    const [projectPath, registry, report, releaseSet, version] = process.argv.slice(3);
    if (report) rmSync(report, { force: true });
    if (!projectPath || !registry || !report || !releaseSet || !version) {
      throw new Error("usage: --dependency-policy <project> <registry> <report> <release-set> <version>");
    }
    writeDependencyPolicyReport({ projectPath, registry, report, releaseSet, version });
  } else if (mode === "--policy-findings") {
    const [input, output] = process.argv.slice(3);
    if (!input || !output) throw new Error("usage: --policy-findings <evidence-directory> <output>");
    invalidateReport(output, [input, ...POLICY_SOURCES.map(name => join(input, name))]);
    const read = name => existsSync(join(input, name)) ? readFileSync(join(input, name), "utf8") : undefined;
    writeFileSync(output, JSON.stringify(extractPolicyFindings(read), null, 2) + "\n");
  } else if (typeof mode === "string" && (SUMMARY_MODES.includes(mode) || !mode.startsWith("--"))) {
    const drift = mode === "--audit-drift";
    const record = mode === "--record";
    const summaryPath = drift || record ? process.argv[3] : mode;
    if (!summaryPath) throw new Error(`usage: ${mode} <acceptance-summary.json>`);
    const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
    // Unset means fail closed; only the pull_request acceptance job sets warn.
    const unlistedAdvisories = process.env.DACS_UNLISTED_ADVISORIES || "fail";
    const result = drift ? registryAuditDriftDisposition(summary)
      : registryContainerDisposition(summary, undefined, { unlistedAdvisories });
    // A refused summary is left as it is: recording the refusal would make its
    // failure class match its disposition and admit it on the next reading.
    if (record && admitAcceptanceRun(summary, RELEASE_VERSION).state !== "refused") {
      const { exitCode, failureClass, message, checks } = result;
      atomicWriteJson(summaryPath, { ...summary, failureClass,
        disposition: { exitCode, failureClass, message, checks, unlistedAdvisories } });
    }
    // The pull-request re-check of exit 4 turns unlisted IDs into a warning and
    // a step-summary line; failing acceptance names them in its error.
    if (!drift && !record && result.exitCode === 4 && result.unlistedAdvisories?.length) {
      const ids = result.unlistedAdvisories.join(", ");
      process.stdout.write(`::warning title=Advisory IDs outside the #191 baseline::${ids}. Pull requests only warn; ` +
        "the scheduled drift job and release paths fail until they are reviewed and recorded in " +
        "scripts/registry-container-audit-baseline.json and .md.\n");
      if (process.env.GITHUB_STEP_SUMMARY) {
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- Advisory IDs outside the #191 baseline (warning on this ` +
          `pull request; the scheduled drift job and release paths fail on them): ${ids}\n`);
      }
    }
    if (drift && result.unlistedAdvisories?.length) {
      process.stdout.write(`::warning title=Registry audit advisory drift::Unlisted advisory IDs: ${result.unlistedAdvisories.join(", ")}. Production publication remains blocked by #191.\n`);
    }
    if (drift && result.evaluated === false) {
      process.stdout.write(`::warning title=Registry audit advisory drift::${result.message}\n`);
    }
    if (!drift) annotate(result);
    (result.exitCode === 0 ? process.stdout : process.stderr).write(`${result.message}\n`);
    process.exit(result.exitCode);
  } else {
    throw new Error("unsupported registry policy mode: " + String(mode));
  }
}
