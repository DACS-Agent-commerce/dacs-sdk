#!/usr/bin/env node
// Build the unmodified generated Dockerfile with this checkout's package set,
// then execute its zero-spend image smoke against a real Docker daemon.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDacsAgentProject } from "../packages/create-dacs-agent/dist/index.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(join(tmpdir(), "dacs-real-image-"));
const rail = process.argv[2];
assert(["x402", "pay-dem"].includes(rail), "select x402 or pay-dem");
const project = join(root, "agent");
const image = `dacs-generated-ci-${rail}:${process.pid}`;
const server = createServer();
let imageBuilt = false;
function run(command, args, cwd = repo, extraEnv = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", shell: false,
      env: { ...process.env, ...extraEnv } });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolvePromise()
      : reject(new Error(`${command} failed (${signal ?? code})`)));
  });
}
try {
  // Ignore prepack rebuilds: the CI job builds these packages before packing.
  await run("npm", ["pack", "--ignore-scripts", "--pack-destination", root]);
  await run("npm", ["pack", "--ignore-scripts", "--workspace", "@kynesyslabs/dacs-node", "--pack-destination", root]);
  const packs = (await readdir(root)).filter((name) => name.endsWith(".tgz"));
  assert.equal(packs.length, 2);
  server.on("request", (request, response) => {
    const name = request.url?.slice(1);
    if (!packs.includes(name)) { response.writeHead(404).end(); return; }
    createReadStream(join(root, name)).on("error", () => response.destroy()).pipe(response);
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const port = server.address().port;
  await createDacsAgentProject({ targetDirectory: project, mode: "live-demos", role: "buyer",
    deployment: "docker", rails: rail, install: false });
  await writeFile(join(project, ".env"), await readFile(join(project, ".env.example")), { mode: 0o600 });
  const manifestPath = join(project, "package.json");
  const original = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(original);
  for (const name of ["@kynesyslabs/dacs", "@kynesyslabs/dacs-node"]) {
    const prefix = name.slice(1).replaceAll("/", "-") + "-";
    const pack = packs.find((file) => file.startsWith(prefix));
    assert(pack, `missing ${name} tarball`);
    manifest.dependencies[name] = `http://127.0.0.1:${port}/${pack}`;
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  await run("npm", ["install", "--package-lock-only", "--ignore-scripts", "--omit=optional", "--no-audit", "--no-fund"], project);
  // Keep the generated manifest unchanged; the lock pins the exact packed
  // versions and integrity, fetched through loopback during the host-network build.
  const lockPath = join(project, "package-lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  lock.packages[""].dependencies = JSON.parse(original).dependencies;
  await writeFile(lockPath, JSON.stringify(lock, null, 2) + "\n");
  await writeFile(manifestPath, original);
  // Reconcile optional peer placement after switching the root back to version
  // pins. A single lock-only resolution can leave npm's viem peers inconsistent.
  await run("npm", ["install", "--package-lock-only", "--ignore-scripts", "--omit=optional", "--no-audit", "--no-fund"], project);
  assert.equal(await readFile(manifestPath, "utf8"), original);
  await run("npm", ["ci", "--dry-run", "--ignore-scripts", "--omit=optional", "--no-audit", "--no-fund"], project);
  await run("docker", ["build", "--network", "host", "--tag", image, "."], project,
    { DOCKER_BUILDKIT: "0" });
  imageBuilt = true;
  await run(process.execPath, ["scripts/docker-runtime-smoke.mjs"], project, { DACS_IMAGE: image });
  const receipt = JSON.parse(await readFile(join(project, ".dacs-runtime", "docker-image-smoke.json"), "utf8"));
  assert.equal(receipt.receiptVersion, 1);
  assert.equal(receipt.image, image);
  assert.match(receipt.imageId, /^sha256:[a-f0-9]{64}$/);
} finally {
  await new Promise((resolvePromise) => server.close(resolvePromise));
  if (imageBuilt) await run("docker", ["image", "rm", "--force", image]).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
