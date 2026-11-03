import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ReleaseError, readRegistryDistTags, readRegistryRelease, REGISTRY_ORIGIN, sleep } from "./registry-release-reader.mjs";
import { packages as policyPackages } from "./release-checks.mjs";
import { publishNpmEnvironment, runReleaseCommand } from "./release-command.mjs";

const PUBLISH_DEADLINE_MS = 40 * 60 * 1000;
// Must equal `timeout-minutes` of the workflow's publish job.
const PUBLISH_JOB_TIMEOUT_MS = 45 * 60 * 1000;
const PUBLISH_JOB_RESERVE_MS = 2 * 60 * 1000;
const PUBLISH_COMMAND_TIMEOUT_SECONDS = 300;
const REGISTRY_PROPAGATION_WINDOW_MS = 60_000;
const REGISTRY_POLL_INTERVAL_MS = 2000;
const NPM_ERROR_EXCERPT_CHARS = 2000;

const args = process.argv.slice(2);
if (args.length !== 6 || args[0] !== "--artifact-dir" || !args[1] ||
    args[2] !== "--tag" || !args[3] || args[4] !== "--job-started-at" || !args[5]) {
  throw new Error("usage: publish-release-set --artifact-dir <dir> --tag <tag> --job-started-at <epoch milliseconds>");
}
if (process.env.GITHUB_ACTIONS !== "true") {
  throw new Error("release publication is restricted to the reviewed GitHub workflow");
}
const artifactDirectory = resolve(args[1]);
const tag = args[3];
if (!/^[a-z][a-z0-9-]{0,31}$/u.test(tag)) throw new Error("release tag is invalid");
const jobStartedAt = Number(args[5]);
if (!/^[1-9]\d{0,15}$/u.test(args[5]) || jobStartedAt > Date.now()) {
  throw new Error("--job-started-at must be the job start in epoch milliseconds, not in the future");
}
const deadline = Math.min(Date.now() + PUBLISH_DEADLINE_MS, jobStartedAt + PUBLISH_JOB_TIMEOUT_MS - PUBLISH_JOB_RESERVE_MS);
const timeLeft = () => deadline - Date.now();

const provenance = JSON.parse(
  await readFile(resolve(artifactDirectory, "release-provenance.json"), "utf8"),
);
if (provenance?.schema !== "dacs-release-set/v1" ||
    typeof provenance.version !== "string" ||
    !provenance.version.includes("-") || provenance.source?.clean !== true ||
    typeof provenance.packages !== "object" || provenance.packages === null) {
  throw new Error("release provenance is absent, dirty or not a prerelease");
}
const packages = policyPackages.map(({ name }) => name);
assertStrictFivePackageProvenance(provenance);
if (process.env.DACS_NPM_PUBLISH_CONFIRM !==
    `publish:${provenance.version}:${tag}`) {
  throw new Error("exact release publication confirmation is absent");
}

