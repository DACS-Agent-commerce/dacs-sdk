import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { contentHash } from "../../src/canonical/index.js";
import { bundleAddress, storAddress } from "../../src/canonical/addressing.js";

const CONF = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../vendor/DACS-Standard/conformance",
);
const haveVectors = existsSync(join(CONF, "vectors/golden.json"));
const read = (p: string) => JSON.parse(readFileSync(join(CONF, p), "utf8"));

/**
 * Drives the SDK against the §14 golden vectors — the normative oracle. These
 * assert the SDK reproduces the spec's byte-stable artifact hashes and the
 * hash-based address derivation. The artifact *shapes* are taken from the spec
 * fixtures; the point is that the SDK's canonical-form + hashing + addressing
 * primitives agree with the reference implementation byte-for-byte.
 */
describe("§14 golden vectors — content hashes + addressing", () => {
  if (!haveVectors) {
    it.skip("vectors not synced — run `npm run conformance:sync`", () => {});
    return;
  }
  const golden = read("vectors/golden.json");

  it("AttestationBundle hash matches golden (signed scope omits signatures + anchoredByRole, §10.4.1)", () => {
    const bundle = read("fixtures/attestation-bundle-0004.json");
    const scope = { ...bundle };
    delete scope.signatures;
    delete scope.anchoredByRole;
    expect(contentHash(scope)).toBe(golden.bundle.bundleHash);
  });

  it("SettlementEvidence hash matches golden (signed scope omits signature)", () => {
    const ev = read("fixtures/settlement-evidence-payment-success.json").evidence;
    expect(contentHash(ev)).toBe(golden.settlement.evidenceHash);
  });

  it("role-specific bundle address derivation (§10.4.3)", () => {
    const jobId = golden.bundle.jobId;
    const expected =
      "stor-" +
      createHash("sha256").update(`${jobId}-bundle-buyer`).digest("hex");
    expect(bundleAddress(jobId, "buyer")).toBe(expected);
    expect(storAddress("seed")).toBe(
      "stor-" + createHash("sha256").update("seed").digest("hex"),
    );
  });
});
