import { describe, expect, it, vi } from "vitest";

import { ARTIFACT_SEPARATORS } from "../../src/artifacts/registry.js";
import type {
  AnchorReceipt,
  AttestationRef,
  SettlementEvidence,
} from "../../src/artifacts/types.js";
import {
  isAnchorReceipt,
  isSettlementEvidence,
} from "../../src/artifacts/validators.js";
import { canonicalize, contentHash, sha256Hex } from "../../src/canonical/index.js";
import {
  ed25519Sign,
  ed25519Verify,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  rawPublicKey,
  signedBytes,
} from "../../src/crypto/index.js";
import {
  verifyFinalizedSessionSettlement,
  type FinalizedSessionSettlement,
  type SessionSettlementContext,
  type SessionSettlementVerificationProvider,
} from "../../src/agent/sessionSettlement.js";

const ORCHESTRATOR = "did:demos:orchestrator";
const SEED = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const PRIVATE_KEY = privateKeyFromSeed(SEED);
const PUBLIC_KEY = rawPublicKey(publicKeyFromSeed(SEED));

function context(finalityBlocks = 12): SessionSettlementContext {
  return {
    contextVersion: "1",
    jobId: "job-settlement-1",
    agreementRef: {
      anchor: { kind: "storage-program", locator: "agreement:job-settlement-1" },
      contentHash: "a".repeat(64),
    },
    agreementHash: "b".repeat(64),
    paymentPhaseIndex: 3,
    orchestrator: ORCHESTRATOR,
    payer: {
      primaryClaim: "did:demos:buyer",
      payingKey: "0x1111111111111111111111111111111111111111",
    },
    payee: {
      primaryClaim: "did:demos:seller",
      receivingKey: "0x2222222222222222222222222222222222222222",
    },
    paymentAmount: { amount: "5", currency: "USDC" },
    rail: {
      railId: "rail-x402-base",
      railRegistryVersion: 7,
      descriptorHash: "c".repeat(64),
      railType: "x402",
      handler: "pay-x402",
      asset: "USDC",
      network: "eip155:8453",
      finality: { model: "block-depth", finalityBlocks },
    },
  };
}

function signedEvidence(input: {
  outcome?: "success" | "failure";
  finalityBlocks?: number;
  amount?: string;
  jobId?: string;
} = {}): SettlementEvidence {
  const outcome = input.outcome ?? "success";
  const base = {
    evidenceVersion: "1" as const,
    jobId: input.jobId ?? "job-settlement-1",
    phase: "pay-x402" as const,
    outcome,
    paymentTxRefs: [
      {
        kind: "x402" as const,
        httpResource: "https://seller.example/deliverable",
        paymentReceiptHash: "d".repeat(64),
        settlementTxHash: `0x${"e".repeat(64)}`,
        chainId: 8453,
        protocolVersion: "2",
      },
    ],
    paymentAmount: { amount: input.amount ?? "5", currency: "USDC" },
    observedAt: 1_777_000_000_000,
    ...(outcome === "success"
      ? {
          settlementFinality: {
            model: "block-depth" as const,
            finalityBlocks: input.finalityBlocks ?? 12,
            finalityObservedAt: 1_777_000_000_000,
          },
        }
      : { reason: "provider rejected settlement" }),
  };
  const hash = contentHash(base as unknown as Record<string, unknown>);
  const signature = ed25519Sign(
    signedBytes(ARTIFACT_SEPARATORS.SettlementEvidence, hash),
    PRIVATE_KEY,
  );
  return {
    ...base,
    signature: {
      algorithm: "ed25519",
      signer: ORCHESTRATOR,
      value: Buffer.from(signature).toString("base64url"),
    },
  } as SettlementEvidence;
}

