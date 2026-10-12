#!/usr/bin/env node

import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const SCAN_OUTCOMES = ["success", "failure", "cancelled", "skipped"];
// GitHub drops a step summary over 1 MiB; the job log still lists every fingerprint.
const MAX_SUMMARY_FINGERPRINTS = 1_000;

// Read only each finding's fingerprint (`commit:file:rule:line`). The report's
// Secret, Match and Line fields, and its commit metadata, are never read.
export function fingerprintsFromReport(text) {
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    throw new Error("the Gitleaks report is not valid JSON");
  }
  // Gitleaks writes [] when there are no findings; treat a JSON null the same way.
  if (report === null) return { findings: 0, fingerprints: [] };
  if (!Array.isArray(report)) throw new Error("the Gitleaks report is not a JSON array");
  const fingerprints = new Set();
  report.forEach((finding, index) => {
    const fingerprint =
      finding !== null && typeof finding === "object" ? finding.Fingerprint : undefined;
    if (typeof fingerprint !== "string" || fingerprint === "") {
      throw new Error(`Gitleaks finding ${index + 1} has no fingerprint`);
    }
    fingerprints.add(fingerprint);
  });
  return { findings: report.length, fingerprints: [...fingerprints].sort() };
}

// Escape control characters so that each fingerprint stays on one line.
function renderFingerprint(fingerprint) {
  return /[\u0000-\u001f\u007f]/.test(fingerprint) ? JSON.stringify(fingerprint) : fingerprint;
}

// A fence longer than any backtick run in the list, so no fingerprint can close it.
function fencedBlock(lines) {
  const longestRun = lines
    .flatMap((line) => line.match(/`+/g) ?? [])
    .reduce((longest, run) => Math.max(longest, run.length), 0);
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return [`${fence}text`, ...lines, fence];
}

function fingerprintList(fingerprints, limit) {
  const shown = fingerprints.slice(0, limit).map(renderFingerprint);
  const hidden = fingerprints.length - shown.length;
  return [
    ...fencedBlock(shown),
    ...(hidden > 0 ? ["", `${hidden} more not shown here; the job log lists every fingerprint.`] : []),
  ];
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// Clean only for a scan step that passed with an empty report. A missing,
// unreadable or possibly partial report is never summarized as clean.
export function summarizeGitleaksReport(reportText, scanOutcome, limit = MAX_SUMMARY_FINGERPRINTS) {
  const heading = ["### Gitleaks fingerprints", ""];
  const scanPassed = scanOutcome === "success";
  if (reportText === undefined) {
    return {
      clean: false,
      markdown: [
        ...heading,
        "**No readable Gitleaks report**, so no fingerprints are available. See the scan step's log.",
        "",
      ].join("\n"),
    };
  }
  let report;
  try {
    report = fingerprintsFromReport(reportText);
  } catch (error) {
    return {
      clean: false,
      markdown: [
        ...heading,
        `**Unreadable Gitleaks report:** ${error instanceof Error ? error.message : String(error)}. See the scan step's log.`,
        "",
      ].join("\n"),
    };
  }
  if (report.findings === 0) {
    return {
      clean: scanPassed,
      markdown: [
        ...heading,
        scanPassed
          ? "No findings."
          : "**The scan step did not pass.** Gitleaks reported no findings, but the scan may be partial. See the scan step's log.",
        "",
      ].join("\n"),
    };
  }
  return {
    clean: false,
    markdown: [
      ...heading,
      `**${plural(report.findings, "finding")}** under ${plural(report.fingerprints.length, "fingerprint")}${
        scanPassed ? ", although the scan step passed" : ""
      }. Secret values are not shown.`,
      "",
      "Each line is `commit:file:rule:line`. Fingerprints already in `.gitleaksignore` are not reported. A fingerprint missing from the previous run's list is a new finding.",
      "",
      ...fingerprintList(report.fingerprints, limit),
      "",
    ].join("\n"),
  };
}

function parseArguments(argumentsList) {
  const options = { report: undefined, scanOutcome: undefined };
  const supported = new Map([
    ["--report", "report"],
    ["--scan-outcome", "scanOutcome"],
  ]);
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    const key = supported.get(argument);
    if (!key) throw new Error(`unknown argument: ${argument}`);
    const value = argumentsList[++index];
    if (!value) throw new Error(`${argument} requires a value`);
    options[key] = value;
  }
  if (!options.report) throw new Error("--report is required");
  if (!SCAN_OUTCOMES.includes(options.scanOutcome)) {
    throw new Error(`--scan-outcome must be one of ${SCAN_OUTCOMES.join(", ")}`);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  let reportText;
  try {
    reportText = await readFile(options.report, "utf8");
  } catch {
    reportText = undefined;
  }
  const summary = summarizeGitleaksReport(reportText, options.scanOutcome);
  const log = summarizeGitleaksReport(reportText, options.scanOutcome, Infinity);
  process.stdout.write(log.markdown);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, summary.markdown, "utf8");
  }
  if (!summary.clean) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(
      `fingerprint summary failed closed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
