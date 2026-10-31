import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
const modulePath = "../../scripts/registry-container-disposition.mjs";
const { classifyPolicyChecks, registryAuditDriftDisposition, registryContainerDisposition, RELEASE_VERSION } = await import(modulePath);
const repoRoot = resolve(import.meta.dirname, "../..");
const baseline = JSON.parse(readFileSync(join(repoRoot, "scripts/registry-container-audit-baseline.json"), "utf8"));
const roots: string[] = [];
const scratch = () => { const root = mkdtempSync(join(tmpdir(), "dacs-admission-")); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
const summary = () => ({ schema: "dacs-registry-container-acceptance/v1", complete: true, packageVersion: RELEASE_VERSION,
  functionalPassed: true, generatedTestsPassed: true, docker: { policy: { schema: "dacs-runtime-image-policy/v1" } },
  audit: { ...counts, observedAdvisories: [] as string[], unlistedAdvisories: [] as string[], directAdvisories: [] as string[] },
  securityGate: { auditExitCode: 0,
    findings: { schema: "dacs-registry-policy-findings/v1", gitDependencies: [], productionImageDependencies: [],
      productionImageInventory: { scanComplete: true, errors: [], missing: [] },
      engine: { exitCode: 0, code: null, scanComplete: true, violations: [] },
      lockSbom: { exitCode: 0, code: null, problems: [] }, physicalSbom: { exitCode: 0, code: null, problems: [] } } } });
const cli = (...args: string[]) => spawnSync(process.execPath, ["scripts/registry-container-disposition.mjs", ...args],
  { cwd: repoRoot, encoding: "utf8" });
const writeSummary = (value: unknown) => {
  const path = join(scratch(), "summary.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
};

describe("explicit acceptance outcomes", () => {
  it.each([undefined, null, 0, "false"])("rejects drift completion %j in API and CLI", complete => {
    const value = { ...summary(), complete };
    expect(registryAuditDriftDisposition(value).exitCode).toBe(3);
    expect(cli("--audit-drift", writeSummary(value)).status).toBe(3);
  });

  it.each([undefined, null, "false", 137, 2])("never waives a missing, malformed or interrupted exit code %j", outcome => {
    const s = summary();
    Object.assign(s.securityGate.findings, {
      engine: { exitCode: outcome, code: "EBADENGINE", scanComplete: true,
        violations: baseline.policyFindings.engineViolations, reportedPackage: baseline.policyFindings.engineViolations[0].package },
      lockSbom: { exitCode: outcome, code: "ESBOMPROBLEMS", problems: baseline.policyFindings.lockSbomProblems },
      physicalSbom: { exitCode: outcome, code: "ESBOMPROBLEMS", problems: baseline.policyFindings.physicalSbomProblems } });
    expect(classifyPolicyChecks(s, baseline)).toMatchObject({ engineStrict: "blocked", lockSbom: "blocked", physicalSbom: "blocked" });
  });

  it.each([
    { high: 1, total: 1 }, { total: -1 }, { total: 0.5 }, { low: undefined },
    { observedAdvisories: [baseline.advisoryIds[0]] },
  ])("blocks contradictory summary totals %j", audit => {
    const s = summary(); Object.assign(s.audit, audit);
    expect(registryContainerDisposition(s)).toMatchObject({ exitCode: 3, checks: { audit: "blocked" } });
  });

  it("blocks a nonzero advisory report behind audit exit zero", () => {
    const s = summary(); Object.assign(s.audit, { high: 1, total: 1, observedAdvisories: [baseline.advisoryIds[0]] });
    expect(registryContainerDisposition(s)).toMatchObject({ exitCode: 3, checks: { audit: "blocked" },
      message: expect.stringContaining("npm audit exited 0 for these counts, not 1") });
  });

  it.each([[0, 4], [1, 3]])("expects npm's exit %i for an info-only report (exit %i)", (auditExitCode, exitCode) => {
    const s = summary();
    Object.assign(s.audit, { info: 1, total: 1, observedAdvisories: [baseline.advisoryIds[0]] });
    s.securityGate.auditExitCode = auditExitCode;
    expect(registryContainerDisposition(s).exitCode).toBe(exitCode);
  });

  it.each([
    [["--frobnicate"], "unsupported registry policy mode: --frobnicate"],
    [["--policy-findings"], "usage: --policy-findings <evidence-directory> <output>"],
    [["--record"], "usage: --record <acceptance-summary.json>"],
  ])("refuses %j with a usage error", (args, message) => {
    const result = cli(...args);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
  });
});

describe("complete acceptance admission", () => {
  it.each([
    { failedStage: "consumer" },
    { failureEvidence: [] },
    { failedStage: "consumer", failureClass: "network", failureEvidence: ["npm error code ETIMEDOUT"] },
    { failureClass: "functional" },
    { failureClass: null },
    { failureClass: "policy", disposition: { exitCode: 0, failureClass: null } },
  ])("refuses a complete run that also records a failure %j in both APIs and the CLI", fields => {
    const value = { ...summary(), ...fields };
    expect(registryContainerDisposition(value)).toMatchObject({ exitCode: 1, failureClass: "functional",
      message: expect.stringContaining("complete acceptance summary records a failure") });
    expect(registryAuditDriftDisposition(value).exitCode).toBe(3);
    const path = writeSummary(value);
    expect(cli(path).status).toBe(1);
    expect(cli("--audit-drift", path).status).toBe(3);
  });

  it("admits a complete run whose failure class is the one its disposition recorded", () => {
    expect(registryContainerDisposition({ ...summary(), failureClass: null,
      disposition: { exitCode: 0, failureClass: null } }).exitCode).toBe(0);
  });
});

describe("interrupted acceptance admission", () => {
  it.each([{}, { failedStage: "" }, { failedStage: "consumer" }, { failedStage: "consumer", failureEvidence: [] }])(
    "does not trust a network claim without a stage and evidence %j", fields => {
      const interrupted = { schema: "dacs-registry-container-acceptance/v1", complete: false, failureClass: "network", ...fields };
      for (const disposition of [registryContainerDisposition, registryAuditDriftDisposition]) {
        expect(disposition(interrupted)).toMatchObject({ exitCode: 1, failureClass: "functional" });
        expect(disposition(interrupted).message).not.toContain("undefined");
      }
    });
});

describe("recording a disposition", () => {
  it("records a passing summary's disposition and re-records it to the same bytes", () => {
    const path = writeSummary(summary());
    expect(cli("--record", path).status).toBe(0);
    const recorded = readFileSync(path, "utf8");
    expect(JSON.parse(recorded)).toMatchObject({ failureClass: null,
      disposition: { exitCode: 0, failureClass: null, unlistedAdvisories: "fail" } });
    expect(cli("--record", path).status).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(recorded);
  });

  it("re-classifies a recorded baseline-only summary to its recorded exit", () => {
    const s = summary();
    Object.assign(s.audit, { high: 1, total: 1, observedAdvisories: [baseline.advisoryIds[0]] });
    s.securityGate.auditExitCode = 1;
    const path = writeSummary(s);
    expect(cli("--record", path).status).toBe(4);
    const recorded = JSON.parse(readFileSync(path, "utf8"));
    expect(recorded).toMatchObject({ failureClass: "policy", disposition: { exitCode: 4, failureClass: "policy" } });
    expect(registryContainerDisposition(recorded).exitCode).toBe(4);
    expect(cli(path).status).toBe(4);
  });

  it.each([
    { failureClass: "network" },
    { failureClass: "functional" },
    { failureClass: null },
    { failureClass: "policy", disposition: { exitCode: 0, failureClass: null } },
    { failedStage: "consumer" },
    { packageVersion: "0.0.0-other" },
  ])("leaves a refused complete summary %j unchanged and refused on repeat", fields => {
    const bytes = JSON.stringify({ ...summary(), ...fields });
    const path = join(scratch(), "summary.json");
    writeFileSync(path, bytes);
    expect(cli("--record", path).status).toBe(1);
    expect(readFileSync(path, "utf8")).toBe(bytes);
    expect(cli("--record", path).status).toBe(1);
    expect(cli(path).status).toBe(1);
  });

  it("preserves the original summary when recording fails after a partial write", () => {
    const root = scratch(), input = join(root, "summary.json"), preload = join(root, "failed-write.cjs");
    const bytes = JSON.stringify({ schema: "dacs-registry-container-acceptance/v1", complete: false });
    writeFileSync(input, bytes);
    writeFileSync(preload, `const fs = require('node:fs'); const write = fs.writeFileSync; fs.writeFileSync = (path, ...args) => {
      if (String(path).startsWith(${JSON.stringify(input)})) { write(path, '{'); throw new Error('fixture disk full'); }
      return write(path, ...args); }; require('node:module').syncBuiltinESMExports();`);
    const result = spawnSync(process.execPath, ["--require", preload, "scripts/registry-container-disposition.mjs", "--record", input],
      { cwd: repoRoot, encoding: "utf8" });
    expect(result.stderr).toContain("fixture disk full");
    expect(result.status).not.toBe(0);
    expect(readFileSync(input, "utf8")).toBe(bytes);
    expect(readdirSync(root).some(name => name.includes(".tmp-"))).toBe(false);
  });
});

describe("policy findings CLI", () => {
  it("invalidates saved findings after a failed repeat", () => {
    const root = scratch(), output = join(root, "policy.json");
    expect(cli("--policy-findings", root, output).status).toBe(0);
    mkdirSync(join(root, "engine-strict.log"));
    expect(cli("--policy-findings", root, output).status).not.toBe(0);
    expect(existsSync(output)).toBe(false);
  });

  it.each(["generated-package-lock.json", "dependency-policy.json", "engine-strict.log"])(
    "refuses an output that names its source %s without deleting it", name => {
      const root = scratch();
      writeFileSync(join(root, name), "evidence");
      expect(cli("--policy-findings", root, join(root, ".", name)).status).not.toBe(0);
      expect(readFileSync(join(root, name), "utf8")).toBe("evidence");
    });
});
