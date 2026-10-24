import { canonicalize, sha256Hex } from "../../src/canonical/index.js";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

// Keep the classifier executable as plain Node ESM.
const dispositionModulePath = "../../scripts/registry-container-disposition.mjs";
const { registryContainerDisposition, registryAuditDriftDisposition, classifyRegistryAudit, extractPolicyFindings, classifyPolicyChecks, classifyAcceptanceFailure, failureSummary, satisfiesEngineRange, scanLockEngines, registryDependencyViolations, runtimeImageInventoryFindings, RELEASE_VERSION, unlistedPolicyFindings, candidateIntegrityErrors } = await import(dispositionModulePath);
const inventoryModulePath = "../../scripts/runtime-image-inventory.mjs";
const { runtimeImageInventory } = await import(inventoryModulePath);
const repoRoot = resolve(import.meta.dirname, "../..");
const workflowPath = join(repoRoot, ".github/workflows/registry-container-acceptance.yml");

// A runtime-image inventory that matches the lock's production closure.
const completeInventory = { scanComplete: true, errors: [], missing: [] };

// The shape written by scripts/verify-registry-container-consumer.sh when the
// rehearsal works and only the recorded #191 transitive audit findings remain.
function baselineOnlySummary() {
  return {
    schema: "dacs-registry-container-acceptance/v1", complete: true,
    packageVersion: JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version as string,
    generatedTestsPassed: true,
    functionalPassed: true,
    docker: { policy: { schema: "dacs-runtime-image-policy/v1", typescriptPresent: false, rubicSdkPresent: false, productionDependencyPolicyPassed: true } },
    audit: { directAdvisories: [] as string[], observedAdvisories: ["GHSA-23hp-3jrh-7fpw"], unlistedAdvisories: [] as string[], info: 0, low: 20, moderate: 30, high: 13, critical: 3, total: 66 },
    securityGate: {
      passed: false,
      registryDependencyPolicyPassed: true,
      productionImageDependencyPolicyPassed: true,
      engineStrictExitCode: 0,
      auditExitCode: 1,
      lockSbomExitCode: 0,
      physicalSbomExitCode: 0,
      findings: { schema: "dacs-registry-policy-findings/v1", gitDependencies: [], productionImageDependencies: [],
        engine: { exitCode: 0, code: null, scanComplete: true, violations: [] },
        lockSbom: { exitCode: 0, code: null, problems: [] }, physicalSbom: { exitCode: 0, code: null, problems: [] },
        productionImageInventory: completeInventory } as Record<string, unknown>,
    },
  };
}

// The lines of one workflow step, from its `- name:` line to the next step.
function workflowStepLines(stepName: string, path = workflowPath) {
  const lines = readFileSync(path, "utf8").split("\n");
  const start = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const stepIndent = (lines[start] ?? "").indexOf("-");
  let end = start + 1;
  while (end < lines.length && ((lines[end] ?? "").trim() === "" || (lines[end] ?? "").search(/\S/) > stepIndent)) end += 1;
  return { lines, start, end, stepIndent };
}

// A step's own `if:` condition; Actions' default is success().
function workflowStepCondition(stepName: string): string | undefined {
  const { lines, start, end, stepIndent } = workflowStepLines(stepName);
  const keyIndent = " ".repeat(stepIndent + 2);
  return lines.slice(start + 1, end).find((line) => line.startsWith(`${keyIndent}if:`))?.slice(keyIndent.length + 3).trim();
}

// Extracts the literal `run: |` block of one workflow step without a YAML dependency.
function workflowStepScript(stepName: string, path = workflowPath): string {
  const { lines, start, stepIndent } = workflowStepLines(stepName, path);
  let index = start + 1;
  while (index < lines.length && !/^\s+run:/.test(lines[index] ?? "")) index += 1;
  const runLine = lines[index] ?? "";
  const inline = runLine.replace(/^\s+run:\s*/, "");
  if (inline !== "|") return inline;
  const body: string[] = [];
  const blockIndent = runLine.indexOf("run:") + 2;
  for (index += 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() !== "" && line.search(/\S/) <= stepIndent) break;
    body.push(line.slice(blockIndent));
  }
  return body.join("\n");
}

function requiredFixtureEntry<T>(entry: T | undefined, location: string): T {
  if (entry === undefined) throw new Error("missing fixture entry: " + location);
  return entry;
}

const scratch: string[] = [];
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// Every child runs without rc files and with an explicit PATH whose `node` is
// this process's own binary, never a host node.
function stubBin(directory: string, stubs: Record<string, string> = {}) {
  const bin = join(directory, "bin");
  mkdirSync(bin, { recursive: true });
  const node = `'${process.execPath.replaceAll("'", "'\\''")}'`;
  for (const [name, body] of Object.entries({ node: `exec ${node} "$@"`, ...stubs })) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o700);
  }
  return [bin, dirname(process.execPath), process.env.PATH ?? ""].join(delimiter);
}
function runBash(args: string[], options: { cwd: string; env: Record<string, string> }) {
  return spawnSync("bash", ["--norc", "--noprofile", ...args], { cwd: options.cwd, encoding: "utf8",
    env: { HOME: options.cwd, ...options.env } });
}

// Runs a workflow step in a scratch checkout holding the real disposition
// script. The npm stub writes `summary` (if given) where acceptance would, then
// exits with the acceptance status. `event` is the run's GITHUB_EVENT_NAME;
// `stepSummary` is GITHUB_STEP_SUMMARY's contents afterwards.
function runWorkflowStep(acceptanceExitCode: number, summary?: unknown, strictAudit = false,
  stepName = "Run registry-shaped Linux and Docker acceptance", event = "pull_request") {
  const directory = mkdtempSync(join(tmpdir(), "dacs-registry-step-"));
  scratch.push(directory);
  const checkout = join(directory, "checkout");
  mkdirSync(join(checkout, "scripts"), { recursive: true });
  for (const name of ["registry-container-disposition.mjs", "runtime-image-inventory.mjs", "acceptance-evidence-io.mjs"]) {
    writeFileSync(join(checkout, "scripts", name), readFileSync(join(repoRoot, "scripts", name)));
  }
  // The disposition reads the release version from the checkout's manifest.
  writeFileSync(join(checkout, "package.json"), readFileSync(join(repoRoot, "package.json")));
  writeFileSync(join(checkout, "scripts/registry-container-audit-baseline.json"),
    readFileSync(join(repoRoot, "scripts/registry-container-audit-baseline.json")));
  const write = summary === undefined ? "" : [
    "mkdir -p registry-container-artifacts",
    `cat > registry-container-artifacts/acceptance-summary.json <<'JSON'\n${JSON.stringify(summary)}\nJSON`,
  ].join("\n");
  const PATH = stubBin(directory, { npm: `${write}\nexit ${acceptanceExitCode}` });
  // The drift step runs after acceptance has (or has not) written the summary.
  if (stepName !== "Run registry-shaped Linux and Docker acceptance") {
    runBash(["-e", "-c", "npm || true"], { cwd: checkout, env: { PATH } });
  }
  const GITHUB_STEP_SUMMARY = join(directory, "step-summary.md");
  writeFileSync(GITHUB_STEP_SUMMARY, "");
  const result = runBash(["-e", "-c", workflowStepScript(stepName)], {
    cwd: checkout, env: { ENFORCE_AUDIT_DRIFT: String(strictAudit), GITHUB_EVENT_NAME: event, GITHUB_STEP_SUMMARY, PATH },
  });
  return { ...result, stepSummary: readFileSync(GITHUB_STEP_SUMMARY, "utf8") };
}
const runDriftStep = (summary?: unknown, strictAudit = false) =>
  runWorkflowStep(0, summary, strictAudit, "Check advisory-ID drift");

describe("registry/container acceptance disposition", () => {
  it("passes only when both the rehearsal and the release security gate pass", () => {
    const summary = baselineOnlySummary();
    summary.securityGate.passed = true;
    Object.assign(summary.audit, { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 });
    summary.audit.observedAdvisories = [];
    summary.securityGate.auditExitCode = 0;
    expect(registryContainerDisposition(summary).exitCode).toBe(0);
    expect(registryContainerDisposition({ ...summary, functionalPassed: false }).exitCode).toBe(1);
    expect(registryContainerDisposition({}).exitCode).toBe(1);
  });

  it("reports audit findings within the recorded #191 baseline distinctly from a regression", () => {
    expect(registryContainerDisposition(baselineOnlySummary()).exitCode).toBe(4);
  });

  it("treats a summary without the expected schema or passing generated tests as a functional failure", () => {
    const { schema: _schema, ...unversioned } = baselineOnlySummary();
    expect(registryContainerDisposition(unversioned).exitCode).toBe(1);
    expect(registryContainerDisposition({ ...baselineOnlySummary(), schema: "other/v1" }).exitCode).toBe(1);
    expect(registryContainerDisposition({ ...baselineOnlySummary(), generatedTestsPassed: false }).exitCode)
      .toBe(1);
  });

  it("refuses a summary for another or no package version", () => {
    const { packageVersion: version, ...unversioned } = baselineOnlySummary();
    expect(version).toBe(RELEASE_VERSION);
    for (const summary of [unversioned, { ...unversioned, packageVersion: "999.999.999" },
      { ...unversioned, packageVersion: `${version}-other` }, { ...unversioned, packageVersion: null }]) {
      expect(registryContainerDisposition(summary)).toMatchObject({ exitCode: 1, failureClass: "functional",
        message: expect.stringContaining(`not the release version ${JSON.stringify(version)}`) });
    }
    // The version is the caller's release, never the summary's own claim.
    expect(registryContainerDisposition(baselineOnlySummary(), undefined, { packageVersion: "0.0.0" }).exitCode).toBe(1);
    expect(registryContainerDisposition(baselineOnlySummary(), undefined, { packageVersion: "" }).exitCode).toBe(1);
    expect(registryContainerDisposition({ ...baselineOnlySummary(), packageVersion: "1.2.3" }, undefined,
      { packageVersion: "1.2.3" }).exitCode).toBe(4);
  });

  it.each([
    ["a registry dependency policy violation", (s: ReturnType<typeof baselineOnlySummary>) => {
      s.securityGate.registryDependencyPolicyPassed = false;
    }],
    ["a production image dependency violation", (s: ReturnType<typeof baselineOnlySummary>) => {
      s.securityGate.productionImageDependencyPolicyPassed = false;
    }],
    ["an engine-strict failure", (s: ReturnType<typeof baselineOnlySummary>) => {
      s.securityGate.engineStrictExitCode = 1;
    }],
    ["a lockfile SBOM failure", (s: ReturnType<typeof baselineOnlySummary>) => {
      s.securityGate.lockSbomExitCode = 1;
    }],
    ["a physical SBOM failure", (s: ReturnType<typeof baselineOnlySummary>) => {
      s.securityGate.physicalSbomExitCode = 1;
    }],
    ["a failed audit with no findings", (s: ReturnType<typeof baselineOnlySummary>) => {
      s.audit.total = 0;
      s.audit.observedAdvisories = [];
    }],
  ])("keeps %s as a blocking security result", (_label, mutate) => {
    const summary = baselineOnlySummary();
    mutate(summary);
    expect(registryContainerDisposition(summary).exitCode).toBe(3);
  });

  it("is the exit status the acceptance script reports for a written summary", () => {
    const directory = mkdtempSync(join(tmpdir(), "dacs-registry-summary-"));
    scratch.push(directory);
    const summaryPath = join(directory, "acceptance-summary.json");
    writeFileSync(summaryPath, JSON.stringify(baselineOnlySummary()));
    const result = spawnSync(process.execPath, ["scripts/registry-container-disposition.mjs", summaryPath], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(result.status).toBe(4);
    expect(readFileSync(join(repoRoot, "scripts/verify-registry-container-consumer.sh"), "utf8"))
      .toContain('node scripts/registry-container-disposition.mjs --record "$output_dir/acceptance-summary.json"');
    const recorded = spawnSync(process.execPath, ["scripts/registry-container-disposition.mjs", "--record", summaryPath], {
      cwd: repoRoot, encoding: "utf8",
    });
    expect(recorded.status).toBe(4);
    expect(JSON.parse(readFileSync(summaryPath, "utf8"))).toMatchObject({ failureClass: "policy",
      disposition: { exitCode: 4, failureClass: "policy" } });
  });

  it("cross-checks the unlisted advisory IDs the summary recorded", () => {
    // R5-228a: an unlisted ID dropped from the recorded list is a tampered summary.
    const summary = baselineOnlySummary();
    summary.audit.observedAdvisories.push("GHSA-2222-3333-4444");
    expect(registryContainerDisposition(summary)).toMatchObject({ exitCode: 3,
      message: expect.stringContaining("does not match baseline") });
    expect(registryAuditDriftDisposition(summary).exitCode).toBe(3);
  });
});

describe("registry/container pull_request job", () => {
  it("does not fail a pull request for audit findings within the recorded #191 baseline", () => {
    const result = runWorkflowStep(4, baselineOnlySummary());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("::warning title=#191 security gate blocked::");
  });

  it("fails an early exit 4 that wrote no acceptance summary", () => {
    const result = runWorkflowStep(4);
    expect(result.status).toBe(4);
    expect(result.stdout).not.toContain("::warning title=#191 security gate blocked::");
    expect(result.stdout).toContain("::error title=Registry/container acceptance failed::");
  });

  it.each([
    ["an unexpected schema", { ...baselineOnlySummary(), schema: "other/v1" }],
    ["a functional failure", { ...baselineOnlySummary(), functionalPassed: false }],
    ["failed generated tests", { ...baselineOnlySummary(), generatedTestsPassed: false }],
    ["a dependency policy violation", {
      ...baselineOnlySummary(),
      securityGate: { ...baselineOnlySummary().securityGate, registryDependencyPolicyPassed: false },
    }],
  ])("fails exit 4 when the summary records %s", (_label, summary) => {
    const result = runWorkflowStep(4, summary);
    expect(result.status).toBe(4);
    expect(result.stdout).not.toContain("::warning title=#191 security gate blocked::");
  });

  it.each([1, 2, 3])("still fails the job on acceptance exit %i", (code) => {
    expect(runWorkflowStep(code).status).toBe(code);
  });

  it("passes when acceptance passes", () => {
    expect(runWorkflowStep(0).status).toBe(0);
  });

  it("checks drift, publishes the summary and uploads evidence even after acceptance fails", () => {
    // Without always(), Actions' default success() would skip drift whenever
    // acceptance exits 3, which masked drift in round 4.
    for (const step of ["Check advisory-ID drift", "Publish acceptance summary", "Upload registry/container evidence"]) {
      expect(workflowStepCondition(step)).toBe("always()");
    }
    expect(workflowStepCondition("Run registry-shaped Linux and Docker acceptance")).toBeUndefined();
  });
});

describe("registry/container workflow wiring", () => {
  const acceptance = readFileSync(workflowPath, "utf8");
  const drift = readFileSync(join(repoRoot, ".github/workflows/registry-container-audit-drift.yml"), "utf8");

  it("runs pull-request acceptance when either workflow or the gate's scripts change", () => {
    const paths = /\n  pull_request:\n    paths:\n((?: {6}- .+\n)+)/.exec(acceptance)?.[1]?.split("\n")
      .map((line) => line.trim().replace(/^- "(.*)"$/, "$1")).filter(Boolean) ?? [];
    expect(paths).toEqual(expect.arrayContaining([".github/workflows/registry-container-acceptance.yml",
      ".github/workflows/registry-container-audit-drift.yml", "scripts/registry-container-disposition.mjs", "scripts/sync-vectors.mjs",
      "scripts/registry-container-audit-baseline.json", "scripts/verify-registry-container-consumer.sh",
      "scripts/acceptance-evidence-io.mjs", "scripts/bounded-build.mjs", "scripts/bounded-command.mjs",
      "scripts/bounded-npm-http.cjs", "scripts/bounded-transport.sh", "scripts/bounded-http.sh", "scripts/http-json-limits.mjs"]));
  });

  it("has the scheduled drift workflow call acceptance with drift enforced", () => {
    expect(drift).toMatch(/\non:\n  schedule:\n    - cron: "[^"]+"\n  workflow_dispatch:\n/);
    expect(drift).toMatch(/\n    uses: \.\/\.github\/workflows\/registry-container-acceptance\.yml\n    with:\n      enforce-audit-drift: true\n/);
    expect(acceptance).toMatch(/\n  workflow_call:\n    inputs:\n      enforce-audit-drift:\n        type: boolean\n        default: false\n/);
    expect(workflowStepLines("Check advisory-ID drift").lines.join("\n"))
      .toContain("ENFORCE_AUDIT_DRIFT: ${{ inputs.enforce-audit-drift || false }}");
  });

  // Daybreak r9 P2: prerelease publication never ran the advisory gate, so an
  // advisory published after the baseline could not stop it.
  it("cannot select the warn policy from a caller that enforces drift", () => {
    // The called workflow's only input is enforce-audit-drift, and the policy
    // is set nowhere but the acceptance step, which never warns when it is true.
    expect(/\n  workflow_call:\n((?: {4}.+\n)+)/.exec(acceptance)?.[1])
      .toBe("    inputs:\n      enforce-audit-drift:\n        type: boolean\n        default: false\n");
    expect(acceptance.match(/DACS_UNLISTED_ADVISORIES/g)).toHaveLength(2);
    expect(workflowStepLines("Run registry-shaped Linux and Docker acceptance").lines.join("\n"))
      .toContain("ENFORCE_AUDIT_DRIFT: ${{ inputs.enforce-audit-drift || false }}");
    const summary = baselineOnlySummary();
    summary.audit.observedAdvisories.push("GHSA-2222-3333-4444");
    summary.audit.unlistedAdvisories.push("GHSA-2222-3333-4444");
    // The publish workflow's event, and pull_request too, once drift is enforced.
    for (const event of ["workflow_dispatch", "pull_request"]) {
      for (const status of [3, 4]) {
        const result = runWorkflowStep(status, summary, true, undefined, event);
        expect(result.status).toBe(status);
        expect(result.stdout).not.toContain("::warning title=#191 security gate blocked::");
        expect(result.stdout).not.toContain("::warning title=Advisory IDs outside the #191 baseline::");
      }
    }
    expect(runDriftStep(summary, true).status).toBe(3);
    // Baseline-only findings stay waived (exit 4 re-checks as 4), as on every run.
    expect(runWorkflowStep(4, baselineOnlySummary(), true, undefined, "workflow_dispatch").status).toBe(0);
  });

});

// Runs the acceptance script up to its first npm command, with stubs that
// leave partial consumer output behind and then fail with status 17.
function runEarlyFailure(extraStubCommands = "") {
  const directory = mkdtempSync(join(tmpdir(), "dacs-registry-failure-"));
  scratch.push(directory);
  const npmBody = [
    'for directory in "$RUNNER_TEMP"/dacs-registry-acceptance.*; do',
    '  printf "partial doctor diagnostic\\n" > "$directory/consumer/doctor.log"',
    '  mkdir -p "$directory/consumer/one-click-agent"',
    `  printf '{"name":"one-click-agent"}\\n' > "$directory/consumer/one-click-agent/package.json"`,
    `  printf '{"lockfileVersion":3}\\n' > "$directory/consumer/one-click-agent/package-lock.json"`,
    extraStubCommands,
    "done",
    "exit 17",
  ].join("\n");
  // curl, docker and npm are stubs and node is this process's binary; the
  // script's temporary root is this private directory.
  chmodSync(directory, 0o700);
  const PATH = stubBin(directory, { curl: 'printf "curl 8.5.0\\n"' , docker: "exit 0", npm: npmBody });
  const output = join(directory, "evidence");
  const result = runBash(["scripts/verify-registry-container-consumer.sh", "--output-dir", output], {
    cwd: repoRoot, env: { RUNNER_TEMP: directory, HOME: directory, PATH, OUTPUT_DIR: output },
  });
  return { directory, output, result };
}

// A gzip'd ustar archive holding package/package.json, as npm pack writes it.
function packTarball(manifest: Record<string, string>) {
  const body = Buffer.from(JSON.stringify(manifest));
  const header = Buffer.alloc(512);
  header.write("package/package.json", 0, 100, "utf8");
  header.write("0000644\0", 100); header.write("0000000\0", 108); header.write("0000000\0", 116);
  header.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
  header.write("00000000000\0", 136); header.write("        ", 148); header.write("0", 156); header.write("ustar\0" + "00", 257);
  let sum = 0; for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return gzipSync(Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512), Buffer.alloc(1024)]));
}