function fixture(options: Parameters<typeof signedEvidence>[0] = {}) {
  const evidence = signedEvidence(options);
  const evidenceHash = contentHash(evidence as unknown as Record<string, unknown>);
  const evidenceRef: AttestationRef = {
    anchor: { kind: "storage-program", locator: "evidence:job-settlement-1:3" },
    contentHash: evidenceHash,
  };
  const anchorReceipt: AnchorReceipt = {
    receiptVersion: "1",
    substrate: "demos",
    finalityProfile: "bft-final",
    logicalAddress: evidenceRef.anchor.locator,
    nativeAddress: "native:evidence:job-settlement-1:3",
    contentHash: evidenceHash,
    transactionRef: { kind: "demos", value: "anchor-tx-1" },
    writer: ORCHESTRATOR,
    state: "finalized",
    observationDisposition: "established",
    observedAt: 1_777_000_000_001,
    blockRef: {
      id: "block-anchor-1",
      height: "77",
      timestamp: 1_777_000_000_001,
    },
    evidence: { kind: "validator-set", value: "quorum-proof-1" },
  };
  const proof = {
    proofVersion: "fixture-1",
    settlementId: `evm:8453:${"e".repeat(64)}:0`,
    payer: "0x1111111111111111111111111111111111111111",
    payee: "0x2222222222222222222222222222222222222222",
    amount: "5",
  };
  const settlement: FinalizedSessionSettlement = {
    settlementVersion: "1",
    outcome: options.outcome ?? "success",
    evidence,
    evidenceRef,
    anchorReceipt,
    nativeProofRef: {
      proofVersion: "1",
      kind: "x402-response-and-chain-observation",
      locator: "proof:job-settlement-1:3",
      contentHash: sha256Hex(canonicalize(proof)),
      encoding: "jcs",
    },
  };
  return { settlement, proof };
}

function provider(
  proof: Record<string, unknown>,
  overrides: Partial<SessionSettlementVerificationProvider> = {},
): SessionSettlementVerificationProvider {
  return {
    authenticateContext: () => ({ disposition: "pass" }),
    verifyEvidenceAnchor: () => ({ disposition: "pass" }),
    resolveNativeProof: () => ({ disposition: "present", artifact: proof }),
    revalidateSettlement: () => ({ disposition: "pass" }),
    evidence: {
      resolvePublicKey: async (signer) =>
        signer === ORCHESTRATOR ? new Uint8Array(PUBLIC_KEY) : null,
      verify: (bytes, signature, publicKey) =>
        ed25519Verify(bytes, signature, publicKeyFromRaw(publicKey)),
    },
    ...overrides,
  };
}

