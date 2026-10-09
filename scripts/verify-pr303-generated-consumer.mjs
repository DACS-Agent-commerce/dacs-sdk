#!/usr/bin/env node
/**
 * Generated live-consumer verification for PR #303.
 *
 * Mirrors the CI `packed-live-rail` job for both rails: pack the exact
 * three-package release set, install the packed generator, generate a fresh
 * live-demos buyer project, install the exact local core/host tarballs with
 * the pinned TypeScript and Node types, rebuild the reviewed SQLite adapter,
 * then typecheck, run the generated fixture tests and the generated offline
 * smoke, and prove rail-specific dependency/configuration isolation.
 *
 * Network use is limited to public npm package (and better-sqlite3 native)
 * downloads made by npm itself. No live RPC, testnet, wallet or funded action
 * is configured or run. Shell-free; fixed commands; finite per-step budgets.
 *
 * usage: node scripts/verify-pr303-generated-consumer.mjs --output-dir <dir>
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RAILS = Object.freeze(["x402", "pay-dem"]);
const PROFILE = "dacs-sdk:fixed-price-x402:v1";
const TYPESCRIPT = "typescript@5.9.2";
const NODE_TYPES = "@types/node@20.19.1";
const X402_DEPENDENCIES = Object.freeze(["@x402/core", "@x402/evm", "@x402/fetch", "viem"]);
const REQUIRED_GENERATED_TESTS = Object.freeze([
  "authenticated lifecycle backup restores both roles and rejects tampering",
  "upgrade check proves compatible stores without writing",
  "upgrade check blocks an unfinished irreversible effect",
]);
const MINUTE = 60_000;

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--output-dir" || !args[1]) {
  throw new Error("usage: node scripts/verify-pr303-generated-consumer.mjs --output-dir <dir>");
}
const outputDirectory = resolve(args[1]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha512Integrity(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function prepareOutputDirectory() {
  try {
    const observed = await stat(outputDirectory);
    if (!observed.isDirectory() || (await readdir(outputDirectory)).length !== 0) {
      throw new Error(`output directory must be new or empty: ${outputDirectory}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(outputDirectory, { recursive: true });
  }
}

const steps = [];

/** Run one fixed command without a shell and keep its complete log as evidence. */
async function step(name, command, commandArgs, options) {
  const started = Date.now();
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd,
    env: { ...process.env, NO_COLOR: "1", npm_config_update_notifier: "false" },
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: options.timeoutMs,
    killSignal: "SIGKILL",
    shell: false,
  });
  const logName = `${name}.log`;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  await writeFile(join(outputDirectory, logName),
    `$ ${[command, ...commandArgs].join(" ")}\n(cwd ${options.cwd})\n\n` +
      `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);
  const record = {
    name,
    command: [command, ...commandArgs],
    cwd: options.cwd,
    exitCode: result.status,
    signal: result.signal,
    timedOut: result.error?.code === "ETIMEDOUT",
    durationMs: Date.now() - started,
    log: logName,
  };
  steps.push(record);
  if (result.error && result.error.code !== "ETIMEDOUT") {
    throw new Error(`${name} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${name} failed (exit ${String(result.status)}, signal ${String(result.signal)})`);
  }
  return { stdout, stderr };
}

function nodeTestSummary(output) {
  const summary = {};
  for (const match of output.matchAll(/^[#ℹ] (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)/gmu)) {
    summary[match[1]] = Number(match[2]);
  }
  return summary;
}

function requiredTestsPassed(output) {
  return Object.fromEntries(REQUIRED_GENERATED_TESTS.map((name) => {
    const passed = output.split("\n").some((line) =>
      new RegExp(`^\\s*(?:ok \\d+ - |✔ )${escapeRegExp(name)}(?:\\s|$)`, "u").test(line) &&
        !/# (?:SKIP|TODO)/i.test(line));
    return [name, passed];
  }));
}

async function packageIntegrity(generated, packageName, tarball) {
  const lock = JSON.parse(
    await readFile(join(generated, "node_modules", ".package-lock.json"), "utf8"),
  );
  const entry = lock.packages?.[`node_modules/${packageName}`];
  const installed = JSON.parse(await readFile(
    join(generated, "node_modules", ...packageName.split("/"), "package.json"),
    "utf8",
  ));
  const expectedIntegrity = sha512Integrity(tarball.bytes);
  return {
    package: packageName,
    version: installed.version,
    resolved: entry?.resolved ?? null,
    integrity: entry?.integrity ?? null,
    exactLocalTarball: typeof entry?.resolved === "string" &&
      entry.resolved.startsWith("file:") && entry.resolved.endsWith(tarball.filename) &&
      entry.integrity === expectedIntegrity,
  };
}

async function installedVersion(generated, packageName) {
  try {
    return JSON.parse(await readFile(
      join(generated, "node_modules", ...packageName.split("/"), "package.json"),
      "utf8",
    )).version;
  } catch {
    return null;
  }
}

/** Port of the CI "Prove rail-specific dependency and configuration isolation" step. */
async function railIsolation(generated, rail) {
  const manifest = JSON.parse(await readFile(join(generated, "package.json"), "utf8"));
  const environment = await readFile(join(generated, ".env.example"), "utf8");
  const compose = await readFile(join(generated, "compose.yaml"), "utf8");
  const configuration = `${environment}\n${compose}`;
  const dependencies = manifest.dependencies || {};
  const has = (name) => Object.prototype.hasOwnProperty.call(dependencies, name);
  const violations = [];
  const rejectConfig = (prefixes) => {
    for (const line of configuration.split("\n")) {
      if (prefixes.some((prefix) => line.trimStart().startsWith(prefix))) {
        violations.push(`${rail} generated unrelated configuration: ${line}`);
      }
    }
  };
  if (Object.values(dependencies).some((value) =>
    value.startsWith("file:") || value.startsWith("git+"))) {
    violations.push("generated manifest contains a non-registry dependency");
  }
  if (rail === "pay-dem") {
    for (const name of X402_DEPENDENCIES) {
      if (has(name) || existsSync(join(generated, "node_modules", ...name.split("/")))) {
        violations.push(`pay-dem consumer contains ${name}`);
      }
    }
    rejectConfig(["DACS_X402_", "DACS_EVM_", "DACS_FIXED_PRICE_AMOUNT", "DACS_MAX_EVM_"]);
  } else {
    for (const name of X402_DEPENDENCIES) {
      if (!has(name)) violations.push(`x402 consumer omits ${name}`);
    }
    rejectConfig(["DACS_PAY_DEM_", "DACS_MAX_PAY_DEM_"]);
  }
  return { dependencies, violations };
}

async function releaseSetComparison(packs) {
  const sums = join(dirname(outputDirectory), "release-set", "SHA256SUMS");
  if (!existsSync(sums)) return { status: "absent", path: sums };
  const expected = new Map((await readFile(sums, "utf8")).trim().split("\n").map((line) => {
    const [digest, filename] = line.split(/\s+/);
    return [filename, digest];
  }));
  const packages = Object.fromEntries(Object.values(packs).map((item) =>
    [item.filename, { packed: item.sha256, releaseSet: expected.get(item.filename) ?? null }]));
  const matched = Object.values(packages).every((item) => item.packed === item.releaseSet);
  return { status: matched ? "matched" : "mismatched", path: sums, packages };
}

await prepareOutputDirectory();
const started = Date.now();
const version = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")).version;
const scratch = await mkdtemp(join(tmpdir(), "dacs-pr303-consumer-"));
const report = {
  schema: "dacs-pr303-generated-consumer/v1",
  packageVersion: version,
  toolchain: { node: process.version },
  network: "public npm registry and better-sqlite3 native artifacts only; no live services",
  packs: {},
  releaseSet: null,
  rails: {},
  failures: [],
};
try {
  report.toolchain.npm = (await step("npm-version", "npm", ["--version"],
    { cwd: repoRoot, timeoutMs: MINUTE })).stdout.trim();
  const packs = join(scratch, "packs");
  const runner = join(scratch, "runner");
  await mkdir(packs);
  await mkdir(runner);
  await step("pack-core", "npm", ["pack", "--pack-destination", packs],
    { cwd: repoRoot, timeoutMs: 15 * MINUTE });
  await step("pack-host", "npm",
    ["pack", "--workspace", "@kynesyslabs/dacs-node", "--pack-destination", packs],
    { cwd: repoRoot, timeoutMs: 15 * MINUTE });
  await step("pack-generator", "npm",
    ["pack", "--workspace", "create-dacs-agent", "--pack-destination", packs],
    { cwd: repoRoot, timeoutMs: 15 * MINUTE });
  const tarballs = {};
  for (const [label, filename] of [
    ["core", `kynesyslabs-dacs-${version}.tgz`],
    ["host", `kynesyslabs-dacs-node-${version}.tgz`],
    ["generator", `create-dacs-agent-${version}.tgz`],
  ]) {
    const path = join(packs, filename);
    const bytes = await readFile(path);
    tarballs[label] = { filename, path, bytes, sha256: sha256(bytes) };
    await copyFile(path, join(outputDirectory, filename));
    report.packs[label] = { filename, bytes: bytes.length, sha256: tarballs[label].sha256 };
  }
  await writeFile(join(outputDirectory, "SHA256SUMS"), Object.values(tarballs)
    .map((item) => `${item.sha256}  ${item.filename}`).sort().join("\n") + "\n");
  report.releaseSet = await releaseSetComparison(tarballs);
  if (report.releaseSet.status === "mismatched") {
    report.failures.push("packed tarballs differ from the verified release set");
  }
  await step("install-generator", "npm", [
    "install", "--prefix", runner, "--no-audit", "--ignore-scripts", tarballs.generator.path,
  ], { cwd: repoRoot, timeoutMs: 15 * MINUTE });
  const bin = join(runner, "node_modules", "create-dacs-agent", "dist", "bin.js");

  for (const rail of RAILS) {
    const railRoot = join(scratch, rail);
    const generated = join(railRoot, "generated");
    await mkdir(railRoot);
    const railReport = { status: "failed" };
    report.rails[rail] = railReport;
    try {
      await step(`${rail}-generate`, process.execPath, [
        bin, generated, "--yes", "--mode", "live-demos", "--profile", PROFILE,
        "--role", "buyer", "--rails", rail, "--deploy", "docker", "--no-install",
      ], { cwd: railRoot, timeoutMs: 5 * MINUTE });
      await step(`${rail}-install`, "npm", [
        "install", "--no-audit", "--no-save", "--ignore-scripts", "--omit=optional",
        tarballs.core.path, tarballs.host.path, TYPESCRIPT, NODE_TYPES,
      ], { cwd: generated, timeoutMs: 20 * MINUTE });
      await step(`${rail}-rebuild-sqlite`, "npm", ["rebuild", "better-sqlite3"],
        { cwd: generated, timeoutMs: 15 * MINUTE });
      railReport.installed = {
        core: await packageIntegrity(generated, "@kynesyslabs/dacs", tarballs.core),
        host: await packageIntegrity(generated, "@kynesyslabs/dacs-node", tarballs.host),
        typescript: await installedVersion(generated, "typescript"),
        nodeTypes: await installedVersion(generated, "@types/node"),
        betterSqlite3: await installedVersion(generated, "better-sqlite3"),
        demosdk: await installedVersion(generated, "@kynesyslabs/demosdk"),
      };
      await copyFile(join(generated, "package.json"),
        join(outputDirectory, `${rail}-generated-package.json`));
      await step(`${rail}-typecheck`, "npm", ["run", "typecheck"],
        { cwd: generated, timeoutMs: 15 * MINUTE });
      const tested = await step(`${rail}-test`, "npm", ["test"],
        { cwd: generated, timeoutMs: 20 * MINUTE });
      const testOutput = `${tested.stdout}\n${tested.stderr}`;
      railReport.tests = {
        summary: nodeTestSummary(testOutput),
        required: requiredTestsPassed(testOutput),
      };
      const smoke = await step(`${rail}-offline-smoke`, "npm", ["run", "dacs:smoke:offline"],
        { cwd: generated, timeoutMs: 15 * MINUTE });
      const smokeLine = smoke.stdout.split("\n").reverse()
        .find((line) => line.includes("dacs.offline-simulation.complete"));
      railReport.offlineSmoke = smokeLine === undefined ? null : JSON.parse(smokeLine);
      railReport.isolation = await railIsolation(generated, rail);

      const problems = [];
      if (!railReport.installed.core.exactLocalTarball ||
          !railReport.installed.host.exactLocalTarball) {
        problems.push("installed SDK packages are not the exact packed tarballs");
      }
      if (railReport.installed.typescript !== "5.9.2" ||
          railReport.installed.nodeTypes !== "20.19.1") {
        problems.push("generated consumer did not install the pinned TypeScript toolchain");
      }
      const summary = railReport.tests.summary;
      if (!(summary.pass > 0) || summary.fail !== 0 || (summary.cancelled ?? 0) !== 0) {
        problems.push("generated test summary is missing, failing or cancelled");
      }
      for (const [name, passed] of Object.entries(railReport.tests.required)) {
        if (!passed) problems.push(`required generated test did not pass: ${name}`);
      }
      if (railReport.offlineSmoke?.simulationPassed !== true) {
        problems.push("generated offline smoke did not report simulationPassed");
      }
      problems.push(...railReport.isolation.violations);
      railReport.problems = problems;
      railReport.status = problems.length === 0 ? "passed" : "failed";
      if (problems.length !== 0) report.failures.push(...problems.map((item) => `${rail}: ${item}`));
    } catch (error) {
      railReport.error = error instanceof Error ? error.message : String(error);
      report.failures.push(`${rail}: ${railReport.error}`);
    }
  }
} catch (error) {
  report.failures.push(error instanceof Error ? error.message : String(error));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
report.steps = steps;
report.durationMs = Date.now() - started;
report.passed = report.failures.length === 0 &&
  RAILS.every((rail) => report.rails[rail]?.status === "passed");
await writeFile(join(outputDirectory, "generated-consumer.json"),
  `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.passed ? 0 : 1;
