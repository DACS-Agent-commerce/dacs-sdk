#!/usr/bin/env node
// Required acceptance fails (exit 3) on any advisory ID missing from the #191
// baseline; observing only listed IDs, or a subset of them, is baseline-only
// (exit 4). The scheduled/manual drift workflow reports unlisted IDs daily.
// Neither classification permits production publication while #191 remains
// blocked.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const ACCEPTANCE_SUMMARY_SCHEMA = "dacs-registry-container-acceptance/v1";
const baselinePath = new URL("./registry-container-audit-baseline.json", import.meta.url);
const advisoryId = /^GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}$/;

function validIds(ids) {
  return Array.isArray(ids) && ids.every(id => typeof id === "string" && advisoryId.test(id)) &&
    new Set(ids).size === ids.length;
}

export function classifyRegistryAudit(observedAdvisories, baseline) {
  if (baseline?.schema !== "dacs-registry-audit-baseline/v1" ||
      typeof baseline.source?.commit !== "string" || !/^[a-f0-9]{40}$/.test(baseline.source.commit) ||
      typeof baseline.source?.job !== "string" || !baseline.source.job ||
      !validIds(baseline.advisoryIds) || baseline.advisoryIds.length === 0 || !validIds(observedAdvisories)) {
    throw new Error("malformed registry audit baseline or observed advisory IDs");
  }
  const known = new Set(baseline.advisoryIds);
  return { observedAdvisories: [...observedAdvisories].sort(),
    unlistedAdvisories: observedAdvisories.filter(id => !known.has(id)).sort() };
}

function summaryAudit(summary, baseline) {
  const policy = classifyRegistryAudit(summary.audit?.observedAdvisories, baseline);
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

// Why a run failed: an unreachable registry or audit endpoint (a timeout, or
// 5xx/408/429 after retries), a security-policy result, or the rehearsal itself.
export const FAILURE_CLASSES = ["network", "policy", "functional"];
// npm prints `network timeout at:` (code FETCH_ERROR) for a request timeout and
// `Response timeout while trying to fetch` for a body timeout.
const networkSignature = /\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ESOCKETTIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|E50[0234]|E408|E429)\b|socket hang up|network timeout at: |Response timeout while trying to fetch|TLS handshake timeout|i\/o timeout|toomanyrequests|curl: \((?:6|7|28|35|52|56)\)/;

