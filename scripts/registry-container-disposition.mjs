#!/usr/bin/env node
// Observing only advisory IDs listed in the #191 baseline, or a subset of
// them, is baseline-only (exit 4). An ID missing from the baseline fails closed
// (exit 3) unless DACS_UNLISTED_ADVISORIES=warn, which only the pull_request
// acceptance job sets: there it is a warning, so an advisory newly published
// against an unchanged tree cannot turn every PR red. The scheduled drift job,
// manual runs, prerelease publication and release paths fail, and an unlisted
// ID that is high or critical on a direct dependency fails pull requests too.
// An observed ID recorded in `assessedAdvisories` (a transitive advisory
// assessed for reachability, as SECURITY.md's audit policy allows) does not
// block the gate, and one recorded in the #191 baseline is baseline-only; one
// on a direct dependency at high or critical severity always blocks, whichever
// list records it. Nothing here permits production publication while #191
// remains blocked.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { RUNTIME_IMAGE_INVENTORY_SCHEMA } from "./runtime-image-inventory.mjs";

export const ACCEPTANCE_SUMMARY_SCHEMA = "dacs-registry-container-acceptance/v1";
// The evidence a complete summary embeds, by the schema its producer writes.
export const RUNTIME_IMAGE_POLICY_SCHEMA = "dacs-runtime-image-policy/v1";
export const POLICY_FINDINGS_SCHEMA = "dacs-registry-policy-findings/v1";
// Every entry under the final image's node_modules (runtime-image-inventory.mjs).
export { RUNTIME_IMAGE_INVENTORY_SCHEMA };
const baselinePath = new URL("./registry-container-audit-baseline.json", import.meta.url);
// The release the acceptance packs and installs: the checkout's own version,
// as verify-registry-container-consumer.sh reads it.
export const RELEASE_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const advisoryId = /^GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}$/;

function validIds(ids) {
  return Array.isArray(ids) && ids.every(id => typeof id === "string" && advisoryId.test(id)) &&
    new Set(ids).size === ids.length;
}

// Each assessment names where its reachability assessment is recorded.
const validAssessments = entries => Array.isArray(entries) && entries.every(entry => typeof entry === "object" &&
  entry !== null && typeof entry.id === "string" && advisoryId.test(entry.id) && typeof entry.assessment === "string" &&
  entry.assessment.trim() !== "") && new Set(entries.map(entry => entry.id)).size === entries.length;