// Runs the whole acceptance script up to its consumer container, where the
// generated project's doctor fails (exit 1, not the expected 5). Docker, npm
// and curl are stubs; node is this process's binary; the registry is a
// loopback server that serves exactly the published candidates.
async function runToConsumerStage(complete = false, failStart = false) {
  const directory = mkdtempSync(join(tmpdir(), "dacs-registry-doctor-")); scratch.push(directory); chmodSync(directory, 0o700);
  const version = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version as string;
  const releaseSet = join(directory, "release-set"); mkdirSync(releaseSet);
  const served: Record<string, { integrity: string; tarball: string; manifest: { name: string; version: string }; shasum: string }> = {};
  const archives: Record<string, Buffer> = {};
  const packages: Record<string, { integrity: string }> = {};
  for (const [name, file] of [["@kynesyslabs/dacs", "kynesyslabs-dacs"], ["@kynesyslabs/dacs-node", "kynesyslabs-dacs-node"], ["create-dacs-agent", "create-dacs-agent"]] as const) {
    const manifest = { name, version };
    const bytes = packTarball(manifest); const tarball = "/" + file + ".tgz";
    writeFileSync(join(releaseSet, `${file}-${version}.tgz`), bytes); archives[tarball] = bytes;
    served["/" + name.replace("/", "%2f")] = { integrity: sri(bytes), tarball, manifest, shasum: createHash("sha1").update(bytes).digest("hex") }; packages[name] = { integrity: sri(bytes) };
  }
  writeFileSync(join(releaseSet, "release-provenance.json"), JSON.stringify({ version, source: { clean: true }, packages }));
  writeFileSync(join(releaseSet, "SHA256SUMS"), "fixture\n");
  const npmRoot = join(directory, "npm-root"); mkdirSync(join(npmRoot, "npm/node_modules/libnpmpublish"), { recursive: true });
  writeFileSync(join(npmRoot, "npm/package.json"), JSON.stringify({ version: "11.19.0" }));
  writeFileSync(join(npmRoot, "npm/node_modules/libnpmpublish/package.json"), JSON.stringify({ main: "index.js" }));
  writeFileSync(join(npmRoot, "npm/node_modules/libnpmpublish/index.js"), "exports.publish = async () => {};\n");
  const npmEntry = process.env.npm_execpath;
  if (!npmEntry) throw new Error("driver fixture needs the executing npm parser");
  symlinkSync(dirname(createRequire(npmEntry).resolve("npm-package-arg/package.json")), join(npmRoot, "npm/node_modules/npm-package-arg"));
  const server = createServer((request, response) => {
    const archive = archives[request.url ?? ""]; const record = served[request.url ?? ""];
    response.writeHead(archive || record ? 200 : 404, { "content-type": archive ? "application/octet-stream" : "application/json" });
    response.end(archive ?? JSON.stringify(record ? { name: record.manifest.name, "dist-tags": { acceptance: version }, versions: { [version]: { ...record.manifest,
      dist: { integrity: record.integrity, shasum: record.shasum, tarball: `http://${request.headers.host}${record.tarball}` } } } } : {}));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture server has no port");
  const port = address.port; const registry = `http://127.0.0.1:${port}`;
  const fixture = join(directory, "consumer-fixture"); const project = join(fixture, "one-click-agent"); mkdirSync(project, { recursive: true });
  const dependencies = Object.fromEntries(["@kynesyslabs/dacs", "@kynesyslabs/dacs-node", "@kynesyslabs/demosdk", "@x402/core", "@x402/evm", "@x402/fetch", "better-sqlite3", "viem"].map(name => [name, version]));
  const manifest = { name: "one-click-agent", version, dependencies };
  const lock: Record<string, unknown> = { "": manifest };
  const inventory: Array<{ location: string; name: string; version: string }> = [];
  for (const name of ["@kynesyslabs/dacs", "@kynesyslabs/dacs-node"]) {
    const location = "node_modules/" + name; const record = packages[name]; if (!record) throw new Error("missing fixture archive");
    lock[location] = { version, resolved: `${registry}/${name}.tgz`, integrity: record.integrity };
    mkdirSync(join(project, location), { recursive: true }); writeFileSync(join(project, location, "package.json"), JSON.stringify({ name, version }));
    inventory.push({ location, name, version });
  }
  writeFileSync(join(project, "Dockerfile"), "FROM node:20 AS build\nRUN npm ci\nFROM node:20\n");
  writeFileSync(join(project, ".dockerignore"), "**\n");
  writeFileSync(join(project, "package.json"), JSON.stringify(manifest)); writeFileSync(join(project, "package-lock.json"), JSON.stringify({ packages: lock }));
  const doctor = JSON.parse(readFileSync(join(repoRoot, "test/scripts/fixtures/registry-container-doctor-without-credentials.json"), "utf8"));
  doctor.sdkVersion = version;
  delete doctor.reportHash;
  doctor.reportHash = sha256Hex(canonicalize(doctor));
  const files: Record<string, string> = { "generated-tests.exit-code": "0\n", "doctor.exit-code": "5\n", "doctor.log": "blocked without credentials\n",
    "doctor.json": JSON.stringify(doctor),
    "npm-audit.exit-code": "0\n", "npm-audit.json": JSON.stringify({ metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } }, vulnerabilities: {} }),
    "engine-strict.exit-code": "0\n", "engine-strict.log": "", "engine-versions.json": JSON.stringify({ node: "20.19.1", npm: "11.19.0" }) };
  for (const kind of ["lock", "physical"]) { files[`consumer-${kind}.cdx.json`] = "{}"; files[`consumer-${kind}-sbom.err`] = ""; files[`consumer-${kind}-sbom.exit-code`] = "0\n"; }
  for (const [name, value] of Object.entries(files)) writeFileSync(join(fixture, name), value);
  const pinned = join(directory, "npm-pinned"); const built = join(directory, "image-built"); const commands = join(directory, "docker-commands");
  const PATH = stubBin(directory, {
    curl: ['case "$*" in', '  *--version*) echo "curl 8.5.0" ;;', '  *org.couchdb.user*) printf \'{"token":"local-acceptance-token"}\' ;;', 'esac', 'exit 0'].join("\n"),
    npm: ['case "$1" in', `  install) case "$*" in *npm@11.19.0*) touch '${pinned}' ;; *) exit 92 ;; esac ;;`,
      `  --version) if [ -f '${pinned}' ]; then echo 11.19.0; else echo 10.9.9; fi ;;`, `  root) echo '${npmRoot}' ;;`, '  view) exit 97 ;;',
      `  run) if [ "$2" = release:set:verify ]; then mkdir -p "$5" && cp '${releaseSet}'/* "$5"/; fi ;;`, 'esac', 'exit 0'].join("\n"),
    docker: [`printf '%s\\n' "$*" >> '${commands}'`, ...(failStart ? ['if [ "$1 $2" = "run --detach" ]; then exit 17; fi'] : []), `if [ "$1" = inspect ]; then echo ${port}; exit 0; fi`,
      `if [ "$1" = build ]; then touch '${built}'; exit 0; fi`,
      `if [ "$1 $2" = 'image inspect' ]; then [ -f '${built}' ] || exit 98; case "$*" in *--format*) echo 10001:10001 ;; *) printf '%s' '[{"Id":"fixture","Size":1,"Config":{"User":"10001:10001"}}]' ;; esac; exit 0; fi`,
      'if [ "$1" = compose ]; then echo "services: {}"; exit 0; fi', 'if [ "$1" != run ]; then exit 0; fi', 'work=; previous=',
      'for argument in "$@"; do', '  if [ "$previous" = --volume ]; then case "$argument" in *:/work) work=${argument%:/work} ;; esac; fi', '  previous=$argument', 'done',
      'if [ -n "$work" ]; then', ...(complete ? [`  cp -r '${fixture}/.' "$work/"`, '  exit 0'] : [
        '  mkdir -p "$work/one-click-agent"', `  printf '{"name":"one-click-agent"}\\n' > "$work/one-click-agent/package.json"`,
        `  printf '{"lockfileVersion":3,"packages":{}}\\n' > "$work/one-click-agent/package-lock.json"`, `  printf '0\\n' > "$work/generated-tests.exit-code"`,
        `  printf 'doctor: release metadata is unreadable\\n' > "$work/doctor.log"`, `  printf '1\\n' > "$work/doctor.exit-code"`, "  echo 'npm run dacs:doctor exited 1'", '  exit 1']),
      'fi', 'case "$*" in', `  *--entrypoint*) [ -f '${built}' ] || exit 98 ;;`, 'esac', 'case "$*" in', '  *"--entrypoint id"*) echo 10001 ;;',
      '  *"--entrypoint test"*) exit 1 ;;', `  *"--entrypoint node"*) printf '%s' '${JSON.stringify({ schema: "dacs-runtime-image-inventory/v1", packages: inventory })}' ;;`, 'esac', 'exit 0'].join("\n"),
  });
  const output = join(directory, "evidence");
  try {
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(done => {
      const child = spawn("bash", ["--norc", "--noprofile", "scripts/verify-registry-container-consumer.sh", "--output-dir", output], { cwd: repoRoot, env: { RUNNER_TEMP: directory, PATH } });
      let stdout = ""; let stderr = ""; child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
      child.on("close", status => done({ status, stdout, stderr }));
    });
    return { directory, output, result, commands };
  } finally { server.close(); }
}

const CANDIDATE_VERSION = "0.1.0-test";
// A summary the producer composed for CANDIDATE_VERSION, judged as that release.
const candidateDisposition = (summary: unknown, baseline?: unknown, options: Record<string, unknown> = {}) =>
  registryContainerDisposition(summary, baseline, { packageVersion: CANDIDATE_VERSION, ...options });
const CANDIDATE_REGISTRY = "http://host.docker.internal:4873";
const sri = (bytes: Buffer) => "sha512-" + createHash("sha512").update(bytes).digest("base64");

