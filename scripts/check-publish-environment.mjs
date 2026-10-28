#!/usr/bin/env node
// Fails closed unless the gated publish environment already exists with the
// protection docs/npm-prerelease-release.md's owner step 1 sets. GitHub creates
// a missing environment the first time a job names it, with no reviewers and no
// deployment rule, so without this check a dispatch before that step would
// publish with no maintainer approval.
//
// usage: check-publish-environment.mjs <environment.json> <deployment-branch-policies.json>
// (the GitHub REST responses for the environment and its deployment policies)
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const PUBLISH_ENVIRONMENT = "npm-prerelease-gated";
// The only deployment rule owner step 1 sets: release tags. A broader pattern
// such as `*` would let any tag a writer pushes deploy to the environment.
export const PUBLISH_TAG_PATTERN = "v*";

// Every reason the environment cannot gate publication; empty when it can.
export function publishEnvironmentProblems(environment, policies) {
  if (environment?.name !== PUBLISH_ENVIRONMENT) {
    return [`the ${PUBLISH_ENVIRONMENT} environment does not exist or is another environment`];
  }
  const problems = [];
  if (environment.can_admins_bypass !== false) problems.push("it does not prohibit admin bypass");
  const rules = Array.isArray(environment.protection_rules) ? environment.protection_rules : [];
  const reviewers = rules.filter(rule => rule?.type === "required_reviewers" &&
    Array.isArray(rule.reviewers) && rule.reviewers.length > 0);
  if (reviewers.length === 0) problems.push("it has no required reviewers");
  else if (!reviewers.some(rule => rule.prevent_self_review === true)) problems.push("it does not prevent self-review");
  const branchPolicy = environment.deployment_branch_policy;
  const list = Array.isArray(policies?.branch_policies) ? policies.branch_policies : null;
  if (branchPolicy?.custom_branch_policies !== true || branchPolicy.protected_branches !== false) {
    problems.push("its deployments are not limited to custom tag patterns");
  } else if (!list || list.length === 0 || policies.total_count !== list.length) {
    problems.push("its deployment tag patterns could not be read in full");
  } else if (list.some(policy => policy?.type !== "tag" || policy.name !== PUBLISH_TAG_PATTERN)) {
    problems.push(`a deployment pattern other than the ${PUBLISH_TAG_PATTERN} tag pattern can deploy to it`);
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [environmentPath, policiesPath] = process.argv.slice(2);
  const read = path => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; } };
  const problems = environmentPath && policiesPath ? publishEnvironmentProblems(read(environmentPath), read(policiesPath))
    : ["usage: check-publish-environment.mjs <environment.json> <deployment-branch-policies.json>"];
  if (problems.length) {
    process.stdout.write(`::error title=Unprotected publish environment::${PUBLISH_ENVIRONMENT} cannot gate ` +
      `publication: ${problems.join("; ")}. Complete owner step 1 in docs/npm-prerelease-release.md first.\n`);
    process.exit(1);
  }
  process.stdout.write(`${PUBLISH_ENVIRONMENT} has required reviewers, prevents self-review and admin bypass, and deploys only ` +
    `from the ${PUBLISH_TAG_PATTERN} tag pattern\n`);
}
