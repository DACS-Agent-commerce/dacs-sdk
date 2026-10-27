import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
const modulePath = "../../scripts/registry-container-disposition.mjs";
const { expectedAuditExitCode, registryAuditPolicy, summaryAudit } = await import(modulePath);
const repoRoot = resolve(import.meta.dirname, "../..");
const baseline = JSON.parse(readFileSync(join(repoRoot, "scripts/registry-container-audit-baseline.json"), "utf8"));
const roots: string[] = [];
const scratch = () => { const root = mkdtempSync(join(tmpdir(), "dacs-audit-evidence-")); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const cli = (...args: string[]) => spawnSync(process.execPath, ["scripts/registry-container-disposition.mjs", ...args],
  { cwd: repoRoot, encoding: "utf8" });
const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
const [firstId, secondId] = baseline.advisoryIds as string[];
const advisory = (name: string, severity: string, id = firstId) =>
  ({ name, severity, url: "https://github.com/advisories/" + id, range: "*" });
type Finding = { severity: string; isDirect: unknown; via: unknown[] };
const report = (vulnerabilities: Record<string, Finding>) => {
  const packages = Object.values(vulnerabilities);
  const bySeverity = Object.fromEntries(Object.keys(counts).filter(key => key !== "total")
    .map(severity => [severity, packages.filter(value => value.severity === severity).length]));
  return { auditReportVersion: 2, metadata: { vulnerabilities: { ...bySeverity, total: packages.length } }, vulnerabilities };
};
const auditPolicyRun = (audit: unknown) => {
  const root = scratch(), input = join(root, "audit.json"), output = join(root, "policy.json");
  writeFileSync(input, JSON.stringify(audit));
  return { result: cli("--audit-policy", input, output), output };
};

describe("npm audit report admission", () => {
  it("accepts multiple advisory IDs per package and a resolved inherited advisory cycle", () => {
    const { result, output } = auditPolicyRun(report({
      x: { severity: "high", isDirect: false, via: [advisory("x", "high"), advisory("x", "high", secondId), "y"] },
      y: { severity: "high", isDirect: false, via: ["x"] } }));
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(output, "utf8")).observedAdvisories).toEqual([firstId, secondId].sort());
  });

  it.each([
    ["a missing reference", { x: { severity: "high", isDirect: false, via: ["missing"] } }],
    ["an ungrounded cycle", { x: { severity: "high", isDirect: false, via: ["x"] } }],
    ["counts that disagree with the entries", { x: { severity: "low", isDirect: false, via: [advisory("x", "low")] } }],
    ["no entries behind nonzero counts", {}],
    ["an invalid advisory severity", { x: { severity: "high", isDirect: false, via: [advisory("x", "severe")] } }],
    ["an advisory without a URL", { x: { severity: "high", isDirect: false, via: [{ ...advisory("x", "high"), url: undefined }] } }],
    ["an advisory without a range", { x: { severity: "high", isDirect: false, via: [{ ...advisory("x", "high"), range: undefined }] } }],
    ["an advisory without a package name", { x: { severity: "high", isDirect: false, via: [{ ...advisory("x", "high"), name: undefined }] } }],
    ["an advisory named for another package", { x: { severity: "high", isDirect: false, via: [advisory("other", "high")] } }],
    ["an empty via list", { x: { severity: "high", isDirect: false, via: [] } }],
  ])("rejects %s", (_label, vulnerabilities) => {
    const { result, output } = auditPolicyRun({ auditReportVersion: 2,
      metadata: { vulnerabilities: { ...counts, high: 1, total: 1 } }, vulnerabilities });
    expect(result.status).not.toBe(0);
    expect(existsSync(output)).toBe(false);
  });

  it.each([{ ...counts, total: -1 }, { ...counts, total: 0.5 }, { ...counts, low: undefined }, { ...counts, high: 1 }])(
    "rejects inconsistent vulnerability counts %j", vulnerabilities => {
      expect(() => registryAuditPolicy({ metadata: { vulnerabilities }, vulnerabilities: {} }, baseline))
        .toThrow("inconsistent npm audit vulnerability counts");
    });

  it.each([undefined, null, "true", 0])("refuses incomplete directness %j before producing a policy", isDirect => {
    const { result, output } = auditPolicyRun(report({ fixture: { severity: "high", isDirect, via: [advisory("fixture", "high")] } }));
    expect(result.status).not.toBe(0);
    expect(existsSync(output)).toBe(false);
  });

  it("classifies the same report identically in any package and edge order", () => {
    const graph = {
      leaf: { severity: "high", isDirect: false, via: [advisory("leaf", "moderate"), advisory("leaf", "high", secondId)] },
      parent: { severity: "moderate", isDirect: true, via: ["leaf"] },
      other: { severity: "high", isDirect: true, via: ["leaf"] },
    };
    const expected = registryAuditPolicy(report(graph), baseline);
    const reversed = Object.fromEntries(Object.entries(graph).reverse()
      .map(([name, value]) => [name, { ...value, via: [...value.via].reverse() }]));
    expect(registryAuditPolicy(report(reversed), baseline)).toEqual(expected);
  });
});

