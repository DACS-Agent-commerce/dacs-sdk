import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
const root = resolve(import.meta.dirname, "../..");
const fixture = join(root, "test/scripts/fixtures/registry-container-5c27c28");
describe("captured evidence scope", () => {
  it("documents the evidence and assertions actually included", () => {
    const readme = readFileSync(join(fixture, "README.md"), "utf8");
    if (existsSync(join(fixture, "generated-package-lock.json"))) expect(readme).toContain("Tests re-extract findings");
    else {
      expect(readme).toContain("No generated lock is included");
      expect(readme).toContain("asserts the recorded disposition");
      expect(readme).not.toContain("28 lock entries");
    }
    if (!existsSync(join(root, "scripts/registry-container-audit-baseline.md"))) expect(readme).not.toContain("companion Markdown");
  });
  it("keeps the narrow replay free of unused future-stage scaffolding", () => {
    const result = spawnSync(process.execPath, ["node_modules/typescript/bin/tsc", "--noEmit", "--noUnusedLocals", "--module", "NodeNext",
      "--target", "ES2022", "--skipLibCheck", "--strict", "--types", "node", "test/scripts/registry-container-upstream-findings.test.ts"],
      { cwd: root, encoding: "utf8" });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  }, 30_000);
});
