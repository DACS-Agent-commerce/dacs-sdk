import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Keep the audit step executable as plain Node ESM; a computed import lets this
// TypeScript suite exercise it without shipping a second declaration API.
const summaryModulePath = "../../scripts/gitleaks-fingerprint-summary.mjs";
const { findingsFromReport, listFingerprintsLocally, readGitleaksReport, summarizeGitleaksReport } = await import(
  summaryModulePath
);
const summaryScript = fileURLToPath(new URL(summaryModulePath, import.meta.url));

// Assemble the values that must never be printed at runtime, so secret scanners
// do not need repository-wide allow-list exceptions for this fixture.
const SENTINEL = ["never", "print", "this"].join("_");
const PERSON = ["fixture", "person"].join("-");
const EMAIL = `${PERSON}@example.invalid`;
// An obviously fake credential that a branch put in a file name.
const FAKE_SECRET = ["FAKE", "SECRET", "IN", "FILE", "NAME"].join("_");

const ONE_MIB = 1024 * 1024;
const OUTPUT_LIMIT = 900 * 1024;
const SHA = "a".repeat(40);
const INVALID = "(invalid)";

const KNOWN =
  "63e41f1d35536884cce585b7c390dcc95b47730d:test/fixtures/settlementProcessWorker.ts:generic-api-key:23";
const NEW_A = "1111111111111111111111111111111111111111:src/a.ts:generic-api-key:4";
const NEW_B = "2222222222222222222222222222222222222222:docs/b.md:dacs-mnemonic-assignment:9";

const COUNTS_TAIL = "Secret values, file names and fingerprints are not shown.";
const LISTED_LINE =
  /^[0-9a-f]{16} (?:[0-9a-f]{40}|\(invalid\)) (?:[A-Za-z0-9._-]{1,64}|\(invalid\)) (?:0|[1-9][0-9]*|\(invalid\)) [1-9][0-9]*$/;

// The fields Gitleaks 8.30.1 writes for each finding in a JSON report. Only the
// fingerprint is read; every other field holds text that must never be printed.
function finding(fingerprint: string) {
  return {
    RuleID: "generic-api-key",
    Description: "fixture",
    StartLine: 1,
    EndLine: 1,
    StartColumn: 1,
    EndColumn: 20,
    Match: SENTINEL,
    Secret: SENTINEL,
    File: `docs/${SENTINEL}.md`,
    SymlinkFile: "",
    Commit: SENTINEL,
    Entropy: 4,
    Author: PERSON,
    Email: EMAIL,
    Date: "2026-10-08T00:00:00Z",
    Message: SENTINEL,
    Tags: [],
    Fingerprint: fingerprint,
  };
}

function reportOf(fingerprints: string[]) {
  return JSON.stringify(fingerprints.map(finding));
}

const severalFindings = reportOf([NEW_B, KNOWN, NEW_A, KNOWN]);

function idOf(fingerprint: string) {
  return createHash("sha256").update(fingerprint, "utf8").digest("hex").slice(0, 16);
}

// The line listed for a well-formed `commit:file:rule:line` fingerprint.
function expectedLine(fingerprint: string, findings = 1) {
  const parts = fingerprint.split(":");
  return `${idOf(fingerprint)} ${parts[0]} ${parts.at(-2)} ${parts.at(-1)} ${findings}`;
}

// Each listed line starts with its fixed-length ID, so this sorts by ID.
function byId(lines: string[]) {
  return [...lines].sort();
}

function listedLines(markdown: string): string[] {
  const lines = markdown.split("\n");
  const start = lines.indexOf("```text");
  if (start < 0) return [];
  return lines.slice(start + 1, lines.indexOf("```", start + 1));
}

function countsLine(markdown: string) {
  return markdown.split("\n").find((line) => line.startsWith("**"));
}

function expectNoFindingDetails(text: string) {
  expect(text).not.toContain(SENTINEL);
  expect(text).not.toContain(PERSON);
  expect(text).not.toContain(EMAIL);
}

// The runner reads `::command::` after leading whitespace, `##[command]` anywhere
// in a line, and splits lines at \r as well as \n.
function expectNoWorkflowCommand(text: string) {
  expect(text).toMatch(/^[\x20-\x7e\n]*$/);
  for (const line of text.split("\n")) expect(line.trimStart().startsWith("::")).toBe(false);
  expect(text).not.toContain("::");
  expect(text).not.toContain("##[");
}

