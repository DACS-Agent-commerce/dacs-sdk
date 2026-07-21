import { describe, expect, test } from "vitest";

import { bundleConsistency } from "../../src/agent/bundleConsistency.js";
import { verifyBundleCopy, type BundleCopyDeps } from "../../src/agent/bundleCopyValidity.js";
import { ARTIFACT_SEPARATORS } from "../../src/artifacts/registry.js";
import { contentHash, sha256Hex } from "../../src/canonical/index.js";
import {
  ed25519Sign,
  ed25519Verify,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  rawPublicKey,
  signedBytes,
} from "../../src/crypto/index.js";

/** Two parties with real ed25519 keys. */
function party(seedByte: number) {
  const seed = Uint8Array.from(Buffer.alloc(32, seedByte));
  const priv = privateKeyFromSeed(seed);
  const raw = rawPublicKey(publicKeyFromSeed(seed));
  const hex = Buffer.from(raw).toString("hex");
  return { priv, raw, did: `did:demos:agent:${hex}` };
}
const BUYER = party(11);
const SELLER = party(22);

const deps: BundleCopyDeps = {
  resolvePublicKey: async (did) => {
    const hex = did.match(/([0-9a-fA-F]{64})$/)?.[1];
    return hex ? Uint8Array.from(Buffer.from(hex, "hex")) : null;
  },
  verify: (bytes, sig, pub) => ed25519Verify(bytes, sig, publicKeyFromRaw(pub)),
};

/** A structurally valid DACS-5 bundle body. */
function body(over: Record<string, unknown> = {}) {
  return {
    bundleVersion: "1",
    jobId: "job-1",
    outcome: "completed",
    listingRef: { listingId: "svc", version: 1, contentHash: sha256Hex("listing") },
    agreementRef: { kind: "dacs-3-agreement", id: "agreement-job-1", contentHash: sha256Hex("agr") },
    parties: [
      { role: "buyer", bundleHash: sha256Hex(BUYER.did), primaryClaim: BUYER.did },
      { role: "seller", bundleHash: sha256Hex(SELLER.did), primaryClaim: SELLER.did },
    ],
    phaseSummary: [
      {
        index: 0,
        kind: "settle",
        outcome: "ok",
        attestationRef: { kind: "dacs-4-evidence", id: "e", contentHash: sha256Hex("e") },
      },
    ],
    vetRecords: [],
    settlementEvidence: [
      { kind: "dacs-4-evidence", id: "e", contentHash: sha256Hex("e") },
    ],
    recipeRegistryVersion: 1,
    railRegistryVersion: 1,
    finalisedAt: 1780000000000,
    ...over,
  };
}

/** Sign a bundle body over the §10.4.1 scope (omits signatures + anchoredByRole). */
function sign(
  bodyObj: Record<string, unknown>,
  signers: Array<{ priv: ReturnType<typeof privateKeyFromSeed>; did: string }>,
  anchoredByRole: string,
): Record<string, unknown> {
  const scope = { ...bodyObj };
  delete scope["signatures"];
  delete scope["anchoredByRole"];
  const message = signedBytes(ARTIFACT_SEPARATORS.AttestationBundle, contentHash(scope));
  return {
    ...bodyObj,
    anchoredByRole,
    signatures: signers.map((s) => ({
      party: s.did,
      algorithm: "ed25519",
      value: Buffer.from(ed25519Sign(message, s.priv)).toString("base64url"),
    })),
  };
}

