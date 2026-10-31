import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
const modulePath = "../../scripts/registry-container-disposition.mjs";
const { classifyAcceptanceFailure } = await import(modulePath);
const ioModulePath = "../../scripts/acceptance-evidence-io.mjs";
const { EVIDENCE_MAX_BYTES, EVIDENCE_MAX_LINE_BYTES, EVIDENCE_MAX_LINES, atomicWriteJson, boundedEvidenceText, evidenceLines,
  readEvidence, readRequiredEvidence } = await import(ioModulePath);
const repoRoot = resolve(import.meta.dirname, "../..");
const fixture = (name: string) => readFileSync(join(repoRoot, "test/scripts/fixtures/acceptance-transport", name), "utf8");
const cli = (...args: string[]) => spawnSync(process.execPath, ["scripts/registry-container-disposition.mjs", ...args],
  { cwd: repoRoot, encoding: "utf8" });
const emptyAudit = { auditReportVersion: 2, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } }, vulnerabilities: {} };
const emptyLock = { lockfileVersion: 3, packages: { "": { name: "consumer", version: "1.0.0" } } };
// Reads a stage's own log by name, as the CLI does; every other source is missing.
const stageLog = (stage: string, text: string) => (name: string) =>
  name === (stage === "consumer" ? "generation.log" : "registry.log") ? text : undefined;
const roots: string[] = [];
const scratchRoot = (prefix: string) => { const root = mkdtempSync(join(tmpdir(), prefix)); roots.push(root); return root; };
const temporaryFiles = (root: string) => readdirSync(root).filter(name => name.includes(".tmp-"));
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("acceptance evidence I/O", () => {
  it.each(["--audit-policy", "--policy-findings"])("invalidates a prior successful %s result before a failed repeat", mode => {
    const root = scratchRoot("dacs-repeat-");
    const audit = join(root, "audit.json"), lock = join(root, "lock.json"), output = join(root, "output.json");
    writeFileSync(audit, JSON.stringify(emptyAudit)); writeFileSync(lock, JSON.stringify(emptyLock));
    const args = mode === "--audit-policy" ? [audit, lock, output] : [root, output];
    expect(cli(mode, ...args).status).toBe(0); expect(existsSync(output)).toBe(true);
    // An audit that is not JSON, or a policy source over the evidence byte limit.
    const bad = mode === "--audit-policy" ? audit : join(root, "dependency-policy.json");
    writeFileSync(bad, "{"); if (mode === "--policy-findings") truncateSync(bad, 17 * 1024 * 1024);
    for (let repeat = 0; repeat < 2; repeat++) {
      expect(cli(mode, ...args).status).not.toBe(0);
      expect(existsSync(output)).toBe(false); expect(temporaryFiles(root)).toEqual([]);
    }
  });
  it("bounds encoded file reads before JSON decoding and invalidates prior success", () => {
    const root = scratchRoot("dacs-large-evidence-");
    const input = join(root, "audit.json"), lock = join(root, "lock.json"), output = join(root, "output.json");
    writeFileSync(lock, JSON.stringify(emptyLock));
    writeFileSync(input, JSON.stringify(emptyAudit)); expect(cli("--audit-policy", input, lock, output).status).toBe(0);
    truncateSync(input, 17 * 1024 * 1024);
    const result = cli("--audit-policy", input, lock, output);
    expect(result.status).not.toBe(0); expect(result.stderr).toContain("evidence byte limit"); expect(existsSync(output)).toBe(false);
  });
  // Review C-2/D-1: a missing input reported `"undefined" is not valid JSON`, losing the not-found cause.
  it.each(["--audit-policy", "summary"])("names a missing required %s input, exits nonzero and leaves no stale output", mode => {
    const root = scratchRoot("dacs-missing-evidence-");
    const missing = join(root, "missing.json"), output = join(root, "output.json");
    writeFileSync(join(root, "lock.json"), JSON.stringify(emptyLock)); writeFileSync(output, "{}");
    const result = mode === "--audit-policy" ? cli(mode, missing, join(root, "lock.json"), output) : cli(missing);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`ENOENT: evidence file missing: ${missing}`);
    expect(result.stderr).not.toContain("is not valid JSON");
    if (mode === "--audit-policy") expect(existsSync(output)).toBe(false);
  });
  it("refuses an audit that is not valid UTF-8 and invalidates prior success", () => {
    const root = scratchRoot("dacs-utf8-evidence-");
    const input = join(root, "audit.json"), lock = join(root, "lock.json"), output = join(root, "output.json");
    writeFileSync(lock, JSON.stringify(emptyLock));
    writeFileSync(input, JSON.stringify(emptyAudit)); expect(cli("--audit-policy", input, lock, output).status).toBe(0);
    writeFileSync(input, Buffer.concat([Buffer.from('{"auditReportVersion":2,"x":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}')]));
    const result = cli("--audit-policy", input, lock, output);
    expect(result.status).not.toBe(0); expect(result.stderr).toContain("evidence is not valid UTF-8"); expect(existsSync(output)).toBe(false);
  });
  it.each(["npm error ECONNRESET " + "x".repeat(8192), "\n".repeat(100001)])("fails classification on oversized lines or line counts", text => {
    expect(classifyAcceptanceFailure({ stage: "consumer", read: stageLog("consumer", text) })).toMatchObject({ failureClass: "functional", evidence: [expect.stringContaining("evidence")] });
  });
  it("writes a bounded failed classification for an oversized file", () => {
    const root = scratchRoot("dacs-failure-evidence-");
    const log = join(root, "generation.log"); writeFileSync(log, ""); truncateSync(log, 17 * 1024 * 1024);
    expect(cli("--failure-summary", root, "consumer", "1").status).toBe(0);
    const summary = JSON.parse(readFileSync(join(root, "acceptance-summary.json"), "utf8"));
    expect(summary).toMatchObject({ complete: false, failureClass: "functional" });
    expect(JSON.stringify(summary).length).toBeLessThan(1024);
  });
  it.each(["docker-dns.txt", "git-dns.txt", "git-connect.txt"])("recognizes captured transport diagnostic %s", name => {
    const text = fixture(name);
    expect(classifyAcceptanceFailure({ stage: "registry-start", read: () => text })).toMatchObject({ failureClass: "network" });
  });
});

