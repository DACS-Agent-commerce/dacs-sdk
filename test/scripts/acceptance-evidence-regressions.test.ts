import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
const modulePath = "../../scripts/registry-container-disposition.mjs";
const { classifyPolicyChecks, extractPolicyFindings, POLICY_SOURCES, registryAuditDriftDisposition, registryAuditPolicy,
  registryContainerDisposition, RELEASE_VERSION, unlistedPolicyFindings } = await import(modulePath);
const repoRoot = resolve(import.meta.dirname, "../..");
const baseline = JSON.parse(readFileSync(join(repoRoot, "scripts/registry-container-audit-baseline.json"), "utf8"));
const roots: string[] = [];
const scratch = () => { const root = mkdtempSync(join(tmpdir(), "dacs-evidence-")); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const cli = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath,
  ["scripts/registry-container-disposition.mjs", ...args], { cwd: repoRoot, encoding: "utf8", env: { ...process.env, ...env } });
type Gate = { auditExitCode: number; findings: Record<string, unknown> } & Record<string, unknown>;
const passing = () => ({
  schema: "dacs-registry-container-acceptance/v1", complete: true, packageVersion: RELEASE_VERSION,
  generatedTestsPassed: true, functionalPassed: true, docker: { policy: { schema: "dacs-runtime-image-policy/v1" } as Record<string, unknown> },
  audit: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0, observedAdvisories: [] as string[], unlistedAdvisories: [] as string[], directAdvisories: [] as string[] },
  securityGate: { auditExitCode: 0, findings: { schema: "dacs-registry-policy-findings/v1", gitDependencies: [], productionImageDependencies: [],
    productionImageInventory: { scanComplete: true, errors: [], missing: [] },
    engine: { exitCode: 0, code: null, scanComplete: true, violations: [] },
    lockSbom: { exitCode: 0, code: null, problems: [] }, physicalSbom: { exitCode: 0, code: null, problems: [] } } } as Gate,
});
const withFindings = (findings: Record<string, unknown>) => {
  const summary = passing();
  summary.securityGate.findings = { ...summary.securityGate.findings, ...findings };
  return summary;
};

// Every closed source of a run whose policy gates all pass.
const passingSources = (): Record<string, string> => ({
  "generated-package-lock.json": JSON.stringify({ packages: { "": { dependencies: { a: "1.0.0" } },
    "node_modules/a": { version: "1.0.0", integrity: "sha512-fixture" } } }),
  "dependency-policy.json": JSON.stringify({ schema: "dacs-registry-dependency-policy/v1", passed: true, violations: [] }),
  "engine-versions.json": JSON.stringify({ node: "20.19.1", npm: "11.19.0" }),
  "engine-strict.log": "", "engine-strict.exit-code": "0\n",
  "consumer-lock-sbom.err": "", "consumer-lock-sbom.exit-code": "0\n",
  "consumer-physical-sbom.err": "", "consumer-physical-sbom.exit-code": "0\n",
  "runtime-image-policy.json": JSON.stringify({ schema: "dacs-runtime-image-policy/v1" }),
  "runtime-image-inventory.json": JSON.stringify({ schema: "dacs-runtime-image-inventory/v1",
    packages: [{ location: "node_modules/a", name: "a", version: "1.0.0" }] }),
});
const extracted = (files: Record<string, string>) => extractPolicyFindings((name: string) => files[name]);
const gateSources: Record<string, string[]> = {
  registryDependency: ["generated-package-lock.json", "dependency-policy.json"],
  productionImage: ["generated-package-lock.json", "runtime-image-policy.json", "runtime-image-inventory.json"],
  engineStrict: ["generated-package-lock.json", "engine-versions.json", "engine-strict.log", "engine-strict.exit-code"],
  lockSbom: ["consumer-lock-sbom.err", "consumer-lock-sbom.exit-code"],
  physicalSbom: ["consumer-physical-sbom.err", "consumer-physical-sbom.exit-code"],
};

