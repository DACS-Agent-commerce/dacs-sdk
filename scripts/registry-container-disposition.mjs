#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cachedArchive, installationClosure, installationDifferences, packedFiles } from "./installation-closure.mjs";
import { runtimeImageInventory, RUNTIME_IMAGE_INVENTORY_SCHEMA } from "./runtime-image-inventory.mjs";
import { atomicWriteJson, boundedEvidenceText, evidenceLines, readEvidence } from "./acceptance-evidence-io.mjs";
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

// Check every package count and every inherited advisory edge before policy admission.
function validateAuditGraph(audit) {
  const counts = audit.metadata?.vulnerabilities;
  validateAuditCounts(counts);
  if (!isPlainObject(audit.vulnerabilities)) throw new Error("npm audit vulnerability graph missing");
  const entries = Object.entries(audit.vulnerabilities);
  if (entries.length > MAX_AUDIT_PACKAGES || entries.length !== counts.total || auditSeverities.some(severity =>
      entries.filter(([, value]) => value?.severity === severity).length !== counts[severity])) {
    throw new Error("npm audit graph disagrees with vulnerability counts");
  }
  const reached = new Set();
  const dependents = new Map();
  for (const [name, value] of entries) {
    if (typeof value.isDirect !== "boolean") throw new Error("npm audit directness must be an explicit boolean");
    if (!Array.isArray(value.via) || value.via.length === 0 || value.via.length > MAX_ADVISORY_EDGES) {
      throw new Error("incomplete npm audit advisory graph");
    }
    for (const via of value.via) {
      if (typeof via === "string" && Object.hasOwn(audit.vulnerabilities, via)) {
        const parents = dependents.get(via) ?? [];
        parents.push(name); dependents.set(via, parents);
      } else if (isPlainObject(via) && auditSeverities.includes(via.severity)) reached.add(name);
      else throw new Error("incomplete npm audit advisory graph");
    }
  }
  const queue = [...reached];
  for (let index = 0; index < queue.length; index++) {
    for (const parent of dependents.get(queue[index]) ?? []) {
      if (!reached.has(parent)) { reached.add(parent); queue.push(parent); }
    }
  }
  if (reached.size !== entries.length) throw new Error("incomplete npm audit advisory graph");
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

// The executing npm's command-line entry (npm_execpath), or that of the npm on PATH.
const npmCliPath = () => join(dirname(process.env.npm_execpath ?? join(execFileSync("npm", ["root", "--global"],
  { encoding: "utf8" }).trim(), "npm/bin/npm-cli.js")), "npm-cli.js");

// Use the executing npm's parser, including loose semver and alias-name rules.
// Acceptance pins npm; this keeps dependency grammar separate from engine ranges.
let npmPackageArg;
function registrySourceSpec(value) {
  if (typeof value !== "string") return false;
  if (!npmPackageArg) npmPackageArg = createRequire(npmCliPath())("npm-package-arg");
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
// Node resolves a bare specifier to a directory or to one of these files.
const MODULE_FILE_EXTENSIONS = [".js", ".json", ".node"];
const MAX_LISTED_DIFFERENCES = 20;

// The release candidates in `releaseSet`, as `{ name, integrity, version,
// files }`: each packed tarball must be the one release-provenance.json
// records for `version` before either is compared with the consumer's lock.
function releaseCandidates(releaseSet, version) {
  const provenance = JSON.parse(readFileSync(join(releaseSet, "release-provenance.json"), "utf8"));
  if (provenance?.version !== version) throw new Error(`release-provenance.json is not for version ${version}`);
  return CANDIDATE_NAMES.map(name => {
    const bytes = readFileSync(join(releaseSet, `${name.slice(1).replace("/", "-")}-${version}.tgz`));
    const integrity = "sha512-" + createHash("sha512").update(bytes).digest("base64");
    const recorded = provenance.packages?.[name]?.integrity;
    if (recorded !== integrity) {
      throw new Error(`release-provenance.json records ${String(recorded)} for ${name}, but the packed tarball is ${integrity}`);
    }
    return { name, integrity, version, files: packedFiles(bytes) };
  });
}

function declaredInstallScripts(files) {
  const scripts = JSON.parse(files.get("package.json").toString("utf8"))?.scripts;
  return [...INSTALL_LIFECYCLE_SCRIPTS.filter(script => isPlainObject(scripts) && script in scripts),
    ...(files.has("binding.gyp") ? ["binding.gyp"] : [])];
}

// Each candidate `owner` (a manifest or lock entry) declares, directly or as
// an `npm:` alias, by the specifier its code imports it with.
function declaredCandidates(owner, candidates) {
  const declared = [];
  for (const field of specFields) {
    for (const [specifier, spec] of Object.entries(isPlainObject(owner?.[field]) ? owner[field] : {})) {
      const name = typeof spec === "string" && /^npm:/i.test(spec) && registrySourceSpec(spec)
        ? npmPackageArg.resolve(specifier, spec).subSpec?.name : specifier;
      const candidate = candidates.find(release => release.name === name);
      if (candidate) declared.push({ specifier, candidate });
    }
  }
  return declared;
}

// Every package.json scope in an archive, retaining manifests rather than
// archive/file buffers after extraction. No module-root search limits the list.
function archivePackageScopes(owner, archive) {
  const scopes = new Map();
  for (const [path, bytes] of packedFiles(archive)) {
    if (posix.basename(path) !== "package.json") continue;
    const scope = { owner };
    try {
      scope.manifest = JSON.parse(bytes.toString("utf8"));
      scope.unreadable = !isPlainObject(scope.manifest);
    } catch { scope.unreadable = true; }
    scopes.set(posix.dirname(`${owner}/${path}`), scope);
  }
  return scopes;
}

// A closed inventory of physical module roots and EVERY package.json scope,
// including scopes outside node_modules. Only archives checked against the
// installed tree contribute manifests; opaque registry entries cannot pass.
function candidateInventory(closure, scopes, registry) {
  const modules = new Map(closure.carried);
  const errors = [];
  const { origin, path } = consumerRegistry(registry);
  for (const [location, record] of closure.entries) {
    if (!record.present) continue;
    modules.set(location, { owner: record.bundledBy ?? location, entry: record.entry,
      name: location.replace(/^.*node_modules\//, ""), manifest: record.manifest });
    if (record.unverified) {
      let url;
      try { url = new URL(record.entry.resolved); } catch { /* source policy refuses non-registry entries */ }
      if (url?.origin === origin && url.pathname.startsWith(path)) {
        errors.push("cannot authenticate an unverified registry archive: " + location);
      }
    }
  }
  for (const [location, scope] of scopes) modules.set(location, { ...modules.get(location), ...scope });
  return { modules, errors };
}

// Every declaration from the project, installed lock entries and the complete
// archive scope inventory, once, with its declaring directory.
function candidateDeclarations(manifest, lock, inventory, candidates) {
  const owners = [["", manifest], ["", lock?.packages?.[""]]];
  for (const [location, module] of inventory.modules) {
    owners.push([location, module.entry], [location, module.manifest]);
  }
  const declarations = new Map();
  for (const [location, owner] of owners) {
    for (const { specifier, candidate } of declaredCandidates(owner, candidates)) {
      declarations.set(JSON.stringify([location, specifier, candidate.name]), { location, specifier, candidate });
    }
  }
  return [...declarations.values()];
}

// A copy of `candidate` installed at `location` must be its packed tarball,
// fetched through the isolated registry, at the release's name and version.
function releaseCopyErrors(location, entry, { name, integrity, version }, registry) {
  const { origin, path } = consumerRegistry(registry);
  const errors = [];
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

// A report-shaped `npm audit --json` document: a result for the audit policy.
const isAuditReport = value => typeof value === "object" && value !== null &&
  ("auditReportVersion" in value || "vulnerabilities" in value || "metadata" in value);
// npm's fetch errors: a request or body timeout, a refused or reset connection,
// and a body that is not JSON or was cut off (a proxy's HTML page, a drop).
const transientAuditMessage = /^(?:network timeout at: |request to \S+ failed, reason: |Response timeout while trying to fetch |invalid json response body at |Invalid response body while trying to fetch )/;

// When the audit endpoint fails, `npm audit --json` writes npm's audit error
// object (lib/utils/audit-error.js) instead of a report: a string `message`,
// with the HTTP answer's `statusCode` or, for a fetch error, no status. Every
// such object is an endpoint error. One with no status, a 5xx/408/429 status
// or a transient fetch message is network; any other answer means the audit
// could not be run (functional). Neither is a policy result. Returns null for
// anything else, a report included.
export function auditEndpointError(text) {
  let value;
  try { value = JSON.parse(text ?? ""); } catch { return null; }
  if (typeof value !== "object" || value === null || typeof value.message !== "string" || isAuditReport(value)) return null;
  const status = Number.isInteger(value.statusCode) ? value.statusCode : null;
  const transient = status === null || (status >= 500 && status <= 599) || status === 408 || status === 429 ||
    transientAuditMessage.test(value.message);
  return { transient, statusCode: status, message: value.message.replace(/\s+/g, " ").slice(0, 300) };
}

// The evidence each network-dependent stage leaves behind. Consumer output
// also holds generated-test logs, so only npm and Docker errors count there.
const stageEvidence = {
  "release-set": [["release-set.log", () => true]],
  "registry-start": [["registry.log", () => true]],
  "registry-auth": [["registry.log", () => true]],
  publish: [["registry.log", () => true]],
  consumer: [["generation.log", line => /^npm error |Error response from daemon|^docker: /.test(line)]],
  "audit-policy": [["npm-audit.json", () => true]],
  "image-build": [["docker-build.log", () => true]],
};
const policyStages = new Set(["dependency-policy", "audit-policy"]);

/** Classifies bounded stage evidence; oversized or unreadable diagnostics fail functionally. */
export function classifyAcceptanceFailure({ stage, read }) {
  try { return classifyBoundedFailure({ stage, read: name => boundedEvidenceText(read(name)) }); }
  catch (error) { return { failureClass: "functional", evidence: ["evidence classification failed: " + String(error.message).slice(0, 300)] }; }
}

function classifyBoundedFailure({ stage, read }) {
  if (stage === "audit-policy") {
    const text = read("npm-audit.json");
    const endpoint = auditEndpointError(text);
    if (endpoint) {
      return { failureClass: endpoint.transient ? "network" : "functional",
        evidence: [`npm-audit.json: audit endpoint error: ${endpoint.message}`] };
    }
    // A report the policy rejected is a policy result, whatever text its
    // advisories carry: the network signature is only for other evidence.
    let report = null;
    try { report = JSON.parse(text ?? ""); } catch { /* not JSON */ }
    if (isAuditReport(report)) return { failureClass: "policy", evidence: [] };
  }
  const evidence = [];
  for (const [name, relevant] of stageEvidence[stage] ?? []) {
    for (const line of evidenceLines(read(name))) {
      if (evidence.length < 5 && relevant(line) && networkSignature.test(line)) evidence.push(`${name}: ${line.trim()}`);
    }
  }
  if (evidence.length > 0) return { failureClass: "network", evidence: evidence.slice(0, 5) };
  // Verdaccio never answered its ping: the registry endpoint was unreachable.
  if (stage === "registry-ready") return { failureClass: "network", evidence: ["registry ping did not succeed within 30 attempts"] };
  return { failureClass: policyStages.has(stage) ? "policy" : "functional", evidence: [] };
}

export function failureSummary({ stage, exitCode, read }) {
  const { failureClass, evidence } = classifyAcceptanceFailure({ stage, read });
  return { schema: ACCEPTANCE_SUMMARY_SCHEMA, complete: false, failedStage: stage, exitCode, failureClass,
    failureEvidence: evidence, functionalPassed: false, generatedTestsPassed: false };
}

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

// Every sensitive identity in the closed inventory must be an independently
// locked release archive. Nested scopes, carried modules and file shadows have
// no such identity. A nested scope declaring candidates is refused as well.
function candidateInventoryErrors(closure, inventory, candidates, declarations, registry) {
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
    const identities = candidates.filter(candidate => names.includes(candidate.name) ||
      declarations.some(declared => declared.candidate === candidate && names.includes(declared.specifier)));
    if (!module.entry && (identities.length || module.unreadable || declaredCandidates(module.manifest, candidates).length)) {
      errors.push(`cannot authenticate a candidate copy carried in the archive of ${module.owner}: ${location}`);
    } else {
      if (module.unreadable) errors.push("cannot read an archive package scope: " + location);
      for (const candidate of identities) errors.push(...releaseCopyErrors(location, module.entry, candidate, registry));
    }
  }
  return errors;
}

// The first module Node finds for `specifier` from `directory`: its ESM
// resolver walks up every parent to the file system root, a node_modules
// directory included, and stops at the first directory of that name; require()
// then searches its global folders (NODE_PATH, the home and install ones) and
// also loads a file of that name with an extension.
function firstModule(directory, specifier) {
  const lookups = [];
  for (let current = directory; ; current = dirname(current)) {
    lookups.push(join(current, "node_modules"));
    if (dirname(current) === current) break;
  }
  lookups.push(...createRequire(join(directory, "package.json")).resolve.paths(specifier) ?? []);
  for (const lookup of new Set(lookups)) {
    const found = [specifier, ...MODULE_FILE_EXTENSIONS.map(extension => specifier + extension)]
      .map(name => join(lookup, name)).find(path => existsSync(path));
    if (found) return found;
  }
  return null;
}

// Node's own resolution of each declared specifier from its declaring
// directory, as the absolute files it loads: require.resolve here and
// import.meta.resolve in a child process, as its parent argument needs a flag.
// A specifier that cannot resolve, or resolves to a built-in, gives none.
const ESM_RESOLUTIONS = "process.stdout.write(JSON.stringify(JSON.parse(process.argv[1]).map(([specifier, parent]) => " +
  "{ try { return import.meta.resolve(specifier, parent); } catch { return null; } })));";
const RESOLUTION_TIMEOUT_MS = 30_000;
const MAX_RESOLUTION_OUTPUT_BYTES = 1024 * 1024;
function nodeResolutions(project, declarations) {
  const parents = declarations.map(({ location }) => join(project, location, "package.json"));
  const esm = spawnSync(process.execPath, ["--experimental-import-meta-resolve", "--input-type=module", "--eval", ESM_RESOLUTIONS,
    JSON.stringify(declarations.map(({ specifier }, index) => [specifier, pathToFileURL(parents[index]).href]))],
  { encoding: "utf8", timeout: RESOLUTION_TIMEOUT_MS, maxBuffer: MAX_RESOLUTION_OUTPUT_BYTES });
  if (esm.status !== 0) throw new Error("Node's ESM resolver failed: " + (esm.error?.message ?? esm.stderr));
  const urls = JSON.parse(esm.stdout);
  return declarations.map(({ specifier }, index) => {
    const files = typeof urls[index] === "string" && urls[index].startsWith("file:") ? [fileURLToPath(urls[index])] : [];
    try { files.push(createRequire(parents[index]).resolve(specifier)); } catch { /* require() throws as well */ }
    return files.filter(file => isAbsolute(file));
  });
}

// Each declared candidate specifier must lead Node, from the directory of the
// package declaring it, to an installed copy of the release, or to nothing at
// all where npm left an optional copy out. Node's own resolution must agree.
function candidateResolutionErrors(project, closure, declarations) {
  const resolutions = nodeResolutions(project, declarations);
  return declarations.flatMap(({ location, specifier, candidate }, index) => {
    const declared = `${specifier} declared by ${location || "the project"}`;
    const found = firstModule(join(project, location), specifier);
    const elsewhere = resolutions[index].filter(file => found === null || (file !== found && !file.startsWith(found + sep)));
    if (found === null) return elsewhere.map(file => `${declared} resolves to ${file}, which no module Node searched holds`);
    const holder = relative(project, found);
    if (holder.startsWith("..") || isAbsolute(holder)) return [`${declared} loads ${found}, outside the installation`];
    const record = closure.entries.get(holder);
    if (!record?.present || record.entry.integrity !== candidate.integrity || record.entry.inBundle === true) {
      return [`${declared} loads ${holder}, not the ${candidate.name} release`];
    }
    return elsewhere.map(file => `${declared} resolves to ${file}, outside ${holder}`);
  });
}

// What keeps the installation at `project` (a real path) from holding only
// release copies of `candidates` wherever Node loads them, given its closure:
// candidates that run install code, installed candidate entries that are not
// the release, carried modules standing in for one, and declared candidates
// Node loads from anything else.
function candidateIntegrityErrors({ project, manifest, lock, registry, candidates, closure, scopes }) {
  const inventory = candidateInventory(closure, scopes, registry);
  const declarations = candidateDeclarations(manifest, lock, inventory, candidates);
  return [
    ...candidates.flatMap(({ name, files }) => {
      const scripts = declaredInstallScripts(files);
      return scripts.length ? [`candidate package runs code when installed (${scripts.join(", ")}): ${name}`] : [];
    }),
    ...candidateInventoryErrors(closure, inventory, candidates, declarations, registry),
    ...candidateResolutionErrors(project, closure, declarations),
  ];
}

// npm's cache directory: npm_config_cache when set, as npm reads it, or npm's own setting for the project.
const npmCacheDirectory = project => process.env.npm_config_cache ||
  execFileSync(process.execPath, [npmCliPath(), "config", "get", "cache"], { cwd: project, encoding: "utf8" }).trim();

// Checks the consumer at `projectPath`, installed by npm ci --ignore-scripts
// and unused by any package code so far (such code could change the tree
// after extraction), and writes its registry dependency report. Every
// installed path must be its locked archive's and every candidate copy the
// release in `releaseSet`; otherwise it throws listing each difference.
function writeDependencyPolicyReport({ projectPath, registry, report, releaseSet, version }) {
  const project = realpathSync(projectPath);
  const manifest = JSON.parse(readFileSync(join(project, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(project, "package-lock.json"), "utf8"));
  const missing = DUAL_RAIL_DEPENDENCIES.filter(name => typeof manifest.dependencies?.[name] !== "string");
  if (missing.length) throw new Error("dual-rail consumer is missing " + missing.join(", "));
  const candidates = releaseCandidates(releaseSet, version);
  const cache = npmCacheDirectory(project);
  const scopes = new Map();
  const closure = installationClosure(project, lock, (location, entry) => {
    const archive = cachedArchive(cache, entry.integrity);
    for (const [path, scope] of archivePackageScopes(location, archive)) scopes.set(path, scope);
    return archive;
  });
  const differences = installationDifferences(project, closure).map(line => "installed tree is not the locked archives: " + line);
  const errors = [...closure.errors, ...differences.slice(0, MAX_LISTED_DIFFERENCES),
    ...(differences.length > MAX_LISTED_DIFFERENCES ? [`and ${differences.length - MAX_LISTED_DIFFERENCES} more differences`] : []),
    ...candidateIntegrityErrors({ project, manifest, lock, registry, candidates, closure, scopes })];
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
export function extractPolicyFindings(readInput) {
  const read = name => boundedEvidenceText(readInput(name));
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
  const strictLog = [...evidenceLines(read("engine-strict.log"))].join("\n");
  let versions = null;
  try { versions = json("engine-versions.json"); } catch { /* unreadable: the scan is incomplete */ }
  const { scanComplete, violations, ...scan } = scanLockEngines(lock, versions);
  const sbom = name => {
    const errors = [...evidenceLines(read(`${name}.err`))].join("\n");
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

// Baseline rules match location, dependency spec and engine range; SBOM rules
// elide installed versions so patch releases alone do not create new rules.
const sameIdentity = (keys) => (item, known) => keys.every(key => JSON.stringify(item?.[key]) === JSON.stringify(known?.[key]));
const packageName = (spec) => typeof spec === "string" ? spec.replace(/(?<=.)@[^@]*$/, "") : spec;
const gitIdentity = sameIdentity(["location", "field", "value"]);
const engineIdentity = (item, known) => typeof item?.package === "string" &&
  packageName(item.package) === packageName(known?.package) && sameIdentity(["location", "required"])(item, known);
const imageIdentity = (item, known) => sameIdentity(["name", "location"])(item, known) &&
  (item?.name !== "pqcrypto" || sameIdentity(["version"])(item, known));
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

function annotate(result) {
  if (result.exitCode !== 0 && result.exitCode !== 4) {
    process.stdout.write(`::error title=Registry/container acceptance ${result.failureClass} failure::${result.message}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [mode, input, output] = process.argv.slice(2);
  if (mode === "--audit-policy" && input && output) {
    invalidateReport(input, output);
    const audit = JSON.parse(readEvidence(input));
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
    atomicWriteJson(output, { schema: "dacs-registry-audit-policy/v1", observed: counts, ...policy, passed });
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
    const read = name => readEvidence(join(input, name));
    atomicWriteJson(output, extractPolicyFindings(read));
  } else if (mode === "--failure-summary" && input && output) {
    // <stage-dir> <stage> <exit-code>: the run stopped before its summary.
    rmSync(join(input, "acceptance-summary.json"), { force: true });
    const exitCode = process.argv[5];
    const read = name => readEvidence(join(input, name));
    const summary = failureSummary({ stage: output, exitCode: Number(exitCode), read });
    atomicWriteJson(join(input, "acceptance-summary.json"), summary);
    const evidence = summary.failureEvidence.length ? `; ${summary.failureEvidence[0]}` : "";
    annotate({ exitCode: summary.exitCode, failureClass: summary.failureClass,
      message: `stopped at stage ${output} with exit ${exitCode}${evidence}`.replace(/[\r\n%]/g, " ") });
  } else {
    const drift = mode === "--audit-drift";
    const record = mode === "--record";
    const summaryPath = drift || record ? input : mode;
    const summary = JSON.parse(readEvidence(summaryPath));
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