// When the audit endpoint fails, `npm audit --json` writes npm's audit error
// object (lib/utils/audit-error.js) instead of a report: the HTTP answer's
// `statusCode` and message, or a fetch error's message with no status. A
// timeout, an unreachable endpoint and 5xx/408/429 are transient (network);
// any other answer means the audit could not be run (functional). Neither is a
// policy result. Returns null for anything else.
export function auditEndpointError(text) {
  let value;
  try { value = JSON.parse(text ?? ""); } catch { return null; }
  if (typeof value !== "object" || value === null || typeof value.message !== "string" ||
      "auditReportVersion" in value || "vulnerabilities" in value || "metadata" in value) return null;
  const status = Number.isInteger(value.statusCode) ? value.statusCode : null;
  if (status === null && !/^(?:network timeout at: |request to \S+ failed, reason: )/.test(value.message)) return null;
  const transient = status === null || (status >= 500 && status <= 599) || status === 408 || status === 429;
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
    const endpoint = auditEndpointError(read("npm-audit.json"));
    if (endpoint) {
      return { failureClass: endpoint.transient ? "network" : "functional",
        evidence: [`npm-audit.json: audit endpoint error: ${endpoint.message}`] };
    }
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

// One token's comparators, [operator, [major, minor, patch], prerelease?], as
// semver desugars carets, tildes and X-ranges. [] is any version.
function tokenComparators(token) {
  const match = rangeToken.exec(token);
  if (!match) throw new Error(`unsupported engine range token ${JSON.stringify(token)}`);
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
    if (typeof entry !== "object" || entry === null) { errors.push(`${location}: unreadable lock entry`); continue; }
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

// Records each security-gate finding by exact identity (lock path, version,
// integrity, engine range, npm problem line) for comparison with the baseline.
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
  const productionImageDependencies = [["typescript", image.typescriptPresent], ["rubic-sdk", image.rubicSdkPresent]]
    .filter(([, present]) => present === true)
    .map(([name]) => packages[`node_modules/${name}`]
      ? { name, location: `node_modules/${name}`, ...identity(`node_modules/${name}`) }
      : { name, location: null, version: null, integrity: null });
  return {
    schema: "dacs-registry-policy-findings/v1",
    gitDependencies,
    engine: { exitCode: exitCode("engine-strict.exit-code"), code: npmErrorCode(strictLog),
      reportedPackage: /Not compatible with your version of node\/npm: (\S+)/.exec(strictLog)?.[1] ?? null,
      scan, scanComplete, violations },
    lockSbom: sbom("consumer-lock-sbom"),
    physicalSbom: sbom("consumer-physical-sbom"),
    productionImageDependencies,
  };
}

const sameIdentity = (keys) => (item, known) => keys.every(key => JSON.stringify(item?.[key]) === JSON.stringify(known?.[key]));
const gitIdentity = sameIdentity(["location", "field", "value", "version", "integrity"]);
const engineIdentity = sameIdentity(["package", "location", "integrity", "required"]);
const imageIdentity = sameIdentity(["name", "location", "version", "integrity"]);
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
  const sbom = (exitCode, observed, knownProblems) => exitCode === 0 ? "passed" :
    observed?.exitCode === exitCode && observed.code === "ESBOMPROBLEMS" &&
      allListed(observed.problems, knownProblems, (a, b) => a === b) ? "baseline" : "blocked";
  return {
    registryDependency: gate.registryDependencyPolicyPassed === true
      ? ((findings.gitDependencies ?? []).length === 0 ? "passed" : "blocked")
      : allListed(findings.gitDependencies, known.gitDependencies, gitIdentity) ? "baseline" : "blocked",
    productionImage: gate.productionImageDependencyPolicyPassed === true
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

export function registryContainerDisposition(summary, baseline = JSON.parse(readFileSync(baselinePath, "utf8"))) {
  if (summary?.schema !== ACCEPTANCE_SUMMARY_SCHEMA) {
    return { exitCode: 1, failureClass: "functional", message: "registry/container acceptance summary has an unexpected schema" };
  }
  if (summary.complete === false) {
    const failureClass = FAILURE_CLASSES.includes(summary.failureClass) ? summary.failureClass : "functional";
    return { exitCode: 1, failureClass, message: `registry/container acceptance stopped at stage ` +
      `${String(summary.failedStage)} (${failureClass} failure)` };
  }
  if (summary.functionalPassed !== true || summary.generatedTestsPassed !== true) {
    return { exitCode: 1, failureClass: "functional", message: "functional registry/container rehearsal failed" };
  }
  let policy;
  try { policy = summaryAudit(summary, baseline); }
  catch (error) { return { exitCode: 3, failureClass: "policy", message: String(error) }; }
  const gate = summary.securityGate;
  const checks = classifyPolicyChecks(summary, baseline);
  // An advisory ID outside the baseline blocks, even one newly published
  // against a dependency the tree already had.
  const audit = gate?.auditExitCode === 0 && policy.observedAdvisories.length === 0 ? "passed"
    : policy.observedAdvisories.length > 0 && policy.unlistedAdvisories.length === 0 &&
      [0, 1].includes(gate?.auditExitCode) ? "baseline" : "blocked";
  const states = { ...checks, audit };
  const named = state => Object.keys(states).filter(name => states[name] === state);
  if (named("passed").length === Object.keys(states).length && gate.passed === true) {
    return { exitCode: 0, failureClass: null, message: "registry/container acceptance passed", checks: states, ...policy };
  }
  if (named("blocked").length === 0) {
    return { exitCode: 4, failureClass: "policy", checks: states, message: "functional registry/container rehearsal passed; " +
      `production publication remains blocked by #191 baseline findings (${named("baseline").join(", ")})`, ...policy };
  }
  return { exitCode: 3, failureClass: "policy", checks: states, message: "functional registry/container rehearsal passed, " +
    `but the #191 security gate is blocked beyond the recorded baseline (${named("blocked").join(", ")})` +
    (policy.unlistedAdvisories.length ? `; advisory IDs not in the #191 baseline: ${policy.unlistedAdvisories.join(", ")}. ` +
      "Review them, then add them to scripts/registry-container-audit-baseline.json and .md in a PR under CODEOWNERS review" : ""),
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
    for (const vulnerability of Object.values(audit.vulnerabilities)) {
      for (const via of Array.isArray(vulnerability?.via) ? vulnerability.via : []) {
        if (typeof via === "object" && via !== null) {
          if (typeof via.url !== "string") throw new Error("npm audit advisory URL missing");
          ids.add(via.url.replace(/^https:\/\/github\.com\/advisories\//, ""));
        }
      }
    }
    const policy = classifyRegistryAudit([...ids], JSON.parse(readFileSync(baselinePath, "utf8")));
    writeFileSync(output, JSON.stringify({ schema: "dacs-registry-audit-policy/v1", observed: counts, ...policy }, null, 2) + "\n");
    process.stdout.write(JSON.stringify(counts) + "\n");
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
    const result = drift ? registryAuditDriftDisposition(summary) : registryContainerDisposition(summary);
    if (record) {
      const { exitCode, failureClass, message, checks } = result;
      writeFileSync(summaryPath, JSON.stringify({ ...summary, failureClass,
        disposition: { exitCode, failureClass, message, checks } }, null, 2) + "\n");
    }
    // Required acceptance names unlisted IDs in its error; drift warns.
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
