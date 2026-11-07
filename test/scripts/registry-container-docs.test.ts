import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const modulePath = "../../scripts/registry-container-disposition.mjs";
const { registryContainerDisposition } = await import(modulePath);
const runbook = () => readFileSync("scripts/registry-container-audit-baseline.md", "utf8");
const fixtureSummary = () => {
  const summary = JSON.parse(readFileSync("test/scripts/fixtures/registry-container-5c27c28/acceptance-summary.json", "utf8"));
  summary.complete = true;
  return summary;
};
const disposition = (summary: unknown) => registryContainerDisposition(summary, undefined, { packageVersion: "0.1.0-alpha.0" });
describe("acceptance runbook contracts", () => {
  it("documents and preserves pqcrypto's exact manifest-version exception", () => {
    const summary = JSON.parse(readFileSync("test/scripts/fixtures/registry-container-5c27c28/acceptance-summary.json", "utf8"));
    summary.complete = true;
    const result = () => registryContainerDisposition(summary, undefined, { packageVersion: "0.1.0-alpha.0" });
    expect(result().exitCode).toBe(4);
    const pqcrypto = summary.securityGate.findings.productionImageDependencies.find((item: { name: string }) => item.name === "pqcrypto");
    if (!pqcrypto) throw new Error("missing pqcrypto fixture finding");
    pqcrypto.version = "1.0.02";
    expect(result()).toMatchObject({ exitCode: 3, checks: { productionImage: "blocked" } });
    expect(readFileSync("scripts/registry-container-audit-baseline.md", "utf8")).toContain("exact recorded manifest version `1.0.01`");
  });
  it("creates an existing parent and a new output directory on every documented run", () => {
    const readme = readFileSync("README.md", "utf8");
    const block = /```sh\n(mkdir -p registry-container-artifacts[\s\S]*?)```/.exec(readme)?.[1];
    expect(block).toBeDefined();
    const root = mkdtempSync(join(tmpdir(), "dacs-docs-run-"));
    try {
      const stub = `npm() {
  [ "$1 $2 $3 $4" = 'run acceptance:registry-container -- --output-dir' ]
  [ -d "$(dirname "$5")" ] && [ ! -e "$5" ]
  mkdir "$5"
  printf '%s\\n' "$5"
}
`;
      const result = spawnSync("bash", ["--norc", "--noprofile", "-eu", "-c", stub + block + "\n" + block], { cwd: root, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      const paths = result.stdout.trim().split("\n"); expect(paths).toHaveLength(2); expect(new Set(paths).size).toBe(2);
      expect(readme.replace(/\s+/g, " ")).toContain("Handled failures after preflight (an exit, SIGINT or SIGTERM) retain partial evidence");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("baseline matching documented against the classifier", () => {
  it("pins Git, engine and image identities to exact version and integrity", () => {
    expect(disposition(fixtureSummary()).exitCode).toBe(4);
    const changes: Array<[string, (summary: any) => void]> = [
      ["git version", summary => { summary.securityGate.findings.gitDependencies[0].version = "0.6.24"; }],
      ["git integrity", summary => { summary.securityGate.findings.gitDependencies[0].integrity = "sha512-other-archive"; }],
      ["engine package version", summary => { summary.securityGate.findings.engine.violations[0].package = "@npmcli/agent@5.0.3"; }],
      ["engine integrity", summary => { summary.securityGate.findings.engine.violations[0].integrity = "sha512-other-archive"; }],
      ["image version", summary => { summary.securityGate.findings.productionImageDependencies.find((item: any) => item.name === "typescript").version = "5.9.3"; }],
      ["image integrity", summary => { summary.securityGate.findings.productionImageDependencies.find((item: any) => item.name === "typescript").integrity = "sha512-other-archive"; }],
    ];
    for (const [name, change] of changes) {
      const summary = fixtureSummary();
      change(summary);
      expect(disposition(summary).exitCode, name).toBe(3);
    }
  });
  it("elides installed versions only for SBOM rules", () => {
    const summary = fixtureSummary();
    summary.securityGate.findings.physicalSbom.problems = summary.securityGate.findings.physicalSbom.problems
      .map((problem: string) => problem.replace("bip39@3.1.2", "bip39@3.1.3"));
    expect(disposition(summary).exitCode).toBe(4);
  });
  it("documents the exact identities, SBOM-only elision and the reconstructed replay", () => {
    const text = runbook().replace(/\s+/g, " ");
    expect(text).toContain("Git findings pin the lock location, dependency field and spec, package version and archive integrity.");
    expect(text).toContain("Engine findings pin the package name and version, location, archive integrity and required engine range.");
    expect(text).toContain("Image findings pin the package name, location, installed version and archive integrity.");
    expect(text).toContain("Only these rules ignore installed versions.");
    expect(text).toContain("a replay reconstructed with that run's completion metadata (see the fixture README) is exit 4");
    expect(text).not.toContain("@npmcli/agent@5.0.3");
    expect(text).not.toContain("stays baseline-only instead of failing");
  });
  it("states that a clean run exits 0 and a listed ID alone does not force exit 4", () => {
    const clean = fixtureSummary();
    clean.securityGate.findings.gitDependencies = [];
    clean.securityGate.findings.engine = { ...clean.securityGate.findings.engine, exitCode: 0, code: null, reportedPackage: null, violations: [] };
    clean.securityGate.findings.lockSbom = { exitCode: 0, code: null, problems: [] };
    clean.securityGate.findings.physicalSbom = { exitCode: 0, code: null, problems: [] };
    clean.securityGate.findings.productionImageDependencies = [];
    clean.securityGate.findings.productionImageInventory = { scanComplete: true, missing: [], errors: [], packages: [] };
    for (const count of ["info", "low", "moderate", "high", "critical", "total"]) clean.audit[count] = 0;
    clean.audit.observedAdvisories = [];
    clean.securityGate.auditExitCode = 0;
    clean.securityGate.passed = true;
    expect(disposition(clean).exitCode).toBe(0);

    const mixed = fixtureSummary();
    mixed.securityGate.findings.gitDependencies[0].version = "0.6.24";
    expect(disposition(mixed)).toMatchObject({ exitCode: 3, checks: { audit: "baseline", registryDependency: "blocked" } });

    const text = runbook().replace(/\s+/g, " ");
    expect(text).toContain("A clean run with no advisory and every other policy gate passing is exit 0.");
    expect(text).toContain("a listed ID alone does not produce exit 4 when another gate is blocked, which exits 3");
  });
  it("keeps the standalone runbook's top-level heading", () => {
    expect(runbook().startsWith("# Registry/container audit baseline\n")).toBe(true);
  });
  it("scopes the partial-evidence promise to handled exits", () => {
    const readme = readFileSync("README.md", "utf8").replace(/\s+/g, " ");
    expect(readme).toContain("Power loss or SIGKILL can leave the reserved directory empty");
    expect(readme).toContain("may not survive a reboot");
  });
});


it("scopes byte limits to HTTP responses and deadlines to wrapped commands", () => {
  const readme = readFileSync("README.md", "utf8").replace(/\s+/g, " ");
  expect(readme).toContain("npm HTTP responses have byte and time limits.");
  expect(readme).toContain("Commands wrapped with `run_bounded` have deadlines.");
  expect(readme).not.toContain("responses and command execution have byte and time limits");
});