describe("verifyBundleCopy (§10.4.3(b) copy validity)", () => {
  test("a FULLY SIGNED copy at its own role address is valid", async () => {
    const copy = sign(body(), [BUYER, SELLER], "buyer");
    const r = await verifyBundleCopy(copy, "buyer", deps);
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(r.fullySigned).toBe(true);
      expect(r.signers.sort()).toEqual([BUYER.did, SELLER.did].sort());
    }
  });

  test("a SINGLE-SIGNED ABORT copy stands (§10.11 suppression)", async () => {
    const copy = sign(body({ outcome: "aborted" }), [BUYER], "buyer");
    const r = await verifyBundleCopy(copy, "buyer", deps);
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(r.fullySigned).toBe(false);
      expect(r.abortStanding).toBe(true);
    }
  });

  test("a SINGLE-SIGNED NON-ABORT copy is REJECTED (§10.4.1)", async () => {
    const copy = sign(body({ outcome: "completed" }), [BUYER], "buyer");
    const r = await verifyBundleCopy(copy, "buyer", deps);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toMatch(/single-signed/);
  });

  test("WRONG ANCHOR ROLE is rejected (a buyer copy at the seller address)", async () => {
    const copy = sign(body(), [BUYER, SELLER], "buyer");
    const r = await verifyBundleCopy(copy, "seller", deps);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toMatch(/anchoredByRole/);
  });

  test("an INVALID SIGNATURE taints the copy", async () => {
    const copy = sign(body(), [BUYER, SELLER], "buyer");
    // Tamper with the signed scope AFTER signing — the signatures no longer verify.
    const tampered = { ...copy, outcome: "failed-counterparty" };
    const r = await verifyBundleCopy(tampered, "buyer", deps);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toMatch(/failed verification/);
  });

  test("a copy with no signatures at all is rejected", async () => {
    const r = await verifyBundleCopy({ ...body(), anchoredByRole: "buyer" }, "buyer", deps);
    expect(r.valid).toBe(false);
  });
});

describe("bundleConsistency wired to the async validator (no fail-open)", () => {
  const isValid = async (b: Record<string, unknown>, role: "buyer" | "seller") =>
    (await verifyBundleCopy(b, role, deps)).valid;

  test("two fully-signed agreeing copies ⇒ unified", async () => {
    const b = sign(body(), [BUYER, SELLER], "buyer");
    const s = sign(body(), [BUYER, SELLER], "seller");
    expect(await bundleConsistency({ buyer: b, seller: s }, { isValid })).toBe("unified");
  });

  test("two fully-signed contradicting copies ⇒ divergent", async () => {
    const b = sign(body({ outcome: "completed" }), [BUYER, SELLER], "buyer");
    const s = sign(body({ outcome: "failed-counterparty" }), [BUYER, SELLER], "seller");
    expect(await bundleConsistency({ buyer: b, seller: s }, { isValid })).toBe("divergent");
  });

  test("REGRESSION: an async gate that rejects actually drops the copy (a Promise is truthy)", async () => {
    // Pre-fix, `isValid` was sync — handed this async callback the returned
    // Promise was truthy, so BOTH invalid copies were accepted and the verdict
    // came back `divergent`. It must be `absent`.
    const b = sign(body({ outcome: "completed" }), [BUYER], "buyer"); // single-signed non-abort → invalid
    const s = sign(body({ outcome: "failed-counterparty" }), [SELLER], "seller"); // ditto
    expect(await bundleConsistency({ buyer: b, seller: s }, { isValid })).toBe("absent");
  });

  test("a single-signed abort copy alone ⇒ oneSided (suppression arm survives the gate)", async () => {
    const b = sign(body({ outcome: "aborted" }), [BUYER], "buyer");
    expect(await bundleConsistency({ buyer: b }, { isValid })).toBe("oneSided");
  });

  test("a copy at the wrong role address is dropped ⇒ oneSided, not divergent", async () => {
    const b = sign(body({ outcome: "completed" }), [BUYER, SELLER], "buyer");
    // The seller slot holds a copy anchored by the BUYER → invalid there.
    const wrong = sign(body({ outcome: "failed-counterparty" }), [BUYER, SELLER], "buyer");
    expect(await bundleConsistency({ buyer: b, seller: wrong }, { isValid })).toBe("oneSided");
  });
});
