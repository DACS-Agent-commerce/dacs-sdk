import { describe, expect, it, vi } from "vitest";

import type { AnchorReceipt, SettlementEvidence } from "../../src/artifacts/types.js";
import {
  canonicalize,
  contentHash,
  encodeAddressSegment,
  sha256Hex,
} from "../../src/canonical/index.js";
import {
  ed25519Sign,
  ed25519Verify,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  rawPublicKey,
} from "../../src/crypto/index.js";
import {
  verifyFinalizedSessionSettlement,
  type SessionSettlementContext,
  type SessionSettlementNativeProofRef,
  type SessionSettlementVerificationProvider,
} from "../../src/agent/sessionSettlement.js";
import {
  publishSellerSessionSettlement,
  sellerSessionSettlementPublicationEffectId,
  type SellerSessionSettlementPublicationDeps,
} from "../../src/seller/sessionSettlementPublication.js";
import {
  publishSellerSessionSettlement as rootPublishSellerSessionSettlement,
  sellerSessionSettlementPublicationEffectId as rootSettlementEffectId,
} from "../../src/index.js";
import {
  publishSellerSessionSettlement as sellerPublishSellerSessionSettlement,
  sellerSessionSettlementPublicationEffectId as sellerSettlementEffectId,
} from "../../src/seller/index.js";
import type {
  SellerFulfilmentHandoff,
  SellerPaymentAuthorization,
  SellerPaymentEvidenceInput,
  SellerReceiptClaim,
  SellerReceiptInspectionResult,
} from "../../src/seller/paymentIntake.js";

const ORCHESTRATOR = "did:demos:orchestrator";
const SEED = Uint8Array.from({ length: 32 }, (_, index) => index + 41);
const PRIVATE_KEY = privateKeyFromSeed(SEED);
const PUBLIC_KEY = rawPublicKey(publicKeyFromSeed(SEED));
const NOW = 1_777_000_000_000;
const TX_HASH = "e".repeat(64);

function authorization(jobId = "job-publication-1"): SellerPaymentAuthorization {
  const evidenceInput: SellerPaymentEvidenceInput = {
    evidenceVersion: "1" as const,
    jobId,
    phase: "pay-x402" as const,
    outcome: "success" as const,
    paymentTxRefs: [{
      kind: "x402-event" as const,
      httpResource: "https://seller.example/resource",
      paymentReceiptHash: "d".repeat(64),
      settlementTxHash: TX_HASH,
      chainId: 8453,
      logIndex: 2,
      protocolVersion: "2",
    }],
    paymentAmount: { amount: "5", currency: "USDC" },
    settlementFinality: {
      model: "block-depth" as const,
      finalityBlocks: 12,
      finalityObservedAt: NOW,
    },
    observedAt: NOW,
  };
  return {
    jobId,
    phaseIndex: 3,
    agreementHash: "a".repeat(64),
    listingRef: {
      listingId: "listing-publication-1",
      version: 2,
      contentHash: "b".repeat(64),
    },
    railId: "rail-x402-base",
    railRegistryVersion: 7,
    commitment: {
      ref: `commitment:${jobId}`,
      contentHash: "c".repeat(64),
      finalizedAt: NOW - 2_000,
    },
    settlementIdentity: {
      kind: "evm",
      chainId: 8453,
      txHash: TX_HASH,
      logIndex: 2,
      includedAt: NOW - 1_000,
    },
    settlementId: `evm:8453:${TX_HASH}:2`,
    evidenceHash: sha256Hex(canonicalize(evidenceInput)),
    evidenceInput,
    payoutBindingTier: 2,
    sessionBinding: "established",
  };
}

function claim(value: SellerPaymentAuthorization): SellerReceiptClaim {
  return {
    settlementId: value.settlementId,
    jobId: value.jobId,
    phaseIndex: value.phaseIndex,
    observedAt: value.evidenceInput.observedAt,
    evidenceHash: value.evidenceHash,
    authorization: structuredClone(value),
  };
}

