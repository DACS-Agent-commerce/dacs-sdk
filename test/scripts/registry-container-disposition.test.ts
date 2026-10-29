import { canonicalize, sha256Hex } from "../../src/canonical/index.js";
import { projectTemplates } from "../../packages/create-dacs-agent/src/templates.js";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cacheArchive, npmCi, packTarball, serveArchives } from "./npm-archive-fixtures.js";
import { auditLock, auditReport } from "./npm-audit-fixtures.js";

// Keep the classifier executable as plain Node ESM.
const dispositionModulePath = "../../scripts/registry-container-disposition.mjs";
const { registryContainerDisposition, registryAuditDriftDisposition, classifyRegistryAudit, extractPolicyFindings, classifyPolicyChecks, classifyAcceptanceFailure, failureSummary, satisfiesEngineRange, scanLockEngines, registryDependencyViolations, runtimeImageInventoryFindings, RELEASE_VERSION } = await import(dispositionModulePath);
const inventoryModulePath = "../../scripts/runtime-image-inventory.mjs";
const { runtimeImageInventory } = await import(inventoryModulePath);
const archiveModulePath = "../../scripts/installation-closure.mjs";
const { npmToolchain, runNpmNode } = await import(archiveModulePath);
// Reference replay invokes the real npm toolchain for each policy scenario.
vi.setConfig({ testTimeout: 60_000 });
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
  stepName = "Run registry-shaped Linux and Docker acceptance", event = "pull_request", priorSummary?: unknown) {
  const directory = mkdtempSync(join(tmpdir(), "dacs-registry-step-"));
  scratch.push(directory);
  const checkout = join(directory, "checkout");
  // Keep static imports, transitive imports, workers and baseline data together.
  cpSync(join(repoRoot, "scripts"), join(checkout, "scripts"), { recursive: true });
  // The disposition reads the release version from the checkout's manifest.
  writeFileSync(join(checkout, "package.json"), readFileSync(join(repoRoot, "package.json")));
  if (priorSummary !== undefined) {
    mkdirSync(join(checkout, "registry-container-artifacts"));
    writeFileSync(join(checkout, "registry-container-artifacts/acceptance-summary.json"), JSON.stringify(priorSummary));
  }
  const write = summary === undefined ? "" : [
    "mkdir -p registry-container-artifacts",
    `cat > registry-container-artifacts/acceptance-summary.json <<'JSON'\n${typeof summary === "string" ? summary : JSON.stringify(summary)}\nJSON`,
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
  return { ...result, checkout, stepSummary: readFileSync(GITHUB_STEP_SUMMARY, "utf8") };
}
const runDriftStep = (summary?: unknown, strictAudit = false) =>
  runWorkflowStep(0, summary, strictAudit, "Check advisory-ID drift");

function dependencyPolicyFailureSummary() {
  const summary = baselineOnlySummary();
  summary.securityGate.findings.gitDependencies = [{ name: "unrecorded", location: "node_modules/unrecorded",
    version: "1.0.0", integrity: null, field: "dependencies.git", value: "github:owner/repo" }];
  return summary;
}

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

  // Each gate reads the extracted findings only; the composer's flags repeat them.
  const unrecordedPackage = { name: "unrecorded", location: "node_modules/unrecorded", version: "1.0.0", integrity: null };
  const sbomFailure = { exitCode: 1, code: "ESBOMPROBLEMS", problems: ["missing: unrecorded@1.0.0, required by consumer@1.0.0"] };
  it.each([
    ["a registry dependency policy violation", (s: ReturnType<typeof baselineOnlySummary>) => {
      s.securityGate.findings.gitDependencies = [{ ...unrecordedPackage, field: "dependencies.git", value: "github:owner/repo" }];
    }],
    ["a production image dependency violation", (s: ReturnType<typeof baselineOnlySummary>) => {
      s.securityGate.findings.productionImageDependencies = [unrecordedPackage];
    }],
    ["an engine-strict failure", (s: ReturnType<typeof baselineOnlySummary>) => {
      s.securityGate.findings.engine = { exitCode: 1, code: "EBADENGINE", scanComplete: true, reportedPackage: "unrecorded@1.0.0",
        violations: [{ package: "unrecorded@1.0.0", location: "node_modules/unrecorded", integrity: null, required: { node: ">=99" } }] };
    }],
    ["a lockfile SBOM failure", (s: ReturnType<typeof baselineOnlySummary>) => {
      s.securityGate.findings.lockSbom = sbomFailure;
    }],
    ["a physical SBOM failure", (s: ReturnType<typeof baselineOnlySummary>) => {
      s.securityGate.findings.physicalSbom = sbomFailure;
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
    // An unlisted ID dropped from the recorded list is an inconsistent summary.
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
    expect(result.stdout).toContain("::warning title=Registry/container policy warning::");
  });

  it("fails an early exit 4 that wrote no acceptance summary", () => {
    const result = runWorkflowStep(4);
    expect(result.status).toBe(4);
    expect(result.stdout).not.toContain("::warning title=Registry/container policy warning::");
    expect(result.stdout).toContain("::error title=Registry/container acceptance failed::");
  });

  it.each([
    ["an unexpected schema", { ...baselineOnlySummary(), schema: "other/v1" }],
    ["a functional failure", { ...baselineOnlySummary(), functionalPassed: false }],
    ["failed generated tests", { ...baselineOnlySummary(), generatedTestsPassed: false }],
    ["a dependency policy violation", dependencyPolicyFailureSummary()],
  ])("fails exit 4 when the summary records %s", (_label, summary) => {
    const result = runWorkflowStep(4, summary);
    expect(result.status).toBe(4);
    expect(result.stdout).not.toContain("::warning title=Registry/container policy warning::");
  });

  it.each([1, 2, 3])("still fails the job on acceptance exit %i", (code) => {
    expect(runWorkflowStep(code).status).toBe(code);
  });

  it("passes when acceptance passes", () => {
    const summary = baselineOnlySummary();
    summary.securityGate.passed = true;
    Object.assign(summary.audit, { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 });
    summary.audit.observedAdvisories = [];
    summary.securityGate.auditExitCode = 0;
    expect(runWorkflowStep(0, summary).status).toBe(0);
  });

  it("refuses existing evidence before producer launch and preserves its contents", () => {
    const summary = baselineOnlySummary();
    const result = runWorkflowStep(4, undefined, false, undefined, "pull_request", summary);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Existing evidence requires a fresh checkout");
    expect(JSON.parse(readFileSync(join(result.checkout, "registry-container-artifacts/acceptance-summary.json"), "utf8"))).toEqual(summary);
  });
  it.each([
    ["missing", undefined], ["malformed JSON", "{"], ["empty", ""],
    ["oversized", "x".repeat(16 * 1024 * 1024 + 1)],
    ["wrong version", { ...baselineOnlySummary(), packageVersion: "0.0.0" }],
    ["interrupted", { ...baselineOnlySummary(), complete: false }],
  ])("blocks successful producer status with %s evidence", (_name, summary) => {
    expect(runWorkflowStep(0, summary).status).not.toBe(0);
    expect(runWorkflowStep(4, summary).status).toBe(4);
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
    const changedInputs = [".github/workflows/registry-container-acceptance.yml",
      ".github/workflows/registry-container-audit-drift.yml", "package.json", "package-lock.json",
      "scripts/check-npm-advisories.mjs", "scripts/installation-closure.mjs", "scripts/installation-archive-worker.mjs",
      "scripts/reference-installation.mjs", "scripts/acceptance-directory.mjs", "scripts/acceptance-seal.mjs",
      "scripts/registry-container-registry.sh", "scripts/sync-vectors.mjs", "src/index.ts", "packages/dacs-node/src/index.ts",
      "packages/create-dacs-agent/src/index.ts", "test/scripts/registry-container-disposition.test.ts",
      "tsconfig.json", "tsconfig.build.json", "vitest.config.ts"];
    const matches = (path: string, pattern: string) => new RegExp("^" + pattern.split("*")
      .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$").test(path);
    for (const input of changedInputs) expect(paths.some(pattern => matches(input, pattern)), input).toBe(true);
    for (const input of ["README.md", "packageXjson", "tsconfig-buildXjson"]) {
      expect(paths.some(pattern => matches(input, pattern)), input).toBe(false);
    }
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
    expect(acceptance).toContain("bash scripts/acceptance-ci.sh acceptance");
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
        expect(result.stdout).not.toContain("::warning title=Registry/container policy warning::");
        expect(result.stdout).not.toContain("::warning title=Advisory IDs outside the #191 baseline::");
      }
    }
    expect(runDriftStep(summary, true).status).toBe(3);
    // Baseline-only findings stay waived (exit 4 re-checks as 4), as on every run.
    expect(runWorkflowStep(4, baselineOnlySummary(), true, undefined, "workflow_dispatch").status).toBe(0);
  });

});