// `directAdvisories` are the observed IDs that npm reports at high or critical
// severity on a direct dependency of the consumer.
export function classifyRegistryAudit(observedAdvisories, baseline, directAdvisories = []) {
  const assessments = baseline?.assessedAdvisories ?? [];
  if (baseline?.schema !== "dacs-registry-audit-baseline/v1" ||
      typeof baseline.source?.commit !== "string" || !/^[a-f0-9]{40}$/.test(baseline.source.commit) ||
      typeof baseline.source?.job !== "string" || !baseline.source.job ||
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

function summaryAudit(summary, baseline) {
  const policy = classifyRegistryAudit(summary.audit?.observedAdvisories, baseline, summary.audit?.directAdvisories ?? []);
  if (JSON.stringify(policy.unlistedAdvisories) !== JSON.stringify(summary.audit?.unlistedAdvisories)) {
    throw new Error("summary advisory classification does not match baseline");
  }
  return policy;
}

export function registryAuditDriftDisposition(summary, baseline = JSON.parse(readFileSync(baselinePath, "utf8"))) {
  // A run that stopped before its audit was classified has no advisory IDs to
  // compare: report where and why it stopped, not a malformed baseline.
  if (summary?.schema === ACCEPTANCE_SUMMARY_SCHEMA && summary.complete === false) {
    const failureClass = FAILURE_CLASSES.includes(summary.failureClass) ? summary.failureClass : "functional";
    return { exitCode: 1, evaluated: false, failureClass, message: "Advisory-ID drift was not evaluated: acceptance stopped " +
      `at stage ${String(summary.failedStage)} (${failureClass} failure${failureClass === "network" ? "; rerun the workflow" : ""})` };
  }
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
const registryRange = "[\\w.*^~<>=|+ -]*";
const registrySpec = new RegExp(`^(?:${registryRange}|npm:(?:@[\\w.-]+/)?[\\w.-]+(?:@${registryRange})?)$`);
const tarballFile = /\.(?:tgz|tar|tar\.gz)$/i;
const sri = /^(?:sha512|sha384|sha256|sha1)-[A-Za-z0-9+/]+={0,2}$/;
const specFields = ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"];
const isPlainObject = value => typeof value === "object" && value !== null && !Array.isArray(value);

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
  const specs = (location, owner) => {
    for (const field of specFields) {
      // A present map that is not a plain object (an array, a string, null)
      // has no specs to check, so it is a violation itself.
      if (owner?.[field] !== undefined && !isPlainObject(owner[field])) {
        violations.push({ location, field, value: JSON.stringify(owner[field]) });
        continue;
      }
      for (const [name, value] of Object.entries(owner?.[field] ?? {})) {
        if (typeof value !== "string" || !registrySpec.test(value) || tarballFile.test(value)) {
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
    if (entry.link === true || url === null || url.origin !== origin || !url.pathname.startsWith(path)) {
      violations.push({ location, field: entry.link === true ? "link" : "resolved", value: entry.resolved ?? null });
    }
    if (typeof entry.integrity !== "string" || !sri.test(entry.integrity)) {
      violations.push({ location, field: "integrity", value: entry.integrity ?? null });
    }
  }
  return violations;
}

// Every installed copy of a candidate package, top-level, nested or aliased,
// must be the packed release-set tarball that release-provenance.json records,
// at the release's version both in the lock and, when `installedManifest`
// reads it, in the installed package.json.
export function candidateIntegrityErrors({ lock, registry, candidates, installedManifest }) {
  const { origin, path } = consumerRegistry(registry);
  const packages = isPlainObject(lock?.packages) ? lock.packages : {};
  const errors = [];
  for (const { name, integrity, version } of candidates) {
    if (typeof version !== "string" || version === "") {
      errors.push("candidate record has no release version: " + name);
      continue;
    }
    const locations = Object.keys(packages).filter(location => location === "node_modules/" + name ||
      location.endsWith("/node_modules/" + name) || packages[location]?.name === name);
    if (!locations.includes("node_modules/" + name)) errors.push("candidate package is not installed at the top level: " + name);
    for (const location of locations) {
      const entry = packages[location];
      let url = null;
      try { url = new URL(entry?.resolved); } catch { /* not a URL */ }
      if (url === null || url.origin !== origin || !url.pathname.startsWith(path)) {
        errors.push("candidate package did not resolve through the isolated registry: " + location);
      } else if (entry.integrity !== integrity) {
        errors.push("candidate package integrity does not match the packed tarball: " + location +
          " (expected " + integrity + ", observed " + String(entry.integrity) + ")");
      }
      if (entry?.version !== version) {
        errors.push("candidate package lock version does not match the release: " + location +
          " (expected " + version + ", observed " + String(entry?.version) + ")");
      }
      if (installedManifest) {
        let manifest;
        try { manifest = installedManifest(location); } catch { manifest = undefined; }
        if (manifest?.name !== name || manifest?.version !== version) {
          errors.push("installed candidate package is not the release: " + location + " (expected " + name + "@" +
            version + ", observed " + String(manifest?.name) + "@" + String(manifest?.version) + ")");
        }
      }
    }
  }
  return errors;
}

// Why a run failed: an unreachable registry or audit endpoint (a timeout, or
// 5xx/408/429 after retries), a security-policy result, or the rehearsal itself.
export const FAILURE_CLASSES = ["network", "policy", "functional"];
// npm prints `network timeout at:` (code FETCH_ERROR) for a request timeout and
// `Response timeout while trying to fetch` for a body timeout.
const networkSignature = /\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ESOCKETTIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|E50[0234]|E408|E429)\b|socket hang up|network timeout at: |Response timeout while trying to fetch|TLS handshake timeout|i\/o timeout|toomanyrequests|curl: \((?:6|7|28|35|52|56)\)/;

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
  "registry-start": [["registry.log", () => true]],
  "registry-auth": [["registry.log", () => true]],
  publish: [["registry.log", () => true]],
  consumer: [["generation.log", line => /^npm error |Error response from daemon|^docker: /.test(line)]],
  "audit-policy": [["npm-audit.json", () => true]],
  "image-build": [["docker-build.log", () => true]],
};
const policyStages = new Set(["dependency-policy", "audit-policy"]);

export function classifyAcceptanceFailure({ stage, read }) {
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
    for (const line of (read(name) ?? "").split("\n")) {
      if (relevant(line) && networkSignature.test(line)) evidence.push(`${name}: ${line.trim()}`);
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

const npmErrorCode = text => /^npm error code (\S+)$/m.exec(text ?? "")?.[1] ?? null;

// npm's EBADENGINE check (npm-install-checks) tests each non-optional package's
// engines.node and engines.npm with semver.satisfies(current, range,
// { includePrerelease: true }). This is that range grammar for a release
// version. Anything else throws, so a range it cannot read never passes.
const versionId = "0|[1-9]\\d{0,14}";
const rangeId = `${versionId}|x|X|\\*`;
const prereleaseId = "(?:0|[1-9]\\d*|\\d*[a-zA-Z-][a-zA-Z0-9-]*)";
const partialVersion = `v?(${rangeId})(?:\\.(${rangeId})(?:\\.(${rangeId})(?:-(${prereleaseId}(?:\\.${prereleaseId})*))?` +
  "(?:\\+[a-zA-Z0-9-]+(?:\\.[a-zA-Z0-9-]+)*)?)?)?";
const rangeToken = new RegExp(`^(<=|>=|<|>|=|~>|~|\\^)?${partialVersion}$`);
const hyphenRange = new RegExp(`^${partialVersion} - ${partialVersion}$`);
const isX = id => id === undefined || id === "x" || id === "X" || id === "*";
// semver 7.8.5, which the pinned npm 11.19.0 bundles, rejects a plain
// comparator with a numeric part after an X (`1.x.0`, `>=1.x.0`, `*.1.2`), so
// npm reports EBADENGINE for it; it still reads tildes, carets and hyphen
// ranges with one (`~1.x.0`, `^x.1`, `1.x.0 - 2`).
const numericAfterX = (M, m, p) => (isX(M) && !(isX(m) && isX(p))) || (isX(m) && !isX(p));

// One token's comparators, [operator, [major, minor, patch], prerelease?], as
// semver desugars carets, tildes and X-ranges. [] is any version.
function tokenComparators(token) {
  const match = rangeToken.exec(token);
  if (!match || (!/^[~^]/.test(match[1] ?? "") && numericAfterX(match[2], match[3], match[4]))) {
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
    : [[tpr === undefined ? "<=" : "<", [Number(tM), Number(tm), Number(tp)]]];
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
  return match ? match.slice(1).map(Number) : null;
};

// semver.satisfies for a release version; throws for a range it cannot read.
export function satisfiesEngineRange(current, range) {
  const version = releaseVersion(current);
  if (version === null || typeof range !== "string") {
    throw new Error(`unsupported engine check ${JSON.stringify(current)} against ${JSON.stringify(range)}`);
  }
  // Every set is parsed before any is tested: semver rejects the whole range.
  const sets = range.trim().replace(/\s+/g, " ").split("||").map(part => {
    const set = part.trim();
    const hyphen = hyphenRange.exec(set);
    if (hyphen) return hyphenComparators(hyphen);
    // `>= 1.2` is `>=1.2`, as semver trims an operator's trailing space.
    const tokens = [];
    for (const token of set === "" ? [] : set.split(" ")) {
      if (/^(?:<=|>=|<|>|=|~>|~|\^)$/.test(tokens.at(-1) ?? "") && /^v?[0-9xX*]/.test(token)) tokens.push(tokens.pop() + token);
      else tokens.push(token);
    }
    return tokens.flatMap(tokenComparators);
  });
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
  if (typeof packages !== "object" || packages === null || Array.isArray(packages)) errors.push("lock has no packages map");
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
        const name = entry.name ?? (location === "" ? lock.name : location.slice(location.lastIndexOf("node_modules/") + 13));
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
export function runtimeImageInventoryFindings(inventory, lock) {
  const packages = isPlainObject(lock?.packages) ? lock.packages : null;
  if (packages === null) {
    return { scanComplete: false, errors: ["the generated lock has no packages"], unexpected: [], missing: [] };
  }
  if (inventory?.schema !== RUNTIME_IMAGE_INVENTORY_SCHEMA || !Array.isArray(inventory.packages)) {
    return { scanComplete: false, errors: [`runtime-image-inventory.json is not ${RUNTIME_IMAGE_INVENTORY_SCHEMA}`],
      unexpected: [], missing: [] };
  }
  const closure = new Map(Object.entries(packages)
    .filter(([location, entry]) => location.startsWith("node_modules/") && entry?.dev !== true));
  const errors = [];
  const unexpected = [];
  const seen = new Set();
  for (const item of inventory.packages) {
    const location = item?.location;
    if (typeof location !== "string" || !/^node_modules\/(?:.+\/node_modules\/)?(?:@[^/]+\/)?[^/@.][^/]*$/.test(location) ||
        typeof item.name !== "string" || typeof item.version !== "string" || seen.has(location)) {
      errors.push("unreadable runtime-image inventory entry: " + JSON.stringify(item));
      continue;
    }
    seen.add(location);
    const entry = closure.get(location);
    const name = entry?.name ?? location.slice(location.lastIndexOf("node_modules/") + 13);
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

// Records each security-gate finding with its observed identity (lock path,
// version, integrity, engine range, npm problem line); the baseline compares
// them by rule (see gitIdentity below).
export function extractPolicyFindings(read) {
  const json = name => JSON.parse(read(name) ?? "null");
  const exitCode = name => { const text = read(name); return text === undefined ? null : Number(text.trim()); };
  const lock = json("generated-package-lock.json");
  const packages = lock?.packages ?? {};
  const identity = location => ({ version: packages[location]?.version ?? null, integrity: packages[location]?.integrity ?? null });
  const gitDependencies = (json("dependency-policy.json")?.violations ?? []).map(violation =>
    ({ location: violation.location, field: violation.field ?? null, value: violation.value, ...identity(violation.location) }));
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
  // The two packages the policy names, then every other image package outside
  // the production closure.
  const named = [["typescript", image.typescriptPresent], ["rubic-sdk", image.rubicSdkPresent]]
    .filter(([, present]) => present === true)
    .map(([name]) => packages[`node_modules/${name}`]
      ? { name, location: `node_modules/${name}`, ...identity(`node_modules/${name}`) }
      : { name, location: null, version: null, integrity: null });
  const productionImageDependencies = [...named,
    ...unexpected.filter(item => !named.some(known => known.location === item.location))];
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

// The baseline keeps each finding's observed version and integrity as evidence,
// but matches it by rule: lock location, dependency field and spec, required
// engine range, and npm's problem line with installed versions elided. The
// consumer installs without a lockfile, so a patch release of a package that
// keeps the same rule stays baseline-only; a new package, location, spec or
// range still blocks.
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
// Non-empty, and every finding is recorded in the baseline exactly.
const allListed = (items, known, same) => Array.isArray(items) && items.length > 0 && Array.isArray(known) &&
  items.every(item => known.some(entry => same(item, entry)));

// Each security-gate check is "passed", "baseline" (fails only with findings
// recorded in the #191 baseline) or "blocked" (anything else, fail closed).
export function classifyPolicyChecks(summary, baseline) {
  const gate = summary?.securityGate ?? {};
  const findings = gate.findings ?? {};
  const known = baseline?.policyFindings ?? {};
  const engine = findings.engine;
  const inventory = findings.productionImageInventory;
  // The image's package set must be read in full and hold the whole required
  // closure; a package outside it is a production-image finding (above).
  const inventoryRead = inventory?.scanComplete === true && Array.isArray(inventory.missing) &&
    inventory.missing.length === 0;
  const sbom = (exitCode, observed, knownProblems) => exitCode === 0 ? "passed" :
    observed?.exitCode === exitCode && observed.code === "ESBOMPROBLEMS" &&
      allListed(observed.problems, knownProblems, sbomIdentity) ? "baseline" : "blocked";
  return {
    registryDependency: gate.registryDependencyPolicyPassed === true
      ? ((findings.gitDependencies ?? []).length === 0 ? "passed" : "blocked")
      : allListed(findings.gitDependencies, known.gitDependencies, gitIdentity) ? "baseline" : "blocked",
    productionImage: !inventoryRead ? "blocked" : gate.productionImageDependencyPolicyPassed === true
      ? ((findings.productionImageDependencies ?? []).length === 0 ? "passed" : "blocked")
      : allListed(findings.productionImageDependencies, known.productionImageDependencies, imageIdentity) ? "baseline" : "blocked",
    engineStrict: gate.engineStrictExitCode === 0 ? "passed" :
      engine?.exitCode === gate.engineStrictExitCode && engine.code === "EBADENGINE" && engine.scanComplete === true &&
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
    const failureClass = FAILURE_CLASSES.includes(summary.failureClass) ? summary.failureClass : "functional";
    return { exitCode: 1, failureClass, message: `registry/container acceptance stopped at stage ` +
      `${String(summary.failedStage)} (${failureClass} failure)` };
  }
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
  catch (error) { return { exitCode: 3, failureClass: "policy", message: String(error) }; }
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
  const audit = ![0, 1].includes(gate?.auditExitCode) || (gate.auditExitCode === 1 && observed === 0) ||
      assessedDirect.length > 0 || unlistedDirect.length > 0 || baselineDirect.length > 0 ? "blocked"
    : policy.unlistedAdvisories.length > 0 ? (unlistedAdvisories === "warn" ? "unlisted" : "blocked")
    : observed > policy.assessedAdvisories.length ? "baseline" : "passed";
  const states = { ...checks, audit };
  const named = state => Object.keys(states).filter(name => states[name] === state);
  if (named("passed").length === Object.keys(states).length && gate.passed === true) {
    return { exitCode: 0, failureClass: null, message: "registry/container acceptance passed", checks: states, ...policy };
  }
  if (named("blocked").length === 0) {
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

function annotate(result) {
  if (result.exitCode !== 0 && result.exitCode !== 4) {
    process.stdout.write(`::error title=Registry/container acceptance ${result.failureClass} failure::${result.message}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, input, output] = process.argv.slice(2);
  if (mode === "--audit-policy" && input && output) {
    const audit = JSON.parse(readFileSync(input, "utf8"));
    const counts = audit.metadata?.vulnerabilities;
    if (!counts || !Number.isInteger(counts.total) || !Number.isInteger(counts.critical) || !audit.vulnerabilities) {
      throw new Error("npm audit did not produce vulnerability metadata");
    }
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
    const [project, registry, report, releaseSet, version] = process.argv.slice(3);
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
    const errors = candidateIntegrityErrors({ lock, registry, candidates,
      installedManifest: location => JSON.parse(readFileSync(join(project, location, "package.json"), "utf8")) });
    if (errors.length) throw new Error(errors.join("\n"));
    const violations = registryDependencyViolations({ manifest, lock, registry });
    writeFileSync(report, JSON.stringify({ schema: "dacs-registry-dependency-policy/v1", passed: violations.length === 0,
      violations }, null, 2) + "\n");
  } else if (mode === "--policy-findings" && input && output) {
    const read = name => existsSync(join(input, name)) ? readFileSync(join(input, name), "utf8") : undefined;
    writeFileSync(output, JSON.stringify(extractPolicyFindings(read), null, 2) + "\n");
  } else if (mode === "--failure-summary" && input && output) {
    // <stage-dir> <stage> <exit-code>: the run stopped before its summary.
    const exitCode = process.argv[5];
    const read = name => existsSync(join(input, name)) ? readFileSync(join(input, name), "utf8") : undefined;
    const summary = failureSummary({ stage: output, exitCode: Number(exitCode), read });
    writeFileSync(join(input, "acceptance-summary.json"), JSON.stringify(summary, null, 2) + "\n");
    const evidence = summary.failureEvidence.length ? `; ${summary.failureEvidence[0]}` : "";
    annotate({ exitCode: summary.exitCode, failureClass: summary.failureClass,
      message: `stopped at stage ${output} with exit ${exitCode}${evidence}`.replace(/[\r\n%]/g, " ") });
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
      writeFileSync(summaryPath, JSON.stringify({ ...summary, failureClass,
        disposition: { exitCode, failureClass, message, checks, unlistedAdvisories } }, null, 2) + "\n");
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
