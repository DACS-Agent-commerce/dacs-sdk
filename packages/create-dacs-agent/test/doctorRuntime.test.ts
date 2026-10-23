import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, expect, test } from "vitest";
import { projectTemplates } from "../src/index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

// Execute the generated doctor's deployment probe with real child processes.
// post-start avoids binding ports; all Docker commands go to this read-only fake.
async function probe(scenario: Record<string, unknown>, deployment = "docker") {
  const root = await mkdtemp(join(tmpdir(), "dacs-doctor-runtime-"));
  directories.push(root);
  await mkdir(join(root, "bin"));
  const log = join(root, "calls.jsonl");
  const fake = join(root, "bin", "docker");
  await writeFile(fake, `#!${process.execPath}
const fs = require("node:fs");
const scenario = JSON.parse(process.env.DACS_TEST_DOCKER_SCENARIO);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.DACS_TEST_DOCKER_LOG, JSON.stringify(args) + "\\n");
const compose = args[0] === "compose";
if (scenario.hang === (compose ? "compose" : "docker")) setInterval(() => {}, 1000);
else {
  console.log(compose ? (scenario.compose ?? "2.40.3") : (scenario.docker ?? "28.5.1 28.5.1"));
  process.exit(compose ? (scenario.composeExit ?? 0) : (scenario.dockerExit ?? 0));
}
`);
  await chmod(fake, 0o755);
  const source = projectTemplates({ packageName: "agent", mode: "live-demos", role: "buyer",
    deployment: "docker", rails: "pay-dem" })["src/doctor.ts"]!;
  const start = source.indexOf("async function dockerRuntime(");
  expect(start).toBeGreaterThan(0);
  const end = source.indexOf("\n}\n", start) + 2;
  const script = ts.transpileModule(`
import { spawn } from "node:child_process";
const ROLES = ["buyer", "seller"];
const serviceEndpoint = (role) => role === "buyer" ? "http://127.0.0.1:3101" : "http://127.0.0.1:3102";
const pass = (facts) => ({ status: "pass", facts });
const fail = (reasonCode) => ({ status: "fail", reasonCode });
const blocked = (reasonCode) => ({ status: "blocked", reasonCode });
${source.slice(start, end)}
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 500);
try { console.log(JSON.stringify(await dockerRuntime({ phase: "post-start", signal: controller.signal }))); }
finally { clearTimeout(timer); }
`, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const entry = join(root, "probe.mjs");
  await writeFile(entry, script);
  const result = spawnSync(process.execPath, [entry], { encoding: "utf8", timeout: 5000,
    env: { PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`, DACS_DEPLOYMENT: deployment,
      DACS_RUNTIME_UID: "4242", DACS_RUNTIME_GID: "4343", DACS_TEST_DOCKER_LOG: log,
      DACS_TEST_DOCKER_SCENARIO: JSON.stringify(scenario) } });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  const calls = await readFile(log, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return { report: JSON.parse(result.stdout), calls: calls.trim() ? calls.trim().split("\n").map((line) => JSON.parse(line)) : [] };
}

const dockerCall = ["version", "--format", "{{.Client.Version}} {{.Server.Version}}"];
const composeCall = ["compose", "version", "--short"];

test.runIf(process.platform !== "win32")("doctor checks minimum Docker and Compose versions and accepts newer releases", async () => {
  for (const [docker, compose] of [
    ["24.0.9 24.0.9", "v2.10.2"], ["28.5.1 28.5.1", "2.40.3-desktop.1"],
    ["29.9.1 29.9.1", "v5.6.0"], ["28.5.1 29.0.0", "2.41.0"], ["30.0.0 30.0.0", "3.0.0"],
  ]) {
    const result = await probe({ docker, compose });
    expect(result.report).toMatchObject({ status: "pass", facts: { dockerVersion: docker, composeVersion: compose } });
    expect(result.calls).toEqual([dockerCall, composeCall]);
  }
  for (const compose of ["1.29.2", "2.9.9", "dev", "2.10", "2.10.bad"]) {
    const result = await probe({ compose });
    expect(result.report, compose).toEqual({ status: "fail", reasonCode: "docker-compose-version-unsupported" });
    expect(result.calls).toEqual([dockerCall, composeCall]);
  }
  for (const docker of ["23.0.6 28.5.1", "28.5.1 23.0.6", "28.5.1", "dev dev"]) {
    const result = await probe({ docker });
    expect(result.report, docker).toEqual({ status: "fail", reasonCode: "docker-version-unsupported" });
    expect(result.calls).toEqual([dockerCall]);
  }
}, 30_000);

test.runIf(process.platform !== "win32")("doctor blocks failed or timed out toolchain checks and skips Docker for local services", async () => {
  for (const [scenario, reasonCode] of [
    [{ dockerExit: 1 }, "docker-runtime-unavailable"],
    [{ composeExit: 1 }, "docker-compose-unavailable"],
    [{ hang: "docker" }, "docker-runtime-timeout"],
    [{ hang: "compose" }, "docker-runtime-timeout"],
    [{ compose: "x".repeat(257) }, "docker-compose-unavailable"],
  ] as const) {
    const result = await probe(scenario);
    expect(result.report).toEqual({ status: "blocked", reasonCode });
  }
  const local = await probe({}, "local");
  expect(local.report.status).toBe("pass");
  expect(local.calls).toEqual([]);
}, 15_000);
