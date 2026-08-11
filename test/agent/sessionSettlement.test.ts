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
  type SessionSettlementIdentityBinding,
  type SessionSettlementVerificationProvider,
} from "../../src/agent/sessionSettlement.js";

const ORCHESTRATOR = "did:demos:orchestrator";
const SEED = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const PRIVATE_KEY = privateKeyFromSeed(SEED);
const PUBLIC_KEY = rawPublicKey(publicKeyFromSeed(SEED));
const SETTLEMENT_ID = `evm:8453:${"e".repeat(64)}:0`;

function context(finalityBlocks = 12): SessionSettlementContext {
  return {
    contextVersion: "1",
    jobId: "job-settlement-1",
    agreementRef: {
      anchor: { kind: "storage-program", locator: "agreement:job-settlement-1" },
      contentHash: "b".repeat(64),
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

function settlementBinding(
  value: SessionSettlementContext,
  settlementId = SETTLEMENT_ID,
): SessionSettlementIdentityBinding {
  return {
    jobId: value.jobId,
    railId: value.rail.railId,
    phaseIndex: value.paymentPhaseIndex,
    settlementId,
  };
}

function nativePass(input: {
  context: Readonly<SessionSettlementContext>;
}, settlementId = SETTLEMENT_ID) {
  return {
    disposition: "pass" as const,
    binding: settlementBinding(
      input.context as SessionSettlementContext,
      settlementId,
    ),
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
    settlementId: SETTLEMENT_ID,
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
    revalidateSettlement: (input) => nativePass(input, String(proof.settlementId)),
    claimSettlementIdentity: (input) => ({
      disposition: "pass",
      ownership: "bound",
      binding: structuredClone(input.binding),
      ownerHash: input.ownerHash,
    }),
    evidence: {
      resolvePublicKey: async (signer) =>
        signer === ORCHESTRATOR ? new Uint8Array(PUBLIC_KEY) : null,
      verify: (bytes, signature, publicKey) =>
        ed25519Verify(bytes, signature, publicKeyFromRaw(publicKey)),
    },
    ...overrides,
  };
}

function atomicProvider(proof: Record<string, unknown>): {
  value: SessionSettlementVerificationProvider;
  claims: Map<string, {
    binding: SessionSettlementIdentityBinding;
    ownerHash: string;
  }>;
} {
  const claims = new Map<string, {
    binding: SessionSettlementIdentityBinding;
    ownerHash: string;
  }>();
  const value = provider(proof, {
    claimSettlementIdentity: (input) => {
      const existing = claims.get(input.binding.settlementId);
      if (!existing) {
        claims.set(input.binding.settlementId, structuredClone(input));
        return {
          disposition: "pass" as const,
          ownership: "bound" as const,
          binding: structuredClone(input.binding),
          ownerHash: input.ownerHash,
        };
      }
      if (
        canonicalize(existing.binding) !== canonicalize(input.binding) ||
        existing.ownerHash !== input.ownerHash
      ) {
        return {
          disposition: "fail" as const,
          reason: "settlement identity already belongs to another session",
        };
      }
      return {
        disposition: "pass" as const,
        ownership: "existing" as const,
        binding: structuredClone(existing.binding),
        ownerHash: existing.ownerHash,
      };
    },
  });
  return { value, claims };
}

describe("verifyFinalizedSessionSettlement", () => {
  it("authenticates exact evidence, anchor, proof, and live finality", async () => {
    const { settlement, proof } = fixture();
    expect(isSettlementEvidence(settlement.evidence)).toBe(true);
    expect(isAnchorReceipt(settlement.anchorReceipt)).toBe(true);
    const revalidate = vi.fn((input: Parameters<
      SessionSettlementVerificationProvider["revalidateSettlement"]
    >[0]) => nativePass(input));
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
    expect(result.value.identityHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.value.observationHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.value.settlementBinding).toEqual(settlementBinding(context()));
    expect(result.value.settlementOwnership).toBe("bound");
    expect(revalidate).toHaveBeenCalledOnce();
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.settlement.evidence)).toBe(true);
  });

  it("re-runs native observation in recovery mode", async () => {
    const { settlement, proof } = fixture();
    const revalidate = vi.fn((input: Parameters<
      SessionSettlementVerificationProvider["revalidateSettlement"]
    >[0]) =>
      input.mode === "recovery"
        ? { disposition: "indeterminate" as const, reason: "head unavailable" }
        : nativePass(input),
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
    const revalidate = vi.fn((input: Parameters<
      SessionSettlementVerificationProvider["revalidateSettlement"]
    >[0]) => nativePass(input));
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
    const revalidate = vi.fn((input: Parameters<
      SessionSettlementVerificationProvider["revalidateSettlement"]
    >[0]) => nativePass(input));
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

    const incomplete = provider(proof) as Partial<
      SessionSettlementVerificationProvider
    >;
    delete incomplete.claimSettlementIdentity;
    expect(await verifyFinalizedSessionSettlement(
      context(),
      settlement,
      incomplete as SessionSettlementVerificationProvider,
    )).toEqual({
      disposition: "error",
      reason: "settlement verification provider is incomplete or unsafe",
    });
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

  it("rejects a split agreement reference/hash before invoking trust providers", async () => {
    const { settlement, proof } = fixture();
    const split = context();
    split.agreementRef.contentHash = "a".repeat(64);
    const authenticateContext = vi.fn(() => ({ disposition: "pass" as const }));

    const result = await verifyFinalizedSessionSettlement(
      split,
      settlement,
      provider(proof, { authenticateContext }),
    );

    expect(result).toEqual({
      disposition: "error",
      reason: "settlement context is not exact canonical data",
    });
    expect(authenticateContext).not.toHaveBeenCalled();
  });

  it("binds the evidence reference signer and receipt logical address locally", async () => {
    const { settlement, proof } = fixture();
    const wrongAddress = structuredClone(settlement);
    wrongAddress.anchorReceipt.logicalAddress = "evidence:other-job:3";
    const addressAnchorVerifier = vi.fn(() => ({ disposition: "pass" as const }));
    expect(await verifyFinalizedSessionSettlement(
      context(),
      wrongAddress,
      provider(proof, { verifyEvidenceAnchor: addressAnchorVerifier }),
    )).toEqual({
      disposition: "rejected",
      reason: "settlement evidence lacks an exact finalized orchestrator receipt",
    });
    expect(addressAnchorVerifier).not.toHaveBeenCalled();

    const wrongSigner = structuredClone(settlement);
    wrongSigner.evidenceRef.signer = "did:demos:outsider";
    const signerAnchorVerifier = vi.fn(() => ({ disposition: "pass" as const }));
    expect(await verifyFinalizedSessionSettlement(
      context(),
      wrongSigner,
      provider(proof, { verifyEvidenceAnchor: signerAnchorVerifier }),
    )).toEqual({
      disposition: "rejected",
      reason: "settlement evidence lacks an exact finalized orchestrator receipt",
    });
    expect(signerAnchorVerifier).not.toHaveBeenCalled();
  });

  it("requires an exact authenticated native job, rail, and phase binding", async () => {
    const { settlement, proof } = fixture();
    const variants: Array<SessionSettlementIdentityBinding> = [
      { ...settlementBinding(context()), jobId: "other-job" },
      { ...settlementBinding(context()), railId: "other-rail" },
      { ...settlementBinding(context()), phaseIndex: 4 },
    ];
    for (const binding of variants) {
      const claim = vi.fn(() => ({
        disposition: "pass" as const,
        ownership: "bound" as const,
        binding,
        ownerHash: "1".repeat(64),
      }));
      const result = await verifyFinalizedSessionSettlement(
        context(),
        settlement,
        provider(proof, {
          revalidateSettlement: () => ({ disposition: "pass", binding }),
          claimSettlementIdentity: claim,
        }),
      );
      expect(result).toEqual({
        disposition: "rejected",
        reason: "native settlement binding does not match the authenticated session",
      });
      expect(claim).not.toHaveBeenCalled();
    }
  });

  it.each([
    "demos:ABCDEF",
    `demos:${"A".repeat(64)}`,
    `evm:0:${"e".repeat(64)}:0`,
    `evm:08453:${"e".repeat(64)}:0`,
    `evm:8453:0x${"e".repeat(64)}:0`,
    `evm:8453:${"e".repeat(64)}:01`,
    `evm:9007199254740992:${"e".repeat(64)}:0`,
  ])("rejects non-canonical settlement identity %s", async (settlementId) => {
    const { settlement, proof } = fixture();
    const result = await verifyFinalizedSessionSettlement(
      context(),
      settlement,
      provider(proof, {
        revalidateSettlement: (input) => ({
          disposition: "pass",
          binding: settlementBinding(
            input.context as SessionSettlementContext,
            settlementId,
          ),
        }),
      }),
    );
    expect(result).toEqual({
      disposition: "error",
      reason: "native settlement verdict is malformed",
    });
  });

  it("atomically prevents one native settlement identity from owning two phases", async () => {
    const { settlement, proof } = fixture();
    const atomic = atomicProvider(proof);
    const first = await verifyFinalizedSessionSettlement(
      context(),
      settlement,
      atomic.value,
    );
    expect(first.disposition).toBe("verified");

    const repeatedPhase = context();
    repeatedPhase.paymentPhaseIndex = 4;
    const replay = await verifyFinalizedSessionSettlement(
      repeatedPhase,
      settlement,
      atomic.value,
    );
    expect(replay).toEqual({
      disposition: "rejected",
      reason:
        "settlement identity claim: settlement identity already belongs to another session",
    });
    expect(atomic.claims).toHaveLength(1);
  });

  it("rejects a claim provider that rebounds an otherwise valid owner", async () => {
    const { settlement, proof } = fixture();
    const reboundBinding = await verifyFinalizedSessionSettlement(
      context(),
      settlement,
      provider(proof, {
        claimSettlementIdentity: (input) => ({
          disposition: "pass",
          ownership: "existing",
          binding: { ...input.binding, phaseIndex: input.binding.phaseIndex + 1 },
          ownerHash: input.ownerHash,
        }),
      }),
    );
    expect(reboundBinding).toEqual({
      disposition: "error",
      reason: "settlement identity claim returned rebound ownership",
    });

    const reboundOwner = await verifyFinalizedSessionSettlement(
      context(),
      settlement,
      provider(proof, {
        claimSettlementIdentity: (input) => ({
          disposition: "pass",
          ownership: "existing",
          binding: structuredClone(input.binding),
          ownerHash: "0".repeat(64),
        }),
      }),
    );
    expect(reboundOwner).toEqual({
      disposition: "error",
      reason: "settlement identity claim returned rebound ownership",
    });
  });

  it("uses inspected descriptor values and never a Proxy get replacement", async () => {
    const { settlement, proof } = fixture();
    const inspected = provider(proof);
    const poisonedEvidence = {
      resolvePublicKey: async () => null,
      verify: () => false,
    };
    const proxied = new Proxy(inspected, {
      get: (target, property, receiver) => {
        if (property === "authenticateContext") {
          return () => ({ disposition: "fail", reason: "Proxy get was used" });
        }
        if (property === "evidence") return poisonedEvidence;
        return Reflect.get(target, property, receiver);
      },
    });

    const result = await verifyFinalizedSessionSettlement(
      context(),
      settlement,
      proxied,
    );
    expect(result.disposition).toBe("verified");
  });

  it("invokes captured provider callbacks with an inert frozen receiver", async () => {
    const { settlement, proof } = fixture();
    const capturedReceivers: unknown[] = [];
    const value = provider(proof);
    value.authenticateContext = function (this: unknown) {
      capturedReceivers.push(this);
      return { disposition: "pass" };
    };

    const result = await verifyFinalizedSessionSettlement(
      context(),
      settlement,
      value,
    );
    expect(result.disposition).toBe("verified");
    expect(capturedReceivers).toHaveLength(1);
    expect(capturedReceivers[0]).not.toBe(value);
    expect(Object.isFrozen(capturedReceivers[0])).toBe(true);
  });

  it("detects a native verifier mutating its byte proof input", async () => {
    const { settlement, proof } = fixture();
    const bytes = Uint8Array.from([0, 1, 2, 3, 4, 5]);
    settlement.nativeProofRef = {
      ...settlement.nativeProofRef,
      contentHash: sha256Hex(bytes),
      encoding: "bytes",
    };
    const result = await verifyFinalizedSessionSettlement(
      context(),
      settlement,
      provider(proof, {
        resolveNativeProof: () => ({ disposition: "present", bytes }),
        revalidateSettlement: (input) => {
          if (input.nativeProof instanceof Uint8Array) {
            input.nativeProof[0] = 9;
          }
          return nativePass(input);
        },
      }),
    );
    expect(result).toEqual({
      disposition: "error",
      reason: "native settlement verifier mutated its proof input",
    });
    expect(bytes).toEqual(Uint8Array.from([0, 1, 2, 3, 4, 5]));
  });

  it("keeps stable identity across refreshed recovery observations", async () => {
    const { settlement, proof } = fixture();
    const atomic = atomicProvider(proof);
    const initial = await verifyFinalizedSessionSettlement(
      context(),
      settlement,
      atomic.value,
    );
    expect(initial.disposition).toBe("verified");
    if (initial.disposition !== "verified") return;

    const refreshed = structuredClone(settlement);
    refreshed.anchorReceipt.observedAt += 10_000;
    refreshed.anchorReceipt.blockRef = {
      id: "block-anchor-refreshed",
      height: "88",
      timestamp: refreshed.anchorReceipt.observedAt,
    };
    refreshed.anchorReceipt.evidence = {
      kind: "validator-set",
      value: "quorum-proof-refreshed",
    };
    const recovery = await verifyFinalizedSessionSettlement(
      context(),
      refreshed,
      atomic.value,
      "recovery",
    );
    expect(recovery.disposition).toBe("verified");
    if (recovery.disposition !== "verified") return;
    expect(recovery.value.settlementOwnership).toBe("existing");
    expect(recovery.value.identityHash).toBe(initial.value.identityHash);
    expect(recovery.value.observationHash).not.toBe(
      initial.value.observationHash,
    );
  });

  it("maps evidence dependency and identity-store throws into four-valued results", async () => {
    const { settlement, proof } = fixture();
    const keyFailure = await verifyFinalizedSessionSettlement(
      context(),
      settlement,
      provider(proof, {
        evidence: {
          resolvePublicKey: async () => {
            throw new Error("key service unavailable");
          },
          verify: () => true,
        },
      }),
    );
    expect(keyFailure).toEqual({
      disposition: "indeterminate",
      reason: "normative settlement evidence verification threw",
    });

    const verifyFailure = await verifyFinalizedSessionSettlement(
      context(),
      settlement,
      provider(proof, {
        evidence: {
          resolvePublicKey: async () => new Uint8Array(PUBLIC_KEY),
          verify: () => {
            throw new Error("crypto backend unavailable");
          },
        },
      }),
    );
    expect(verifyFailure).toEqual({
      disposition: "indeterminate",
      reason: "normative settlement evidence verification threw",
    });

    const claimFailure = await verifyFinalizedSessionSettlement(
      context(),
      settlement,
      provider(proof, {
        claimSettlementIdentity: () => {
          throw new Error("store unavailable");
        },
      }),
    );
    expect(claimFailure).toEqual({
      disposition: "indeterminate",
      reason: "settlement identity claim threw",
    });

    const claimIndeterminate = await verifyFinalizedSessionSettlement(
      context(),
      settlement,
      provider(proof, {
        claimSettlementIdentity: () => ({
          disposition: "indeterminate",
          reason: "store quorum unavailable",
        }),
      }),
    );
    expect(claimIndeterminate).toEqual({
      disposition: "indeterminate",
      reason: "settlement identity claim: store quorum unavailable",
    });
  });

  it("returns an error instead of throwing on non-canonical hash input", async () => {
    const { settlement, proof } = fixture();
    const unsafe = context();
    unsafe.payer.primaryClaim = "\ud800";

    await expect(verifyFinalizedSessionSettlement(
      unsafe,
      settlement,
      provider(proof),
    )).resolves.toEqual({
      disposition: "error",
      reason: "settlement identity cannot be canonicalized safely",
    });
  });
});
