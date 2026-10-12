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
  classifyPolicyChecks, classifyAcceptanceFailure, failureSummary } = await import(dispositionModulePath);

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

// Extracts the literal `run: |` block of one workflow step without a YAML dependency.
function workflowStepScript(stepName: string): string {
  const lines = readFileSync(workflowPath, "utf8").split("\n");
  const start = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const stepIndent = (lines[start] ?? "").indexOf("-");
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

// Executes the script's own dependency-policy program against a generated
// consumer whose lock initially names the exact packed candidate tarballs.
function dependencyPolicyHarness() {
  const directory = mkdtempSync(join(tmpdir(), "dacs-registry-integrity-"));
  scratch.push(directory);
  const packages: Record<string, { resolved: string; integrity: string; name?: string }> = {};
  for (const name of ["dacs", "dacs-node"]) {
    const bytes = Buffer.from(name);
    writeFileSync(join(directory, `kynesyslabs-${name}-${CANDIDATE_VERSION}.tgz`), bytes);
    packages[`node_modules/@kynesyslabs/${name}`] = {
      resolved: `${CANDIDATE_REGISTRY}/${name}.tgz`,
      integrity: sri(bytes),
    };
  }
  const project = join(directory, "project");
  mkdirSync(project);
  writeFileSync(join(project, "package.json"), JSON.stringify({ dependencies: Object.fromEntries([
    "@kynesyslabs/dacs", "@kynesyslabs/dacs-node", "@kynesyslabs/demosdk", "@x402/core",
    "@x402/evm", "@x402/fetch", "better-sqlite3", "viem",
  ].map((name) => [name, CANDIDATE_VERSION])) }));
  const script = readFileSync(join(repoRoot, "scripts/verify-registry-container-consumer.sh"), "utf8")
    .split('"$artifact_stage/dependency-policy.json"')[1]!.split("<<'NODE'\n")[1]!.split("\nNODE")[0]!;
  const run = () => {
    writeFileSync(join(project, "package-lock.json"), JSON.stringify({ packages }));
    return spawnSync(process.execPath, [
      "-", project, CANDIDATE_REGISTRY, join(directory, "report.json"), directory, CANDIDATE_VERSION,
    ], { input: script, encoding: "utf8" });
  };
  return { packages, run };
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


describe("advisory-ID baseline", () => {
  const baseline = JSON.parse(readFileSync(join(repoRoot, "scripts/registry-container-audit-baseline.json"), "utf8"));
  it("reports an unlisted advisory without failing required acceptance, and fails the drift check", () => {
    const summary = baselineOnlySummary();
    const unknown = "GHSA-2222-3333-4444";
    summary.audit.observedAdvisories.push(unknown);
    summary.audit.unlistedAdvisories.push(unknown);
    expect(registryContainerDisposition(summary)).toMatchObject({ exitCode: 4, unlistedAdvisories: [unknown] });
    expect(registryAuditDriftDisposition(summary)).toMatchObject({ exitCode: 3, unlistedAdvisories: [unknown] });
    const result = runWorkflowStep(4, summary);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Unlisted advisory IDs: ${unknown}`);
    expect(runWorkflowStep(4, summary, true).status).toBe(0);
    expect(runDriftStep(summary, false).status).toBe(0);
    expect(runDriftStep(summary, true).status).toBe(3);
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
  const scan = readFileSync(join(b7b180f, "engine-scan.log"), "utf8");
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
    ["a new engine violation", "engineStrict", { "engine-scan.log": scan + "npm warn EBADENGINE   package: 'new-pkg@1.0.0',\n" }],
    ["a baselined package with a changed range", "engineStrict", { "generated-package-lock.json": withLock(p => {
      p["node_modules/@npmcli/agent"]!.engines = { node: ">=24" }; }) }],
    ["a strict failure not explained by the scan", "engineStrict", { "engine-scan.log": scan.replace(/.*@npmcli\/agent@5\.0\.2.*\n/, "") }],
    ["an incomplete engine scan", "engineStrict", { "engine-scan.exit-code": "1\n" }],
    ["a missing engine scan", "engineStrict", { "engine-scan.log": undefined }],
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
    ["audit-policy", { "npm-audit.json": '{"error":{"code":"ENOTFOUND","summary":"getaddrinfo ENOTFOUND registry.npmjs.org"}}' }, "network"],
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
