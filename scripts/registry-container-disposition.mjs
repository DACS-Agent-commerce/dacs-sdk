#!/usr/bin/env node
// Observing only advisory IDs listed in the #191 baseline, or a subset of
// them, is baseline-only (exit 4). An ID missing from the baseline fails closed
// (exit 3) unless DACS_UNLISTED_ADVISORIES=warn, which only the pull_request
// acceptance job sets: there it is a warning, so an advisory newly published
// against an unchanged tree cannot turn every PR red. The scheduled drift job,
// manual runs, prerelease publication and release paths fail, and an unlisted
// ID that is high or critical on a direct dependency fails pull requests too.
// An observed ID recorded in `assessedAdvisories` (a transitive advisory
// assessed for reachability, as SECURITY.md's audit policy allows) does not
// block the gate, and one recorded in the #191 baseline is baseline-only; one
// on a direct dependency at high or critical severity always blocks, whichever
// list records it. Nothing here permits production publication while #191
// remains blocked.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
export const ACCEPTANCE_SUMMARY_SCHEMA = "dacs-registry-container-acceptance/v1";
// The evidence a complete summary embeds, by the schema its producer writes.
export const RUNTIME_IMAGE_POLICY_SCHEMA = "dacs-runtime-image-policy/v1";
export const POLICY_FINDINGS_SCHEMA = "dacs-registry-policy-findings/v1";
const baselinePath = new URL("./registry-container-audit-baseline.json", import.meta.url);
// The release the acceptance packs and installs: the checkout's own version,
// as verify-registry-container-consumer.sh reads it.
export const RELEASE_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const advisoryId = /^GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}$/;

function validIds(ids) {
  return Array.isArray(ids) && ids.every(id => typeof id === "string" && advisoryId.test(id)) &&
    new Set(ids).size === ids.length;
}

// Each assessment names where its reachability assessment is recorded.
const validAssessments = entries => Array.isArray(entries) && entries.every(entry => typeof entry === "object" &&
  entry !== null && typeof entry.id === "string" && advisoryId.test(entry.id) && typeof entry.assessment === "string" &&
  entry.assessment.trim() !== "") && new Set(entries.map(entry => entry.id)).size === entries.length;

// `directAdvisories` are the observed IDs that npm reports at high or critical
// severity on a direct dependency of the consumer.
export function classifyRegistryAudit(observedAdvisories, baseline, directAdvisories = []) {
  const assessments = baseline?.assessedAdvisories ?? [];
  if (baseline?.schema !== "dacs-registry-audit-baseline/v1" ||
      typeof baseline.source?.commit !== "string" || !/^[a-f0-9]{40}$/.test(baseline.source.commit) ||
      typeof baseline.source?.job !== "string" || !baseline.source.job ||
      !validIds(baseline.advisoryIds) || !validAssessments(assessments) ||
      assessments.some(({ id }) => baseline.advisoryIds.includes(id)) || !validIds(observedAdvisories) ||
      !validIds(directAdvisories) || directAdvisories.some(id => !observedAdvisories.includes(id))) {
    throw new Error("malformed registry audit baseline or observed advisory IDs");
  }
  const known = new Set(baseline.advisoryIds);
  const assessed = new Set(assessments.map(({ id }) => id));
  return { observedAdvisories: [...observedAdvisories].sort(),
    unlistedAdvisories: observedAdvisories.filter(id => !known.has(id) && !assessed.has(id)).sort(),
    assessedAdvisories: observedAdvisories.filter(id => assessed.has(id)).sort(),
    directAdvisories: [...directAdvisories].sort() };
}