// Runs the dependency-policy command the script runs against a generated
// consumer whose lock initially names the exact packed candidate tarballs,
// as release-provenance.json records them.
function dependencyPolicyHarness() {
  const directory = mkdtempSync(join(tmpdir(), "dacs-registry-integrity-"));
  scratch.push(directory);
  const packages: Record<string, Record<string, unknown>> = {};
  const provenance = { version: CANDIDATE_VERSION, packages: {} as Record<string, { integrity: string }> };
  for (const name of ["dacs", "dacs-node"]) {
    const bytes = Buffer.from(name);
    writeFileSync(join(directory, `kynesyslabs-${name}-${CANDIDATE_VERSION}.tgz`), bytes);
    packages[`node_modules/@kynesyslabs/${name}`] = {
      version: CANDIDATE_VERSION,
      resolved: `${CANDIDATE_REGISTRY}/${name}.tgz`,
      integrity: sri(bytes),
    };
    provenance.packages[`@kynesyslabs/${name}`] = { integrity: sri(bytes) };
  }
  const project = join(directory, "project");
  mkdirSync(project);
  const manifest: Record<string, unknown> = { dependencies: Object.fromEntries([
    "@kynesyslabs/dacs", "@kynesyslabs/dacs-node", "@kynesyslabs/demosdk", "@x402/core",
    "@x402/evm", "@x402/fetch", "better-sqlite3", "viem",
  ].map((name) => [name, CANDIDATE_VERSION])) };
  const report = join(directory, "report.json");
  expect(readFileSync(join(repoRoot, "scripts/verify-registry-container-consumer.sh"), "utf8")).toContain(
    'node scripts/registry-container-disposition.mjs --dependency-policy "$project" "$consumer_registry" \\\n' +
    '  "$artifact_stage/dependency-policy.json" "$release_set" "$version"');
  // The package.json installed at each candidate lock location: by default
  // the lock entry's own name and version; `null` installs none.
  const installed: Record<string, Record<string, unknown> | null> = {};
  const run = (afterInstall: (project: string) => void = () => undefined) => {
    rmSync(join(project, "node_modules"), { recursive: true, force: true });
    for (const [location, entry] of Object.entries(packages)) {
      const name = typeof entry.name === "string" ? entry.name : location.replace(/^.*node_modules\//, "");
      if (name !== "@kynesyslabs/dacs" && name !== "@kynesyslabs/dacs-node") continue;
      const installedManifest = location in installed ? installed[location] : { name, version: entry.version };
      if (installedManifest === null) continue;
      mkdirSync(join(project, location), { recursive: true });
      writeFileSync(join(project, location, "package.json"), JSON.stringify(installedManifest));
    }
    afterInstall(project);
    writeFileSync(join(project, "package.json"), JSON.stringify(manifest));
    writeFileSync(join(project, "package-lock.json"), JSON.stringify({ packages: { "": {}, ...packages } }));
    writeFileSync(join(directory, "release-provenance.json"), JSON.stringify(provenance));
    const result = spawnSync(process.execPath, ["scripts/registry-container-disposition.mjs", "--dependency-policy",
      project, CANDIDATE_REGISTRY, report, directory, CANDIDATE_VERSION], { cwd: repoRoot, encoding: "utf8" });
    return { ...result, report: result.status === 0 ? JSON.parse(readFileSync(report, "utf8")) : null };
  };
  return { packages, manifest, provenance, installed, run, report };
}

// Executes the script's own summary program over a stage holding the evidence
// a complete run collects; `overrides` replaces individual evidence files.
function writeSummary(overrides: Record<string, string> = {}) {
  const stage = mkdtempSync(join(tmpdir(), "dacs-registry-summary-stage-"));
  scratch.push(stage);
  const files: Record<string, string> = {
    "docker-image.json": JSON.stringify([{ Id: "sha256:image", Size: 1, Config: { User: "10001:10001" } }]),
    "npm-audit.json": JSON.stringify({ metadata: { vulnerabilities: baselineOnlySummary().audit } }),
    "dependency-policy.json": JSON.stringify({ schema: "dacs-registry-dependency-policy/v1", passed: true,
      violations: [] }),
    "audit-policy.json": JSON.stringify({ schema: "dacs-registry-audit-policy/v1",
      observedAdvisories: baselineOnlySummary().audit.observedAdvisories, unlistedAdvisories: [], directAdvisories: [] }),
    "runtime-image-policy.json": JSON.stringify({ schema: "dacs-runtime-image-policy/v1", functionalPassed: true,
      productionDependencyPolicyPassed: true }),
    "policy-findings.json": JSON.stringify(baselineOnlySummary().securityGate.findings),
    "release-provenance.json": JSON.stringify({ version: CANDIDATE_VERSION }),
    "engine-strict.exit-code": "0\n",
    "npm-audit.exit-code": "1\n",
    "consumer-lock-sbom.exit-code": "0\n",
    "consumer-physical-sbom.exit-code": "0\n",
    "generated-tests.exit-code": "0\n",
    "doctor.exit-code": "5\n",
    "doctor.json": readFileSync(join(repoRoot, "test/scripts/fixtures/registry-container-doctor-without-credentials.json"), "utf8"),
    ...overrides,
  };
  for (const [name, body] of Object.entries(files)) writeFileSync(join(stage, name), body);
  const script = readFileSync(join(repoRoot, "scripts/verify-registry-container-consumer.sh"), "utf8")
    .split('node - "$artifact_stage" "$version" "$runtime_image"')[1]!.split("<<'NODE'\n")[1]!
    .split("\nNODE")[0]!;
  const result = spawnSync(process.execPath, [
    "-", stage, CANDIDATE_VERSION, "dacs-one-click-acceptance:test", "live-demos", "seller", "both",
  ], { input: script, encoding: "utf8" });
  expect(result.status).toBe(0);
  return JSON.parse(readFileSync(join(stage, "acceptance-summary.json"), "utf8"));
}

describe("registry/container evidence", () => {
  it.each(["dacs", "dacs-node"])("rejects an untracked installed nested or aliased %s", name => {
    for (const location of [`node_modules/plugin/node_modules/@kynesyslabs/${name}`, "node_modules/untracked-alias"]) {
      const fixture = dependencyPolicyHarness();
      const result = fixture.run(project => {
        mkdirSync(join(project, location), { recursive: true });
        writeFileSync(join(project, location, "package.json"), JSON.stringify({ name: `@kynesyslabs/${name}`, version: "0.0.0-wrong" }));
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("installed candidate has no lock entry: " + location);
    }
  });
  it.each(["dacs", "dacs-node"])("requires the top-level %s even with valid nested and aliased copies", name => {
    const { packages, run } = dependencyPolicyHarness();
    const top = `node_modules/@kynesyslabs/${name}`;
    const entry = packages[top];
    expect(entry).toBeDefined();
    packages[`node_modules/plugin/node_modules/@kynesyslabs/${name}`] = { ...entry };
    packages["node_modules/alias"] = { ...entry, name: `@kynesyslabs/${name}` };
    delete packages[top];
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("candidate package is not installed at the top level: @kynesyslabs/" + name);
  });
  it("invalidates a previous success report before a rejected repeat", () => {
    const fixture = dependencyPolicyHarness();
    expect(fixture.run().status).toBe(0);
    expect(JSON.parse(readFileSync(fixture.report, "utf8")).passed).toBe(true);
    const entry = fixture.packages["node_modules/@kynesyslabs/dacs"];
    if (!entry) throw new Error("missing fixture candidate");
    entry.integrity = "sha512-wrong";
    expect(fixture.run().status).not.toBe(0);
    expect(existsSync(fixture.report)).toBe(false);
  });
  it("rejects an unknown policy mode", () => {
    expect(spawnSync(process.execPath, ["scripts/registry-container-disposition.mjs", "--dependency-polciy"],
      { cwd: repoRoot }).status).not.toBe(0);
  });


  it("traverses image build, evidence assembly and disposition using the pinned host npm", async () => {
    const { directory, output, result, commands } = await runToConsumerStage(true);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(existsSync(join(directory, "npm-pinned"))).toBe(true);
    const invoked = readFileSync(commands, "utf8");
    expect(invoked).toMatch(/^build .*--tag /m);
    expect(invoked).toContain("--file "); expect(invoked).toContain("Dockerfile.acceptance");
    expect(invoked).toContain("--env DACS_BOUNDED_NPM_HTTP=1");
    expect(invoked).toContain("--env NODE_OPTIONS=--require=/acceptance-support/bounded-npm-http.cjs");
    expect(invoked).toContain("--env npm_config_fetch_retries=2");
    for (const name of ["doctor.json", "compose.rendered.yaml", "docker-image.json", "runtime-image-inventory.json", "runtime-image-policy.json", "policy-findings.json", "release-set.log"]) expect(existsSync(join(output, name)), name).toBe(true);
    expect(JSON.parse(readFileSync(join(output, "acceptance-summary.json"), "utf8"))).toMatchObject({ complete: true, functionalPassed: true, disposition: { exitCode: 0 } });
  }, 30_000);
  it.each(["git-dns.txt", "git-connect.txt"])("classifies the release-set Git diagnostic %s through its stage mapping", name => {
    const text = readFileSync(join(repoRoot, "test/scripts/fixtures/acceptance-transport", name), "utf8");
    expect(classifyAcceptanceFailure({ stage: "release-set", read: () => text }).failureClass).toBe("network");
  });

  it("retains release-set network errors and classifies them as network failures", () => {
    const { output } = runEarlyFailure('printf "npm error code ECONNRESET\\n"');
    expect(readFileSync(join(output, "release-set.log"), "utf8")).toContain("ECONNRESET");
    expect(JSON.parse(readFileSync(join(output, "acceptance-summary.json"), "utf8"))).toMatchObject({ failedStage: "release-set", failureClass: "network", failureEvidence: [expect.stringContaining("ECONNRESET")] });
  });

  it("exports partial evidence and preserves the early failure status", () => {
    const { output, result } = runEarlyFailure();
    expect(result.status).toBe(17);
    expect(readFileSync(join(output, "acceptance.exit-code"), "utf8")).toBe("17\n");
    expect(readFileSync(join(output, "doctor.log"), "utf8")).toBe("partial doctor diagnostic\n");
    expect(readFileSync(join(output, "generated-package.json"), "utf8")).toBe('{"name":"one-click-agent"}\n');
    expect(readFileSync(join(output, "generated-package-lock.json"), "utf8")).toBe('{"lockfileVersion":3}\n');
    // The runner's tool versions are evidence too; the stubs print nothing.
    expect(readFileSync(join(output, "runner-tools.txt"), "utf8")).toMatch(/^bash \d+\.\d+/);
  });

  it("keeps the consumer's diagnostics when the generated doctor fails before any of them is exported", async () => {
    const { output, result, directory } = await runToConsumerStage();
    expect(result.status, result.stderr).toBe(1);
    const evidence = (name: string) => readFileSync(join(output, name), "utf8");
    expect(evidence("doctor.log")).toBe("doctor: release metadata is unreadable\n");
    expect(evidence("doctor.exit-code")).toBe("1\n");
    expect(evidence("generated-tests.exit-code")).toBe("0\n");
    expect(evidence("generated-package.json")).toBe('{"name":"one-click-agent"}\n');
    expect(evidence("generated-package-lock.json")).toBe('{"lockfileVersion":3,"packages":{}}\n');
    expect(evidence("generation.log")).toContain("dacs:doctor exited 1");
    for (const name of ["release-provenance.json", "SHA256SUMS", "registry.log", "runner-tools.txt"]) {
      expect(existsSync(join(output, name)), name).toBe(true);
    }
    expect(JSON.parse(evidence("acceptance-summary.json"))).toMatchObject({ complete: false, failedStage: "consumer",
      exitCode: 1, failureClass: "functional" });
    expect(result.stdout).toContain("::error title=Registry/container acceptance functional failure::stopped at stage consumer");
    // The temporary acceptance root, which held them, is gone.
    expect(readdirSync(directory).filter((name) => name.startsWith("dacs-registry-acceptance."))).toEqual([]);
  });

  it("finishes cleanup and keeps the original status when an evidence write fails", () => {
    // A directory where the exit-code file belongs makes that write fail.
    const { directory, output, result } = runEarlyFailure(
      '  mkdir -p "$directory/artifacts/acceptance.exit-code"',
    );
    expect(result.status).toBe(17);
    expect(readFileSync(join(output, "doctor.log"), "utf8")).toBe("partial doctor diagnostic\n");
    const retained = readdirSync(directory).filter(name => name.startsWith("dacs-registry-acceptance."));
    expect(retained).toHaveLength(1);
    expect(readFileSync(join(directory, retained[0] ?? "missing", "consumer/doctor.log"), "utf8")).toBe("partial doctor diagnostic\n");
    expect(result.stderr).toContain("retained at ");
  });

  it("rejects a registry lock entry with different tarball bytes and reports both digests", () => {
    const { packages, run } = dependencyPolicyHarness();
    expect(run().status).toBe(0);
    const expected = packages["node_modules/@kynesyslabs/dacs-node"]!.integrity;
    packages["node_modules/@kynesyslabs/dacs-node"]!.integrity = "sha512-wrong";
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("integrity does not match");
    expect(result.stderr).toContain(`expected ${expected}, observed sha512-wrong`);
  });

  it("rejects a core lock entry with different tarball bytes", () => {
    const { packages, run } = dependencyPolicyHarness();
    packages["node_modules/@kynesyslabs/dacs"]!.integrity = sri(Buffer.from("other core"));
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("integrity does not match the packed tarball: node_modules/@kynesyslabs/dacs");
  });

  it.each(["dacs", "dacs-node"])("rejects a nested @kynesyslabs/%s copy that is not the candidate", (name) => {
    const { packages, run } = dependencyPolicyHarness();
    const topLevel = packages[`node_modules/@kynesyslabs/${name}`]!;
    const nested = `node_modules/some-plugin/node_modules/@kynesyslabs/${name}`;
    packages[nested] = { ...topLevel };
    expect(run().status).toBe(0);
    packages[nested] = { resolved: `${CANDIDATE_REGISTRY}/${name}-old.tgz`, integrity: sri(Buffer.from("old")) };
    const substituted = run();
    expect(substituted.status).not.toBe(0);
    expect(substituted.stderr).toContain(`integrity does not match the packed tarball: ${nested}`);
    packages[nested] = { resolved: `https://registry.npmjs.org/${name}.tgz`, integrity: topLevel.integrity };
    const outside = run();
    expect(outside.status).not.toBe(0);
    expect(outside.stderr).toContain(`did not resolve through the isolated registry: ${nested}`);
  });

  it.each(["dacs", "dacs-node"])("rejects a substituted npm alias of %s", (name) => {
    const { packages, run } = dependencyPolicyHarness();
    packages["node_modules/alias"] = { ...packages[`node_modules/@kynesyslabs/${name}`]!, name: `@kynesyslabs/${name}` };
    expect(run().status).toBe(0);
    packages["node_modules/alias"]!.integrity = "sha512-wrong";
    expect(run().status).not.toBe(0);
  });

  it.each(["dacs", "dacs-node"])("compares the installed @kynesyslabs/%s with release-provenance.json", (name) => {
    const { packages, provenance, run } = dependencyPolicyHarness();
    expect(run()).toMatchObject({ status: 0, report: { passed: true, violations: [] } });
    const packed = provenance.packages[`@kynesyslabs/${name}`]!.integrity;
    provenance.packages[`@kynesyslabs/${name}`]!.integrity = sri(Buffer.from("another build"));
    const recorded = run();
    expect(recorded.status).not.toBe(0);
    expect(recorded.stderr).toContain(`release-provenance.json records ${sri(Buffer.from("another build"))} ` +
      `for @kynesyslabs/${name}, but the packed tarball is ${packed}`);
    // A lock that matches the provenance record but not the packed bytes fails too.
    packages[`node_modules/@kynesyslabs/${name}`]!.integrity = sri(Buffer.from("another build"));
    expect(run().status).not.toBe(0);
  });

  // Every installed candidate copy is the release's version, in the lock and
  // in the package.json npm installed, top-level, nested or aliased.
  it.each(["dacs", "dacs-node"])("rejects a @kynesyslabs/%s copy that is not the release version", (name) => {
    const { packages, installed, run } = dependencyPolicyHarness();
    const topLevel = `node_modules/@kynesyslabs/${name}`;
    const nested = `node_modules/some-plugin/node_modules/@kynesyslabs/${name}`;
    packages[nested] = { ...packages[topLevel]! };
    packages["node_modules/alias"] = { ...packages[topLevel]!, name: `@kynesyslabs/${name}` };
    expect(run().status).toBe(0);
    for (const location of [topLevel, nested, "node_modules/alias"]) {
      const entry = packages[location]!;
      for (const version of [undefined, "0.0.0-wrong", "0.1.0-alpha.0"]) {
        packages[location] = version === undefined
          ? Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "version"))
          : { ...entry, version };
        installed[location] = { name: `@kynesyslabs/${name}`, version: CANDIDATE_VERSION };
        const lockVersion = run();
        expect(lockVersion.status, `${location} ${String(version)}`).not.toBe(0);
        expect(lockVersion.stderr).toContain(`lock version does not match the release: ${location} ` +
          `(expected ${CANDIDATE_VERSION}, observed ${String(version)})`);
      }
      packages[location] = entry;
      for (const manifest of [null, { name: `@kynesyslabs/${name}`, version: "0.0.0-wrong" },
        { name: "@kynesyslabs/other", version: CANDIDATE_VERSION }]) {
        installed[location] = manifest;
        const installedCopy = run();
        expect(installedCopy.status, `${location} ${JSON.stringify(manifest)}`).not.toBe(0);
        expect(installedCopy.stderr).toContain(`installed candidate package is not the release: ${location}`);
      }
      delete installed[location];
      expect(run().status).toBe(0);
    }
  }, 30_000);

  it("composes only evidence of its producer's schema for the release version", () => {
    const evidence: Array<[string, Record<string, unknown>]> = [
      ["dependency-policy.json", { schema: "dacs-registry-dependency-policy/v1", passed: true, violations: [] }],
      ["audit-policy.json", { schema: "dacs-registry-audit-policy/v1",
        observedAdvisories: baselineOnlySummary().audit.observedAdvisories, unlistedAdvisories: [] }],
      ["runtime-image-policy.json", { schema: "dacs-runtime-image-policy/v1", functionalPassed: true,
        productionDependencyPolicyPassed: true }],
      ["policy-findings.json", { schema: "dacs-registry-policy-findings/v1", gitDependencies: [],
        productionImageInventory: completeInventory }],
    ];
    const builder = readFileSync(join(repoRoot, "scripts/verify-registry-container-consumer.sh"), "utf8")
      .split('node - "$artifact_stage" "$version" "$runtime_image"')[1]!.split("<<'NODE'\n")[1]!
      .split("\nNODE")[0]!;
    for (const [name, body] of evidence) {
      for (const schema of [undefined, "wrong/v999"]) {
        expect(() => writeSummary({ [name]: JSON.stringify({ ...body, schema }) }), `${name} ${String(schema)}`)
          .toThrow();
      }
      expect(builder).toContain(`["${name}", `);
    }
    expect(() => writeSummary({ "release-provenance.json": JSON.stringify({ version: "999.999.999" }) })).toThrow();

    // The disposition re-checks the schemas the summary embeds, and the
    // release version the summary was composed for.
    const passing = writeSummary();
    expect(passing.packageVersion).toBe(CANDIDATE_VERSION);
    expect(candidateDisposition(passing).exitCode).toBe(4);
    expect(registryContainerDisposition(passing)).toMatchObject({ exitCode: 1, failureClass: "functional" });
    expect(candidateDisposition({ ...passing, packageVersion: "999.999.999" }).exitCode).toBe(1);
    const embedded = (change: (summary: typeof passing) => void) => {
      const summary = structuredClone(passing);
      change(summary);
      return candidateDisposition(summary);
    };
    for (const schema of [undefined, "wrong/v999"]) {
      expect(embedded((summary) => { summary.docker.policy.schema = schema; }))
        .toMatchObject({ exitCode: 1, failureClass: "functional" });
      expect(embedded((summary) => { summary.securityGate.findings.schema = schema; }))
        .toMatchObject({ exitCode: 1, failureClass: "functional" });
    }
  });

  it("writes every registry-policy violation to the report the summary reads", () => {
    const { packages, manifest, run } = dependencyPolicyHarness();
    packages["node_modules/x"] = { version: "1.0.0", resolved: "https://example.com/x-1.0.0.tgz", integrity: sri(Buffer.from("x")) };
    manifest.overrides = { viem: "npm:not-viem@1.0.0" };
    expect(run()).toMatchObject({ status: 0, report: { schema: "dacs-registry-dependency-policy/v1", passed: false,
      violations: [{ location: "package.json", field: "overrides", value: '{"viem":"npm:not-viem@1.0.0"}' },
        { location: "node_modules/x", field: "resolved", value: "https://example.com/x-1.0.0.tgz" }] } });
  });

  it("derives the summary fields from the checks that ran", () => {
    const passing = writeSummary();
    expect(passing).toMatchObject({
      generatedMode: "live-demos", generatedRole: "seller", generatedRails: ["x402", "pay-dem"],
      registryDependencyOnly: true, generatedTestsPassed: true, functionalPassed: true,
      doctor: { observedExitCode: 5, disposition: "blocked-without-credentials" },
    });
    expect(candidateDisposition(passing).exitCode).toBe(4);

    const violation = writeSummary({ "dependency-policy.json": JSON.stringify({
      schema: "dacs-registry-dependency-policy/v1",
      passed: false, violations: [{ location: "package.json", value: "file:../dacs" }],
    }) });
    expect(violation.registryDependencyOnly).toBe(false);
    expect(candidateDisposition(violation).exitCode).toBe(3);

    const failedTests = writeSummary({ "generated-tests.exit-code": "1\n" });
    expect(failedTests).toMatchObject({ generatedTestsPassed: false, functionalPassed: false });
    expect(candidateDisposition(failedTests).exitCode).toBe(1);

    const doctor = writeSummary({ "doctor.exit-code": "0\n" });
    expect(doctor).toMatchObject({ functionalPassed: false, doctor: { disposition: "unexpected" } });
    expect(candidateDisposition(doctor).exitCode).toBe(1);
  });
});


// The consumer may install registry packages only: an allowlist over every
// lock entry and every dependency spec, not a list of known bad forms.
describe("registry dependency allowlist", () => {
  const registry = "http://127.0.0.1:4873";
  const registered = (name: string) => ({ version: "1.0.0", resolved: `${registry}/${name}/-/${name}-1.0.0.tgz`,
    integrity: sri(Buffer.from(name)) });
  const violationsWith = (packages: Record<string, unknown>, manifest: Record<string, unknown> = {}) =>
    registryDependencyViolations({ manifest, registry,
      lock: { packages: { "": { name: "consumer" }, "node_modules/ok": registered("ok"), ...packages } } });

  it("passes registry tarballs with an integrity and registry specs", () => {
    expect(violationsWith({ "node_modules/a": { ...registered("a"), dependencies: { b: "^1.2.3", c: "1.x || >=2.0.0 <3",
      d: "latest", e: "*", f: "", g: "npm:bitcoinjs-lib@^5.2.0", h: "npm:@scope/pkg@1.0.0", i: ">= 1.2.3-beta.1+build.5" },
    optionalDependencies: { j: "~1.0.0" }, peerDependencies: { k: "^5 || ^6" } } },
    { dependencies: { a: "1.0.0" }, devDependencies: { typescript: "5.9.2" } })).toEqual([]);
  });

  it.each([
    ["a tarball from an arbitrary host", "https://example.com/x/-/x-1.0.0.tgz"],
    ["a codeload.github.com tarball", "https://codeload.github.com/o/x/tar.gz/0123456789abcdef0123456789abcdef01234567"],
    ["a Git URL with a ref", "git+ssh://git@github.com/o/x.git#0123456789abcdef0123456789abcdef01234567"],
    ["a Git URL without a ref", "git+https://github.com/o/x.git"],
    ["a GitLab tarball", "https://gitlab.com/o/x/-/archive/main/x-main.tar.gz"],
    ["a file: tarball", "file:../x-1.0.0.tgz"],
    ["a registry tarball on another port", "http://127.0.0.1:4874/x/-/x-1.0.0.tgz"],
    ["a registry tarball over another scheme", "https://127.0.0.1:4873/x/-/x-1.0.0.tgz"],
    ["a relative path", "../x"],
  ])("rejects an installed entry resolved from %s", (_label, resolved) => {
    expect(violationsWith({ "node_modules/x": { ...registered("x"), resolved } }))
      .toEqual([{ location: "node_modules/x", field: "resolved", value: resolved }]);
  });

  it("rejects an installed entry without resolved, without integrity, or linked to a directory", () => {
    const { resolved: _resolved, ...unresolved } = registered("x");
    const { integrity: _integrity, ...unpinned } = registered("y");
    expect(violationsWith({ "node_modules/x": unresolved, "node_modules/y": unpinned,
      "node_modules/z": { link: true, resolved: "packages/z" }, "node_modules/w": { ...registered("w"), integrity: "sha512-" } }))
      .toEqual([
        { location: "node_modules/x", field: "resolved", value: null },
        { location: "node_modules/y", field: "integrity", value: null },
        { location: "node_modules/z", field: "link", value: "packages/z" },
        { location: "node_modules/z", field: "integrity", value: null },
        { location: "node_modules/w", field: "integrity", value: "sha512-" },
      ]);
  });

  it.each([
    ["a github: shorthand", "github:Irys-xyz/avsc#csp-fixes"],
    ["an owner/repo shorthand", "Irys-xyz/avsc#csp-fixes"],
    ["an owner/repo shorthand without a ref", "Irys-xyz/avsc"],
    ["a GitHub URL without a ref", "https://github.com/Irys-xyz/avsc"],
    ["a GitHub URL with a ref (the #191 avsc form)", "https://github.com/Irys-xyz/avsc#csp-fixes"],
    ["a GitLab URL", "https://gitlab.com/o/avsc#main"],
    ["a gitlab: shorthand", "gitlab:o/avsc"],
    ["a Git URL", "git://github.com/o/avsc.git"],
    ["an scp-style Git URL", "git@github.com:o/avsc.git"],
    ["a tarball URL", "https://example.com/avsc-1.0.0.tgz"],
    ["a file: spec", "file:../avsc"],
    ["a link: spec", "link:../avsc"],
    ["a relative directory", "./avsc"],
    ["a parent directory", "../avsc"],
    ["a tarball file", "avsc-1.0.0.tgz"],
    ["a workspace: spec", "workspace:*"],
  ])("rejects a dependency spec that is %s, in the lock and the manifest", (_label, spec) => {
    expect(violationsWith({ "node_modules/z": { ...registered("z"), dependencies: { avsc: spec } } }))
      .toEqual([{ location: "node_modules/z", field: "dependencies.avsc", value: spec }]);
    expect(violationsWith({ "node_modules/z": { ...registered("z"), optionalDependencies: { avsc: spec } } }))
      .toEqual([{ location: "node_modules/z", field: "optionalDependencies.avsc", value: spec }]);
    expect(violationsWith({}, { dependencies: { avsc: spec } }))
      .toEqual([{ location: "package.json", field: "dependencies.avsc", value: spec }]);
  });

  // Daybreak r10 P3: a present map that was not a plain object was read as
  // empty, so a spec inside it was never checked.
  it.each([
    ["an array", ["github:Irys-xyz/avsc#csp-fixes"]],
    ["a string", "github:Irys-xyz/avsc#csp-fixes"],
    ["null", null],
  ])("rejects a dependency map that is %s, in the lock and the manifest", (_label, map) => {
    const value = JSON.stringify(map);
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"]) {
      expect(violationsWith({ "node_modules/z": { ...registered("z"), [field]: map } }))
        .toEqual([{ location: "node_modules/z", field, value }]);
      expect(violationsWith({ "": { name: "consumer", [field]: map } })).toEqual([{ location: "", field, value }]);
      expect(violationsWith({}, { [field]: map })).toEqual([{ location: "package.json", field, value }]);
    }
  });

  it("rejects overrides, which can redirect a package to another source", () => {
    expect(violationsWith({}, { overrides: { viem: "npm:not-viem@2.55.19" } }))
      .toEqual([{ location: "package.json", field: "overrides", value: '{"viem":"npm:not-viem@2.55.19"}' }]);
    expect(violationsWith({}, { overrides: { semver: "7.5.4" } })).toHaveLength(1);
  });

  it("rejects an unreadable lock", () => {
    expect(registryDependencyViolations({ manifest: {}, registry, lock: { packages: [] } }))
      .toEqual([{ location: "package-lock.json", field: "packages", value: null }]);
    expect(violationsWith({ "node_modules/x": [] })).toEqual([{ location: "node_modules/x", field: "entry", value: "[]" }]);
  });

  it("refuses a registry that is neither HTTPS nor this run's loopback registry", () => {
    for (const value of ["http://registry.npmjs.org", "http://10.0.0.1:4873"]) {
      expect(() => registryDependencyViolations({ manifest: {}, lock: { packages: { "": {} } }, registry: value })).toThrow("HTTPS or loopback");
    }
    expect(registryDependencyViolations({ manifest: {}, lock: { packages: { "": {} } }, registry: "https://registry.npmjs.org" })).toEqual([]);
  });

  it("reports exactly the #191 baseline's Git dependency for the b7b180f lock", () => {
    const lock = JSON.parse(readFileSync(join(repoRoot, "test/scripts/fixtures/registry-container-b7b180f/generated-package-lock.json"), "utf8"));
    const baseline = JSON.parse(readFileSync(join(repoRoot, "scripts/registry-container-audit-baseline.json"), "utf8"));
    const violations = registryDependencyViolations({ manifest: lock.packages[""], lock, registry: "http://127.0.0.1:32768" });
    expect(violations).toEqual(baseline.policyFindings.gitDependencies.map(({ location, field, value }:
      { location: string; field: string; value: string }) => ({ location, field, value })));
  });
});