// Runs the acceptance script up to its first npm command, with stubs that
// leave partial consumer phase output behind and then fail with status 17.
function runEarlyFailure(extraStubCommands = "") {
  const directory = mkdtempSync(join(tmpdir(), "dacs-registry-failure-"));
  scratch.push(directory);
  const npmBody = [
    'for directory in "$RUNNER_TEMP"/dacs-registry-acceptance.*; do',
    '  printf "partial doctor diagnostic\\n" > "$directory/exec-out/doctor.log"',
    '  printf "partial engine diagnostic\\n" > "$directory/measure-out/engine-strict.log"',
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
const packManifestTarball = (manifest: Record<string, string>) =>
  packTarball({ "package.json": JSON.stringify(manifest) });

// Runs the whole acceptance script through its consumer containers, where the
// generated project's doctor fails (exit 1, not the expected 5) unless the run
// is `complete`. Docker, npm and curl are stubs; node is this process's
// binary; the registry is a loopback server that serves exactly the published
// candidates.
async function runToConsumerStage(complete = false, failStart = false, hooks: ConsumerHooks = {}) {
  const directory = mkdtempSync(join(tmpdir(), "dacs-registry-doctor-")); scratch.push(directory); chmodSync(directory, 0o700);
  const version = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version as string;
  const releaseSet = join(directory, "release-set"); mkdirSync(releaseSet);
  const served: Record<string, { integrity: string; tarball: string; manifest: { name: string; version: string }; shasum: string }> = {};
  const archives: Record<string, Buffer> = {};
  const packages: Record<string, { integrity: string }> = {};
  for (const [name, file] of [["@kynesyslabs/dacs", "kynesyslabs-dacs"], ["@kynesyslabs/dacs-node", "kynesyslabs-dacs-node"], ["create-dacs-agent", "create-dacs-agent"]] as const) {
    const manifest = { name, version };
    const bytes = packManifestTarball(manifest); const tarball = "/" + file + ".tgz";
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
  // The dependency grammar and the audit policy's advisory ranges read these npm modules.
  for (const name of ["npm-package-arg", "semver"]) {
    symlinkSync(dirname(createRequire(npmEntry).resolve(`${name}/package.json`)), join(npmRoot, "npm/node_modules", name));
  }
  const server = createServer((request, response) => {
    const archive = archives[request.url ?? ""]; const record = served[request.url ?? ""];
    response.writeHead(archive || record ? 200 : 404, { "content-type": archive ? "application/octet-stream" : "application/json" });
    response.end(archive ?? JSON.stringify(record ? { name: record.manifest.name, "dist-tags": { acceptance: version }, versions: { [version]: { ...record.manifest,
      dist: { integrity: record.integrity, shasum: record.shasum, tarball: `http://${request.headers.host}${record.tarball}` } } } } : {}));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture server has no port");
  const port = address.port; const registry = `http://127.0.0.1:${port}`;
  // Each consumer phase copies its part of the fixture into the mounts it was given.
  const fixture = join(directory, "consumer-fixture"); const project = join(fixture, "install", "one-click-agent");
  for (const [name, contents] of Object.entries(projectTemplates({ packageName: "one-click-agent", deployment: "docker",
    mode: "live-demos", role: "seller", rails: "both" }))) {
    mkdirSync(dirname(join(project, name)), { recursive: true }); writeFileSync(join(project, name), contents);
  }
  const dependencies = Object.fromEntries(["@kynesyslabs/dacs", "@kynesyslabs/dacs-node", "@kynesyslabs/demosdk", "@x402/core", "@x402/evm", "@x402/fetch", "better-sqlite3", "viem"].map(name => [name, version]));
  const manifest = { name: "one-click-agent", version, dependencies };
  const lock: Record<string, unknown> = { "": manifest };
  const inventory: Array<{ location: string; name: string; version: string }> = [];
  // The audit policy resolves every direct dependency in the lock; non-candidates get placeholder bytes.
  for (const name of Object.keys(dependencies)) {
    const location = "node_modules/" + name; const integrity = packages[name]?.integrity ?? sri(Buffer.from(name));
    lock[location] = { version, resolved: `${registry}/${name}.tgz`, integrity };
    mkdirSync(join(project, location), { recursive: true }); writeFileSync(join(project, location, "package.json"), JSON.stringify({ name, version }));
    inventory.push({ location, name, version });
  }
  const lockText = JSON.stringify({ packages: lock });
  writeFileSync(join(project, "package.json"), JSON.stringify(manifest)); writeFileSync(join(project, "package-lock.json"), lockText);
  const doctor = JSON.parse(readFileSync(join(repoRoot, "test/scripts/fixtures/registry-container-doctor-without-credentials.json"), "utf8"));
  doctor.sdkVersion = version;
  delete doctor.reportHash;
  doctor.reportHash = sha256Hex(canonicalize(doctor));
  // The fake measure phase emits the checker's output; real-npm and bundle tests exercise the checker itself.
  const measured: Record<string, string> = { "dependency-policy.exit-code": "0\n",
    "dependency-policy.json": JSON.stringify({ schema: "dacs-registry-dependency-policy/v1", passed: true, violations: [] }),
    "npm-audit.exit-code": "0\n", "npm-audit.json": JSON.stringify({ metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } }, vulnerabilities: {} }),
    "engine-strict.exit-code": "0\n", "engine-strict.log": "", "engine-versions.json": JSON.stringify({ node: "20.19.1", npm: "11.19.0" }) };
  for (const kind of ["lock", "physical"]) { measured[`consumer-${kind}.cdx.json`] = "{}"; measured[`consumer-${kind}-sbom.err`] = ""; measured[`consumer-${kind}-sbom.exit-code`] = "0\n"; }
  const executed: Record<string, string> = { "generated-tests.exit-code": "0\n", "doctor.exit-code": "5\n", "doctor.log": "blocked without credentials\n",
    "doctor.json": JSON.stringify(doctor) };
  for (const [phase, files] of [["measure", measured], ["execute", executed]] as const) {
    mkdirSync(join(fixture, phase));
    for (const [name, value] of Object.entries(files)) writeFileSync(join(fixture, phase, name), value);
  }
  const pinned = join(directory, "npm-pinned"); const built = join(directory, "image-built"); const commands = join(directory, "docker-commands");
  const builtLock = join(directory, "built-lock"); const lateRemovals = join(directory, "late-removals");
  const phase = (name: keyof ConsumerHooks, steps: string[]) => [`  *-${name})`, ...steps, hooks[name] ?? "", `  exit ${name === "doctor" ? complete ? 5 : 1 : 0} ;;`];
  const PATH = stubBin(directory, {
    curl: ['case "$*" in', '  *--version*) echo "curl 8.5.0" ;;', '  */-/ping*) printf \'{}\' ;;', '  *org.couchdb.user*) printf \'{"token":"local-acceptance-token"}\' ;;', 'esac', 'exit 0'].join("\n"),
    npm: ['case "$1" in', `  install) case "$*" in *npm@11.19.0*) touch '${pinned}' ;; *) exit 92 ;; esac ;;`,
      `  --version) if [ -f '${pinned}' ]; then echo 11.19.0; else echo 10.9.9; fi ;;`, `  root) echo '${npmRoot}' ;;`, '  view) exit 97 ;;',
      `  run) if [ "$2" = release:set:verify ]; then mkdir -p "$5" && cp '${releaseSet}'/* "$5"/; fi ;;`, 'esac', 'exit 0'].join("\n"),
    docker: [`printf '%s\\n' "$*" | tr '\\n' ' ' >> '${commands}'`, `echo >> '${commands}'`, ...(failStart ? ['if [ "$1 $2" = "run --detach" ]; then exit 17; fi'] : []), `if [ "$1" = inspect ]; then echo ${port}; exit 0; fi`,
      // The build context's lock as the image would install it.
      `if [ "$1" = build ]; then touch '${built}'; for context; do :; done; cp "$context/package-lock.json" '${builtLock}'; exit 0; fi`,
      `if [ "$1 $2" = 'image inspect' ]; then [ -f '${built}' ] || exit 98; case "$*" in *--format*) echo 10001:10001 ;; *) printf '%s' '[{"Id":"fixture","Size":1,"Config":{"User":"10001:10001"}}]' ;; esac; exit 0; fi`,
      // A consumer container removed only after its output was collected or deleted is recorded.
      'if [ "$1 $2" = "rm --force" ]; then case "$3" in dacs-consumer-*) for root in "$RUNNER_TEMP"/dacs-registry-acceptance.*; do',
      `  if [ ! -d "$root/exec-out" ] || [ -e "$root/artifacts/doctor.log" ]; then echo "$3" >> '${lateRemovals}'; fi; done ;; esac; fi`,
      'if [ "$1" = compose ]; then echo "services: {}"; exit 0; fi', 'if [ "$1" != run ]; then exit 0; fi', 'name=; work=; out=; writable=; previous=',
      'for argument in "$@"; do', '  case "$previous" in', '    --name) name=$argument ;;',
      '    --volume) case "$argument" in *:ro) ;; *) writable="$writable ${argument%:*}" ;; esac',
      '      case "$argument" in *:/work|*:/work:ro) work=${argument%%:/work*} ;; *:/out) out=${argument%:/out} ;; esac ;;',
      '  esac', '  previous=$argument', 'done',
      'case "$name" in', ...phase("install", [`  cp -r '${fixture}/install/.' "$work/"`]),
      ...phase("measure", ['  case "$*" in *--dependency-policy*) ;; *) exit 99 ;; esac', `  cp '${fixture}/measure/'* "$out/"`]),
      ...phase("tests", [`  [ -f '${built}' ] || exit 98`, '  echo generated-image-tests']),
      ...phase("doctor", complete ? [`  [ -f '${built}' ] || exit 98`, `  cat '${fixture}/execute/doctor.json'`,
        `  cat '${fixture}/execute/doctor.log' >&2`] : ['  echo "doctor: release metadata is unreadable" >&2']),
      'esac', 'case "$*" in', `  *--entrypoint*) [ -f '${built}' ] || exit 98 ;;`, 'esac', 'case "$*" in', '  *"--entrypoint id"*) echo 10001 ;;',
      '  *"--entrypoint test"*) exit 1 ;;', `  *"--entrypoint node"*) printf '%s' '${JSON.stringify({ schema: "dacs-runtime-image-inventory/v1", packages: inventory })}' ;;`, 'esac', 'exit 0'].join("\n"),
  });
  const output = join(directory, "evidence");
  try {
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(done => {
      const child = spawn("bash", ["--norc", "--noprofile", "scripts/verify-registry-container-consumer.sh", "--output-dir", output], { cwd: repoRoot, env: { RUNNER_TEMP: directory, PATH } });
      let stdout = ""; let stderr = ""; child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
      child.on("close", status => done({ status, stdout, stderr }));
    });
    return { directory, output, result, commands, lockText, builtLock, lateRemovals };
  } finally { server.close(); }
}

// Shell run by the fake consumer phase of that name, after it copied its fixture
// and before it exits, with the phase's mounts in $work and $out and every
// writable host mount in $writable.
type ConsumerHooks = Partial<Record<"install" | "measure" | "tests" | "doctor", string>>;
// The volumes and environment of each named consumer phase run, as Docker received them.
function consumerRuns(commands: string) {
  return Object.fromEntries(readFileSync(commands, "utf8").split("\n").filter(line => line.startsWith("run ") && line.includes(" --name dacs-consumer-"))
    .map((line, order) => [/ --name dacs-consumer-\S+-(\w+) /.exec(line)![1]!, { line, order,
      volumes: [...line.matchAll(/--volume (\S+)/g)].map(match => match[1]!) }]));
}

const CANDIDATE_VERSION = "0.1.0-test";
// A summary the producer composed for CANDIDATE_VERSION, judged as that release.
const candidateDisposition = (summary: unknown, baseline?: unknown, options: Record<string, unknown> = {}) =>
  registryContainerDisposition(summary, baseline, { packageVersion: CANDIDATE_VERSION, ...options });
const CANDIDATE_REGISTRY = "http://host.docker.internal:4873";
const CANDIDATES = ["@kynesyslabs/dacs", "@kynesyslabs/dacs-node"];
const DUAL_RAIL_DEPENDENCIES = [...CANDIDATES, "@kynesyslabs/demosdk", "@x402/core", "@x402/evm", "@x402/fetch", "better-sqlite3", "viem"];
const sri = (bytes: Buffer) => "sha512-" + createHash("sha512").update(bytes).digest("base64");
const releaseFile = (name: string) => `${name.slice(1).replace("/", "-")}-${CANDIDATE_VERSION}.tgz`;
const packageJson = (name: string | undefined, version: string, fields: Record<string, unknown> = {}) =>
  JSON.stringify({ ...(name === undefined ? {} : { name }), version, ...fields });

// Runs the dependency-policy command against a generated consumer whose lock
// names the exact packed candidate tarballs, as release-provenance.json
// records them. Every locked archive is in the consumer's npm cache, and `run`
// installs each one's files where npm puts them, as npm ci --ignore-scripts does.
function dependencyPolicyHarness(candidateFields: Record<string, unknown> = {}, candidateFiles: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "dacs-registry-integrity-"));
  scratch.push(directory);
  const project = join(directory, "project");
  const cache = join(directory, "npm-cache");
  mkdirSync(project);
  const packages: Record<string, Record<string, unknown>> = {};
  const contents: Record<string, Record<string, string>> = {};
  const provenance = { version: CANDIDATE_VERSION, packages: {} as Record<string, { integrity: string }> };
  // Locks `files` at `location` as the archive npm fetched for it; `fields` are added to its lock entry.
  const lockPackage = (location: string, files: Record<string, string>, fields: Record<string, unknown> = {}) => {
    const archive = packTarball(files);
    cacheArchive(cache, archive);
    contents[location] = files;
    packages[location] = { version: JSON.parse(files["package.json"] ?? "{}").version ?? "1.0.0",
      resolved: `${CANDIDATE_REGISTRY}/${location.replace(/^.*node_modules\//, "")}.tgz`, integrity: sri(archive), ...fields };
    return archive;
  };
  // Locks and installs another copy of the archive at `from`.
  const copyPackage = (from: string, to: string, fields: Record<string, unknown> = {}) => {
    contents[to] = contents[from] ?? {};
    packages[to] = { ...packages[from], ...fields };
  };
  for (const name of DUAL_RAIL_DEPENDENCIES) {
    const archive = lockPackage(`node_modules/${name}`, { "package.json": packageJson(name, CANDIDATE_VERSION, CANDIDATES.includes(name) ? candidateFields : {}),
      "index.js": `module.exports = "${name}";\n`, ...(CANDIDATES.includes(name) ? candidateFiles : {}) });
    if (CANDIDATES.includes(name)) {
      writeFileSync(join(directory, releaseFile(name)), archive);
      provenance.packages[name] = { integrity: sri(archive) };
    }
  }
  const manifest: Record<string, unknown> = {
    dependencies: Object.fromEntries(DUAL_RAIL_DEPENDENCIES.map(name => [name, CANDIDATE_VERSION])) };
  const report = join(directory, "report.json");
  expect(readFileSync(join(repoRoot, "scripts/verify-registry-container-consumer.sh"), "utf8")).toContain(
    'node /acceptance-sdk/scripts/registry-container-disposition.mjs --dependency-policy "$PWD" "$npm_config_registry" \\\n' +
    '      /out/dependency-policy.json /release-set "$DACS_PACKAGE_VERSION"');
  // The files installed at a lock location instead of its archive's; `null` installs none.
  const installed: Record<string, Record<string, string> | null> = {};
  // `environment` adds to the command's environment; `script` and `projectPath` are the paths it is given.
  const run = (afterInstall: (project: string) => void = () => undefined, { environment = {}, script = "scripts/registry-container-disposition.mjs",
    projectPath = project }: { environment?: Record<string, string>; script?: string; projectPath?: string } = {}) => {
    // Supply a complete npm lock/manifest contract, including every fixture
    // package, before applying the test's interrupted or changed tree state.
    const dependencies = ["dependencies", "optionalDependencies", "devDependencies"];
    for (const location of Object.keys(packages)) {
      for (let end = location.lastIndexOf("/node_modules/"); end >= 0;) {
        const parent = location.slice(0, end);
        if (!packages[parent]) lockPackage(parent, { "package.json": packageJson(parent.slice("node_modules/".length), "1.0.0") });
        end = parent.lastIndexOf("/node_modules/");
      }
    }
    // Keep declared aliases in a complete graph, even when a test adds a
    // file shadow or carried copy rather than supplying the ordinary lock edge.
    for (const [owner, fields] of [["", manifest], ...Object.entries(packages)] as [string, Record<string, unknown>][]) {
      for (const field of [...dependencies, "peerDependencies"]) {
        for (const [name, spec] of Object.entries((fields[field] ?? {}) as Record<string, unknown>)) {
          const candidate = typeof spec === "string" && /^npm:(@kynesyslabs\/(?:dacs|dacs-node))@/.exec(spec)?.[1];
          const location = (owner ? owner + "/" : "") + "node_modules/" + name;
          if (candidate && !packages[location] && !packages["node_modules/" + name] && packages["node_modules/" + candidate]) {
            copyPackage("node_modules/" + candidate, location, { name: candidate });
          }
        }
      }
    }
    for (const [location, entry] of Object.entries(packages)) {
      const split = location.lastIndexOf("/node_modules/");
      const name = location.slice(split < 0 ? "node_modules/".length : split + "/node_modules/".length);
      const owner = split < 0 ? manifest : packages[location.slice(0, split)];
      if (split < 0 && DUAL_RAIL_DEPENDENCIES.includes(name)) continue;
      if (owner && !dependencies.some(field => Object.hasOwn(owner[field] ?? {}, name))) {
        const declared = owner.dependencies;
        owner.dependencies = { ...(typeof declared === "object" && declared !== null ? declared : {}), [name]: entry.version };
      }
    }
    const lock = { lockfileVersion: 3, packages: { "": manifest, ...packages } };
    writeFileSync(join(project, "package.json"), JSON.stringify(manifest));
    writeFileSync(join(project, "package-lock.json"), JSON.stringify(lock));
    writeFileSync(join(project, ".npmrc"), "legacy-peer-deps=true\n");
    writeFileSync(join(directory, "release-provenance.json"), JSON.stringify(provenance));
    rmSync(join(project, "node_modules"), { recursive: true, force: true });
    const modes = new Map<string, number>();
    let hiddenLock: Buffer | undefined;
    if (Object.values(packages).every(entry => typeof entry.resolved === "string" && /^https?:/.test(entry.resolved))) {
      try {
        const toolchain = npmToolchain();
        runNpmNode(toolchain, [toolchain.cli, "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", `--cache=${cache}`], { cwd: project });
        hiddenLock = readFileSync(join(project, "node_modules/.package-lock.json"));
        for (const [location, files] of Object.entries(contents)) {
          for (const path of Object.keys(files)) {
            const installedPath = join(project, location, path);
            if (existsSync(installedPath)) modes.set(installedPath, statSync(installedPath).mode & 0o777);
          }
        }
      } catch { /* Invalid contracts deliberately have no completed baseline. */ }
    }
    rmSync(join(project, "node_modules"), { recursive: true, force: true });
    for (const location of Object.keys(packages)) {
      for (const [path, body] of Object.entries((location in installed ? installed[location] : contents[location]) ?? {})) {
        const installedPath = join(project, location, path);
        mkdirSync(dirname(installedPath), { recursive: true });
        writeFileSync(installedPath, body);
        const mode = modes.get(installedPath);
        if (mode !== undefined) chmodSync(installedPath, mode);
      }
    }
    if (hiddenLock) writeFileSync(join(project, "node_modules/.package-lock.json"), hiddenLock);
    afterInstall(project);
    const result = spawnSync(process.execPath, [script, "--dependency-policy", projectPath, CANDIDATE_REGISTRY, report, directory, CANDIDATE_VERSION],
      { cwd: repoRoot, encoding: "utf8", env: { ...process.env, npm_config_cache: cache, ...environment } });
    return { ...result, report: result.status === 0 ? JSON.parse(readFileSync(report, "utf8")) : null };
  };
  return { directory, cache, packages, contents, manifest, provenance, installed, lockPackage, copyPackage, run, report };
}
const TREE = "installed tree is not the locked archives: ";

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
      typescriptPresent: false, rubicSdkPresent: false, productionDependencyPolicyPassed: true }),
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

