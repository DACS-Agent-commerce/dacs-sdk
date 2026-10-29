#!/usr/bin/env node
// Checks REST evidence for the protected environment in docs/npm-prerelease-release.md.
// Fails closed before GitHub can create an unprotected environment on first use.
// Usage: check-publish-environment.mjs <environment.json> <deployment-branch-policies.json>
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { HTTP_JSON_MAX_BYTES } from "./http-json-limits.mjs";

export const PUBLISH_ENVIRONMENT = "npm-prerelease-gated";
// The only deployment rule owner step 1 sets: release tags. A broader pattern
// such as `*` would let any tag a writer pushes deploy to the environment.
export const PUBLISH_TAG_PATTERN = "v*";
const MAX_COLLECTION_ENTRIES = 100;

// The identity a required-reviewers entry can actually match, or null when the
// entry is malformed and cannot approve anything.
function reviewerIdentity(entry) {
  const reviewer = entry?.reviewer;
  if (!reviewer || typeof reviewer !== "object") return null;
  if (entry.type === "User" && typeof reviewer.login === "string" && reviewer.login !== "") {
    return { type: "User", login: reviewer.login };
  }
  if (entry.type === "Team" && typeof reviewer.slug === "string" && reviewer.slug !== "") {
    return { type: "Team", slug: reviewer.slug };
  }
  return null;
}

// Whether someone other than the run's triggering actor can approve the job.
// Team membership is not in this evidence, so a team cannot prove that an
// eligible approver exists: only a named user counts.
function hasEligibleApprover(rules, dispatchActor) {
  if (dispatchActor === "") return true;
  const actor = dispatchActor.toLowerCase();
  return rules.some(rule => rule.reviewers.some(entry => {
    const identity = reviewerIdentity(entry);
    return identity.type === "User" && identity.login.toLowerCase() !== actor;
  }));
}

// Every reason the environment cannot gate publication; empty when it can.
export function publishEnvironmentProblems(environment, policies, dispatchActor = "") {
  if (environment?.name !== PUBLISH_ENVIRONMENT) {
    return [`the ${PUBLISH_ENVIRONMENT} environment does not exist or is another environment`];
  }
  const problems = [];
  if (environment.can_admins_bypass !== false) problems.push("it does not prohibit admin bypass");
  const rules = Array.isArray(environment.protection_rules) && environment.protection_rules.length <= MAX_COLLECTION_ENTRIES ? environment.protection_rules : [];
  const reviewers = rules.filter(rule => rule?.type === "required_reviewers" &&
    Array.isArray(rule.reviewers) && rule.reviewers.length > 0 && rule.reviewers.length <= MAX_COLLECTION_ENTRIES &&
    rule.reviewers.every(entry => reviewerIdentity(entry) !== null));
  if (reviewers.length === 0) problems.push("it has no required reviewers");
  else if (!reviewers.some(rule => rule.prevent_self_review === true)) problems.push("it does not prevent self-review");
  else if (!hasEligibleApprover(reviewers, dispatchActor)) problems.push("its required reviewers cannot approve the job that the dispatch requester created");
  const branchPolicy = environment.deployment_branch_policy;
  const list = Array.isArray(policies?.branch_policies) ? policies.branch_policies : null;
  if (branchPolicy?.custom_branch_policies !== true || branchPolicy.protected_branches !== false) {
    problems.push("its deployments are not limited to custom tag patterns");
  } else if (!list || list.length === 0 || list.length > MAX_COLLECTION_ENTRIES || policies.total_count !== list.length) {
    problems.push("its deployment tag patterns could not be read in full");
  } else if (list.some(policy => policy?.type !== "tag" || policy.name !== PUBLISH_TAG_PATTERN)) {
    problems.push(`a deployment pattern other than the ${PUBLISH_TAG_PATTERN} tag pattern can deploy to it`);
  } else if (list.length !== 1) {
    problems.push("it has more than one deployment tag pattern");
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [environmentPath, policiesPath] = process.argv.slice(2);
  const read = path => {
    try {
      const bytes = readFileSync(path);
      if (bytes.length > HTTP_JSON_MAX_BYTES) throw new Error(`input exceeds ${HTTP_JSON_MAX_BYTES} bytes`);
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch (error) { process.stderr.write(`${path}: ${error.message}\n`); process.exit(1); }
  };
  const problems = environmentPath && policiesPath ? publishEnvironmentProblems(read(environmentPath), read(policiesPath),
    process.env.GITHUB_TRIGGERING_ACTOR || process.env.GITHUB_ACTOR || "")
    : ["usage: check-publish-environment.mjs <environment.json> <deployment-branch-policies.json>"];
  if (problems.length) {
    process.stdout.write(`::error title=Unprotected publish environment::${PUBLISH_ENVIRONMENT} cannot gate ` +
      `publication: ${problems.join("; ")}. Complete owner step 1 in docs/npm-prerelease-release.md first.\n`);
    process.exit(1);
  }
  process.stdout.write(`${PUBLISH_ENVIRONMENT} has required reviewers, prevents self-review and admin bypass, and deploys only ` +
    `from the ${PUBLISH_TAG_PATTERN} tag pattern\n`);
}