describe("advisory-ID baseline", () => {
  const baseline = JSON.parse(readFileSync(join(repoRoot, "scripts/registry-container-audit-baseline.json"), "utf8"));
  const unknown = "GHSA-2222-3333-4444";
  // Outside pull requests an unlisted ID fails closed: exit 3, and a claimed
  // exit 4 is refused by the step's re-check. On pull_request it only warns.
  const expectUnlisted = (summary: ReturnType<typeof baselineOnlySummary>, unlisted: string[]) => {
    const result = registryContainerDisposition(summary);
    expect(result).toMatchObject({ exitCode: 3, failureClass: "policy", unlistedAdvisories: unlisted,
      checks: { audit: "blocked" } });
    expect(result.message).toContain(`advisory IDs not in the #191 baseline: ${unlisted.join(", ")}`);
    expect(result.message).toContain("registry-container-audit-baseline.json and .md in a PR under CODEOWNERS review");
    expect(registryAuditDriftDisposition(summary)).toMatchObject({ exitCode: 3, unlistedAdvisories: unlisted });
    for (const event of ["schedule", "workflow_dispatch", "push"]) {
      expect(runWorkflowStep(3, summary, false, undefined, event).status).toBe(3);
      const claimed = runWorkflowStep(4, summary, false, undefined, event);
      expect(claimed.status).toBe(4);
      expect(claimed.stdout).toContain(`::error title=Registry/container acceptance policy failure::`);
      expect(claimed.stdout).toContain(unlisted[0]);
      expect(claimed.stdout).not.toContain("::warning title=#191 security gate blocked::");
    }
    const warned = registryContainerDisposition(summary, undefined, { unlistedAdvisories: "warn" });
    expect(warned).toMatchObject({ exitCode: 4, failureClass: "policy", unlistedAdvisories: unlisted,
      checks: { audit: "unlisted" } });
    expect(warned.message).toContain(`advisory IDs not in the #191 baseline (a pull-request warning; the scheduled ` +
      `drift job and release paths fail on them): ${unlisted.join(", ")}`);
    const pullRequest = runWorkflowStep(4, summary);
    expect(pullRequest.status).toBe(0);
    expect(pullRequest.stdout).toContain(`::warning title=Advisory IDs outside the #191 baseline::${unlisted.join(", ")}. ` +
      "Pull requests only warn; the scheduled drift job and release paths fail");
    expect(pullRequest.stdout).toContain("::warning title=#191 security gate blocked::");
    // A baseline-only disposition (exit 4) is no error annotation.
    expect(pullRequest.stdout).not.toContain("::error title=Registry/container acceptance");
    expect(pullRequest.stepSummary).toBe("- Advisory IDs outside the #191 baseline (warning on this pull request; the " +
      `scheduled drift job and release paths fail on them): ${unlisted.join(", ")}\n`);
    expect(runDriftStep(summary, false).status).toBe(0);
    expect(runDriftStep(summary, true).status).toBe(3);
  };
  it("warns a pull request on an appended unlisted advisory and fails closed everywhere else, drift included", () => {
    const summary = baselineOnlySummary();
    summary.audit.observedAdvisories.push(unknown);
    summary.audit.unlistedAdvisories.push(unknown);
    expectUnlisted(summary, [unknown]);
  });
  it("treats a same-count substitution the same way", () => {
    const summary = baselineOnlySummary();
    summary.audit.observedAdvisories = [unknown];
    summary.audit.unlistedAdvisories = [unknown];
    expectUnlisted(summary, [unknown]);
    const full = baselineOnlySummary();
    full.audit.observedAdvisories = [...baseline.advisoryIds.slice(1), unknown];
    full.audit.unlistedAdvisories = [unknown];
    expect(full.audit.observedAdvisories).toHaveLength(baseline.advisoryIds.length);
    expectUnlisted(full, [unknown]);
  });
  it("records the policy the script's --record call used, and fails closed without one", () => {
    const directory = mkdtempSync(join(tmpdir(), "dacs-registry-policy-"));
    scratch.push(directory);
    const summary = baselineOnlySummary();
    summary.audit.observedAdvisories.push(unknown);
    summary.audit.unlistedAdvisories.push(unknown);
    const record = (policy?: string) => {
      const path = join(directory, "acceptance-summary.json");
      writeFileSync(path, JSON.stringify(summary));
      const result = spawnSync(process.execPath, ["scripts/registry-container-disposition.mjs", "--record", path], {
        cwd: repoRoot, encoding: "utf8", env: policy === undefined ? {} : { DACS_UNLISTED_ADVISORIES: policy } });
      return { status: result.status, recorded: JSON.parse(readFileSync(path, "utf8")) };
    };
    expect(record("warn")).toMatchObject({ status: 4, recorded: { disposition: { exitCode: 4, unlistedAdvisories: "warn" } } });
    expect(record()).toMatchObject({ status: 3, recorded: { disposition: { exitCode: 3, unlistedAdvisories: "fail" } } });
    expect(record("fail").status).toBe(3);
    expect(record("ignore").status).not.toBe(0);
    expect(record("ignore").status).not.toBe(4);
  });
  it("lets a pull request pass an unlisted ID only when nothing else is blocked", () => {
    const summary = baselineOnlySummary();
    summary.audit.observedAdvisories.push(unknown);
    summary.audit.unlistedAdvisories.push(unknown);
    summary.securityGate.registryDependencyPolicyPassed = false;
    expect(registryContainerDisposition(summary, undefined, { unlistedAdvisories: "warn" })).toMatchObject({ exitCode: 3,
      checks: { audit: "unlisted", registryDependency: "blocked" } });
    expect(runWorkflowStep(4, summary).status).toBe(4);
  });
  // Code r9 P3-2: SECURITY.md says CI fails on any direct high/critical
  // advisory, but pull requests only warned on an unlisted direct one.
  it("fails a pull request on an unlisted advisory that is high or critical on a direct dependency", () => {
    const summary: ReturnType<typeof baselineOnlySummary> & { audit: { directAdvisories?: string[] } } =
      baselineOnlySummary();
    summary.audit.observedAdvisories.push(unknown, "GHSA-3333-4444-5555");
    summary.audit.unlistedAdvisories.push(unknown, "GHSA-3333-4444-5555");
    summary.audit.directAdvisories = [unknown];
    for (const policy of ["warn", "fail"]) {
      const result = registryContainerDisposition(summary, undefined, { unlistedAdvisories: policy });
      expect(result).toMatchObject({ exitCode: 3, failureClass: "policy", checks: { audit: "blocked" } });
      expect(result.message).toContain(`of those, high or critical on a direct dependency, which fail pull requests ` +
        `too: ${unknown}`);
    }
    const pullRequest = runWorkflowStep(4, summary);
    expect(pullRequest.status).toBe(4);
    expect(pullRequest.stdout).toContain("::error title=Registry/container acceptance policy failure::");
    expect(runWorkflowStep(3, summary).status).toBe(3);
    // The same IDs, neither of them direct, only warn.
    summary.audit.directAdvisories = [];
    expect(registryContainerDisposition(summary, undefined, { unlistedAdvisories: "warn" }))
      .toMatchObject({ exitCode: 4, checks: { audit: "unlisted" } });
    expect(runWorkflowStep(4, summary).status).toBe(0);
  });
  // Code r10 P3-2: a baseline-only exit 4 lets a prerelease publish, so the
  // #191 baseline may waive transitive findings only.
  it("keeps a subset of the baseline advisories baseline-only (exit 4)", () => {
    const summary = baselineOnlySummary();
    summary.audit.observedAdvisories = baseline.advisoryIds.slice(10);
    expect(registryContainerDisposition(summary)).toMatchObject({ exitCode: 4, unlistedAdvisories: [],
      checks: { audit: "baseline" } });
    const result = runWorkflowStep(4, summary);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("::warning title=#191 security gate blocked::");
    expect(result.stdout).not.toContain("::warning title=Advisory IDs outside the #191 baseline::");
    expect(result.stepSummary).toBe("");
    expect(runWorkflowStep(4, summary, false, undefined, "schedule").status).toBe(0);
    expect(runDriftStep(summary, true).status).toBe(0);
  });
  it("reports drift even when a non-audit failure fails the acceptance step", () => {
    // P3-4: a blocked dependency policy (exit 3) must not mask the drift result.
    const summary = baselineOnlySummary();
    summary.audit.observedAdvisories.push(unknown);
    summary.audit.unlistedAdvisories.push(unknown);
    summary.securityGate.registryDependencyPolicyPassed = false;
    expect(runWorkflowStep(3, summary, true).status).toBe(3);
    const drift = runDriftStep(summary, true);
    expect(drift.status).toBe(3);
    expect(drift.stdout).toContain(`Unlisted advisory IDs: ${unknown}`);
    expect(runDriftStep(baselineOnlySummary(), true).status).toBe(0);
    expect(runDriftStep(undefined, true).status).toBe(1);
    expect(runDriftStep(undefined, false).status).toBe(0);
  });
  it("passes the scheduled classification for listed advisories with consistent changed counts", () => {
    const summary = baselineOnlySummary();
    summary.audit.total = 145; summary.audit.critical = 5; summary.audit.low = 97;
    expect(registryAuditDriftDisposition(summary).exitCode).toBe(0);
    expect(registryContainerDisposition(summary).exitCode).toBe(4);
  });
  it("rejects advisory IDs behind contradictory zero totals", () => {
    const summary = baselineOnlySummary();
    Object.assign(summary.audit, { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 });
    expect(registryContainerDisposition(summary).exitCode).toBe(3);
    expect(registryAuditDriftDisposition(summary).exitCode).toBe(3);
  });
  it.each([{}, { ...baseline, advisoryIds: ["bogus"] }, { ...baseline, source: {} },
    { ...baseline, assessedAdvisories: [{ id: "GHSA-23hp-3jrh-7fpw", assessment: "SECURITY.md" }] },
    { ...baseline, assessedAdvisories: [{ id: "bogus", assessment: "SECURITY.md" }] },
    { ...baseline, assessedAdvisories: [{ id: "GHSA-2222-3333-4444", assessment: " " }] },
    { ...baseline, assessedAdvisories: "GHSA-2222-3333-4444" }])("fails closed for a malformed baseline %j", (bad) => {
    expect(() => classifyRegistryAudit([], bad)).toThrow();
    expect(registryContainerDisposition(baselineOnlySummary(), bad).exitCode).toBe(3);
    expect(registryAuditDriftDisposition(baselineOnlySummary(), bad).exitCode).toBe(3);
  });
  it("accepts an empty #191 list, in which every observed ID is unlisted", () => {
    expect(classifyRegistryAudit(["GHSA-23hp-3jrh-7fpw"], { ...baseline, advisoryIds: [] }))
      .toMatchObject({ unlistedAdvisories: ["GHSA-23hp-3jrh-7fpw"], assessedAdvisories: [] });
  });
});

