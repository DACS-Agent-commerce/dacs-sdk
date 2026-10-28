import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const modulePath = "../../scripts/registry-container-disposition.mjs";
const { POLICY_SOURCES, extractPolicyFindings, registryContainerDisposition, unlistedPolicyFindings } = await import(modulePath);
const repoRoot = resolve(import.meta.dirname, "../..");
const fixtureRoot = join(repoRoot, "test/scripts/fixtures/registry-container-b7b180f");
const baseline = JSON.parse(readFileSync(join(repoRoot, "scripts/registry-container-audit-baseline.json"), "utf8"));

// The historical run has no observed inventory. Every present source must read
// successfully at setup; a scenario removes evidence explicitly with undefined.
const sourceFiles = {
  "generated-package-lock.json": "generated-package-lock.json",
  "dependency-policy.json": "dependency-policy.json",
  "runtime-image-policy.json": "runtime-image-policy.json",
  "runtime-image-inventory.json": undefined,
  "engine-versions.json": "engine-versions.json",
  "engine-strict.log": "engine-strict.log.txt",
  "engine-strict.exit-code": "engine-strict.exit-code",
  "consumer-lock-sbom.err": "consumer-lock-sbom.err",
  "consumer-lock-sbom.exit-code": "consumer-lock-sbom.exit-code",
  "consumer-physical-sbom.err": "consumer-physical-sbom.err",
  "consumer-physical-sbom.exit-code": "consumer-physical-sbom.exit-code",
} as const;
type Sources = Record<keyof typeof sourceFiles, string | undefined>;
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const recordedSources: Sources = freeze(Object.fromEntries(Object.entries(sourceFiles).map(([logical, physical]) =>
  [logical, physical === undefined ? undefined : readFileSync(join(fixtureRoot, physical), "utf8")])) as Sources);
const summaryBytes = readFileSync(join(fixtureRoot, "acceptance-summary.json"), "utf8");
const recordedSummary = freeze(JSON.parse(summaryBytes));
const provenance = JSON.parse(readFileSync(join(fixtureRoot, "provenance.json"), "utf8"));

// Explicit synthetic observation, independent of every scenario's lock. These
// versions model the selected closure with optional packages omitted, not a run.
type ImageEntry = { name: string; version: string; location: string };
const simulatedInventory = freeze({ schema: "dacs-runtime-image-inventory/v1", packages: ([
  ["@npmcli/agent", "5.0.2"], ["@npmcli/fs", "6.0.0"], ["@npmcli/redact", "5.0.0"],
  ["@sigstore/bundle", "5.0.0"], ["@sigstore/core", "4.0.1"], ["@sigstore/sign", "5.0.0"],
  ["@sigstore/tuf", "5.0.0"], ["@sigstore/verify", "4.1.2"], ["@tufjs/models", "5.0.0"],
  ["cacache", "21.0.1"], ["make-fetch-happen", "16.0.1"], ["minipass", "7.1.3"],
  ["minipass-fetch", "6.0.0"], ["proc-log", "7.0.0"], ["semver", "7.8.5"],
  ["sigstore", "5.0.0"], ["ssri", "14.0.0"], ["tuf-js", "6.0.0"], ["typescript", "5.9.2"],
] as const).map(([name, version]): ImageEntry => ({ name, version, location: `node_modules/${name}` })) });
function projection(overrides: Partial<Sources> = {}) {
  const sources: Sources = { ...recordedSources, ...overrides };
  const summary = structuredClone(recordedSummary);
  summary.complete = true; // Explicit current-contract projection of a legacy run.
  summary.securityGate.findings = extractPolicyFindings((name: keyof Sources) => sources[name]);
  return summary;
}
function simulation(overrides: Partial<Sources> = {}) {
  const summary = projection({ "runtime-image-inventory.json": JSON.stringify(simulatedInventory), ...overrides });
  summary.audit.directAdvisories = []; // Explicit synthetic transitive-only assumption.
  return summary;
}
const disposition = (summary: unknown, rules = baseline) =>
  registryContainerDisposition(summary, rules, { packageVersion: "0.1.0-alpha.0" });