describe("Gitleaks finding summary", () => {
  it("reports only a passed scan of an empty array as clean", () => {
    for (const text of ["[]", "[]\n", " [ ]\n"]) {
      const summary = summarizeGitleaksReport({ text }, "success");
      expect(summary.clean).toBe(true);
      expect(summary.markdown).toContain("No findings.");
      expect(listedLines(summary.markdown)).toEqual([]);
    }
    for (const outcome of ["failure", "cancelled", "skipped"]) {
      const summary = summarizeGitleaksReport({ text: "[]" }, outcome);
      expect(summary.clean).toBe(false);
      expect(summary.markdown).toContain("the scan may be partial");
      expect(summary.markdown).not.toContain("No findings.");
    }
  });

  it("fails closed on anything but a JSON array of fingerprinted findings", () => {
    const malformed: Array<[string, RegExp]> = [
      ["null", /not a JSON array/],
      ["{}", /not a JSON array/],
      ['"x"', /not a JSON array/],
      ['"[]"', /not a JSON array/],
      ["0", /not a JSON array/],
      ["", /not valid JSON/],
      ["[", /not valid JSON/],
      ["\ufeff[]", /not valid JSON/],
      ["[null]", /finding 1 has no fingerprint/],
      [JSON.stringify([finding(NEW_A), { ...finding(NEW_B), Fingerprint: "" }]), /finding 2 has no fingerprint/],
      [JSON.stringify([{ ...finding(NEW_A), Fingerprint: 7 }]), /finding 1 has no fingerprint/],
      ['[{"__proto__": {"Fingerprint": "x"}}]', /finding 1 has no fingerprint/],
    ];
    for (const [text, reason] of malformed) {
      expect(() => findingsFromReport(text)).toThrow(reason);
      for (const outcome of ["success", "failure"]) {
        const summary = summarizeGitleaksReport({ text }, outcome);
        expect(summary.clean).toBe(false);
        expect(summary.markdown).toContain("Unreadable Gitleaks report");
        expect(summary.markdown).toMatch(reason);
        expect(summary.markdown).not.toContain("No findings.");
        expectNoFindingDetails(summary.markdown);
      }
    }
    const missing = summarizeGitleaksReport({ problem: "the report is missing" }, "success");
    expect(missing).toMatchObject({ clean: false });
    expect(missing.markdown).toContain("the report is missing");
  });

  it("lists each distinct fingerprint as an ID with its commit, rule, line and count", () => {
    const summary = summarizeGitleaksReport({ text: severalFindings }, "failure");
    expect(summary.clean).toBe(false);
    expect(countsLine(summary.markdown)).toBe(
      `**4 findings** under 3 IDs: 0 malformed, 0 omitted from the list below. ${COUNTS_TAIL}`,
    );
    expect(listedLines(summary.markdown)).toEqual(
      byId([expectedLine(NEW_A), expectedLine(NEW_B), expectedLine(KNOWN, 2)]),
    );
    for (const fingerprint of [KNOWN, NEW_A, NEW_B]) {
      expect(summary.markdown).not.toContain(fingerprint);
      expect(summary.markdown).not.toContain(fingerprint.split(":")[1]);
    }
    expectNoFindingDetails(summary.markdown);

    const inconsistent = summarizeGitleaksReport({ text: reportOf([NEW_A]) }, "success");
    expect(inconsistent.clean).toBe(false);
    expect(inconsistent.markdown).toContain("although the scan step passed");
  });

  it("shows a new finding as a new ID, or as a higher count for a known one", () => {
    const listed = (fingerprints: string[]) =>
      listedLines(summarizeGitleaksReport({ text: reportOf(fingerprints) }, "failure").markdown);
    const known = listed([KNOWN]);
    expect(listed([KNOWN, NEW_A]).filter((line) => !known.includes(line))).toEqual([expectedLine(NEW_A)]);
    // A second finding with the same fingerprint keeps the ID; only the count shows it.
    expect(listed([KNOWN, KNOWN])).toEqual([expectedLine(KNOWN, 2)]);
  });

  it("shows a commit, rule or line only when it passes its check", () => {
    const cases: Array<[fingerprint: string, commit: string, rule: string, line: string]> = [
      [`${SHA}:src/a:b.ts:generic-api-key:4`, SHA, "generic-api-key", "4"],
      [`${SHA}:src/a.ts:R.u_l-e.9:0`, SHA, "R.u_l-e.9", "0"],
      [`${SHA}:src/a.ts:${"r".repeat(64)}:9007199254740991`, SHA, "r".repeat(64), "9007199254740991"],
      [`${"A".repeat(40)}:src/a.ts:generic-api-key:4`, INVALID, "generic-api-key", "4"],
      [`${"a".repeat(39)}:src/a.ts:generic-api-key:4`, INVALID, "generic-api-key", "4"],
      [`::add-mask::src/a.ts:generic-api-key:4`, INVALID, "generic-api-key", "4"],
      [`##[add-mask]${SHA}:src/a.ts:generic-api-key:4`, INVALID, "generic-api-key", "4"],
      [`${SHA}:src/a.ts:${"r".repeat(65)}:4`, SHA, INVALID, "4"],
      [`${SHA}:src/a.ts::4`, SHA, INVALID, "4"],
      [`${SHA}:src/a.ts:##[group]x:4`, SHA, INVALID, "4"],
      [`${SHA}:src/a.ts:generic api key:4`, SHA, INVALID, "4"],
      [`${SHA}:src/a.ts:generic-api-key:-1`, SHA, "generic-api-key", INVALID],
      [`${SHA}:src/a.ts:generic-api-key:1.5`, SHA, "generic-api-key", INVALID],
      [`${SHA}:src/a.ts:generic-api-key:01`, SHA, "generic-api-key", INVALID],
      [`${SHA}:src/a.ts:generic-api-key:9007199254740992`, SHA, "generic-api-key", INVALID],
      [`${SHA}:src/a.ts:generic-api-key:`, SHA, "generic-api-key", INVALID],
      [`${SHA}:src/a.ts:generic-api-key:4\r`, SHA, "generic-api-key", INVALID],
      [`${SHA}:src/a.ts:generic-api-key:\u0664`, SHA, "generic-api-key", INVALID],
      // A Gitleaks fingerprint without a commit, and one too short to have all four fields.
      ["src/a.ts:generic-api-key:4", INVALID, INVALID, INVALID],
      [`${SHA}:generic-api-key:4`, INVALID, INVALID, INVALID],
      [SHA, INVALID, INVALID, INVALID],
    ];
    const summary = summarizeGitleaksReport({ text: reportOf(cases.map(([fingerprint]) => fingerprint)) }, "failure");
    const malformed = cases.filter((fields) => fields.includes(INVALID)).length;
    expect(countsLine(summary.markdown)).toBe(
      `**${cases.length} findings** under ${cases.length} IDs: ${malformed} malformed, 0 omitted from the list below. ${COUNTS_TAIL}`,
    );
    expect(listedLines(summary.markdown)).toEqual(
      byId(cases.map(([fingerprint, commit, rule, line]) => `${idOf(fingerprint)} ${commit} ${rule} ${line} 1`)),
    );
    expectNoWorkflowCommand(summary.markdown);
  });

  it("stops listing at its byte limit and still gives every count", () => {
    const many = Array.from({ length: 200 }, (_, index) => `${SHA}:src/${index}.ts:generic-api-key:${index}`);
    const summary = summarizeGitleaksReport({ text: reportOf(many) }, "failure", 4_096);
    const size = Buffer.byteLength(summary.markdown);
    const listed = listedLines(summary.markdown);
    expect(size).toBeLessThanOrEqual(4_096);
    expect(size).toBeGreaterThan(4_096 - 2 * (Buffer.byteLength(listed[0] ?? "") + 1));
    expect(listed.length).toBeGreaterThan(0);
    expect(listed).toEqual(byId(many.map((fingerprint) => expectedLine(fingerprint))).slice(0, listed.length));
    expect(countsLine(summary.markdown)).toBe(
      `**200 findings** under 200 IDs: 0 malformed, ${200 - listed.length} omitted from the list below. ${COUNTS_TAIL}`,
    );
  });

  it("lists raw fingerprints only in the local listing, escaped to printable ASCII", () => {
    const control = `${SHA}:src/\u001b]0;x\u0007\u0085.ts:generic-api-key:7`;
    const quoted = `"${SHA}:src/a.ts":generic-api-key:8`;
    const listing = listFingerprintsLocally({ text: reportOf([NEW_B, KNOWN, NEW_A, KNOWN, control, quoted]) });
    expect(listing.ok).toBe(true);
    expect(listing.text).toMatch(/^[\x20-\x7e\n]*$/);
    const lines = listing.text.split("\n");
    expect(lines[0]).toBe(
      "6 findings under 5 IDs, 1 malformed. Each line is the ID, then the fingerprint; a quoted fingerprint is a JSON string.",
    );
    expect(lines.slice(1, -1)).toEqual(
      byId([
        `${idOf(NEW_A)} ${NEW_A}`,
        `${idOf(NEW_B)} ${NEW_B}`,
        `${idOf(KNOWN)} ${KNOWN}`,
        `${idOf(control)} "${SHA}:src/\\u001b]0;x\\u0007\\u0085.ts:generic-api-key:7"`,
        `${idOf(quoted)} "\\u0022${SHA}:src/a.ts\\u0022:generic-api-key:8"`,
      ]),
    );
    expectNoFindingDetails(listing.text);
    for (const text of ["null", "{}", "["]) {
      expect(listFingerprintsLocally({ text }).ok).toBe(false);
    }
    expect(listFingerprintsLocally({ problem: "the report is missing" }).ok).toBe(false);
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

    // No shell and no PATH lookup; PATH holds only this Node's directory.
    function runStep(args: string[], env: Record<string, string> = {}, nodeArgs: string[] = []) {
      return spawnSync(process.execPath, [...nodeArgs, summaryScript, ...args], {
        encoding: "utf8",
        env: { PATH: dirname(process.execPath), GITHUB_STEP_SUMMARY: stepSummary, ...env },
        maxBuffer: 16 * ONE_MIB,
      });
    }

    async function runOn(report: string | Buffer, outcome = "failure") {
      await writeFile(reportPath, report);
      await writeFile(stepSummary, "earlier step\n");
      const result = runStep(["--report", reportPath, "--scan-outcome", outcome]);
      const written = await readFile(stepSummary, "utf8");
      expect(written.startsWith("earlier step\n")).toBe(true);
      // Every summary ends its last line.
      expect(written.endsWith("\n")).toBe(true);
      return { ...result, summary: written.slice("earlier step\n".length) };
    }

    // The job log between the `::stop-commands::<token>` line and a newline, then the
    // `::<token>::` line.
    function logBody(stdout: string) {
      const start = /^::stop-commands::([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\n/.exec(
        stdout,
      );
      expect(start).not.toBeNull();
      const token = start?.[1] ?? "";
      const rest = stdout.slice(start?.[0].length ?? 0);
      const resume = `\n::${token}::\n`;
      expect(rest.endsWith(resume)).toBe(true);
      const body = rest.slice(0, -resume.length);
      expect(body).not.toContain(token);
      return { token, body };
    }

    it("keeps a secret in a file name out of the log and the summary", async () => {
      const fingerprints = [
        `${SHA}:config/${FAKE_SECRET}.env:generic-api-key:1`,
        `${SHA}:${FAKE_SECRET}:generic-api-key:2`,
        `${SHA}:${FAKE_SECRET}:generic-api-key:9:src/a.ts:generic-api-key:3`,
        `${FAKE_SECRET}:src/a.ts:generic-api-key:4`,
        `${SHA}:src/a.ts:generic-api-key:${FAKE_SECRET}`,
      ];
      const result = await runOn(reportOf(fingerprints));
      expect(result.status).toBe(1);
      expect(result.stderr).toBe("");
      for (const text of [result.stdout, result.summary]) {
        expect(text).not.toContain(FAKE_SECRET);
        expect(text).not.toContain("config/");
        expectNoFindingDetails(text);
      }
      expect(logBody(result.stdout).body).toBe(result.summary);
      expect(listedLines(result.summary)).toHaveLength(fingerprints.length);
    });

    it("keeps workflow commands out of the job log", async () => {
      const hostile = [
        "::add-mask::src/a.ts:generic-api-key:1",
        `${SHA}:docs/::add-mask::x.ts:generic-api-key:2`,
        `${SHA}:docs/##[add-mask]src/a.ts:generic-api-key:3`,
        `${SHA}:cr\r::warning::x.ts:generic-api-key:4`,
        `${SHA}:crlf\r\n::error::x.ts:generic-api-key:5`,
        `${SHA}:tab\t::notice::x.ts:generic-api-key:6`,
        `${SHA}:esc\u001b[2K::debug::x.ts:generic-api-key:7`,
        `##[add-mask]${SHA}:src/a.ts:generic-api-key:8`,
        `${SHA}:src/a.ts:##[group]x:9`,
        `${SHA}:src/a.ts:generic-api-key:10\r::error::x`,
        `${SHA}:src/a.ts:generic-api-key:11\r\n##[endgroup]`,
        `${SHA}:src/a.ts:generic-api-key:\t::stop-commands::x`,
        `${SHA}:src/a.ts:cr\r::error::x:12`,
        `${SHA}:src/a.ts:tab\t##[group]:13`,
        `${SHA}:src/a.ts:esc\u001b::error::x:14`,
      ];
      const result = await runOn(reportOf(hostile));
      expect(result.status).toBe(1);
      expect(result.stderr).toBe("");
      expect(result.stdout).toMatch(/^[\x20-\x7e\n]*$/);
      const { body } = logBody(result.stdout);
      expect(body).toBe(result.summary);
      expectNoWorkflowCommand(body);
      expectNoWorkflowCommand(result.summary);
      const listed = listedLines(body);
      expect(listed).toHaveLength(hostile.length);
      for (const line of listed) expect(line).toMatch(LISTED_LINE);
    });

    it("fails closed on null, an object, a scalar and invalid JSON", async () => {
      for (const report of ["null", "{}", '"x"', "7", "[", "nul"]) {
        for (const outcome of ["success", "failure"]) {
          const result = await runOn(report, outcome);
          expect(result.status).toBe(1);
          expect(result.summary).toContain("Unreadable Gitleaks report");
          expect(result.summary).not.toContain("No findings.");
          expect(logBody(result.stdout).body).toBe(result.summary);
        }
      }
    }, 20_000);

    it("exits zero only for a passed scan of an empty array", async () => {
      const passed = await runOn("[]\n", "success");
      expect(passed.status).toBe(0);
      expect(passed.summary).toContain("No findings.");
      expect(logBody(passed.stdout).body).toBe(passed.summary);
      for (const outcome of ["failure", "cancelled", "skipped"]) {
        const result = await runOn("[]\n", outcome);
        expect(result.status).toBe(1);
        expect(result.summary).toContain("the scan may be partial");
        expect(result.summary).not.toContain("No findings.");
      }
    });

    it("lists 1,001 findings, and 1,000 with 2 KB paths, in under 1 MiB", async () => {
      const many = Array.from(
        { length: 1_001 },
        (_, index) => `${String(index).padStart(40, "0")}:src/a.ts:generic-api-key:1`,
      );
      const longPaths = Array.from(
        { length: 1_000 },
        (_, index) => `${SHA}:${"p".repeat(2_000)}/${index}.ts:generic-api-key:${index}`,
      );
      for (const fingerprints of [many, longPaths]) {
        const result = await runOn(reportOf(fingerprints));
        expect(result.status).toBe(1);
        expect(Buffer.byteLength(result.summary)).toBeLessThan(ONE_MIB);
        expect(Buffer.byteLength(result.stdout)).toBeLessThan(ONE_MIB);
        expect(countsLine(result.summary)).toBe(
          `**${fingerprints.length} findings** under ${fingerprints.length} IDs: 0 malformed, 0 omitted from the list below. ${COUNTS_TAIL}`,
        );
        expect(listedLines(result.summary)).toEqual(byId(fingerprints.map((fingerprint) => expectedLine(fingerprint))));
        expect(result.summary).not.toContain("p".repeat(64));
        expect(logBody(result.stdout).body).toBe(result.summary);
      }
    }, 20_000);

    it("stops listing at 900 KiB in the summary and the log, and counts what it omits", async () => {
      // About 142 bytes a line, so 8,000 lines would exceed 1 MiB.
      const rule = "r".repeat(64);
      const many = Array.from({ length: 8_000 }, (_, index) => `${SHA}:src/a.ts:${rule}:${9_000_000_000_000_000 + index}`);
      const result = await runOn(reportOf(many));
      expect(result.status).toBe(1);
      const { body } = logBody(result.stdout);
      expect(body).toBe(result.summary);
      expect(Buffer.byteLength(result.stdout)).toBeLessThan(ONE_MIB);
      const size = Buffer.byteLength(result.summary);
      const listed = listedLines(result.summary);
      expect(size).toBeLessThanOrEqual(OUTPUT_LIMIT);
      // The limit is used, not a count: one or two more lines would not fit.
      expect(size).toBeGreaterThan(OUTPUT_LIMIT - 2 * (Buffer.byteLength(listed[0] ?? "") + 1));
      const omitted = many.length - listed.length;
      expect(omitted).toBeGreaterThan(0);
      expect(listed).toEqual(byId(many.map((fingerprint) => expectedLine(fingerprint))).slice(0, listed.length));
      expect(countsLine(result.summary)).toBe(
        `**8000 findings** under 8000 IDs: 0 malformed, ${omitted} omitted from the list below. ${COUNTS_TAIL}`,
      );
    }, 20_000);

    it("reads a report of up to 64 MiB and fails closed on a larger one", async () => {
      // A valid empty report padded with whitespace: only the size limit can fail it.
      const padded = Buffer.alloc(64 * ONE_MIB, 0x20);
      padded.write("[]", 0);
      const limit = await runOn(padded, "success");
      expect(limit.status).toBe(0);
      expect(limit.summary).toContain("No findings.");
      const over = await runOn(Buffer.concat([padded, Buffer.from(" ")]), "success");
      expect(over.status).toBe(1);
      expect(over.summary).toContain("the report is over 64 MiB, so it was not read");
      expect(over.summary).not.toContain("No findings.");
    }, 20_000);

    it("refuses a report over 64 MiB without reading it", async () => {
      // Sparse files take no disk space. Every FileHandle shares one readFile, so a
      // spy on it sees whether a report's content is read. The assertions compare
      // only small values, so that a failure never prints 64 MiB of text.
      const handle = await open(stepSummary, "r");
      const fileHandle = Object.getPrototypeOf(handle);
      await handle.close();
      const read = vi.spyOn(fileHandle, "readFile");
      try {
        await writeFile(reportPath, "");
        await truncate(reportPath, 64 * ONE_MIB + 1);
        const over = await readGitleaksReport(reportPath);
        expect(Object.keys(over)).toEqual(["problem"]);
        expect(over.problem).toBe("the report is over 64 MiB, so it was not read");
        expect(read).not.toHaveBeenCalled();
        await truncate(reportPath, 64 * ONE_MIB);
        const limit = await readGitleaksReport(reportPath);
        expect(limit.problem).toBeUndefined();
        expect(limit.text?.length).toBe(64 * ONE_MIB);
        expect(read).toHaveBeenCalledTimes(1);
      } finally {
        read.mockRestore();
      }
    }, 20_000);

    it("lists a report over 64 MiB locally", async () => {
      const report = Buffer.alloc(64 * ONE_MIB + 1, 0x20);
      report.write(reportOf([NEW_A]), 0);
      await writeFile(reportPath, report);
      const local = runStep(["--report", reportPath, "--local"]);
      expect(local.status).toBe(0);
      expect(local.stdout.split("\n").slice(1)).toEqual([`${idOf(NEW_A)} ${NEW_A}`, ""]);
      const workflow = runStep(["--report", reportPath, "--scan-outcome", "failure"]);
      expect(workflow.status).toBe(1);
      expect(logBody(workflow.stdout).body).toContain("the report is over 64 MiB, so it was not read");
    }, 20_000);

    it("gives the same input the same IDs, and each run a new stop token", async () => {
      await writeFile(reportPath, severalFindings);
      const first = logBody(runStep(["--report", reportPath, "--scan-outcome", "failure"]).stdout);
      const second = logBody(runStep(["--report", reportPath, "--scan-outcome", "failure"]).stdout);
      expect(listedLines(first.body)).toEqual(listedLines(second.body));
      expect(listedLines(first.body).map((line) => line.slice(0, 16))).toEqual(
        [idOf(NEW_A), idOf(NEW_B), idOf(KNOWN)].sort(),
      );
      expect(first.token).not.toBe(second.token);
    });

    it("gives different fingerprints different IDs", async () => {
      const variants = [
        NEW_A,
        NEW_A.replace("src/a.ts", "src/b.ts"),
        NEW_A.replace("src/a.ts", "src/A.ts"),
        NEW_A.replace("src/a.ts", "src/a.ts "),
        NEW_A.replace("src/a.ts", "src//a.ts"),
        NEW_A.replace(":4", ":5"),
        NEW_A.replace("generic-api-key", "generic-api-keY"),
        NEW_A.replace("1111111111111111111111111111111111111111", "1111111111111111111111111111111111111112"),
      ];
      const result = await runOn(reportOf(variants));
      const ids = listedLines(logBody(result.stdout).body).map((line) => line.slice(0, 16));
      expect(new Set(ids).size).toBe(variants.length);
      expect(ids).toEqual(variants.map(idOf).sort());
    });

    it("exits non-zero without a report", async () => {
      const result = runStep(["--report", reportPath, "--scan-outcome", "success"]);
      expect(result.status).toBe(1);
      expect(await readFile(stepSummary, "utf8")).toContain("the report is missing");
      const directoryReport = runStep(["--report", directory, "--scan-outcome", "success"]);
      expect(directoryReport.status).toBe(1);
      expect(await readFile(stepSummary, "utf8")).toContain("the report is not a file");
    });

    it("fails closed on missing or unknown arguments without echoing them", async () => {
      await writeFile(reportPath, "[]\n");
      for (const args of [
        ["--report", reportPath],
        ["--report", reportPath, "--scan-outcome", ""],
        ["--report", reportPath, "--scan-outcome", "passed"],
        ["--scan-outcome", "success"],
        ["--report", reportPath, "--scan-outcome", "success", "--verbose"],
        ["--report", reportPath, "--scan-outcome", "success", "##[add-mask]x"],
        ["--report", reportPath, "--scan-outcome", "success", "::add-mask::x"],
        ["--report", reportPath, "--local", "--scan-outcome", "success"],
      ]) {
        const result = runStep(args);
        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("fingerprint summary failed closed");
        expectNoWorkflowCommand(result.stderr);
      }
      expect(await readFile(stepSummary, "utf8")).toBe("earlier step\n");
    });

    it("names only the error code when the summary can't be written", async () => {
      await writeFile(reportPath, "[]\n");
      const result = runStep(["--report", reportPath, "--scan-outcome", "success"], { GITHUB_STEP_SUMMARY: directory });
      expect(result.status).toBe(1);
      expect(result.stderr).toBe("fingerprint summary failed closed: EISDIR\n");
      // The log resumes workflow commands before the summary write fails.
      const { token, body } = logBody(result.stdout);
      expect(result.stdout.endsWith(`::${token}::\n`)).toBe(true);
      expect(body).toBe("### Gitleaks findings\n\nNo findings.\n");
    });

    it("resumes workflow commands on a line of their own after a partial write", async () => {
      // A stdout whose write of the summary text emits 10 bytes, then throws.
      const partialWrite = join(directory, "partial-write.mjs");
      await writeFile(
        partialWrite,
        [
          "const write = process.stdout.write.bind(process.stdout);",
          "process.stdout.write = (text, ...rest) => {",
          '  if (!String(text).startsWith("### ")) return write(text, ...rest);',
          "  write(String(text).slice(0, 10));",
          '  throw new Error("partial write");',
          "};",
          "",
        ].join("\n"),
      );
      await writeFile(reportPath, severalFindings);
      const result = runStep(["--report", reportPath, "--scan-outcome", "failure"], {}, [
        "--import",
        pathToFileURL(partialWrite).href,
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toBe("fingerprint summary failed closed: partial write\n");
      const { token, body } = logBody(result.stdout);
      expect(body).toBe("### Gitlea");
      expect(result.stdout.endsWith(`### Gitlea\n::${token}::\n`)).toBe(true);
    });

    it("prints raw fingerprints only locally, with the IDs the workflow shows", async () => {
      await writeFile(reportPath, severalFindings);
      const local = runStep(["--report", reportPath, "--local"]);
      expect(local.status).toBe(0);
      expect(await readFile(stepSummary, "utf8")).toBe("earlier step\n");
      const lines = local.stdout.split("\n").slice(1, -1);
      expect(lines).toEqual(byId([NEW_A, NEW_B, KNOWN].map((fingerprint) => `${idOf(fingerprint)} ${fingerprint}`)));
      const workflow = runStep(["--report", reportPath, "--scan-outcome", "failure"]);
      expect(listedLines(logBody(workflow.stdout).body).map((line) => line.slice(0, 16))).toEqual(
        lines.map((line) => line.slice(0, 16)),
      );

      const refused = runStep(["--report", reportPath, "--local"], { GITHUB_ACTIONS: "true" });
      expect(refused.status).toBe(1);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain("it does not run in GitHub Actions");

      await writeFile(reportPath, "null");
      expect(runStep(["--report", reportPath, "--local"]).status).toBe(1);
    });
  });
});
