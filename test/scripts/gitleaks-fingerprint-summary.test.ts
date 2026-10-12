import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Keep the audit step executable as plain Node ESM; a computed import lets this
// TypeScript suite exercise it without shipping a second declaration API.
const summaryModulePath = "../../scripts/gitleaks-fingerprint-summary.mjs";
const { fingerprintsFromReport, summarizeGitleaksReport } = await import(summaryModulePath);
const summaryScript = fileURLToPath(new URL(summaryModulePath, import.meta.url));

// Assemble the values that must never be printed at runtime, so secret scanners
// do not need repository-wide allow-list exceptions for this fixture.
const SENTINEL = ["never", "print", "this"].join("_");
const PERSON = ["fixture", "person"].join("-");
const EMAIL = `${PERSON}@example.invalid`;

const KNOWN =
  "63e41f1d35536884cce585b7c390dcc95b47730d:test/fixtures/settlementProcessWorker.ts:generic-api-key:23";
const NEW_A = "1111111111111111111111111111111111111111:src/a.ts:generic-api-key:4";
const NEW_B = "2222222222222222222222222222222222222222:docs/b.md:dacs-mnemonic-assignment:9";

// The fields Gitleaks 8.30.1 writes for each finding in a JSON report.
function finding(fingerprint: string) {
  const [commit, file, rule, line] = fingerprint.split(":");
  return {
    RuleID: rule,
    Description: "fixture",
    StartLine: Number(line),
    EndLine: Number(line),
    StartColumn: 1,
    EndColumn: 20,
    Match: SENTINEL,
    Secret: SENTINEL,
    File: file,
    SymlinkFile: "",
    Commit: commit,
    Entropy: 4,
    Author: PERSON,
    Email: EMAIL,
    Date: "2026-10-08T00:00:00Z",
    Message: SENTINEL,
    Tags: [],
    Fingerprint: fingerprint,
  };
}

const severalFindings = JSON.stringify([finding(NEW_B), finding(KNOWN), finding(NEW_A), finding(KNOWN)]);