// Once #191's findings are gone, SECURITY.md's audit policy still allows
// transitive advisories assessed for reachability; the gate must be able to
// pass with them, and never with a direct high/critical one.
describe("assessed advisories", () => {
  const baseline = JSON.parse(readFileSync(join(repoRoot, "scripts/registry-container-audit-baseline.json"), "utf8"));
  const assessedId = "GHSA-2222-3333-4444";
  const assessed = { ...baseline, assessedAdvisories: [{ id: assessedId, assessment: "SECURITY.md#audit-policy" }] };
  const cleared = (direct: string[] | null = []) => {
    const summary: ReturnType<typeof baselineOnlySummary> & { audit: { directAdvisories?: string[] } } = baselineOnlySummary();
    summary.securityGate.passed = true;
    summary.audit.observedAdvisories = [assessedId];
    if (direct !== null) summary.audit.directAdvisories = direct;
    else Reflect.deleteProperty(summary.audit, "directAdvisories");
    return summary;
  };

  it("passes the gate (exit 0) when every observed advisory is an assessed transitive one", () => {
    expect(registryContainerDisposition(cleared(), assessed)).toMatchObject({ exitCode: 0, failureClass: null,
      checks: { audit: "passed" }, assessedAdvisories: [assessedId] });
    expect(registryAuditDriftDisposition(cleared(), assessed)).toMatchObject({ exitCode: 0 });
    // Not yet assessed: the same tree is an unlisted ID.
    expect(registryContainerDisposition({ ...cleared(), audit: { ...cleared().audit, unlistedAdvisories: [assessedId] } }))
      .toMatchObject({ exitCode: 3, checks: { audit: "blocked" } });
  });

  it("keeps #191 baseline IDs beside assessed ones baseline-only", () => {
    const summary = cleared();
    summary.audit.observedAdvisories = ["GHSA-23hp-3jrh-7fpw", assessedId];
    summary.securityGate.passed = false;
    expect(registryContainerDisposition(summary, assessed)).toMatchObject({ exitCode: 4, checks: { audit: "baseline" } });
  });

  it("never accepts an assessed advisory that is high or critical on a direct dependency", () => {
    const result = registryContainerDisposition(cleared([assessedId]), assessed, { unlistedAdvisories: "warn" });
    expect(result).toMatchObject({ exitCode: 3, checks: { audit: "blocked" } });
    expect(result.message).toContain(`which an assessment cannot accept: ${assessedId}`);
    // A summary that does not record directness cannot show it is transitive.
    expect(registryContainerDisposition(cleared(null), assessed)).toMatchObject({ exitCode: 3, checks: { audit: "blocked" } });
  });

  it("records directness from npm's report and lets the summary pass the gate", () => {
    const directory = mkdtempSync(join(tmpdir(), "dacs-registry-audit-policy-"));
    scratch.push(directory);
    const via = (id: string, severity: string) => ({ source: 1, name: "x", dependency: "x", title: "t",
      url: `https://github.com/advisories/${id}`, severity, cwe: [], cvss: {}, range: "<2" });
    const report = { auditReportVersion: 2, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 1, high: 2, critical: 0, total: 3 } },
      vulnerabilities: {
        direct: { name: "direct", severity: "high", isDirect: true, via: [via("GHSA-3333-4444-5555", "high"), "transitive"] },
        moderate: { name: "moderate", severity: "moderate", isDirect: true, via: [via("GHSA-4444-5555-6666", "moderate")] },
        transitive: { name: "transitive", severity: "high", isDirect: false, via: [via("GHSA-23hp-3jrh-7fpw", "high")] },
      } };
    writeFileSync(join(directory, "npm-audit.json"), JSON.stringify(report));
    const policyPath = join(directory, "audit-policy.json");
    const result = spawnSync(process.execPath, ["scripts/registry-container-disposition.mjs", "--audit-policy",
      join(directory, "npm-audit.json"), policyPath], { cwd: repoRoot, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(policyPath, "utf8"))).toMatchObject({
      observedAdvisories: ["GHSA-23hp-3jrh-7fpw", "GHSA-3333-4444-5555", "GHSA-4444-5555-6666"],
      unlistedAdvisories: ["GHSA-3333-4444-5555", "GHSA-4444-5555-6666"], assessedAdvisories: [],
      directAdvisories: ["GHSA-3333-4444-5555"], passed: false });

    const policy = { schema: "dacs-registry-audit-policy/v1", observedAdvisories: [assessedId],
      unlistedAdvisories: [], assessedAdvisories: [assessedId], directAdvisories: [], passed: true };
    const summary = writeSummary({ "audit-policy.json": JSON.stringify(policy), "npm-audit.exit-code": "1\n" });
    expect(summary.securityGate.passed).toBe(true);
    expect(summary.audit).toMatchObject({ assessedAdvisories: [assessedId], directAdvisories: [] });
    expect(candidateDisposition(summary, assessed)).toMatchObject({ exitCode: 0 });
    expect(writeSummary({ "audit-policy.json": JSON.stringify({ ...policy, passed: false }), "npm-audit.exit-code": "1\n" })
      .securityGate.passed).toBe(false);
    expect(writeSummary({ "audit-policy.json": JSON.stringify({ ...policy, observedAdvisories: [], assessedAdvisories: [] }),
      "npm-audit.exit-code": "1\n" }).securityGate.passed).toBe(false);
  });
});

// Selected original lock entries used by the offline engine scan.
const b7b180f = join(repoRoot, "test/scripts/fixtures/registry-container-b7b180f");
// .gitignore ignores *.log, so that run's engine-strict.log is stored as
// engine-strict.log.txt; every other file keeps its artifact name.
const b7b180fFile = (name: string) => join(b7b180f, name === "engine-strict.log" ? "engine-strict.log.txt" : name);
// These simulations explicitly construct an inventory, absent from that run,
// derived from the lock in use: its production closure without the optional
// entries, which is what the image's `npm prune --omit=dev --omit=optional`
// leaves. A CI run uploads observed fixtures with a real inventory.
function closureInventory(lockText: string | undefined) {
  const packages: Record<string, { version?: string; name?: string; dev?: boolean; optional?: boolean }> =
    JSON.parse(lockText ?? "{}").packages ?? {};
  return JSON.stringify({ schema: "dacs-runtime-image-inventory/v1", packages: Object.entries(packages)
    .filter(([location, entry]) => location.startsWith("node_modules/") && !entry.dev && !entry.optional)
    .map(([location, entry]) => ({ location, version: entry.version,
      name: entry.name ?? location.slice(location.lastIndexOf("node_modules/") + 13) })) });
}
function b7b180fEvidence(overrides: Record<string, string | undefined> = {}) {
  const recorded = (name: string) => name in overrides ? overrides[name]
    : (() => { try { return readFileSync(b7b180fFile(name), "utf8"); } catch { return undefined; } })();
  const read = recorded;
  const summary = JSON.parse(readFileSync(join(b7b180f, "acceptance-summary.json"), "utf8"));
  summary.complete = true; // Completion metadata for this offline reconstruction.
  summary.securityGate.findings = extractPolicyFindings(read);
  return summary;
}

// Simulations explicitly supply the absent inventory and transitive-audit assumption.
function b7b180fSimulation(overrides: Record<string, string | undefined> = {}) {
  const summary = b7b180fEvidence({ "runtime-image-inventory.json": closureInventory(
    overrides["generated-package-lock.json"] ?? readFileSync(join(b7b180f, "generated-package-lock.json"), "utf8")), ...overrides });
  summary.audit.directAdvisories = [];
  return summary;
}
const historicalDisposition = (summary: unknown, baseline?: unknown) =>
  registryContainerDisposition(summary, baseline, { packageVersion: "0.1.0-alpha.0" });

describe("#191 policy-finding baseline", () => {
  it("pins simulated historical replay to the recorded release", () => {
    const summary = b7b180fSimulation();
    expect(registryContainerDisposition(summary, undefined, { packageVersion: "0.1.1" }).exitCode).toBe(1);
    expect(historicalDisposition(summary).exitCode).toBe(4);
  });

  it("does not invent a runtime inventory for the recorded run", () => {
    expect(b7b180fEvidence().securityGate.findings.productionImageInventory.scanComplete).toBe(false);
  });
  const baseline = JSON.parse(readFileSync(join(repoRoot, "scripts/registry-container-audit-baseline.json"), "utf8"));

  it("keeps the recorded run blocked without observed inventory and directness", () => {
    const summary = b7b180fEvidence();
    expect(classifyPolicyChecks(summary, baseline)).toEqual({ registryDependency: "baseline", productionImage: "blocked",
      engineStrict: "baseline", lockSbom: "baseline", physicalSbom: "baseline" });
    expect(historicalDisposition(summary)).toMatchObject({ exitCode: 3, failureClass: "policy" });
    expect(summary.securityGate.findings.engine.violations).toHaveLength(16);
    // Without the recorded findings the same run is blocked, as at b7b180f.
    expect(historicalDisposition(summary, { ...baseline, policyFindings: undefined }).exitCode).toBe(3);
  });

  const lock = () => JSON.parse(readFileSync(join(b7b180f, "generated-package-lock.json"), "utf8"));
  const withLock = (edit: (packages: Record<string, Record<string, unknown>>) => void) => {
    const value = lock(); edit(value.packages); return JSON.stringify(value);
  };
  const dependencyPolicy = (violations: unknown[]) => JSON.stringify({ schema: "dacs-registry-dependency-policy/v1",
    passed: false, violations });
  const avsc = { location: "node_modules/@bundlr-network/client/node_modules/arbundles", field: "dependencies.avsc",
    value: "https://github.com/Irys-xyz/avsc#csp-fixes" };
  const strictLog = readFileSync(b7b180fFile("engine-strict.log"), "utf8");
  const sbomErr = (name: string) => readFileSync(join(b7b180f, name), "utf8");
  it.each([
    ["a different Git dependency", "registryDependency", { "dependency-policy.json": dependencyPolicy([avsc,
      { location: "node_modules/other", field: "dependencies.x", value: "git+https://github.com/x/y.git" }]) }],
    ["the same Git dependency from another ref", "registryDependency", { "dependency-policy.json":
      dependencyPolicy([{ ...avsc, value: "https://github.com/Irys-xyz/avsc#main" }]) }],
    ["the Git dependency at another lock location", "registryDependency", { "dependency-policy.json":
      dependencyPolicy([{ ...avsc, location: "node_modules/arbundles" }]) }],
    ["a direct file: dependency", "registryDependency", { "dependency-policy.json":
      dependencyPolicy([{ location: "package.json", value: "file:../dacs" }]) }],
    ["a new engine violation", "engineStrict", { "generated-package-lock.json": withLock(p => {
      p["node_modules/new-pkg"] = { version: "1.0.0", integrity: "sha512-new", engines: { node: ">=22" } }; }) }],
    ["a new violation of a package's npm engine", "engineStrict", { "generated-package-lock.json": withLock(p => {
      requiredFixtureEntry(p["node_modules/minipass"], "node_modules/minipass").engines = { node: ">=16", npm: ">=12" }; }) }],
    ["a baselined package with a changed range", "engineStrict", { "generated-package-lock.json": withLock(p => {
      requiredFixtureEntry(p["node_modules/@npmcli/agent"], "node_modules/@npmcli/agent").engines = { node: ">=24" }; }) }],
    ["a strict failure not explained by the scan", "engineStrict", { "engine-strict.log":
      strictLog.replaceAll("@npmcli/agent@5.0.2", "other@1.0.0") }],
    ["an engine range the scan cannot read", "engineStrict", { "generated-package-lock.json": withLock(p => {
      requiredFixtureEntry(p["node_modules/minipass"], "node_modules/minipass").engines = { node: "please-use-yarn" }; }) }],
    ["an engine scan without the container's versions", "engineStrict", { "engine-versions.json": undefined }],
    ["an engine scan without the container's npm version", "engineStrict", { "engine-versions.json":
      JSON.stringify({ node: "v20.19.1" }) }],
    ["an engine-strict failure other than EBADENGINE", "engineStrict", { "engine-strict.log": "npm error code EBADPLATFORM\n" }],
    ["a new lock SBOM problem", "lockSbom", { "consumer-lock-sbom.err": sbomErr("consumer-lock-sbom.err") +
      "npm error invalid: viem@2.0.0, ^2.55.19 required by x@1.0.0\n" }],
    ["a lock SBOM usage error", "lockSbom", { "consumer-lock-sbom.err": "npm error code EUSAGE\n" }],
    ["baselined SBOM lines under another error code", "physicalSbom", { "consumer-physical-sbom.err":
      sbomErr("consumer-physical-sbom.err").replace("ESBOMPROBLEMS", "EINVALIDTREE") }],
    ["a new physical SBOM problem", "physicalSbom", { "consumer-physical-sbom.err": sbomErr("consumer-physical-sbom.err") +
      "npm error missing: other@1.0.0, required by x@1.0.0\n" }],
    ["a lock SBOM problem against a changed range", "lockSbom", { "consumer-lock-sbom.err":
      sbomErr("consumer-lock-sbom.err").replace(">=0.62.0 <1.0.0", ">=0.63.0 <1.0.0") }],
    ["typescript in the image but not at the lock's top level", "productionImage", {
      "generated-package-lock.json": withLock(p => { delete p["node_modules/typescript"]; }) }],
    ["rubic-sdk in the image", "productionImage", { "runtime-image-policy.json": JSON.stringify({
      ...JSON.parse(readFileSync(join(b7b180f, "runtime-image-policy.json"), "utf8")), rubicSdkPresent: true }) }],
  ])("still exits 3 for %s", (_label, check, overrides) => {
    const summary = b7b180fSimulation(overrides as Record<string, string | undefined>);
    expect(classifyPolicyChecks(summary, baseline)[check as string]).toBe("blocked");
    expect(historicalDisposition(summary)).toMatchObject({ exitCode: 3, failureClass: "policy" });
  });

  // Final r11 review: the consumer installs without a lockfile, so a patch
  // release under the same rule (make-fetch-happen takes @npmcli/agent ^5.0.0)
  // must not turn every PR, the drift job and prereleases red.
  const release = (location: string, version: string) => (p: Record<string, Record<string, unknown>>) => {
    const entry = requiredFixtureEntry(p[location], location);
    entry.version = version; entry.integrity = `sha512-${version}-next-release`;
  };
  it.each([
    ["@npmcli/agent 5.0.3 with the same engine range", "engineStrict", {
      "generated-package-lock.json": withLock(release("node_modules/@npmcli/agent", "5.0.3")),
      "engine-strict.log": strictLog.replaceAll("@npmcli/agent@5.0.2", "@npmcli/agent@5.0.3") }],
    ["arbundles 0.6.24 with the same Git avsc spec", "registryDependency", {
      "generated-package-lock.json": withLock(release("node_modules/@bundlr-network/client/node_modules/arbundles", "0.6.24")) }],
    ["typescript 5.9.3 in the image", "productionImage", {
      "generated-package-lock.json": withLock(release("node_modules/typescript", "5.9.3")) }],
    ["lock SBOM problems with other installed versions", "lockSbom", { "consumer-lock-sbom.err": sbomErr("consumer-lock-sbom.err")
      .replace("arbundles@0.6.23", "arbundles@0.6.24").replace("@ton/core@0.59.1", "@ton/core@0.59.2")
      .replace("@ton/ton@15.4.0", "@ton/ton@15.4.1").replace("@solana/spl-token@0.4.15", "@solana/spl-token@0.4.16") }],
    ["a physical SBOM problem with other installed versions", "physicalSbom", { "consumer-physical-sbom.err":
      sbomErr("consumer-physical-sbom.err").replace("node-fetch@2.7.0", "node-fetch@2.7.1")
        .replace("@near-js/providers@0.2.3", "@near-js/providers@0.2.4") }],
  ])("stays baseline-only (exit 4) for %s", (_label, check, overrides) => {
    const summary = b7b180fSimulation(overrides as Record<string, string | undefined>);
    expect(classifyPolicyChecks(summary, baseline)[check as string]).toBe("baseline");
    expect(historicalDisposition(summary)).toMatchObject({ exitCode: 4, failureClass: "policy" });
  });

  it("passes a check with no findings and blocks a passing flag that carries findings", () => {
    const summary = b7b180fSimulation();
    summary.securityGate.registryDependencyPolicyPassed = true;
    expect(classifyPolicyChecks(summary, baseline).registryDependency).toBe("blocked");
    summary.securityGate.findings.gitDependencies = [];
    expect(classifyPolicyChecks(summary, baseline).registryDependency).toBe("passed");
  });
});