function handoff(
  value: SellerPaymentAuthorization,
  signer = ORCHESTRATOR,
): SellerFulfilmentHandoff {
  return {
    handoffVersion: "1",
    fulfilmentId: `fulfilment:${value.jobId}`,
    jobId: value.jobId,
    agreementRef: `agreement:${value.jobId}`,
    agreementHash: value.agreementHash,
    commitmentRef: value.commitment.ref,
    authorizationHash: sha256Hex(canonicalize(value)),
    settlementId: value.settlementId,
    paymentEvidenceHash: value.evidenceHash,
    paymentPhaseIndex: value.phaseIndex,
    deliveryPhaseIndex: 4,
    phase: "deliver-storage-program",
    logicalAddress: `dacs4:delivery:${value.jobId}`,
    deliverableSpecHash: "f".repeat(64),
    agreementViewHash: "1".repeat(64),
    validationFloorAt: NOW,
    evidenceAuthority: { primaryClaim: signer, algorithm: "ed25519" },
    candidate: {
      status: "preparation-failed",
      validatedAt: NOW,
      reason: "fixture terminal preparation failure",
    },
  };
}

function context(value: SellerPaymentAuthorization): SessionSettlementContext {
  return {
    contextVersion: "1",
    jobId: value.jobId,
    agreementRef: {
      anchor: { kind: "storage-program", locator: `agreement:${value.jobId}` },
      contentHash: value.agreementHash,
    },
    agreementHash: value.agreementHash,
    paymentPhaseIndex: value.phaseIndex,
    orchestrator: ORCHESTRATOR,
    payer: {
      primaryClaim: "did:demos:buyer",
      payingKey: "0x1111111111111111111111111111111111111111",
    },
    payee: {
      primaryClaim: "did:demos:seller",
      receivingKey: "0x2222222222222222222222222222222222222222",
    },
    paymentAmount: structuredClone(value.evidenceInput.paymentAmount),
    rail: {
      railId: value.railId,
      railVersion: 3,
      railRegistryVersion: value.railRegistryVersion,
      descriptorHash: "9".repeat(64),
      railType: "x402",
      handler: "pay-x402",
      asset: "USDC",
      network: "eip155:8453",
      finality: { model: "block-depth", finalityBlocks: 12 },
    },
  };
}

function proof(value: SellerPaymentAuthorization) {
  return {
    proofVersion: "fixture-1",
    settlementId: value.settlementId,
    event: structuredClone(value.settlementIdentity),
  };
}

function proofRef(value: SellerPaymentAuthorization): SessionSettlementNativeProofRef {
  return {
    proofVersion: "1",
    kind: "authenticated-x402-event",
    locator: `proof:${value.jobId}:${value.phaseIndex}`,
    contentHash: sha256Hex(canonicalize(proof(value))),
    encoding: "jcs",
  };
}

function finalizedReceipt(
  logicalAddress: string,
  evidenceHash: string,
): AnchorReceipt {
  return {
    receiptVersion: "1",
    substrate: "test-sr2",
    finalityProfile: "test-final",
    logicalAddress,
    nativeAddress: `native:${logicalAddress}`,
    contentHash: evidenceHash,
    transactionRef: { kind: "test", value: `tx:${evidenceHash}` },
    writer: ORCHESTRATOR,
    state: "finalized",
    observationDisposition: "established",
    observedAt: NOW + 1,
    blockRef: { id: "block:77", height: "77", timestamp: NOW + 1 },
    evidence: { kind: "quorum", value: "proof:77" },
  };
}

interface Harness {
  authorization: SellerPaymentAuthorization;
  nativeProofRef: SessionSettlementNativeProofRef;
  anchored?: SettlementEvidence;
  inspect: ReturnType<typeof vi.fn>;
  anchor: ReturnType<typeof vi.fn>;
  deps: SellerSessionSettlementPublicationDeps;
}

