#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { appendFile, open } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const SCAN_OUTCOMES = ["success", "failure", "cancelled", "skipped"];
// The workflow step doesn't read a larger report, so it fails, and the report is
// reviewed with --local, which has no cap.
const MAX_REPORT_BYTES = 64 * 1024 * 1024;
// GitHub doesn't display a step summary over 1 MiB. The summary and the job log get
// the same text, whose list of findings stops at this size.
const MAX_OUTPUT_BYTES = 900 * 1024;
// Shown in place of a commit, rule or line that fails its check.
const INVALID = "(invalid)";
const COMMIT = /^[0-9a-f]{40}$/;
const RULE = /^[A-Za-z0-9._-]{1,64}$/;
const LINE = /^(?:0|[1-9][0-9]*)$/;

// The report's text, or why there is none. Nothing over maxBytes is read.
export async function readGitleaksReport(path, maxBytes = MAX_REPORT_BYTES) {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return { problem: "the report is missing" };
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return { problem: "the report is not a file" };
    if (stats.size > maxBytes) return { problem: "the report is over 64 MiB, so it was not read" };
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes) return { problem: "the report is over 64 MiB, so it was not read" };
    return { text: bytes.toString("utf8") };
  } catch {
    return { problem: "the report could not be read" };
  } finally {
    await handle.close();
  }
}

// A short digest of a fingerprint (`commit:file:rule:line`), which can contain a
// file name. It hides the file name from casual reading, but anyone who sees the
// commit, rule and line can confirm a guessed file name against it.
export function findingId(fingerprint) {
  return createHash("sha256").update(fingerprint, "utf8").digest("hex").slice(0, 16);
}

// A Gitleaks git fingerprint is `commit:file:rule:line`, and the file can contain
// colons, so the commit is read from the left and the rule and line from the right.
// The file is never shown. The commit, rule and line are shown as Gitleaks wrote
// them if they pass their checks, which bound their shape, not their source.
function checkedFields(fingerprint) {
  const first = fingerprint.indexOf(":");
  const last = fingerprint.lastIndexOf(":");
  const beforeLast = last > 0 ? fingerprint.lastIndexOf(":", last - 1) : -1;
  const shaped = first >= 0 && beforeLast > first;
  const commit = shaped ? fingerprint.slice(0, first) : "";
  const rule = shaped ? fingerprint.slice(beforeLast + 1, last) : "";
  const line = shaped ? fingerprint.slice(last + 1) : "";
  const fields = {
    commit: COMMIT.test(commit) ? commit : INVALID,
    rule: RULE.test(rule) ? rule : INVALID,
    line: LINE.test(line) && Number.isSafeInteger(Number(line)) ? line : INVALID,
  };
  return { ...fields, malformed: Object.values(fields).includes(INVALID) };
}