const agent = "node_modules/@npmcli/agent";
const arbundles = "node_modules/@bundlr-network/client/node_modules/arbundles";
const typescript = "node_modules/typescript";
type LockEntry = { version?: string; integrity?: string; dev?: boolean; optional?: boolean;
  engines?: { node?: string; npm?: string }; dependencies?: Record<string, string> };
function withLock(edit: (packages: Record<string, LockEntry>) => void) {
  const value = JSON.parse(recordedSources["generated-package-lock.json"] ?? "");
  edit(value.packages);
  return JSON.stringify(value);
}
function editEntry(location: string, change: Partial<LockEntry>) {
  return withLock(packages => {
    if (!packages[location]) throw new Error(`Selected lock lacks ${location}`);
    Object.assign(packages[location], change);
  });
}
function withInventory(edit: (packages: typeof simulatedInventory.packages) => void) {
  const value = structuredClone(simulatedInventory);
  edit(value.packages);
  return JSON.stringify(value);
}
const addImage = (name: string, version: string, location = `node_modules/${name}`) =>
  withInventory(packages => { packages.push({ name, version, location }); });
function imageVersion(version: string) {
  return withInventory(packages => {
    const entry = packages.find(item => item.location === typescript);
    if (!entry) throw new Error("Synthetic image lacks TypeScript");
    entry.version = version;
  });
}
function blocked(summary: ReturnType<typeof simulation>, gate: string, rules = baseline) {
  const result = disposition(summary, rules);
  expect(result).toMatchObject({ exitCode: 3, failureClass: "policy", checks: { [gate]: "blocked" } });
  return unlistedPolicyFindings(summary, rules, [gate])[gate];
}