function harness(): Harness {
  const value = authorization();
  const retainedClaim = claim(value);
  const retainedHandoff = handoff(value);
  const state: { anchored?: SettlementEvidence } = {};
  const inspect = vi.fn(async (): Promise<SellerReceiptInspectionResult> => ({
    status: "already-consumed",
    claim: structuredClone(retainedClaim),
    handoff: structuredClone(retainedHandoff),
  }));
  const receiptStore = { inspectPermit: inspect };
  const anchor = vi.fn(async (input: Parameters<
    SellerSessionSettlementPublicationDeps["anchorEvidence"]
  >[0]) => {
    state.anchored = structuredClone(input.evidence);
    return {
      disposition: "anchored" as const,
      evidenceRef: {
        anchor: { kind: "storage-program" as const, locator: input.logicalAddress },
        contentHash: input.evidenceHash,
        signer: ORCHESTRATOR,
      },
      anchorReceipt: finalizedReceipt(input.logicalAddress, input.evidenceHash),
    };
  });
  const deps: SellerSessionSettlementPublicationDeps = {
    receiptStore,
    evidenceSigner: {
      algorithm: "ed25519",
      signer: ORCHESTRATOR,
      sign: (bytes) => ed25519Sign(bytes, PRIVATE_KEY),
    },
    evidence: {
      resolvePublicKey: async (signer) => signer === ORCHESTRATOR ? PUBLIC_KEY : null,
      verify: (bytes, signature, publicKey) =>
        ed25519Verify(bytes, signature, publicKeyFromRaw(publicKey)),
    },
    anchorEvidence: anchor,
    verifyAnchorReceipt: async () => ({ disposition: "pass" }),
    resolveEvidence: async () => state.anchored
      ? { disposition: "present", evidence: structuredClone(state.anchored) }
      : { disposition: "absent" },
  };
  return {
    authorization: value,
    nativeProofRef: proofRef(value),
    get anchored() {
      return state.anchored;
    },
    inspect,
    anchor,
    deps,
  };
}

function request(h: Harness) {
  return {
    paymentPermitId: "permit-publication-1",
    authorization: structuredClone(h.authorization),
    nativeProofRef: structuredClone(h.nativeProofRef),
  };
}

