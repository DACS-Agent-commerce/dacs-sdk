import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Keep the production disposition executable as plain Node ESM; a computed
// import lets this TypeScript suite exercise it without a declaration file.
const dispositionModulePath = "../../scripts/registry-container-disposition.mjs";
const { registryContainerDisposition } = await import(dispositionModulePath);

const repoRoot = resolve(import.meta.dirname, "../..");
const workflowPath = join(repoRoot, ".github/workflows/registry-container-acceptance.yml");

// The shape written by scripts/verify-registry-container-consumer.sh when the
// rehearsal works and only the recorded #191 transitive audit findings remain.
function baselineOnlySummary() {
  return {
    functionalPassed: true,
    audit: { info: 0, low: 20, moderate: 30, high: 13, critical: 3, total: 66 },
    securityGate: {
      passed: false,
      registryDependencyPolicyPassed: true,
      productionImageDependencyPolicyPassed: true,
      engineStrictExitCode: 0,
      auditExitCode: 1,
      auditBaselineExceeded: false,
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
  const stepIndent = lines[start].indexOf("-");
  let index = start + 1;
  while (index < lines.length && !/^\s+run:/.test(lines[index])) index += 1;
  const runLine = lines[index];
  const inline = runLine.replace(/^\s+run:\s*/, "");
  if (inline !== "|") return inline;
  const body: string[] = [];
  const blockIndent = runLine.indexOf("run:") + 2;
  for (index += 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() !== "" && line.search(/\S/) <= stepIndent) break;
    body.push(line.slice(blockIndent));
  }
  return body.join("\n");
}

const scratch: string[] = [];
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function runWorkflowStep(acceptanceExitCode: number) {
  const directory = mkdtempSync(join(tmpdir(), "dacs-registry-step-"));
  scratch.push(directory);
  const npmStub = join(directory, "npm");
  writeFileSync(npmStub, `#!/bin/sh\nexit ${acceptanceExitCode}\n`);
  chmodSync(npmStub, 0o700);
  return spawnSync("bash", ["-e", "-c", workflowStepScript("Run registry-shaped Linux and Docker acceptance")], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}` },
  });
}

describe("registry/container acceptance disposition", () => {
  it("passes only when both the rehearsal and the release security gate pass", () => {
    const summary = baselineOnlySummary();
    summary.securityGate.passed = true;
    summary.audit.total = 0;
    expect(registryContainerDisposition(summary).exitCode).toBe(0);
    expect(registryContainerDisposition({ ...summary, functionalPassed: false }).exitCode).toBe(1);
    expect(registryContainerDisposition({}).exitCode).toBe(1);
  });

  it("reports audit findings within the recorded #191 baseline distinctly from a regression", () => {
    expect(registryContainerDisposition(baselineOnlySummary()).exitCode).toBe(4);
  });

  it.each([
    ["audit beyond the baseline", (s: ReturnType<typeof baselineOnlySummary>) => {
      s.securityGate.auditBaselineExceeded = true;
    }],
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
    ["a missing baseline verdict", (s: ReturnType<typeof baselineOnlySummary>) => {
      delete (s.securityGate as Partial<typeof s.securityGate>).auditBaselineExceeded;
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
    const result = runWorkflowStep(4);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("::warning title=#191 security gate blocked::");
  });

  it.each([1, 2, 3])("still fails the job on acceptance exit %i", (code) => {
    expect(runWorkflowStep(code).status).toBe(code);
  });

  it("passes when acceptance passes", () => {
    expect(runWorkflowStep(0).status).toBe(0);
  });
});
