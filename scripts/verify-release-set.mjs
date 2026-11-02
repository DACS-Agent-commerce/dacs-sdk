import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packages as policyPackages, validateArtifactSet, validateFiles } from "./release-checks.mjs";
import { validateReleaseIdentity } from "./release-identity.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Label and compiled-package file checks per policy package. Client and kit have
// no compiled output; their packed files are checked against the policy's allow-list.
const packageDetails = Object.freeze({
  "@kynesyslabs/dacs": { label: "core", requiredFiles: ["dist/index.js", "dist/index.d.ts", "LICENSE"] },
  "@kynesyslabs/dacs-node": {
    label: "host",
    requiredFiles: [
      "dist/index.js",
      "dist/index.d.ts",
      "dist/sqlite.js",
      "dist/demosLoader.js",
      "dist/demosLoaderHook.js",
      "LICENSE",
    ],
  },
  "@kynesyslabs/dacs-client": { label: "client" },
  "@kynesyslabs/dacs-seller": { label: "seller" },
  "create-dacs-agent": {
    label: "generator",
    requiredFiles: ["dist/index.js", "dist/index.d.ts", "dist/bin.js", "LICENSE"],
  },
});
const packageDefinitions = Object.freeze(policyPackages.map((policy) => {
  const details = packageDetails[policy.name];
  if (details === undefined) throw new Error(`release policy names unknown package ${policy.name}`);
  return Object.freeze({
    ...details, name: policy.name, policy, directory: resolve(repoRoot, policy.directory),
  });
}));
const INTERNAL_DEPENDENCY_SECTIONS = ["dependencies", "peerDependencies", "optionalDependencies"];

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const [outputFlag, outputPath, ...extraArgs] = args.filter((arg) => arg !== "--strict");
if (outputFlag !== "--output-dir" || !outputPath || extraArgs.length > 0) {
  throw new Error("usage: node scripts/verify-release-set.mjs --output-dir <new-directory> [--strict]");
}
const outputDirectory = resolve(repoRoot, outputPath);

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, NO_COLOR: "1", ...options.env },
    maxBuffer: 32 * 1024 * 1024,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${commandArgs.join(" ")} failed (${String(result.status)})\n` +
        result.stdout + result.stderr,
    );
  }
  return result.stdout.trim();
}

function runBytes(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    env: { ...process.env, NO_COLOR: "1" },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} failed`);
  }
  return result.stdout;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function assertNewOutputDirectory() {
  try {
    await stat(outputDirectory);
    throw new Error(`output directory already exists: ${outputDirectory}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const parent = await stat(dirname(outputDirectory));
  if (!parent.isDirectory()) throw new Error("release-set output parent is not a directory");
}

async function packOnce(definition, destination) {
  const raw = run("npm", [
    "pack", "--ignore-scripts", "--silent", "--json", "--pack-destination", destination,
  ], { cwd: definition.directory });
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length !== 1 ||
      typeof parsed[0]?.filename !== "string" || !Array.isArray(parsed[0]?.files)) {
    throw new Error(`${definition.label} npm pack metadata is invalid`);
  }
  const path = join(destination, parsed[0].filename);
  const bytes = await readFile(path);
  return Object.freeze({ metadata: parsed[0], path, bytes, sha256: sha256(bytes) });
}

async function inspectPackedManifest(definition, artifact, scratch) {
  const extracted = join(scratch, `extract-${definition.label}`);
  await mkdir(extracted);
  run("tar", ["-xzf", artifact.path, "-C", extracted]);
  const packageRoot = join(extracted, "package");
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  validateReleaseIdentity(manifest, definition.name);
  if (definition.requiredFiles === undefined) {
    validateFiles(definition.policy, manifest, artifact.metadata.files.map((file) => file.path));
  }
  for (const file of definition.requiredFiles ?? []) {
    try {
      const observed = await stat(join(packageRoot, file));
      if (!observed.isFile()) throw new Error("not a file");
    } catch {
      throw new Error(`${definition.label} packed artifact is missing ${file}`);
    }
  }
  return Object.freeze({ manifest, packageRoot });
}

// Why a package cannot be released yet, or undefined when it can be packed.
async function notReadyReason(definition) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(definition.directory, "package.json"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return "missing package manifest";
    throw error;
  }
  return manifest.private !== undefined && manifest.private !== false
    ? "private package is not releasable" : undefined;
}

function assertInternalDependenciesPrecede(artifacts) {
  const order = packageDefinitions.map((definition) => definition.name);
  for (const { manifest } of Object.values(artifacts)) {
    for (const section of INTERNAL_DEPENDENCY_SECTIONS) {
      for (const dependency of Object.keys(manifest[section] ?? {})) {
        if (order.indexOf(dependency) > order.indexOf(manifest.name)) {
          throw new Error(`${manifest.name} depends on ${dependency}, which comes later in policy order`);
        }
      }
    }
  }
}

async function createSbom(definition, artifacts, scratch) {
  const consumer = join(scratch, `sbom-${definition.label}`);
  await mkdir(consumer);
  const own = artifacts[definition.label];
  const declared = new Set(INTERNAL_DEPENDENCY_SECTIONS.flatMap((section) =>
    Object.keys(own.manifest[section] ?? {})));
  const internal = packageDefinitions
    .filter((item) => item.name !== definition.name && declared.has(item.name))
    .map((item) => {
      if (artifacts[item.label] === undefined) {
        throw new Error(`${definition.name} declares ${item.name}, which is not in the release set`);
      }
      return artifacts[item.label];
    });
  const dependencies = Object.fromEntries([...internal, own].map((item) => [
    item.manifest.name,
    `file:${item.artifact.path}`,
  ]));
  const nativeVersion = definition.label === "host"
    ? own.manifest.optionalDependencies?.["better-sqlite3"] : undefined;
  if (nativeVersion !== undefined) dependencies["better-sqlite3"] = nativeVersion;
  await writeFile(join(consumer, "package.json"), `${JSON.stringify({
    name: `dacs-${definition.label}-sbom-root`,
    version: artifacts.core.manifest.version,
    private: true,
    dependencies,
  }, null, 2)}\n`);
  run("npm", [
    "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund",
    ...(definition.label === "core" ? ["--omit=optional"] : []),
  ], { cwd: consumer });
  const raw = run("npm", [
    "sbom", "--package-lock-only", "--sbom-format", "cyclonedx", "--omit=dev",
    ...(definition.label === "core" ? ["--omit=optional"] : []),
  ], { cwd: consumer });
  const sbom = JSON.parse(raw);
  if (sbom.bomFormat !== "CycloneDX" || typeof sbom.specVersion !== "string" ||
      !Array.isArray(sbom.components) || !sbom.components.some((component) =>
        component?.name === definition.name &&
        component?.version === artifacts[definition.label].manifest.version)) {
    throw new Error(`${definition.label} CycloneDX SBOM is incomplete`);
  }
  return Object.freeze({ raw: `${JSON.stringify(sbom, null, 2)}\n`, sbom });
}

await assertNewOutputDirectory();
run("npm", ["run", "build"]);
run("npm", ["run", "host:build"]);
run("npm", ["run", "generator:build"]);

const notReady = [];
const releasable = [];
for (const definition of packageDefinitions) {
  const reason = await notReadyReason(definition);
  if (reason === undefined) releasable.push(definition);
  else notReady.push(`${definition.name}: ${reason}`);
}
if (strict && notReady.length > 0) {
  throw new Error(`strict release requires every package to be releasable: ${notReady.join("; ")}`);
}
for (const reason of notReady) process.stderr.write(`not ready: ${reason}\n`);

const scratch = await mkdtemp(join(tmpdir(), "dacs-release-set-"));
try {
  const firstDirectory = join(scratch, "pack-1");
  const secondDirectory = join(scratch, "pack-2");
  await mkdir(firstDirectory);
  await mkdir(secondDirectory);
  const artifacts = {};
  for (const definition of releasable) {
    const first = await packOnce(definition, firstDirectory);
    const second = await packOnce(definition, secondDirectory);
    if (first.sha256 !== second.sha256 || !first.bytes.equals(second.bytes)) {
      throw new Error(`${definition.label} package is not reproducible`);
    }
    const inspected = await inspectPackedManifest(definition, first, scratch);
    artifacts[definition.label] = Object.freeze({
      definition,
      artifact: first,
      manifest: inspected.manifest,
    });
  }
  if (artifacts.core === undefined) throw new Error("the release set requires the core package");
  const versions = new Set(Object.values(artifacts).map((item) => item.manifest.version));
  const metadata = new Set(Object.values(artifacts)
    .filter((item) => item.manifest.dacs !== undefined)
    .map((item) => JSON.stringify(item.manifest.dacs)));
  const hostPeerDiverges = artifacts.host !== undefined &&
    artifacts.host.manifest.peerDependencies?.["@kynesyslabs/dacs"] !== artifacts.core.manifest.version;
  if (versions.size !== 1 || metadata.size !== 1 || hostPeerDiverges) {
    throw new Error("release package versions, compatibility metadata or host peer diverge");
  }
  if (strict) {
    validateArtifactSet(Object.values(artifacts).map(({ manifest }) => ({ manifest, releasable: true })), true);
    assertInternalDependenciesPrecede(artifacts);
  }
  const sboms = {};
  for (const definition of releasable) {
    sboms[definition.label] = await createSbom(definition, artifacts, scratch);
  }

  await mkdir(outputDirectory);
  for (const definition of releasable) {
    const item = artifacts[definition.label];
    await cp(item.artifact.path, join(outputDirectory, basename(item.artifact.path)));
    await writeFile(join(outputDirectory, `${definition.label}.cdx.json`),
      sboms[definition.label].raw);
  }
  const sourceCommit = run("git", ["rev-parse", "HEAD"]);
  const sourceTree = run("git", ["rev-parse", "HEAD^{tree}"]);
  const trackedDiff = runBytes("git", ["diff", "--binary", "HEAD", "--"]);
  const sourceStatus = runBytes(
    "git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
  );
  const lockfileBytes = await readFile(join(repoRoot, "package-lock.json"));
  const provenance = Object.freeze({
    schema: "dacs-release-set/v1",
    admission: strict ? "strict-five" : "preparation",
    order: releasable.map((definition) => definition.name),
    version: artifacts.core.manifest.version,
    compatibility: artifacts.core.manifest.dacs,
    source: Object.freeze({
      repository: artifacts.core.manifest.repository.url,
      commit: sourceCommit,
      tree: sourceTree,
      clean: trackedDiff.length === 0 && sourceStatus.length === 0,
      trackedDiffSha256: trackedDiff.length === 0 ? null : sha256(trackedDiff),
      worktreeStatusSha256: sourceStatus.length === 0 ? null : sha256(sourceStatus),
      lockfileSha256: sha256(lockfileBytes),
    }),
    toolchain: Object.freeze({ node: process.version, npm: run("npm", ["--version"]) }),
    packages: Object.freeze(Object.fromEntries(releasable.map((definition) => {
      const item = artifacts[definition.label];
      return [definition.name, Object.freeze({
        filename: basename(item.artifact.path),
        bytes: item.artifact.bytes.length,
        sha256: item.artifact.sha256,
        shasum: item.artifact.metadata.shasum,
        integrity: item.artifact.metadata.integrity,
        reproduciblePackCount: 2,
        sbom: `${definition.label}.cdx.json`,
      })];
    }))),
  });
  await writeFile(join(outputDirectory, "release-provenance.json"),
    `${JSON.stringify(provenance, null, 2)}\n`);
  await writeFile(join(outputDirectory, "SHA256SUMS"),
    releasable.map((definition) => {
      const item = artifacts[definition.label];
      return `${item.artifact.sha256}  ${basename(item.artifact.path)}`;
    }).sort().join("\n") + "\n");
  process.stdout.write(`${JSON.stringify(provenance, null, 2)}\n`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
