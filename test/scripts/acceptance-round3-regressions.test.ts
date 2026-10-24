import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
const modulePath = "../../scripts/registry-container-disposition.mjs";
const { registryContainerDisposition, registryAuditDriftDisposition } = await import(modulePath);
const roots: string[] = [];
const scratch = () => { const root = mkdtempSync(join(tmpdir(), "dacs-round3-")); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const cli = (...args: string[]) => spawnSync(process.execPath, ["scripts/registry-container-disposition.mjs", ...args], { encoding: "utf8" });
const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
const audit = (isDirect: unknown) => ({ metadata: { vulnerabilities: { ...counts, high: 1, total: 1 } },
  vulnerabilities: { fixture: { severity: "high", isDirect,
    via: [{ url: "https://github.com/advisories/GHSA-23hp-3jrh-7fpw", severity: "high" }] } } });
describe("round 3 audit admission", () => {
  it.each([undefined, null, "true", 0])("refuses incomplete directness %j before producing a policy", isDirect => {
    const root = scratch(), input = join(root, "audit.json"), output = join(root, "policy.json");
    writeFileSync(input, JSON.stringify(audit(isDirect)));
    expect(cli("--audit-policy", input, output).status).not.toBe(0);
    expect(existsSync(output)).toBe(false);
  });
  it.each([true, false])("preserves explicit directness %j", direct => {
    const root = scratch(), input = join(root, "audit.json"), output = join(root, "policy.json");
    writeFileSync(input, JSON.stringify(audit(direct))); expect(cli("--audit-policy", input, output).status).toBe(0);
    expect(JSON.parse(readFileSync(output, "utf8")).directAdvisories).toEqual(direct ? ["GHSA-23hp-3jrh-7fpw"] : []);
  });
  it.each(["--audit-policy", "--policy-findings"])("invalidates saved %s success after a failed repeat", mode => {
    const root = scratch(), input = mode === "--audit-policy" ? join(root, "audit.json") : root, output = join(root, "policy.json");
    if (mode === "--audit-policy") writeFileSync(input, JSON.stringify({ metadata: { vulnerabilities: counts }, vulnerabilities: {} }));
    expect(cli(mode, input, output).status).toBe(0);
    if (mode === "--audit-policy") writeFileSync(input, readFileSync("test/scripts/fixtures/npm-audit-endpoint-errors/503.json"));
    else writeFileSync(join(root, "dependency-policy.json"), "{");
    expect(cli(mode, input, output).status).not.toBe(0); expect(existsSync(output)).toBe(false);
  });
  it("refuses an audit output that aliases its input without deleting evidence", () => {
    const root = scratch(), input = join(root, "audit.json"), bytes = JSON.stringify(audit(false));
    writeFileSync(input, bytes); expect(cli("--audit-policy", input, join(root, ".", "audit.json")).status).not.toBe(0);
    expect(readFileSync(input, "utf8")).toBe(bytes);
  });
  it("preserves the original summary when recording fails after a partial write", () => {
    const root = scratch(), input = join(root, "summary.json"), preload = join(root, "failed-write.cjs");
    const bytes = JSON.stringify({ schema: "dacs-registry-container-acceptance/v1", complete: false }); writeFileSync(input, bytes);
    writeFileSync(preload, `const fs = require('node:fs'); const write = fs.writeFileSync; fs.writeFileSync = (path, ...args) => {
      if (String(path).startsWith(${JSON.stringify(input)})) { write(path, '{'); throw new Error('fixture disk full'); }
      return write(path, ...args); }; require('node:module').syncBuiltinESMExports();`);
    const result = spawnSync(process.execPath, ["--require", preload, "scripts/registry-container-disposition.mjs", "--record", input], { encoding: "utf8" });
    expect(result.stderr).toContain("fixture disk full"); expect(result.status).not.toBe(0);
    expect(readFileSync(input, "utf8")).toBe(bytes); expect(readdirSync(root).some(name => name.includes(".tmp-"))).toBe(false);
  });
});
describe("interrupted acceptance admission", () => {
  it.each([{}, { failedStage: "" }, { failedStage: "consumer" }, { failedStage: "consumer", failureEvidence: [] }])(
    "does not trust a network claim without a stage and evidence %j", fields => {
      const summary = { schema: "dacs-registry-container-acceptance/v1", complete: false, failureClass: "network", ...fields };
      for (const disposition of [registryContainerDisposition, registryAuditDriftDisposition]) {
        expect(disposition(summary)).toMatchObject({ exitCode: 1, failureClass: "functional" });
        expect(disposition(summary).message).not.toContain("undefined");
      }
    });
});