describe("closed acceptance sources", () => {
  it("reads exactly the closed list of sources and passes them when complete", () => {
    expect([...POLICY_SOURCES].sort()).toEqual(Object.keys(passingSources()).sort());
    expect(registryContainerDisposition(withFindings(extracted(passingSources())))).toMatchObject({ exitCode: 0 });
  });

  it.each(Object.keys(passingSources()))("blocks every gate %s feeds when it is missing, never reading it as empty", name => {
    const files = passingSources();
    delete files[name];
    const findings = extracted(files);
    const checks = classifyPolicyChecks(withFindings(findings), baseline);
    for (const [gate, sources] of Object.entries(gateSources)) {
      expect(checks[gate], gate).toBe(sources.includes(name) ? "blocked" : "passed");
    }
    expect(JSON.stringify(findings)).toContain(JSON.stringify(name));
    const result = registryContainerDisposition(withFindings(findings));
    expect(result.exitCode).toBe(3);
    expect(result.message).toContain(`incomplete evidence: ${name}`);
  });

  it.each(Object.keys(passingSources()).filter(name => name.endsWith(".json") || name.endsWith(".exit-code")))(
    "blocks the gates %s feeds when it cannot be read", name => {
      const files = { ...passingSources(), [name]: "{" };
      expect(registryContainerDisposition(withFindings(extracted(files))).exitCode).toBe(3);
    });

  it.each([
    { schema: "wrong", passed: false, violations: [] },
    { schema: "dacs-registry-dependency-policy/v1", passed: false, violations: [] },
    { schema: "dacs-registry-dependency-policy/v1", passed: true, violations: [{ location: "node_modules/a" }] },
    { schema: "dacs-registry-dependency-policy/v1", violations: [] },
  ])("refuses a dependency policy outside its schema %j", report => {
    const findings = extracted({ ...passingSources(), "dependency-policy.json": JSON.stringify(report) });
    expect(findings.gitDependencies).toEqual({ incomplete: ["dependency-policy.json"] });
    expect(classifyPolicyChecks(withFindings(findings), baseline).registryDependency).toBe("blocked");
  });

  it("blocks the audit gate when the summary records no audit evidence", () => {
    const summary = passing();
    Reflect.deleteProperty(summary, "audit");
    expect(registryContainerDisposition(summary)).toMatchObject({ exitCode: 3, checks: { audit: "blocked" } });
  });

  it.each([
    {},
    { packages: {} },
    { packages: [] },
    { packages: { "": null, "node_modules/a": { version: "1.0.0" } } },
    { packages: { "node_modules/a": { version: "1.0.0" } } },
  ])("blocks every gate the generated lock feeds when it lacks a packages map or root entry %j", lock => {
    const findings = extracted({ ...passingSources(), "generated-package-lock.json": JSON.stringify(lock) });
    for (const key of ["gitDependencies", "engine", "productionImageDependencies", "productionImageInventory"]) {
      expect(findings[key], key).toEqual({ incomplete: ["generated-package-lock.json"] });
    }
    const checks = classifyPolicyChecks(withFindings(findings), baseline);
    for (const [gate, sources] of Object.entries(gateSources)) {
      expect(checks[gate], gate).toBe(sources.includes("generated-package-lock.json") ? "blocked" : "passed");
    }
  });

  it.each(["", " ", "bad", "-1", "256", "1.5"])("does not decode invalid exit evidence %j as success", text => {
    const findings = extracted({ ...passingSources(), "engine-strict.exit-code": text });
    expect(findings.engine).toEqual({ incomplete: ["engine-strict.exit-code"] });
  });

  it("extracts each policy finding from evidence and exercises the CLI", () => {
    const files: Record<string, string> = {
      ...passingSources(),
      "generated-package-lock.json": JSON.stringify({ packages: { "": {}, "node_modules/a": { version: "1.0.0", integrity: "sha512-fixture", engines: { node: ">=22" } } } }),
      "dependency-policy.json": JSON.stringify({ schema: "dacs-registry-dependency-policy/v1", passed: false,
        violations: [{ location: "node_modules/a", field: "dependencies.b", value: "file:b" }] }),
      "engine-strict.log": "npm error code EBADENGINE\nnpm error Not compatible with your version of node/npm: a@1.0.0\n",
      "engine-strict.exit-code": "1\n", "consumer-lock-sbom.exit-code": "1\n", "consumer-physical-sbom.exit-code": "1\n",
      "consumer-lock-sbom.err": "npm error code ESBOMPROBLEMS\nnpm error invalid: a@1.0.0, 2 required by fixture@1\n",
      "consumer-physical-sbom.err": "npm error code ESBOMPROBLEMS\nnpm error missing: b@1, required by fixture@1\n",
      "runtime-image-inventory.json": JSON.stringify({ schema: "dacs-runtime-image-inventory/v1", packages: [{ location: "node_modules/a", name: "a", version: "2.0.0" }] }),
    };
    const findings = extracted(files);
    expect(findings).toMatchObject({ gitDependencies: [{ location: "node_modules/a", field: "dependencies.b", value: "file:b", version: "1.0.0" }],
      engine: { exitCode: 1, code: "EBADENGINE", scanComplete: true, violations: [{ package: "a@1.0.0" }] },
      lockSbom: { exitCode: 1, code: "ESBOMPROBLEMS", problems: ["invalid: a@1.0.0, 2 required by fixture@1"] },
      physicalSbom: { problems: ["missing: b@1, required by fixture@1"] }, productionImageDependencies: [{ name: "a", version: "2.0.0" }] });
    const root = scratch();
    mkdirSync(join(root, "input"));
    for (const [name, value] of Object.entries(files)) writeFileSync(join(root, "input", name), value);
    const result = cli(["--policy-findings", join(root, "input"), join(root, "output.json")]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(root, "output.json"), "utf8"))).toEqual(findings);
  });
});

