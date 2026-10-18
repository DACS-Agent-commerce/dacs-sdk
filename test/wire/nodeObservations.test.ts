import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
const dir = new URL("../../conformance/tp1-node-observations/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", dir), "utf8"));
const read = (name: string) => JSON.parse(readFileSync(new URL(name, dir), "utf8"));
const body = (name: string) => { const b = read(name).body; return typeof b === "string" ? JSON.parse(b) : b; };
describe("pinned read-only node observations", () => {
  it("pins exact timestamped requests and responses and discloses unknown deployment bytes", () => {
    for (const [name, digest] of Object.entries(manifest.sha256)) {
      const bytes = readFileSync(new URL(name, dir));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(digest);
      expect(read(name).time ?? manifest.capturedAt).toMatch(/^2026-10-18/);
      expect(read(name).request.method).toBe("nodeCall");
    }
    const version = body("network.json").response.nodeVersion;
    expect(version.commit).toBe(manifest.sourceCommit);
    expect(version.dirty).toBe(true);
    expect(manifest.deploymentArtifactDigest).toBeNull();
    expect(manifest.deploymentOverlay).toBeNull();
    expect(manifest.executionFailedTransaction.observed).toBe(false);
  });
  it("distinguishes numeric-zero RPC refusal from string-zero genesis availability", () => {
    expect(read("block0.json").http).toBe(200);
    expect(body("block0.json").result).toBe(400);
    const genesis = body("genesis-string-zero.json").response;
    expect(genesis.number).toBe(0);
    expect(genesis.hash).toBe(body("block1.json").response.content.previousHash);
    expect(body("missing-status.json").response).toEqual({ state: "unknown" });
    expect(body("missing-tx.json").result).toBe(400);
  });
  it("names the verifier-issued session challenge rule SN-1 in the register", () => {
    const register = JSON.parse(readFileSync(new URL("../../conformance/tp1-register.json", import.meta.url), "utf8"));
    expect(register.rows.find((r: any) => r.id === "G2").summary).toContain("SN-1");
    expect(register.rows.find((r: any) => r.id === "G2").summary).not.toContain("JID-1");
  });
});
