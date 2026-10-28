import { describe, expect, test, vi } from "vitest";

import {
  validateSettlementEvidenceStructure,
  verifySettlementEvidence,
  type AuthenticatedEvidenceContext,
} from "../../src/agent/verifySettlementEvidence.js";
import { contentHash, stripSignature } from "../../src/canonical/index.js";
import { ARTIFACT_SEPARATORS } from "../../src/artifacts/registry.js";
import {
  ed25519Sign, ed25519Verify, privateKeyFromSeed, publicKeyFromRaw,
  publicKeyFromSeed, rawPublicKey, signedBytes,
} from "../../src/crypto/index.js";

const JOB = "01JZ000000000000000000036K";
const RAW_JOB = "01JZ000000000000000000036\u212a";
const ORCHESTRATOR = "did:demos:orchestrator";
const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const privateKey = privateKeyFromSeed(seed);
const publicKey = rawPublicKey(publicKeyFromSeed(seed));

function fixture() {
  const evidence = {
    evidenceVersion: "1",
    jobId: JOB,
    phase: "pay-evm-erc20",
    outcome: "success",
    observedAt: 1_700_000_000_000,
    paymentAmount: { amount: "5", currency: "USDC" },
    paymentTxRefs: [{ kind: "evm" as const, chainId: 80002, txHash: "0xsettled" }],
    settlementFinality: { model: "block-depth", finalityObservedAt: 1_700_000_000_000 },
    signature: { algorithm: "ed25519", signer: ORCHESTRATOR, value: "" },
  };
  evidence.signature.value = Buffer.from(ed25519Sign(
    signedBytes(ARTIFACT_SEPARATORS.SettlementEvidence, contentHash(stripSignature(evidence))),
    privateKey,
  )).toString("base64url");
  const context: AuthenticatedEvidenceContext = {
    orchestrator: ORCHESTRATOR,
    agreement: { amount: "5", currency: "USDC" },
    rail: {
      railId: "usdc", railType: "evm-erc20", asset: "USDC",
      network: "eip155:80002", handler: "pay-evm-erc20",
    },
    paymentAddress: { railId: "usdc", phaseIndex: 0 },
    attestationRef: {
      anchor: { kind: "storage-program", locator: `dacs4:payment:${JOB}:usdc:0` },
      contentHash: contentHash(stripSignature(evidence)),
    },
    result: { ok: true, txRefs: evidence.paymentTxRefs },
  };
  const deps = {
    resolvePublicKey: vi.fn(async () => publicKey),
    verify: vi.fn((bytes: Uint8Array, signature: Uint8Array, key: Uint8Array) =>
      ed25519Verify(bytes, signature, publicKeyFromRaw(key))),
  };
  return { evidence, context, deps };
}

describe("current evidence raw job-ID admission", () => {
  test("accepts the canonical ASCII spelling with a real signature", async () => {
    const { evidence, context, deps } = fixture();
    expect(await validateSettlementEvidenceStructure(evidence)).toEqual({ decision: "valid", reasons: [] });
    expect(await verifySettlementEvidence(evidence, context, deps)).toEqual({ decision: "pass", reasons: [] });
    expect(deps.verify).toHaveBeenCalledOnce();
  });

  test("rejects a Unicode spelling before structural NFC normalization", async () => {
    const { evidence } = fixture();
    const raw = { ...evidence, jobId: RAW_JOB };
    expect(RAW_JOB).not.toBe(JOB);
    expect(RAW_JOB.normalize("NFC")).toBe(JOB);
    expect(contentHash(stripSignature(raw))).toBe(contentHash(stripSignature(evidence)));
    expect(await validateSettlementEvidenceStructure(raw)).toEqual({
      decision: "error", reasons: [expect.stringMatching(/canonical uppercase ULID/)],
    });
    expect(raw.jobId).toBe(RAW_JOB);
  });

  test.each([false, true])("rejects raw Unicode before key resolution or verification (frozen: %s)", async (frozen) => {
    const { evidence, context, deps } = fixture();
    const raw = { ...evidence, jobId: RAW_JOB };
    if (frozen) Object.freeze(raw);
    expect(await verifySettlementEvidence(raw, context, deps)).toEqual({
      decision: "error", reasons: [expect.stringMatching(/canonical uppercase ULID/)],
    });
    expect(deps.resolvePublicKey).not.toHaveBeenCalled();
    expect(deps.verify).not.toHaveBeenCalled();
  });

  test("accepts read-only canonical evidence without changing its spelling", async () => {
    const { evidence, context, deps } = fixture();
    Object.freeze(evidence);
    expect((await verifySettlementEvidence(evidence, context, deps)).decision).toBe("pass");
    expect(evidence.jobId).toBe(JOB);
  });

  test.each(["accessor", "proxy"])("rejects %s evidence without invoking caller code", async (kind) => {
    const { evidence, context, deps } = fixture();
    const read = vi.fn(() => JOB);
    const raw = kind === "accessor"
      ? Object.defineProperty(evidence, "jobId", { enumerable: true, get: read })
      : new Proxy(evidence, { get: read });
    expect((await validateSettlementEvidenceStructure(raw)).decision).toBe("error");
    expect((await verifySettlementEvidence(raw, context, deps)).decision).toBe("error");
    expect(read).not.toHaveBeenCalled();
    expect(deps.resolvePublicKey).not.toHaveBeenCalled();
    expect(deps.verify).not.toHaveBeenCalled();
  });
});
