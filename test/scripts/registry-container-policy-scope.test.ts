import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
describe("acceptance policy scope", () => {
  it("does not describe publication controls before their workflow exists", () => {
    const policy = readFileSync("SECURITY.md", "utf8");
    if (!existsSync(".github/workflows/publish-prerelease-gated.yml")) {
      expect(policy).not.toContain("Publish gated npm prerelease");
      expect(policy).not.toContain("npm-prerelease-gated");
      expect(policy).not.toContain("any release or publication path fail closed");
    }
    if (!existsSync(".github/workflows/registry-container-audit-drift.yml")) {
      expect(policy).not.toContain("Scheduled drift checks");
      expect(policy).not.toContain("callers enforcing drift");
    }
    expect(policy).toContain("manual runs");
  });
  it("introduces workflow parsers only with their callers", () => {
    const result = spawnSync(process.execPath, ["node_modules/typescript/bin/tsc", "--noEmit", "--noUnusedLocals", "--module", "NodeNext", "--target", "ES2022", "--skipLibCheck", "--strict", "--types", "node", "test/scripts/registry-container-disposition.test.ts"], { encoding: "utf8" });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  }, 30_000);
});