describe("verifyFinalizedSessionSettlement", () => {
  it("authenticates exact evidence, anchor, proof, and live finality", async () => {
    const { settlement, proof } = fixture();
    expect(isSettlementEvidence(settlement.evidence)).toBe(true);
    expect(isAnchorReceipt(settlement.anchorReceipt)).toBe(true);
    const revalidate = vi.fn(() => ({ disposition: "pass" as const }));
    const result = await verifyFinalizedSessionSettlement(
      context(),
      settlement,
      provider(proof, { revalidateSettlement: revalidate }),
    );

    expect(result.disposition).toBe("verified");
    if (result.disposition !== "verified") return;
    expect(result.value.outcome).toBe("success");
    expect(result.value.mode).toBe("initial");
    expect(result.value.evidenceHash).toBe(settlement.evidenceRef.contentHash);
    expect(result.value.nativeProofHash).toBe(settlement.nativeProofRef.contentHash);
    expect(result.value.resultHash).toMatch(/^[0-9a-f]{64}$/);
    expect(revalidate).toHaveBeenCalledOnce();
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.settlement.evidence)).toBe(true);
  });

  it("re-runs native observation in recovery mode", async () => {
    const { settlement, proof } = fixture();
    const revalidate = vi.fn((input: { mode: string }) =>
      input.mode === "recovery"
        ? { disposition: "indeterminate" as const, reason: "head unavailable" }
        : { disposition: "pass" as const },
    );
    const result = await verifyFinalizedSessionSettlement(
      context(),
      settlement,
      provider(proof, { revalidateSettlement: revalidate }),
      "recovery",
    );
    expect(result).toEqual({
      disposition: "indeterminate",
      reason: "native settlement: head unavailable",
    });
    expect(revalidate).toHaveBeenCalledOnce();
  });

  it("rejects a descriptor-pinned depth downgrade before native callbacks", async () => {
    const { settlement, proof } = fixture({ finalityBlocks: 1 });
    const revalidate = vi.fn(() => ({ disposition: "pass" as const }));
    const result = await verifyFinalizedSessionSettlement(
      context(12),
      settlement,
      provider(proof, { revalidateSettlement: revalidate }),
    );
    expect(result).toEqual({
      disposition: "rejected",
      reason: "settlement finality does not match the authenticated rail pin",
    });
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("rejects evidence/proof substitutions and a forged anchor", async () => {
    const { settlement, proof } = fixture();
    const wrongEvidence = structuredClone(settlement);
    wrongEvidence.evidenceRef.contentHash = "f".repeat(64);
    expect((await verifyFinalizedSessionSettlement(
      context(), wrongEvidence, provider(proof),
    )).disposition).toBe("rejected");

    const wrongProof = structuredClone(settlement);
    wrongProof.nativeProofRef.contentHash = "f".repeat(64);
    expect((await verifyFinalizedSessionSettlement(
      context(), wrongProof, provider(proof),
    )).disposition).toBe("rejected");

    const forgedAnchor = structuredClone(settlement);
    forgedAnchor.anchorReceipt.state = "reorged";
    forgedAnchor.anchorReceipt.observationDisposition = "indeterminate";
    forgedAnchor.anchorReceipt.preservedReceiptHash = "1".repeat(64);
    expect((await verifyFinalizedSessionSettlement(
      context(), forgedAnchor, provider(proof),
    )).disposition).toBe("rejected");
  });

  it("requires exact signed/context-bound failure evidence too", async () => {
    const { settlement, proof } = fixture({ outcome: "failure" });
    const revalidate = vi.fn(() => ({ disposition: "pass" as const }));
    const result = await verifyFinalizedSessionSettlement(
      context(),
      settlement,
      provider(proof, { revalidateSettlement: revalidate }),
    );
    expect(result.disposition).toBe("verified");
    if (result.disposition === "verified") {
      expect(result.value.outcome).toBe("failure");
    }
    expect(revalidate).toHaveBeenCalledOnce();

    const tampered = structuredClone(settlement);
    tampered.evidence.reason = "different failure";
    expect((await verifyFinalizedSessionSettlement(
      context(), tampered, provider(proof),
    )).disposition).toBe("rejected");
  });

  it("does not accept delivery HTTP status as settlement state", async () => {
    const { settlement, proof } = fixture();
    const poisoned = {
      ...settlement,
      deliveryHttpStatus: 503,
    };
    expect(await verifyFinalizedSessionSettlement(
      context(), poisoned, provider(proof),
    )).toEqual({
      disposition: "error",
      reason: "finalized settlement is not exact canonical data",
    });
  });

  it("rejects accessors, -0, partial variants, and malformed provider verdicts", async () => {
    const { settlement, proof } = fixture();
    const accessorContext = context() as unknown as Record<string, unknown>;
    Object.defineProperty(accessorContext, "jobId", {
      enumerable: true,
      get: () => "job-settlement-1",
    });
    expect((await verifyFinalizedSessionSettlement(
      accessorContext, settlement, provider(proof),
    )).disposition).toBe("error");

    const negativeZero = context();
    negativeZero.paymentPhaseIndex = -0;
    expect((await verifyFinalizedSessionSettlement(
      negativeZero, settlement, provider(proof),
    )).disposition).toBe("error");

    const partial = structuredClone(settlement) as unknown as Record<string, unknown>;
    delete partial.nativeProofRef;
    expect((await verifyFinalizedSessionSettlement(
      context(), partial, provider(proof),
    )).disposition).toBe("error");

    expect((await verifyFinalizedSessionSettlement(
      context(),
      settlement,
      provider(proof, {
        authenticateContext: () => ({ disposition: "pass", reason: "smuggled" }) as never,
      }),
    )).disposition).toBe("error");
  });

  it("captures provider methods before the first await", async () => {
    const { settlement, proof } = fixture();
    const live = provider(proof);
    const original = live.revalidateSettlement;
    live.authenticateContext = async () => {
      live.revalidateSettlement = () => ({
        disposition: "fail",
        reason: "late replacement",
      });
      return { disposition: "pass" };
    };
    const result = await verifyFinalizedSessionSettlement(context(), settlement, live);
    expect(result.disposition).toBe("verified");
    expect(live.revalidateSettlement).not.toBe(original);
  });

  it("propagates reorg/not-final observations without converting them to absence", async () => {
    const { settlement, proof } = fixture();
    for (const reason of ["reorged", "not-final", "reverted"]) {
      const result = await verifyFinalizedSessionSettlement(
        context(),
        settlement,
        provider(proof, {
          revalidateSettlement: () => ({ disposition: "fail", reason }),
        }),
        "recovery",
      );
      expect(result).toEqual({
        disposition: "rejected",
        reason: `native settlement: ${reason}`,
      });
    }
  });
});
