import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const modulePath = "../../scripts/registry-container-disposition.mjs";
const { classifyAcceptanceFailure } = await import(modulePath);
const cli = (...args: string[]) => spawnSync(process.execPath, ["scripts/registry-container-disposition.mjs", ...args], { encoding: "utf8" });
const emptyAudit = { auditReportVersion: 2, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } }, vulnerabilities: {} };
const emptyLock = { lockfileVersion: 3, packages: { "": { name: "consumer", version: "1.0.0" } } };
describe("acceptance evidence I/O", () => {
  it.each(["--audit-policy", "--policy-findings"])("invalidates a prior successful %s result before a failed repeat", mode => {
    const root = mkdtempSync(join(tmpdir(), "dacs-repeat-"));
    try {
      const audit = join(root, "audit.json"), lock = join(root, "lock.json"), output = join(root, "output.json");
      writeFileSync(audit, JSON.stringify(emptyAudit)); writeFileSync(lock, JSON.stringify(emptyLock));
      const args = mode === "--audit-policy" ? [audit, lock, output] : [root, output];
      expect(cli(mode, ...args).status).toBe(0); expect(existsSync(output)).toBe(true);
      // An audit that is not JSON, or a policy source over the evidence byte limit.
      const bad = mode === "--audit-policy" ? audit : join(root, "dependency-policy.json");
      writeFileSync(bad, "{"); if (mode === "--policy-findings") truncateSync(bad, 17 * 1024 * 1024);
      expect(cli(mode, ...args).status).not.toBe(0);
      expect(existsSync(output)).toBe(false); expect(readdirSync(root).some(name => name.includes(".tmp-"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("bounds encoded file reads before JSON decoding and invalidates prior success", () => {
    const root = mkdtempSync(join(tmpdir(), "dacs-large-evidence-"));
    try {
      const input = join(root, "audit.json"), lock = join(root, "lock.json"), output = join(root, "output.json");
      writeFileSync(lock, JSON.stringify(emptyLock));
      writeFileSync(input, JSON.stringify(emptyAudit)); expect(cli("--audit-policy", input, lock, output).status).toBe(0);
      truncateSync(input, 17 * 1024 * 1024);
      const result = cli("--audit-policy", input, lock, output);
      expect(result.status).not.toBe(0); expect(result.stderr).toContain("evidence byte limit"); expect(existsSync(output)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.each(["npm error ECONNRESET " + "x".repeat(8192), "\n".repeat(100001)])("fails classification on oversized lines or line counts", text => {
    expect(classifyAcceptanceFailure({ stage: "consumer", read: () => text })).toMatchObject({ failureClass: "functional", evidence: [expect.stringContaining("evidence")] });
  });
  it("writes a bounded failed classification for an oversized file", () => {
    const root = mkdtempSync(join(tmpdir(), "dacs-failure-evidence-"));
    try {
      const log = join(root, "generation.log"); writeFileSync(log, ""); truncateSync(log, 17 * 1024 * 1024);
      expect(cli("--failure-summary", root, "consumer", "1").status).toBe(0);
      const summary = JSON.parse(readFileSync(join(root, "acceptance-summary.json"), "utf8"));
      expect(summary).toMatchObject({ complete: false, failureClass: "functional" });
      expect(JSON.stringify(summary).length).toBeLessThan(1024);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.each(["docker-dns.txt", "git-dns.txt", "git-connect.txt"])("recognizes captured transport diagnostic %s", name => {
    const text = readFileSync(join("test/scripts/fixtures/acceptance-transport", name), "utf8");
    expect(classifyAcceptanceFailure({ stage: "registry-start", read: () => text })).toMatchObject({ failureClass: "network" });
  });
});

describe("physical diagnostic line boundaries", () => {
  it.each([false, true])("admits exactly 100000 lines with terminating newline %s", trailing => {
    const log = "npm error code ECONNRESET\n" + "x\n".repeat(99998) + "x" + (trailing ? "\n" : "");
    expect(classifyAcceptanceFailure({ stage: "consumer", read: () => log }).failureClass).toBe("network");
    expect(classifyAcceptanceFailure({ stage: "consumer", read: () => log + (trailing ? "x\n" : "\nx") }).failureClass).toBe("functional");
  });
  it.each(["docker-refused.txt", "docker-unreachable.txt"])("preserves Docker transport cause %s", name => {
    const log = readFileSync(join("test/scripts/fixtures/acceptance-transport", name), "utf8");
    for (const stage of ["registry-start", "consumer"]) {
      expect(classifyAcceptanceFailure({ stage, read: () => log })).toMatchObject({ failureClass: "network", evidence: [expect.stringContaining("connect:")] });
    }
  });
});
