import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Keep the production disposition executable as plain Node ESM; a computed
// import lets this TypeScript suite exercise it without a declaration file.
const dispositionModulePath = "../../scripts/registry-container-disposition.mjs";
const { registryContainerDisposition, registryAuditDriftDisposition, classifyRegistryAudit, extractPolicyFindings,
  classifyPolicyChecks, classifyAcceptanceFailure, failureSummary, satisfiesEngineRange, scanLockEngines,
  registryDependencyViolations } = await import(dispositionModulePath);

const repoRoot = resolve(import.meta.dirname, "../..");
const workflowPath = join(repoRoot, ".github/workflows/registry-container-acceptance.yml");

// The shape written by scripts/verify-registry-container-consumer.sh when the
// rehearsal works and only the recorded #191 transitive audit findings remain.
function baselineOnlySummary() {
  return {
    schema: "dacs-registry-container-acceptance/v1",
    generatedTestsPassed: true,
    functionalPassed: true,
    audit: { observedAdvisories: ["GHSA-23hp-3jrh-7fpw"], unlistedAdvisories: [] as string[], info: 0, low: 20, moderate: 30, high: 13, critical: 3, total: 66 },
    securityGate: {
      passed: false,
      registryDependencyPolicyPassed: true,
      productionImageDependencyPolicyPassed: true,
      engineStrictExitCode: 0,
      auditExitCode: 1,
      lockSbomExitCode: 0,
      physicalSbomExitCode: 0,
    },
  };
}