describe("complete acceptance evidence regressions", () => {
  it.each([
    ["typescriptPresent", true], ["rubicSdkPresent", true], ["productionDependencyPolicyPassed", false],
  ])("ignores a composer image flag %s that contradicts the inventory", (field, value) => {
    const summary = passing();
    summary.docker.policy = { ...summary.docker.policy, [field]: value };
    expect(registryContainerDisposition(summary).exitCode).toBe(0);
  });

  it.each([false, true, undefined])("ignores the composer's overall gate status %s", passed => {
    const clean = passing();
    Object.assign(clean.securityGate, { passed, registryDependencyPolicyPassed: passed, engineStrictExitCode: 9 });
    expect(registryContainerDisposition(clean).exitCode).toBe(0);
    const violating = withFindings({ gitDependencies: [{ location: "node_modules/a", field: "dependencies.b", value: "file:b" }] });
    Object.assign(violating.securityGate, { passed, registryDependencyPolicyPassed: passed });
    expect(registryContainerDisposition(violating)).toMatchObject({ exitCode: 3, checks: { registryDependency: "blocked" } });
  });

  it.each(["typescript", "rubic-sdk"])("retains prohibited image package %s wherever the inventory holds it", name => {
    for (const nested of [false, true]) for (const installedName of [name, "other-package"]) {
      const location = nested ? `node_modules/parent/node_modules/${name}` : `node_modules/${name}`;
      const item = { name: installedName, location, version: "1.0.0" };
      const parent = { name: "parent", location: "node_modules/parent", version: "1.0.0" };
      const files = { ...passingSources(),
        "generated-package-lock.json": JSON.stringify({ packages: {
          "": { dependencies: { [nested ? "parent" : name]: "1.0.0" } },
          ...(nested ? { [parent.location]: { ...parent, dependencies: { [name]: "1.0.0" } } } : {}),
          [location]: { name: installedName, version: "1.0.0", integrity: "sha512-fixture" },
        } }),
        "runtime-image-inventory.json": JSON.stringify({ schema: "dacs-runtime-image-inventory/v1", packages: nested ? [parent, item] : [item] }),
      };
      const { productionImageDependencies, productionImageInventory } = extracted(files);
      expect(productionImageInventory).toMatchObject({ scanComplete: true, missing: [], errors: [] });
      expect(productionImageDependencies).toEqual([{ ...item, integrity: "sha512-fixture" }]);
      expect(registryContainerDisposition(withFindings({ productionImageDependencies, productionImageInventory })))
        .toMatchObject({ exitCode: 3, checks: { productionImage: "blocked" } });
    }
  });

  it.each([
    ["an incomplete scan", { scanComplete: false, errors: [], missing: [] }],
    ["an inventory error", { scanComplete: true, errors: ["unreadable runtime-image inventory entry: {}"], missing: [] }],
    ["a missing required package", { scanComplete: true, errors: [], missing: ["node_modules/a"] }],
  ])("blocks the image gate on %s", (_label, productionImageInventory) => {
    expect(registryContainerDisposition(withFindings({ productionImageInventory })))
      .toMatchObject({ exitCode: 3, checks: { productionImage: "blocked" } });
  });

  describe("baseline match of a prohibited image package", () => {
    const location = "node_modules/typescript";
    const locked = { version: "5.9.2", integrity: "sha512-fixture" };
    const known = { policyFindings: { productionImageDependencies: [{ name: "typescript", location, ...locked }] } };
    const classifyImage = (installed: { name: string; version: string }) => {
      const files = { ...passingSources(),
        "generated-package-lock.json": JSON.stringify({ packages: { "": { dependencies: { typescript: "5.9.2" } }, [location]: locked } }),
        "runtime-image-inventory.json": JSON.stringify({ schema: "dacs-runtime-image-inventory/v1", packages: [{ location, ...installed }] }),
      };
      return classifyPolicyChecks(withFindings(extracted(files)), known).productionImage;
    };
    it("accepts the locked typescript copy the baseline records", () => {
      expect(classifyImage({ name: "typescript", version: "5.9.2" })).toBe("baseline");
    });
    it("blocks another package installed at the baselined typescript location", () => {
      expect(classifyImage({ name: "extra-runtime-package", version: "1.0.0" })).toBe("blocked");
    });
  });

  it.each(["gitDependencies", "engine", "lockSbom", "physicalSbom", "productionImageDependencies", "productionImageInventory"])(
    "rejects missing %s findings", key => {
      const summary = passing();
      Reflect.deleteProperty(summary.securityGate.findings, key);
      expect(registryContainerDisposition(summary).exitCode).toBe(3);
    });

  it("requires explicit completion", () => {
    const summary = passing(); Reflect.deleteProperty(summary, "complete");
    expect(registryContainerDisposition(summary).exitCode).toBe(1);
  });

  it.each(["engine", "lockSbom", "physicalSbom"])("rejects contradictory %s evidence", key => {
    const contradictory = { exitCode: 1, code: "fixture-error", scanComplete: true, violations: [], problems: [] };
    expect(registryContainerDisposition(withFindings({ [key]: contradictory })).exitCode).toBe(3);
  });

  it.each([["lockSbom", "lockSbom"], ["physicalSbom", "physicalSbom"]])(
    "blocks %s exit 1 that lists no problem", (key, gate) => {
      const sbom = { exitCode: 1, code: "ESBOMPROBLEMS", problems: [] };
      expect(classifyPolicyChecks(withFindings({ [key]: sbom }), baseline)[gate]).toBe("blocked");
    });

  describe("SBOM stderr extraction", () => {
    const sbomSources = [["lockSbom", "consumer-lock-sbom", "lockSbomProblems"],
      ["physicalSbom", "consumer-physical-sbom", "physicalSbomProblems"]] as const;
    const failed = (name: string, lines: string[]) => ({ ...passingSources(), [`${name}.exit-code`]: "1\n",
      [`${name}.err`]: ["npm error code ESBOMPROBLEMS", ...lines.map(line => `npm error ${line}`), ""].join("\n") });
    const logTail = ["", "A complete log of this run can be found in: /root/.npm/_logs/run-debug-0.log"];

    it.each(sbomSources)("keeps the baseline %s problems behind the usual npm framing lines", (gate, name, knownKey) => {
      const lines = [...baseline.policyFindings[knownKey], ...logTail];
      const findings = extracted(failed(name, lines));
      expect(findings[gate].problems).toEqual(baseline.policyFindings[knownKey]);
      expect(classifyPolicyChecks(withFindings(findings), baseline)[gate]).toBe("baseline");
    });

    it.each(sbomSources)("blocks %s when a line outside the problem grammar accompanies baseline problems", (gate, name, knownKey) => {
      const findings = extracted(failed(name, [...baseline.policyFindings[knownKey], "conflict: new-package@1", ...logTail]));
      expect(findings[gate].problems).toContain("conflict: new-package@1");
      expect(classifyPolicyChecks(withFindings(findings), baseline)[gate]).toBe("blocked");
      expect(unlistedPolicyFindings(withFindings(findings), baseline, [gate])[gate]).toEqual(["conflict: new-package@1"]);
    });

    it.each(sbomSources)("blocks %s when only unrecognised lines follow the error code", (gate, name) => {
      const findings = extracted(failed(name, ["some unrecognised problem line"]));
      expect(classifyPolicyChecks(withFindings(findings), baseline)[gate]).toBe("blocked");
    });

    it.each(sbomSources)("blocks %s when the log names the error code but lists nothing", (gate, name) => {
      const findings = extracted(failed(name, logTail));
      expect(findings[gate]).toMatchObject({ exitCode: 1, code: "ESBOMPROBLEMS", problems: [] });
      expect(classifyPolicyChecks(withFindings(findings), baseline)[gate]).toBe("blocked");
    });

    it.each(sbomSources)("blocks %s when a second error code follows the first", (gate, name, knownKey) => {
      const findings = extracted(failed(name, [...baseline.policyFindings[knownKey], "code ENOTFOUND"]));
      expect(classifyPolicyChecks(withFindings(findings), baseline)[gate]).toBe("blocked");
    });
  });

  describe("engine log extraction", () => {
    const reportA = "npm error Not compatible with your version of node/npm: a@1.0.0\n";
    const engineLog = (log: string) => ({ ...passingSources(),
      "generated-package-lock.json": JSON.stringify({ packages: { "": {},
        "node_modules/a": { version: "1.0.0", integrity: "sha512-fixture", engines: { node: ">=22" } },
        "node_modules/b": { version: "2.0.0", integrity: "sha512-fixture", engines: { node: ">=22" } } } }),
      "engine-strict.log": log, "engine-strict.exit-code": "1\n" });
    // Classifies against a baseline that lists every violation the lock scan finds.
    const classifyLog = (log: string) => {
      const findings = extracted(engineLog(log));
      const known = { policyFindings: { engineViolations: findings.engine.violations } };
      return { findings, state: classifyPolicyChecks(withFindings(findings), known).engineStrict };
    };

    it("accepts one EBADENGINE report naming a listed violation", () => {
      expect(classifyLog(`npm error code EBADENGINE\n${reportA}`).state).toBe("baseline");
    });

    it.each([
      ["a network error after it", `npm error code EBADENGINE\n${reportA}npm error code ENOTFOUND\n`],
      ["a network error before it", `npm error code ENOTFOUND\nnpm error code EBADENGINE\n${reportA}`],
      ["the same code twice", `npm error code EBADENGINE\n${reportA}npm error code EBADENGINE\n`],
    ])("blocks an EBADENGINE report with %s and keeps every code", (_label, log) => {
      const { findings, state } = classifyLog(log);
      expect(state).toBe("blocked");
      expect(findings.engine.code).not.toBe("EBADENGINE");
      expect(findings.engine.code).toContain("EBADENGINE");
    });

    it("keeps the network code of a log that never reports the engine", () => {
      expect(classifyLog("npm error code ENOTFOUND\n").findings.engine).toMatchObject({ code: "ENOTFOUND" });
    });

    it("blocks a log that reports two incompatible packages, as npm stops at the first", () => {
      const log = `npm error code EBADENGINE\n${reportA}npm error Not compatible with your version of node/npm: b@2.0.0\n`;
      const { findings, state } = classifyLog(log);
      expect(findings.engine.violations).toHaveLength(2);
      expect(state).toBe("blocked");
    });

    // npm 11 names the package on its `engine` and its `notsup` line for one error.
    it("reads one EBADENGINE error naming its package on both engine and notsup lines as that package", () => {
      const log = "npm error code EBADENGINE\nnpm error engine Unsupported engine\n" +
        "npm error engine Not compatible with your version of node/npm: a@1.0.0\n" +
        "npm error notsup Not compatible with your version of node/npm: a@1.0.0\n";
      const { findings, state } = classifyLog(log);
      expect(findings.engine).toMatchObject({ code: "EBADENGINE", reportedPackage: "a@1.0.0" });
      expect(state).toBe("baseline");
    });
  });

  it("rejects an incomplete engine scan behind a successful exit code", () => {
    expect(registryContainerDisposition(withFindings({ engine: { exitCode: 0, code: null, scanComplete: false, violations: [] } })).exitCode).toBe(3);
  });

  it.each([undefined, "other/v1"])("rejects drift evidence with schema %s", schema => {
    expect(registryAuditDriftDisposition({ schema, complete: false, audit: { observedAdvisories: [], unlistedAdvisories: [] } }).exitCode).toBe(3);
  });
});