describe("npm audit graph severity", () => {
  const severities = ["info", "low", "moderate", "high", "critical"];
  const id = "GHSA-23hp-3jrh-7fpw";
  const edge = (name: string, severity: string, url = `https://github.com/advisories/${id}`) =>
    ({ name, url, severity, range: "*" });
  type PackageFinding = { severity: string; isDirect: boolean; via: (string | ReturnType<typeof edge>)[] };
  // Each package marked isDirect is a root dependency in the audited lock.
  function auditFixture() {
    const directory = mkdtempSync(join(tmpdir(), "dacs-audit-severity-"));
    scratch.push(directory);
    const input = join(directory, "audit.json"), lock = join(directory, "lock.json"), output = join(directory, "policy.json");
    const run = (vulnerabilities: Record<string, PackageFinding>) => {
      writeFileSync(input, JSON.stringify(auditReport(vulnerabilities)));
      writeFileSync(lock, JSON.stringify(auditLock(vulnerabilities)));
      return spawnSync(process.execPath, [join(repoRoot, "scripts/registry-container-disposition.mjs"), "--audit-policy", input, lock, output],
        { cwd: repoRoot, encoding: "utf8" });
    };
    return { run, output };
  }

  it.each(severities.flatMap(severity => severities.filter(via => via !== severity)
    .flatMap(via => [true, false].map(isDirect => ({ severity, via, isDirect }))))) (
    "refuses a $severity package with only a $via advisory (direct: $isDirect)", ({ severity, via, isDirect }) => {
      const fixture = auditFixture();
      const result = fixture.run({ fixture: { severity, isDirect, via: [edge("fixture", via)] } });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("npm audit package severity disagrees with reachable advisories");
      expect(existsSync(fixture.output)).toBe(false);
    });

  it.each([
    { root: { severity: "high", isDirect: true, via: ["leaf"] },
      leaf: { severity: "low", isDirect: false, via: [edge("leaf", "low")] } },
    { root: { severity: "high", isDirect: true, via: ["leaf"] },
      leaf: { severity: "high", isDirect: false, via: ["root", edge("leaf", "low")] } },
  ])("refuses contradictory inherited severities %j", graph => {
    const fixture = auditFixture();
    const result = fixture.run(graph);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("npm audit package severity disagrees with reachable advisories");
    expect(existsSync(fixture.output)).toBe(false);
  });

  it.each(severities.flatMap((severity, index) => severities.slice(index + 1)
    .flatMap(via => [true, false].map(isDirect => ({ severity, via, isDirect }))))) (
    "accepts $severity inherited from aggregated $via evidence (direct: $isDirect)", ({ severity, via, isDirect }) => {
      const fixture = auditFixture();
      const result = fixture.run({ root: { severity, isDirect, via: ["leaf"] },
        leaf: { severity: via, isDirect: false, via: [edge("leaf", via)] } });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(fixture.output, "utf8"))).toMatchObject({
        observedAdvisories: [id], directAdvisories: [] });
    });

  it.each([
    { severity: "low", own: "moderate", inherited: "critical", accepted: false },
    { severity: "critical", own: "low", inherited: "high", accepted: false },
    { severity: "moderate", own: "low", inherited: "critical", accepted: true },
    { severity: "high", own: "high", inherited: "critical", accepted: true },
  ])("bounds mixed evidence by own and reachable advisories: %j", ({ severity, own, inherited, accepted }) => {
    const fixture = auditFixture();
    const result = fixture.run({ root: { severity, isDirect: true, via: [edge("root", own), "leaf"] },
      leaf: { severity: inherited, isDirect: false, via: [edge("leaf", inherited)] } });
    expect(result.status === 0, result.stderr).toBe(accepted);
    expect(existsSync(fixture.output)).toBe(accepted);
    if (accepted) expect(JSON.parse(readFileSync(fixture.output, "utf8")).directAdvisories)
      .toEqual(own === "high" ? [id] : []);
  });

  it.each([false, true])("admits a collapsed two-copy audit graph in either package order (reversed: %s)", reversed => {
    const fixture = auditFixture();
    // npm groups leaf@1 (moderate) and leaf@2 (high) into one name-level record.
    const graph = { parent: { severity: "moderate", isDirect: true, via: ["leaf"] },
      other: { severity: "high", isDirect: true, via: ["leaf"] },
      leaf: { severity: "high", isDirect: false, via: [edge("leaf", "moderate"),
        edge("leaf", "high", "https://github.com/advisories/GHSA-2pr8-phx7-x9h3")] } };
    const result = fixture.run(reversed ? Object.fromEntries(Object.entries(graph).reverse()) : graph);
    expect(result.status, result.stderr).toBe(0);
    const policy = JSON.parse(readFileSync(fixture.output, "utf8"));
    expect(policy).toMatchObject({ directAdvisories: [], unlistedAdvisories: [],
      observedAdvisories: [id, "GHSA-2pr8-phx7-x9h3"], observed: { moderate: 1, high: 2, total: 3 } });
    const summary = baselineOnlySummary();
    Object.assign(summary.audit, policy.observed, { observedAdvisories: policy.observedAdvisories,
      unlistedAdvisories: policy.unlistedAdvisories, directAdvisories: policy.directAdvisories });
    expect(registryContainerDisposition(summary)).toMatchObject({ exitCode: 4, checks: { audit: "baseline" } });
  });

  it.each([["low", "critical"], ["critical", "low"]])("uses the maximum own severity in order %j, %j", (first, second) => {
    const fixture = auditFixture();
    expect(fixture.run({ fixture: { severity: "critical", isDirect: true, via: [edge("fixture", first), edge("fixture", second)] } }).status).toBe(0);
    expect(JSON.parse(readFileSync(fixture.output, "utf8")).directAdvisories).toEqual([id]);
  });

  it("propagates a higher severity through an already reached inherited cycle", () => {
    const fixture = auditFixture();
    expect(fixture.run({
      low: { severity: "low", isDirect: false, via: [edge("low", "low")] },
      root: { severity: "critical", isDirect: true, via: ["low", "middle"] },
      middle: { severity: "critical", isDirect: false, via: ["root", "critical"] },
      critical: { severity: "critical", isDirect: false, via: [edge("critical", "critical")] },
    }).status).toBe(0);
    expect(JSON.parse(readFileSync(fixture.output, "utf8")).directAdvisories).toEqual([]);
  });

  it("refuses direct evidence whose own advisory is below its package severity", () => {
    const fixture = auditFixture();
    expect(fixture.run({ fixture: { severity: "high", isDirect: true, via: [edge("fixture", "high")] } }).status).toBe(0);
    expect(JSON.parse(readFileSync(fixture.output, "utf8")).directAdvisories).toEqual([id]);
    const result = fixture.run({ fixture: { severity: "high", isDirect: true, via: [edge("fixture", "low")] } });
    expect(result.status).not.toBe(0);
    expect(existsSync(fixture.output)).toBe(false);
  });

  it("blocks a recorded direct high advisory, and classifies the stopped audit stage as policy", () => {
    const fixture = auditFixture();
    expect(fixture.run({ fixture: { severity: "high", isDirect: true, via: [edge("fixture", "high")] } }).status).toBe(0);
    const policy = JSON.parse(readFileSync(fixture.output, "utf8"));
    const summary = baselineOnlySummary();
    Object.assign(summary.audit, policy.observed, { observedAdvisories: policy.observedAdvisories,
      unlistedAdvisories: policy.unlistedAdvisories, directAdvisories: policy.directAdvisories });
    expect(registryContainerDisposition(summary)).toMatchObject({ exitCode: 3, checks: { audit: "blocked" } });
    expect(registryContainerDisposition({ ...summary, complete: false, failedStage: "audit-policy", failureClass: "policy" }))
      .toMatchObject({ exitCode: 1, failureClass: "policy" });
  });
});

describe("complete installed package scopes", { timeout: 60_000 }, () => {
  it.each([
    ["identity", "cannot authenticate a candidate copy carried in the archive of node_modules/plugin: node_modules/plugin/arbitrary/deep"],
    ["alias-name", "the project declares @kynesyslabs/dacs under another name: alias"],
    ["alias-declaration", "node_modules/plugin/arbitrary/deep declares @kynesyslabs/dacs under another name: alias"],
  ])("refuses a nested package scope's %s", (form, refusal) => {
    const fixture = dependencyPolicyHarness();
    fixture.manifest.optionalDependencies = { alias: `npm:@kynesyslabs/dacs@${CANDIDATE_VERSION}` };
    fixture.lockPackage("node_modules/plugin", { "package.json": packageJson("plugin", "1.0.0"),
      "arbitrary/deep/package.json": packageJson(form === "identity" ? "@kynesyslabs/dacs" : form === "alias-name" ? "alias" : "inner", "1.0.0",
        { exports: "./copy.cjs", ...(form === "alias-declaration" ? { dependencies: { alias: `npm:@kynesyslabs/dacs@${CANDIDATE_VERSION}` } } : {}) }),
      "arbitrary/deep/copy.cjs": "module.exports = 'unreleased-copy';" });
    const result = fixture.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(refusal);
  });

  it("accepts a package scope whose nested objects and string values reuse the key name", () => {
    const fixture = dependencyPolicyHarness();
    fixture.lockPackage("node_modules/plugin", { "package.json": packageJson("plugin", "1.0.0"),
      "dist/package.json": '{"name":"inner","exports":{"name":{"name":"./a.js"},"./b":[{"name":"x"}]},"description":"name:\\"name\\":"}',
      "dist/a.js": "export default 1;" });
    expect(fixture.run()).toMatchObject({ status: 0, report: { passed: true } });
  });

  it("refuses a package scope that repeats a top-level key", () => {
    const fixture = dependencyPolicyHarness();
    fixture.lockPackage("node_modules/plugin", { "package.json": packageJson("plugin", "1.0.0"),
      "dist/package.json": '{"name":"inner","exports":"./a.js","exports":"./b.js"}', "dist/a.js": "", "dist/b.js": "" });
    const result = fixture.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("node_modules/plugin/dist");
  });

  it("accepts an ordinary nested package scope without candidate identities or declarations", () => {
    const fixture = dependencyPolicyHarness();
    fixture.lockPackage("node_modules/plugin", { "package.json": packageJson("plugin", "1.0.0"),
      "dist/package.json": packageJson("inner", "1.0.0", { type: "module", exports: "./index.js" }), "dist/index.js": "export default 1;" });
    expect(fixture.run()).toMatchObject({ status: 0, report: { passed: true } });
  });
});

