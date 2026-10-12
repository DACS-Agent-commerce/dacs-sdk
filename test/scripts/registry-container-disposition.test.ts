import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Keep the production disposition executable as plain Node ESM; a computed
// import lets this TypeScript suite exercise it without a declaration file.
const dispositionModulePath = "../../scripts/registry-container-disposition.mjs";
const { registryContainerDisposition, registryAuditDriftDisposition, classifyRegistryAudit } = await import(dispositionModulePath);

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

// Runs the workflow step in a scratch checkout holding the real disposition
// script. The npm stub writes `summary` (if given) where acceptance would, then
// exits with the acceptance status.
function runWorkflowStep(acceptanceExitCode: number, summary?: unknown, strictAudit = false) {
  const directory = mkdtempSync(join(tmpdir(), "dacs-registry-step-"));
  scratch.push(directory);
  const bin = join(directory, "bin");
  const checkout = join(directory, "checkout");
  mkdirSync(bin);
  mkdirSync(join(checkout, "scripts"), { recursive: true });
  writeFileSync(join(checkout, "scripts/registry-container-disposition.mjs"),
    readFileSync(join(repoRoot, "scripts/registry-container-disposition.mjs")));
  writeFileSync(join(checkout, "scripts/registry-container-audit-baseline.json"),
    readFileSync(join(repoRoot, "scripts/registry-container-audit-baseline.json")));
  const write = summary === undefined ? "" : [
    "mkdir -p registry-container-artifacts",
    `cat > registry-container-artifacts/acceptance-summary.json <<'JSON'\n${JSON.stringify(summary)}\nJSON`,
  ].join("\n");
  const npmStub = join(bin, "npm");
  writeFileSync(npmStub, `#!/bin/sh\n${write}\nexit ${acceptanceExitCode}\n`);
  chmodSync(npmStub, 0o700);
  return spawnSync("bash", ["-e", "-c", workflowStepScript("Run registry-shaped Linux and Docker acceptance")], {
    cwd: checkout,
    encoding: "utf8",
    env: { ...process.env, ENFORCE_AUDIT_DRIFT: String(strictAudit), PATH: `${bin}:${process.env.PATH ?? ""}` },
  });
}

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
      .toContain('node scripts/registry-container-disposition.mjs "$output_dir/acceptance-summary.json"');
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
  for (const [name, body] of [["docker", "exit 0"], ["npm", npmBody]]) {
    const stub = join(directory, name!);
    writeFileSync(stub, `#!/bin/sh\n${body}\n`);
    chmodSync(stub, 0o700);
  }
  const output = join(directory, "evidence");
  const result = spawnSync("bash", ["scripts/verify-registry-container-consumer.sh", "--output-dir", output], {
    cwd: repoRoot, encoding: "utf8",
    env: { ...process.env, RUNNER_TEMP: directory, PATH: `${directory}:${process.env.PATH ?? ""}` },
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
    expect(runWorkflowStep(4, summary, true).status).toBe(3);
  });
  it("passes the scheduled classification for a listed advisory regardless of diagnostic counts", () => {
    const summary = baselineOnlySummary();
    summary.audit.total = 145; summary.audit.critical = 5;
    expect(registryAuditDriftDisposition(summary).exitCode).toBe(0);
    expect(registryContainerDisposition(summary).exitCode).toBe(4);
  });
  it.each([{}, { ...baseline, advisoryIds: ["bogus"] }, { ...baseline, source: {} },
    { ...baseline, advisoryIds: [] }])("fails closed for a malformed baseline %j", (bad) => {
    expect(() => classifyRegistryAudit([], bad)).toThrow();
    expect(registryContainerDisposition(baselineOnlySummary(), bad).exitCode).toBe(3);
    expect(registryAuditDriftDisposition(baselineOnlySummary(), bad).exitCode).toBe(3);
  });
});