// The lines of one workflow step, from its `- name:` line to the next step.
function workflowStepLines(stepName: string) {
  const lines = readFileSync(workflowPath, "utf8").split("\n");
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
function workflowStepScript(stepName: string): string {
  const { lines, start, stepIndent } = workflowStepLines(stepName);
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
// exits with the acceptance status.
function runWorkflowStep(acceptanceExitCode: number, summary?: unknown, strictAudit = false,
  stepName = "Run registry-shaped Linux and Docker acceptance") {
  const directory = mkdtempSync(join(tmpdir(), "dacs-registry-step-"));
  scratch.push(directory);
  const checkout = join(directory, "checkout");
  mkdirSync(join(checkout, "scripts"), { recursive: true });
  writeFileSync(join(checkout, "scripts/registry-container-disposition.mjs"),
    readFileSync(join(repoRoot, "scripts/registry-container-disposition.mjs")));
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
  return runBash(["-e", "-c", workflowStepScript(stepName)], {
    cwd: checkout, env: { ENFORCE_AUDIT_DRIFT: String(strictAudit), PATH },
  });
}
const runDriftStep = (summary?: unknown, strictAudit = false) =>
  runWorkflowStep(0, summary, strictAudit, "Check advisory-ID drift");

describe("registry/container acceptance disposition", () => {
  it("passes only when both the rehearsal and the release security gate pass", () => {
    const summary = baselineOnlySummary();
    summary.securityGate.passed = true;
    summary.audit.total = 0;
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
      ".github/workflows/registry-container-audit-drift.yml", "scripts/registry-container-disposition.mjs",
      "scripts/registry-container-audit-baseline.json", "scripts/verify-registry-container-consumer.sh"]));
  });

  it("has the scheduled drift workflow call acceptance with drift enforced", () => {
    expect(drift).toMatch(/\non:\n  schedule:\n    - cron: "[^"]+"\n  workflow_dispatch:\n/);
    expect(drift).toMatch(/\n    uses: \.\/\.github\/workflows\/registry-container-acceptance\.yml\n    with:\n      enforce-audit-drift: true\n/);
    expect(acceptance).toMatch(/\n  workflow_call:\n    inputs:\n      enforce-audit-drift:\n        type: boolean\n        default: false\n/);
    expect(workflowStepLines("Check advisory-ID drift").lines.join("\n"))
      .toContain("ENFORCE_AUDIT_DRIFT: ${{ inputs.enforce-audit-drift || false }}");
  });

  it("requires code-owner review of the baseline, the scripts that decide it, and both workflows", () => {
    const owners = readFileSync(join(repoRoot, ".github/CODEOWNERS"), "utf8").split("\n");
    for (const file of ["scripts/registry-container-audit-baseline.json", "scripts/registry-container-audit-baseline.md",
      "scripts/registry-container-disposition.mjs", "scripts/verify-registry-container-consumer.sh",
      ".github/workflows/registry-container-acceptance.yml", ".github/workflows/registry-container-audit-drift.yml",
      ".github/CODEOWNERS"]) {
      expect(owners).toContain(`/${file} @randomblocker`);
    }
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
  const PATH = stubBin(directory, { curl: "exit 0", docker: "exit 0", npm: npmBody });
  const output = join(directory, "evidence");
  const result = runBash(["scripts/verify-registry-container-consumer.sh", "--output-dir", output], {
    cwd: repoRoot, env: { RUNNER_TEMP: directory, HOME: directory, PATH },
  });
  return { directory, output, result };
}

const CANDIDATE_VERSION = "0.1.0-test";
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
  const run = () => {
    writeFileSync(join(project, "package.json"), JSON.stringify(manifest));
    writeFileSync(join(project, "package-lock.json"), JSON.stringify({ packages }));
    writeFileSync(join(directory, "release-provenance.json"), JSON.stringify(provenance));
    rmSync(report, { force: true });
    const result = spawnSync(process.execPath, ["scripts/registry-container-disposition.mjs", "--dependency-policy",
      project, CANDIDATE_REGISTRY, report, directory, CANDIDATE_VERSION], { cwd: repoRoot, encoding: "utf8" });
    return { ...result, report: result.status === 0 ? JSON.parse(readFileSync(report, "utf8")) : null };
  };
  return { packages, manifest, provenance, run };
}

// Executes the script's own summary program over a stage holding the evidence
// a complete run collects; `overrides` replaces individual evidence files.
function writeSummary(overrides: Record<string, string> = {}) {
  const stage = mkdtempSync(join(tmpdir(), "dacs-registry-summary-stage-"));
  scratch.push(stage);
  const files: Record<string, string> = {
    "docker-image.json": JSON.stringify([{ Id: "sha256:image", Size: 1, Config: { User: "10001:10001" } }]),
    "npm-audit.json": JSON.stringify({ metadata: { vulnerabilities: baselineOnlySummary().audit } }),
    "dependency-policy.json": JSON.stringify({ passed: true, violations: [] }),
    "audit-policy.json": JSON.stringify({ observedAdvisories: baselineOnlySummary().audit.observedAdvisories, unlistedAdvisories: [] }),
    "runtime-image-policy.json": JSON.stringify({ functionalPassed: true, productionDependencyPolicyPassed: true }),
    "policy-findings.json": JSON.stringify({ schema: "dacs-registry-policy-findings/v1", gitDependencies: [] }),
    "engine-strict.exit-code": "0\n",
    "npm-audit.exit-code": "1\n",
    "consumer-lock-sbom.exit-code": "0\n",
    "consumer-physical-sbom.exit-code": "0\n",
    "generated-tests.exit-code": "0\n",
    "doctor.exit-code": "5\n",
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

  it("finishes cleanup and keeps the original status when an evidence write fails", () => {
    // A directory where the exit-code file belongs makes that write fail.
    const { directory, output, result } = runEarlyFailure(
      '  mkdir -p "$directory/artifacts/acceptance.exit-code"',
    );
    expect(result.status).toBe(17);
    expect(readFileSync(join(output, "doctor.log"), "utf8")).toBe("partial doctor diagnostic\n");
    expect(readdirSync(directory).filter((name) => name.startsWith("dacs-registry-acceptance."))).toEqual([]);
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
    expect(registryContainerDisposition(passing).exitCode).toBe(4);

    const violation = writeSummary({ "dependency-policy.json": JSON.stringify({
      passed: false, violations: [{ location: "package.json", value: "file:../dacs" }],
    }) });
    expect(violation.registryDependencyOnly).toBe(false);
    expect(registryContainerDisposition(violation).exitCode).toBe(3);

    const failedTests = writeSummary({ "generated-tests.exit-code": "1\n" });
    expect(failedTests).toMatchObject({ generatedTestsPassed: false, functionalPassed: false });
    expect(registryContainerDisposition(failedTests).exitCode).toBe(1);

    const doctor = writeSummary({ "doctor.exit-code": "0\n" });
    expect(doctor).toMatchObject({ functionalPassed: false, doctor: { disposition: "unexpected" } });
    expect(registryContainerDisposition(doctor).exitCode).toBe(1);
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
      expect(() => registryDependencyViolations({ manifest: {}, lock: { packages: {} }, registry: value })).toThrow("HTTPS or loopback");
    }
    expect(registryDependencyViolations({ manifest: {}, lock: { packages: {} }, registry: "https://registry.npmjs.org" })).toEqual([]);
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
  // An unlisted ID fails the required job: exit 3, and a claimed exit 4 is
  // refused by the step's re-check.
  const expectRequiredFailure = (summary: ReturnType<typeof baselineOnlySummary>, unlisted: string[]) => {
    const result = registryContainerDisposition(summary);
    expect(result).toMatchObject({ exitCode: 3, failureClass: "policy", unlistedAdvisories: unlisted,
      checks: { audit: "blocked" } });
    expect(result.message).toContain(`advisory IDs not in the #191 baseline: ${unlisted.join(", ")}`);
    expect(result.message).toContain("registry-container-audit-baseline.json and .md in a PR under CODEOWNERS review");
    expect(registryAuditDriftDisposition(summary)).toMatchObject({ exitCode: 3, unlistedAdvisories: unlisted });
    expect(runWorkflowStep(3, summary).status).toBe(3);
    const claimed = runWorkflowStep(4, summary);
    expect(claimed.status).toBe(4);
    expect(claimed.stdout).toContain(`::error title=Registry/container acceptance policy failure::`);
    expect(claimed.stdout).toContain(unlisted[0]);
    expect(claimed.stdout).not.toContain("::warning title=#191 security gate blocked::");
    expect(runDriftStep(summary, false).status).toBe(0);
    expect(runDriftStep(summary, true).status).toBe(3);
  };
  it("fails required acceptance on an appended unlisted advisory, and fails the drift check", () => {
    const summary = baselineOnlySummary();
    const unknown = "GHSA-2222-3333-4444";
    summary.audit.observedAdvisories.push(unknown);
    summary.audit.unlistedAdvisories.push(unknown);
    expectRequiredFailure(summary, [unknown]);
  });
  it("fails required acceptance on a same-count substitution", () => {
    const summary = baselineOnlySummary();
    const unknown = "GHSA-2222-3333-4444";
    summary.audit.observedAdvisories = [unknown];
    summary.audit.unlistedAdvisories = [unknown];
    expectRequiredFailure(summary, [unknown]);
    const full = baselineOnlySummary();
    full.audit.observedAdvisories = [...baseline.advisoryIds.slice(1), unknown];
    full.audit.unlistedAdvisories = [unknown];
    expect(full.audit.observedAdvisories).toHaveLength(baseline.advisoryIds.length);
    expectRequiredFailure(full, [unknown]);
  });
  it("keeps a subset of the baseline advisories baseline-only (exit 4)", () => {
    const summary = baselineOnlySummary();
    summary.audit.observedAdvisories = baseline.advisoryIds.slice(10);
    expect(registryContainerDisposition(summary)).toMatchObject({ exitCode: 4, unlistedAdvisories: [],
      checks: { audit: "baseline" } });
    const result = runWorkflowStep(4, summary);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("::warning title=#191 security gate blocked::");
    expect(runDriftStep(summary, true).status).toBe(0);
  });
  it("reports drift even when a non-audit failure fails the acceptance step", () => {
    // P3-4: a blocked dependency policy (exit 3) must not mask the drift result.
    const summary = baselineOnlySummary();
    const unknown = "GHSA-2222-3333-4444";
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
  it("passes the scheduled classification for a listed advisory regardless of diagnostic counts", () => {
    const summary = baselineOnlySummary();
    summary.audit.total = 145; summary.audit.critical = 5;
    expect(registryAuditDriftDisposition(summary).exitCode).toBe(0);
    expect(registryContainerDisposition(summary).exitCode).toBe(4);
  });
  it("uses advisory IDs even when diagnostic counts change", () => {
    const summary = baselineOnlySummary();
    summary.audit.total = 0; summary.audit.critical = 0;
    expect(registryContainerDisposition(summary).exitCode).toBe(4);
    expect(registryAuditDriftDisposition(summary).exitCode).toBe(0);
  });
  it.each([{}, { ...baseline, advisoryIds: ["bogus"] }, { ...baseline, source: {} },
    { ...baseline, advisoryIds: [] }])("fails closed for a malformed baseline %j", (bad) => {
    expect(() => classifyRegistryAudit([], bad)).toThrow();
    expect(registryContainerDisposition(baselineOnlySummary(), bad).exitCode).toBe(3);
    expect(registryAuditDriftDisposition(baselineOnlySummary(), bad).exitCode).toBe(3);
  });
});

// The real b7b180f evidence (run 38214792229): functional pass, every non-audit
// check failing on findings that main's published dependency tree carries.
// The lock keeps only the entries these tests use, each byte-identical to that
// run's lock. engine-versions.json holds the container versions its
// engine-strict.log reports (`Actual:`); that run did not yet write the file.
const b7b180f = join(repoRoot, "test/scripts/fixtures/registry-container-b7b180f");
function b7b180fEvidence(overrides: Record<string, string | undefined> = {}) {
  const read = (name: string) => name in overrides ? overrides[name]
    : (() => { try { return readFileSync(join(b7b180f, name), "utf8"); } catch { return undefined; } })();
  const summary = JSON.parse(readFileSync(join(b7b180f, "acceptance-summary.json"), "utf8"));
  summary.securityGate.findings = extractPolicyFindings(read);
  return summary;
}

describe("#191 policy-finding baseline", () => {
  const baseline = JSON.parse(readFileSync(join(repoRoot, "scripts/registry-container-audit-baseline.json"), "utf8"));

  it("classifies the b7b180f run as baseline-only (exit 4), not exit 3", () => {
    const summary = b7b180fEvidence();
    expect(classifyPolicyChecks(summary, baseline)).toEqual({ registryDependency: "baseline", productionImage: "baseline",
      engineStrict: "baseline", lockSbom: "baseline", physicalSbom: "baseline" });
    expect(registryContainerDisposition(summary)).toMatchObject({ exitCode: 4, failureClass: "policy" });
    expect(summary.securityGate.findings.engine.violations).toHaveLength(16);
    // Without the recorded findings the same run is blocked, as at b7b180f.
    expect(registryContainerDisposition(summary, { ...baseline, policyFindings: undefined }).exitCode).toBe(3);
  });

  const lock = () => JSON.parse(readFileSync(join(b7b180f, "generated-package-lock.json"), "utf8"));
  const withLock = (edit: (packages: Record<string, Record<string, unknown>>) => void) => {
    const value = lock(); edit(value.packages); return JSON.stringify(value);
  };
  const dependencyPolicy = (violations: unknown[]) => JSON.stringify({ passed: false, violations });
  const avsc = { location: "node_modules/@bundlr-network/client/node_modules/arbundles", field: "dependencies.avsc",
    value: "https://github.com/Irys-xyz/avsc#csp-fixes" };
  const strictLog = readFileSync(join(b7b180f, "engine-strict.log"), "utf8");
  const sbomErr = (name: string) => readFileSync(join(b7b180f, name), "utf8");
  it.each([
    ["a different Git dependency", "registryDependency", { "dependency-policy.json": dependencyPolicy([avsc,
      { location: "node_modules/other", field: "dependencies.x", value: "git+https://github.com/x/y.git" }]) }],
    ["the same Git dependency from another ref", "registryDependency", { "dependency-policy.json":
      dependencyPolicy([{ ...avsc, value: "https://github.com/Irys-xyz/avsc#main" }]) }],
    ["the Git dependency under a different arbundles", "registryDependency", { "generated-package-lock.json": withLock(p => {
      p["node_modules/@bundlr-network/client/node_modules/arbundles"]!.integrity = "sha512-other"; }) }],
    ["a direct file: dependency", "registryDependency", { "dependency-policy.json":
      dependencyPolicy([{ location: "package.json", value: "file:../dacs" }]) }],
    ["a new engine violation", "engineStrict", { "generated-package-lock.json": withLock(p => {
      p["node_modules/new-pkg"] = { version: "1.0.0", integrity: "sha512-new", engines: { node: ">=22" } }; }) }],
    ["a new violation of a package's npm engine", "engineStrict", { "generated-package-lock.json": withLock(p => {
      p["node_modules/minipass"]!.engines = { node: ">=16", npm: ">=12" }; }) }],
    ["a baselined package with a changed range", "engineStrict", { "generated-package-lock.json": withLock(p => {
      p["node_modules/@npmcli/agent"]!.engines = { node: ">=24" }; }) }],
    ["a strict failure not explained by the scan", "engineStrict", { "engine-strict.log":
      strictLog.replaceAll("@npmcli/agent@5.0.2", "other@1.0.0") }],
    ["an engine range the scan cannot read", "engineStrict", { "generated-package-lock.json": withLock(p => {
      p["node_modules/minipass"]!.engines = { node: "please-use-yarn" }; }) }],
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
    ["a different typescript in the image", "productionImage", { "generated-package-lock.json": withLock(p => {
      p["node_modules/typescript"]!.version = "5.9.3"; }) }],
    ["rubic-sdk in the image", "productionImage", { "runtime-image-policy.json": JSON.stringify({
      ...JSON.parse(readFileSync(join(b7b180f, "runtime-image-policy.json"), "utf8")), rubicSdkPresent: true }) }],
  ])("still exits 3 for %s", (_label, check, overrides) => {
    const summary = b7b180fEvidence(overrides as Record<string, string | undefined>);
    expect(classifyPolicyChecks(summary, baseline)[check as string]).toBe("blocked");
    expect(registryContainerDisposition(summary)).toMatchObject({ exitCode: 3, failureClass: "policy" });
  });

  it("passes a check with no findings and blocks a passing flag that carries findings", () => {
    const summary = b7b180fEvidence();
    summary.securityGate.registryDependencyPolicyPassed = true;
    expect(classifyPolicyChecks(summary, baseline).registryDependency).toBe("blocked");
    summary.securityGate.findings.gitDependencies = [];
    expect(classifyPolicyChecks(summary, baseline).registryDependency).toBe("passed");
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
  it.each(["please-use-yarn", "01.2.3", ">=1.2.3.4", "^", "1 -2", "> = 1", "1.2-beta", ">=1 || foo", "V1.2.3"])(
    "fails closed on the range %j", (range) => {
      expect(() => satisfiesEngineRange("20.19.1", range)).toThrow(/unsupported engine range/);
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
  it.each(["503.json", "502.json", "500.json", "504.json", "429.json", "timeout.json", "econnreset.json",
    "econnrefused.json", "socket-hang-up.json"])("classifies npm's audit endpoint error %s as network, never policy", (name) => {
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
