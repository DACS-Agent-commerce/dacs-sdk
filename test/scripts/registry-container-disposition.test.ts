import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync,
  writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

// Keep the production disposition executable as plain Node ESM; a computed
// import lets this TypeScript suite exercise it without a declaration file.
const dispositionModulePath = "../../scripts/registry-container-disposition.mjs";
const { registryContainerDisposition, registryAuditDriftDisposition, classifyRegistryAudit, extractPolicyFindings,
  classifyPolicyChecks, classifyAcceptanceFailure, failureSummary, satisfiesEngineRange, scanLockEngines,
  registryDependencyViolations, runtimeImageInventoryFindings, RELEASE_VERSION, unlistedPolicyFindings } =
  await import(dispositionModulePath);
const repoRoot = resolve(import.meta.dirname, "../..");
const workflowPath = join(repoRoot, ".github/workflows/registry-container-acceptance.yml");
describe("advisory-ID baseline", () => {
  const baseline = JSON.parse(readFileSync(join(repoRoot, "scripts/registry-container-audit-baseline.json"), "utf8"));
  it("accepts an empty #191 list, in which every observed ID is unlisted", () => {
    expect(classifyRegistryAudit(["GHSA-23hp-3jrh-7fpw"], { ...baseline, advisoryIds: [] }))
      .toMatchObject({ unlistedAdvisories: ["GHSA-23hp-3jrh-7fpw"], assessedAdvisories: [] });
  });
});
