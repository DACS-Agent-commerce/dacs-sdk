import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(
  new URL("../../../scripts/verify-pr303-test-effectiveness.mjs", import.meta.url),
);

interface EffectivenessReport {
  repositoryTargets: { unchanged: boolean };
  baselines: { file: string; status: string }[];
  mutants: { id: string; status: string; restored: boolean }[];
  passed: boolean;
}

function runEffectivenessScript(): Promise<{ status: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], {
      stdio: ["ignore", "pipe", "inherit"],
      shell: false,
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout }));
  });
}

describe("PR303 test-effectiveness witnesses", () => {
  it("catches each selected wrong implementation through its intended assertion", async () => {
    const result = await runEffectivenessScript();
    const report = JSON.parse(result.stdout) as EffectivenessReport;
    const evidence = result.stdout.slice(0, 60_000);

    expect(report.repositoryTargets.unchanged, evidence).toBe(true);
    expect(report.baselines.map(({ file, status }) => [file, status]), evidence).toEqual([
      ["test/fixedPricePayDemBuyerCommerce.test.ts", "passed"],
      ["test/fixedPriceX402BuyerAudit.test.ts", "passed"],
      ["test/fixedPriceX402BuyerCommerce.test.ts", "passed"],
      ["test/httpRuntime.test.ts", "passed"],
      ["test/service.test.ts", "passed"],
      ["test/sqlite.test.ts", "passed"],
    ]);
    const mutants = report.mutants.map(({ id, status, restored }) => [id, status, restored]);
    expect(mutants, evidence).toEqual([
      ["sqlite-history-limit-8", "killed", true],
      ["http-queue-returns-submitted-identity", "killed", true],
      ["http-queue-invents-identity-without-record", "killed", true],
      ["service-returns-signed-not-retained", "killed", true],
      ["service-substitutes-missing-retained-envelope", "killed", true],
      ["x402-received-ignores-anchored-bytes", "killed", true],
      ["paydem-received-binds-deliverable-not-evidence", "killed", true],
      ["x402-evidence-ignores-request-hash", "killed", true],
      ["x402-evidence-ignores-finality-echo", "killed", true],
      ["x402-audit-ignores-finality-echo", "killed", true],
      ["paydem-evidence-claims-resolved-address", "killed", true],
    ]);
    expect(report.passed, evidence).toBe(true);
    expect(result.status, evidence).toBe(0);
  }, 1_000_000);
});
