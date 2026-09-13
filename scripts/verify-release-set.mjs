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

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDefinitions = Object.freeze([
  Object.freeze({
    label: "core",
    name: "@kynesyslabs/dacs",
    directory: repoRoot,
    requiredFiles: ["dist/index.js", "dist/index.d.ts", "LICENSE"],
  }),
  Object.freeze({
    label: "host",
    name: "@kynesyslabs/dacs-node",
    directory: join(repoRoot, "packages", "dacs-node"),
    requiredFiles: [
      "dist/index.js",
      "dist/index.d.ts",
      "dist/sqlite.js",
      "dist/demosLoader.js",
      "dist/demosLoaderHook.js",
      "LICENSE",
    ],
  }),
  Object.freeze({
    label: "generator",
    name: "create-dacs-agent",
    directory: join(repoRoot, "packages", "create-dacs-agent"),
    requiredFiles: ["dist/index.js", "dist/index.d.ts", "dist/bin.js", "LICENSE"],
  }),
]);

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--output-dir" || !args[1]) {
  throw new Error("usage: node scripts/verify-release-set.mjs --output-dir <new-directory>");
}
const outputDirectory = resolve(repoRoot, args[1]);

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
  if (manifest.name !== definition.name || manifest.license !== "MIT" ||
      manifest.repository?.url !==
        "git+https://github.com/DACS-Agent-commerce/dacs-sdk.git" ||
      manifest.publishConfig?.access !== "public" ||
      manifest.publishConfig?.provenance !== true) {
    throw new Error(`${definition.label} release identity or publish policy is invalid`);
  }
  for (const file of definition.requiredFiles) {
    try {
      const observed = await stat(join(packageRoot, file));
      if (!observed.isFile()) throw new Error("not a file");
    } catch {
      throw new Error(`${definition.label} packed artifact is missing ${file}`);
    }
  }
  return Object.freeze({ manifest, packageRoot });
}

async function createSbom(definition, artifacts, scratch) {
  const consumer = join(scratch, `sbom-${definition.label}`);
  await mkdir(consumer);
  const dependencyArtifacts = definition.label === "host"
    ? [artifacts.core, artifacts.host] : [artifacts[definition.label]];
  const dependencies = Object.fromEntries(dependencyArtifacts.map((item) => [
    item.manifest.name,
    `file:${item.artifact.path}`,
  ]));
  if (definition.label === "host") dependencies["better-sqlite3"] = "12.6.2";
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

const scratch = await mkdtemp(join(tmpdir(), "dacs-release-set-"));
try {
  const firstDirectory = join(scratch, "pack-1");
  const secondDirectory = join(scratch, "pack-2");
  await mkdir(firstDirectory);
  await mkdir(secondDirectory);
  const artifacts = {};
  for (const definition of packageDefinitions) {
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
  const versions = new Set(Object.values(artifacts).map((item) => item.manifest.version));
  const metadata = new Set(Object.values(artifacts).map((item) =>
    JSON.stringify(item.manifest.dacs)));
  if (versions.size !== 1 || metadata.size !== 1 ||
      artifacts.host.manifest.peerDependencies?.["@kynesyslabs/dacs"] !==
        artifacts.core.manifest.version) {
    throw new Error("release package versions, compatibility metadata or host peer diverge");
  }
  const sboms = {};
  for (const definition of packageDefinitions) {
    sboms[definition.label] = await createSbom(definition, artifacts, scratch);
  }

  await mkdir(outputDirectory);
  for (const definition of packageDefinitions) {
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
    packages: Object.freeze(Object.fromEntries(packageDefinitions.map((definition) => {
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
    packageDefinitions.map((definition) => {
      const item = artifacts[definition.label];
      return `${item.artifact.sha256}  ${basename(item.artifact.path)}`;
    }).sort().join("\n") + "\n");
  process.stdout.write(`${JSON.stringify(provenance, null, 2)}\n`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
