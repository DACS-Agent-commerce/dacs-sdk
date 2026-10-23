import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const modulePath = "../../scripts/check-publish-environment.mjs";
const { publishEnvironmentProblems } = await import(modulePath);
const environment = () => ({ name: "npm-prerelease-gated", can_admins_bypass: false,
  protection_rules: [{ type: "required_reviewers", prevent_self_review: true, reviewers: [{ id: 1 }] }],
  deployment_branch_policy: { custom_branch_policies: true, protected_branches: false } });
const policies = () => ({ total_count: 1, branch_policies: [{ type: "tag", name: "v*" }] });
describe("publish environment evidence bounds", () => {
  it.each(["invalid JSON", "missing file", "oversized JSON"])("preserves the input cause for %s", kind => {
    const root = mkdtempSync(join(tmpdir(), "dacs-publish-input-")); const input = join(root, "environment.json"); const policy = join(root, "policies.json");
    try {
      writeFileSync(policy, JSON.stringify(policies()));
      if (kind !== "missing file") writeFileSync(input, kind === "invalid JSON" ? "{invalid" : JSON.stringify({ ...environment(), padding: "x".repeat(2 * 1024 * 1024) }));
      const result = spawnSync(process.execPath, ["scripts/check-publish-environment.mjs", input, policy], { encoding: "utf8" });
      expect(result.status).not.toBe(0); expect(result.stderr).toContain(input);
      expect(result.stderr).toMatch(kind === "missing file" ? /ENOENT/ : kind === "invalid JSON" ? /JSON|Expected|Unexpected/ : /exceeds.*bytes/);
      expect(result.stdout).not.toContain("Complete owner step 1");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.each(["rules", "reviewers", "policies"])("bounds decoded %s collections", kind => {
    const env = environment(); const policy = policies();
    const rule = env.protection_rules[0]; if (!rule) throw new Error("missing fixture protection rule");
    if (kind === "rules") env.protection_rules = Array.from({ length: 101 }, () => rule);
    if (kind === "reviewers") rule.reviewers = Array.from({ length: 101 }, () => ({ id: 1 }));
    if (kind === "policies") { policy.branch_policies = Array.from({ length: 101 }, () => ({ type: "tag", name: "v*" })); policy.total_count = 101; }
    expect(publishEnvironmentProblems(env, policy)).not.toEqual([]);
  });
  it("uses the same bounded reader for both fresh environment checks and bounds both jobs", () => {
    const workflow = readFileSync(".github/workflows/publish-prerelease-gated.yml", "utf8");
    expect(workflow.match(/bash scripts\/require-publish-environment.sh/g)).toHaveLength(2);
    expect(workflow.match(/timeout-minutes: 45/g)).toHaveLength(2);
  });
});