// Review C-3/D-4/D-8: each read, line and write boundary of the evidence module.
describe("evidence read boundaries", () => {
  const file = (bytes: Buffer | string) => { const path = join(scratchRoot("dacs-read-"), "evidence"); writeFileSync(path, bytes); return path; };
  it("returns undefined for a missing file and an empty string for an empty one", () => {
    expect(readEvidence(join(scratchRoot("dacs-read-"), "missing"))).toBeUndefined();
    expect(readEvidence(file(""))).toBe("");
  });
  it("admits exactly the byte budget and refuses one byte more", () => {
    const path = file("");
    truncateSync(path, EVIDENCE_MAX_BYTES);
    expect(readEvidence(path)).toHaveLength(EVIDENCE_MAX_BYTES);
    truncateSync(path, EVIDENCE_MAX_BYTES + 1);
    expect(() => readEvidence(path)).toThrow("evidence byte limit exceeded");
  });
  it("refuses a directory, a device and a FIFO without blocking", () => {
    expect(() => readEvidence(scratchRoot("dacs-read-"))).toThrow("evidence must be a regular file");
    expect(() => readEvidence("/dev/null")).toThrow("evidence must be a regular file");
    if (process.platform === "win32") return;
    const fifo = join(scratchRoot("dacs-read-"), "fifo");
    execFileSync("mkfifo", [fifo]);
    expect(() => readEvidence(fifo)).toThrow("evidence must be a regular file");
  });
  it("refuses invalid UTF-8 instead of substituting characters", () => {
    expect(() => readEvidence(file(Buffer.from([0x61, 0xff, 0xfe, 0x62])))).toThrow("evidence is not valid UTF-8");
    expect(readEvidence(file("é\n"))).toBe("é\n");
  });
  it("names the missing path of required evidence", () => {
    const missing = join(scratchRoot("dacs-read-"), "missing.json");
    let error: unknown;
    try { readRequiredEvidence(missing); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: "ENOENT", message: `ENOENT: evidence file missing: ${missing}` });
    expect(readRequiredEvidence(file("{}"))).toBe("{}");
  });
  it("refuses injected evidence that is not a string or is over the byte budget", () => {
    expect(boundedEvidenceText(undefined)).toBeUndefined();
    expect(() => boundedEvidenceText(Buffer.from("x"))).toThrow("evidence byte limit exceeded");
    expect(() => boundedEvidenceText("é".repeat(EVIDENCE_MAX_BYTES / 2) + "x")).toThrow("evidence byte limit exceeded");
  });
});