describe("the project's own package scope", { timeout: 60_000 }, () => {
  const shadow = (project: string) => writeFileSync(join(project, "shadow.cjs"), "module.exports = 'unreleased-copy';\n");

  it.each(CANDIDATES)("refuses a project named for candidate %s, which Node resolves to the project itself", name => {
    const fixture = dependencyPolicyHarness();
    Object.assign(fixture.manifest, { name, exports: "./shadow.cjs" });
    const result = fixture.run(project => {
      shadow(project);
      expect(spawnSync(process.execPath, ["-p", `require(${JSON.stringify(name)})`], { cwd: project, encoding: "utf8" }).stdout)
        .toBe("unreleased-copy\n");
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("the project is named for candidate package " + name);
    expect(existsSync(fixture.report)).toBe(false);
  });

  it.each([
    ["the candidates' scope", "@kynesyslabs", { "./dacs": "./shadow.cjs" }, "@kynesyslabs/dacs", "@kynesyslabs/dacs"],
    ["a subpath of dacs-node", "@kynesyslabs/dacs-node/transport", "./shadow.cjs", "@kynesyslabs/dacs-node/transport", "@kynesyslabs/dacs-node"],
    ["a subpath of dacs", "@kynesyslabs/dacs/extra", "./shadow.cjs", "@kynesyslabs/dacs/extra", "@kynesyslabs/dacs"],
  ])("refuses a project named for %s, which Node resolves to the project itself", (_form, name, exports, request, candidate) => {
    const fixture = dependencyPolicyHarness();
    Object.assign(fixture.manifest, { name, exports });
    const result = fixture.run(project => {
      shadow(project);
      expect(spawnSync(process.execPath, ["-p", `require(${JSON.stringify(request)})`], { cwd: project, encoding: "utf8" }).stdout)
        .toBe("unreleased-copy\n");
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("the project is named for candidate package " + candidate);
    expect(existsSync(fixture.report)).toBe(false);
  });

  it.each([["plain", '"name"'], ["escaped", '"\\u006eame"']])("refuses a project package.json that repeats a top-level key (%s spelling)", (_form, key) => {
    const fixture = dependencyPolicyHarness();
    Object.assign(fixture.manifest, { name: "ordinary-root", exports: "./shadow.cjs" });
    const result = fixture.run(project => {
      shadow(project);
      writeFileSync(join(project, "package.json"), `{"name":"@kynesyslabs/dacs",${key}:"ordinary-root",` +
        JSON.stringify({ ...fixture.manifest, name: undefined }).slice(1));
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("cannot read the project package.json: it repeats a top-level key");
    expect(existsSync(fixture.report)).toBe(false);
  });

  it("accepts a project with an ordinary name that exports its own files", () => {
    const fixture = dependencyPolicyHarness();
    Object.assign(fixture.manifest, { name: "ordinary-root", exports: "./shadow.cjs" });
    expect(fixture.run(shadow)).toMatchObject({ status: 0, report: { passed: true } });
  });
});

describe("registry/container evidence", () => {
  it("accepts a consumer installed exactly from its locked archives", () => {
    expect(dependencyPolicyHarness().run()).toMatchObject({ status: 0, report: { passed: true, violations: [] } });
  });

  it.each(["dacs", "dacs-node"])("rejects an untracked installed nested or aliased %s", name => {
    const fixture = dependencyPolicyHarness();
    const result = fixture.run(project => {
      for (const location of [`node_modules/plugin/node_modules/@kynesyslabs/${name}`, "node_modules/untracked-alias"]) {
        mkdirSync(join(project, location), { recursive: true });
        writeFileSync(join(project, location, "package.json"), packageJson(`@kynesyslabs/${name}`, "0.0.0-wrong"));
      }
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(TREE + "unexpected directory: node_modules/plugin");
    expect(result.stderr).toContain(TREE + "unexpected directory: node_modules/untracked-alias");
  });

  it.each(["dacs", "dacs-node"])("requires the top-level %s even with valid nested and aliased copies", name => {
    const { packages, contents, copyPackage, run } = dependencyPolicyHarness();
    const top = `node_modules/@kynesyslabs/${name}`;
    copyPackage(top, `node_modules/plugin/node_modules/@kynesyslabs/${name}`);
    copyPackage(top, "node_modules/alias", { name: `@kynesyslabs/${name}` });
    delete packages[top];
    delete contents[top];
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

  it("runs the policy, and invalidates a previous success report, when started through a linked script path", () => {
    const fixture = dependencyPolicyHarness();
    expect(fixture.run().status).toBe(0);
    const linked = join(fixture.directory, "linked-scripts");
    symlinkSync(join(repoRoot, "scripts"), linked);
    fixture.packages["node_modules/@kynesyslabs/dacs"] = { ...fixture.packages["node_modules/@kynesyslabs/dacs"], integrity: "sha512-wrong" };
    const result = fixture.run(undefined, { script: join(linked, "registry-container-disposition.mjs") });
    expect(result.status).not.toBe(0);
    expect(existsSync(fixture.report)).toBe(false);
  });

  it.each(["dacs", "dacs-node"])("rejects an installed %s whose runtime file differs from the packed tarball", name => {
    const root = `node_modules/@kynesyslabs/${name}`;
    const result = dependencyPolicyHarness().run(project => writeFileSync(join(project, root, "index.js"), "module.exports = 'replaced';\n"));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`${TREE}changed: ${root}/index.js`);
  });

  it.each([
    ["an added file", (root: string) => writeFileSync(join(root, "postinstall.js"), "x"), "unexpected file: node_modules/@kynesyslabs/dacs/postinstall.js"],
    ["a missing file", (root: string) => rmSync(join(root, "index.js")), "missing: node_modules/@kynesyslabs/dacs/index.js"],
    ["a file that is a link", (root: string) => { rmSync(join(root, "index.js")); symlinkSync("../dacs-node/index.js", join(root, "index.js")); },
      "expected file, found link: node_modules/@kynesyslabs/dacs/index.js"],
    ["a file that is a hard link", (root: string) => linkSync(join(root, "index.js"), join(root, "alias.js")),
      "hard link: node_modules/@kynesyslabs/dacs/index.js"],
    ["a directory the tarball does not hold", (root: string) => mkdirSync(join(root, "dist")), "unexpected directory: node_modules/@kynesyslabs/dacs/dist"],
  ])("rejects an installed candidate with %s", (_form, change, difference) => {
    const result = dependencyPolicyHarness().run(project => change(join(project, "node_modules/@kynesyslabs/dacs")));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(TREE + difference);
  });

  it.each([
    ["preinstall", { scripts: { preinstall: "node setup.js" } }, {}],
    ["install", { scripts: { install: "node setup.js" } }, {}],
    ["postinstall", { scripts: { postinstall: "node setup.js" } }, {}],
    ["binding.gyp", {}, { "binding.gyp": "{}" }],
  ])("rejects a candidate whose tarball declares %s", (declared, fields, files) => {
    const result = dependencyPolicyHarness(fields, files).run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`candidate package runs code when installed (${declared}): @kynesyslabs/dacs`);
  });

  it("accepts the dependencies npm installs inside a candidate directory", () => {
    const fixture = dependencyPolicyHarness();
    fixture.lockPackage("node_modules/@kynesyslabs/dacs/node_modules/dependency", { "package.json": packageJson("dependency", "1.0.0"), "index.js": "" });
    expect(fixture.run()).toMatchObject({ status: 0, report: { passed: true } });
  });

  it("rejects a packed tarball that is not an npm package archive", () => {
    const { directory, run, provenance } = dependencyPolicyHarness();
    const bytes = packTarball({ "index.js": "" });
    provenance.packages["@kynesyslabs/dacs"] = { integrity: sri(bytes) };
    const result = run(() => writeFileSync(join(directory, releaseFile("@kynesyslabs/dacs")), bytes));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("packed tarball has no package.json");
  });

  it("rejects release provenance for another version", () => {
    const { provenance, run } = dependencyPolicyHarness();
    provenance.version = "0.0.0-other";
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`release-provenance.json is not for version ${CANDIDATE_VERSION}`);
  });

  it("rejects a consumer missing a dual-rail dependency", () => {
    const { manifest, run } = dependencyPolicyHarness();
    manifest.dependencies = Object.fromEntries(DUAL_RAIL_DEPENDENCIES.filter(name => name !== "viem").map(name => [name, CANDIDATE_VERSION]));
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("dual-rail consumer is missing viem");
  });

  it("rejects an installation whose locked archives npm's cache does not hold", () => {
    const fixture = dependencyPolicyHarness();
    rmSync(fixture.cache, { recursive: true });
    const result = fixture.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/node_modules\/@kynesyslabs\/dacs: cannot read npm's cached archive .*\(ENOENT\)/);
  });

  it("rejects an unknown policy mode", () => {
    expect(spawnSync(process.execPath, ["scripts/registry-container-disposition.mjs", "--dependency-polciy"],
      { cwd: repoRoot }).status).not.toBe(0);
  });


  it("traverses consumer policy, image build, evidence assembly and disposition with pinned npm", async () => {
    const { directory, output, result, commands } = await runToConsumerStage(true);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(existsSync(join(directory, "npm-pinned"))).toBe(true);
    const invoked = readFileSync(commands, "utf8");
    expect(invoked).toMatch(/^build .*--tag /m);
    expect(invoked).toContain("--file "); expect(invoked).toContain("Dockerfile.acceptance");
    expect(invoked).toContain("--env DACS_BOUNDED_NPM_HTTP=1");
    expect(invoked).toContain("--env NODE_OPTIONS=--require=/acceptance-support/bounded-npm-http.cjs");
    expect(invoked).toContain("--env npm_config_fetch_retries=2");
    expect(invoked).toContain("/acceptance-sdk/package.json:ro");
    expect(invoked).toContain("/acceptance-sdk/scripts:ro");
    expect(invoked).toContain("--dependency-policy");
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
    // Partial output of both consumer phases is collected without a complete set.
    expect(readFileSync(join(output, "doctor.log"), "utf8")).toBe("partial doctor diagnostic\n");
    expect(readFileSync(join(output, "engine-strict.log"), "utf8")).toBe("partial engine diagnostic\n");
    // The runner's tool versions are evidence too; the stubs print nothing.
    expect(readFileSync(join(output, "runner-tools.txt"), "utf8")).toMatch(/^bash \d+\.\d+/);
  });

  it("keeps the consumer's diagnostics when the generated doctor fails before any of them is exported", async () => {
    const { output, result, directory, lockText } = await runToConsumerStage();
    expect(result.status, result.stderr).toBe(1);
    const evidence = (name: string) => readFileSync(join(output, name), "utf8");
    expect(evidence("doctor.log")).toBe("doctor: release metadata is unreadable\n");
    expect(evidence("doctor.exit-code")).toBe("1\n");
    expect(evidence("generated-tests.exit-code")).toBe("0\n");
    expect(JSON.parse(evidence("generated-package.json"))).toMatchObject({ name: "one-click-agent" });
    expect(evidence("generated-package-lock.json")).toBe(lockText);
    expect(evidence("dependency-policy.json")).toContain('"passed":true');
    expect(evidence("generation.log")).toContain("generated-image-tests");
    for (const name of ["release-provenance.json", "SHA256SUMS", "registry.log", "runner-tools.txt"]) {
      expect(existsSync(join(output, name)), name).toBe(true);
    }
    expect(JSON.parse(evidence("acceptance-summary.json"))).toMatchObject({ complete: false, failedStage: "image-checks",
      exitCode: 1, failureClass: "functional" });
    expect(result.stdout).toContain("::error title=Registry/container acceptance functional failure::stopped at stage image-checks");
    // The temporary acceptance root, which held them, is gone.
    expect(readdirSync(directory).filter((name) => name.startsWith("dacs-registry-acceptance."))).toEqual([]);
  });

  it("gives each consumer phase a closed set of mounts, in install, measure, tests, doctor order", async () => {
    const { result, commands } = await runToConsumerStage(true);
    expect(result.status, result.stderr).toBe(0);
    const runs = consumerRuns(commands);
    const local = (volume: string) => volume.replace(/^\S*\/dacs-registry-acceptance\.[^/]+/, "<root>").replace(repoRoot, "<repo>");
    const support = "<repo>/scripts:/acceptance-support:ro";
    expect(runs.install?.volumes.map(local)).toEqual(["<root>/gen:/work", support]);
    expect(runs.measure?.volumes.map(local)).toEqual(["<root>/gen:/work:ro", "<root>/measure-out:/out", support,
      "<repo>/scripts:/acceptance-sdk/scripts:ro", "<repo>/package.json:/acceptance-sdk/package.json:ro", "<root>/release-set:/release-set:ro"]);
    expect(runs.tests?.volumes).toEqual([]); expect(runs.doctor?.volumes).toEqual([]);
    // Neither the evidence stage nor the sealed build context is ever mounted.
    for (const line of readFileSync(commands, "utf8").split("\n").filter(line => line.startsWith("run "))) {
      expect(line).not.toMatch(/--volume \S*\/(?:artifacts|sealed)[/:]/);
    }
    expect([runs.install?.order, runs.measure?.order, runs.tests?.order, runs.doctor?.order]).toEqual([0, 1, 2, 3]);
  }, 30_000);

  it("measures before any package code runs and keeps scripts off during install", async () => {
    const { result, commands } = await runToConsumerStage(true);
    expect(result.status, result.stderr).toBe(0);
    const { install, measure, tests, doctor } = consumerRuns(commands);
    for (const step of ["--dependency-policy", "npm audit ", "npm sbom --sbom-format", "npm sbom --package-lock-only", "--engine-strict"]) {
      expect(measure?.line, step).toContain(step); expect(doctor?.line, step).not.toContain(step);
    }
    expect(readFileSync(join(repoRoot, "packages/create-dacs-agent/src/liveTemplates.ts"), "utf8")).toContain("RUN npm rebuild better-sqlite3");
    expect(measure?.line).not.toContain("npm rebuild"); expect(tests?.line).toContain("--read-only");
    expect(install?.line).toContain("--env npm_config_ignore_scripts=true"); expect(doctor?.line).not.toContain("npm ");
    expect(install?.line).toContain("npm install --global --ignore-scripts npm@11.19.0");
    expect(install?.line).toContain("npm install --ignore-scripts ");
    expect(measure?.line).toMatch(new RegExp(` --user ${process.getuid?.()}:${process.getgid?.()} `));
    for (const run of [install, measure]) {
      for (const setting of ["--init", "--env npm_config_cache=/work/.npm-cache", "--env DACS_BOUNDED_NPM_HTTP=1",
        "--env NODE_OPTIONS=--require=/acceptance-support/bounded-npm-http.cjs", "--env npm_config_fetch_retries=2"]) {
        expect(run?.line, setting).toContain(setting);
      }
    }
  }, 30_000);

  it("reports the measured policy when package code rewrites it in every mount it can write", async () => {
    const report = (violations: unknown[]) => JSON.stringify({ schema: "dacs-registry-dependency-policy/v1", passed: violations.length === 0, violations });
    const { output, result } = await runToConsumerStage(true, false, {
      measure: `  printf '%s' '${report([{ location: "node_modules/viem", field: "resolved", value: "https://codeload.github.com/fixture/viem/tar.gz/main" }])}' > "$out/dependency-policy.json"`,
      doctor: `  for mount in $writable; do printf '%s' '${report([])}' > "$mount/dependency-policy.json"; done`,
    });
    expect(JSON.parse(readFileSync(join(output, "acceptance-summary.json"), "utf8")), result.stderr).toMatchObject({
      complete: true, registryDependencyOnly: false, securityGate: { passed: false, registryDependencyPolicyPassed: false } });
    expect(result.status).not.toBe(0);
  }, 30_000);

  it("builds and records the lock as measured when package code rewrites it afterwards", async () => {
    const { output, result, commands, lockText, builtLock } = await runToConsumerStage(true, false, {
      doctor: `  [ -z "$work" ] || printf '%s' '{"packages":{"node_modules/viem":{"resolved":"https://codeload.github.com/fixture/viem/tar.gz/main"}}}' > "$work/one-click-agent/package-lock.json"`,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(builtLock, "utf8")).toBe(lockText);
    expect(readFileSync(join(output, "generated-package-lock.json"), "utf8")).toBe(lockText);
    expect(JSON.parse(readFileSync(join(output, "sealed-context.json"), "utf8")).files["package-lock.json"])
      .toBe(createHash("sha256").update(lockText).digest("hex"));
    const build = readFileSync(commands, "utf8").split("\n").find(line => line.startsWith("build "));
    expect(build).toMatch(/--file \S+\/sealed\/context\/Dockerfile\.acceptance .* \S+\/sealed\/context\s*$/);
  }, 30_000);

  it.each([
    ["install", "evidence-seal", ['  rm "$work/one-click-agent/.dockerignore"', '  ln -s HOST/secret "$work/one-click-agent/.dockerignore"']],
  ])("refuses links planted in the %s phase without changing or exporting a host file", async (phase, failedStage, plant) => {
    const host = mkdtempSync(join(tmpdir(), "dacs-registry-host-")); scratch.push(host);
    writeFileSync(join(host, "secret"), "host-only value\n"); writeFileSync(join(host, "target.json"), "{}\n");
    const { output, result, commands } = await runToConsumerStage(true, false, { [phase]: plant.join("\n").replaceAll("HOST", `'${host}'`) });
    expect(result.status).not.toBe(0);
    expect(JSON.parse(readFileSync(join(output, "acceptance-summary.json"), "utf8"))).toMatchObject({ complete: false, failedStage, failureClass: "functional" });
    expect(readFileSync(join(host, "secret"), "utf8")).toBe("host-only value\n"); expect(readFileSync(join(host, "target.json"), "utf8")).toBe("{}\n");
    expect(spawnSync("grep", ["-r", "host-only value", output]).status).toBe(1);
    expect(readFileSync(commands, "utf8")).not.toMatch(/^build /m);
  }, 30_000);

  it("removes a consumer container its deadline stopped before collecting or deleting its mounts", async () => {
    const { output, result, commands, lateRemovals } = await runToConsumerStage(true, false, {
      doctor: '  printf "partial\\n" >&2\n  exit 124' });
    expect(result.status).toBe(124);
    expect(readFileSync(commands, "utf8")).toMatch(/^rm --force dacs-consumer-\S+-doctor\s*$/m);
    expect(existsSync(lateRemovals)).toBe(false);
    expect(readFileSync(join(output, "doctor.log"), "utf8")).toContain("partial\n");
  }, 30_000);

  it("finishes cleanup and keeps the original status when an evidence write fails", () => {
    // A directory where the exit-code file belongs makes that write fail.
    const { directory, output, result } = runEarlyFailure(
      '  mkdir -p "$directory/artifacts/acceptance.exit-code"',
    );
    expect(result.status).toBe(17);
    expect(readFileSync(join(output, "doctor.log"), "utf8")).toBe("partial doctor diagnostic\n");
    const retained = readdirSync(directory).filter(name => name.startsWith("dacs-registry-acceptance."));
    expect(retained).toHaveLength(1);
    expect(readFileSync(join(directory, retained[0] ?? "missing", "exec-out/doctor.log"), "utf8")).toBe("partial doctor diagnostic\n");
    expect(result.stderr).toContain("retained at ");
  });

  it.each(["dacs", "dacs-node"])("rejects a %s lock entry with different tarball bytes and reports both digests", name => {
    const { packages, run } = dependencyPolicyHarness();
    const location = `node_modules/@kynesyslabs/${name}`;
    const expected = packages[location]?.integrity;
    packages[location] = { ...packages[location], integrity: "sha512-wrong" };
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`candidate package integrity does not match the packed tarball: ${location} ` +
      `(expected ${String(expected)}, observed sha512-wrong)`);
  });

  it("rejects a candidate lock entry naming another package", () => {
    const { packages, run } = dependencyPolicyHarness();
    packages["node_modules/@kynesyslabs/dacs"] = { ...packages["node_modules/@kynesyslabs/dacs"], name: "@kynesyslabs/other" };
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("candidate package lock name does not match the release: node_modules/@kynesyslabs/dacs");
  });

  it.each(["dacs", "dacs-node"])("rejects a nested @kynesyslabs/%s copy that is not the candidate", name => {
    const fixture = dependencyPolicyHarness();
    const nested = `node_modules/some-plugin/node_modules/@kynesyslabs/${name}`;
    fixture.copyPackage(`node_modules/@kynesyslabs/${name}`, nested);
    expect(fixture.run().status).toBe(0);
    fixture.lockPackage(nested, { "package.json": packageJson(`@kynesyslabs/${name}`, CANDIDATE_VERSION), "index.js": "old" });
    const substituted = fixture.run();
    expect(substituted.status).not.toBe(0);
    expect(substituted.stderr).toContain(`integrity does not match the packed tarball: ${nested}`);
    fixture.copyPackage(`node_modules/@kynesyslabs/${name}`, nested, { resolved: `https://registry.npmjs.org/${name}.tgz` });
    const outside = fixture.run();
    expect(outside.status).not.toBe(0);
    expect(outside.stderr).toContain(`did not resolve through the isolated registry: ${nested}`);
  });

  it.each(["dacs", "dacs-node"])("rejects an npm alias of %s, substituted or the release", name => {
    const fixture = dependencyPolicyHarness();
    const anotherName = `candidate package @kynesyslabs/${name} is installed under another name: node_modules/alias`;
    fixture.copyPackage(`node_modules/@kynesyslabs/${name}`, "node_modules/alias", { name: `@kynesyslabs/${name}` });
    const release = fixture.run();
    expect(release.status).not.toBe(0);
    expect(release.stderr).toContain(anotherName);
    fixture.lockPackage("node_modules/alias", { "package.json": packageJson("other", CANDIDATE_VERSION) }, { name: `@kynesyslabs/${name}` });
    const result = fixture.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(anotherName);
  });

  it.each(["dacs", "dacs-node"])("rejects an installed package whose package.json alone names @kynesyslabs/%s", name => {
    const fixture = dependencyPolicyHarness();
    fixture.lockPackage("node_modules/undocumented-copy", { "package.json": packageJson(`@kynesyslabs/${name}`, CANDIDATE_VERSION),
      "index.js": "module.exports = 'old-copy';\n" });
    const result = fixture.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`candidate package @kynesyslabs/${name} is installed under another name: node_modules/undocumented-copy`);
  });

  it.each(["dacs", "dacs-node"])("compares the installed @kynesyslabs/%s with release-provenance.json", name => {
    const { packages, provenance, run } = dependencyPolicyHarness();
    expect(run()).toMatchObject({ status: 0, report: { passed: true, violations: [] } });
    const packed = provenance.packages[`@kynesyslabs/${name}`]?.integrity;
    provenance.packages[`@kynesyslabs/${name}`] = { integrity: sri(Buffer.from("another build")) };
    const recorded = run();
    expect(recorded.status).not.toBe(0);
    expect(recorded.stderr).toContain(`release-provenance.json records ${sri(Buffer.from("another build"))} ` +
      `for @kynesyslabs/${name}, but the packed tarball is ${String(packed)}`);
    // A lock that matches the provenance record but not the packed bytes fails too.
    packages[`node_modules/@kynesyslabs/${name}`] = { ...packages[`node_modules/@kynesyslabs/${name}`], integrity: sri(Buffer.from("another build")) };
    expect(run().status).not.toBe(0);
  });

  // Every installed candidate copy is the release's version in the lock, and
  // its installed package.json is the archive's, top-level or nested. Each
  // case runs the policy once, so it stays well inside the test deadline.
  const releaseCopy = (name: string, nested: boolean) => {
    const fixture = dependencyPolicyHarness();
    const nestedLocation = `node_modules/some-plugin/node_modules/${name}`;
    fixture.copyPackage(`node_modules/${name}`, nestedLocation);
    return { fixture, location: nested ? nestedLocation : `node_modules/${name}` };
  };
  const releaseCopies = CANDIDATES.flatMap(name => [false, true].map(nested => [name, nested] as const));

  it.each(releaseCopies.flatMap(([name, nested]) => [undefined, "0.0.0-wrong", "0.1.0-alpha.0"]
    .map(version => [name, nested, version] as const)))("rejects a %s copy, nested=%s, whose lock version is %s", (name, nested, version) => {
    const { fixture, location } = releaseCopy(name, nested);
    fixture.packages[location] = { ...fixture.packages[location], version };
    const result = fixture.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`lock version does not match the release: ${location} ` +
      `(expected ${CANDIDATE_VERSION}, observed ${String(version)})`);
  });

  it.each(releaseCopies.flatMap(([name, nested]) => ([[name, "0.0.0-wrong"], ["@kynesyslabs/other", CANDIDATE_VERSION]] as const)
    .map(([installedName, installedVersion]) => [name, nested, installedName, installedVersion] as const)))(
    "rejects a %s copy, nested=%s, whose installed package.json is %s@%s", (name, nested, installedName, installedVersion) => {
      const { fixture, location } = releaseCopy(name, nested);
      fixture.installed[location] = { ...fixture.contents[location], "package.json": packageJson(installedName, installedVersion) };
      const result = fixture.run();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`${TREE}changed: ${location}/package.json`);
    });

  it("composes only evidence of its producer's schema for the release version", () => {
    const evidence: Array<[string, Record<string, unknown>]> = [
      ["dependency-policy.json", { schema: "dacs-registry-dependency-policy/v1", passed: true, violations: [] }],
      ["audit-policy.json", { schema: "dacs-registry-audit-policy/v1",
        observedAdvisories: baselineOnlySummary().audit.observedAdvisories, unlistedAdvisories: [] }],
      ["runtime-image-policy.json", { schema: "dacs-runtime-image-policy/v1", functionalPassed: true,
        typescriptPresent: false, rubicSdkPresent: false, productionDependencyPolicyPassed: true }],
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

  it("derives the summary fields from the checks that ran", () => {
    const passing = writeSummary();
    expect(passing).toMatchObject({
      generatedMode: "live-demos", generatedRole: "seller", generatedRails: ["x402", "pay-dem"],
      registryDependencyOnly: true, generatedTestsPassed: true, functionalPassed: true,
      doctor: { observedExitCode: 5, disposition: "blocked-without-credentials" },
    });
    expect(candidateDisposition(passing).exitCode).toBe(4);

    // The policy findings carry the violation as the producer extracts it from that report.
    const fileDependency = { location: "package.json", value: "file:../dacs" };
    const violation = writeSummary({
      "dependency-policy.json": JSON.stringify({ schema: "dacs-registry-dependency-policy/v1", passed: false,
        violations: [fileDependency] }),
      "policy-findings.json": JSON.stringify({ ...baselineOnlySummary().securityGate.findings,
        gitDependencies: [{ ...fileDependency, field: null, version: null, integrity: null }] }),
    });
    expect(violation.registryDependencyOnly).toBe(false);
    expect(candidateDisposition(violation).exitCode).toBe(3);

    const failedTests = writeSummary({ "generated-tests.exit-code": "1\n" });
    expect(failedTests).toMatchObject({ generatedTestsPassed: false, functionalPassed: false });
    expect(candidateDisposition(failedTests).exitCode).toBe(1);

    const doctor = writeSummary({ "doctor.exit-code": "0\n" });
    expect(doctor).toMatchObject({ functionalPassed: false, doctor: { disposition: "unexpected" } });
    expect(candidateDisposition(doctor).exitCode).toBe(1);
  });

  it("reports registry-source violations and refuses an unreplayable override contract", () => {
    const fixture = dependencyPolicyHarness();
    fixture.lockPackage("node_modules/x", { "package.json": packageJson("x", "1.0.0") }, { resolved: "https://example.com/x-1.0.0.tgz" });
    expect(fixture.run()).toMatchObject({ status: 0, report: { schema: "dacs-registry-dependency-policy/v1", passed: false,
      violations: [{ location: "node_modules/x", field: "resolved", value: "https://example.com/x-1.0.0.tgz" }] } });
    fixture.manifest.overrides = { viem: "npm:not-viem@1.0.0" };
    expect(registryDependencyViolations({ manifest: fixture.manifest, lock: { packages: { "": fixture.manifest, ...fixture.packages } },
      registry: CANDIDATE_REGISTRY })).toContainEqual({ location: "package.json", field: "overrides", value: '{"viem":"npm:not-viem@1.0.0"}' });
    expect(fixture.run().status).not.toBe(0);
  });

  it("refuses a Git dependency without verified bytes, including a carried module", () => {
    const fixture = dependencyPolicyHarness();
    const location = "node_modules/git-dependency";
    fixture.packages[location] = { version: "1.0.0", resolved: "git+ssh://git@example.com/git-dependency.git#0" };
    fixture.installed[location] = { "package.json": packageJson("git-dependency", "1.0.0"), "lib/index.js": "" };
    expect(fixture.run().status).not.toBe(0);
    const hidden = fixture.run(project => {
      mkdirSync(join(project, location, "lib/node_modules/@kynesyslabs/dacs"), { recursive: true });
      writeFileSync(join(project, location, "lib/node_modules/@kynesyslabs/dacs/package.json"), packageJson("@kynesyslabs/dacs", "0.0.0-old"));
    });
    expect(hidden.status).not.toBe(0);
    expect(hidden.stderr).toContain("cannot authenticate an unverified registry archive: " + location);
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
      expect(claimed.stdout).not.toContain("::warning title=Registry/container policy warning::");
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
    expect(pullRequest.stdout).toContain("::warning title=Registry/container policy warning::");
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
    const summary = dependencyPolicyFailureSummary();
    summary.audit.observedAdvisories.push(unknown);
    summary.audit.unlistedAdvisories.push(unknown);
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
    expect(result.stdout).toContain("::warning title=Registry/container policy warning::");
    expect(result.stdout).not.toContain("::warning title=Advisory IDs outside the #191 baseline::");
    expect(result.stepSummary).toBe("");
    expect(runWorkflowStep(4, summary, false, undefined, "schedule").status).toBe(0);
    expect(runDriftStep(summary, true).status).toBe(0);
  });
  it("reports drift even when a non-audit failure fails the acceptance step", () => {
    // P3-4: a blocked dependency policy (exit 3) must not mask the drift result.
    const summary = dependencyPolicyFailureSummary();
    summary.audit.observedAdvisories.push(unknown);
    summary.audit.unlistedAdvisories.push(unknown);
    expect(registryContainerDisposition(summary)).toMatchObject({ exitCode: 3,
      checks: { registryDependency: "blocked" } });
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

  it("records directness from the audited lock and lets the summary pass the gate", () => {
    const directory = mkdtempSync(join(tmpdir(), "dacs-registry-audit-policy-"));
    scratch.push(directory);
    const via = (name: string, id: string, severity: string) => ({ source: 1, name, dependency: name, title: "t",
      url: `https://github.com/advisories/${id}`, severity, cwe: [], cvss: {}, range: "<2" });
    const report = { auditReportVersion: 2, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 1, high: 2, critical: 0, total: 3 } },
      vulnerabilities: {
        direct: { name: "direct", severity: "high", isDirect: true, via: [via("direct", "GHSA-3333-4444-5555", "high"), "transitive"] },
        moderate: { name: "moderate", severity: "moderate", isDirect: true, via: [via("moderate", "GHSA-4444-5555-6666", "moderate")] },
        transitive: { name: "transitive", severity: "high", isDirect: false, via: [via("transitive", "GHSA-23hp-3jrh-7fpw", "high")] },
      } };
    writeFileSync(join(directory, "npm-audit.json"), JSON.stringify(report));
    // The root declares direct@1.0.0 and moderate@1.0.0, not transitive.
    writeFileSync(join(directory, "package-lock.json"), JSON.stringify(auditLock(report.vulnerabilities)));
    const policyPath = join(directory, "audit-policy.json");
    const result = spawnSync(process.execPath, ["scripts/registry-container-disposition.mjs", "--audit-policy",
      join(directory, "npm-audit.json"), join(directory, "package-lock.json"), policyPath], { cwd: repoRoot, encoding: "utf8" });
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
describe("runtime-image package inventory", () => {
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
    cpSync(join(repoRoot, "scripts"), join(checkout, "scripts"), { recursive: true });
    writeFileSync(join(checkout, "package.json"), readFileSync(join(repoRoot, "package.json")));
    const evidence = join(checkout, "registry-container-artifacts");
    mkdirSync(evidence);
    for (const name of readdirSync(b7b180f)) {
      writeFileSync(join(evidence, name === "engine-strict.log.txt" ? "engine-strict.log" : name),
        readFileSync(join(b7b180f, name)));
    }
    // A synthetic observation for this assembly test, independent of the lock.
    writeFileSync(join(evidence, "runtime-image-inventory.json"), JSON.stringify({
      schema: "dacs-runtime-image-inventory/v1", packages: [
        { location: "node_modules/vitest", name: "vitest", version: "3.2.4" },
      ],
    }));
    writeFileSync(join(evidence, "docker-build.log"), "not a fixture\n");
    const result = runBash(["-e", "-c", workflowStepScript("Assemble disposition fixtures")], {
      cwd: checkout, env: { GITHUB_SHA: "0123456789abcdef", PATH: stubBin(checkout) },
    });
    expect(result.status).toBe(0);
    const fixtures = join(checkout, "registry-container-fixtures/registry-container-0123456");
    expect(readdirSync(fixtures).sort()).toEqual([
      "acceptance-summary.json", "consumer-lock-sbom.err", "consumer-lock-sbom.exit-code",
      "consumer-physical-sbom.err", "consumer-physical-sbom.exit-code", "dependency-policy.json",
      "engine-strict.exit-code", "engine-strict.log.txt", "engine-versions.json", "generated-package-lock.json",
      "runtime-image-inventory.json", "runtime-image-policy.json",
    ]);
    const read = (name: string) => {
      const file = join(fixtures, name === "engine-strict.log" ? "engine-strict.log.txt" : name);
      return existsSync(file) ? readFileSync(file, "utf8") : undefined;
    };
    const summary = JSON.parse(readFileSync(join(fixtures, "acceptance-summary.json"), "utf8"));
    summary.securityGate.findings = extractPolicyFindings(read);
    expect(summary.securityGate.findings.productionImageDependencies)
      .toContainEqual({ name: "vitest", location: "node_modules/vitest", version: "3.2.4", integrity: null });
    // This offline replay supplies the historical run's absent completion and directness metadata.
    expect(registryContainerDisposition({ ...summary, complete: true, audit: { ...summary.audit, directAdvisories: [] } },
      undefined, { packageVersion: summary.packageVersion }))
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
  const lock = () => JSON.parse(readFileSync(join(b7b180f, "generated-package-lock.json"), "utf8"));
  const container = { node: "v20.19.1", npm: "11.19.0" };
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
    const command = script.split("\n").find((line) => line.includes("> /out/engine-versions.json"))!.trim()
      .replace("/out/engine-versions.json", "engine-versions.json");
    const directory = mkdtempSync(join(tmpdir(), "dacs-registry-versions-"));
    scratch.push(directory);
    const result = runBash(["-ceu", command], { cwd: directory,
      env: { PATH: stubBin(directory, { npm: "echo 11.19.0" }) } });
    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(join(directory, "engine-versions.json"), "utf8")))
      .toEqual({ node: process.version, npm: "11.19.0" });
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

describe("baseline Git and image archive identities", () => {
  const baseline = JSON.parse(readFileSync(join(repoRoot, "scripts/registry-container-audit-baseline.json"), "utf8"));
  it.each([
    ["Git", "gitDependencies", "registryDependency"],
    ["typescript", "productionImageDependencies", "productionImage"],
    ["pqcrypto", "productionImageDependencies", "productionImage"],
  ] as const)("pins the recorded version and integrity of %s findings at the same location", (name, group, check) => {
    const known = name === "Git" ? baseline.policyFindings[group][0]
      : baseline.policyFindings[group].find((entry: { name: string }) => entry.name === name);
    const classify = (finding: Record<string, unknown>) => {
      const summary = baselineOnlySummary();
      summary.securityGate.findings[group] = [finding];
      return { check: classifyPolicyChecks(summary, baseline)[check], exit: registryContainerDisposition(summary, baseline).exitCode };
    };
    expect(classify(known)).toEqual({ check: "baseline", exit: 4 });
    for (const change of [{ version: "9.9.9" }, { integrity: sri(Buffer.from("different archive")) },
      { version: undefined }, { integrity: undefined }]) {
      expect(classify({ ...known, ...change }), JSON.stringify(change)).toEqual({ check: "blocked", exit: 3 });
    }
  });

  it("pins the recorded version and integrity of engine findings at the same location and range", () => {
    const known = baseline.policyFindings.engineViolations[0];
    const classify = (violation: Record<string, unknown>) => {
      const summary = baselineOnlySummary();
      summary.securityGate.findings.engine = { exitCode: 1, code: "EBADENGINE", scanComplete: true,
        violations: [violation], reportedPackage: violation.package };
      return { check: classifyPolicyChecks(summary, baseline).engineStrict, exit: registryContainerDisposition(summary, baseline).exitCode };
    };
    expect(classify(known)).toEqual({ check: "baseline", exit: 4 });
    for (const change of [{ package: known.package.replace(/@[^@]*$/, "@99.0.0") },
      { integrity: sri(Buffer.from("different archive")) }, { integrity: undefined }]) {
      expect(classify({ ...known, ...change }), JSON.stringify(change)).toEqual({ check: "blocked", exit: 3 });
    }
  });
});

// A candidate is declared and installed under its own name only, so an alias
// is refused wherever it is declared, whatever npm installed for it.
describe("declared candidate aliases", () => {
  const aliasOf = (name: string) => `npm:@kynesyslabs/${name}@${CANDIDATE_VERSION}`;
  const other = { "package.json": packageJson("other", CANDIDATE_VERSION) };
  const declares = (declarer: string, specifier: string, name = "dacs") =>
    `${declarer} declares @kynesyslabs/${name} under another name: ${specifier}`;

  it.each(["dacs", "dacs-node"])("rejects a same-version replacement for a declared %s alias", name => {
    const fixture = dependencyPolicyHarness();
    fixture.manifest.dependencies = { ...fixture.manifest.dependencies as object, "candidate-alias": aliasOf(name) };
    fixture.lockPackage("node_modules/candidate-alias", other);
    const result = fixture.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(declares("the project", "candidate-alias", name));
  });

  it.each(["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"])(
    "rejects installed aliases declared in nested %s maps", field => {
      for (const hoisted of [false, true]) {
        const fixture = dependencyPolicyHarness();
        const location = hoisted ? "node_modules/candidate-alias" : "node_modules/plugin/node_modules/candidate-alias";
        fixture.lockPackage("node_modules/plugin", { "package.json": packageJson("plugin", "1.0.0") },
          { [field]: { "candidate-alias": aliasOf("dacs") } });
        fixture.lockPackage(location, other);
        if (!hoisted) fixture.copyPackage("node_modules/@kynesyslabs/dacs", "node_modules/candidate-alias", { name: "@kynesyslabs/dacs" });
        const result = fixture.run();
        expect(result.status, `${field} ${location}`).not.toBe(0);
        expect(result.stderr).toContain(declares("node_modules/plugin", "candidate-alias"));
      }
    });

  it.each(["dacs", "dacs-node"])("rejects a %s alias declared only by an installed package's own manifest", name => {
    const fixture = dependencyPolicyHarness();
    fixture.lockPackage("node_modules/plugin", { "package.json": packageJson("plugin", "1.0.0",
      { dependencies: { "candidate-alias": aliasOf(name) } }) }, { dependencies: { "candidate-alias": `npm:other@${CANDIDATE_VERSION}` } });
    fixture.lockPackage("node_modules/candidate-alias", other);
    const result = fixture.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(declares("node_modules/plugin", "candidate-alias", name));
  });

  it("rejects an alias declared by an installed package without a name", () => {
    const fixture = dependencyPolicyHarness();
    fixture.lockPackage("node_modules/plugin", { "package.json": packageJson(undefined, "1.0.0",
      { dependencies: { "candidate-alias": aliasOf("dacs") } }) });
    fixture.lockPackage("node_modules/candidate-alias", other);
    const result = fixture.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(declares("node_modules/plugin", "candidate-alias"));
  });

  it("rejects an alias even when it holds the exact candidate identity and bytes", () => {
    const fixture = dependencyPolicyHarness();
    fixture.manifest.dependencies = { ...fixture.manifest.dependencies as object, alias: aliasOf("dacs") };
    fixture.copyPackage("node_modules/@kynesyslabs/dacs", "node_modules/alias", { name: "@kynesyslabs/dacs" });
    const result = fixture.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(declares("the project", "alias"));
    expect(result.stderr).toContain("candidate package @kynesyslabs/dacs is installed under another name: node_modules/alias");
  });

  it.each(["optional", "dev", "devOptional"])("rejects an omitted %s alias, and a present one that is not its archive", flag => {
    const fixture = dependencyPolicyHarness();
    const alias = "node_modules/candidate-alias";
    fixture.copyPackage("node_modules/@kynesyslabs/dacs", alias, { name: "@kynesyslabs/dacs", [flag]: true });
    fixture.manifest.optionalDependencies = { "candidate-alias": aliasOf("dacs") };
    fixture.installed[alias] = null;
    const omitted = fixture.run();
    expect(omitted.status).not.toBe(0);
    expect(omitted.stderr).toContain(declares("the project", "candidate-alias"));
    fixture.installed[alias] = { "package.json": packageJson("@kynesyslabs/dacs", "0.0.0-wrong") };
    const result = fixture.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`${TREE}changed: ${alias}/package.json`);
  });

  it("requires a top-level candidate even if its absent lock entry is optional", () => {
    const fixture = dependencyPolicyHarness();
    const location = "node_modules/@kynesyslabs/dacs";
    fixture.packages[location] = { ...fixture.packages[location], optional: true };
    fixture.installed[location] = null;
    const result = fixture.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(TREE + "missing: node_modules/@kynesyslabs/dacs");
  });

  it.each(["optional", "dev", "devOptional"])("rejects an omitted %s alias Node resolves to another installed package", flag => {
    const fixture = dependencyPolicyHarness();
    const alias = "node_modules/candidate-alias";
    const omitted = "node_modules/plugin/node_modules/candidate-alias";
    fixture.lockPackage("node_modules/plugin", { "package.json": packageJson("plugin", "1.0.0") },
      { optionalDependencies: { "candidate-alias": aliasOf("dacs") } });
    fixture.copyPackage("node_modules/@kynesyslabs/dacs", omitted, { name: "@kynesyslabs/dacs", [flag]: true });
    fixture.installed[omitted] = null;
    fixture.lockPackage(alias, other);
    const result = fixture.run(project => {
      expect(createRequire(join(project, "node_modules/plugin/index.js")).resolve("candidate-alias/package.json"))
        .toBe(join(project, alias, "package.json"));
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(declares("node_modules/plugin", "candidate-alias"));
  });
});

// npm leaves an optional alias out on another platform; Node then keeps
// looking above the project, and require() also in its global folders.
describe("omitted candidate aliases Node resolves outside the installation", () => {
  const omittedAlias = () => {
    const fixture = dependencyPolicyHarness();
    fixture.copyPackage("node_modules/@kynesyslabs/dacs", "node_modules/candidate-alias", { name: "@kynesyslabs/dacs", optional: true });
    fixture.manifest.optionalDependencies = { "candidate-alias": `npm:@kynesyslabs/dacs@${CANDIDATE_VERSION}` };
    fixture.installed["node_modules/candidate-alias"] = null;
    return fixture;
  };
  const oldCopy = (directory: string) => {
    const copy = join(directory, "candidate-alias");
    mkdirSync(copy, { recursive: true });
    writeFileSync(join(copy, "package.json"), packageJson("@kynesyslabs/dacs", "0.0.0-old"));
    writeFileSync(join(copy, "index.js"), "module.exports = 'old-copy';\n");
    return realpathSync(copy);
  };
  const refusal = "the project declares @kynesyslabs/dacs under another name: candidate-alias";

  it("rejects an omitted candidate alias Node loads from a parent directory's node_modules", () => {
    const fixture = omittedAlias();
    const copy = oldCopy(join(fixture.directory, "node_modules"));
    const result = fixture.run(project => {
      expect(createRequire(join(project, "index.cjs")).resolve("candidate-alias")).toBe(join(copy, "index.js"));
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(refusal);
  });

  it("rejects an omitted candidate alias require() loads from a NODE_PATH folder", () => {
    const fixture = omittedAlias();
    const folder = join(fixture.directory, "global");
    const copy = oldCopy(folder);
    const result = fixture.run(project => {
      expect(spawnSync(process.execPath, ["--eval", "console.log(require.resolve('candidate-alias'))"],
        { cwd: project, encoding: "utf8", env: { ...process.env, NODE_PATH: folder } }).stdout).toBe(join(copy, "index.js") + "\n");
    }, { environment: { NODE_PATH: folder } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(refusal);
  });

  it("rejects an omitted candidate alias Node finds nowhere", () => {
    const result = omittedAlias().run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(refusal);
  });

  // A package named like the alias it declares resolves that specifier to its
  // own exports before any node_modules, whether or not npm installed the alias.
  it.each([true, false])("rejects a declared candidate alias Node resolves to the declaring package itself, alias installed=%s", installed => {
    const fixture = dependencyPolicyHarness();
    const declarer = "node_modules/self-named";
    fixture.lockPackage(declarer, { "package.json": packageJson("candidate-alias", "1.0.0", { exports: { ".": "./index.js" },
      dependencies: { "candidate-alias": `npm:@kynesyslabs/dacs@${CANDIDATE_VERSION}` } }), "index.js": "module.exports = 'itself';\n" });
    fixture.copyPackage("node_modules/@kynesyslabs/dacs", `${declarer}/node_modules/candidate-alias`, { name: "@kynesyslabs/dacs", optional: true });
    if (!installed) fixture.installed[`${declarer}/node_modules/candidate-alias`] = null;
    const result = fixture.run(project => {
      expect(createRequire(join(project, declarer, "index.js")).resolve("candidate-alias")).toBe(join(realpathSync(project), declarer, "index.js"));
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`${declarer} declares @kynesyslabs/dacs under another name: candidate-alias`);
  });
});

describe("candidate copies hidden in the installed tree", () => {
  const evil = { "package.json": packageJson("@kynesyslabs/dacs", "0.0.0-evil"), "index.js": "module.exports = 'shadow';" };
  const carried = (owner: string, location: string) => `cannot authenticate a candidate copy carried in the archive of ${owner}: ${location}`;
  const plugin = "node_modules/plugin";
  // Locks a package `plugin` whose archive holds `files` besides its package.json.
  const lockPlugin = (fixture: ReturnType<typeof dependencyPolicyHarness>, files: Record<string, string>) =>
    fixture.lockPackage(plugin, { "package.json": packageJson("plugin", "1.0.0"), ...files });
  const below = (directory: string, files: Record<string, string>) =>
    Object.fromEntries(Object.entries(files).map(([path, body]) => [`${directory}/${path}`, body]));

  it.each([".js", ".json", ".node"])("rejects canonical and declared alias file shadows with extension %s", extension => {
    for (const name of ["dacs", "dacs-node"]) for (const alias of [false, true]) {
      const fixture = dependencyPolicyHarness();
      const specifier = alias ? "candidate-alias" : `@kynesyslabs/${name}`;
      if (alias) fixture.manifest.dependencies = { ...fixture.manifest.dependencies as object,
        [specifier]: `npm:@kynesyslabs/${name}@${CANDIDATE_VERSION}` };
      const location = `node_modules/${specifier}${extension}`;
      const result = fixture.run(project => writeFileSync(join(project, location), extension === ".json" ? "{}" : "module.exports = 42;"));
      expect(result.status, `${name} ${specifier}${extension}`).not.toBe(0);
      expect(result.stderr).toContain(`${TREE}unexpected file: ${location}`);
    }
  });

  it.each([false, true])("rejects scope-level node_modules hiding a candidate, locked=%s", locked => {
    const fixture = dependencyPolicyHarness();
    const scope = "node_modules/@kynesyslabs/node_modules";
    if (locked) fixture.lockPackage(scope, { "package.json": packageJson("@kynesyslabs/node_modules", "1.0.0"), ...below("@kynesyslabs/dacs", evil) });
    const result = fixture.run(project => {
      if (!locked) for (const [path, body] of Object.entries(below("@kynesyslabs/dacs", evil))) {
        mkdirSync(dirname(join(project, scope, path)), { recursive: true });
        writeFileSync(join(project, scope, path), body);
      }
      expect(createRequire(join(project, "node_modules/@kynesyslabs/dacs-node/index.js")).resolve("@kynesyslabs/dacs"))
        .toBe(join(project, scope, "@kynesyslabs/dacs/index.js"));
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(locked ? carried(scope, `${scope}/@kynesyslabs/dacs`) : TREE + "unexpected directory: " + scope);
  });

  // Node's ESM resolver, unlike require, searches a `node_modules` directory
  // that is itself inside `node_modules`.
  it("rejects a candidate copy hidden in node_modules/node_modules", () => {
    let resolved = "";
    const result = dependencyPolicyHarness().run(project => {
      const holder = join(project, "node_modules/node_modules/@kynesyslabs/dacs");
      mkdirSync(holder, { recursive: true });
      writeFileSync(join(holder, "package.json"), packageJson("@kynesyslabs/dacs", "0.0.0-evil", { type: "module" }));
      writeFileSync(join(holder, "index.js"), "export default 'shadow';");
      const probe = join(project, "node_modules/@kynesyslabs/dacs-node/probe.mjs");
      writeFileSync(probe, "process.stdout.write(import.meta.resolve('@kynesyslabs/dacs'));");
      resolved = spawnSync(process.execPath, [probe], { encoding: "utf8" }).stdout;
      rmSync(probe);
    });
    expect(resolved).toContain("node_modules/node_modules/@kynesyslabs/dacs/index.js");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(TREE + "unexpected directory: node_modules/node_modules");
  });

  it.each(["dist", "lib/inner"])("rejects a candidate copy in %s/node_modules inside an installed candidate", directory => {
    const host = "node_modules/@kynesyslabs/dacs-node";
    const result = dependencyPolicyHarness().run(project => {
      const holder = join(project, host, directory, "node_modules/@kynesyslabs/dacs");
      mkdirSync(holder, { recursive: true });
      writeFileSync(join(holder, "package.json"), evil["package.json"]);
      expect(createRequire(join(project, host, directory, "index.js")).resolve("@kynesyslabs/dacs/package.json"))
        .toBe(join(holder, "package.json"));
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`${TREE}unexpected directory: ${host}/${directory.split("/")[0]}`);
  });

  it.each([
    ["a candidate", "@kynesyslabs/dacs", false],
    ["a declared alias of a candidate", "candidate-alias", true],
    ["a copy only its package.json names", "undocumented-copy", false],
    ["a scoped copy only its package.json names", "@other/undocumented-copy", false],
  ])("rejects %s carried in dist/node_modules of a package that is not a candidate", (_form, name, alias) => {
    const fixture = dependencyPolicyHarness();
    if (alias) fixture.manifest.dependencies = { ...fixture.manifest.dependencies as object, [name]: `npm:@kynesyslabs/dacs@${CANDIDATE_VERSION}` };
    lockPlugin(fixture, { "dist/index.js": `module.exports = require(${JSON.stringify(name)});`, ...below(`dist/node_modules/${name}`, evil) });
    const result = fixture.run(project => {
      expect(createRequire(join(project, plugin, "dist/index.js")).resolve(name)).toBe(join(project, plugin, "dist/node_modules", name, "index.js"));
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(carried(plugin, `${plugin}/dist/node_modules/${name}`));
  });

  it.each(["dist/node_modules/foo/node_modules", "a/node_modules/b/dist/node_modules"])(
    "rejects a candidate carried in %s below a package that is not a candidate", directory => {
      const fixture = dependencyPolicyHarness();
      lockPlugin(fixture, below(`${directory}/@kynesyslabs/dacs`, evil));
      const result = fixture.run(project => {
        expect(createRequire(join(project, plugin, directory, "..", "index.js")).resolve("@kynesyslabs/dacs"))
          .toBe(join(project, plugin, directory, "@kynesyslabs/dacs/index.js"));
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(carried(plugin, `${plugin}/${directory}/@kynesyslabs/dacs`));
    });

  it("rejects a candidate file shadow carried in node_modules of a package that is not a candidate", () => {
    const fixture = dependencyPolicyHarness();
    lockPlugin(fixture, { "dist/node_modules/@kynesyslabs/dacs.js": "module.exports = 'shadow';" });
    const result = fixture.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(carried(plugin, `${plugin}/dist/node_modules/@kynesyslabs/dacs.js`));
  });

  it("rejects a carried module whose package.json cannot be read", () => {
    const fixture = dependencyPolicyHarness();
    lockPlugin(fixture, { "dist/node_modules/fixture/package.json": '{"name": "fixture",' });
    const result = fixture.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(carried(plugin, `${plugin}/dist/node_modules/fixture`));
  });

  it.each([["dacs", "dist/node_modules"], ["dacs-node", "lib/inner/node_modules"]])(
    "rejects a carried package declaring a %s alias that another carried package stands in for, in %s", (name, directory) => {
      const fixture = dependencyPolicyHarness();
      lockPlugin(fixture, {
        [`${directory}/holder/package.json`]: packageJson("holder", "1.0.0", { dependencies: { alias: `npm:@kynesyslabs/${name}@${CANDIDATE_VERSION}` } }),
        [`${directory}/alias/package.json`]: packageJson("other", CANDIDATE_VERSION),
        [`${directory}/alias/index.js`]: "module.exports = 'substituted';",
      });
      const result = fixture.run(project => {
        expect(createRequire(join(project, plugin, directory, "holder/index.js")).resolve("alias"))
          .toBe(join(project, plugin, directory, "alias/index.js"));
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`${plugin}/${directory}/holder declares @kynesyslabs/${name} under another name: alias`);
    });

  it.each([
    ["a module that is no candidate", below("cli/node_modules/@kynesyslabs/other", { "package.json": packageJson("@kynesyslabs/other", "1.0.0") })],
    ["a package whose alias is not a candidate", { "dist/node_modules/holder/package.json": packageJson("holder", "1.0.0",
      { dependencies: { alias: "npm:other@1.0.0" } }) }],
  ])("accepts %s carried in node_modules of a package that is not a candidate", (_form, files) => {
    const fixture = dependencyPolicyHarness();
    lockPlugin(fixture, files);
    expect(fixture.run()).toMatchObject({ status: 0, report: { passed: true } });
  });

  it.each([
    ["a linked scope directory", (project: string) => symlinkSync(join(project, "elsewhere"), join(project, plugin, "dist/node_modules/@kynesyslabs")),
      `${plugin}/dist/node_modules/@kynesyslabs`],
    ["a linked directory", (project: string) => symlinkSync(join(project, "elsewhere"), join(project, plugin, "dist/linked")), `${plugin}/dist/linked`],
    ["a link to a file outside the package", (project: string) => symlinkSync(join(project, "elsewhere/main.cjs"), join(project, plugin, "main.cjs")),
      `${plugin}/main.cjs`],
    ["a link to a file inside the package", (project: string) => symlinkSync("package.json", join(project, plugin, "main.json")), `${plugin}/main.json`],
  ])("rejects %s inside an installed package, which npm never creates", (_form, link, location) => {
    const fixture = dependencyPolicyHarness();
    lockPlugin(fixture, { "dist/index.js": "", "dist/node_modules/other/package.json": packageJson("other", "1.0.0") });
    const result = fixture.run(project => {
      mkdirSync(join(project, "elsewhere/node_modules/@kynesyslabs/dacs"), { recursive: true });
      writeFileSync(join(project, "elsewhere/main.cjs"), "module.exports = require('@kynesyslabs/dacs');");
      link(project);
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`${TREE}unexpected link: ${location}`);
  });

  // npm links the commands of a package's lock `bin` map into .bin, and only those.
  describe("executable links", () => {
    const withBin = () => {
      const fixture = dependencyPolicyHarness();
      fixture.packages["node_modules/@kynesyslabs/dacs"] = { ...fixture.packages["node_modules/@kynesyslabs/dacs"], bin: { dacs: "index.js" } };
      return fixture;
    };
    const linkBin = (project: string, command: string, target: string) => {
      mkdirSync(join(project, "node_modules/.bin"), { recursive: true });
      symlinkSync(target, join(project, "node_modules/.bin", command));
    };
    it("accepts an installed candidate's ordinary executable link", () => {
      expect(withBin().run(project => linkBin(project, "dacs", "../@kynesyslabs/dacs/index.js")))
        .toMatchObject({ status: 0, report: { passed: true } });
    });
    it("accepts an ordinary executable link when the project path goes through a link", () => {
      const fixture = withBin();
      const linked = join(fixture.directory, "linked");
      symlinkSync(fixture.directory, linked);
      expect(fixture.run(project => linkBin(project, "dacs", "../@kynesyslabs/dacs/index.js"), { projectPath: join(linked, "project") }))
        .toMatchObject({ status: 0, report: { passed: true } });
    });
    it.each([
      ["to a file outside every installed package", "runner", "../../elsewhere/runner.cjs", "unexpected link: node_modules/.bin/runner"],
      ["whose target does not exist", "dacs", "../missing-command", "link to an unexpected target: node_modules/.bin/dacs -> ../missing-command"],
    ])("rejects an executable link %s", (_form, command, target, difference) => {
      const result = withBin().run(project => {
        linkBin(project, "dacs", "../@kynesyslabs/dacs/index.js");
        rmSync(join(project, "node_modules/.bin", command), { force: true });
        linkBin(project, command, target);
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(TREE + difference);
    });
    // Node resolves a candidate from a `node_modules` directory placed inside `.bin`.
    it.each(["a directory", "a link to a directory"])("rejects a candidate copy hidden in .bin as %s", form => {
      const hidden = "node_modules/.bin/node_modules";
      const result = withBin().run(project => {
        linkBin(project, "dacs", "../@kynesyslabs/dacs/index.js");
        const holder = form === "a directory" ? join(project, hidden) : join(project, "elsewhere");
        mkdirSync(join(holder, "@kynesyslabs/dacs"), { recursive: true });
        writeFileSync(join(holder, "@kynesyslabs/dacs/package.json"), evil["package.json"]);
        if (form !== "a directory") symlinkSync(holder, join(project, hidden));
        expect(createRequire(join(project, "node_modules/.bin/runner.js")).resolve("@kynesyslabs/dacs/package.json"))
          .toContain(form === "a directory" ? hidden : "elsewhere");
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`${TREE}unexpected ${form === "a directory" ? "directory" : "link"}: ${hidden}`);
    });
  });

  it.each([false, true])("rejects a declared dependency alias file shadow, hoisted=%s", hoisted => {
    const fixture = dependencyPolicyHarness();
    lockPlugin(fixture, {});
    fixture.packages[plugin] = { ...fixture.packages[plugin], dependencies: { "candidate-alias": `npm:@kynesyslabs/dacs@${CANDIDATE_VERSION}` } };
    const location = hoisted ? "node_modules/candidate-alias.js" : `${plugin}/node_modules/candidate-alias.js`;
    const result = fixture.run(project => {
      mkdirSync(dirname(join(project, location)), { recursive: true });
      writeFileSync(join(project, location), "module.exports = 42;");
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(TREE + `unexpected file: ${location}`);
    expect(result.stderr).toContain(`${plugin} declares @kynesyslabs/dacs under another name: candidate-alias`);
  });
});

// Runs the dependency policy on a consumer npm ci --ignore-scripts installed
// from a loopback registry serving the release candidates, the other dual-rail
// packages and `archives`. `locked` adds lock entries (location: the archive
// served and fields for its entry); `declared` adds to the consumer manifest.
async function registryInstallation(directory: string, archives: Record<string, Buffer>,
  locked: Record<string, [archive: string, fields: Record<string, unknown>]>,
  declared: { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> } = {}) {
  const project = join(directory, "project");
  const cache = join(directory, "npm-cache");
  mkdirSync(project, { recursive: true });
  const served = new Map(Object.entries(archives));
  const provenance = { version: CANDIDATE_VERSION, packages: {} as Record<string, { integrity: string }> };
  for (const name of DUAL_RAIL_DEPENDENCIES) {
    const archive = archives[name] ?? packTarball({ "package.json": packageJson(name, CANDIDATE_VERSION), "index.js": `module.exports = ${JSON.stringify(name)};\n` });
    served.set(name, archive);
    if (CANDIDATES.includes(name)) {
      writeFileSync(join(directory, releaseFile(name)), archive);
      provenance.packages[name] = { integrity: sri(archive) };
    }
  }
  writeFileSync(join(directory, "release-provenance.json"), JSON.stringify(provenance));
  const server = await serveArchives(served);
  try {
    const entry = (archive: string, fields: Record<string, unknown>) => {
      const bytes = served.get(archive);
      if (!bytes) throw new Error("no fixture archive " + archive);
      return { version: CANDIDATE_VERSION, resolved: `${server.registry}/${encodeURIComponent(archive)}.tgz`, integrity: sri(bytes), ...fields };
    };
    const manifest = { name: "fixture-consumer", version: "1.0.0", ...declared,
      dependencies: { ...Object.fromEntries(DUAL_RAIL_DEPENDENCIES.map(name => [name, CANDIDATE_VERSION])), ...declared.dependencies } };
    const packages = { "": manifest, ...Object.fromEntries(DUAL_RAIL_DEPENDENCIES.map(name => [`node_modules/${name}`, entry(name, {})])),
      ...Object.fromEntries(Object.entries(locked).map(([location, [archive, fields]]) => [location, entry(archive, fields)])) };
    writeFileSync(join(project, "package.json"), JSON.stringify(manifest));
    writeFileSync(join(project, "package-lock.json"), JSON.stringify({ name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true, packages }));
    const install = await npmCi(project, server.registry, cache);
    expect(install.status, install.output).toBe(0);
    const policy = spawnSync(process.execPath, ["scripts/registry-container-disposition.mjs", "--dependency-policy",
      project, server.registry, join(directory, "report.json"), directory, CANDIDATE_VERSION],
    { cwd: repoRoot, encoding: "utf8", env: { ...process.env, npm_config_cache: cache } });
    return { project, policy };
  } finally { await server.close(); }
}

describe("dependency policy over npm ci installations", () => {
  const temporaryDirectory = () => {
    const directory = mkdtempSync(join(tmpdir(), "dacs-registry-installation-"));
    scratch.push(directory);
    return directory;
  };

  it("accepts the release candidates npm installed from the isolated registry", async () => {
    const { policy } = await registryInstallation(temporaryDirectory(), {}, {});
    expect(policy.status, policy.stderr).toBe(0);
  }, 60_000);

  it.each(["fs", "path"])("refuses the built-in resolution of the exact installed candidate alias %s", async specifier => {
    const directory = temporaryDirectory();
    const { project, policy } = await registryInstallation(directory, {}, {
      [`node_modules/${specifier}`]: ["@kynesyslabs/dacs", { name: "@kynesyslabs/dacs" }],
    }, { dependencies: { [specifier]: `npm:@kynesyslabs/dacs@${CANDIDATE_VERSION}` } });
    expect(createRequire(join(project, "index.cjs")).resolve(specifier)).toBe(specifier);
    expect(policy.status).not.toBe(0);
    expect(policy.stderr).toContain(`the project declares @kynesyslabs/dacs under another name: ${specifier}`);
    expect(existsSync(join(directory, "report.json"))).toBe(false);
  }, 60_000);

  it.each(["dependencies", "peerDependencies", "devDependencies", "optionalDependencies", "optional-peer"])(
    "refuses a candidate alias the %s map declares, though npm installed nothing for it", async field => {
      const directory = temporaryDirectory();
      const alias = `npm:@kynesyslabs/dacs@${CANDIDATE_VERSION}`;
      const plugin = packTarball({ "package.json": packageJson("plugin", CANDIDATE_VERSION,
        field === "optional-peer" ? { peerDependencies: { "candidate-alias": alias },
          peerDependenciesMeta: { "candidate-alias": { optional: true } } } : { [field]: { "candidate-alias": alias } }) });
      const { project, policy } = await registryInstallation(directory, { plugin }, { "node_modules/plugin": ["plugin", {}] },
        { dependencies: { plugin: CANDIDATE_VERSION } });
      expect(() => createRequire(join(project, "node_modules/plugin/index.cjs")).resolve("candidate-alias")).toThrow();
      expect(policy.status).not.toBe(0);
      expect(policy.stderr).toContain("node_modules/plugin declares @kynesyslabs/dacs under another name: candidate-alias");
      expect(existsSync(join(directory, "report.json"))).toBe(false);
    }, 60_000);

  it.each(["identity", "alias-name", "alias-declaration", "malformed", "ordinary"])(
    "authenticates an npm-generated package scope: %s", async form => {
      const directory = temporaryDirectory();
      const alias = `npm:@kynesyslabs/dacs@${CANDIDATE_VERSION}`;
      const specifier = form.startsWith("alias-") ? "candidate-alias" : "@kynesyslabs/dacs";
      const scope = form === "malformed" ? "{" : packageJson(
        form === "identity" ? "@kynesyslabs/dacs" : form === "alias-name" ? specifier : "inner", CANDIDATE_VERSION,
        { exports: "./copy.cjs", ...(form === "alias-declaration" ? { dependencies: { [specifier]: alias } } : {}) });
      const plugin = packTarball({ "package.json": packageJson("plugin", CANDIDATE_VERSION,
        { main: "node_modules/.bin/runner.cjs", dependencies: { "bin-owner": CANDIDATE_VERSION } }),
        "node_modules/.bin/runner.cjs": `module.exports = require(${JSON.stringify(specifier)});`,
        "node_modules/.bin/copy.cjs": "module.exports = 'unreleased-copy';",
        // npm replaces this archived scope with the generated command link.
        ...(form === "ordinary" ? { "node_modules/.bin/package.json": packageJson("@kynesyslabs/dacs", CANDIDATE_VERSION,
          { exports: "./copy.cjs" }) } : {}) });
      const binOwner = packTarball({ "package.json": packageJson("bin-owner", CANDIDATE_VERSION,
        { bin: { "package.json": "scope.json" } }), "scope.json": scope });
      const other = packTarball({ "package.json": packageJson("other", CANDIDATE_VERSION),
        "index.js": "module.exports = 'unreleased-copy';" });
      const { project, policy } = await registryInstallation(directory, { plugin, "bin-owner": binOwner, other }, {
        "node_modules/plugin": ["plugin", { dependencies: { "bin-owner": CANDIDATE_VERSION } }],
        "node_modules/plugin/node_modules/bin-owner": ["bin-owner", { bin: { "package.json": "scope.json" } }],
        ...(form === "alias-declaration" ? { "node_modules/candidate-alias": ["other", {}] as [string, Record<string, unknown>] } : {}),
      }, { dependencies: { plugin: CANDIDATE_VERSION },
        ...(form === "alias-name" ? { optionalDependencies: { [specifier]: alias } } : {}) });
      const installedScope = join(project, "node_modules/plugin/node_modules/.bin/package.json");
      expect(realpathSync(installedScope)).toBe(join(project, "node_modules/plugin/node_modules/bin-owner/scope.json"));
      expect(readFileSync(installedScope, "utf8")).toBe(scope);
      const loaded = spawnSync(process.execPath, ["--eval", "console.log(require('plugin'))"], { cwd: project, encoding: "utf8" });
      if (form === "ordinary") {
        expect(loaded.status, loaded.stderr).toBe(0);
        expect(loaded.stdout).toBe("@kynesyslabs/dacs\n");
        expect(policy.status, policy.stderr).toBe(0);
        expect(JSON.parse(readFileSync(join(directory, "report.json"), "utf8"))).toMatchObject({ passed: true });
      } else {
        if (form === "malformed") expect(loaded.status).not.toBe(0);
        else {
          expect(loaded.status, loaded.stderr).toBe(0);
          expect(loaded.stdout).toBe("unreleased-copy\n");
        }
        expect(policy.status, policy.stderr).not.toBe(0);
        expect(policy.stderr).toContain(form === "alias-name" ? `the project declares @kynesyslabs/dacs under another name: ${specifier}`
          : "node_modules/plugin/node_modules/.bin");
        expect(existsSync(join(directory, "report.json"))).toBe(false);
      }
    }, 60_000);

  // npm would link the command to a directory, adding a module root inside
  // .bin; the closure admits command links to archive files only.
  it("refuses npm-generated directory links that create additional module roots", async () => {
    const directory = temporaryDirectory();
    const plugin = packTarball({ "package.json": packageJson("plugin", CANDIDATE_VERSION,
      { main: "node_modules/.bin/runner.cjs", dependencies: { "bin-owner": CANDIDATE_VERSION } }),
      "node_modules/.bin/runner.cjs": "module.exports = require('@kynesyslabs/dacs');" });
    const binOwner = packTarball({ "package.json": packageJson("bin-owner", CANDIDATE_VERSION,
      { bin: { node_modules: "modules" } }),
      "modules/@kynesyslabs/dacs/package.json": packageJson(undefined, CANDIDATE_VERSION),
      "modules/@kynesyslabs/dacs/index.js": "module.exports = 'unreleased-copy';" });
    const { project, policy } = await registryInstallation(directory, { plugin, "bin-owner": binOwner }, {
      "node_modules/plugin": ["plugin", { dependencies: { "bin-owner": CANDIDATE_VERSION } }],
      "node_modules/plugin/node_modules/bin-owner": ["bin-owner", { bin: { node_modules: "modules" } }],
    }, { dependencies: { plugin: CANDIDATE_VERSION } });
    const loaded = spawnSync(process.execPath, ["--eval", "console.log(require('plugin'))"], { cwd: project, encoding: "utf8" });
    expect(loaded.status, loaded.stderr).toBe(0);
    expect(loaded.stdout).toBe("unreleased-copy\n");
    expect(policy.status, policy.stderr).not.toBe(0);
    expect(policy.stderr).toContain("link target is not a reference file or package directory: node_modules/plugin/node_modules/.bin/node_modules");
    expect(existsSync(join(directory, "report.json"))).toBe(false);
  }, 60_000);

  it.each(CANDIDATES.flatMap(name => ["name", "version"].map(field => [name, field] as const)))(
    "refuses a %s release archive with the wrong manifest %s despite matching provenance and lock", async (name, field) => {
      const directory = temporaryDirectory();
      const archive = packTarball({ "package.json": packageJson(name, CANDIDATE_VERSION, { [field]: field === "name" ? "other" : "0.0.0-old" }),
        "index.js": "module.exports = 'incorrect-release';" });
      const { project, policy } = await registryInstallation(directory, { [name]: archive }, {});
      expect(JSON.parse(readFileSync(join(project, `node_modules/${name}/package.json`), "utf8"))[field])
        .toBe(field === "name" ? "other" : "0.0.0-old");
      expect(policy.status).not.toBe(0);
      expect(policy.stderr).toContain(`packed candidate manifest does not match the release: ${name}@${CANDIDATE_VERSION}`);
      expect(existsSync(join(directory, "report.json"))).toBe(false);
    }, 60_000);

  it.each(CANDIDATES.flatMap(name => [CANDIDATE_VERSION, "0.0.0-old"].map(version => [name, version] as const)))(
    "refuses bundled %s@%s claiming the release archive's integrity", async (name, version) => {
      const directory = temporaryDirectory();
      const plugin = packTarball({ "package.json": packageJson("plugin", CANDIDATE_VERSION, { bundleDependencies: [name] }),
        "index.js": `module.exports = require(${JSON.stringify(name)});`,
        [`node_modules/${name}/package.json`]: packageJson(name, version),
        [`node_modules/${name}/index.js`]: "module.exports = 'bundled-copy';" });
      const location = `node_modules/plugin/node_modules/${name}`;
      const { project, policy } = await registryInstallation(directory, { plugin }, {
        "node_modules/plugin": ["plugin", {}], [location]: [name, { inBundle: true }],
      }, { dependencies: { plugin: CANDIDATE_VERSION } });
      const loaded = spawnSync(process.execPath, ["--eval", "console.log(require('plugin'))"], { cwd: project, encoding: "utf8" });
      expect(loaded.status, loaded.stderr).toBe(0);
      expect(loaded.stdout).toBe("bundled-copy\n");
      expect(policy.status).not.toBe(0);
      expect(policy.stderr).toContain("candidate package has no independently verified release archive: " + location);
      expect(existsSync(join(directory, "report.json"))).toBe(false);
    }, 60_000);

  it.each(["identity", "alias"])("refuses a SHA-1 registry archive hiding a candidate %s", async form => {
    const directory = temporaryDirectory();
    const plugin = packTarball({ "package.json": packageJson(form === "identity" ? CANDIDATES[0] : "plugin", CANDIDATE_VERSION,
      form === "alias" ? { dependencies: { alias: `npm:@kynesyslabs/dacs@${CANDIDATE_VERSION}` } } : {}),
      "index.js": form === "alias" ? "module.exports = require('alias');" : "module.exports = 'unreleased-copy';" });
    const other = packTarball({ "package.json": packageJson("other", CANDIDATE_VERSION), "index.js": "module.exports = 'unreleased-copy';" });
    const { project, policy } = await registryInstallation(directory, { plugin, other }, {
      "node_modules/plugin": ["plugin", { integrity: "sha1-" + createHash("sha1").update(plugin).digest("base64") }],
      ...(form === "alias" ? { "node_modules/alias": ["other", {}] as [string, Record<string, unknown>] } : {}),
    }, { dependencies: { plugin: CANDIDATE_VERSION, ...(form === "alias" ? { alias: CANDIDATE_VERSION } : {}) } });
    expect(spawnSync(process.execPath, ["--eval", "console.log(require('plugin'))"], { cwd: project, encoding: "utf8" }).stdout)
      .toBe("unreleased-copy\n");
    expect(policy.status).not.toBe(0);
    expect(policy.stderr).toContain("cannot authenticate an unverified registry archive: node_modules/plugin");
    expect(existsSync(join(directory, "report.json"))).toBe(false);
  }, 60_000);

  it.each(["dist", "lib/deep/inner"])("refuses a candidate self-reference in the nested %s package scope", async scope => {
    const plugin = packTarball({ "package.json": packageJson("plugin", CANDIDATE_VERSION, { main: `${scope}/index.cjs` }),
      [`${scope}/package.json`]: packageJson("@kynesyslabs/dacs", CANDIDATE_VERSION, { exports: "./copy.cjs" }),
      [`${scope}/index.cjs`]: "module.exports = require('@kynesyslabs/dacs');",
      [`${scope}/copy.cjs`]: "module.exports = 'unreleased-copy';" });
    const { project, policy } = await registryInstallation(temporaryDirectory(), { plugin },
      { "node_modules/plugin": ["plugin", {}] }, { dependencies: { plugin: CANDIDATE_VERSION } });
    expect(spawnSync(process.execPath, ["--eval", "console.log(require('plugin'))"], { cwd: project, encoding: "utf8" }).stdout)
      .toBe("unreleased-copy\n");
    expect(policy.status).not.toBe(0);
    expect(policy.stderr).toContain(`cannot authenticate a candidate copy carried in the archive of node_modules/plugin: node_modules/plugin/${scope}`);
  }, 60_000);

  // Node matches a package scope by prefix, so a scope named for a candidate's
  // own scope or for a subpath of the candidate captures a require() of it.
  it.each([
    ["the candidates' scope", "@kynesyslabs", { "./dacs": "./copy.cjs" }, "@kynesyslabs/dacs"],
    ["a subpath of dacs-node", "@kynesyslabs/dacs-node/transport", "./copy.cjs", "@kynesyslabs/dacs-node/transport"],
    ["a subpath of dacs", "@kynesyslabs/dacs/extra", "./copy.cjs", "@kynesyslabs/dacs/extra"],
  ])("refuses a nested package scope named for %s", async (_form, scopeName, exports, request) => {
    const plugin = packTarball({ "package.json": packageJson("plugin", CANDIDATE_VERSION, { main: "dist/index.cjs" }),
      "dist/package.json": packageJson(scopeName, CANDIDATE_VERSION, { exports }),
      "dist/index.cjs": `module.exports = require(${JSON.stringify(request)});`,
      "dist/copy.cjs": "module.exports = 'unreleased-copy';" });
    const { project, policy } = await registryInstallation(temporaryDirectory(), { plugin },
      { "node_modules/plugin": ["plugin", {}] }, { dependencies: { plugin: CANDIDATE_VERSION } });
    expect(spawnSync(process.execPath, ["--eval", "console.log(require('plugin'))"], { cwd: project, encoding: "utf8" }).stdout)
      .toBe("unreleased-copy\n");
    expect(policy.status).not.toBe(0);
    expect(policy.stderr).toContain("cannot authenticate a candidate copy carried in the archive of node_modules/plugin: node_modules/plugin/dist");
  }, 60_000);

  it("accepts a nested package scope named for a sibling of a candidate", async () => {
    const plugin = packTarball({ "package.json": packageJson("plugin", CANDIDATE_VERSION, { main: "dist/index.cjs" }),
      "dist/package.json": packageJson("@kynesyslabs/dacs-other", CANDIDATE_VERSION, { exports: "./copy.cjs" }),
      "dist/index.cjs": "module.exports = 1;", "dist/copy.cjs": "module.exports = 1;" });
    const { policy } = await registryInstallation(temporaryDirectory(), { plugin },
      { "node_modules/plugin": ["plugin", {}] }, { dependencies: { plugin: CANDIDATE_VERSION } });
    expect(policy.status, policy.stderr).toBe(0);
  }, 60_000);

  // Supported Node versions differ on which name they use; the policy refuses both.
  it("refuses a package scope with an escaped duplicate name regardless of runtime resolution", async () => {
    const directory = temporaryDirectory();
    const plugin = packTarball({ "package.json": packageJson("plugin", CANDIDATE_VERSION, { main: "dist/index.cjs" }),
      "dist/package.json": '{"name":"@kynesyslabs/dacs","\\u006eame":"ordinary-scope","exports":"./copy.cjs"}',
      "dist/index.cjs": "module.exports = require('@kynesyslabs/dacs');",
      "dist/copy.cjs": "module.exports = 'unreleased-copy';" });
    const { policy } = await registryInstallation(directory, { plugin },
      { "node_modules/plugin": ["plugin", {}] }, { dependencies: { plugin: CANDIDATE_VERSION } });
    expect(policy.status).not.toBe(0);
    expect(policy.stderr).toContain("cannot authenticate a candidate copy carried in the archive of node_modules/plugin: node_modules/plugin/dist");
    expect(existsSync(join(directory, "report.json"))).toBe(false);
  }, 60_000);

  // The lock records only fixture-plugin; npm still installs the old copy its
  // archive carries, and require() from its dist directory loads that copy.
  it("rejects a candidate copy carried in a dependency's archive that the lock does not record", async () => {
    const plugin = packTarball({ "package.json": packageJson("fixture-plugin", "1.0.0", { main: "dist/index.cjs" }),
      "dist/index.cjs": "module.exports = require('@kynesyslabs/dacs');\n",
      "dist/node_modules/@kynesyslabs/dacs/package.json": packageJson("@kynesyslabs/dacs", "0.0.0-old"),
      "dist/node_modules/@kynesyslabs/dacs/index.js": "module.exports = 'old-copy';\n" });
    const { project, policy } = await registryInstallation(temporaryDirectory(), { "fixture-plugin": plugin },
      { "node_modules/fixture-plugin": ["fixture-plugin", { version: "1.0.0" }] }, { dependencies: { "fixture-plugin": "1.0.0" } });
    expect(spawnSync(process.execPath, ["--eval", "console.log(require('fixture-plugin'))"], { cwd: project, encoding: "utf8" }).stdout).toBe("old-copy\n");
    expect(policy.status).not.toBe(0);
    expect(policy.stderr).toContain("cannot authenticate a candidate copy carried in the archive of node_modules/fixture-plugin: " +
      "node_modules/fixture-plugin/dist/node_modules/@kynesyslabs/dacs");
  }, 60_000);

  // npm skips the optional alias on this platform although the lock records
  // the release's integrity for it; CommonJS and ESM then load the parent
  // project's old copy.
  it("rejects an omitted optional candidate alias that loads a parent project's copy", async () => {
    const directory = temporaryDirectory();
    const parentCopy = join(directory, "node_modules/candidate-alias");
    mkdirSync(parentCopy, { recursive: true });
    writeFileSync(join(parentCopy, "package.json"), packageJson("@kynesyslabs/dacs", "0.0.0-old"));
    writeFileSync(join(parentCopy, "index.js"), "module.exports = 'ancestor';\n");
    const { project, policy } = await registryInstallation(directory, {},
      { "node_modules/candidate-alias": ["@kynesyslabs/dacs", { name: "@kynesyslabs/dacs", optional: true, os: [`!${process.platform}`] }] },
      { optionalDependencies: { "candidate-alias": `npm:@kynesyslabs/dacs@${CANDIDATE_VERSION}` } });
    expect(existsSync(join(project, "node_modules/candidate-alias"))).toBe(false);
    expect(createRequire(join(project, "index.cjs")).resolve("candidate-alias")).toBe(join(realpathSync(parentCopy), "index.js"));
    expect(spawnSync(process.execPath, ["--input-type=module", "--eval", "console.log(import.meta.resolve('candidate-alias'))"],
      { cwd: project, encoding: "utf8" }).stdout).toContain(`${realpathSync(parentCopy)}/index.js`);
    expect(policy.status).not.toBe(0);
    expect(policy.stderr).toContain("the project declares @kynesyslabs/dacs under another name: candidate-alias");
  }, 60_000);
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
    // A retryable HTTP status as curl --fail, Git and the Docker registry client spell it.
    ["registry-auth", { "registry.log": "curl: (22) The requested URL returned error: 503" }, "network"],
    ["registry-start", { "registry.log": "curl: (22) The requested URL returned error: 429 Too Many Requests" }, "network"],
    ["publish", { "registry.log": "curl: (22) The requested URL returned error: 408" }, "network"],
    ["registry-auth", { "registry.log": "curl: (22) The requested URL returned error: 403" }, "functional"],
    ["consumer", { "generation.log": "npm error fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 502" }, "network"],
    ["consumer", { "generation.log": "npm error fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 404" }, "functional"],
    ["registry-start", { "registry.log": "docker: Error response from daemon: received unexpected HTTP status: 503 Service Unavailable." }, "network"],
    ["image-build", { "docker-build.log": "#3 ERROR: failed to resolve source metadata for docker.io/library/node:20: unexpected status from HEAD request to https://registry-1.docker.io/v2/library/node/manifests/20: 503 Service Unavailable" }, "network"],
    ["image-build", { "docker-build.log": "#3 ERROR: failed to resolve source metadata for docker.io/library/node:20: unexpected status from HEAD request to https://registry-1.docker.io/v2/library/node/manifests/20: 401 Unauthorized" }, "functional"],
    // Output of downloaded or generated code can print any npm line: once the
    // consumer stage has written its dependency policy, its log is not evidence.
    ["consumer", { "dependency-policy.json": "{}", "generation.log": "not ok 1 - seller test failed\nnpm error code ECONNRESET" }, "functional"],
    ["consumer", { "dependency-policy.json": "{}", "generation.log": "npm error command sh -c prebuild-install\nnpm error ECONNRESET" }, "functional"],
    // The image build's own steps count until one runs package code.
    ["image-build", { "docker-build.log": "#7 [build 3/8] RUN npm ci --ignore-scripts --omit=optional\n#7 9.1 npm error code ECONNRESET" }, "network"],
    ["image-build", { "docker-build.log": "#9 [build 4/8] RUN npm rebuild better-sqlite3\n#9 1.2 npm error ECONNRESET" }, "functional"],
    ["image-build", { "docker-build.log": "Step 8/14 : RUN npm run build\n ---> Running in 0a1b\nnpm error code ECONNRESET" }, "functional"],
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
    expect(summary).toMatchObject({ failureClass: "network", failureEvidence: [expect.any(String)] });
    // The saved evidence keeps the status npm recorded, or none.
    expect(JSON.parse(summary.failureEvidence[0])).toEqual({ message: expect.any(String),
      statusCode: JSON.parse(npmOutput("npm-audit-endpoint-errors", name)).statusCode });
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

  // The class written for an audit endpoint error is the one every reader of
  // the saved summary derives from its evidence: its status, or with none, its
  // message's transport signature.
  it.each([
    ["a retryable status with a message no signature knows", { statusCode: 503, message: "upstream unavailable" }, "network"],
    ["a 502 reason phrase", { statusCode: 502, message: "Bad Gateway" }, "network"],
    ["a 429 reason phrase", { statusCode: 429, message: "Too Many Requests" }, "network"],
    ["a retryable status whose message is cut", { statusCode: 503,
      message: "503 UpstreamUnavailable" + "x".repeat(350) + " - POST https://registry.npmjs.org/-/npm/v1/security/audits/quick" }, "network"],
    ["a fetch error with a transport signature", { message: "request to https://r/ failed, reason: socket hang up" }, "network"],
    ["a TLS connection dropped before the handshake", { message: "request to https://r/ failed, reason: Client network " +
      "socket disconnected before secure TLS connection was established" }, "network"],
    ["a fetch error with no transport signature", { message: "request aborted by an unknown cause" }, "functional"],
    ["a certificate the client refused", { message: "request to https://r/ failed, reason: self-signed certificate in " +
      "certificate chain" }, "functional"],
    ["a transient fetch message beside a status npm does not retry", { message: "invalid json response body at http://r/ " +
      "reason: x", statusCode: 200 }, "functional"],
    ["a status answer npm does not retry", { message: "418 I'm a teapot - POST http://r/", statusCode: 418 }, "functional"],
    ["a status that is not an integer", { message: "ETIMEDOUT", statusCode: "503" }, "functional"],
  ])("classifies an npm audit-error object with %s as its summary's readers do", (_label, error: { message: string;
    statusCode?: unknown }, failureClass) => {
    const read = reader({ "npm-audit.json": JSON.stringify({ ...error, error: { summary: "", detail: "" } }) });
    const { failureClass: written, evidence } = classifyAcceptanceFailure({ stage: "audit-policy", read });
    expect(written).toBe(failureClass);
    expect(JSON.parse(evidence[0])).toEqual({ statusCode: Number.isInteger(error.statusCode) ? error.statusCode
      : "statusCode" in error ? null : undefined, message: error.message.slice(0, 300) });
    const summary = failureSummary({ stage: "audit-policy", exitCode: 1, read });
    expect(registryContainerDisposition(summary).failureClass).toBe(failureClass);
    expect(registryAuditDriftDisposition(summary).failureClass).toBe(failureClass);
  });

  it.each([
    [{ statusCode: 503, message: "upstream unavailable" }, "network"],
    [{ message: "request aborted by an unknown cause" }, "functional"],
  ])("reports audit endpoint error %j as %s when written and when read back by the CLI", (error, failureClass) => {
    const stage = mkdtempSync(join(tmpdir(), "dacs-registry-audit-endpoint-"));
    scratch.push(stage);
    writeFileSync(join(stage, "npm-audit.json"), JSON.stringify(error));
    const run = (...args: string[]) => spawnSync(process.execPath, ["scripts/registry-container-disposition.mjs", ...args],
      { cwd: repoRoot, encoding: "utf8" });
    const annotation = `::error title=Registry/container acceptance ${failureClass} failure::`;
    expect(run("--failure-summary", stage, "audit-policy", "1").stdout).toContain(annotation);
    const summaryPath = join(stage, "acceptance-summary.json");
    const read = run(summaryPath);
    expect(read.status).toBe(1);
    expect(read.stdout).toContain(annotation);
    expect(read.stderr).toContain(`(${failureClass} failure)`);
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
    writeFileSync(join(stage, "generated-package-lock.json"), JSON.stringify(auditLock({})));
    const policy = spawnSync(process.execPath, ["scripts/registry-container-disposition.mjs", "--audit-policy",
      join(stage, "npm-audit.json"), join(stage, "generated-package-lock.json"), join(stage, "audit-policy.json")],
      { cwd: repoRoot, encoding: "utf8" });
    expect(policy.status).not.toBe(0);
    expect(policy.stderr).toContain("incomplete npm audit advisory for x");
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

  it("records the class in the early-failure summary and its annotation", () => {
    const { output, result } = runEarlyFailure();
    expect(result.status).toBe(17);
    expect(JSON.parse(readFileSync(join(output, "acceptance-summary.json"), "utf8"))).toMatchObject({
      schema: "dacs-registry-container-acceptance/v1", complete: false, failedStage: "release-set", exitCode: 17,
      failureClass: "functional" });
    expect(result.stdout).toContain(
      "::error title=Registry/container acceptance functional failure::stopped at stage release-set with exit 17");
  });

  it("reports an audit outage as a network stop through the script's CLI and the enforced drift step", () => {
    const stage = mkdtempSync(join(tmpdir(), "dacs-registry-outage-"));
    scratch.push(stage);
    writeFileSync(join(stage, "npm-audit.json"), npmOutput("npm-audit-endpoint-errors", "503.json"));
    const result = spawnSync(process.execPath, ["scripts/registry-container-disposition.mjs", "--failure-summary", stage,
      "audit-policy", "1"], { cwd: repoRoot, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    const summary = JSON.parse(readFileSync(join(stage, "acceptance-summary.json"), "utf8"));
    expect(summary).toMatchObject({ complete: false, failedStage: "audit-policy", failureClass: "network",
      failureEvidence: [expect.any(String)] });
    const evidence = summary.failureEvidence[0];
    expect(JSON.parse(evidence)).toMatchObject({
      statusCode: 503, message: expect.stringContaining("503 Service Unavailable - POST "),
    });
    expect(result.stdout).toContain("::error title=Registry/container acceptance network failure::stopped at stage " +
      `audit-policy with exit 1; ${evidence}`);
    const drift = runDriftStep(summary, true);
    expect(drift.status).toBe(1);
    expect(drift.stdout).toContain("::warning title=Registry audit advisory drift::Advisory-ID drift was not evaluated: " +
      "acceptance stopped at stage audit-policy (network failure; rerun the workflow)");
    expect(drift.stdout + drift.stderr).not.toContain("malformed");
    expect(runDriftStep(summary, false).status).toBe(0);
  });

  it("does not let an early failure summary pass the exit-4 waiver", () => {
    const summary = failureSummary({ stage: "consumer", exitCode: 4, read: () => undefined });
    expect(runWorkflowStep(4, summary).status).toBe(4);
  });

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