// The publisher accepts only a set that strict admission produced: exactly the
// policy's packages, in policy order. It runs before any registry read.
function assertStrictFivePackageProvenance({ admission, packages: recorded }) {
  if (admission !== "strict-five") {
    throw new Error("release provenance was not produced by strict five-package admission");
  }
  const names = Object.keys(recorded);
  const missing = packages.filter((name) => !names.includes(name));
  const unknown = names.filter((name) => !packages.includes(name));
  if (missing.length > 0) throw new Error(`release provenance is missing ${missing.join(", ")}`);
  if (unknown.length > 0) throw new Error(`release provenance names unknown ${unknown.join(", ")}`);
  if (names.some((name, index) => name !== packages[index])) {
    throw new Error(`release provenance packages are not in policy order: ${names.join(", ")}`);
  }
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Reads the registry's release: undefined when absent; another integrity is refused with `conflictCode`.
async function readExactRelease({ name, receipt }, conflictCode) {
  const release = await readRegistryRelease(name, provenance.version, { deadline });
  if (release !== undefined && release.integrity !== receipt.integrity) {
    throw new ReleaseError(conflictCode, name, "the registry's integrity differs from the admitted archive");
  }
  return release;
}

// Calls `probe` until it settles (not undefined) or the propagation window ends; the run's deadline ending it stops the run.
async function pollWithinWindow(probe, name) {
  const windowEnd = Math.min(Date.now() + REGISTRY_PROPAGATION_WINDOW_MS, deadline);
  while (Date.now() < deadline) {
    const settled = await probe();
    if (settled !== undefined) return settled;
    if (Date.now() >= windowEnd && windowEnd < deadline) return undefined;
    await sleep(Math.max(0, Math.min(REGISTRY_POLL_INTERVAL_MS, windowEnd - Date.now())));
  }
  throw new ReleaseError("publish_budget_exhausted", name, "the run's deadline passed while waiting for the registry");
}

// `next` is only read, never moved: it must resolve to this version within the propagation window.
async function requireNextTag(name) {
  let observed;
  const settled = await pollWithinWindow(async () => {
    observed = (await readRegistryDistTags(name, { deadline }))?.next;
    return observed === provenance.version ? true : undefined;
  }, name);
  if (settled === undefined) {
    throw new ReleaseError("dist_tag_conflict", name, `next is ${observed ?? "absent"}, not ${provenance.version}`);
  }
}

// Publishes once, never retrying; readback of the registry decides, not the exit code. Returns true when npm failed but the release is there.
async function publishAndReconcile(plan) {
  if (timeLeft() < PUBLISH_COMMAND_TIMEOUT_SECONDS * 1000 + REGISTRY_PROPAGATION_WINDOW_MS) {
    throw new ReleaseError("publish_budget_exhausted", plan.name, "too little time is left for one publish and its readback");
  }
  const result = await runReleaseCommand("npm", [
    "publish", plan.artifactPath, "--tag", tag, "--access", "public", "--provenance", "--registry", REGISTRY_ORIGIN,
  ], {
    cwd: process.cwd(), env: publishNpmEnvironment(process.env),
    seconds: Math.min(PUBLISH_COMMAND_TIMEOUT_SECONDS, Math.floor(timeLeft() / 1000)),
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  const failed = result.exitCode !== 0 || result.timedOut || result.cause !== undefined;
  const how = result.timedOut ? "timed out" : result.cause ? "could not finish" : `exited with ${result.exitCode}`;
  const failure = failed ? new Error(`npm publish ${how}: ${result.stderr.trim().slice(-NPM_ERROR_EXCERPT_CHARS)}`, { cause: result.cause }) : undefined;
  const release = await pollWithinWindow(() => readExactRelease(plan, "published_integrity_conflict"), plan.name).catch((error) => {
    if (failed && error.code?.startsWith("registry_")) throw new ReleaseError("publish_outcome_unknown", plan.name, "npm publish failed and the readback failed", error);
    throw error;
  });
  if (release === undefined) throw new ReleaseError("publish_outcome_unknown", plan.name, "the release is not visible after the propagation window", failure);
  return failed;
}

const plans = [];
for (const name of packages) {
  const receipt = provenance.packages[name];
  if (!receipt || typeof receipt.filename !== "string" ||
      typeof receipt.sha256 !== "string" || typeof receipt.integrity !== "string") {
    throw new Error(`release receipt is invalid for ${name}`);
  }
  const artifactPath = resolve(artifactDirectory, receipt.filename);
  if (!artifactPath.startsWith(`${artifactDirectory}/`)) {
    throw new Error(`release artifact path escapes its directory for ${name}`);
  }
  const observed = await lstat(artifactPath);
  if (!observed.isFile() || observed.isSymbolicLink()) {
    throw new Error(`release artifact is not a regular file for ${name}`);
  }
  const bytes = await readFile(artifactPath);
  if (sha256(bytes) !== receipt.sha256) {
    throw new Error(`release artifact checksum differs for ${name}`);
  }
  const plan = { name, receipt, artifactPath };
  const existing = await readExactRelease(plan, "existing_release_conflict");
  if (existing !== undefined) await requireNextTag(name);
  plans.push(Object.freeze({ ...plan, status: existing === undefined ? "publish" : "existing" }));
}

for (const plan of plans) {
  if (plan.status === "existing") {
    process.stdout.write(`${plan.name}@${provenance.version} already matches\n`);
    continue;
  }
  const reconciled = await publishAndReconcile(plan);
  await requireNextTag(plan.name);
  process.stdout.write(`${plan.name}@${provenance.version} published and verified${
    reconciled ? " after npm publish failed (reconciled by readback)" : ""}\n`);
}

// A saved result is not trusted: read all five again, resumed ones included, before reporting success.
for (const plan of plans) {
  if (await readExactRelease(plan, "published_integrity_conflict") === undefined) {
    throw new ReleaseError("publish_outcome_unknown", plan.name, "the release is not visible at the final check");
  }
  await requireNextTag(plan.name);
}
process.stdout.write(`all five packages are at ${provenance.version} with next\n`);
