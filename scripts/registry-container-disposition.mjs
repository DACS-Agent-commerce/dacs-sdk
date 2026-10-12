#!/usr/bin/env node
// Required acceptance reports advisory drift without failing every PR together.
// The scheduled/manual drift workflow fails on unlisted advisory IDs. Neither
// classification permits production publication while #191 remains blocked.
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
  try {
    const policy = summaryAudit(summary, baseline);
    return { exitCode: policy.unlistedAdvisories.length ? 3 : 0,
      message: policy.unlistedAdvisories.length ? `Unlisted advisory IDs: ${policy.unlistedAdvisories.join(", ")}` : "No advisory-ID drift", ...policy };
  } catch (error) { return { exitCode: 3, message: String(error) }; }
}

// Why a run failed: an unreachable registry or audit endpoint (or 5xx after
// retries), a security-policy result, or the rehearsal itself.
export const FAILURE_CLASSES = ["network", "policy", "functional"];
const networkSignature = /\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ESOCKETTIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|E50[0234])\b|socket hang up|TLS handshake timeout|i\/o timeout|toomanyrequests|curl: \((?:6|7|28|35|52|56)\)/;
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

// Records each security-gate finding by exact identity (lock path, version,
// integrity, engine range, npm problem line) for comparison with the baseline.
export function extractPolicyFindings(read) {
  const json = name => JSON.parse(read(name) ?? "null");
  const exitCode = name => { const text = read(name); return text === undefined ? null : Number(text.trim()); };
  const packages = json("generated-package-lock.json")?.packages ?? {};
  const nameAt = location => packages[location]?.name ?? location.slice(location.lastIndexOf("node_modules/") + 13);
  const identity = location => ({ version: packages[location]?.version ?? null, integrity: packages[location]?.integrity ?? null });
  const gitDependencies = (json("dependency-policy.json")?.violations ?? []).map(violation =>
    ({ location: violation.location, field: violation.field ?? null, value: violation.value, ...identity(violation.location) }));
  const strictLog = read("engine-strict.log") ?? "";
  const scanLog = read("engine-scan.log");
  const engineIds = [...new Set([...(scanLog ?? "").matchAll(/EBADENGINE\s+package: '([^']+)'/g)].map(match => match[1]))];
  const violations = engineIds.flatMap(id => {
    const locations = Object.keys(packages).filter(location => location !== "" && packages[location].optional !== true &&
      `${nameAt(location)}@${packages[location].version}` === id);
    return locations.length ? locations.map(location => ({ package: id, location,
      integrity: packages[location].integrity ?? null, required: packages[location].engines ?? null }))
      : [{ package: id, location: null, integrity: null, required: null }];
  });
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
      scanComplete: scanLog !== undefined && exitCode("engine-scan.exit-code") === 0, violations },
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
  const audit = gate?.auditExitCode === 0 && policy.observedAdvisories.length === 0 ? "passed"
    : policy.observedAdvisories.length > 0 && [0, 1].includes(gate?.auditExitCode) ? "baseline" : "blocked";
  const states = { ...checks, audit };
  const named = state => Object.keys(states).filter(name => states[name] === state);
  if (named("passed").length === Object.keys(states).length && gate.passed === true) {
    return { exitCode: 0, failureClass: null, message: "registry/container acceptance passed", checks: states, ...policy };
  }
  if (named("blocked").length === 0) {
    return { exitCode: 4, failureClass: "policy", checks: states, message: "functional registry/container rehearsal passed; " +
      `production publication remains blocked by #191 baseline findings (${named("baseline").join(", ")})` +
      (policy.unlistedAdvisories.length ? `; unlisted advisory IDs: ${policy.unlistedAdvisories.join(", ")}` : ""), ...policy };
  }
  return { exitCode: 3, failureClass: "policy", checks: states, message: "functional registry/container rehearsal passed, " +
    `but the #191 security gate is blocked beyond the recorded baseline (${named("blocked").join(", ")})`, ...policy };
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
    if (result.unlistedAdvisories?.length) {
      process.stdout.write(`::warning title=Registry audit advisory drift::Unlisted advisory IDs: ${result.unlistedAdvisories.join(", ")}. Production publication remains blocked by #191.\n`);
    }
    if (!drift) annotate(result);
    (result.exitCode === 0 ? process.stdout : process.stderr).write(`${result.message}\n`);
    process.exit(result.exitCode);
  }
}
