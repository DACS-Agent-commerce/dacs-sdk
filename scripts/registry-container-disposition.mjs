#!/usr/bin/env node
// Required acceptance reports advisory drift without failing every PR together.
// The scheduled/manual drift workflow fails on unlisted advisory IDs. Neither
// classification permits production publication while #191 remains blocked.
import { readFileSync, writeFileSync } from "node:fs";
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

export function registryContainerDisposition(summary, baseline = JSON.parse(readFileSync(baselinePath, "utf8"))) {
  if (summary?.schema !== ACCEPTANCE_SUMMARY_SCHEMA) {
    return { exitCode: 1, message: "registry/container acceptance summary has an unexpected schema" };
  }
  if (summary.functionalPassed !== true || summary.generatedTestsPassed !== true) {
    return { exitCode: 1, message: "functional registry/container rehearsal failed" };
  }
  let policy;
  try { policy = summaryAudit(summary, baseline); }
  catch (error) { return { exitCode: 3, message: String(error) }; }
  const gate = summary.securityGate;
  const checksPassed = gate?.registryDependencyPolicyPassed === true &&
    gate.productionImageDependencyPolicyPassed === true && gate.engineStrictExitCode === 0 &&
    gate.lockSbomExitCode === 0 && gate.physicalSbomExitCode === 0;
  const total = summary.audit?.total;
  if (checksPassed && gate.passed === true && total === 0 && gate.auditExitCode === 0 && policy.observedAdvisories.length === 0) {
    return { exitCode: 0, message: "registry/container acceptance passed", ...policy };
  }
  if (checksPassed && Number.isInteger(total) && total > 0 && policy.observedAdvisories.length > 0 &&
      [0, 1].includes(gate.auditExitCode)) {
    return { exitCode: 4, message: "functional registry/container rehearsal passed; production publication " +
      "remains blocked by #191 audit findings" + (policy.unlistedAdvisories.length ?
        `; unlisted advisory IDs: ${policy.unlistedAdvisories.join(", ")}` : " within the recorded baseline"), ...policy };
  }
  return { exitCode: 3, message: "functional registry/container rehearsal passed, but the #191 security gate is blocked beyond audit findings", ...policy };
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
    if (counts.total > 0 && ids.size === 0) throw new Error("npm audit findings lack advisory IDs");
    const policy = classifyRegistryAudit([...ids], JSON.parse(readFileSync(baselinePath, "utf8")));
    writeFileSync(output, JSON.stringify({ schema: "dacs-registry-audit-policy/v1", observed: counts, ...policy }, null, 2) + "\n");
    process.stdout.write(JSON.stringify(counts) + "\n");
  } else {
    const drift = mode === "--audit-drift";
    const summary = JSON.parse(readFileSync(drift ? input : mode, "utf8"));
    const result = drift ? registryAuditDriftDisposition(summary) : registryContainerDisposition(summary);
    if (result.unlistedAdvisories?.length) {
      process.stdout.write(`::warning title=Registry audit advisory drift::Unlisted advisory IDs: ${result.unlistedAdvisories.join(", ")}. Production publication remains blocked by #191.\n`);
    }
    (result.exitCode === 0 ? process.stdout : process.stderr).write(`${result.message}\n`);
    process.exit(result.exitCode);
  }
}
