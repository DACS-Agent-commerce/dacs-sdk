import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--output-dir" || !args[1])) {
  throw new Error("usage: node scripts/verify-package.mjs [--output-dir <new-directory>]");
}
const requestedOutput = args.length === 0 ? null : resolve(repoRoot, args[1]);

async function validateOutputDestination() {
  if (!requestedOutput) return;
  try {
    await stat(requestedOutput);
    throw new Error(`output directory already exists: ${requestedOutput}`);
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  const parent = await stat(dirname(requestedOutput));
  if (!parent.isDirectory()) throw new Error(`output parent is not a directory: ${dirname(requestedOutput)}`);
}

function runRaw(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, NO_COLOR: "1", ...options.env },
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${commandArgs.join(" ")} failed (${result.status})\n${result.stdout.toString("utf8")}${result.stderr.toString("utf8")}`,
    );
  }
  return result.stdout;
}

function run(command, commandArgs, options = {}) {
  return runRaw(command, commandArgs, options).toString("utf8").trim();
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertNoUntrackedInputs() {
  const status = run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const untracked = status
    .split("\0")
    .filter((entry) => entry.startsWith("?? "))
    .map((entry) => entry.slice(3));
  if (untracked.length) {
    throw new Error(
      `refusing to package untracked inputs; add, ignore, or remove them first: ${untracked.join(", ")}`,
    );
  }
}

async function listFiles(root, relative = "") {
  const entries = await readdir(join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const path = join(relative, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(root, path)));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`package contains unsupported filesystem entry: ${path}`);
  }
  return files;
}

function packageTargets(manifest) {
  const targets = [];
  function collect(value, location) {
    if (value === null) return;
    if (typeof value === "string") {
      targets.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const [index, entry] of value.entries()) collect(entry, `${location}[${index}]`);
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) collect(entry, `${location}.${key}`);
      return;
    }
    throw new Error(`unsupported package target at ${location}: ${typeof value}`);
  }

  collect(manifest.exports ?? {}, "exports");
  collect(manifest.bin ?? {}, "bin");
  return [...new Set(targets.map((target) => target.replace(/^\.\//, "")))].sort();
}

async function assertPureSubpaths(extractedRoot) {
  const forbidden = [
    "@kynesyslabs/demosdk",
    "@x402/evm",
    "@x402/fetch",
    '"viem',
    "'viem",
    "/substrate/",
    "/rails/",
  ];
  const roots = [join(extractedRoot, "dist", "canonical"), join(extractedRoot, "dist", "artifacts")];
  for (const root of roots) {
    for (const relative of await listFiles(root)) {
      const supported = [".js", ".d.ts", ".js.map", ".d.ts.map"];
      if (!supported.some((extension) => relative.endsWith(extension))) {
        throw new Error(`cannot inspect unexpected pure-subpath emit: ${relative}`);
      }
      const text = await readFile(join(root, relative), "utf8");
      const match = forbidden.find((value) => text.includes(value));
      if (match) throw new Error(`${relative} reaches forbidden optional/live dependency ${match}`);
    }
  }
}

async function pack(destination) {
  const raw = run("npm", [
    "pack",
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    destination,
  ]);
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error(`npm pack returned ${Array.isArray(parsed) ? parsed.length : "invalid"} records`);
  }
  const metadata = parsed[0];
  const path = join(destination, metadata.filename);
  const bytes = await readFile(path);
  return { metadata, path, bytes, sha256: sha256(bytes) };
}

await validateOutputDestination();
assertNoUntrackedInputs();
run("npm", ["run", "clean"]);
run("npm", ["run", "build"]);

const scratch = await mkdtemp(join(tmpdir(), "dacs-sdk-package-"));
try {
  const firstDir = join(scratch, "pack-1");
  const secondDir = join(scratch, "pack-2");
  await mkdir(firstDir);
  await mkdir(secondDir);

  const first = await pack(firstDir);
  const second = await pack(secondDir);
  if (first.sha256 !== second.sha256 || !first.bytes.equals(second.bytes)) {
    throw new Error(`package is not reproducible: ${first.sha256} != ${second.sha256}`);
  }

  const extracted = join(scratch, "extracted");
  await mkdir(extracted);
  run("tar", ["-xzf", first.path, "-C", extracted]);
  const packageRoot = join(extracted, "package");
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const files = await listFiles(packageRoot);
  const targets = packageTargets(manifest);
  const missingTargets = targets.filter((target) => !files.includes(target));
  if (missingTargets.length) {
    throw new Error(`packed artifact is missing declared targets: ${missingTargets.join(", ")}`);
  }
  if (manifest.name !== "@kynesyslabs/dacs" || manifest.license !== "MIT") {
    throw new Error("packed package identity or license is incorrect");
  }
  if (manifest.repository?.url !== "git+https://github.com/DACS-Agent-commerce/dacs-sdk.git") {
    throw new Error("packed package has no exact official source repository");
  }
  await assertPureSubpaths(packageRoot);

  const consumer = join(scratch, "consumer");
  await mkdir(consumer);
  await cp(first.path, join(consumer, "sdk.tgz"));
  await writeFile(
    join(consumer, "package.json"),
    `${JSON.stringify(
      {
        name: "dacs-sdk-package-consumer",
        private: true,
        type: "module",
        dependencies: { "@kynesyslabs/dacs": "file:./sdk.tgz" },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(consumer, "index.ts"),
    [
      'import { canonicalize, contentHash } from "@kynesyslabs/dacs/canonical";',
      'import { isAttestationRef } from "@kynesyslabs/dacs/artifacts";',
      "const canonical = canonicalize({ z: 2, a: 1.5 });",
      'if (canonical !== \'{"a":1.5,"z":2}\') throw new Error(`unexpected canonical bytes: ${canonical}`);',
      'if (contentHash({ z: 2, a: 1.5 }) !== contentHash({ a: 1.5, z: 2 })) throw new Error("hash drift");',
      'if (!isAttestationRef({ anchor: { kind: "storage-program", locator: "demos:test" }, contentHash: "a".repeat(64) })) throw new Error("artifact import failed");',
      'console.log(JSON.stringify({ canonical, artifactSubpath: "ok" }));',
      "",
    ].join("\n"),
  );

  const bunCache = join(scratch, "bun-cache");
  await mkdir(bunCache);
  run("bun", ["install", "--ignore-scripts", "--cache-dir", bunCache], { cwd: consumer });
  const optionalPeers = [
    "@kynesyslabs/demosdk",
    "@x402/evm",
    "@x402/fetch",
    "viem",
  ];
  for (const peer of optionalPeers) {
    try {
      await stat(join(consumer, "node_modules", ...peer.split("/")));
      throw new Error(`optional peer was installed for pure subpaths: ${peer}`);
    } catch (error) {
      if (error && error.code !== "ENOENT") throw error;
    }
  }
  const onlineOutput = run("bun", ["run", "index.ts"], { cwd: consumer });
  await rm(join(consumer, "node_modules"), { recursive: true, force: false });
  run(
    "bun",
    [
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--cache-dir",
      bunCache,
      "--registry",
      "http://127.0.0.1:1",
    ],
    { cwd: consumer },
  );
  const offlineOutput = run("bun", ["run", "index.ts"], { cwd: consumer });
  if (onlineOutput !== offlineOutput) throw new Error("online and offline consumer outputs differ");

  const sourceCommit = run("git", ["rev-parse", "HEAD"]);
  const sourceTree = run("git", ["rev-parse", "HEAD^{tree}"]);
  const trackedDiff = runRaw("git", ["diff", "--binary", "HEAD", "--"]);
  const lockfileBytes = await readFile(join(repoRoot, "package-lock.json"));
  const provenance = {
    schema: "dacs-sdk-package-artifact/v1",
    package: { name: manifest.name, version: manifest.version, license: manifest.license },
    source: {
      repository: manifest.repository.url,
      commit: sourceCommit,
      tree: sourceTree,
      clean: trackedDiff.length === 0,
      trackedDiffSha256: trackedDiff.length === 0 ? null : sha256(trackedDiff),
      lockfileSha256: sha256(lockfileBytes),
    },
    toolchain: {
      node: process.version,
      npm: run("npm", ["--version"]),
      bun: run("bun", ["--version"]),
    },
    artifact: {
      filename: first.metadata.filename,
      bytes: first.bytes.length,
      sha256: first.sha256,
      shasum: first.metadata.shasum,
      integrity: first.metadata.integrity,
      reproduciblePackCount: 2,
      files,
      declaredTargets: targets,
    },
    consumer: {
      imports: ["@kynesyslabs/dacs/canonical", "@kynesyslabs/dacs/artifacts"],
      optionalPeersAbsent: optionalPeers,
      onlineInstall: "pass",
      offlineFrozenRematerialization: "pass",
      offlineConstraint: "isolated populated cache and unreachable loopback registry",
      outputSha256: sha256(onlineOutput),
    },
  };

  if (requestedOutput) {
    await mkdir(requestedOutput, { recursive: false });
    await cp(first.path, join(requestedOutput, basename(first.path)));
    await writeFile(join(requestedOutput, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(provenance, null, 2)}\n`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