describe("evidence line boundaries", () => {
  it("yields no line for missing or empty text", () => {
    expect([...evidenceLines()]).toEqual([]);
    expect([...evidenceLines("")]).toEqual([]);
  });
  it.each([["ASCII", "x"], ["two-byte UTF-8", "é"]])("admits a %s line of exactly the encoded line budget", (_label, unit) => {
    const line = unit.repeat(EVIDENCE_MAX_LINE_BYTES / Buffer.byteLength(unit));
    expect([...evidenceLines(line + "\nnext")]).toEqual([line, "next"]);
    expect(() => [...evidenceLines(line + unit)]).toThrow("evidence line limit exceeded");
  });
  it.each([false, true])("admits exactly the line count with terminating newline %s", trailing => {
    const text = "x\n".repeat(EVIDENCE_MAX_LINES - 1) + "x" + (trailing ? "\n" : "");
    expect([...evidenceLines(text)]).toHaveLength(EVIDENCE_MAX_LINES);
    expect(() => [...evidenceLines(text + (trailing ? "x" : "\nx"))]).toThrow("evidence line limit exceeded");
  });
});

describe("atomic JSON writes", () => {
  it("replaces the destination and leaves no temporary file", () => {
    const root = scratchRoot("dacs-write-"), path = join(root, "result.json");
    writeFileSync(path, "old");
    atomicWriteJson(path, { ok: true });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ok: true });
    expect(temporaryFiles(root)).toEqual([]);
  });
  it("removes its temporary file when the rename fails", () => {
    const root = scratchRoot("dacs-write-"), path = join(root, "result.json");
    mkdirSync(path); writeFileSync(join(path, "occupied"), "");
    expect(() => atomicWriteJson(path, { ok: true })).toThrow();
    expect(temporaryFiles(root)).toEqual([]);
  });
  it("writes nothing when the value cannot be serialised", () => {
    const root = scratchRoot("dacs-write-"), path = join(root, "result.json");
    expect(() => atomicWriteJson(path, { count: 1n })).toThrow();
    expect(readdirSync(root)).toEqual([]);
  });
});

describe("physical diagnostic line boundaries", () => {
  it.each([false, true])("admits exactly 100000 lines with terminating newline %s", trailing => {
    const log = "npm error code ECONNRESET\n" + "x\n".repeat(99998) + "x" + (trailing ? "\n" : "");
    expect(classifyAcceptanceFailure({ stage: "consumer", read: stageLog("consumer", log) }).failureClass).toBe("network");
    expect(classifyAcceptanceFailure({ stage: "consumer", read: stageLog("consumer", log + (trailing ? "x\n" : "\nx")) }).failureClass).toBe("functional");
  });
  it.each(["docker-refused.txt", "docker-unreachable.txt"])("preserves Docker transport cause %s", name => {
    const log = fixture(name);
    for (const stage of ["registry-start", "consumer"]) {
      expect(classifyAcceptanceFailure({ stage, read: stageLog(stage, log) })).toMatchObject({ failureClass: "network", evidence: [expect.stringContaining("connect:")] });
    }
  });
});
