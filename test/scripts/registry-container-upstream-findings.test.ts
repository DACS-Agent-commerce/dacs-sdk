import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const modulePath = "../../scripts/registry-container-disposition.mjs";
const { extractPolicyFindings, registryContainerDisposition, unlistedPolicyFindings } = await import(modulePath);
const repoRoot = resolve(import.meta.dirname, "../..");
const fixture = join(repoRoot, "test/scripts/fixtures/registry-container-5c27c28");
const baseline = JSON.parse(readFileSync(join(repoRoot, "scripts/registry-container-audit-baseline.json"), "utf8"));
const read = (name: string) => readFileSync(join(fixture,
  name === "engine-strict.log" ? "engine-strict.log.txt" : name), "utf8");
const original = () => JSON.parse(read("acceptance-summary.json"));
const recordedProjection = (overrides: Record<string, string> = {}) => {
  const summary = original();
  summary.complete = true; // Reconstructed evidence; the original legacy JSON is unchanged.
  summary.securityGate.findings = extractPolicyFindings((name: string) => overrides[name] ?? read(name));
  return summary;
};
// These leaves and observations complete only the explicit simulation. The
// recorded projection above keeps every uploaded byte and its current refusal.
const semverModule = "semver";
const { validRange, minVersion } = await import(semverModule);
const simulatedLock = JSON.parse(read("generated-package-lock.json"));
const simulatedInventory = JSON.parse(read("runtime-image-inventory.json"));
for (const entry of Object.values(simulatedLock.packages)) {
  if (typeof entry !== "object" || entry === null) throw new Error("Invalid simulated lock entry");
  for (const [name, range] of Object.entries(Reflect.get(entry, "dependencies") ?? {})) {
    const location = `node_modules/${name}`;
    if (simulatedLock.packages[location]) continue;
    const version = typeof range === "string" && validRange(range) ? minVersion(range).version : "0.0.0";
    simulatedLock.packages[location] = { version };
    simulatedInventory.packages.push({ name, version, location });
  }
}
const evidence = (overrides: Record<string, string> = {}) => recordedProjection({
  "generated-package-lock.json": JSON.stringify(simulatedLock),
  "runtime-image-inventory.json": JSON.stringify(simulatedInventory), ...overrides,
});
const historicalDisposition = (summary: unknown, baseline?: unknown) =>
  registryContainerDisposition(summary, baseline, { packageVersion: "0.1.0-alpha.0" });
const withoutFinding = (check: "productionImage" | "physicalSbom") => {
  const value = structuredClone(baseline);
  if (check === "productionImage") {
    value.policyFindings.productionImageDependencies = value.policyFindings.productionImageDependencies
      .filter((item: { name: string }) => item.name !== "pqcrypto");
  } else {
    value.policyFindings.physicalSbomProblems = value.policyFindings.physicalSbomProblems
      .filter((line: string) => !line.startsWith("invalid: bip39@"));
  }
  return value;
};