// Only a JSON array is a report; Gitleaks writes [] when there are no findings.
// Each finding's fingerprint is read. Its Secret, Match and Line fields, and its
// commit metadata, are never read.
export function findingsFromReport(text) {
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    throw new Error("the report is not valid JSON");
  }
  if (!Array.isArray(report)) throw new Error("the report is not a JSON array");
  const counts = new Map();
  report.forEach((finding, index) => {
    const fingerprint =
      finding !== null && typeof finding === "object" && Object.hasOwn(finding, "Fingerprint")
        ? finding.Fingerprint
        : undefined;
    if (typeof fingerprint !== "string" || fingerprint === "") {
      throw new Error(`finding ${index + 1} has no fingerprint`);
    }
    counts.set(fingerprint, (counts.get(fingerprint) ?? 0) + 1);
  });
  const entries = [...counts]
    .map(([fingerprint, findings]) => ({
      id: findingId(fingerprint),
      fingerprint,
      findings,
      ...checkedFields(fingerprint),
    }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const malformed = entries.reduce((total, entry) => total + (entry.malformed ? entry.findings : 0), 0);
  return { findings: report.length, entries, malformed };
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function unreadable(problem) {
  return [
    "### Gitleaks findings",
    "",
    `**Unreadable Gitleaks report:** ${problem}. See the scan step's log.`,
    "",
  ].join("\n");
}

function findingsMarkdown(report, scanPassed, lines, omitted) {
  return [
    "### Gitleaks findings",
    "",
    `**${plural(report.findings, "finding")}** under ${plural(report.entries.length, "ID")}: ${plural(
      report.malformed,
      "malformed finding",
    )}, ${plural(omitted, "ID")} omitted from the list below${
      scanPassed ? ", although the scan step passed" : ""
    }. File names and fingerprints are not shown.`,
    "",
    // Gitleaks exits 1 both for findings and when it stops on an error, after writing the report.
    ...(scanPassed
      ? []
      : [
          "Gitleaks fails the scan step for findings, and also when it stops on an error. If the step's log says `partial scan`, findings may be missing from this list.",
          "",
        ]),
    "Each line is `id commit rule line findings`. The commit, rule and line are shown as Gitleaks wrote them in the fingerprint (`commit:file:rule:line`); one that fails its check shows as `(invalid)`. The ID is the first 16 hex digits of the fingerprint's SHA-256, and `findings` counts the findings that share it. Compare the IDs and counts with the last run whose findings were all reviewed. The list stops at 900 KiB. To review omitted IDs, and to get the fingerprints for `.gitleaksignore`, reproduce the scan locally as `docs/public-repository-cutover.md` describes.",
    "",
    "```text",
    ...lines,
    "```",
    "",
  ].join("\n");
}

// Clean only for a scan step that passed with an empty report. A missing,
// unreadable or possibly partial report is never summarized as clean. The text
// is built only from fixed wording, counts, IDs and checked fields.
export function summarizeGitleaksReport(report, scanOutcome, maxBytes = MAX_OUTPUT_BYTES) {
  const scanPassed = scanOutcome === "success";
  if (report.problem !== undefined) return { clean: false, markdown: unreadable(report.problem) };
  let parsed;
  try {
    parsed = findingsFromReport(report.text);
  } catch (error) {
    return { clean: false, markdown: unreadable(error.message) };
  }
  if (parsed.findings === 0) {
    return {
      clean: scanPassed,
      markdown: [
        "### Gitleaks findings",
        "",
        scanPassed
          ? "No findings."
          : "**The scan step did not pass.** Gitleaks reported no findings, but the scan may be partial. See the scan step's log.",
        "",
      ].join("\n"),
    };
  }
  // Reserve room for the widest counts, then list IDs while they fit.
  let room = maxBytes - Buffer.byteLength(findingsMarkdown(parsed, scanPassed, [], parsed.entries.length));
  const lines = [];
  for (const { id, commit, rule, line, findings } of parsed.entries) {
    const text = `${id} ${commit} ${rule} ${line} ${findings}`;
    room -= Buffer.byteLength(text) + 1;
    if (room < 0) break;
    lines.push(text);
  }
  return {
    clean: false,
    markdown: findingsMarkdown(parsed, scanPassed, lines, parsed.entries.length - lines.length),
  };
}

// Printable ASCII as is; anything else as a JSON string escaped to printable
// ASCII, so that no file name can drive the terminal.
function printableFingerprint(fingerprint) {
  if (/^[\x20-\x7e]*$/.test(fingerprint) && !fingerprint.startsWith('"')) return fingerprint;
  const escaped = fingerprint.replace(
    /[^\x20-\x21\x23-\x5b\x5d-\x7e]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return `"${escaped}"`;
}

// For a local reproduction only: each distinct fingerprint, as `.gitleaksignore`
// needs it, after the ID that the workflow's summary shows for it.
export function listFingerprintsLocally(report) {
  if (report.problem !== undefined) return { ok: false, text: `Unreadable Gitleaks report: ${report.problem}.\n` };
  let parsed;
  try {
    parsed = findingsFromReport(report.text);
  } catch (error) {
    return { ok: false, text: `Unreadable Gitleaks report: ${error.message}.\n` };
  }
  return {
    ok: true,
    text: [
      `${plural(parsed.findings, "finding")} under ${plural(parsed.entries.length, "ID")}, ${plural(parsed.malformed, "malformed finding")}. Each line is the ID, then the fingerprint; a quoted fingerprint is a JSON string.`,
      ...parsed.entries.map(({ id, fingerprint }) => `${id} ${printableFingerprint(fingerprint)}`),
      "",
    ].join("\n"),
  };
}

function parseArguments(argumentsList) {
  const options = { report: undefined, scanOutcome: undefined, local: false };
  const supported = new Map([
    ["--report", "report"],
    ["--scan-outcome", "scanOutcome"],
  ]);
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--local") {
      options.local = true;
      continue;
    }
    const key = supported.get(argument);
    // Never echo an argument: everything this step prints goes to the job log.
    if (!key) throw new Error(`unknown argument ${index + 1}; expected --report, --scan-outcome or --local`);
    const value = argumentsList[++index];
    if (!value) throw new Error(`${argument} requires a value`);
    options[key] = value;
  }
  if (!options.report) throw new Error("--report is required");
  if (options.local) {
    if (options.scanOutcome !== undefined) throw new Error("--local takes no --scan-outcome");
  } else if (!SCAN_OUTCOMES.includes(options.scanOutcome)) {
    throw new Error(`--scan-outcome must be one of ${SCAN_OUTCOMES.join(", ")}`);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.local && process.env.GITHUB_ACTIONS === "true") {
    throw new Error("--local prints raw fingerprints, which can contain secrets; it does not run in GitHub Actions");
  }
  // Only the workflow step caps the report; a local run is how an over-cap report is reviewed.
  const report = await readGitleaksReport(options.report, options.local ? Infinity : MAX_REPORT_BYTES);
  if (options.local) {
    const listing = listFingerprintsLocally(report);
    process.stdout.write(listing.text);
    if (!listing.ok) process.exitCode = 1;
    return;
  }
  const summary = summarizeGitleaksReport(report, options.scanOutcome);
  // The runner ignores workflow commands until it sees the random token again. The
  // resume line is written even if writing the text fails, after a newline, so that
  // it starts a line even if only part of the text was written.
  const token = randomUUID();
  process.stdout.write(`::stop-commands::${token}\n`);
  try {
    process.stdout.write(summary.markdown);
  } finally {
    process.stdout.write(`\n::${token}::\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, summary.markdown, "utf8");
  }
  if (!summary.clean) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    // A system error's message names a path, so print only its code.
    const reason =
      typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
        ? error.code
        : error instanceof Error
          ? error.message
          : "unexpected error";
    process.stderr.write(`fingerprint summary failed closed: ${reason}\n`);
    process.exitCode = 1;
  });
}
