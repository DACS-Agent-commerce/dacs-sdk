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
describe("5c27c28 upstream findings retained under #191", () => {
  it("retains the original blocked image and SBOM dispositions", () => {
    const recorded = original();
    expect(recorded.disposition).toMatchObject({ exitCode: 3,
      checks: { productionImage: "blocked", physicalSbom: "blocked" } });
  });

});