describe("5c27c28 upstream findings retained under #191", () => {
  it("retains the original summary and checks its current incomplete projection", () => {
    const recorded = original();
    expect(recorded.disposition).toMatchObject({ exitCode: 3,
      checks: { productionImage: "blocked", physicalSbom: "blocked" } });
    const projected = recordedProjection();
    const extracted = projected.securityGate.findings;
    const expectedErrors = JSON.parse(readFileSync(join(repoRoot,
      "test/scripts/fixtures/registry-container-5c27c28-current-inventory-errors.json"), "utf8"));
    expect(extracted.productionImageInventory).toEqual({
      ...recorded.securityGate.findings.productionImageInventory, scanComplete: false, errors: expectedErrors,
    });
    expect(historicalDisposition(projected)).toMatchObject({ exitCode: 3, checks: { productionImage: "blocked" } });
    // Compare every legacy field after explicitly checking the newer closure rule.
    extracted.productionImageInventory = recorded.securityGate.findings.productionImageInventory;
    // Selected rows change the evaluated package count. After the checked
    // inventory projection above, every remaining finding stays exact.
    extracted.engine.scan.evaluatedPackages = recorded.securityGate.findings.engine.scan.evaluatedPackages;
    expect(extracted).toEqual(recorded.securityGate.findings);
  });

  it("names exactly the two unlisted entries against the previous baseline", () => {
    const previous = withoutFinding("productionImage");
    previous.policyFindings.physicalSbomProblems = withoutFinding("physicalSbom").policyFindings.physicalSbomProblems;
    const summary = evidence();
    expect(historicalDisposition(summary, previous)).toMatchObject({ exitCode: 3,
      checks: { productionImage: "blocked", physicalSbom: "blocked" } });
    expect(unlistedPolicyFindings(summary, previous, ["productionImage", "physicalSbom"]))
      .toEqual({ productionImage: [{ name: "pqcrypto", location: "node_modules/pqcrypto", version: "1.0.01",
        integrity: "sha512-83SHdhiOYAaUK6HUKihoH36SqQ11ma+Q7o+DQUasV/IUZSrW8doQVPoTPrR0xU+tUyFnrJSC4aIp5rKnlELrqw==" }],
      physicalSbom: ["invalid: bip39@3.1.2, 3.1.0 required by @multiversx/sdk-core@13.17.2"] });
  });

  it.each(["productionImage", "physicalSbom"] as const)("requires the individual disposition for %s", check => {
    expect(historicalDisposition(evidence(), withoutFinding(check))).toMatchObject({ exitCode: 3,
      checks: { [check]: "blocked" } });
  });

  it("rejects a legacy summary without completion and classifies reconstructed findings as baseline-only", () => {
    expect(historicalDisposition(original(), baseline).exitCode).toBe(1);
    for (const summary of [evidence()]) {
      expect(summary.securityGate.passed).toBe(false);
      expect(summary.securityGate.findings.productionImageInventory).toEqual({ scanComplete: true, errors: [], missing: [] });
      expect(historicalDisposition(summary, baseline)).toMatchObject({ exitCode: 4, failureClass: "policy",
        checks: { registryDependency: "baseline", productionImage: "baseline", engineStrict: "baseline",
          lockSbom: "baseline", physicalSbom: "baseline", audit: "baseline" } });
    }
  });

  it("continues reporting pqcrypto's registry / manifest mismatch without normalizing it", () => {
    const lock = JSON.parse(read("generated-package-lock.json"));
    expect(lock.packages["node_modules/@kynesyslabs/demosdk"].dependencies.pqcrypto).toBe("^1.0.1");
    expect(lock.packages["node_modules/pqcrypto"].version).toBe("1.0.1");
    expect(evidence().securityGate.findings.productionImageDependencies).toContainEqual({
      name: "pqcrypto", location: "node_modules/pqcrypto", version: "1.0.01",
      integrity: lock.packages["node_modules/pqcrypto"].integrity });
  });

  it("retains the omitted optional bip39 copy and npm's failing physical SBOM", () => {
    const lock = JSON.parse(read("generated-package-lock.json"));
    expect(lock.packages["node_modules/@multiversx/sdk-core"].optionalDependencies.bip39).toBe("3.1.0");
    expect(lock.packages["node_modules/@multiversx/sdk-core/node_modules/bip39"])
      .toMatchObject({ version: "3.1.0", optional: true });
    const inventory = JSON.parse(read("runtime-image-inventory.json"));
    expect(inventory.packages).not.toContainEqual(expect.objectContaining({
      location: "node_modules/@multiversx/sdk-core/node_modules/bip39" }));
    expect(evidence().securityGate.findings.physicalSbom).toMatchObject({ exitCode: 1, code: "ESBOMPROBLEMS",
      problems: expect.arrayContaining(["invalid: bip39@3.1.2, 3.1.0 required by @multiversx/sdk-core@13.17.2"]) });
  });

  it.each([
    ["another location", { location: "node_modules/other/node_modules/pqcrypto" }],
    ["another package", { name: "other" }],
  ])("still blocks a pqcrypto image finding at %s", (_label, edit) => {
    const summary = evidence();
    Object.assign(summary.securityGate.findings.productionImageDependencies
      .find((item: { name: string }) => item.name === "pqcrypto"), edit);
    expect(historicalDisposition(summary, baseline)).toMatchObject({ exitCode: 3,
      checks: { productionImage: "blocked" } });
  });

  it.each([
    ["another required range", "invalid: bip39@3.1.2, 3.0.0 required by @multiversx/sdk-core@13.17.2"],
    ["another parent", "invalid: bip39@3.1.2, 3.1.0 required by other@13.17.2"],
    ["another package", "invalid: other@3.1.2, 3.1.0 required by @multiversx/sdk-core@13.17.2"],
  ])("still blocks an SBOM problem with %s", (_label, problem) => {
    const summary = evidence();
    summary.securityGate.findings.physicalSbom.problems[0] = problem;
    expect(historicalDisposition(summary, baseline)).toMatchObject({ exitCode: 3,
      checks: { physicalSbom: "blocked" } });
  });

  it("does not waive a missing required pqcrypto package", () => {
    const inventory = structuredClone(simulatedInventory);
    inventory.packages = inventory.packages.filter((item: { name: string }) => item.name !== "pqcrypto");
    const summary = evidence({ "runtime-image-inventory.json": JSON.stringify(inventory) });
    expect(summary.securityGate.findings.productionImageInventory.missing).toContain("node_modules/pqcrypto");
    expect(historicalDisposition(summary, baseline)).toMatchObject({ exitCode: 3,
      checks: { productionImage: "blocked" } });
  });
});