function listedFingerprints(markdown: string): string[] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => /^`{3,}text$/.test(line));
  if (start < 0) return [];
  const fence = lines[start]!.slice(0, -"text".length);
  const end = lines.indexOf(fence, start + 1);
  return lines.slice(start + 1, end);
}

function expectNoFindingDetails(markdown: string) {
  expect(markdown).not.toContain(SENTINEL);
  expect(markdown).not.toContain(PERSON);
  expect(markdown).not.toContain(EMAIL);
}

describe("Gitleaks fingerprint summary", () => {
  it("reports a passed scan with no findings as clean", () => {
    for (const report of ["[]\n", "null"]) {
      const summary = summarizeGitleaksReport(report, "success");
      expect(summary.clean).toBe(true);
      expect(summary.markdown).toContain("No findings.");
      expect(listedFingerprints(summary.markdown)).toEqual([]);
    }
  });

  it("lists every distinct fingerprint, sorted, and no secret or commit details", () => {
    const summary = summarizeGitleaksReport(severalFindings, "failure");
    expect(summary.clean).toBe(false);
    expect(summary.markdown).toContain("**4 findings** under 3 fingerprints. Secret values are not shown.");
    expect(listedFingerprints(summary.markdown)).toEqual([NEW_A, NEW_B, KNOWN].sort());
    expectNoFindingDetails(summary.markdown);
  });

  it("keeps a new fingerprint distinguishable from a known one", () => {
    const known = listedFingerprints(
      summarizeGitleaksReport(JSON.stringify([finding(KNOWN)]), "failure").markdown,
    );
    const later = listedFingerprints(
      summarizeGitleaksReport(JSON.stringify([finding(KNOWN), finding(NEW_A)]), "failure").markdown,
    );
    expect(later.filter((fingerprint) => !known.includes(fingerprint))).toEqual([NEW_A]);
  });

  it("never reports a scan step that did not pass as clean", () => {
    for (const outcome of ["failure", "cancelled", "skipped"]) {
      const summary = summarizeGitleaksReport("[]", outcome);
      expect(summary.clean).toBe(false);
      expect(summary.markdown).toContain("the scan may be partial");
    }
    const inconsistent = summarizeGitleaksReport(JSON.stringify([finding(NEW_A)]), "success");
    expect(inconsistent.clean).toBe(false);
    expect(inconsistent.markdown).toContain("although the scan step passed");
  });

  it("fails closed on a missing or malformed report", () => {
    expect(summarizeGitleaksReport(undefined, "success")).toMatchObject({ clean: false });
    expect(summarizeGitleaksReport(undefined, "success").markdown).toContain("No readable Gitleaks report");
    const malformed: Array<[string, RegExp]> = [
      ["", /not valid JSON/],
      ["[", /not valid JSON/],
      ["{}", /not a JSON array/],
      ['"[]"', /not a JSON array/],
      ["[null]", /finding 1 has no fingerprint/],
      [JSON.stringify([finding(NEW_A), { ...finding(NEW_B), Fingerprint: "" }]), /finding 2 has no fingerprint/],
      [JSON.stringify([{ ...finding(NEW_A), Fingerprint: 7 }]), /finding 1 has no fingerprint/],
    ];
    for (const [report, reason] of malformed) {
      expect(() => fingerprintsFromReport(report)).toThrow(reason);
      const summary = summarizeGitleaksReport(report, "success");
      expect(summary.clean).toBe(false);
      expect(summary.markdown).toMatch(reason);
      expectNoFindingDetails(summary.markdown);
    }
  });

  it("keeps each fingerprint on one line inside the code block", () => {
    const backticks = "3333333333333333333333333333333333333333:docs/````.md:generic-api-key:1";
    const newline = "4444444444444444444444444444444444444444:docs/a\nb.md:generic-api-key:2";
    const summary = summarizeGitleaksReport(JSON.stringify([finding(backticks), finding(newline)]), "failure");
    expect(summary.markdown).toContain("`````text\n");
    expect(listedFingerprints(summary.markdown)).toEqual([backticks, JSON.stringify(newline)]);
  });

  it("caps the step summary but not the job log", () => {
    const many = Array.from(
      { length: 1_002 },
      (_, index) => `${String(index).padStart(40, "0")}:src/a.ts:generic-api-key:1`,
    );
    const report = JSON.stringify(many.map(finding));
    const summary = summarizeGitleaksReport(report, "failure");
    expect(listedFingerprints(summary.markdown)).toEqual(many.slice(0, 1_000));
    expect(summary.markdown).toContain("2 more not shown here; the job log lists every fingerprint.");
    expect(listedFingerprints(summarizeGitleaksReport(report, "failure", Infinity).markdown)).toEqual(many);
  });

  describe("workflow step", () => {
    let directory: string;
    let reportPath: string;
    let stepSummary: string;

    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), "dacs-gitleaks-summary-"));
      reportPath = join(directory, "gitleaks-report.json");
      stepSummary = join(directory, "step-summary.md");
      await writeFile(stepSummary, "earlier step\n");
    });

    afterEach(async () => {
      await rm(directory, { recursive: true, force: true });
    });

    function runStep(...args: string[]) {
      return spawnSync(process.execPath, [summaryScript, ...args], {
        encoding: "utf8",
        env: { GITHUB_STEP_SUMMARY: stepSummary },
      });
    }

    it("appends the fingerprints of several findings and exits non-zero", async () => {
      await writeFile(reportPath, severalFindings);
      const result = runStep("--report", reportPath, "--scan-outcome", "failure");
      expect(result.status).toBe(1);
      const written = await readFile(stepSummary, "utf8");
      expect(written.startsWith("earlier step\n### Gitleaks fingerprints\n")).toBe(true);
      expect(listedFingerprints(written)).toEqual([NEW_A, NEW_B, KNOWN].sort());
      expect(listedFingerprints(result.stdout)).toEqual([NEW_A, NEW_B, KNOWN].sort());
      expectNoFindingDetails(written);
      expectNoFindingDetails(result.stdout + result.stderr);
    });

    it("exits zero only for a passed scan with no findings", async () => {
      await writeFile(reportPath, "[]\n");
      expect(runStep("--report", reportPath, "--scan-outcome", "success").status).toBe(0);
      expect(await readFile(stepSummary, "utf8")).toContain("No findings.");
      expect(runStep("--report", reportPath, "--scan-outcome", "failure").status).toBe(1);
    });

    it("exits non-zero without a report", async () => {
      const result = runStep("--report", reportPath, "--scan-outcome", "failure");
      expect(result.status).toBe(1);
      expect(await readFile(stepSummary, "utf8")).toContain("No readable Gitleaks report");
    });

    it("fails closed on missing or unknown arguments", async () => {
      await writeFile(reportPath, "[]\n");
      for (const args of [
        ["--report", reportPath],
        ["--report", reportPath, "--scan-outcome", ""],
        ["--report", reportPath, "--scan-outcome", "passed"],
        ["--scan-outcome", "success"],
        ["--report", reportPath, "--scan-outcome", "success", "--verbose"],
      ]) {
        const result = runStep(...args);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("fingerprint summary failed closed");
      }
      expect(await readFile(stepSummary, "utf8")).toBe("earlier step\n");
    });
  });
});
