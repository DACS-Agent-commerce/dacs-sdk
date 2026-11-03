import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
const modulePath = "../../scripts/check-publish-environment.mjs";
const { publishEnvironmentProblems } = await import(modulePath);
type FixtureReviewer = { type?: string; reviewer?: { login?: string; slug?: string; name?: string } };
type FixtureRule = { type?: string; prevent_self_review?: boolean; reviewers?: Array<FixtureReviewer | null> };
type FixtureEnvironment = { name: string; can_admins_bypass?: boolean | string | null; protection_rules: FixtureRule[];
  deployment_branch_policy: { custom_branch_policies: boolean; protected_branches: boolean } | null };
const environment = (): FixtureEnvironment => ({ name: "npm-prerelease-gated", can_admins_bypass: false,
  protection_rules: [{ type: "required_reviewers", prevent_self_review: true,
    reviewers: [{ type: "User", reviewer: { login: "maintainer" } }] }],
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
  }, 30_000);
  it.each(["rules", "reviewers", "policies"])("bounds decoded %s collections", kind => {
    const env = environment(); const policy = policies();
    const rule = env.protection_rules[0]; if (!rule) throw new Error("missing fixture protection rule");
    if (kind === "rules") env.protection_rules = Array.from({ length: 101 }, () => rule);
    if (kind === "reviewers") rule.reviewers = Array.from({ length: 101 }, () => ({ type: "User", reviewer: { login: "maintainer" } }));
    if (kind === "policies") { policy.branch_policies = Array.from({ length: 101 }, () => ({ type: "tag", name: "v*" })); policy.total_count = 101; }
    expect(publishEnvironmentProblems(env, policy)).not.toEqual([]);
  });
  it("uses the same bounded reader for both fresh environment checks and bounds both jobs", () => {
    const workflow = readFileSync(".github/workflows/publish-prerelease-gated.yml", "utf8");
    expect(workflow.match(/bash scripts\/require-publish-environment.sh/g)).toHaveLength(2);
    expect(workflow.match(/timeout-minutes: 45/g)).toHaveLength(2);
  });
});

