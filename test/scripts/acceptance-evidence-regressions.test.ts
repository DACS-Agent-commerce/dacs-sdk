import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
const modulePath = "../../scripts/registry-container-disposition.mjs";
const { classifyPolicyChecks, registryContainerDisposition, registryAuditDriftDisposition, extractPolicyFindings, RELEASE_VERSION } = await import(modulePath);
const repoRoot = resolve(import.meta.dirname, "../..");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const passing = () => ({
  schema: "dacs-registry-container-acceptance/v1", complete: true, packageVersion: RELEASE_VERSION,
  generatedTestsPassed: true, functionalPassed: true, docker: { policy: { schema: "dacs-runtime-image-policy/v1", typescriptPresent: false, rubicSdkPresent: false, productionDependencyPolicyPassed: true } },
  audit: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0, observedAdvisories: [] as string[], unlistedAdvisories: [] as string[], directAdvisories: [] as string[] },
  securityGate: { passed: true, registryDependencyPolicyPassed: true, productionImageDependencyPolicyPassed: true,
    engineStrictExitCode: 0, auditExitCode: 0, lockSbomExitCode: 0, physicalSbomExitCode: 0,
    findings: { schema: "dacs-registry-policy-findings/v1", gitDependencies: [], productionImageDependencies: [],
      productionImageInventory: { scanComplete: true, errors: [], missing: [] },
      engine: { exitCode: 0, code: null, scanComplete: true, violations: [] },
      lockSbom: { exitCode: 0, code: null, problems: [] }, physicalSbom: { exitCode: 0, code: null, problems: [] } } },
});
describe("complete acceptance evidence regressions", () => {
  it.each(["typescriptPresent", "rubicSdkPresent", "productionDependencyPolicyPassed"])(
    "rejects missing or contradictory image policy %s in API and CLI", field => {
      const root = mkdtempSync(join(tmpdir(), "dacs-image-policy-")); roots.push(root);
      const input = join(root, "summary.json");
      const check = (summary: ReturnType<typeof passing>, expected: number) => {
        expect(registryContainerDisposition(summary).exitCode).toBe(expected);
        writeFileSync(input, JSON.stringify(summary));
        expect(spawnSync(process.execPath, ["scripts/registry-container-disposition.mjs", input],
          { cwd: repoRoot, encoding: "utf8" }).status).toBe(expected);
      };
      check(passing(), 0);
      for (const value of [undefined, null, "false", field !== "productionDependencyPolicyPassed"]) {
        const summary = passing(); Object.assign(summary.docker.policy, { [field]: value });
        check(summary, 3);
      }
    });

  it.each(["typescript", "rubic-sdk"])("retains prohibited image package %s despite absent or false policy flags", name => {
    for (const flag of [undefined, false]) for (const nested of [false, true]) {
      const location = nested ? `node_modules/parent/node_modules/${name}` : `node_modules/${name}`;
      const item = { name, location, version: "1.0.0" };
      const parent = { name: "parent", location: "node_modules/parent", version: "1.0.0" };
      const files: Record<string, string> = {
        "generated-package-lock.json": JSON.stringify({ packages: {
          "": { dependencies: { [nested ? "parent" : name]: "1.0.0" } },
          ...(nested ? { [parent.location]: { ...parent, dependencies: { [name]: "1.0.0" } } } : {}),
          [location]: { version: "1.0.0", integrity: "sha512-fixture" },
        } }),
        "runtime-image-policy.json": JSON.stringify({ typescriptPresent: flag, rubicSdkPresent: flag }),
        "runtime-image-inventory.json": JSON.stringify({ schema: "dacs-runtime-image-inventory/v1", packages: nested ? [parent, item] : [item] }),
      };
      const extracted = extractPolicyFindings((filename: string) => files[filename]);
      expect(extracted.productionImageInventory).toMatchObject({ scanComplete: true, missing: [], errors: [] });
      expect(extracted.productionImageDependencies).toEqual([{ ...item, integrity: "sha512-fixture" }]);
      const summary = passing(); Object.assign(summary.securityGate, { findings: { ...summary.securityGate.findings, ...extracted } });
      expect(registryContainerDisposition(summary).exitCode).toBe(3);
    }
  });

  describe("baseline match of a prohibited image package", () => {
    const location = "node_modules/typescript";
    const locked = { version: "5.9.2", integrity: "sha512-fixture" };
    const baseline = { policyFindings: { productionImageDependencies: [{ name: "typescript", location, ...locked }] } };
    const classifyImage = (installed: { name: string; version: string }) => {
      const files: Record<string, string> = {
        "generated-package-lock.json": JSON.stringify({ packages: { "": { dependencies: { typescript: "5.9.2" } }, [location]: locked } }),
        "runtime-image-policy.json": JSON.stringify({ typescriptPresent: true, rubicSdkPresent: false }),
        "runtime-image-inventory.json": JSON.stringify({ schema: "dacs-runtime-image-inventory/v1", packages: [{ location, ...installed }] }),
      };
      const summary = passing();
      summary.docker.policy.typescriptPresent = true; summary.docker.policy.productionDependencyPolicyPassed = false;
      Object.assign(summary.securityGate, { productionImageDependencyPolicyPassed: false,
        findings: { ...summary.securityGate.findings, ...extractPolicyFindings((name: string) => files[name]) } });
      return classifyPolicyChecks(summary, baseline).productionImage;
    };
    it("accepts the locked typescript copy the baseline records", () => {
      expect(classifyImage({ name: "typescript", version: "5.9.2" })).toBe("baseline");
    });
    it("blocks another package installed at the baselined typescript location", () => {
      expect(classifyImage({ name: "extra-runtime-package", version: "1.0.0" })).toBe("blocked");
    });
  });

  it.each(["gitDependencies", "engine", "lockSbom", "physicalSbom"])("rejects missing %s evidence despite success flags", key => {
    const summary = passing(); Reflect.deleteProperty(summary.securityGate.findings, key);
    expect(registryContainerDisposition(summary).exitCode).toBe(3);
  });
  it("requires explicit completion", () => {
    const summary = passing(); Reflect.deleteProperty(summary, "complete");
    expect(registryContainerDisposition(summary).exitCode).toBe(1);
  });
  it.each(["engine", "lockSbom", "physicalSbom"] as const)("rejects contradictory %s evidence", key => {
    const summary = passing(); Object.assign(summary.securityGate.findings[key], { exitCode: 1, code: "fixture-error" });
    expect(registryContainerDisposition(summary).exitCode).toBe(3);
  });
  it("rejects an incomplete engine scan behind a successful exit code", () => {
    const summary = passing(); summary.securityGate.findings.engine.scanComplete = false;
    expect(registryContainerDisposition(summary).exitCode).toBe(3);
  });
  it.each([false, undefined])("rejects unexplained overall gate status %s", passed => {
    const summary = passing(); Object.assign(summary.securityGate, { passed });
    expect(registryContainerDisposition(summary).exitCode).toBe(3);
  });
  it.each(["GHSA-23hp-3jrh-7fpw", "GHSA-2222-3333-4444"])("requires directness before waiving %s", id => {
    const summary = passing(); summary.audit.observedAdvisories = [id];
    summary.audit.unlistedAdvisories = id.includes("2222") ? [id] : [];
    Reflect.deleteProperty(summary.audit, "directAdvisories"); summary.securityGate.auditExitCode = 1; summary.securityGate.passed = false;
    expect(registryContainerDisposition(summary, undefined, { unlistedAdvisories: "warn" }).exitCode).toBe(3);
  });
  it.each([undefined, "other/v1"])("rejects drift evidence with schema %s", schema => {
    expect(registryAuditDriftDisposition({ schema, complete: false, audit: { observedAdvisories: [], unlistedAdvisories: [] } }).exitCode).toBe(3);
  });
  it.each(["", " ", "bad", "-1", "256", "1.5"])("does not decode invalid exit evidence %j as success", text => {
    expect(extractPolicyFindings((name: string) => name.endsWith(".exit-code") ? text : undefined).engine.exitCode).toBeNull();
  });
  it("extracts each policy finding from evidence and exercises the CLI", () => {
    const files: Record<string, string> = {
      "generated-package-lock.json": JSON.stringify({ packages: { "": {}, "node_modules/a": { version: "1.0.0", integrity: "sha512-fixture", engines: { node: ">=22" } } } }),
      "dependency-policy.json": JSON.stringify({ violations: [{ location: "node_modules/a", field: "dependencies.b", value: "file:b" }] }),
      "engine-versions.json": JSON.stringify({ node: "20.19.1", npm: "11.19.0" }),
      "engine-strict.log": "npm error code EBADENGINE\nnpm error Not compatible with your version of node/npm: a@1.0.0\n",
      "engine-strict.exit-code": "1\n", "consumer-lock-sbom.exit-code": "1\n", "consumer-physical-sbom.exit-code": "1\n",
      "consumer-lock-sbom.err": "npm error code ESBOMPROBLEMS\nnpm error invalid: a@1.0.0, 2 required by fixture@1\n",
      "consumer-physical-sbom.err": "npm error code ESBOMPROBLEMS\nnpm error missing: b@1, required by fixture@1\n",
      "runtime-image-policy.json": JSON.stringify({ typescriptPresent: false, rubicSdkPresent: false }),
      "runtime-image-inventory.json": JSON.stringify({ schema: "dacs-runtime-image-inventory/v1", packages: [{ location: "node_modules/a", name: "a", version: "2.0.0" }] }),
    };
    const extracted = extractPolicyFindings((name: string) => files[name]);
    expect(extracted).toMatchObject({ gitDependencies: [{ location: "node_modules/a", field: "dependencies.b", value: "file:b", version: "1.0.0" }],
      engine: { exitCode: 1, code: "EBADENGINE", scanComplete: true, violations: [{ package: "a@1.0.0" }] },
      lockSbom: { exitCode: 1, code: "ESBOMPROBLEMS", problems: ["invalid: a@1.0.0, 2 required by fixture@1"] },
      physicalSbom: { problems: ["missing: b@1, required by fixture@1"] }, productionImageDependencies: [{ name: "a", version: "2.0.0" }] });
    const root = mkdtempSync(join(tmpdir(), "dacs-evidence-")); roots.push(root); mkdirSync(join(root, "input"));
    for (const [name, value] of Object.entries(files)) writeFileSync(join(root, "input", name), value);
    const result = spawnSync(process.execPath, ["scripts/registry-container-disposition.mjs", "--policy-findings", join(root, "input"), join(root, "output.json")], { cwd: repoRoot, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(root, "output.json"), "utf8"))).toEqual(extracted);
    const missing = extractPolicyFindings(() => undefined);
    expect(missing.engine).toMatchObject({ exitCode: null, scanComplete: false });
    expect(missing.productionImageInventory.scanComplete).toBe(false);
  });
});