describe("pinned baseline identities", () => {
  const known = baseline.policyFindings;
  const classify = (findings: Record<string, unknown>) => registryContainerDisposition(withFindings(findings), baseline);
  const git = known.gitDependencies[0];
  const engine = known.engineViolations[0];
  const image = known.productionImageDependencies.find((item: { name: string }) => item.name === "pqcrypto");
  const engineFinding = (violation: Record<string, unknown>) => ({ engine: { exitCode: 1, code: "EBADENGINE", scanComplete: true,
    violations: [violation], reportedPackage: violation.package } });

  it("waives each recorded identity exactly as recorded", () => {
    expect(classify({ gitDependencies: [git] }).exitCode).toBe(4);
    expect(classify(engineFinding(engine)).exitCode).toBe(4);
    expect(classify({ productionImageDependencies: [image] }).exitCode).toBe(4);
  });

  it.each(["location", "field", "value", "version", "integrity"])("blocks a Git finding with another %s", key => {
    expect(classify({ gitDependencies: [{ ...git, [key]: "changed" }] })).toMatchObject({ exitCode: 3, checks: { registryDependency: "blocked" } });
  });

  it.each(["package", "location", "integrity", "required"])("blocks an engine finding with another %s", key => {
    expect(classify(engineFinding({ ...engine, [key]: key === "required" ? { node: ">=99" } : "changed" })))
      .toMatchObject({ exitCode: 3, checks: { engineStrict: "blocked" } });
  });

  it.each(["name", "location", "version", "integrity"])("blocks an image finding with another %s", key => {
    expect(classify({ productionImageDependencies: [{ ...image, [key]: key === "version" ? "1.0.1" : "changed" }] }))
      .toMatchObject({ exitCode: 3, checks: { productionImage: "blocked" } });
  });
});