describe("publish environment evidence validation", () => {
  // Malformed reviewer entries are not evidence that anyone can approve.
  it.each([
    ["a null reviewer", [null]],
    ["an empty reviewer", [{}]],
    ["a user without a login", [{ type: "User", reviewer: {} }]],
    ["a user without the reviewer object", [{ type: "User" }]],
    ["a team without a slug", [{ type: "Team", reviewer: { name: "Release team" } }]],
    ["an unknown reviewer type", [{ type: "Organization", reviewer: { login: "maintainers" } }]],
  ])("rejects %s instead of counting it as a required reviewer", (_name, reviewers) => {
    const env = environment();
    env.protection_rules = [{ type: "required_reviewers", prevent_self_review: true, reviewers }];
    expect(publishEnvironmentProblems(env, policies())).toEqual(["it has no required reviewers"]);
  });

  it("counts user and team reviewers that carry an identity", () => {
    const env = environment();
    env.protection_rules = [{ type: "required_reviewers", prevent_self_review: true,
      reviewers: [{ type: "User", reviewer: { login: "maintainer" } },
        { type: "Team", reviewer: { slug: "release" } }] }];
    expect(publishEnvironmentProblems(env, policies())).toEqual([]);
  });

  // GitHub does not offer the job's creator as an approver, so a sole matching
  // user reviewer leaves the deployment waiting with no eligible approver.
  it("rejects the dispatch requester as the only eligible reviewer", () => {
    expect(publishEnvironmentProblems(environment(), policies(), "maintainer")).not.toEqual([]);
    expect(publishEnvironmentProblems(environment(), policies(), "MAINTAINER")).not.toEqual([]);
    expect(publishEnvironmentProblems(environment(), policies(), "another-maintainer")).toEqual([]);
    const env = environment();
    env.protection_rules = [{ type: "required_reviewers", prevent_self_review: true,
      reviewers: [{ type: "User", reviewer: { login: "maintainer" } },
        { type: "User", reviewer: { login: "release" } }] }];
    expect(publishEnvironmentProblems(env, policies(), "maintainer")).toEqual([]);
    // Team membership is not in this evidence, so a team reviewer cannot prove
    // that anyone other than the dispatch requester can approve: the guard needs
    // a named user, here a distinct one.
    env.protection_rules = [{ type: "required_reviewers", prevent_self_review: true,
      reviewers: [{ type: "Team", reviewer: { slug: "release" } }] }];
    expect(publishEnvironmentProblems(env, policies(), "maintainer")).not.toEqual([]);
    env.protection_rules = [{ type: "required_reviewers", prevent_self_review: true,
      reviewers: [{ type: "User", reviewer: { login: "maintainer" } },
        { type: "Team", reviewer: { slug: "release" } }] }];
    expect(publishEnvironmentProblems(env, policies(), "maintainer")).not.toEqual([]);
    env.protection_rules = [{ type: "required_reviewers", prevent_self_review: true,
      reviewers: [{ type: "User", reviewer: { login: "maintainer" } },
        { type: "User", reviewer: { login: "release" } }] }];
    expect(publishEnvironmentProblems(env, policies(), "maintainer")).toEqual([]);
  });

  it("reads the dispatch actor from the Actions environment in the CLI", () => {
    const root = mkdtempSync(join(tmpdir(), "dacs-publish-actor-")); const input = join(root, "environment.json"); const policy = join(root, "policies.json");
    try {
      writeFileSync(input, JSON.stringify(environment()));
      writeFileSync(policy, JSON.stringify(policies()));
      const result = spawnSync(process.execPath, ["scripts/check-publish-environment.mjs", input, policy],
        { encoding: "utf8", env: { ...process.env, GITHUB_ACTOR: "maintainer", GITHUB_TRIGGERING_ACTOR: "" } });
      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain("cannot approve");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  // Node runs a module by its real path, so a linked path to the guard must
  // still execute it. Otherwise the CLI check is skipped and the guard exits 0
  // without reading the environment: the gate fails open.
  it.each(["absolute", "relative"])("runs the guard CLI through an %s directory alias instead of passing silently", kind => {
    const root = mkdtempSync(join(tmpdir(), "dacs-publish-alias-"));
    const input = join(root, "environment.json"), policy = join(root, "policies.json");
    try {
      symlinkSync(resolve("scripts"), join(root, "alias"));
      writeFileSync(policy, JSON.stringify(policies()));
      // Unprotected: no admin-bypass prohibition, no reviewers, no tag policy.
      writeFileSync(input, JSON.stringify({ name: "npm-prerelease-gated" }));
      const script = kind === "absolute" ? join(root, "alias/check-publish-environment.mjs") : "alias/check-publish-environment.mjs";
      const result = spawnSync(process.execPath, [script, input, policy],
        { cwd: root, encoding: "utf8", env: { ...process.env, GITHUB_TRIGGERING_ACTOR: "", GITHUB_ACTOR: "" } });
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(result.stdout).toContain("cannot gate publication");
      // The same alias runs a protected environment to success, so the check runs.
      writeFileSync(input, JSON.stringify(environment()));
      const passed = spawnSync(process.execPath, [script, input, policy],
        { cwd: root, encoding: "utf8", env: { ...process.env, GITHUB_TRIGGERING_ACTOR: "", GITHUB_ACTOR: "" } });
      expect(passed.status, passed.stdout + passed.stderr).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  // Duplicate entries are not the single unambiguous policy the runbook sets.
  it("rejects duplicate deployment policies even when each names the release pattern", () => {
    const duplicated = { total_count: 2,
      branch_policies: [{ type: "tag", name: "v*" }, { type: "tag", name: "v*" }] };
    expect(publishEnvironmentProblems(environment(), duplicated)).not.toEqual([]);
  });
});
