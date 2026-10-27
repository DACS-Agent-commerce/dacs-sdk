import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
const modulePath = "../../scripts/registry-container-disposition.mjs";
const { registryContainerDisposition, registryAuditDriftDisposition } = await import(modulePath);
const repoRoot = resolve(import.meta.dirname, "../..");
const dispositions = [registryContainerDisposition, registryAuditDriftDisposition];
const interrupted = (failureEvidence: unknown, failedStage = "npm audit") => ({
  schema: "dacs-registry-container-acceptance/v1", complete: false, failedStage, failureClass: "network", failureEvidence,
});
const auditFixtures = join(repoRoot, "test/scripts/fixtures/npm-audit-endpoint-errors");
const installFixtures = join(repoRoot, "test/scripts/fixtures/npm-install-network-errors");

describe("interrupted network evidence admission", () => {
  it.each(readdirSync(auditFixtures).sort())("classifies captured audit endpoint error %s in both dispositions", name => {
    const text = readFileSync(join(auditFixtures, name), "utf8");
    const failureClass = ["403.json", "404.json"].includes(name) ? "functional" : "network";
    for (const disposition of dispositions) {
      expect(disposition(interrupted([text]))).toMatchObject({ exitCode: 1, failureClass });
    }
  });
  it.each(readdirSync(installFixtures).sort())("preserves captured npm install network error %s", name => {
    const text = readFileSync(join(installFixtures, name), "utf8");
    for (const disposition of dispositions) {
      expect(disposition(interrupted([text], "consumer"))).toMatchObject({ exitCode: 1, failureClass: "network" });
    }
  });
  it.each(["npm error code E403", "npm error code E404", "npm error code EJSONPARSE", "something failed",
    "npm error code EBADENGINE", "npm error code ERESOLVE", "npm error code FETCH_ERROR",
    JSON.stringify({ statusCode: 403, message: "upstream ETIMEDOUT" }),
    JSON.stringify({ statusCode: 404, message: "network timeout at: https://registry.invalid" }),
    ...["503", null, true, -1].map(statusCode => JSON.stringify({ statusCode, message: "ETIMEDOUT" })),
    JSON.stringify({ auditReportVersion: 2, message: "ETIMEDOUT" }),
    "npm error code E403\nnpm error network timeout at: https://registry.invalid",
    "npm error code EJSONPARSE\nnpm error invalid json response body at https://registry.invalid",
  ])("refuses unsupported or nonretryable network evidence %s", text => {
    for (const disposition of dispositions) {
      expect(disposition(interrupted([text]))).toMatchObject({ exitCode: 1, failureClass: "functional" });
    }
  });
  it.each(["npm error code ETIMEDOUT", "npm-audit.json: audit endpoint error: 503 Service Unavailable - POST https://registry.invalid/audit",
    "generation.log: npm error code ECONNRESET", "docker-build.log: dial tcp: lookup registry.invalid: no such host",
    "generation.log: npm error code ECONNRESET\n" + "x".repeat(4096 - 26),
    "registry ping did not succeed within 30 attempts",
  ])("preserves recognized saved stage diagnostic %s", text => {
    for (const disposition of dispositions) {
      expect(disposition(interrupted([text]))).toMatchObject({ exitCode: 1, failureClass: "network" });
    }
  });
  it.each([undefined, null, "ETIMEDOUT", [], [null], ["ETIMEDOUT", null], Array(6).fill("ETIMEDOUT"),
    ["ETIMEDOUT", ...Array(1)], ["ETIMEDOUT " + "x".repeat(8192)],
  ])("rejects malformed or oversized evidence %j", evidence => {
    for (const disposition of dispositions) {
      expect(disposition(interrupted(evidence))).toMatchObject({ exitCode: 1, failureClass: "functional" });
    }
  });
  it.each(["x", "é"])("checks the exact encoded byte and entry boundaries using %s", character => {
    const text = "ETIMEDOUT " + character.repeat((8192 - 10) / Buffer.byteLength(character));
    expect(Buffer.byteLength(text)).toBe(8192);
    for (const disposition of dispositions) {
      expect(disposition(interrupted(Array(5).fill(text))).failureClass).toBe("network");
      expect(disposition(interrupted([text + character])).failureClass).toBe("functional");
    }
  });
  it.each(["functional", "policy"])("preserves a %s interruption without network evidence", failureClass => {
    for (const disposition of dispositions) {
      expect(disposition({ ...interrupted([]), failureClass })).toMatchObject({ exitCode: 1, failureClass });
    }
  });
  it.each([
    ["integrity", "npm error code EINTEGRITY\nnpm error sha512 integrity checksum failed"],
    ["forbidden", "npm error code E403\nnpm error 403 Forbidden - GET https://registry.invalid/leaf"],
  ])("refuses a network claim when one entry is %s evidence beside retryable ones", (_label, other) => {
    for (const disposition of dispositions) {
      expect(disposition(interrupted(["npm error code ECONNRESET", other]))).toMatchObject({ exitCode: 1, failureClass: "functional" });
    }
  });
  it.each([["a string", "ETIMEDOUT"], ["an oversized list", Array(6).fill("x")]])(
    "refuses %s as the evidence of a policy interruption", (_label, evidence) => {
      for (const disposition of dispositions) {
        expect(disposition({ ...interrupted(evidence), failureClass: "policy" })).toMatchObject({ exitCode: 1, failureClass: "functional" });
      }
    });
  it("rejects unsupported claims through both CLI paths", () => {
    const root = mkdtempSync(join(tmpdir(), "dacs-network-admission-")), input = join(root, "summary.json");
    try {
      writeFileSync(input, JSON.stringify(interrupted(["npm error code E403"])));
      for (const args of [[input], ["--audit-drift", input]]) {
        const result = spawnSync(process.execPath, ["scripts/registry-container-disposition.mjs", ...args],
          { cwd: repoRoot, encoding: "utf8" });
        expect(result.status).toBe(1); expect(result.stderr).toContain("functional failure");
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
