import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditLock, auditReport, npmAuditReport, type AuditFinding } from "./npm-audit-fixtures.js";
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
const advisory = (name: string, severity: string, id = firstId, range = "*") =>
  ({ name, severity, url: "https://github.com/advisories/" + id, range });
const auditPolicyRun = (audit: unknown, lock: unknown) => {
  const root = scratch(), input = join(root, "audit.json"), lockPath = join(root, "lock.json"), output = join(root, "policy.json");
  writeFileSync(input, JSON.stringify(audit));
  if (lock !== undefined) writeFileSync(lockPath, typeof lock === "string" ? lock : JSON.stringify(lock));
  return { result: cli("--audit-policy", input, lockPath, output), output };
};
const graphPolicyRun = (vulnerabilities: Record<string, AuditFinding>) => auditPolicyRun(auditReport(vulnerabilities), auditLock(vulnerabilities));

// Real npm output (npm 10.9.9, loopback registry): the consumer installs
// leaf@1 directly (a low advisory) and mid, which nests leaf@2 (a high one).
// npm aggregates both under one `leaf` record marked isDirect.
const captured = (name: string) => ({
  audit: JSON.parse(readFileSync(join(repoRoot, "test/scripts/fixtures/npm-audit-nested-advisory", name, "npm-audit.json"), "utf8")),
  lock: JSON.parse(readFileSync(join(repoRoot, "test/scripts/fixtures/npm-audit-nested-advisory", name, "package-lock.json"), "utf8")),
});
const [lowId, highId] = ["GHSA-23hp-3jrh-7fpw", "GHSA-2pr8-phx7-x9h3"];
// The nested-only lock with `leaf` declared as `field` at `version`, or
// under `alias` (an npm: alias of leaf).
function directLeaf(version: string, { field = "dependencies", alias }: { field?: string; alias?: string } = {}) {
  const { audit, lock } = captured("nested-only");
  const root = lock.packages[""];
  const specifier = alias ?? "leaf";
  root.dependencies = { mid: "1.0.0" };
  root[field] = { ...root[field], [specifier]: alias ? `npm:leaf@${version}` : version };
  delete lock.packages["node_modules/leaf"];
  lock.packages[`node_modules/${specifier}`] = { ...(alias ? { name: "leaf" } : {}), version };
  return { audit, lock };
}

