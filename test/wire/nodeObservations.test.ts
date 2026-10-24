import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TP1_APPROVED_IDENTITY_RECORD, TP1_APPROVED_IDENTITY_RECORD_DIGESTS } from "../../src/wire/profile.js";
const dir = new URL("../../conformance/tp1-node-observations/", import.meta.url);
type Observation = { time?: string; request: { method: string }; http: number; body: unknown };
const read = (name: string): Observation => JSON.parse(readFileSync(new URL(name, dir), "utf8"));
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("observation object required");
  return value as Record<string, unknown>;
};
const body = (name: string) => { const b = read(name).body; return record(typeof b === "string" ? JSON.parse(b) : b); };
// The current reads (2026-10-20, node2's new chain) and the 2026-10-18 reads of the previous chain, kept as history.
const current: typeof import("../../conformance/tp1-node-observations/manifest-2026-10-20.json") = JSON.parse(readFileSync(new URL("manifest-2026-10-20.json", dir), "utf8"));
const history: typeof import("../../conformance/tp1-node-observations/manifest.json") = JSON.parse(readFileSync(new URL("manifest.json", dir), "utf8"));
const sets = [["2026-10-20", current, "-2026-10-20"], ["2026-10-18", history, ""]] as const;
const register = (): typeof import("../../conformance/tp1-register.json") => JSON.parse(readFileSync(new URL("../../conformance/tp1-register.json", import.meta.url), "utf8"));
describe("pinned read-only node observations", () => {
  it.each(sets)("pins exact timestamped requests and responses and discloses unknown deployment bytes (%s)", (date, manifest, suffix) => {
    const expected = ["block0", "block1", "genesis-string-zero", "network", ...(suffix ? [] : ["missing-status", "missing-tx"])].map(name => `${name}${suffix}.json`);
    expect(Object.keys(manifest.sha256).sort()).toEqual(expected.sort());
    const manifestName = suffix ? "manifest-2026-10-20.json" : "manifest.json";
    expect(createHash("sha256").update(readFileSync(new URL(manifestName, dir))).digest("hex")).toBe(suffix
      ? "b102463552fad044837cce595af0608b5f5e481c16aee2c643e80b1a5d4851f7"
      : "82bd2aad615e0e2eb128ebffba022c0fed6b3282bc01d056237466e6125b7ca3");
    for (const [name, digest] of Object.entries(manifest.sha256)) {
      const bytes = readFileSync(new URL(name, dir));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(digest);
      expect(read(name).time ?? manifest.capturedAt).toMatch(new RegExp(`^${date}`));
      expect(read(name).request.method).toBe("nodeCall");
    }
    expect(manifest.capturedAt).toBe(date);
    const version = record(record(body(`network${suffix}.json`).response).nodeVersion);
    expect(version).toMatchObject({
      version: manifest.version,
      commit: manifest.sourceCommit,
      branch: manifest.branch,
      dirty: manifest.dirty,
      builtAt: manifest.builtAt,
    });
    expect(version.dirty).toBe(true);
    expect(manifest.format).toBe("dacs-node-read-observations/v1");
    expect(manifest.deploymentArtifactDigest).toBeNull();
    expect(manifest.deploymentOverlay).toBeNull();
    expect(manifest.executionFailedTransaction.observed).toBe(false);
  });
  it("the approved record names the chain node2 reported on 2026-10-20; the 2026-10-18 chain is history and not approved", () => {
    const chain = TP1_APPROVED_IDENTITY_RECORD.chainIdentity;
    expect(chain).toBe("d59b54c2f70305e03d3a7e4d469f38295ffe4e4a62cb59b9f887057d0e5ca4bc");
    expect(record(record(body("block1-2026-10-20.json").response).content).previousHash).toBe(chain);
    expect(record(body("block1-2026-10-20.json").response).status).toBe("confirmed");
    expect(body("genesis-string-zero-2026-10-20.json").response).toEqual({ number: 0, hash: chain });
    expect(current.chainIdentity).toBe(chain);
    expect(current.sourceCommit).toBe("11e7c8207732e25035de5a04cab25c5346046493");
    const previous = record(record(body("block1.json").response).content).previousHash;
    expect(previous).toBe("83082fbb733d76475a33a9f52fe3700d667a976c2d46bef33a149f47057f7dd4");
    expect(previous).not.toBe(chain);
    expect(current.history.manifest).toBe("manifest.json");
    const r = register();
    expect(r.nodeObservationEvidence).toMatchObject({ manifest: "conformance/tp1-node-observations/manifest-2026-10-20.json", sourceCommit: current.sourceCommit, deploymentQualified: false });
    expect(r.nodeObservationEvidence.reason).toContain("inspection baseline only");
    expect(r.nodeObservationEvidence.history).toEqual([expect.objectContaining({ manifest: "conformance/tp1-node-observations/manifest.json", sourceCommit: history.sourceCommit, chainIdentity: previous })]);
    expect(r.network.previousRecords).toEqual([expect.objectContaining({ chainIdentity: previous, canonicalDigest: "c4e63ad6a75207c57c9342ed2c4fe38619c2b7cba17610753fbad2d5b4cc3cbd" })]);
    const previousRecord = r.network.previousRecords[0];
    if (!previousRecord) throw new Error("previous identity record required");
    expect(TP1_APPROVED_IDENTITY_RECORD_DIGESTS).not.toContain(previousRecord.canonicalDigest);
    const doc = readFileSync(new URL("../../docs/testnet-profile-tp1.md", import.meta.url), "utf8");
    expect(doc).toContain("Node inspection baseline: `kynesyslabs/node` commit\n`11e7c8207732e25035de5a04cab25c5346046493`");
    expect(doc).toContain("so this commit is an inspection baseline only");
  });
  it("keeps deployment qualification open and separates source inspection from observed execution", () => {
    const r = register();
    expect(r.nodeObservationEvidence.deploymentQualified).toBe(false);
    for (const manifest of [current, history]) {
      expect(manifest.qualification).toContain("not a reproducible or qualified node build");
      expect(manifest.executionFailedTransaction.sourceInference).toContain("execution failures are not recorded and surface as unknown");
      expect(manifest.executionFailedTransaction.sourceInference).toContain("not evidence");
    }
    const l2 = r.rows.find((row) => row.id === "L2");
    if (!l2) throw new Error("L2 observation row required");
    expect(l2.summary).toContain("source inference");
    expect(l2.summary).toContain("executable bytes are unqualified");
  });
  it.each(sets)("distinguishes numeric-zero RPC refusal from string-zero genesis availability (%s)", (_date, _manifest, suffix) => {
    expect(read(`block0${suffix}.json`).http).toBe(200);
    expect(body(`block0${suffix}.json`).result).toBe(400);
    const genesis = record(body(`genesis-string-zero${suffix}.json`).response);
    expect(genesis.number).toBe(0);
    expect(genesis.hash).toBe(record(record(body(`block1${suffix}.json`).response).content).previousHash);
  });
  it("records missing-transaction refusal and missing status unknown (2026-10-18)", () => {
    expect(body("missing-status.json").response).toEqual({ state: "unknown" });
    expect(body("missing-tx.json").result).toBe(400);
  });
});