describe("audit policy CLI", () => {
  it("invalidates saved success after a failed repeat", () => {
    const root = scratch(), input = join(root, "audit.json"), output = join(root, "policy.json");
    writeFileSync(input, JSON.stringify(report({})));
    expect(cli("--audit-policy", input, output).status).toBe(0);
    writeFileSync(input, readFileSync(join(repoRoot, "test/scripts/fixtures/npm-audit-endpoint-errors/503.json")));
    expect(cli("--audit-policy", input, output).status).not.toBe(0);
    expect(existsSync(output)).toBe(false);
  });

  it("refuses an output that aliases its input without deleting evidence", () => {
    const root = scratch(), input = join(root, "audit.json"), bytes = JSON.stringify(report({}));
    writeFileSync(input, bytes);
    expect(cli("--audit-policy", input, join(root, ".", "audit.json")).status).not.toBe(0);
    expect(readFileSync(input, "utf8")).toBe(bytes);
  });

  it("names its arguments when one is missing", () => {
    const result = cli("--audit-policy", join(scratch(), "audit.json"));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("usage: --audit-policy");
  });
});

describe("npm audit exit code", () => {
  it.each([
    [{ ...counts }, 0],
    [{ ...counts, info: 2, total: 2 }, 0],
    [{ ...counts, low: 1, total: 1 }, 1],
    [{ ...counts, info: 1, critical: 1, total: 2 }, 1],
  ])("expects npm's default audit level for %j", (vulnerabilities, exitCode) => {
    expect(expectedAuditExitCode(vulnerabilities)).toBe(exitCode);
  });

  it("refuses inconsistent counts", () => {
    expect(() => expectedAuditExitCode({ ...counts, info: 1 })).toThrow("inconsistent npm audit vulnerability counts");
  });
});

describe("recorded summary audit evidence", () => {
  const recorded = (audit: Record<string, unknown>) => ({ audit: { ...counts, observedAdvisories: [], unlistedAdvisories: [],
    directAdvisories: [], ...audit } });

  it("re-classifies recorded advisory IDs against the baseline", () => {
    expect(summaryAudit(recorded({ high: 1, total: 1, observedAdvisories: [firstId] }), baseline))
      .toMatchObject({ observedAdvisories: [firstId], unlistedAdvisories: [], directAdvisories: [] });
  });

  it.each([
    ["no direct-advisory evidence", { directAdvisories: undefined }, "no valid direct-advisory evidence"],
    ["a dropped unlisted ID", { high: 1, total: 1, observedAdvisories: ["GHSA-2222-3333-4444"] }, "does not match baseline"],
    ["advisories behind zero totals", { observedAdvisories: [firstId] }, "audit totals disagree"],
    ["totals without advisories", { high: 1, total: 1 }, "audit totals disagree"],
    ["negative counts", { total: -1 }, "inconsistent npm audit vulnerability counts"],
  ])("refuses %s", (_label, audit, message) => {
    expect(() => summaryAudit(recorded(audit), baseline)).toThrow(message);
  });
});