describe("advisory applicability from the lock", () => {
  it("does not apply a nested-only high advisory to the direct copy of the same package", () => {
    const { audit, lock } = captured("nested-only");
    expect(audit.vulnerabilities.leaf.isDirect).toBe(true);
    expect(registryAuditPolicy(audit, lock, baseline)).toMatchObject({
      observedAdvisories: [lowId, highId], directAdvisories: [], unlistedAdvisories: [], passed: false });
    const { result, output } = auditPolicyRun(audit, lock);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(output, "utf8")).directAdvisories).toEqual([]);
  });

  it("applies a high advisory whose range covers the direct version", () => {
    const { audit, lock } = captured("direct-affected");
    expect(registryAuditPolicy(audit, lock, baseline)).toMatchObject({ observedAdvisories: [highId], directAdvisories: [highId] });
  });

  it.each([
    ["an alias of the package", "2.1.0", { alias: "leaf-two" }, [highId]],
    ["an alias at an unaffected version", "1.0.0", { alias: "leaf-one" }, []],
    ["a dev dependency", "2.1.0", { field: "devDependencies" }, [highId]],
    ["an optional dependency", "2.1.0", { field: "optionalDependencies" }, [highId]],
  ] as const)("reads directness through %s", (_label, version, options, direct) => {
    const { audit, lock } = directLeaf(version, options);
    expect(registryAuditPolicy(audit, lock, baseline).directAdvisories).toEqual(direct);
  });

  it("checks every direct version of a package", () => {
    const { audit, lock } = directLeaf("1.0.0");
    lock.packages[""].dependencies["leaf-two"] = "npm:leaf@2.1.0";
    lock.packages["node_modules/leaf-two"] = { name: "leaf", version: "2.1.0" };
    expect(registryAuditPolicy(audit, lock, baseline).directAdvisories).toEqual([highId]);
  });

  type Lock = { packages: Record<string, Record<string, unknown>> };
  it.each([
    ["no lock", () => null],
    ["a lock without a root", (lock: Lock) => { delete lock.packages[""]; }],
    ["an unresolvable direct dependency", (lock: Lock) => { delete lock.packages["node_modules/leaf"]; }],
    ["a direct version that is not semver", (lock: Lock) => {
      lock.packages["node_modules/leaf"] = { ...lock.packages["node_modules/leaf"], version: "not-a-version" }; }],
    ["a workspace", (lock: Lock) => { lock.packages["packages/app"] = { version: "1.0.0" }; }],
    ["a linked package", (lock: Lock) => { lock.packages["node_modules/leaf"] = { resolved: "packages/leaf", link: true }; }],
    ["root workspaces", (lock: Lock) => { lock.packages[""] = { ...lock.packages[""], workspaces: ["packages/*"] }; }],
  ])("refuses to confirm directness with %s, whatever the report names", (_label, change) => {
    const { audit, lock } = captured("nested-only");
    const changed = change(lock) === null ? null : lock;
    for (const report of [audit, auditReport({})]) {
      expect(() => registryAuditPolicy(report, changed, baseline)).toThrow("advisory applicability unevaluated");
      const { result, output } = auditPolicyRun(report, changed ?? "{");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("advisory applicability unevaluated");
      expect(existsSync(output)).toBe(false);
    }
  });

  // A direct dependency `name` declared under `field` and locked at `version`
  // (as an npm: alias when `installed` differs from `name`).
  const withDirect = (lock: Lock, field: string, name: string, version: string, installed = name) => {
    const root = lock.packages[""] ?? {};
    root[field] = { ...(root[field] as object), [name]: installed === name ? "1.0.0" : `npm:${installed}@1.0.0` };
    lock.packages[`node_modules/${name}`] = { ...(installed === name ? {} : { name: installed }), version };
  };
  it.each([
    ["a report naming other packages", "dependencies", "other", "other", true],
    ["an aliased entry", "dependencies", "al", "zzz", false],
    ["a dev dependency", "devDependencies", "dz", "dz", false],
    ["a peer dependency", "peerDependencies", "dz", "dz", false],
    ["an optional dependency", "optionalDependencies", "dz", "dz", false],
  ] as const)("refuses an unreadable direct version the report does not name, through %s", (_label, field, name, installed, named) => {
    const { audit, lock } = captured("nested-only");
    withDirect(lock, field, name, "not-a-version", installed);
    const report = named ? audit : auditReport({});
    expect(() => registryAuditPolicy(report, lock, baseline)).toThrow(`unreadable version "not-a-version" of ${installed}`);
    const { result, output } = auditPolicyRun(report, lock);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("advisory applicability unevaluated");
    expect(existsSync(output)).toBe(false);
  });

  it("passes an empty report only with a readable lock, and reads a loose direct version", () => {
    const { lock } = captured("nested-only");
    expect(registryAuditPolicy(auditReport({}), lock, baseline)).toMatchObject({ directAdvisories: [], passed: true });
    withDirect(lock, "dependencies", "loose", "v2.1.0");
    const loose = auditReport({ loose: { severity: "high", isDirect: true, via: [advisory("loose", "high")] } });
    expect(registryAuditPolicy(loose, lock, baseline).directAdvisories).toEqual([firstId]);
  });

  it.each(["constructor", "toString", "hasOwnProperty"])("evaluates an advisory for a package named %s", name => {
    const { lock } = captured("nested-only");
    const report = auditReport({ [name]: { severity: "high", isDirect: false, via: [advisory(name, "high")] } });
    expect(registryAuditPolicy(report, lock, baseline)).toMatchObject({ observedAdvisories: [firstId], directAdvisories: [] });
  });

  it("refuses to confirm directness against an unreadable advisory range", () => {
    const { audit, lock } = captured("nested-only");
    audit.vulnerabilities.leaf.via[1].range = "not a range";
    expect(() => registryAuditPolicy(audit, lock, baseline)).toThrow("advisory applicability unevaluated");
  });

  it("refuses to confirm directness when the lock file is missing", () => {
    const { result, output } = auditPolicyRun(captured("nested-only").audit, undefined);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("advisory applicability unevaluated");
    expect(existsSync(output)).toBe(false);
  });

  it("reads a real npm audit report of a nested-only advisory as transitive", { timeout: 60_000 }, async () => {
    const root = scratch(), project = join(root, "project");
    const { lock } = captured("nested-only");
    mkdirSync(project);
    writeFileSync(join(project, "package.json"), JSON.stringify({ ...lock.packages[""], private: true }));
    writeFileSync(join(project, "package-lock.json"), JSON.stringify(lock));
    const url = (id: string) => "https://github.com/advisories/" + id;
    const npm = await npmAuditReport(project, join(root, "cache"), {
      leaf: { "1.0.0": {}, "2.0.0": {}, "2.1.0": {} }, mid: { "1.0.0": { leaf: "2.0.0" } },
    }, { leaf: [
      { id: 1001, url: url(lowId), title: "low on leaf 1", severity: "low", vulnerable_versions: "<2.0.0" },
      { id: 1002, url: url(highId), title: "high on leaf 2", severity: "high", vulnerable_versions: ">=2.0.0 <3.0.0" },
    ] });
    expect(npm.status).toBe(1);
    const policy = registryAuditPolicy(JSON.parse(npm.stdout), lock, baseline);
    expect(policy).toMatchObject({ observedAdvisories: [lowId, highId], directAdvisories: [] });
  });
});