// The image check sees every package in the final image, not only the two the
// policy names: each must be in the lock's production closure at the lock's
// name and version, and the image must hold every required closure entry.
describe("runtime-image package inventory", () => {
  const baseline = JSON.parse(readFileSync(join(repoRoot, "scripts/registry-container-audit-baseline.json"), "utf8"));
  const lockText = readFileSync(join(b7b180f, "generated-package-lock.json"), "utf8");
  const inventory = (edit: (packages: Array<Record<string, unknown>>) => void) => {
    const value = JSON.parse(closureInventory(lockText)); edit(value.packages); return JSON.stringify(value);
  };
  const add = (location: string, name: string | undefined, version: string | undefined) =>
    inventory(packages => { packages.push({ location, name, version }); });

  it("as recorded, without an inventory, blocks the b7b180f run (exit 3)", () => {
    const summary = b7b180fSimulation({ "runtime-image-inventory.json": undefined });
    expect(summary.securityGate.findings.productionImageInventory.scanComplete).toBe(false);
    expect(classifyPolicyChecks(summary, baseline).productionImage).toBe("blocked");
    expect(historicalDisposition(summary)).toMatchObject({ exitCode: 3, failureClass: "policy", checks: { productionImage: "blocked" } });
  });

  it.each([
    ["vitest", add("node_modules/vitest", "vitest", "3.2.4")],
    ["eslint", add("node_modules/eslint", "eslint", "9.30.0")],
    ["a nested esbuild", add("node_modules/sigstore/node_modules/esbuild", "esbuild", "0.25.5")],
    ["a scoped package", add("node_modules/@types/node", "@types/node", "20.19.1")],
    ["a closure package at another version", inventory(packages => {
      requiredFixtureEntry(packages.find(item => item.location === "node_modules/semver"), "node_modules/semver").version = "7.7.1"; })],
    ["a closure location holding another package", inventory(packages => {
      requiredFixtureEntry(packages.find(item => item.location === "node_modules/ssri"), "node_modules/ssri").name = "evil-ssri"; })],
    ["an optional entry the image keeps at another version", add("node_modules/verror", "verror", "1.10.1")],
  ])("blocks %s in the image (exit 3)", (_label, observed) => {
    const summary = b7b180fSimulation({ "runtime-image-inventory.json": observed });
    expect(summary.securityGate.findings.productionImageDependencies.length).toBeGreaterThan(1);
    expect(classifyPolicyChecks(summary, baseline).productionImage).toBe("blocked");
    expect(historicalDisposition(summary)).toMatchObject({ exitCode: 3, failureClass: "policy" });
    // A run whose named-package flag passed is blocked by the same finding.
    summary.securityGate.productionImageDependencyPolicyPassed = true;
    summary.securityGate.findings.productionImageDependencies =
      summary.securityGate.findings.productionImageDependencies.filter((item: { name: string }) => item.name !== "typescript");
    expect(classifyPolicyChecks(summary, baseline).productionImage).toBe("blocked");
  });

  it("stays baseline-only for an optional entry the image keeps, and for an absent one", () => {
    for (const observed of [add("node_modules/verror", "verror", "1.10.0"), undefined]) {
      const summary = b7b180fSimulation(observed === undefined ? {} : { "runtime-image-inventory.json": observed });
      expect(summary.securityGate.findings.productionImageInventory).toEqual({ scanComplete: true, errors: [], missing: [] });
      expect(classifyPolicyChecks(summary, baseline).productionImage).toBe("baseline");
      expect(historicalDisposition(summary)).toMatchObject({ exitCode: 4 });
    }
  });

  it("blocks an image that lacks a required closure package", () => {
    const summary = b7b180fSimulation({ "runtime-image-inventory.json": inventory(packages => {
      packages.splice(packages.findIndex(item => item.location === "node_modules/minipass"), 1); }) });
    expect(summary.securityGate.findings.productionImageInventory.missing).toEqual(["node_modules/minipass"]);
    expect(classifyPolicyChecks(summary, baseline).productionImage).toBe("blocked");
  });

  it("blocks a dev-only lock entry in the image", () => {
    const summary = b7b180fSimulation({
      "generated-package-lock.json": withDev("node_modules/proc-log"),
      "runtime-image-inventory.json": inventory(() => undefined),
    });
    expect(summary.securityGate.findings.productionImageDependencies).toContainEqual(
      { name: "proc-log", location: "node_modules/proc-log", version: "7.0.0", integrity: expect.any(String) });
    expect(classifyPolicyChecks(summary, baseline).productionImage).toBe("blocked");
  });

  it("lists every extra image package when neither named package is present", () => {
    const policy = JSON.parse(readFileSync(b7b180fFile("runtime-image-policy.json"), "utf8"));
    const summary = b7b180fSimulation({
      "runtime-image-policy.json": JSON.stringify({ ...policy, typescriptPresent: false, rubicSdkPresent: false }),
      "runtime-image-inventory.json": inventory(packages => {
        const retained = packages.filter(item => item.name !== "typescript" && item.name !== "rubic-sdk");
        packages.splice(0, packages.length, ...retained, { name: "vitest", location: "node_modules/vitest", version: "3.2.4" });
      }),
    });
    expect(summary.securityGate.findings.productionImageDependencies).toEqual([
      { name: "vitest", location: "node_modules/vitest", version: "3.2.4", integrity: null }]);
  });

  it("lists a named package once when it is also outside the closure", () => {
    const summary = b7b180fSimulation({
      "generated-package-lock.json": withDev("node_modules/typescript"),
      "runtime-image-inventory.json": inventory(() => undefined),
    });
    expect(summary.securityGate.findings.productionImageDependencies
      .filter((item: { location: string }) => item.location === "node_modules/typescript")).toHaveLength(1);
  });
  function withDev(location: string) {
    const value = JSON.parse(lockText); value.packages[location].dev = true; return JSON.stringify(value);
  }

  it.each([
    ["unreadable JSON", "{"],
    ["another schema", JSON.stringify({ schema: "dacs-runtime-image-inventory/v0", packages: [] })],
    ["no package list", JSON.stringify({ schema: "dacs-runtime-image-inventory/v1" })],
    ["an entry without a version", add("node_modules/x", "x", undefined)],
    ["an entry without a name", add("node_modules/x", undefined, "1.0.0")],
    ["a repeated location", add("node_modules/semver", "semver", "7.8.5")],
    ["a scope directory as a package", add("node_modules/@sigstore", "@sigstore", "1.0.0")],
    ["a location outside node_modules", add("lib/x", "x", "1.0.0")],
    ["a dot directory", add("node_modules/.bin", ".bin", "1.0.0")],
  ])("blocks an inventory with %s", (_label, observed) => {
    const summary = b7b180fSimulation({ "runtime-image-inventory.json": observed });
    expect(summary.securityGate.findings.productionImageInventory.scanComplete).toBe(false);
    expect(classifyPolicyChecks(summary, baseline).productionImage).toBe("blocked");
  });

  it("waives a package only when the baseline records its name and location", () => {
    const summary = b7b180fSimulation({ "runtime-image-inventory.json": add("node_modules/vitest", "vitest", "3.2.4") });
    const narrow = { ...baseline, policyFindings: { ...baseline.policyFindings, productionImageDependencies: [
      ...baseline.policyFindings.productionImageDependencies, { name: "vitest", location: "node_modules/vitest" }] } };
    expect(classifyPolicyChecks(summary, narrow).productionImage).toBe("baseline");
    expect(historicalDisposition(summary, narrow)).toMatchObject({ exitCode: 4 });
    const elsewhere = { ...narrow, policyFindings: { ...narrow.policyFindings, productionImageDependencies: [
      ...baseline.policyFindings.productionImageDependencies, { name: "vitest", location: "node_modules/x/node_modules/vitest" }] } };
    expect(classifyPolicyChecks(summary, elsewhere).productionImage).toBe("blocked");
  });

  // A blocked run's log must say which findings the baseline lacks, so they
  // can be reviewed without the run's artifacts.
  it("names the findings outside the baseline when it blocks", () => {
    const summary = b7b180fSimulation({ "runtime-image-inventory.json": add("node_modules/vitest", "vitest", "3.2.4") });
    const recorded = baseline.policyFindings.physicalSbomProblems as string[];
    summary.securityGate.physicalSbomExitCode = 1;
    summary.securityGate.findings.physicalSbom = { exitCode: 1, code: "ESBOMPROBLEMS",
      problems: [...recorded, "invalid: left-pad@9.9.9 node_modules/left-pad"] };
    const result = historicalDisposition(summary, baseline);
    expect(result).toMatchObject({ exitCode: 3,
      checks: { productionImage: "blocked", physicalSbom: "blocked" } });
    expect(result.message).toContain('productionImage: {"name":"vitest","location":"node_modules/vitest"');
    expect(result.message).toContain("physicalSbom: invalid: left-pad@9.9.9 node_modules/left-pad");
    for (const problem of recorded) expect(result.message).not.toContain(problem);
    expect(unlistedPolicyFindings(summary, baseline, ["physicalSbom"]))
      .toEqual({ physicalSbom: ["invalid: left-pad@9.9.9 node_modules/left-pad"] });
  });

  it("reports a lock without packages as an incomplete scan", () => {
    expect(runtimeImageInventoryFindings({ schema: "dacs-runtime-image-inventory/v1", packages: [] }, {}))
      .toEqual({ scanComplete: false, errors: ["the generated lock has no packages"], unexpected: [], missing: [] });
  });

  // The script the acceptance mounts into the image.
  const inventoryScript = join(repoRoot, "scripts/runtime-image-inventory.mjs");
  function imageTree(extra: (root: string) => void = () => undefined) {
    const root = mkdtempSync(join(tmpdir(), "dacs-image-inventory-"));
    scratch.push(root);
    const pkg = (location: string, manifest: Record<string, unknown>) => {
      mkdirSync(join(root, location), { recursive: true });
      writeFileSync(join(root, location, "package.json"), JSON.stringify(manifest));
    };
    pkg("node_modules/a", { name: "a", version: "1.0.0" });
    pkg("node_modules/@s/b", { name: "@s/b", version: "2.0.0" });
    pkg("node_modules/a/node_modules/c", { name: "c", version: "3.0.0" });
    pkg("node_modules/alias", { name: "real", version: "4.0.0" });
    mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
    writeFileSync(join(root, "node_modules/.package-lock.json"), "{}");
    extra(root);
    return root;
  }
  const treeLock = { packages: { "": { name: "app" },
    "node_modules/a": { version: "1.0.0" }, "node_modules/@s/b": { version: "2.0.0" },
    "node_modules/a/node_modules/c": { version: "3.0.0" }, "node_modules/alias": { name: "real", version: "4.0.0" },
    "node_modules/opt": { version: "5.0.0", optional: true } } };

  it("lists every package in the image tree, nested, scoped and aliased", () => {
    const listed = runtimeImageInventory(imageTree());
    expect(listed).toEqual({ schema: "dacs-runtime-image-inventory/v1", packages: [
      { location: "node_modules/@s/b", name: "@s/b", version: "2.0.0" },
      { location: "node_modules/a", name: "a", version: "1.0.0" },
      { location: "node_modules/a/node_modules/c", name: "c", version: "3.0.0" },
      { location: "node_modules/alias", name: "real", version: "4.0.0" },
    ] });
    expect(runtimeImageInventoryFindings(listed, treeLock))
      .toEqual({ scanComplete: true, errors: [], unexpected: [], missing: [] });
    // The CLI the image runs prints the same inventory.
    const cli = spawnSync(process.execPath, [inventoryScript, imageTree()], { encoding: "utf8" });
    expect(cli.status).toBe(0);
    expect(JSON.parse(cli.stdout)).toEqual(listed);
  });

  it.each([
    ["a directory without a readable manifest", (root: string) => mkdirSync(join(root, "node_modules/d"))],
    ["a file Node could load as a module", (root: string) => writeFileSync(join(root, "node_modules/evil.js"), "")],
    ["a symbolic link", (root: string) => symlinkSync(join(root, "node_modules/a"), join(root, "node_modules/e"))],
  ])("lists %s unread, so the scan is incomplete", (_label, extra) => {
    const listed = runtimeImageInventory(imageTree(extra));
    const unread = listed.packages.filter((item: { name: unknown }) => item.name === null);
    expect(unread).toHaveLength(1);
    // A link is recorded as one, so the evidence shows why it was not read.
    expect(unread[0].link === true).toBe(_label === "a symbolic link");
    expect(runtimeImageInventoryFindings(listed, treeLock).scanComplete).toBe(false);
  });

  it("lists an image without node_modules as empty, which lacks the closure", () => {
    const root = mkdtempSync(join(tmpdir(), "dacs-image-inventory-"));
    scratch.push(root);
    const listed = runtimeImageInventory(root);
    expect(listed.packages).toEqual([]);
    expect(runtimeImageInventoryFindings(listed, treeLock).missing).toEqual(
      ["node_modules/a", "node_modules/@s/b", "node_modules/a/node_modules/c", "node_modules/alias"]);
  });

  // The workflow step that assembles regenerated #191 fixtures from a run's
  // evidence carries the inventory, and the fixture replays here.
  it("assembles disposition fixtures with the inventory from a run's evidence", () => {
    const checkout = mkdtempSync(join(tmpdir(), "dacs-registry-fixtures-"));
    scratch.push(checkout);
    const evidence = join(checkout, "registry-container-artifacts");
    mkdirSync(evidence);
    for (const name of readdirSync(b7b180f)) {
      writeFileSync(join(evidence, name === "engine-strict.log.txt" ? "engine-strict.log" : name),
        readFileSync(join(b7b180f, name)));
    }
    writeFileSync(join(evidence, "runtime-image-inventory.json"), add("node_modules/vitest", "vitest", "3.2.4"));
    writeFileSync(join(evidence, "docker-build.log"), "not a fixture\n");
    const result = runBash(["-e", "-c", workflowStepScript("Assemble disposition fixtures")], {
      cwd: checkout, env: { GITHUB_SHA: "0123456789abcdef", PATH: stubBin(checkout) },
    });
    expect(result.status).toBe(0);
    const fixtures = join(checkout, "registry-container-fixtures/registry-container-0123456");
    expect(readdirSync(fixtures).sort()).toEqual([...readdirSync(b7b180f), "runtime-image-inventory.json"].sort());
    const read = (name: string) => {
      const file = join(fixtures, name === "engine-strict.log" ? "engine-strict.log.txt" : name);
      return existsSync(file) ? readFileSync(file, "utf8") : undefined;
    };
    const summary = JSON.parse(read("acceptance-summary.json")!);
    summary.securityGate.findings = extractPolicyFindings(read);
    expect(summary.securityGate.findings.productionImageDependencies)
      .toContainEqual({ name: "vitest", location: "node_modules/vitest", version: "3.2.4", integrity: null });
    // This offline replay supplies the historical run's absent completion and directness metadata.
    expect(historicalDisposition({ ...summary, complete: true, audit: { ...summary.audit, directAdvisories: [] } }))
      .toMatchObject({ exitCode: 3, checks: { productionImage: "blocked" } });
    expect(workflowStepCondition("Assemble disposition fixtures")).toBe("always()");
    expect(workflowStepCondition("Upload disposition fixtures")).toBe("always()");
    expect(workflowStepLines("Upload disposition fixtures").lines.slice(
      workflowStepLines("Upload disposition fixtures").start, workflowStepLines("Upload disposition fixtures").end).join("\n"))
      .toContain("path: registry-container-fixtures/");
  });
});

