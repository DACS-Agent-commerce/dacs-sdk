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
const evidence = (overrides: Record<string, string> = {}) => {
  const summary = original();
  summary.securityGate.findings = extractPolicyFindings((name: string) => overrides[name] ?? read(name));
  return summary;
};
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
  it("retains the original failing summary and re-extracts its findings from the uploaded evidence", () => {
    const recorded = original();
    expect(recorded.disposition).toMatchObject({ exitCode: 3,
      checks: { productionImage: "blocked", physicalSbom: "blocked" } });
    const extracted = evidence().securityGate.findings;
    // Only the package count changes when unrelated lock/inventory rows are
    // removed for this fixture. Every retained entry and finding is original.
    extracted.engine.scan.evaluatedPackages = recorded.securityGate.findings.engine.scan.evaluatedPackages;
    expect(extracted).toEqual(recorded.securityGate.findings);
  });

  it("names exactly the two unlisted entries against the previous baseline", () => {
    const previous = withoutFinding("productionImage");
    previous.policyFindings.physicalSbomProblems = withoutFinding("physicalSbom").policyFindings.physicalSbomProblems;
    const summary = evidence();
    expect(registryContainerDisposition(summary, previous)).toMatchObject({ exitCode: 3,
      checks: { productionImage: "blocked", physicalSbom: "blocked" } });
    expect(unlistedPolicyFindings(summary, previous, ["productionImage", "physicalSbom"]))
      .toEqual({ productionImage: [{ name: "pqcrypto", location: "node_modules/pqcrypto", version: "1.0.01",
        integrity: "sha512-83SHdhiOYAaUK6HUKihoH36SqQ11ma+Q7o+DQUasV/IUZSrW8doQVPoTPrR0xU+tUyFnrJSC4aIp5rKnlELrqw==" }],
      physicalSbom: ["invalid: bip39@3.1.2, 3.1.0 required by @multiversx/sdk-core@13.17.2"] });
  });

  it.each(["productionImage", "physicalSbom"] as const)("requires the individual disposition for %s", check => {
    expect(registryContainerDisposition(evidence(), withoutFinding(check))).toMatchObject({ exitCode: 3,
      checks: { [check]: "blocked" } });
  });

  it("classifies both the original summary and regenerated findings as baseline-only while keeping the gate blocked", () => {
    for (const summary of [original(), evidence()]) {
      expect(summary.securityGate.passed).toBe(false);
      expect(registryContainerDisposition(summary, baseline)).toMatchObject({ exitCode: 4, failureClass: "policy",
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
    expect(registryContainerDisposition(summary, baseline)).toMatchObject({ exitCode: 3,
      checks: { productionImage: "blocked" } });
  });

  it.each([
    ["another required range", "invalid: bip39@3.1.2, 3.0.0 required by @multiversx/sdk-core@13.17.2"],
    ["another parent", "invalid: bip39@3.1.2, 3.1.0 required by other@13.17.2"],
    ["another package", "invalid: other@3.1.2, 3.1.0 required by @multiversx/sdk-core@13.17.2"],
  ])("still blocks an SBOM problem with %s", (_label, problem) => {
    const summary = evidence();
    summary.securityGate.findings.physicalSbom.problems[0] = problem;
    expect(registryContainerDisposition(summary, baseline)).toMatchObject({ exitCode: 3,
      checks: { physicalSbom: "blocked" } });
  });

  it("does not waive a missing required pqcrypto package", () => {
    const inventory = JSON.parse(read("runtime-image-inventory.json"));
    inventory.packages = inventory.packages.filter((item: { name: string }) => item.name !== "pqcrypto");
    const summary = evidence({ "runtime-image-inventory.json": JSON.stringify(inventory) });
    expect(summary.securityGate.findings.productionImageInventory.missing).toContain("node_modules/pqcrypto");
    expect(registryContainerDisposition(summary, baseline)).toMatchObject({ exitCode: 3,
      checks: { productionImage: "blocked" } });
  });
});