describe("npm audit report admission", () => {
  it("accepts multiple advisory IDs per package and a resolved inherited advisory cycle", () => {
    const { result, output } = graphPolicyRun({
      x: { severity: "high", isDirect: false, via: [advisory("x", "high"), advisory("x", "high", secondId), "y"] },
      y: { severity: "high", isDirect: false, via: ["x"] } });
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
      metadata: { vulnerabilities: { ...counts, high: 1, total: 1 } }, vulnerabilities }, auditLock(vulnerabilities));
    expect(result.status).not.toBe(0);
    expect(existsSync(output)).toBe(false);
  });

  it.each([{ ...counts, total: -1 }, { ...counts, total: 0.5 }, { ...counts, low: undefined }, { ...counts, high: 1 }])(
    "rejects inconsistent vulnerability counts %j", vulnerabilities => {
      expect(() => registryAuditPolicy({ metadata: { vulnerabilities }, vulnerabilities: {} }, auditLock({}), baseline))
        .toThrow("inconsistent npm audit vulnerability counts");
    });

  it.each([undefined, null, "true", 0])("refuses incomplete directness %j before producing a policy", isDirect => {
    const { result, output } = graphPolicyRun({ fixture: { severity: "high", isDirect, via: [advisory("fixture", "high")] } });
    expect(result.status).not.toBe(0);
    expect(existsSync(output)).toBe(false);
  });

  it("classifies the same report identically in any package and edge order", () => {
    const graph = {
      leaf: { severity: "high", isDirect: false, via: [advisory("leaf", "moderate"), advisory("leaf", "high", secondId)] },
      parent: { severity: "moderate", isDirect: true, via: ["leaf"] },
      other: { severity: "high", isDirect: true, via: ["leaf"] },
    };
    const expected = registryAuditPolicy(auditReport(graph), auditLock(graph), baseline);
    const reversed = Object.fromEntries(Object.entries(graph).reverse()
      .map(([name, value]) => [name, { ...value, via: [...value.via].reverse() }]));
    expect(registryAuditPolicy(auditReport(reversed), auditLock(reversed), baseline)).toEqual(expected);
  });
});

describe("audit policy CLI", () => {
  it("invalidates saved success after a failed repeat", () => {
    const root = scratch(), input = join(root, "audit.json"), lock = join(root, "lock.json"), output = join(root, "policy.json");
    writeFileSync(input, JSON.stringify(auditReport({})));
    writeFileSync(lock, JSON.stringify(auditLock({})));
    expect(cli("--audit-policy", input, lock, output).status).toBe(0);
    writeFileSync(input, readFileSync(join(repoRoot, "test/scripts/fixtures/npm-audit-endpoint-errors/503.json")));
    expect(cli("--audit-policy", input, lock, output).status).not.toBe(0);
    expect(existsSync(output)).toBe(false);
  });

  it.each(["audit.json", "lock.json"])("refuses an output that aliases its input %s without deleting evidence", name => {
    const root = scratch(), input = join(root, "audit.json"), lock = join(root, "lock.json");
    writeFileSync(input, JSON.stringify(auditReport({})));
    writeFileSync(lock, JSON.stringify(auditLock({})));
    const bytes = readFileSync(join(root, name), "utf8");
    expect(cli("--audit-policy", input, lock, join(root, ".", name)).status).not.toBe(0);
    expect(readFileSync(join(root, name), "utf8")).toBe(bytes);
  });

  it("names its arguments when one is missing", () => {
    const root = scratch();
    const result = cli("--audit-policy", join(root, "audit.json"), join(root, "policy.json"));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("usage: --audit-policy <npm-audit.json> <generated-package-lock.json> <output>");
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