// The 206adc1 run stopped here: `npm ci --no-engine-strict` printed every
// EBADENGINE and then failed npm's lock sync check on the nested Git `avsc`
// (EUSAGE), so the scan never completed and the job exited 3.
describe("lock engine scan", () => {
  const baseline = JSON.parse(readFileSync(join(repoRoot, "scripts/registry-container-audit-baseline.json"), "utf8"));
  const lock = () => JSON.parse(readFileSync(join(b7b180f, "generated-package-lock.json"), "utf8"));
  const container = { node: "v20.19.1", npm: "11.19.0" };
  const byLocation = (items: { location: string }[]) => [...items].sort((a, b) => a.location.localeCompare(b.location));

  it("lists every violation of a tree with a nested Git dependency, exactly the #191 baseline", () => {
    const value = lock();
    expect(value.packages["node_modules/@bundlr-network/client/node_modules/arbundles"].dependencies.avsc)
      .toBe("https://github.com/Irys-xyz/avsc#csp-fixes");
    const scan = scanLockEngines(value, container);
    expect(scan).toMatchObject({ scanComplete: true, errors: [], node: "v20.19.1", npm: "11.19.0" });
    expect(scan.evaluatedPackages).toBe(Object.values(value.packages)
      .filter((entry) => (entry as { optional?: boolean }).optional !== true).length);
    expect(byLocation(scan.violations)).toEqual(byLocation(baseline.policyFindings.engineViolations));
    expect(scan.violations).toHaveLength(16);
    expect(b7b180fEvidence().securityGate.findings.engine).toMatchObject({ scanComplete: true,
      scan: { node: "v20.19.1", npm: "11.19.0", errors: [] }, reportedPackage: "@npmcli/agent@5.0.2" });
  });

  it("skips optional packages and non-object engines, as npm's check does", () => {
    // @arbitrum/sdk (optional) declares engines.npm "please-use-yarn"; verror
    // (optional) declares the legacy array form.
    const value = lock();
    expect(value.packages["node_modules/@arbitrum/sdk"]).toMatchObject({ optional: true,
      engines: { npm: "please-use-yarn" } });
    value.packages["node_modules/verror"].optional = false;
    expect(scanLockEngines(value, container)).toMatchObject({ scanComplete: true, errors: [] });
    value.packages["node_modules/@arbitrum/sdk"].optional = false;
    expect(scanLockEngines(value, container)).toMatchObject({ scanComplete: false,
      errors: [expect.stringContaining("node_modules/@arbitrum/sdk")] });
  });

  it("counts an array-valued lock entry as unreadable, not as evaluated", () => {
    const value = lock();
    value.packages["node_modules/semver"] = [];
    expect(scanLockEngines(value, container)).toMatchObject({ scanComplete: false,
      errors: ["node_modules/semver: unreadable lock entry"] });
  });

  it("checks engines.npm against the container's npm", () => {
    const value = lock();
    value.packages["node_modules/semver"].engines = { node: ">=10", npm: ">=12" };
    expect(scanLockEngines(value, container).violations).toContainEqual({ package: "semver@7.8.5",
      location: "node_modules/semver", integrity: value.packages["node_modules/semver"].integrity,
      required: { node: ">=10", npm: ">=12" } });
    expect(scanLockEngines(value, { ...container, npm: "12.0.0" }).violations).toHaveLength(16);
  });

  it.each([
    ["no lock", undefined, container],
    ["no packages map", { lockfileVersion: 1, dependencies: {} }, container],
    ["no recorded versions", "fixture", null],
    ["a prerelease Node", "fixture", { ...container, node: "v20.19.1-nightly" }],
    ["no recorded npm", "fixture", { node: "v20.19.1" }],
  ])("is incomplete with %s", (_label, value, versions) => {
    const scan = scanLockEngines(value === "fixture" ? lock() : value, versions);
    expect(scan).toMatchObject({ scanComplete: false, evaluatedPackages: 0 });
    expect(scan.errors.length).toBeGreaterThan(0);
  });

  // Expectations from semver.satisfies(version, range, { includePrerelease: true }),
  // which npm's EBADENGINE check uses; the first rows are ranges in the generated lock.
  it.each([
    ["^22.22.2 || ^24.15.0 || >=26.0.0", "20.19.1", false], ["^22.22.2 || ^24.15.0 || >=26.0.0", "22.22.2", true],
    ["^22.22.2 || ^24.15.0 || >=26.0.0", "24.14.9", false], ["^22.22.2 || ^24.15.0 || >=26.0.0", "26.0.0", true],
    ["^20.19.0 || >=22.12.0", "20.19.1", true], ["^20.19.0 || >=22.12.0", "22.11.0", false],
    [">= 0.4", "20.19.1", true], [">= 0.4", "0.3.9", false], [">=v11", "20.19.1", true], [">=v11", "10.9.9", false],
    [">=16 || 14 >=14.17", "14.17.0", true], [">=16 || 14 >=14.17", "14.16.9", false], [">=16 || 14 >=14.17", "15.0.0", false],
    ["4.x || >=6.0.0", "4.9.0", true], ["4.x || >=6.0.0", "5.1.0", false],
    ["6.* || 8.* || >= 10.*", "9.0.0", false], ["6.* || 8.* || >= 10.*", "20.19.1", true],
    ["20.x || 22.x || 23.x || 24.x || 25.x", "20.19.1", true], ["20.x || 22.x || 23.x || 24.x || 25.x", "21.0.0", false],
    ["18 || 20 || >=22", "20.19.1", true], ["18 || 20 || >=22", "21.1.0", false],
    ["> 0.1.90", "0.1.90", false], ["> 0.1.90", "0.1.91", true], ["^14.0 || >=16.0", "15.0.0", false],
    ["^14.0 || >=16.0", "16.0.0", true], ["*", "20.19.1", true], ["<*", "20.19.1", false],
    ["^0.2.3", "0.2.9", true], ["^0.2.3", "0.3.0", false], ["^0.0.3", "0.0.3", true], ["^0.0.3", "0.0.4", false],
    ["^1.2", "1.9.9", true], ["^1.2", "2.0.0", false], ["~1.2.3", "1.2.9", true], ["~1.2.3", "1.3.0", false],
    ["~1", "1.9.0", true], ["~1", "2.0.0", false], ["~> 1.2", "1.2.0", true], ["~> 1.2", "1.3.0", false],
    [">1.2", "1.2.9", false], [">1.2", "1.3.0", true], ["<=1.2", "1.2.9", true], ["<=1.2", "1.3.0", false],
    ["<1", "0.9.9", true], ["<1", "1.0.0", false], ["=1.2", "1.2.5", true], ["=1.2", "1.3.0", false],
    ["1.2.3 - 2.3", "2.3.9", true], ["1.2.3 - 2.3", "2.4.0", false], ["1.2.3 - 2.3.4", "2.3.4", true],
    ["1.2.3 - 2.3.4", "2.3.5", false], ["1.2.3-beta - 2.3.4-rc.1", "1.2.3", true], ["1.2.3-beta - 2.3.4-rc.1", "2.3.4", false],
    [">1.2.3-beta", "1.2.3", true], ["<=1.2.3-beta", "1.2.3", false], ["1.2.3-beta", "1.2.3", false],
    [">=1.2.3+build", "1.2.3", true], ["11.19.0", "11.19.0", true], ["11.19.0", "11.19.1", false],
  ])("evaluates %j at %s as semver does (%s)", (range, version, expected) => {
    expect(satisfiesEngineRange(version, range)).toBe(expected);
    expect(satisfiesEngineRange(`v${version}`, range)).toBe(expected);
  });

  // semver rejects each of these, so npm would not pass them either.
  // The pinned npm's semver 7.8.5 also rejects a plain comparator with a
  // numeric part after an X.
  it.each(["please-use-yarn", "01.2.3", ">=1.2.3.4", "^", "1 -2", "> = 1", "1.2-beta", ">=1 || foo", "V1.2.3",
    "1.x.0", ">=1.x.0", "<1.x.0", "*.1.2", "x.1", "=x.1.2", ">=20 || 1.x.0"])(
    "fails closed on the range %j", (range) => {
      expect(() => satisfiesEngineRange("20.19.1", range)).toThrow(/unsupported engine range/);
    });

  // ...but reads tildes, carets and hyphen ranges with one, as semver 7.8.5 does.
  it.each([
    ["1.5.0", "~1.x.0", true], ["2.0.0", "~1.x.0", false], ["1.5.0", "^1.x.2", true], ["2.0.0", "^1.x.2", false],
    ["1.5.0", "~>1.x.0", true], ["9.9.9", "^x.1", true], ["2.5.0", "1.x.0 - 2", true], ["3.0.0", "1.x.0 - 2", false],
    ["2.9.0", "1 - 2.x.1", true],
  ] as const)("reads %s against %j as semver 7.8.5 does", (version, range, expected) => {
    expect(satisfiesEngineRange(version, range)).toBe(expected);
  });

  it("records the container's Node and npm with the script's own command, not a second npm ci", () => {
    const script = readFileSync(join(repoRoot, "scripts/verify-registry-container-consumer.sh"), "utf8");
    expect(script).not.toContain("--no-engine-strict");
    const command = script.split("\n").find((line) => line.includes("> /work/engine-versions.json"))!.trim()
      .replace("/work/engine-versions.json", "engine-versions.json");
    const directory = mkdtempSync(join(tmpdir(), "dacs-registry-versions-"));
    scratch.push(directory);
    const result = runBash(["-ceu", command], { cwd: directory,
      env: { PATH: stubBin(directory, { npm: "echo 11.19.0" }) } });
    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(join(directory, "engine-versions.json"), "utf8")))
      .toEqual({ node: process.version, npm: "11.19.0" });
  });
});

describe("acceptance failure class", () => {
  const reader = (files: Record<string, string>) => (name: string) => files[name];
  it.each([
    ["consumer", { "generation.log": "npm error code ETIMEDOUT\nnpm error network request failed" }, "network"],
    ["consumer", { "generation.log": "npm error code E503\nnpm error 503 Service Unavailable" }, "network"],
    ["consumer", { "generation.log": "not ok 3 - doctor rejects ECONNREFUSED port\nnpm error code 1" }, "functional"],
    ["registry-start", { "registry.log": "Error response from daemon: Get \"https://registry-1.docker.io/v2/\": net/http: TLS handshake timeout" }, "network"],
    ["registry-ready", {}, "network"],
    ["registry-auth", { "registry.log": "curl: (7) Failed to connect to 127.0.0.1 port 32768" }, "network"],
    ["publish", { "registry.log": "Error: candidate integrity mismatch" }, "functional"],
    ["audit-policy", { "npm-audit.json": '{"metadata":{}}' }, "policy"],
    ["dependency-policy", {}, "policy"],
    ["image-build", { "docker-build.log": "#12 3.1 npm error code ECONNRESET" }, "network"],
    ["image-build", { "docker-build.log": "#14 2.0 error TS2307: Cannot find module" }, "functional"],
    ["release-set", { "generation.log": "npm error code ETIMEDOUT" }, "functional"],
  ])("classifies a %s failure with %j as %s", (stage, files, failureClass) => {
    expect(classifyAcceptanceFailure({ stage, read: reader(files) }).failureClass).toBe(failureClass);
    const summary = failureSummary({ stage, exitCode: 1, read: reader(files) });
    expect(summary).toMatchObject({ complete: false, failedStage: stage, failureClass });
    expect(registryContainerDisposition(summary)).toMatchObject({ exitCode: 1, failureClass });
  });

  // Captured from real npm 10.9.9 against a loopback server: `npm audit --json`
  // stdout when the audit endpoint fails (npm's lib/utils/audit-error.js
  // shape), and `npm install`'s error lines when the registry fails.
  const npmOutput = (kind: string, name: string) => readFileSync(join(repoRoot, "test/scripts/fixtures", kind, name), "utf8");
  // invalid-json-body.json is a 200 answer with an HTML page (a captive proxy's
  // or CDN's error page); aborted-body.json is a connection dropped mid-body.
  it.each(["503.json", "502.json", "500.json", "504.json", "429.json", "timeout.json", "econnreset.json",
    "econnrefused.json", "socket-hang-up.json", "invalid-json-body.json", "aborted-body.json",
  ])("classifies npm's audit endpoint error %s as network, never policy", (name) => {
    const read = reader({ "npm-audit.json": npmOutput("npm-audit-endpoint-errors", name) });
    const summary = failureSummary({ stage: "audit-policy", exitCode: 1, read });
    expect(summary).toMatchObject({ failureClass: "network", failureEvidence: [expect.stringMatching(/^npm-audit\.json: audit endpoint error: /)] });
    expect(registryContainerDisposition(summary)).toMatchObject({ exitCode: 1, failureClass: "network",
      message: "registry/container acceptance stopped at stage audit-policy (network failure)" });
    // The scheduled drift check reports the stopped stage, not a malformed baseline.
    const drift = registryAuditDriftDisposition(summary);
    expect(drift).toMatchObject({ exitCode: 1, evaluated: false, failureClass: "network" });
    expect(drift.message).toBe("Advisory-ID drift was not evaluated: acceptance stopped at stage audit-policy " +
      "(network failure; rerun the workflow)");
  });

  it.each(["403.json", "404.json"])("classifies npm's non-transient audit endpoint answer %s as functional, not policy", (name) => {
    const read = reader({ "npm-audit.json": npmOutput("npm-audit-endpoint-errors", name) });
    expect(classifyAcceptanceFailure({ stage: "audit-policy", read })).toMatchObject({ failureClass: "functional",
      evidence: [expect.stringContaining(`${name.slice(0, 3)} `)] });
  });

  it.each([
    ["a fetch error npm has not been seen to write", { message: "request aborted by an unknown cause" }, "network"],
    ["a transient fetch message beside a status", { message: "invalid json response body at http://r/ reason: x",
      statusCode: 200 }, "network"],
    ["a status answer npm does not retry", { message: "418 I'm a teapot - POST http://r/", statusCode: 418 }, "functional"],
  ])("classifies every npm audit-error object as an endpoint error: %s", (_label, error, failureClass) => {
    const read = reader({ "npm-audit.json": JSON.stringify({ ...error, error: { summary: "", detail: "" } }) });
    expect(classifyAcceptanceFailure({ stage: "audit-policy", read })).toEqual({ failureClass,
      evidence: [`npm-audit.json: audit endpoint error: ${error.message}`] });
  });

  // Daybreak r9 P3: a report the policy rejected, whose advisory title carries
  // a network phrase, was classed network and invited a pointless rerun.
  it("classifies a report-shaped audit the policy rejected as policy, whatever text its advisories carry", () => {
    const stage = mkdtempSync(join(tmpdir(), "dacs-registry-malformed-report-"));
    scratch.push(stage);
    const report = { auditReportVersion: 2,
      metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 } },
      vulnerabilities: { x: { name: "x", severity: "high", isDirect: true,
        via: [{ title: "socket hang up denial of service", severity: "high" }] } } };
    writeFileSync(join(stage, "npm-audit.json"), JSON.stringify(report, null, 2));
    const policy = spawnSync(process.execPath, ["scripts/registry-container-disposition.mjs", "--audit-policy",
      join(stage, "npm-audit.json"), join(stage, "audit-policy.json")], { cwd: repoRoot, encoding: "utf8" });
    expect(policy.status).not.toBe(0);
    expect(policy.stderr).toContain("npm audit advisory URL missing");
    const result = spawnSync(process.execPath, ["scripts/registry-container-disposition.mjs", "--failure-summary", stage,
      "audit-policy", String(policy.status)], { cwd: repoRoot, encoding: "utf8" });
    expect(result.stdout).toContain("::error title=Registry/container acceptance policy failure::stopped at stage audit-policy");
    expect(JSON.parse(readFileSync(join(stage, "acceptance-summary.json"), "utf8"))).toMatchObject({
      failedStage: "audit-policy", failureClass: "policy", failureEvidence: [] });
    // Text that is not an audit document still counts as network evidence.
    expect(classifyAcceptanceFailure({ stage: "audit-policy", read: reader({ "npm-audit.json": "socket hang up\n" }) }))
      .toMatchObject({ failureClass: "network" });
  });

  it.each(["timeout.txt", "503.txt", "429.txt", "reset.txt", "refused.txt"])(
    "classifies npm install's registry error %s in the consumer stage as network", (name) => {
      const read = reader({ "generation.log": npmOutput("npm-install-network-errors", name) });
      expect(classifyAcceptanceFailure({ stage: "consumer", read }).failureClass).toBe("network");
    });

  it("reports an audit outage as a network stop through the script's CLI and the enforced drift step", () => {
    const stage = mkdtempSync(join(tmpdir(), "dacs-registry-outage-"));
    scratch.push(stage);
    writeFileSync(join(stage, "npm-audit.json"), npmOutput("npm-audit-endpoint-errors", "503.json"));
    const result = spawnSync(process.execPath, ["scripts/registry-container-disposition.mjs", "--failure-summary", stage,
      "audit-policy", "1"], { cwd: repoRoot, encoding: "utf8" });
    expect(result.stdout).toContain("::error title=Registry/container acceptance network failure::stopped at stage " +
      "audit-policy with exit 1; npm-audit.json: audit endpoint error: 503 Service Unavailable - POST ");
    const summary = JSON.parse(readFileSync(join(stage, "acceptance-summary.json"), "utf8"));
    expect(summary).toMatchObject({ complete: false, failedStage: "audit-policy", failureClass: "network" });
    const drift = runDriftStep(summary, true);
    expect(drift.status).toBe(1);
    expect(drift.stdout).toContain("::warning title=Registry audit advisory drift::Advisory-ID drift was not evaluated: " +
      "acceptance stopped at stage audit-policy (network failure; rerun the workflow)");
    expect(drift.stdout + drift.stderr).not.toContain("malformed");
    expect(runDriftStep(summary, false).status).toBe(0);
  });

  it("records the class in the early-failure summary and its annotation", () => {
    const { output, result } = runEarlyFailure();
    expect(result.status).toBe(17);
    expect(JSON.parse(readFileSync(join(output, "acceptance-summary.json"), "utf8"))).toMatchObject({
      schema: "dacs-registry-container-acceptance/v1", complete: false, failedStage: "release-set", exitCode: 17,
      failureClass: "functional" });
    expect(result.stdout).toContain(
      "::error title=Registry/container acceptance functional failure::stopped at stage release-set with exit 17");
  });

  it("does not let an early failure summary pass the exit-4 waiver", () => {
    const summary = failureSummary({ stage: "consumer", exitCode: 4, read: () => undefined });
    expect(runWorkflowStep(4, summary).status).toBe(4);
  });
});