describe("original container evidence and explicit simulations", () => {
  it("refuses the untouched legacy summary, projects exit 3, and simulates only exit 4", () => {
    expect(Object.keys(sourceFiles).sort()).toEqual([...POLICY_SOURCES].sort());
    expect(disposition(structuredClone(recordedSummary))).toMatchObject({ exitCode: 1, failureClass: "functional" });
    const current = projection();
    expect(current.securityGate.findings.productionImageInventory).toEqual({ incomplete: ["runtime-image-inventory.json"] });
    expect(current.audit.directAdvisories).toBeUndefined();
    expect(disposition(current)).toMatchObject({ exitCode: 3, checks: { productionImage: "blocked", audit: "blocked" } });
    expect(disposition(current).message).toContain("no valid direct-advisory evidence");
    expect(disposition(simulation())).toMatchObject({ exitCode: 4, checks: {
      registryDependency: "baseline", productionImage: "baseline", engineStrict: "baseline",
      lockSbom: "baseline", physicalSbom: "baseline", audit: "baseline" } });
    expect(disposition(simulation()).message).toContain("production publication remains blocked");
    expect(registryContainerDisposition(simulation(), baseline, { packageVersion: "0.1.1" }).exitCode).toBe(1);
  });

  it("keeps original bytes and summary unchanged across independent repeated scenarios", () => {
    const before = JSON.stringify([recordedSources, recordedSummary, simulatedInventory]);
    const changed = simulation();
    changed.audit.observedAdvisories = [];
    changed.securityGate.findings.engine.violations.length = 0;
    changed.docker.policy.typescriptPresent = false;
    for (let i = 0; i < 2; i++) expect(disposition(simulation()).exitCode).toBe(4);
    expect(JSON.stringify([recordedSources, recordedSummary, simulatedInventory])).toBe(before);
    expect(JSON.stringify(recordedSummary)).toBe(JSON.stringify(JSON.parse(summaryBytes)));
    expect(provenance.source).toMatchObject({ commit: baseline.policyFindings.source.commit, run: baseline.policyFindings.source.run });
    expect(baseline.policyFindings.source.evidence).toBe(`artifact ${provenance.source.artifact}`);
    const physicalBytes: Record<string, string | undefined> = { "acceptance-summary.json": summaryBytes, ...Object.fromEntries(
      Object.entries(sourceFiles).filter(([, physical]) => physical !== undefined)
        .map(([logical, physical]) => [physical, recordedSources[logical as keyof Sources]])) };
    expect(Object.keys(provenance.sha256).sort()).toEqual(Object.keys(physicalBytes).sort());
    for (const [name, bytes] of Object.entries(physicalBytes)) {
      if (bytes === undefined) throw new Error(`Missing present fixture ${name}`);
      expect(createHash("sha256").update(bytes).digest("hex"), name).toBe(provenance.sha256[name]);
    }
  });

  it("accounts for the selected 22 locations, root, optional skips and 16 engine violations", () => {
    const lock = JSON.parse(recordedSources["generated-package-lock.json"] ?? "");
    expect(Object.keys(lock.packages).filter(location => location !== "")).toHaveLength(22);
    const rootDependencies = Object.keys(lock.packages[""].dependencies);
    expect(rootDependencies).toHaveLength(8);
    for (const name of rootDependencies) expect(lock.packages[`node_modules/${name}`]).toBeUndefined();
    const engine = projection().securityGate.findings.engine;
    expect(engine).toMatchObject({ scanComplete: true, scan: { node: "v20.19.1", npm: "11.19.0", evaluatedPackages: 20, errors: [] },
      reportedPackage: "@npmcli/agent@5.0.2" });
    expect(engine.violations).toEqual(baseline.policyFindings.engineViolations);
    expect(engine.violations).toHaveLength(16);
    expect(projection().securityGate.findings.gitDependencies).toEqual(baseline.policyFindings.gitDependencies);
    for (const [field, file] of [["lockSbom", "consumer-lock-sbom.err"], ["physicalSbom", "consumer-physical-sbom.err"]] as const) {
      const recordedProblems = (recordedSources[file] ?? "").split("\n").filter(line => /^npm error (missing|invalid):/.test(line))
        .map(line => line.slice("npm error ".length));
      expect(projection().securityGate.findings[field].problems).toEqual(recordedProblems);
    }
  });

  it.each(["registryDependency", "productionImage", "engineStrict", "lockSbom", "physicalSbom"])(
    "blocks %s when its baseline is removed", gate => {
      const summary = simulation();
      const findings = summary.securityGate.findings;
      const expected: Record<string, unknown> = { registryDependency: findings.gitDependencies,
        productionImage: findings.productionImageDependencies, engineStrict: findings.engine.violations,
        lockSbom: findings.lockSbom.problems, physicalSbom: findings.physicalSbom.problems };
      expect(blocked(summary, gate, { ...baseline, policyFindings: undefined })).toEqual(expected[gate]);
    });

  const strictLog = recordedSources["engine-strict.log"] ?? "";
  for (const [name, location, version, gate] of [
    ["agent", agent, "5.0.3", "engineStrict"], ["arbundles", arbundles, "0.6.24", "registryDependency"],
    ["TypeScript", typescript, "5.9.3", "productionImage"],
  ] as const) {
    it.each(["version", "integrity", "both"])(`blocks ${name} identity change: %s`, field => {
      const change = { ...(field !== "integrity" ? { version } : {}), ...(field !== "version" ? { integrity: "sha512-other-archive" } : {}) };
      const overrides: Partial<Sources> = { "generated-package-lock.json": editEntry(location, change) };
      if (location === agent && field !== "integrity") overrides["engine-strict.log"] = strictLog.replaceAll("@npmcli/agent@5.0.2", `@npmcli/agent@${version}`);
      if (location === typescript && field !== "integrity") overrides["runtime-image-inventory.json"] = imageVersion(version);
      expect(blocked(simulation(overrides), gate)).toEqual([expect.objectContaining({ location })]);
    });
  }

  it("keeps a fixed observed TypeScript version when only the lock version changes", () => {
    const summary = simulation({ "generated-package-lock.json": editEntry(typescript, { version: "5.9.3" }) });
    expect(summary.securityGate.findings.productionImageDependencies).toEqual([baseline.policyFindings.productionImageDependencies[0]]);
    expect(disposition(summary)).toMatchObject({ exitCode: 4, checks: { productionImage: "baseline" } });
  });
  it("blocks an observed TypeScript version change without a lock override", () => {
    expect(blocked(simulation({ "runtime-image-inventory.json": imageVersion("5.9.3") }), "productionImage"))
      .toEqual([expect.objectContaining({ name: "typescript", location: typescript, version: "5.9.3" })]);
  });
  it("keeps TypeScript observed after deleting it from the lock", () => {
    expect(blocked(simulation({ "generated-package-lock.json": withLock(p => { delete p[typescript]; }) }), "productionImage"))
      .toEqual([expect.objectContaining({ name: "typescript", location: typescript })]);
  });

  it.each([true, false])("uses inventory evidence whatever named-package flags say (%s)", flag => {
    const policy = { ...JSON.parse(recordedSources["runtime-image-policy.json"] ?? ""), typescriptPresent: flag, rubicSdkPresent: flag };
    const overrides = { "runtime-image-policy.json": JSON.stringify(policy) };
    const summary = simulation(overrides);
    summary.securityGate.productionImageDependencyPolicyPassed = flag;
    summary.docker.policy.typescriptPresent = flag;
    expect(disposition(summary)).toMatchObject({ exitCode: 4, checks: { productionImage: "baseline" } });
    const observed = simulation({ ...overrides, "runtime-image-inventory.json": addImage("rubic-sdk", "5.0.0") });
    observed.securityGate.productionImageDependencyPolicyPassed = flag;
    expect(blocked(observed, "productionImage")).toEqual([expect.objectContaining({ name: "rubic-sdk", location: "node_modules/rubic-sdk" })]);
  });
  it.each([true, false])("uses dependency findings whatever the summary passing flag says (%s)", flag => {
    const summary = simulation();
    summary.securityGate.registryDependencyPolicyPassed = flag;
    expect(disposition(summary)).toMatchObject({ exitCode: 4, checks: { registryDependency: "baseline" } });
    const clean = simulation({ "dependency-policy.json": JSON.stringify({ schema: "dacs-registry-dependency-policy/v1", passed: true, violations: [] }) });
    clean.securityGate.registryDependencyPolicyPassed = flag;
    expect(disposition(clean)).toMatchObject({ exitCode: 4, checks: { registryDependency: "passed" } });
    const changed = simulation({ "dependency-policy.json": JSON.stringify({ schema: "dacs-registry-dependency-policy/v1", passed: false,
      violations: [{ ...baseline.policyFindings.gitDependencies[0], value: "github:other/package" }] }) });
    changed.securityGate.registryDependencyPolicyPassed = flag;
    expect(blocked(changed, "registryDependency")).toEqual([expect.objectContaining({ location: arbundles, value: "github:other/package" })]);
  });

  it.each([
    ["new Git dependency", { location: "node_modules/other", field: "dependencies.x", value: "git+https://github.com/x/y.git" }],
    ["changed Git ref", { ...baseline.policyFindings.gitDependencies[0], value: "https://github.com/Irys-xyz/avsc#main" }],
    ["changed Git location", { ...baseline.policyFindings.gitDependencies[0], location: "node_modules/arbundles" }],
    ["direct file dependency", { location: "package.json", field: "dependencies.dacs", value: "file:../dacs" }],
  ])("names %s", (_label, violation) => {
    const policy = { schema: "dacs-registry-dependency-policy/v1", passed: false, violations: [violation] };
    expect(blocked(simulation({ "dependency-policy.json": JSON.stringify(policy) }), "registryDependency"))
      .toEqual([expect.objectContaining({ location: violation.location, value: violation.value })]);
  });

  it.each([
    ["Node", withLock(p => { p["node_modules/new-pkg"] = { version: "1.0.0", engines: { node: ">=22" } }; }), "node_modules/new-pkg"],
    ["npm", editEntry("node_modules/minipass", { engines: { node: ">=16", npm: ">=12" } }), "node_modules/minipass"],
    ["changed range", editEntry(agent, { engines: { node: ">=24" } }), agent],
  ])("names the additional engine violation: %s", (_label, lock, location) => {
    expect(blocked(simulation({ "generated-package-lock.json": lock }), "engineStrict"))
      .toEqual([expect.objectContaining({ location })]);
  });
  it("names an unsupported range in scan errors", () => {
    const summary = simulation({ "generated-package-lock.json": editEntry("node_modules/minipass", { engines: { node: "please-use-yarn" } }) });
    blocked(summary, "engineStrict");
    expect(summary.securityGate.findings.engine.scan).toMatchObject({ errors: [expect.stringContaining("node_modules/minipass")] });
  });
  it.each([undefined, JSON.stringify({ node: "v20.19.1" })])("blocks missing recorded tool versions: %s", versions => {
    const summary = simulation({ "engine-versions.json": versions });
    blocked(summary, "engineStrict");
    if (versions === undefined) expect(summary.securityGate.findings.engine).toEqual({ incomplete: ["engine-versions.json"] });
    else expect(summary.securityGate.findings.engine.scan.errors).toContain("no recorded npm release version");
  });
  it.each([
    ["unexplained reported offender", strictLog.replaceAll("@npmcli/agent@5.0.2", "other@1.0.0"), { reportedPackage: "other@1.0.0" }],
    ["non-engine failure", "npm error code EBADPLATFORM\n", { code: "EBADPLATFORM" }],
  ])("blocks %s", (_label, log, finding) => {
    const summary = simulation({ "engine-strict.log": log });
    blocked(summary, "engineStrict");
    expect(summary.securityGate.findings.engine).toMatchObject(finding);
  });

  for (const [file, gate] of [["consumer-lock-sbom.err", "lockSbom"], ["consumer-physical-sbom.err", "physicalSbom"]] as const) {
    const original = recordedSources[file] ?? "";
    it.each([
      ["extra problem", original + "npm error missing: other@1.0.0, required by x@1.0.0\n", "missing: other@1.0.0, required by x@1.0.0"],
      ["changed required range", original.replace(gate === "lockSbom" ? ">=0.62.0 <1.0.0" : "2.6.7", ">=99"), ">=99 required by"],
      ["changed package pair", original.replace(gate === "lockSbom" ? "@ton/ton@15.4.0" : "@near-js/providers@0.2.3", "other@1.0.0"), "required by other@1.0.0"],
      ["unlisted diagnostic", original + "npm error unexpected diagnostic\n", "unexpected diagnostic"],
    ])(`blocks ${gate}: %s`, (_label, diagnostic, named) => {
      const outside = blocked(simulation({ [file]: diagnostic }), gate);
      expect(outside).toEqual([expect.stringContaining(named)]);
    });
    it.each(["EINVALIDTREE", "EUSAGE"])(`blocks ${gate} error code %s`, code => {
      const summary = simulation({ [file]: original.replace("ESBOMPROBLEMS", code) });
      blocked(summary, gate);
      expect(summary.securityGate.findings[gate]).toMatchObject({ code });
    });
    it(`normalizes installed versions for the recorded ${gate} package pairs`, () => {
      const changed = original.replace("@ton/core@0.59.1", "@ton/core@0.59.2").replace("@ton/ton@15.4.0", "@ton/ton@15.4.1")
        .replace("@solana/web3.js@1.89.1", "@solana/web3.js@1.89.2").replace("@solana/spl-token@0.4.15", "@solana/spl-token@0.4.16")
        .replace("arbundles@0.6.23", "arbundles@0.6.24").replace("node-fetch@2.7.0", "node-fetch@2.7.1")
        .replace("@near-js/providers@0.2.3", "@near-js/providers@0.2.4");
      expect(disposition(simulation({ [file]: changed }))).toMatchObject({ exitCode: 4, checks: { [gate]: "baseline" } });
    });
  }
});

