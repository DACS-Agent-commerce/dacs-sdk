import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const modulePath = "../../scripts/registry-container-disposition.mjs";
const { classifyPolicyChecks, registryAuditDriftDisposition, registryContainerDisposition, RELEASE_VERSION } = await import(modulePath);
const baseline = JSON.parse(readFileSync("scripts/registry-container-audit-baseline.json", "utf8"));
const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
const summary = () => ({ schema: "dacs-registry-container-acceptance/v1", complete: true, packageVersion: RELEASE_VERSION,
  functionalPassed: true, generatedTestsPassed: true, docker: { policy: { schema: "dacs-runtime-image-policy/v1", typescriptPresent: false, rubicSdkPresent: false, productionDependencyPolicyPassed: true } },
  audit: { ...counts, observedAdvisories: [], unlistedAdvisories: [], directAdvisories: [] },
  securityGate: { passed: true, auditExitCode: 0, registryDependencyPolicyPassed: true, productionImageDependencyPolicyPassed: true,
    engineStrictExitCode: 0, lockSbomExitCode: 0, physicalSbomExitCode: 0,
    findings: { schema: "dacs-registry-policy-findings/v1", gitDependencies: [], productionImageDependencies: [],
      productionImageInventory: { scanComplete: true, errors: [], missing: [] },
      engine: { exitCode: 0, code: null, scanComplete: true, violations: [] },
      lockSbom: { exitCode: 0, code: null, problems: [] }, physicalSbom: { exitCode: 0, code: null, problems: [] } } } });
const cli = (...args: string[]) => spawnSync(process.execPath, ["scripts/registry-container-disposition.mjs", ...args], { encoding: "utf8" });
describe("explicit acceptance outcomes", () => {
  it.each([undefined, null, 0, "false"])("rejects drift completion %j in API and CLI", complete => {
    const root = mkdtempSync(join(tmpdir(), "dacs-drift-"));
    try {
      const input = join(root, "summary.json"); const value = { ...summary(), complete };
      expect(registryAuditDriftDisposition(value).exitCode).toBe(3);
      writeFileSync(input, JSON.stringify(value)); expect(cli("--audit-drift", input).status).toBe(3);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.each([undefined, null, "false", 137, 2])("never waives missing, malformed or interrupted outcomes %j", outcome => {
    const s = summary(); const gate = s.securityGate;
    Object.assign(gate, { registryDependencyPolicyPassed: outcome, productionImageDependencyPolicyPassed: outcome,
      engineStrictExitCode: outcome, lockSbomExitCode: outcome, physicalSbomExitCode: outcome });
    Object.assign(gate.findings, { gitDependencies: baseline.policyFindings.gitDependencies,
      productionImageDependencies: baseline.policyFindings.productionImageDependencies,
      engine: { exitCode: outcome, code: "EBADENGINE", scanComplete: true,
        violations: baseline.policyFindings.engineViolations, reportedPackage: baseline.policyFindings.engineViolations[0].package },
      lockSbom: { exitCode: outcome, code: "ESBOMPROBLEMS", problems: baseline.policyFindings.lockSbomProblems },
      physicalSbom: { exitCode: outcome, code: "ESBOMPROBLEMS", problems: baseline.policyFindings.physicalSbomProblems } });
    expect(Object.values(classifyPolicyChecks(s, baseline))).toEqual(Array(5).fill("blocked"));
  });
  it.each([
    { high: 1, total: 1 }, { total: -1 }, { total: 0.5 }, { low: undefined },
    { observedAdvisories: [baseline.advisoryIds[0]] },
  ])("blocks contradictory summary totals %j", audit => {
    const s = summary(); Object.assign(s.audit, audit); expect(registryContainerDisposition(s).exitCode).toBe(3);
  });
  it("blocks a nonzero advisory report behind audit exit zero", () => {
    const s = summary(); Object.assign(s.audit, { high: 1, total: 1, observedAdvisories: [baseline.advisoryIds[0]] });
    expect(registryContainerDisposition(s).exitCode).toBe(3);
  });
  it("accepts multiple advisory IDs per package and a resolved inherited advisory cycle", () => {
    const root = mkdtempSync(join(tmpdir(), "dacs-audit-valid-"));
    try {
      const via = baseline.advisoryIds.slice(0, 2).map((id: string) => ({ url: "https://github.com/advisories/" + id, severity: "high" }));
      const input = join(root, "audit.json"), output = join(root, "policy.json");
      writeFileSync(input, JSON.stringify({ metadata: { vulnerabilities: { ...counts, high: 2, total: 2 } },
        vulnerabilities: { x: { severity: "high", isDirect: false, via: [...via, "y"] }, y: { severity: "high", isDirect: false, via: ["x"] } } }));
      expect(cli("--audit-policy", input, output).status).toBe(0);
      expect(JSON.parse(readFileSync(output, "utf8")).observedAdvisories).toHaveLength(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.each([
    { x: { severity: "high", via: ["missing"] } },
    { x: { severity: "high", via: ["x"] } },
    { x: { severity: "low", via: [{ url: "https://github.com/advisories/" + baseline.advisoryIds[0], severity: "low" }] } },
    {},
  ])("rejects inconsistent audit graph or counts %j", vulnerabilities => {
    const root = mkdtempSync(join(tmpdir(), "dacs-audit-"));
    try {
      const input = join(root, "audit.json");
      writeFileSync(input, JSON.stringify({ auditReportVersion: 2, metadata: { vulnerabilities: { ...counts, high: 1, total: 1 } }, vulnerabilities }));
      expect(cli("--audit-policy", input, join(root, "policy.json")).status).not.toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