it("pins the recorded pqcrypto image version while accepting its recorded metadata spelling", () => {
  const known = { name: "pqcrypto", location: "node_modules/pqcrypto", version: "1.0.01" };
  const baseline = { policyFindings: { productionImageDependencies: [known] } };
  const summary = (version: string) => ({ docker: { policy: { typescriptPresent: false, rubicSdkPresent: false, productionDependencyPolicyPassed: false } }, securityGate: {
    productionImageDependencyPolicyPassed: false, engineStrictExitCode: 0,
    lockSbomExitCode: 0, physicalSbomExitCode: 0,
    findings: { productionImageDependencies: [{ ...known, version }], productionImageInventory: completeInventory },
  } });
  expect(classifyPolicyChecks(summary("1.0.01"), baseline).productionImage).toBe("baseline");
  expect(classifyPolicyChecks(summary("9.0.0"), baseline).productionImage).toBe("blocked");
});


describe("canonical installed candidate discovery", () => {
  it.each(["dacs", "dacs-node"])("rejects untracked %s copies with missing, different or unreadable names", name => {
    for (const manifest of [{ version: "0.0.0-wrong" }, { name: "other", version: "0.0.0-wrong" }, null]) {
      const fixture = dependencyPolicyHarness();
      const location = `node_modules/plugin/node_modules/@kynesyslabs/${name}`;
      const result = fixture.run(project => {
        mkdirSync(join(project, location), { recursive: true });
        if (manifest) writeFileSync(join(project, location, "package.json"), JSON.stringify(manifest));
        writeFileSync(join(project, location, "index.js"), "module.exports = 'old';");
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("installed candidate has no lock entry: " + location);
    }
  });
});

describe("declared candidate alias authentication", () => {
  it.each(["dacs", "dacs-node"])("rejects a same-version replacement for a declared %s alias", name => {
    const fixture = dependencyPolicyHarness();
    const alias = "node_modules/candidate-alias";
    fixture.manifest.dependencies = Object.assign({}, fixture.manifest.dependencies, { "candidate-alias": `npm:@kynesyslabs/${name}@${CANDIDATE_VERSION}` });
    fixture.packages[alias] = { name: "@example/other", version: CANDIDATE_VERSION,
      resolved: `${CANDIDATE_REGISTRY}/other.tgz`, integrity: sri(Buffer.from("replacement")) };
    const result = fixture.run(project => {
      mkdirSync(join(project, alias), { recursive: true });
      writeFileSync(join(project, alias, "package.json"), JSON.stringify({ name: "@example/other", version: CANDIDATE_VERSION }));
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("candidate package integrity does not match the packed tarball: " + alias);
  });
});


describe("candidate alias lookup through dependency maps", () => {
  it.each(["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"])(
    "authenticates installed aliases declared in nested %s maps", field => {
      for (const hoisted of [false, true]) {
        const fixture = dependencyPolicyHarness();
        const location = hoisted ? "node_modules/candidate-alias" : "node_modules/plugin/node_modules/candidate-alias";
        fixture.packages["node_modules/plugin"] = { name: "plugin", version: "1.0.0",
          resolved: `${CANDIDATE_REGISTRY}/plugin.tgz`, integrity: sri(Buffer.from("plugin")),
          [field]: { "candidate-alias": `npm:@kynesyslabs/dacs@${CANDIDATE_VERSION}` } };
        fixture.packages[location] = { name: "other", version: CANDIDATE_VERSION,
          resolved: `${CANDIDATE_REGISTRY}/other.tgz`, integrity: sri(Buffer.from("other")) };
        if (!hoisted) fixture.packages["node_modules/candidate-alias"] = {
          ...fixture.packages["node_modules/@kynesyslabs/dacs"], name: "@kynesyslabs/dacs",
        };
        const result = fixture.run(project => {
          mkdirSync(join(project, "node_modules/plugin"), { recursive: true });
          writeFileSync(join(project, "node_modules/plugin/package.json"), JSON.stringify({ name: "plugin", version: "1.0.0" }));
          mkdirSync(join(project, location), { recursive: true });
          writeFileSync(join(project, location, "package.json"), JSON.stringify({ name: "other", version: CANDIDATE_VERSION }));
        });
        expect(result.status, `${field} ${location}`).not.toBe(0);
        expect(result.stderr).toContain("candidate package integrity does not match the packed tarball: " + location);
      }
    });
  it("accepts an alias that retains the exact candidate identity and bytes", () => {
    const fixture = dependencyPolicyHarness();
    fixture.manifest.dependencies = Object.assign({}, fixture.manifest.dependencies, { alias: `npm:@kynesyslabs/dacs@${CANDIDATE_VERSION}` });
    fixture.packages["node_modules/alias"] = { ...fixture.packages["node_modules/@kynesyslabs/dacs"], name: "@kynesyslabs/dacs" };
    expect(fixture.run().status).toBe(0);
  });
});


describe("candidate file shadows and omitted copies", () => {
  it.each([".js", ".json", ".node"])("rejects canonical and declared alias file shadows with extension %s", extension => {
    for (const name of ["dacs", "dacs-node"]) for (const alias of [false, true]) {
      const fixture = dependencyPolicyHarness();
      const spec = alias ? "candidate-alias" : `@kynesyslabs/${name}`;
      if (alias) fixture.manifest.dependencies = Object.assign({}, fixture.manifest.dependencies, {
        [spec]: `npm:@kynesyslabs/${name}@${CANDIDATE_VERSION}` });
      const location = `node_modules/${spec}${extension}`;
      const result = fixture.run(project => {
        writeFileSync(join(project, location), extension === ".json" ? "{}" : "module.exports = 42;");
        expect(createRequire(join(project, "package.json")).resolve(spec)).toBe(join(project, location));
      });
      expect(result.status, `${name} ${spec}${extension}`).not.toBe(0);
      expect(result.stderr).toContain(location);
    }
  });
  it.each(["optional", "dev", "devOptional"])("allows an omitted %s alias but authenticates it when present", flag => {
    const fixture = dependencyPolicyHarness();
    const alias = "node_modules/candidate-alias";
    fixture.packages[alias] = { ...fixture.packages["node_modules/@kynesyslabs/dacs"], name: "@kynesyslabs/dacs", [flag]: true };
    fixture.manifest.optionalDependencies = { "candidate-alias": `npm:@kynesyslabs/dacs@${CANDIDATE_VERSION}` };
    fixture.installed[alias] = null;
    expect(fixture.run()).toMatchObject({ status: 0, report: { passed: true } });
    fixture.installed[alias] = { name: "@kynesyslabs/dacs", version: "0.0.0-wrong" };
    expect(fixture.run().status).not.toBe(0);
  });
  it("requires a top-level candidate even if its absent lock entry is optional", () => {
    const fixture = dependencyPolicyHarness();
    const location = "node_modules/@kynesyslabs/dacs";
    fixture.packages[location] = { ...fixture.packages[location], optional: true };
    fixture.installed[location] = null;
    expect(fixture.run().status).not.toBe(0);
  });
  it.each([new SyntaxError("fixture malformed JSON"), Object.assign(new Error("permission denied"), { code: "EACCES" })])(
    "preserves installed manifest failure cause: %s", cause => {
      const location = "node_modules/@kynesyslabs/dacs";
      const errors = candidateIntegrityErrors({ manifest: {}, registry: CANDIDATE_REGISTRY,
        lock: { packages: { [location]: { version: CANDIDATE_VERSION, resolved: `${CANDIDATE_REGISTRY}/dacs.tgz`, integrity: "sha512-fixture" } } },
        candidates: [{ name: "@kynesyslabs/dacs", version: CANDIDATE_VERSION, integrity: "sha512-fixture" }],
        installedManifest: () => { throw cause; } });
      expect(errors.join("\n")).toContain(location);
      expect(errors.join("\n")).toContain(cause.message);
      expect(errors.join("\n")).toContain(cause instanceof SyntaxError ? "SyntaxError" : "EACCES");
    });
});

describe("candidate executable and nested alias lookup", () => {
  it.each([false, true])("rejects scope-level node_modules hiding a candidate, locked=%s", locked => {
    const fixture = dependencyPolicyHarness();
    const scope = "node_modules/@kynesyslabs/node_modules";
    if (locked) fixture.packages[scope] = { name: "@kynesyslabs/node_modules", version: "1.0.0",
      resolved: `${CANDIDATE_REGISTRY}/scope.tgz`, integrity: sri(Buffer.from("scope")) };
    const result = fixture.run(project => {
      const location = join(project, scope, "@kynesyslabs/dacs");
      mkdirSync(location, { recursive: true });
      writeFileSync(join(location, "package.json"), JSON.stringify({ name: "@kynesyslabs/dacs", version: "0.0.0-wrong" }));
      writeFileSync(join(location, "index.js"), "module.exports = 'shadow';");
      if (locked) writeFileSync(join(project, scope, "package.json"), JSON.stringify({ name: "@kynesyslabs/node_modules", version: "1.0.0" }));
      expect(createRequire(join(project, "node_modules/@kynesyslabs/dacs-node/index.js")).resolve("@kynesyslabs/dacs"))
        .toBe(join(location, "index.js"));
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("cannot inspect node_modules inside a scope directory: " + scope);
  });

  it.each(["optional", "dev", "devOptional"])("follows the installed alias past an omitted %s lock entry", flag => {
    const fixture = dependencyPolicyHarness();
    const alias = "node_modules/candidate-alias";
    const omitted = "node_modules/plugin/node_modules/candidate-alias";
    fixture.packages["node_modules/plugin"] = { version: "1.0.0", resolved: `${CANDIDATE_REGISTRY}/plugin.tgz`,
      integrity: sri(Buffer.from("plugin")), optionalDependencies: { "candidate-alias": `npm:@kynesyslabs/dacs@${CANDIDATE_VERSION}` } };
    fixture.packages[omitted] = { ...fixture.packages["node_modules/@kynesyslabs/dacs"], name: "@kynesyslabs/dacs", [flag]: true };
    fixture.installed[omitted] = null;
    fixture.packages[alias] = { name: "other", version: CANDIDATE_VERSION,
      resolved: `${CANDIDATE_REGISTRY}/other.tgz`, integrity: sri(Buffer.from("other")) };
    const result = fixture.run(project => {
      mkdirSync(join(project, "node_modules/plugin"), { recursive: true });
      mkdirSync(join(project, alias), { recursive: true });
      writeFileSync(join(project, alias, "package.json"), JSON.stringify({ name: "other", version: CANDIDATE_VERSION }));
      expect(createRequire(join(project, "node_modules/plugin/index.js")).resolve("candidate-alias/package.json"))
        .toBe(join(project, alias, "package.json"));
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("candidate package integrity does not match the packed tarball: " + alias);
    fixture.packages[alias] = { ...fixture.packages["node_modules/@kynesyslabs/dacs"], name: "@kynesyslabs/dacs" };
    expect(fixture.run()).toMatchObject({ status: 0, report: { passed: true } });
  });

  it("accepts an installed candidate's ordinary executable link", () => {
    const fixture = dependencyPolicyHarness();
    expect(fixture.run(project => {
      const directory = join(project, "node_modules/.bin");
      mkdirSync(directory);
      writeFileSync(join(project, "node_modules/@kynesyslabs/dacs/cli.js"), "module.exports = 42;");
      symlinkSync("../@kynesyslabs/dacs/cli.js", join(directory, "dacs"));
    })).toMatchObject({ status: 0, report: { passed: true } });
  });
  it.each([false, true])("rejects a declared dependency alias file shadow, hoisted=%s", hoisted => {
    const fixture = dependencyPolicyHarness();
    fixture.packages["node_modules/plugin"] = { version: "1.0.0", resolved: `${CANDIDATE_REGISTRY}/plugin.tgz`,
      integrity: sri(Buffer.from("plugin")), dependencies: { "candidate-alias": `npm:@kynesyslabs/dacs@${CANDIDATE_VERSION}` } };
    const location = hoisted ? "node_modules/candidate-alias.js" : "node_modules/plugin/node_modules/candidate-alias.js";
    const result = fixture.run(project => {
      mkdirSync(dirname(join(project, location)), { recursive: true });
      writeFileSync(join(project, location), "module.exports = 42;");
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(location);
  });
});

it("reports the missing historical fixture location before editing", () => {
  expect(() => requiredFixtureEntry(undefined, "node_modules/semver"))
    .toThrow("missing fixture entry: node_modules/semver");
});


describe("run-local cleanup ownership", () => {
  it("reserves the output before another process can create an empty directory", () => {
    const { directory, output, result } = runEarlyFailure('if mkdir "$OUTPUT_DIR" 2>/dev/null; then touch "$RUNNER_TEMP/concurrent-created"; fi');
    expect(result.status).toBe(17); expect(existsSync(join(directory, "concurrent-created"))).toBe(false);
    expect(readFileSync(join(output, "acceptance.exit-code"), "utf8")).toBe("17\n");
  });
  it("removes the unique registry name even when Docker fails during start", async () => {
    const { result, commands } = await runToConsumerStage(false, true);
    expect(result.status, result.stderr).toBe(17); expect(readFileSync(commands, "utf8")).toMatch(/^rm --force dacs-registry-/m);
  }, 30000);
});
