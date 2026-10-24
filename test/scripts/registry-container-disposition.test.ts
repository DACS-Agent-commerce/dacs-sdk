import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Keep the classifier executable as plain Node ESM.
const dispositionModulePath = "../../scripts/registry-container-disposition.mjs";
const { classifyRegistryAudit } = await import(dispositionModulePath);
const repoRoot = resolve(import.meta.dirname, "../..");
describe("advisory-ID baseline", () => {
  const baseline = JSON.parse(readFileSync(join(repoRoot, "scripts/registry-container-audit-baseline.json"), "utf8"));
  it("accepts an empty #191 list, in which every observed ID is unlisted", () => {
    expect(classifyRegistryAudit(["GHSA-23hp-3jrh-7fpw"], { ...baseline, advisoryIds: [] }))
      .toMatchObject({ unlistedAdvisories: ["GHSA-23hp-3jrh-7fpw"], assessedAdvisories: [] });
  });
});
