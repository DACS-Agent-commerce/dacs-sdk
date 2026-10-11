import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--artifact-dir" || !args[1] ||
    args[2] !== "--tag" || !args[3]) {
  throw new Error("usage: publish-release-set --artifact-dir <dir> --tag <tag>");
}
if (process.env.GITHUB_ACTIONS !== "true") {
  throw new Error("release publication is restricted to the reviewed GitHub workflow");
}
const artifactDirectory = resolve(args[1]);
const tag = args[3];
if (!/^[a-z][a-z0-9-]{0,31}$/u.test(tag)) throw new Error("release tag is invalid");

const provenance = JSON.parse(
  await readFile(resolve(artifactDirectory, "release-provenance.json"), "utf8"),
);
if (provenance?.schema !== "dacs-release-set/v1" ||
    typeof provenance.version !== "string" ||
    !provenance.version.includes("-") || provenance.source?.clean !== true ||
    typeof provenance.packages !== "object" || provenance.packages === null) {
  throw new Error("release provenance is absent, dirty or not a prerelease");
}
if (process.env.DACS_NPM_PUBLISH_CONFIRM !==
    `publish:${provenance.version}:${tag}`) {
  throw new Error("exact release publication confirmation is absent");
}

const packages = [
  "@kynesyslabs/dacs",
  "@kynesyslabs/dacs-node",
  "create-dacs-agent",
];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function registryRelease(name) {
  let response;
  try {
    response = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(name)}/${
        encodeURIComponent(provenance.version)}`,
      {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch {
    throw new Error(`registry lookup unavailable for ${name}`);
  }
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`registry lookup failed closed for ${name}`);
  const body = await response.json();
  if (body?.name !== name || body?.version !== provenance.version ||
      typeof body?.dist?.integrity !== "string") {
    throw new Error(`registry returned invalid release metadata for ${name}`);
  }
  return body;
}

async function waitForExactRelease(name, integrity) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const observed = await registryRelease(name);
    if (observed?.dist?.integrity === integrity) return;
    if (observed !== undefined) {
      throw new Error(`published integrity conflict for ${name}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
  }
  throw new Error(`published release did not become visible for ${name}`);
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
  const existing = await registryRelease(name);
  if (existing !== undefined) {
    if (existing.dist.integrity !== receipt.integrity) {
      throw new Error(`existing registry release conflicts for ${name}`);
    }
    plans.push(Object.freeze({ name, receipt, artifactPath, status: "existing" }));
  } else {
    plans.push(Object.freeze({ name, receipt, artifactPath, status: "publish" }));
  }
}

for (const plan of plans) {
  if (plan.status === "existing") {
    process.stdout.write(`${plan.name}@${provenance.version} already matches\n`);
    continue;
  }
  const result = spawnSync("npm", [
    "publish", plan.artifactPath, "--tag", tag, "--access", "public", "--provenance",
  ], {
    stdio: "inherit",
    env: { ...process.env, NPM_CONFIG_PROVENANCE: "true" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm publish failed for ${plan.name}`);
  await waitForExactRelease(plan.name, plan.receipt.integrity);
  process.stdout.write(`${plan.name}@${provenance.version} published and verified\n`);
}