describe("unlisted advisory policy", () => {
  const baselineId: string = baseline.advisoryIds[0];
  const unlistedId = "GHSA-2222-3333-4444";
  const withAudit = (observed: string[], direct: string[] = []) => {
    const summary = passing();
    Object.assign(summary.audit, { high: observed.length, total: observed.length, observedAdvisories: observed,
      unlistedAdvisories: observed.filter(id => id === unlistedId), directAdvisories: direct });
    summary.securityGate.auditExitCode = observed.length ? 1 : 0;
    return summary;
  };

  it("warns on an unlisted transitive ID under warn and blocks it under fail", () => {
    expect(registryContainerDisposition(withAudit([unlistedId]), undefined, { unlistedAdvisories: "warn" }))
      .toMatchObject({ exitCode: 4, checks: { audit: "unlisted" }, unlistedAdvisories: [unlistedId] });
    expect(registryContainerDisposition(withAudit([unlistedId]))).toMatchObject({ exitCode: 3, checks: { audit: "blocked" } });
  });

  it.each(["warn", "fail"])("blocks a direct high/critical ID under %s whether unlisted, baselined or assessed", policy => {
    const assessed = { ...baseline, advisoryIds: baseline.advisoryIds.filter((id: string) => id !== baselineId),
      assessedAdvisories: [{ id: baselineId, assessment: "SECURITY.md#audit-policy" }] };
    for (const [summary, known] of [[withAudit([unlistedId], [unlistedId]), baseline], [withAudit([baselineId], [baselineId]), baseline],
      [withAudit([baselineId], [baselineId]), assessed]] as const) {
      expect(registryContainerDisposition(summary, known, { unlistedAdvisories: policy }))
        .toMatchObject({ exitCode: 3, checks: { audit: "blocked" } });
    }
  });

  it("throws for an unknown policy", () => {
    expect(() => registryContainerDisposition(passing(), undefined, { unlistedAdvisories: "ignore" }))
      .toThrow('unknown unlisted-advisory policy "ignore"');
  });

  it("warns and writes a step-summary line for DACS_UNLISTED_ADVISORIES=warn, and annotates a blocked run", () => {
    const root = scratch(), path = join(root, "summary.json"), stepSummary = join(root, "step-summary.md");
    writeFileSync(path, JSON.stringify(withAudit([unlistedId])));
    writeFileSync(stepSummary, "");
    const warned = cli([path], { DACS_UNLISTED_ADVISORIES: "warn", GITHUB_STEP_SUMMARY: stepSummary });
    expect(warned.status).toBe(4);
    expect(warned.stdout).toContain(`::warning title=Advisory IDs outside the #191 baseline::${unlistedId}. Pull requests only warn`);
    expect(readFileSync(stepSummary, "utf8")).toContain(`fail on them): ${unlistedId}\n`);
    const blocked = cli([path], { DACS_UNLISTED_ADVISORIES: "", GITHUB_STEP_SUMMARY: stepSummary });
    expect(blocked.status).toBe(3);
    expect(blocked.stdout).toContain("::error title=Registry/container acceptance policy failure::");
    expect(blocked.stderr).toContain(`advisory IDs not in the #191 baseline: ${unlistedId}`);
  });
});

describe("captured nested-only advisory", () => {
  const fixture = (name: string) => {
    const read = (file: string) => JSON.parse(readFileSync(join(repoRoot, "test/scripts/fixtures/npm-audit-nested-advisory", name, file), "utf8"));
    const policy = registryAuditPolicy(read("npm-audit.json"), read("package-lock.json"), baseline);
    const summary = passing();
    summary.audit = { ...policy.observed, observedAdvisories: policy.observedAdvisories,
      unlistedAdvisories: policy.unlistedAdvisories, directAdvisories: policy.directAdvisories };
    summary.securityGate.auditExitCode = 1;
    return summary;
  };

  it("is baseline-only (exit 4) when the high advisory is on the nested copy alone", () => {
    expect(registryContainerDisposition(fixture("nested-only"))).toMatchObject({ exitCode: 4, checks: { audit: "baseline" },
      directAdvisories: [] });
  });

  it.each(["warn", "fail"])("blocks under %s when the high advisory covers the direct version", policy => {
    expect(registryContainerDisposition(fixture("direct-affected"), undefined, { unlistedAdvisories: policy }))
      .toMatchObject({ exitCode: 3, checks: { audit: "blocked" } });
  });
});