describe("publishSellerSessionSettlement", () => {
  it("is exported from both the root and seller package surfaces", () => {
    expect(rootPublishSellerSessionSettlement).toBe(publishSellerSessionSettlement);
    expect(sellerPublishSellerSessionSettlement).toBe(publishSellerSessionSettlement);
    expect(rootSettlementEffectId).toBe(sellerSessionSettlementPublicationEffectId);
    expect(sellerSettlementEffectId).toBe(sellerSessionSettlementPublicationEffectId);
  });

  it("publishes an exact finalized settlement consumable by the public verifier", async () => {
    const h = harness();
    const result = await publishSellerSessionSettlement(request(h), h.deps);
    expect(result.disposition).toBe("published");
    if (result.disposition !== "published") return;
    expect(result.effectId).toBe(sellerSessionSettlementPublicationEffectId({
      authorization: h.authorization,
      nativeProofRef: h.nativeProofRef,
      evidenceAuthority: { primaryClaim: ORCHESTRATOR, algorithm: "ed25519" },
    }));
    expect(result.evidenceHash).toBe(h.authorization.evidenceHash);
    expect(result.settlement.nativeProofRef).toEqual(h.nativeProofRef);
    expect(result.settlement.evidence.signature.signer).toBe(ORCHESTRATOR);
    expect(result.settlement.anchorReceipt.state).toBe("finalized");
    expect(Object.isFrozen(result.settlement.evidence)).toBe(true);

    const nativeProof = proof(h.authorization);
    const provider: SessionSettlementVerificationProvider = {
      authenticateContext: () => ({ disposition: "pass" }),
      verifyEvidenceAnchor: () => ({ disposition: "pass" }),
      resolveNativeProof: () => ({ disposition: "present", artifact: nativeProof }),
      revalidateSettlement: (input) => ({
        disposition: "pass",
        outcome: "success",
        binding: {
          jobId: input.context.jobId,
          railId: input.context.rail.railId,
          phaseIndex: input.context.paymentPhaseIndex,
          settlementId: h.authorization.settlementId,
        },
        nativeObservation: {
          observationVersion: "1",
          kind: "authenticated-x402-event",
          observedAt: NOW + 2,
          finality: structuredClone(h.authorization.evidenceInput.settlementFinality),
          sessionBinding: {
            disposition: "established",
            kind: "eip3009",
            bindingHash: "8".repeat(64),
          },
          details: { chainId: 8453, logIndex: 2 },
        },
      }),
      evidence: h.deps.evidence,
    };
    const verified = await verifyFinalizedSessionSettlement(
      context(h.authorization),
      result.settlement,
      provider,
    );
    expect(verified.disposition).toBe("verified");
  });

  it("requires a consumed permit and rejects permit/authorization substitution", async () => {
    const available = harness();
    available.deps.receiptStore.inspectPermit = async () => ({
      status: "available",
      claim: claim(available.authorization),
    });
    expect(await publishSellerSessionSettlement(request(available), available.deps))
      .toMatchObject({ disposition: "rejected", reason: expect.stringContaining("not been consumed") });
    expect(available.anchor).not.toHaveBeenCalled();

    const substituted = harness();
    const other = authorization("job-substituted");
    substituted.deps.receiptStore.inspectPermit = async () => ({
      status: "already-consumed",
      claim: claim(other),
      handoff: handoff(other),
    });
    expect(await publishSellerSessionSettlement(request(substituted), substituted.deps))
      .toMatchObject({ disposition: "rejected", reason: expect.stringContaining("substituted") });
    expect(substituted.anchor).not.toHaveBeenCalled();
  });

  it("rejects a signer that differs from the consumed authenticated authority", async () => {
    const h = harness();
    h.deps.evidenceSigner = {
      ...h.deps.evidenceSigner,
      signer: "did:demos:attacker",
    };
    expect(await publishSellerSessionSettlement(request(h), h.deps)).toMatchObject({
      disposition: "rejected",
      reason: expect.stringContaining("signer"),
    });
    expect(h.anchor).not.toHaveBeenCalled();
  });

  it("fails closed when the local signer cannot produce a valid signature", async () => {
    const h = harness();
    h.deps.evidenceSigner = {
      ...h.deps.evidenceSigner,
      sign: () => Uint8Array.from([1, 2, 3]),
    };
    const result = await publishSellerSessionSettlement(request(h), h.deps);
    expect(result.disposition).not.toBe("published");
    if (result.disposition === "published") return;
    expect(result.reason).toContain("verification failed");
    expect(h.anchor).not.toHaveBeenCalled();
  });

  it.each(["included", "reorged"] as const)(
    "rejects a %s rather than finalized receipt",
    async (state) => {
      const h = harness();
      h.deps.anchorEvidence = async (input) => ({
        disposition: "anchored",
        evidenceRef: {
          anchor: { kind: "storage-program", locator: input.logicalAddress },
          contentHash: input.evidenceHash,
        },
        anchorReceipt: {
          ...finalizedReceipt(input.logicalAddress, input.evidenceHash),
          state,
          ...(state === "reorged"
            ? {
                observationDisposition: "indeterminate" as const,
                preservedReceiptHash: "7".repeat(64),
              }
            : {}),
        },
      });
      expect(await publishSellerSessionSettlement(request(h), h.deps)).toMatchObject({
        disposition: "rejected",
        reason: expect.stringContaining("finalized"),
      });
    },
  );

  it("requires authenticated receipt provenance and an exact signed readback", async () => {
    const badReceipt = harness();
    badReceipt.deps.verifyAnchorReceipt = async () => ({
      disposition: "fail",
      reason: "writer proof invalid",
    });
    expect(await publishSellerSessionSettlement(request(badReceipt), badReceipt.deps))
      .toMatchObject({ disposition: "rejected", reason: expect.stringContaining("writer proof") });

    const badReadback = harness();
    badReadback.deps.resolveEvidence = async () => {
      const changed = structuredClone(badReadback.anchored!);
      changed.observedAt += 1;
      return { disposition: "present", evidence: changed };
    };
    expect(await publishSellerSessionSettlement(request(badReadback), badReadback.deps))
      .toMatchObject({ disposition: "rejected", reason: expect.stringContaining("readback differs") });
  });

  it("fails closed when an effect callback attempts to mutate its exact input", async () => {
    const h = harness();
    h.deps.anchorEvidence = async (input) => {
      (input.evidence as { observedAt: number }).observedAt += 1;
      throw new Error("unreachable");
    };
    expect(await publishSellerSessionSettlement(request(h), h.deps)).toMatchObject({
      disposition: "indeterminate",
      reason: expect.stringContaining("publication threw"),
    });
  });

  it("rejects a signed event/settlement identity mismatch before any effect", async () => {
    const h = harness();
    h.authorization.settlementId = `evm:8453:${TX_HASH}:9`;
    const result = await publishSellerSessionSettlement(request(h), h.deps);
    expect(result.disposition).not.toBe("published");
    expect(h.anchor).not.toHaveBeenCalled();
  });
});
