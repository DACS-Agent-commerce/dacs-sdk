import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
const disposition = "../../scripts/registry-container-disposition.mjs";
const { POLICY_SOURCES, classifyPolicyChecks, classifyRegistryAudit } = await import(disposition);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function checkout() {
  const root = mkdtempSync(join(tmpdir(), "dacs-ci-replay-")); roots.push(root);
  cpSync("scripts", join(root, "scripts"), { recursive: true });
  cpSync("package.json", join(root, "package.json"));
  return root;
}
function fixtures(root: string) {
  return spawnSync(process.execPath, [join(root, "scripts/acceptance-fixtures.mjs"), join(root, "evidence"), join(root, "fixtures")], { encoding: "utf8" });
}
describe("acceptance evidence entrypoints", () => {
  it("copies exactly the closed inherited evidence set with the sole log rename", () => {
    const root = checkout(); mkdirSync(join(root, "evidence"));
    for (const name of ["acceptance-summary.json", ...POLICY_SOURCES, "docker-build.log", "unrelated.json"]) {
      writeFileSync(join(root, "evidence", name), name);
    }
    const result = fixtures(root); expect(result.status, result.stderr).toBe(0);
    const expected = ["acceptance-summary.json", ...POLICY_SOURCES]
      .map(name => name === "engine-strict.log" ? "engine-strict.log.txt" : name).sort();
    expect(readdirSync(join(root, "fixtures")).sort()).toEqual(expected);
    for (const name of expected) expect(readFileSync(join(root, "fixtures", name), "utf8"))
      .toBe(name === "engine-strict.log.txt" ? "engine-strict.log" : name);
    expect(expected).toContain("runtime-image-inventory.json");
  });
  it.each([false, true])("preserves partial evidence without fabricating a summary or inventory (directory exists=%s)", present => {
    const root = checkout();
    if (present) { mkdirSync(join(root, "evidence")); writeFileSync(join(root, "evidence/engine-strict.log"), "partial failure"); }
    const result = fixtures(root); expect(result.status, result.stderr).toBe(0);
    expect(readdirSync(join(root, "fixtures"))).toEqual(present ? ["engine-strict.log.txt"] : []);
    expect(existsSync(join(root, "fixtures/acceptance-summary.json"))).toBe(false);
    expect(existsSync(join(root, "fixtures/runtime-image-inventory.json"))).toBe(false);
  });
  it("publishes the available summary separately and leaves missing summaries missing", () => {
    const root = checkout(), output = join(root, "step-summary");
    const run = () => spawnSync("bash", ["scripts/acceptance-ci.sh", "summary"], { cwd: root, encoding: "utf8",
      env: { ...process.env, GITHUB_STEP_SUMMARY: output } });
    expect(run().status).toBe(0); expect(existsSync(output)).toBe(false);
    mkdirSync(join(root, "registry-container-artifacts"));
    writeFileSync(join(root, "registry-container-artifacts/acceptance-summary.json"), '{"complete":false}');
    expect(run().status).toBe(0); expect(readFileSync(output, "utf8")).toContain('{"complete":false}');
  });
  it.each(["pull_request", "workflow_dispatch", "schedule", "workflow_call"])("keeps absent drift unevaluated and fails enforcing event %s", event => {
    const root = checkout();
    for (const enforced of [false, true]) {
      const result = spawnSync("bash", ["scripts/acceptance-ci.sh", "drift"], { cwd: root, encoding: "utf8",
        env: { ...process.env, GITHUB_EVENT_NAME: event, ENFORCE_AUDIT_DRIFT: String(enforced) } });
      expect(result.stdout).toContain("was not evaluated");
      expect(result.status).toBe(event === "pull_request" && !enforced ? 0 : 1);
    }
  });
  it("keeps reporting and both upload actions independently always enabled", () => {
    const workflow = readFileSync(resolve(".github/workflows/registry-container-acceptance.yml"), "utf8");
    for (const name of ["Check advisory-ID drift", "Publish acceptance summary", "Upload bootstrap diagnostics", "Upload registry/container evidence",
      "Assemble disposition fixtures", "Upload disposition fixtures"]) {
      const step = workflow.split(`      - name: ${name}\n`)[1]?.split("\n      - ")[0];
      expect(step, name).toContain("        if: always()");
    }
  });
});

// Exact observations from the Node 20 consumer gate, independently re-resolved
// from the packed SDK before this baseline update.
const refreshedEngines = [
  { package: "@tufjs/models@5.0.1", location: "node_modules/@tufjs/models",
    integrity: "sha512-wacy5twbJk36R0dTcGE3qmPNNH095bFselAYNrVCzf0Byd0t3+Qzk3+3gn/rHGP10FuHBVk4swg4aczr1c2z/g==",
    required: { node: "^22.22.2 || ^24.15.0 || >=26.0.0" } },
  { package: "tuf-js@6.0.1", location: "node_modules/tuf-js",
    integrity: "sha512-o59N1PU8xk0bBV3HpJ4jjwldIeze17yXW1XTv02CEEKdC3E/tnJDU3CPWDNT4IZpkx9Srv9v1DJZ+JTdo46THg==",
    required: { node: "^22.22.2 || ^24.15.0 || >=26.0.0" } },
];
const refreshedNotices = ["GHSA-4qx8-w7c3-pj3p", "GHSA-9j65-hcg3-gc64", "GHSA-9qmh-m7c6-f92p", "GHSA-mrhx-c7xc-m3w5", "GHSA-gcqx-w48m-w2h4", "GHSA-qr28-fpjm-wq7f"];
describe("reviewed consumer baseline refresh", () => {
  const baseline = JSON.parse(readFileSync("scripts/registry-container-audit-baseline.json", "utf8"));
  const engineCheck = (violation: typeof refreshedEngines[number]) => classifyPolicyChecks({ securityGate: { findings: {
    engine: { exitCode: 1, code: "EBADENGINE", scanComplete: true, reportedPackage: violation.package, violations: [violation] },
  } } }, baseline).engineStrict;
  it.each(refreshedEngines)("retains the exact reviewed engine identity $package", violation => {
    expect(engineCheck(violation)).toBe("baseline");
  });
  it.each(refreshedEngines)("refuses changed identities for $package", violation => {
    for (const changed of [
      { ...violation, package: violation.package.replace(/1$/, "2") },
      { ...violation, integrity: "sha512-different" },
      { ...violation, location: "node_modules/other/" + violation.location },
      { ...violation, required: { node: ">=26" } },
    ]) expect(engineCheck(changed)).toBe("blocked");
  });
  it.each(refreshedNotices)("retains the reviewed transitive notice %s", id => {
    expect(classifyRegistryAudit([id], baseline)).toMatchObject({ observedAdvisories: [id], unlistedAdvisories: [] });
    expect(classifyRegistryAudit([id], baseline, [id]).directAdvisories).toEqual([id]);
  });
});