describe("original baseline with independent image observations", () => {
  it.each([undefined, "", "{"])("names absent or invalid JSON inventory: %s", inventory => {
    const summary = simulation({ "runtime-image-inventory.json": inventory });
    expect(summary.securityGate.findings.productionImageInventory).toEqual({ incomplete: ["runtime-image-inventory.json"] });
    expect(blocked(summary, "productionImage")).toContain("incomplete evidence: runtime-image-inventory.json");
  });
  it.each([
    { label: "wrong schema", inventory: { schema: "other/v1", packages: [] }, error: "runtime-image-inventory.json" },
    { label: "missing package list", inventory: { schema: "dacs-runtime-image-inventory/v1" }, error: "runtime-image-inventory.json" },
    ...[
      { location: "node_modules/x", name: "x" }, { location: "node_modules/x", version: "1.0.0" },
      { location: "node_modules/semver", name: "semver", version: "7.8.5" },
      { location: "node_modules/@sigstore", name: "@sigstore", version: "1.0.0" },
      { location: "lib/x", name: "x", version: "1.0.0" }, { location: "node_modules/.bin", name: ".bin", version: "1.0.0" },
    ].map(entry => ({ label: JSON.stringify(entry), error: JSON.stringify(entry),
      inventory: { ...simulatedInventory, packages: [...simulatedInventory.packages, entry] } })),
  ])("reports scan errors for $label", ({ inventory, error }) => {
    const summary = simulation({ "runtime-image-inventory.json": JSON.stringify(inventory) });
    expect(summary.securityGate.findings.productionImageInventory).toMatchObject({ scanComplete: false });
    expect(blocked(summary, "productionImage")).toContainEqual(expect.stringContaining("inventory error:"));
    expect(summary.securityGate.findings.productionImageInventory.errors).toEqual([
      expect.stringContaining(error)]);
  });
  it.each([
    ["vitest", "3.2.4", "node_modules/vitest"], ["eslint", "9.30.0", "node_modules/eslint"],
    ["esbuild", "0.25.5", "node_modules/sigstore/node_modules/esbuild"], ["@types/node", "20.19.1", "node_modules/@types/node"],
    ["verror", "1.10.1", "node_modules/verror"],
  ])("names the extra or wrong-version image package %s", (name, version, location) => {
    expect(blocked(simulation({ "runtime-image-inventory.json": addImage(name, version, location) }), "productionImage"))
      .toEqual([expect.objectContaining({ name, version, location })]);
  });
  it.each([
    ["wrong version", "node_modules/semver", { version: "7.7.1" }],
    ["wrong name", "node_modules/ssri", { name: "other-ssri" }],
  ])("names a closure package with %s", (_label, location, change) => {
    const observed = withInventory(packages => {
      const entry = packages.find(item => item.location === location);
      if (!entry) throw new Error(`Synthetic image lacks ${location}`);
      Object.assign(entry, change);
    });
    expect(blocked(simulation({ "runtime-image-inventory.json": observed }), "productionImage"))
      .toEqual([expect.objectContaining({ location, ...change })]);
  });
  it("names dev-only packages and missing required closure entries", () => {
    const dev = simulation({ "generated-package-lock.json": editEntry("node_modules/proc-log", { dev: true }) });
    expect(blocked(dev, "productionImage")).toEqual([expect.objectContaining({ name: "proc-log", location: "node_modules/proc-log" })]);
    const missing = withInventory(packages => { packages.splice(packages.findIndex(item => item.name === "minipass"), 1); });
    expect(blocked(simulation({ "runtime-image-inventory.json": missing }), "productionImage")).toContain('missing: "node_modules/minipass"');
  });
  it("allows a correctly versioned optional package to be present or absent", () => {
    for (const inventory of [JSON.stringify(simulatedInventory), addImage("verror", "1.10.0")]) {
      expect(disposition(simulation({ "runtime-image-inventory.json": inventory }))).toMatchObject({ exitCode: 4, checks: { productionImage: "baseline" } });
    }
  });
  it("reports every extra, and reports a prohibited package only once", () => {
    const inventory = withInventory(packages => { packages.push({ name: "vitest", version: "3.2.4", location: "node_modules/vitest" },
      { name: "eslint", version: "9.30.0", location: "node_modules/eslint" }); });
    const summary = simulation({ "generated-package-lock.json": withLock(p => { delete p[typescript]; }), "runtime-image-inventory.json": inventory });
    expect(blocked(summary, "productionImage").map((item: { name: string }) => item.name)).toEqual(["typescript", "vitest", "eslint"]);
  });
  it.each([
    ["exact identity", { name: "vitest", location: "node_modules/vitest", version: "3.2.4", integrity: null }, 4],
    ["partial identity", { name: "vitest", location: "node_modules/vitest" }, 3],
    ["changed version", { name: "vitest", location: "node_modules/vitest", version: "3.2.5", integrity: null }, 3],
    ["changed integrity", { name: "vitest", location: "node_modules/vitest", version: "3.2.4", integrity: "sha512-other" }, 3],
    ["changed location", { name: "vitest", location: "node_modules/other/node_modules/vitest", version: "3.2.4", integrity: null }, 3],
  ])("matches image exceptions by %s", (_label, entry, exitCode) => {
    const rules = { ...baseline, policyFindings: { ...baseline.policyFindings,
      productionImageDependencies: [...baseline.policyFindings.productionImageDependencies, entry] } };
    const summary = simulation({ "runtime-image-inventory.json": addImage("vitest", "3.2.4") });
    expect(disposition(summary, rules)).toMatchObject({ exitCode, checks: { productionImage: exitCode === 4 ? "baseline" : "blocked" } });
    if (exitCode === 3) expect(blocked(summary, "productionImage", rules)).toEqual([expect.objectContaining({ name: "vitest", location: "node_modules/vitest" })]);
  });
  it("does not waive an observed image version absent from a narrow exception", () => {
    const original = { name: "fixture", location: "node_modules/fixture", version: "1.0.0", integrity: null };
    const rules = { ...baseline, policyFindings: { ...baseline.policyFindings,
      productionImageDependencies: [...baseline.policyFindings.productionImageDependencies, original] } };
    expect(disposition(simulation({ "runtime-image-inventory.json": addImage("fixture", "1.0.0") }), rules).exitCode).toBe(4);
    expect(blocked(simulation({ "runtime-image-inventory.json": addImage("fixture", "1.0.1") }), "productionImage", rules))
      .toEqual([{ ...original, version: "1.0.1" }]);
  });
  it("names only unlisted diagnostics in a blocked result", () => {
    const summary = simulation({ "runtime-image-inventory.json": addImage("vitest", "3.2.4"),
      "consumer-physical-sbom.err": recordedSources["consumer-physical-sbom.err"] + "npm error invalid: left-pad@9.9.9 node_modules/left-pad\n" });
    const result = disposition(summary);
    expect(result).toMatchObject({ exitCode: 3, checks: { productionImage: "blocked", physicalSbom: "blocked" } });
    expect(result.message).toContain('productionImage: {"name":"vitest","location":"node_modules/vitest"');
    expect(result.message).toContain("physicalSbom: invalid: left-pad@9.9.9 node_modules/left-pad");
    for (const problem of baseline.policyFindings.physicalSbomProblems) expect(result.message).not.toContain(problem);
  });
});
