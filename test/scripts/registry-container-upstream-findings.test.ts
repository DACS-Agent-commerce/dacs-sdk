import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const fixture = join(repoRoot, "test/scripts/fixtures/registry-container-5c27c28");
const original = () => JSON.parse(readFileSync(join(fixture, "acceptance-summary.json"), "utf8"));
describe("5c27c28 upstream findings retained under #191", () => {
  it("retains the original blocked image and SBOM dispositions", () => {
    const recorded = original();
    expect(recorded.disposition).toMatchObject({ exitCode: 3,
      checks: { productionImage: "blocked", physicalSbom: "blocked" } });
  });
});
