#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, appendFileSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
import { join, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cachedArchive, packedFileSets } from "./installation-closure.mjs";
import { referenceInstallation, installationDifferences, npmInstallContract } from "./reference-installation.mjs";
import { runtimeImageInventory, RUNTIME_IMAGE_INVENTORY_SCHEMA } from "./runtime-image-inventory.mjs";
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

const MAX_AUDIT_PACKAGES = 100_000, MAX_ADVISORY_EDGES = 1000;
const auditSeverities = ["info", "low", "moderate", "high", "critical"];
function validateAuditCounts(counts) {
  if (!counts || ![...auditSeverities, "total"].every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0) ||
      auditSeverities.reduce((sum, key) => sum + counts[key], 0) !== counts.total) {
    throw new Error("inconsistent npm audit vulnerability counts");
  }
}
// npm aggregates versions by name: own advisories bound severity below, reachable ones above.
function validateAuditGraph(audit) {
  const counts = audit.metadata?.vulnerabilities;
  validateAuditCounts(counts);
  if (!isPlainObject(audit.vulnerabilities)) throw new Error("npm audit vulnerability graph missing");
  const entries = Object.entries(audit.vulnerabilities);
  if (entries.length > MAX_AUDIT_PACKAGES || entries.length !== counts.total || auditSeverities.some(severity =>
      entries.filter(([, value]) => value?.severity === severity).length !== counts[severity])) {
    throw new Error("npm audit graph disagrees with vulnerability counts");
  }
  const own = new Map(), dependents = new Map();
  for (const [name, value] of entries) {
    if (typeof value.isDirect !== "boolean") throw new Error("npm audit directness must be an explicit boolean");
    if (!Array.isArray(value.via) || value.via.length === 0 || value.via.length > MAX_ADVISORY_EDGES) {
      throw new Error("incomplete npm audit advisory graph");
    }
    for (const via of value.via) {
      if (typeof via === "string" && Object.hasOwn(audit.vulnerabilities, via)) {
        const parents = dependents.get(via) ?? [];
        parents.push(name); dependents.set(via, parents);
      } else if (isPlainObject(via) && auditSeverities.includes(via.severity)) {
        own.set(name, Math.max(own.get(name) ?? -1, auditSeverities.indexOf(via.severity)));
      } else throw new Error("incomplete npm audit advisory graph");
    }
  }
  const reached = new Map(own), queue = [...own.keys()];
  for (let index = 0; index < queue.length; index++) {
    for (const parent of dependents.get(queue[index]) ?? []) {
      if ((reached.get(parent) ?? -1) < reached.get(queue[index])) { reached.set(parent, reached.get(queue[index])); queue.push(parent); }
    }
  }
  if (reached.size !== entries.length) throw new Error("incomplete npm audit advisory graph");
  if (entries.some(([name, value]) => auditSeverities.indexOf(value.severity) < (own.get(name) ?? -1) ||
      auditSeverities.indexOf(value.severity) > reached.get(name))) throw new Error("npm audit package severity disagrees with reachable advisories");
}
function summaryAudit(summary, baseline) {
  if (!validIds(summary.audit?.directAdvisories)) throw new Error("summary has no valid direct-advisory evidence");
  const policy = classifyRegistryAudit(summary.audit?.observedAdvisories, baseline, summary.audit?.directAdvisories ?? []);
  if (JSON.stringify(policy.unlistedAdvisories) !== JSON.stringify(summary.audit?.unlistedAdvisories)) {
    throw new Error("summary advisory classification does not match baseline");
  }
  validateAuditCounts(summary.audit);
  if ((summary.audit.total === 0) !== (policy.observedAdvisories.length === 0)) throw new Error("audit totals disagree with advisory evidence");
  return policy;
}
export function registryAuditDriftDisposition(summary, baseline = JSON.parse(readFileSync(baselinePath, "utf8"))) {
  if (summary?.schema !== ACCEPTANCE_SUMMARY_SCHEMA) return { exitCode: 3, message: "unexpected acceptance schema" };
  // A run that stopped before its audit was classified has no advisory IDs to
  // compare: report where and why it stopped, not a malformed baseline.
  if (summary?.schema === ACCEPTANCE_SUMMARY_SCHEMA && summary.complete === false) {
    const failureClass = interruptedFailureClass(summary);
    return { exitCode: 1, evaluated: false, failureClass, message: "Advisory-ID drift was not evaluated: acceptance stopped " +
      `at stage ${String(summary.failedStage || "unknown")} (${failureClass} failure${failureClass === "network" ? "; rerun the workflow" : ""})` };
  }
  if (summary.complete !== true) return { exitCode: 3, message: "acceptance is not complete" };
  try {
    const policy = summaryAudit(summary, baseline);
    return { exitCode: policy.unlistedAdvisories.length ? 3 : 0,
      message: policy.unlistedAdvisories.length ? `Unlisted advisory IDs: ${policy.unlistedAdvisories.join(", ")}` : "No advisory-ID drift", ...policy };
  } catch (error) { return { exitCode: 3, message: String(error) }; }
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
function candidateInventory(closure, installed, registry) {
  const modules = new Map();
  const errors = [];
  const { origin, path } = consumerRegistry(registry);
  for (const [location, record] of closure.entries) {
    if (!record.present && closure.inventory !== null) continue;
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
  return candidates.filter(({ name }) => manifest.name === name)
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

// npm prints `network timeout at:` (code FETCH_ERROR) for a request timeout and
// `Response timeout while trying to fetch` for a body timeout.
export const FAILURE_CLASSES = ["network", "policy", "functional"];
const MAX_FAILURE_EVIDENCE_ENTRIES = 5, MAX_FAILURE_EVIDENCE_BYTES = 8192;
const networkSignature = /\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ESOCKETTIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|E5\d\d|E408|E429)\b|socket hang up|network timeout at: |Response timeout while trying to fetch|TLS handshake timeout|i\/o timeout|toomanyrequests|curl: \((?:6|7|28|35|52|56)\)|dial tcp: lookup .+: (?:no such host|server misbehaving|temporary failure)|Could not resolve (?:host|proxy):|Failed to connect to .+ port \d+|Connection (?:timed out|refused)|connect: (?:connection refused|network is unreachable)|\b(?:408|429|5\d\d) [^\r\n]+ - (?:GET|POST) https?:\/\/|invalid json response body at |Invalid response body while trying to fetch |^registry ping did not succeed within 30 attempts$/;
function retryableFailureEvidence(text) {
  const code = npmErrorCode(text);
  try {
    const endpoint = JSON.parse(text);
    return typeof endpoint?.message === "string" && !["auditReportVersion", "vulnerabilities", "metadata"].some(key => Object.hasOwn(endpoint, key)) &&
      (endpoint.statusCode === undefined ? networkSignature.test(endpoint.message) :
        Number.isInteger(endpoint.statusCode) && ([408, 429].includes(endpoint.statusCode) || (endpoint.statusCode >= 500 && endpoint.statusCode <= 599)));
  } catch { return (!code || code === "FETCH_ERROR" || networkSignature.test(code)) && networkSignature.test(text); }
}
function interruptedFailureClass(summary) {
  return typeof summary.failedStage === "string" && summary.failedStage.trim() && FAILURE_CLASSES.includes(summary.failureClass) &&
    (summary.failureClass !== "network" || (Array.isArray(summary.failureEvidence) && summary.failureEvidence.length <= MAX_FAILURE_EVIDENCE_ENTRIES &&
      [...summary.failureEvidence].every(line => typeof line === "string" && Buffer.byteLength(line) <= MAX_FAILURE_EVIDENCE_BYTES) &&
      summary.failureEvidence.some(retryableFailureEvidence))) ? summary.failureClass : "functional";
}
const npmErrorCode = text => /^npm error code (\S+)$/m.exec(text ?? "")?.[1] ?? null;
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
    const identities = candidates.filter(candidate => names.includes(candidate.name));
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
  const manifestText = readFileSync(join(project, "package.json"), "utf8");
  const manifest = JSON.parse(manifestText);
  const lock = JSON.parse(readFileSync(join(project, "package-lock.json"), "utf8"));
  const missing = DUAL_RAIL_DEPENDENCIES.filter(name => typeof manifest.dependencies?.[name] !== "string");
  if (missing.length) throw new Error("dual-rail consumer is missing " + missing.join(", "));
  const candidates = releaseCandidates(releaseSet, version);
  const installer = npmInstallContract(project);
  const closure = referenceInstallation({ manifest, lock, installer,
    readArchive: (_location, entry) => cachedArchive(installer.config.cache, entry.integrity) });
  const differences = installationDifferences(project, closure).map(line => "installed tree is not the locked archives: " + line);
  const installed = closure.errors.length === 0 && differences.length === 0 &&
    [...closure.entries.values()].every(record => !record.present || !record.unverified)
    ? installedCandidateModules(project, closure) : new Map();
  const errors = [...closure.errors, ...differences.slice(0, MAX_LISTED_DIFFERENCES),
    ...(differences.length > MAX_LISTED_DIFFERENCES ? [`and ${differences.length - MAX_LISTED_DIFFERENCES} more differences`] : []),
    ...candidateIntegrityErrors({ manifestText, manifest, lock, registry, candidates, closure, installed })];
  if (errors.length) throw new Error(errors.join("\n"));
  const violations = registryDependencyViolations({ manifest, lock, registry });
  writeFileSync(report, JSON.stringify({ schema: "dacs-registry-dependency-policy/v1", passed: violations.length === 0,
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

// Records observed identities for comparison with the baseline rules below.
export function extractPolicyFindings(read) {
  const json = name => JSON.parse(read(name) ?? "null");
  const exitCode = name => {
    const text = read(name)?.trim();
    return typeof text === "string" && /^\d{1,3}$/.test(text) && Number(text) <= 255 ? Number(text) : null;
  };
  const lock = json("generated-package-lock.json");
  const packages = lock?.packages ?? {};
  const identity = location => ({ version: packages[location]?.version ?? null, integrity: packages[location]?.integrity ?? null });
  const gitDependencies = json("dependency-policy.json")?.violations?.map(violation =>
    ({ location: violation.location, field: violation.field ?? null, value: violation.value, ...identity(violation.location) })) ?? null;
  const strictLog = read("engine-strict.log") ?? "";
  let versions = null;
  try { versions = json("engine-versions.json"); } catch { /* unreadable: the scan is incomplete */ }
  const { scanComplete, violations, ...scan } = scanLockEngines(lock, versions);
  const sbom = name => {
    const errors = read(`${name}.err`) ?? "";
    return { exitCode: exitCode(`${name}.exit-code`), code: npmErrorCode(errors),
      problems: [...errors.matchAll(/^npm error ((?:missing|invalid|extraneous): .+)$/gm)].map(match => match[1]) };
  };
  const image = json("runtime-image-policy.json") ?? {};
  let inventory = null;
  try { inventory = json("runtime-image-inventory.json"); } catch { /* unreadable: the inventory is incomplete */ }
  const { unexpected, ...imageInventory } = runtimeImageInventoryFindings(inventory, lock);
  // Retain prohibited packages even when they match the production closure.
  const named = [["typescript", image.typescriptPresent], ["rubic-sdk", image.rubicSdkPresent]]
    .flatMap(([name, present]) => {
      const copies = (Array.isArray(inventory?.packages) ? inventory.packages : [])
        .filter(item => item?.name === name || item?.location === `node_modules/${name}`);
      return copies.length ? copies.map(copy => ({ name: copy.name, location: copy.location, ...identity(copy.location), version: copy.version }))
        : present === true ? [{ name, location: null, version: null, integrity: null }] : [];
    });
  const productionImageDependencies = [...named, ...unexpected.filter(item =>
    !named.some(known => known.location === item.location && known.name === item.name))];
  return {
    schema: POLICY_FINDINGS_SCHEMA,
    gitDependencies,
    engine: { exitCode: exitCode("engine-strict.exit-code"), code: npmErrorCode(strictLog),
      reportedPackage: /Not compatible with your version of node\/npm: (\S+)/.exec(strictLog)?.[1] ?? null,
      scan, scanComplete, violations },
    lockSbom: sbom("consumer-lock-sbom"),
    physicalSbom: sbom("consumer-physical-sbom"),
    productionImageDependencies,
    productionImageInventory: imageInventory,
  };
}

// Baseline Git, engine and image identities pin archive version and integrity;
// engine ones also pin the required range. SBOM rules elide patch versions in
// their problem text.
const sameIdentity = (keys) => (item, known) => keys.every(key => JSON.stringify(item?.[key]) === JSON.stringify(known?.[key]));
const gitIdentity = sameIdentity(["location", "field", "value", "version", "integrity"]);
const engineIdentity = sameIdentity(["package", "location", "integrity", "required"]);
const imageIdentity = sameIdentity(["name", "location", "version", "integrity"]);
const sbomProblemRule = (line) => typeof line === "string" ? line
  .replace(/^((?:invalid|extraneous): (?:@[^\s@/]+\/)?[^\s@]+)@[^\s,]+/, "$1@*")
  .replace(/( required by (?:@[^\s@/]+\/)?[^\s@]+)@\S+$/, "$1@*") : line;
const sbomIdentity = (item, known) => typeof item === "string" && sbomProblemRule(item) === sbomProblemRule(known);
const allListed = (items, known, same) => Array.isArray(items) && items.length > 0 && Array.isArray(known) &&
  items.every(item => known.some(entry => same(item, entry)));

// Classifies each check as passed, baseline-only or blocked, failing closed.
export function classifyPolicyChecks(summary, baseline) {
  const gate = summary?.securityGate ?? {};
  const findings = gate.findings ?? {};
  const known = baseline?.policyFindings ?? {};
  const engine = findings.engine;
  const inventory = findings.productionImageInventory;
  const image = summary?.docker?.policy;
  const imageRead = typeof image?.productionDependencyPolicyPassed === "boolean" &&
    image.productionDependencyPolicyPassed === gate.productionImageDependencyPolicyPassed &&
    [["typescript", image.typescriptPresent], ["rubic-sdk", image.rubicSdkPresent]].every(([name, present]) =>
      typeof present === "boolean" && Array.isArray(findings.productionImageDependencies) &&
      present === findings.productionImageDependencies.some(item => item?.name === name));
  // Require a complete inventory and the whole required production closure.
  const inventoryRead = inventory?.scanComplete === true && Array.isArray(inventory.missing) &&
    inventory.missing.length === 0 && Array.isArray(inventory.errors) && inventory.errors.length === 0;
  const sbom = (exitCode, observed, knownProblems) => exitCode === 0
    ? (observed?.exitCode === 0 && observed.code === null && Array.isArray(observed.problems) && observed.problems.length === 0 ? "passed" : "blocked") :
    exitCode === 1 && observed?.exitCode === exitCode && observed.code === "ESBOMPROBLEMS" &&
      allListed(observed.problems, knownProblems, sbomIdentity) ? "baseline" : "blocked";
  return {
    registryDependency: gate.registryDependencyPolicyPassed === true
      ? (Array.isArray(findings.gitDependencies) && findings.gitDependencies.length === 0 ? "passed" : "blocked")
      : gate.registryDependencyPolicyPassed === false && allListed(findings.gitDependencies, known.gitDependencies, gitIdentity) ? "baseline" : "blocked",
    productionImage: !inventoryRead || !imageRead ? "blocked" : gate.productionImageDependencyPolicyPassed === true
      ? (Array.isArray(findings.productionImageDependencies) && findings.productionImageDependencies.length === 0 ? "passed" : "blocked")
      : gate.productionImageDependencyPolicyPassed === false && allListed(findings.productionImageDependencies, known.productionImageDependencies, imageIdentity) ? "baseline" : "blocked",
    engineStrict: gate.engineStrictExitCode === 0
      ? (engine?.exitCode === 0 && engine.code === null && engine.scanComplete === true && Array.isArray(engine.violations) && engine.violations.length === 0 ? "passed" : "blocked") :
      gate.engineStrictExitCode === 1 && engine?.exitCode === gate.engineStrictExitCode && engine.code === "EBADENGINE" && engine.scanComplete === true &&
        Array.isArray(engine.violations) && engine.violations.some(violation => violation.package === engine.reportedPackage) &&
        allListed(engine.violations, known.engineViolations, engineIdentity) ? "baseline" : "blocked",
    lockSbom: sbom(gate.lockSbomExitCode, findings.lockSbom, known.lockSbomProblems),
    physicalSbom: sbom(gate.physicalSbomExitCode, findings.physicalSbom, known.physicalSbomProblems),
  };
}

// The findings of each blocked check that the #191 baseline does not record,
// so a blocked run's log names them. Diagnostic only: it decides nothing.
export function unlistedPolicyFindings(summary, baseline, blocked) {
  const findings = summary?.securityGate?.findings ?? {};
  const known = baseline?.policyFindings ?? {};
  const outside = (items, knownItems, same) => (Array.isArray(items) ? items : [])
    .filter(item => !(Array.isArray(knownItems) && knownItems.some(entry => same(item, entry))));
  const inventory = findings.productionImageInventory ?? {};
  const named = {
    registryDependency: () => outside(findings.gitDependencies, known.gitDependencies, gitIdentity),
    productionImage: () => [
      ...(inventory.scanComplete === true ? [] : ["image inventory scan incomplete"]),
      ...(Array.isArray(inventory.errors) ? inventory.errors.map(error => `inventory error: ${String(error)}`) : []),
      ...(Array.isArray(inventory.missing) ? inventory.missing.map(item => `missing: ${JSON.stringify(item)}`) : []),
      ...outside(findings.productionImageDependencies, known.productionImageDependencies, imageIdentity)],
    engineStrict: () => outside(findings.engine?.violations, known.engineViolations, engineIdentity),
    lockSbom: () => outside(findings.lockSbom?.problems, known.lockSbomProblems, sbomIdentity),
    physicalSbom: () => outside(findings.physicalSbom?.problems, known.physicalSbomProblems, sbomIdentity),
  };
  return Object.fromEntries(blocked.filter(name => name in named).map(name => [name, named[name]()]));
}

// "fail" (the default) or "warn": what an advisory ID outside the baseline does.
export const UNLISTED_ADVISORY_POLICIES = ["fail", "warn"];

export function registryContainerDisposition(summary, baseline = JSON.parse(readFileSync(baselinePath, "utf8")),
  { unlistedAdvisories = "fail", packageVersion = RELEASE_VERSION } = {}) {
  if (!UNLISTED_ADVISORY_POLICIES.includes(unlistedAdvisories)) {
    throw new Error(`unknown unlisted-advisory policy ${JSON.stringify(unlistedAdvisories)}`);
  }
  if (summary?.schema !== ACCEPTANCE_SUMMARY_SCHEMA) {
    return { exitCode: 1, failureClass: "functional", message: "registry/container acceptance summary has an unexpected schema" };
  }
  if (summary.complete === false) {
    const failureClass = interruptedFailureClass(summary);
    return { exitCode: 1, failureClass, message: `registry/container acceptance stopped at stage ` +
      `${String(summary.failedStage || "unknown")} (${failureClass} failure)` };
  }
  if (summary.complete !== true) return { exitCode: 1, failureClass: "functional", message: "acceptance is not complete" };
  if (summary.docker?.policy?.schema !== RUNTIME_IMAGE_POLICY_SCHEMA ||
      summary.securityGate?.findings?.schema !== POLICY_FINDINGS_SCHEMA) {
    return { exitCode: 1, failureClass: "functional",
      message: "registry/container acceptance summary embeds evidence with an unexpected schema" };
  }
  // A summary for another (or no) version says nothing about this release:
  // its candidates were checked against the version it names.
  if (typeof packageVersion !== "string" || packageVersion === "" || summary.packageVersion !== packageVersion) {
    return { exitCode: 1, failureClass: "functional", message: "registry/container acceptance summary is for package " +
      `version ${JSON.stringify(summary.packageVersion)}, not the release version ${JSON.stringify(packageVersion)}` };
  }
  if (summary.functionalPassed !== true || summary.generatedTestsPassed !== true) {
    return { exitCode: 1, failureClass: "functional", message: "functional registry/container rehearsal failed" };
  }
  let policy;
  try { policy = summaryAudit(summary, baseline); }
  catch (error) { return { exitCode: 3, failureClass: "policy", checks: { audit: "blocked" }, message: String(error) }; }
  const gate = summary.securityGate;
  const checks = classifyPolicyChecks(summary, baseline);
  const observed = policy.observedAdvisories.length;
  // SECURITY.md's audit policy: a transitive advisory assessed for reachability
  // does not block; a high/critical advisory on a direct dependency always does
  // (an older summary that does not record directness cannot show otherwise).
  const directKnown = Array.isArray(summary.audit?.directAdvisories);
  const assessedDirect = policy.assessedAdvisories.filter(id => !directKnown || policy.directAdvisories.includes(id));
  // An ID outside the baseline, even one newly published against a dependency
  // the tree already had, is "unlisted" under the pull-request warn policy and
  // blocks otherwise. One that is high or critical on a direct dependency
  // blocks under both policies, as CI fails on any direct high/critical one.
  const unlistedDirect = policy.unlistedAdvisories.filter(id => policy.directAdvisories.includes(id));
  // The #191 baseline waives transitive findings only: a baselined ID that is
  // high or critical on a direct dependency blocks, so a baseline-only exit 4
  // (which lets a prerelease publish) never covers one.
  const baselineDirect = policy.directAdvisories.filter(id => baseline.advisoryIds.includes(id));
  const audit = ![0, 1].includes(gate?.auditExitCode) || (gate.auditExitCode !== (summary.audit.total > 0 ? 1 : 0)) ||
      assessedDirect.length > 0 || unlistedDirect.length > 0 || baselineDirect.length > 0 ? "blocked"
    : policy.unlistedAdvisories.length > 0 ? (unlistedAdvisories === "warn" ? "unlisted" : "blocked")
    : observed > policy.assessedAdvisories.length ? "baseline" : "passed";
  const states = { ...checks, audit };
  const named = state => Object.keys(states).filter(name => states[name] === state);
  if (named("passed").length === Object.keys(states).length && gate.passed === true) {
    return { exitCode: 0, failureClass: null, message: "registry/container acceptance passed", checks: states, ...policy };
  }
  if (named("blocked").length === 0 && gate.passed === false && (named("baseline").length > 0 || named("unlisted").length > 0)) {
    return { exitCode: 4, failureClass: "policy", checks: states, message: "functional registry/container rehearsal passed; " +
      "production publication remains blocked" +
      (named("baseline").length ? ` by #191 baseline findings (${named("baseline").join(", ")})` : "") +
      (audit === "unlisted" ? `; advisory IDs not in the #191 baseline (a pull-request warning; the scheduled drift job ` +
        `and release paths fail on them): ${policy.unlistedAdvisories.join(", ")}` : ""), ...policy };
  }
  const unlisted = Object.entries(unlistedPolicyFindings(summary, baseline, named("blocked")))
    .map(([name, items]) => `${name}: ${items.length ? items.map(item =>
      typeof item === "string" ? item : JSON.stringify(item)).join("; ") : "no finding recorded"}`);
  return { exitCode: 3, failureClass: "policy", checks: states, message: "functional registry/container rehearsal passed, " +
    `but the #191 security gate is blocked beyond the recorded baseline (${named("blocked").join(", ")})` +
    (unlisted.length ? `; findings outside the #191 baseline: ${unlisted.join(" | ")}` : "") +
    (policy.unlistedAdvisories.length ? `; advisory IDs not in the #191 baseline: ${policy.unlistedAdvisories.join(", ")}. ` +
      "Review them, then add them to scripts/registry-container-audit-baseline.json and .md in a PR under CODEOWNERS review" : "") +
    (unlistedDirect.length ? `; of those, high or critical on a direct dependency, which fail pull requests too: ` +
      unlistedDirect.join(", ") : "") +
    (assessedDirect.length ? `; assessed advisories that are high or critical on a direct dependency (or of unrecorded ` +
      `directness), which an assessment cannot accept: ${assessedDirect.join(", ")}` : "") +
    (baselineDirect.length ? `; #191 baseline advisories that are high or critical on a direct dependency, which the ` +
      `baseline cannot waive: ${baselineDirect.join(", ")}` : ""),
    ...policy };
}

function invalidateReport(input, output) {
  if (resolve(input) === resolve(output)) throw new Error("evidence input and output must differ");
  rmSync(output, { force: true });
}

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

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [mode, input, output] = process.argv.slice(2);
  if (mode === "--audit-policy" && input && output) {
    invalidateReport(input, output);
    const audit = JSON.parse(readFileSync(input, "utf8"));
    const counts = audit.metadata?.vulnerabilities;
    validateAuditGraph(audit);
    const ids = new Set();
    const direct = new Set();
    for (const vulnerability of Object.values(audit.vulnerabilities)) {
      for (const via of Array.isArray(vulnerability?.via) ? vulnerability.via : []) {
        if (typeof via === "object" && via !== null) {
          if (typeof via.url !== "string") throw new Error("npm audit advisory URL missing");
          const id = via.url.replace(/^https:\/\/github\.com\/advisories\//, "");
          ids.add(id);
          // The advisory is the direct dependency's own (a `via` object), not
          // one inherited from its dependencies (a `via` name).
          if (vulnerability.isDirect === true && ["high", "critical"].includes(via.severity)) direct.add(id);
        }
      }
    }
    const policy = classifyRegistryAudit([...ids], JSON.parse(readFileSync(baselinePath, "utf8")), [...direct]);
    // Passed only if every observed advisory is an assessed transitive one; the
    // summary also requires npm audit's exit status to be 0 or 1.
    const passed = policy.assessedAdvisories.length === policy.observedAdvisories.length &&
      policy.assessedAdvisories.every(id => !direct.has(id));
    writeFileSync(output, JSON.stringify({ schema: "dacs-registry-audit-policy/v1", observed: counts, ...policy, passed },
      null, 2) + "\n");
    process.stdout.write(JSON.stringify(counts) + "\n");
  } else if (mode === "--dependency-policy") {
    // <project> must be installed with lifecycle scripts disabled and unused by
    // any package code so far; see candidateIntegrityErrors.
    const [projectPath, registry, report, releaseSet, version] = process.argv.slice(3);
    if (report) rmSync(report, { force: true });
    if (!projectPath || !registry || !report || !releaseSet || !version) {
      throw new Error("usage: --dependency-policy <project> <registry> <report> <release-set> <version>");
    }
    writeDependencyPolicyReport({ projectPath, registry, report, releaseSet, version });
  } else if (mode === "--policy-findings" && input && output) {
    invalidateReport(input, output);
    const read = name => existsSync(join(input, name)) ? readFileSync(join(input, name), "utf8") : undefined;
    writeFileSync(output, JSON.stringify(extractPolicyFindings(read), null, 2) + "\n");
  } else {
    const drift = mode === "--audit-drift";
    const record = mode === "--record";
    const summaryPath = drift || record ? input : mode;
    const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
    // Unset means fail closed; only the pull_request acceptance job sets warn.
    const unlistedAdvisories = process.env.DACS_UNLISTED_ADVISORIES || "fail";
    const result = drift ? registryAuditDriftDisposition(summary)
      : registryContainerDisposition(summary, undefined, { unlistedAdvisories });
    if (record) {
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
  }
}
