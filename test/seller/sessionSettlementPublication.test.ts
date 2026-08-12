import { describe, expect, it, vi } from "vitest";

import { ARTIFACT_SEPARATORS } from "../../src/artifacts/registry.js";
import type {
  AnchorReceipt,
  ComponentSignatureAlgorithm,
  SettlementEvidence,
} from "../../src/artifacts/types.js";
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
  signedBytes,
} from "../../src/crypto/index.js";
import {
  verifyFinalizedSessionSettlement,
  type SessionSettlementContext,
  type SessionSettlementNativeProofRef,
  type SessionSettlementVerificationProvider,
} from "../../src/agent/sessionSettlement.js";
import {
  publishSellerSessionSettlement,
  type SellerSessionSettlementPublicationDeps,
  type SellerSessionSettlementPublicationRequest,
  type SellerSessionSettlementNativeProofAuthentication,
} from "../../src/seller/sessionSettlementPublication.js";
import {
  publishSellerSessionSettlement as rootPublishSellerSessionSettlement,
} from "../../src/index.js";
import {
  publishSellerSessionSettlement as sellerPublishSellerSessionSettlement,
} from "../../src/seller/index.js";
import type {
  SellerFulfilmentHandoff,
  SellerPaymentAuthorization,
  SellerPaymentEvidenceInput,
  SellerReceiptClaim,
  SellerReceiptInspectionResult,
} from "../../src/seller/paymentIntake.js";
import {
  sellerFulfilmentAuditSourceHash,
  type SellerFulfilmentAuditSourceV1,
} from "../../src/seller/fulfilmentAuditSource.js";
import { sellerFulfilmentCandidateHash } from "../../src/seller/paymentIntake.js";

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
      signer: ORCHESTRATOR,
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
  algorithm: ComponentSignatureAlgorithm = "ed25519",
): SellerFulfilmentHandoff {
  const base = {
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
    phase: "deliver-storage-program" as const,
    logicalAddress: `dacs4:delivery:${value.jobId}`,
    deliverableSpecHash: "f".repeat(64),
    agreementViewHash: "1".repeat(64),
    validationFloorAt: NOW,
    deliveryInvokedAt: NOW,
    evidenceAuthority: { primaryClaim: signer, algorithm },
    candidate: {
      status: "preparation-failed" as const,
      validatedAt: NOW,
      reason: "fixture terminal preparation failure",
    },
  };
  const pipeline = [
    { kind: "negotiate-fixed-price" as const },
    { kind: "commit-agreement" as const },
    { kind: "vet-credentials" as const },
    { kind: value.evidenceInput.phase, parameters: { rail: value.railId } },
    { kind: "deliver-storage-program" as const },
  ];
  const paymentRef = {
    anchor: { kind: "storage-program" as const, locator: `payment:${value.jobId}:3` },
    contentHash: value.evidenceHash,
  };
  const auditSource: SellerFulfilmentAuditSourceV1 = {
    sourceVersion: "1" as const,
    session: {
      recordVersion: "1" as const,
      jobId: value.jobId,
      state: "settle-pending",
      listingRef: structuredClone(value.listingRef),
      parties: [
        { role: "buyer" as const, bundleHash: "1".repeat(64), primaryClaim: "did:demos:buyer" },
        { role: "seller" as const, bundleHash: "2".repeat(64), primaryClaim: signer },
        { role: "orchestrator" as const, bundleHash: "3".repeat(64), primaryClaim: signer },
      ],
      pipeline,
      phaseResults: pipeline.slice(0, 4).map((step, index) => ({
        index,
        step: structuredClone(step),
        invokedAt: NOW - (3 - index),
        result: index === 3
          ? {
              ok: true,
              txRefs: structuredClone(value.evidenceInput.paymentTxRefs),
              attestationRef: structuredClone(paymentRef),
              contextDelta: {},
            }
          : { ok: true, contextDelta: {} },
        contextDelta: {},
      })),
      startedAt: NOW - 4,
      lastUpdatedAt: NOW,
      recipeRegistryVersion: 1,
      railRegistryVersion: value.railRegistryVersion,
    },
    artifacts: {
      agreementCommitment: {
        anchor: { kind: "storage-program" as const, locator: value.commitment.ref },
        contentHash: value.commitment.contentHash,
      },
      vetRecords: [],
      vetRequirements: [],
      settlementEvidence: [structuredClone(paymentRef)],
    },
    provenanceProfile: "dacs-sdk-operational-v1" as const,
  };
  const auditSourceHash = sellerFulfilmentAuditSourceHash(auditSource);
  return {
    ...base,
    handoffVersion: "2",
    auditSource,
    auditSourceHash,
    auditSourceCommitment: {
      commitmentVersion: "1",
      fulfilmentId: base.fulfilmentId,
      jobId: base.jobId,
      agreementRef: base.agreementRef,
      agreementHash: base.agreementHash,
      commitmentRef: base.commitmentRef,
      authorizationHash: base.authorizationHash,
      paymentPhaseIndex: base.paymentPhaseIndex,
      deliveryPhaseIndex: base.deliveryPhaseIndex,
      phase: base.phase,
      logicalAddress: base.logicalAddress,
      deliverableSpecHash: base.deliverableSpecHash,
      auditSourceHash,
      candidateHash: sellerFulfilmentCandidateHash(base.candidate),
      deliveryInvokedAt: base.deliveryInvokedAt,
      signature: { algorithm, signer, value: "c2ln" },
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
  sign: ReturnType<typeof vi.fn>;
  resolveProof: ReturnType<typeof vi.fn>;
  anchor: ReturnType<typeof vi.fn>;
  deps: SellerSessionSettlementPublicationDeps;
}

function proofAuthentication(
  value: SellerPaymentAuthorization,
  artifact: Record<string, unknown> = proof(value),
): SellerSessionSettlementNativeProofAuthentication {
  return {
    disposition: "authenticated",
    binding: {
      bindingVersion: "1",
      jobId: value.jobId,
      railId: value.railId,
      phaseIndex: value.phaseIndex,
      phase: value.evidenceInput.phase,
      evidenceHash: value.evidenceHash,
      settlementId: value.settlementId,
      network: value.settlementIdentity.kind === "demos"
        ? "demos"
        : `eip155:${value.settlementIdentity.chainId}`,
      event: structuredClone(value.settlementIdentity),
      settlementFinality: structuredClone(value.evidenceInput.settlementFinality),
    },
    proof: {
      encoding: "jcs",
      kind: "authenticated-x402-event",
      locator: `proof:${value.jobId}:${value.phaseIndex}`,
      artifact: structuredClone(artifact),
    },
  };
}

function harness(value = authorization()): Harness {
  const retainedClaim = claim(value);
  const retainedHandoff = handoff(value);
  const state: { anchored?: SettlementEvidence } = {};
  const inspect = vi.fn(async (): Promise<SellerReceiptInspectionResult> => ({
    status: "already-consumed",
    claim: structuredClone(retainedClaim),
    handoff: structuredClone(retainedHandoff),
  }));
  const receiptStore = { inspectPermit: inspect };
  const sign = vi.fn((bytes: Uint8Array) => ed25519Sign(bytes, PRIVATE_KEY));
  const resolveProof = vi.fn(async () => proofAuthentication(value));
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
      sign,
    },
    evidence: {
      resolvePublicKey: async (signer) => signer === ORCHESTRATOR ? PUBLIC_KEY : null,
      verify: (bytes, signature, publicKey) =>
        ed25519Verify(bytes, signature, publicKeyFromRaw(publicKey)),
    },
    resolveAuthenticatedNativeProof: resolveProof,
    resolveRetainedSignedEvidence: async (input) => state.anchored
      ? {
          disposition: "present",
          effectId: input.effectId,
          evidence: structuredClone(state.anchored),
        }
      : { disposition: "absent" },
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
    sign,
    resolveProof,
    anchor,
    deps,
  };
}

function request(h: Harness): SellerSessionSettlementPublicationRequest {
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
  });

  it("publishes an exact finalized settlement consumable by the public verifier", async () => {
    const h = harness();
    const result = await publishSellerSessionSettlement(request(h), h.deps);
    expect(result.disposition).toBe("published");
    if (result.disposition !== "published") return;
    expect(result.effectId).toMatch(/^seller-settlement:v1:[0-9a-f]{64}$/);
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

  it("requires an authenticated native-proof resolver before signing", async () => {
    const missing = harness();
    const incomplete = { ...missing.deps } as Partial<
      SellerSessionSettlementPublicationDeps
    >;
    delete incomplete.resolveAuthenticatedNativeProof;
    expect(await publishSellerSessionSettlement(
      request(missing),
      incomplete as SellerSessionSettlementPublicationDeps,
    )).toMatchObject({ disposition: "error", reason: expect.stringContaining("dependencies") });
    expect(missing.sign).not.toHaveBeenCalled();
    expect(missing.anchor).not.toHaveBeenCalled();

    const absent = harness();
    absent.deps.resolveAuthenticatedNativeProof = async () => ({
      disposition: "rejected",
      reason: "native proof absent",
    });
    expect(await publishSellerSessionSettlement(request(absent), absent.deps))
      .toMatchObject({ disposition: "rejected", reason: expect.stringContaining("absent") });
    expect(absent.sign).not.toHaveBeenCalled();

    const pending = harness();
    pending.deps.resolveAuthenticatedNativeProof = async () => ({
      disposition: "indeterminate",
      reason: "provider unavailable",
    });
    expect(await publishSellerSessionSettlement(request(pending), pending.deps))
      .toMatchObject({ disposition: "indeterminate", reason: expect.stringContaining("unavailable") });
    expect(pending.sign).not.toHaveBeenCalled();
  });

  it("rejects malformed or input-mutating native-proof resolvers", async () => {
    const malformed = harness();
    malformed.deps.resolveAuthenticatedNativeProof = async () =>
      ({ disposition: "authenticated" }) as never;
    expect(await publishSellerSessionSettlement(request(malformed), malformed.deps))
      .toMatchObject({ disposition: "error", reason: expect.stringContaining("malformed") });
    expect(malformed.sign).not.toHaveBeenCalled();

    const mutating = harness();
    mutating.deps.resolveAuthenticatedNativeProof = async (input) => {
      (input.authorization as { jobId: string }).jobId = "job-mutated";
      return proofAuthentication(mutating.authorization);
    };
    expect(await publishSellerSessionSettlement(request(mutating), mutating.deps))
      .toMatchObject({ disposition: "indeterminate", reason: expect.stringContaining("resolution threw") });
    expect(mutating.sign).not.toHaveBeenCalled();
  });

  it("captures accessor and proxy proof outputs without invoking getters or rejecting", async () => {
    const accessor = harness();
    let getterCalls = 0;
    const accessorOutput = Object.defineProperty({}, "disposition", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("untrusted getter must remain inert");
      },
    });
    accessor.deps.resolveAuthenticatedNativeProof = async () => accessorOutput as never;
    await expect(
      publishSellerSessionSettlement(request(accessor), accessor.deps),
    ).resolves.toMatchObject({
      disposition: "error",
      reason: expect.stringContaining("malformed"),
    });
    expect(getterCalls).toBe(0);
    expect(accessor.sign).not.toHaveBeenCalled();
    expect(accessor.anchor).not.toHaveBeenCalled();

    const proxied = harness();
    const proxyOutput = new Proxy({}, {
      getPrototypeOf() {
        throw new Error("untrusted proxy trap");
      },
    });
    proxied.deps.resolveAuthenticatedNativeProof = async () => proxyOutput as never;
    await expect(
      publishSellerSessionSettlement(request(proxied), proxied.deps),
    ).resolves.toMatchObject({
      disposition: "error",
      reason: expect.stringContaining("malformed"),
    });
    expect(proxied.sign).not.toHaveBeenCalled();
    expect(proxied.anchor).not.toHaveBeenCalled();
  });

  it.each([
    ["network", (result: Extract<
      SellerSessionSettlementNativeProofAuthentication,
      { disposition: "authenticated" }
    >) => {
      result.binding.network = "eip155:1";
    }],
    ["event chain", (result: Extract<
      SellerSessionSettlementNativeProofAuthentication,
      { disposition: "authenticated" }
    >) => {
      if (result.binding.event.kind === "evm") result.binding.event.chainId = 1;
    }],
    ["event transaction", (result: Extract<
      SellerSessionSettlementNativeProofAuthentication,
      { disposition: "authenticated" }
    >) => {
      result.binding.event.txHash = "f".repeat(64);
    }],
    ["event log", (result: Extract<
      SellerSessionSettlementNativeProofAuthentication,
      { disposition: "authenticated" }
    >) => {
      if (result.binding.event.kind === "evm") result.binding.event.logIndex = 9;
    }],
  ] as const)("rejects an authenticated proof with the wrong %s", async (_label, mutate) => {
    const h = harness();
    h.deps.resolveAuthenticatedNativeProof = async () => {
      const result = proofAuthentication(h.authorization);
      if (result.disposition !== "authenticated") throw new Error("fixture failure");
      mutate(result);
      return result;
    };
    expect(await publishSellerSessionSettlement(request(h), h.deps)).toMatchObject({
      disposition: "rejected",
      reason: expect.stringContaining("event, network, and evidence"),
    });
    expect(h.sign).not.toHaveBeenCalled();
    expect(h.anchor).not.toHaveBeenCalled();
  });

  it("treats caller proof refs only as equality assertions", async () => {
    const h = harness();
    const substituted = request(h);
    substituted.nativeProofRef!.contentHash = "0".repeat(64);
    expect(await publishSellerSessionSettlement(substituted, h.deps)).toMatchObject({
      disposition: "rejected",
      reason: expect.stringContaining("expectation differs"),
    });
    expect(h.sign).not.toHaveBeenCalled();
    expect(h.anchor).not.toHaveBeenCalled();
  });

  it("derives effect identity only from authenticated proof content", async () => {
    const first = harness();
    const firstRequest = request(first);
    delete firstRequest.nativeProofRef;
    const firstResult = await publishSellerSessionSettlement(firstRequest, first.deps);
    expect(firstResult.disposition).toBe("published");
    if (firstResult.disposition !== "published") return;

    const replay = harness();
    const replayRequest = request(replay);
    delete replayRequest.nativeProofRef;
    const replayResult = await publishSellerSessionSettlement(replayRequest, replay.deps);
    expect(replayResult.disposition).toBe("published");
    if (replayResult.disposition !== "published") return;
    expect(replayResult.effectId).toBe(firstResult.effectId);

    const refreshed = harness();
    const refreshedRequest = request(refreshed);
    delete refreshedRequest.nativeProofRef;
    refreshed.deps.resolveAuthenticatedNativeProof = async () =>
      proofAuthentication(refreshed.authorization, {
        ...proof(refreshed.authorization),
        authenticatedWitness: "different-exact-proof",
      });
    const refreshedResult = await publishSellerSessionSettlement(
      refreshedRequest,
      refreshed.deps,
    );
    expect(refreshedResult.disposition).toBe("published");
    if (refreshedResult.disposition !== "published") return;
    expect(refreshedResult.effectId).not.toBe(firstResult.effectId);
    expect(refreshedResult.settlement.nativeProofRef.contentHash)
      .not.toBe(firstResult.settlement.nativeProofRef.contentHash);
  });

  it("recovers a response-lost anchor without invoking a nondeterministic signer twice", async () => {
    const h = harness();
    const signingPayload = signedBytes(
      ARTIFACT_SEPARATORS.SettlementEvidence,
      h.authorization.evidenceHash,
    );
    const firstSignature = new Uint8Array(64).fill(11);
    const alternateSignature = new Uint8Array(64).fill(12);

    const scriptedSigner = vi.fn()
      .mockImplementationOnce(() => firstSignature.slice())
      .mockImplementationOnce(() => alternateSignature.slice());
    h.deps.evidenceSigner = {
      algorithm: "ed25519",
      signer: ORCHESTRATOR,
      sign: scriptedSigner,
    };
    h.deps.evidence = {
      resolvePublicKey: async () => new Uint8Array(32).fill(3),
      verify: (bytes, signature) =>
        Buffer.from(bytes).equals(Buffer.from(signingPayload)) &&
        (Buffer.from(signature).equals(Buffer.from(firstSignature)) ||
          Buffer.from(signature).equals(Buffer.from(alternateSignature))),
    };
    expect(await h.deps.evidence.verify(
      signingPayload,
      firstSignature,
      new Uint8Array(32),
    )).toBe(true);
    expect(await h.deps.evidence.verify(
      signingPayload,
      alternateSignature,
      new Uint8Array(32),
    )).toBe(true);

    let committedEvidence: SettlementEvidence | undefined;
    let committedAnchor:
      | Extract<
          Awaited<ReturnType<SellerSessionSettlementPublicationDeps["anchorEvidence"]>>,
          { disposition: "anchored" }
        >
      | undefined;
    let nativeAnchorCount = 0;
    h.deps.resolveRetainedSignedEvidence = async (input) => committedEvidence
      ? {
          disposition: "present",
          effectId: input.effectId,
          evidence: structuredClone(committedEvidence),
        }
      : { disposition: "absent" };
    h.deps.anchorEvidence = async (input) => {
      if (!committedAnchor) {
        nativeAnchorCount += 1;
        committedEvidence = structuredClone(input.evidence);
        committedAnchor = {
          disposition: "anchored",
          evidenceRef: {
            anchor: { kind: "storage-program", locator: input.logicalAddress },
            contentHash: input.evidenceHash,
            signer: ORCHESTRATOR,
          },
          anchorReceipt: finalizedReceipt(input.logicalAddress, input.evidenceHash),
        };
        return { disposition: "indeterminate", reason: "anchor response lost" };
      }
      return structuredClone(committedAnchor);
    };
    h.deps.resolveEvidence = async () => committedEvidence
      ? { disposition: "present", evidence: structuredClone(committedEvidence) }
      : { disposition: "absent" };

    const first = await publishSellerSessionSettlement(request(h), h.deps);
    expect(first).toMatchObject({
      disposition: "indeterminate",
      reason: "anchor response lost",
    });
    expect(scriptedSigner).toHaveBeenCalledOnce();
    expect(nativeAnchorCount).toBe(1);

    const recovered = await publishSellerSessionSettlement(request(h), h.deps);
    expect(recovered.disposition).toBe("published");
    if (recovered.disposition !== "published") return;
    expect(scriptedSigner).toHaveBeenCalledOnce();
    expect(nativeAnchorCount).toBe(1);
    expect(recovered.settlement.evidence.signature.value).toBe(
      Buffer.from(firstSignature).toString("base64url"),
    );
    expect(recovered.settlement.evidence.signature.value).not.toBe(
      Buffer.from(alternateSignature).toString("base64url"),
    );
  });

  it("reconciles a retained signature after an ambiguous signer response", async () => {
    const h = harness();
    const signatureBytes = ed25519Sign(
      signedBytes(
        ARTIFACT_SEPARATORS.SettlementEvidence,
        h.authorization.evidenceHash,
      ),
      PRIVATE_KEY,
    );
    let signerWal: SettlementEvidence | undefined;
    const ambiguousSigner = vi.fn(() => {
      signerWal = {
        ...structuredClone(h.authorization.evidenceInput),
        signature: {
          algorithm: "ed25519",
          signer: ORCHESTRATOR,
          value: Buffer.from(signatureBytes).toString("base64url"),
        },
      };
      throw new Error("signer response lost");
    });
    h.deps.evidenceSigner = {
      algorithm: "ed25519",
      signer: ORCHESTRATOR,
      sign: ambiguousSigner,
    };
    h.deps.resolveRetainedSignedEvidence = async (input) => signerWal
      ? {
          disposition: "present",
          effectId: input.effectId,
          evidence: structuredClone(signerWal),
        }
      : { disposition: "absent" };

    expect(await publishSellerSessionSettlement(request(h), h.deps)).toMatchObject({
      disposition: "indeterminate",
      reason: expect.stringContaining("signing threw"),
    });
    expect(ambiguousSigner).toHaveBeenCalledOnce();
    expect(h.anchor).not.toHaveBeenCalled();

    const recovered = await publishSellerSessionSettlement(request(h), h.deps);
    expect(recovered.disposition).toBe("published");
    expect(ambiguousSigner).toHaveBeenCalledOnce();
    expect(h.anchor).toHaveBeenCalledOnce();
  });

  it("fails closed on ambiguous, substituted, or mutating signature reconciliation", async () => {
    const ambiguous = harness();
    ambiguous.deps.resolveRetainedSignedEvidence = async () => ({
      disposition: "indeterminate",
      reason: "publication lookup unavailable",
    });
    expect(await publishSellerSessionSettlement(request(ambiguous), ambiguous.deps))
      .toMatchObject({ disposition: "indeterminate", reason: expect.stringContaining("unavailable") });
    expect(ambiguous.sign).not.toHaveBeenCalled();
    expect(ambiguous.anchor).not.toHaveBeenCalled();

    const substituted = harness();
    substituted.deps.resolveRetainedSignedEvidence = async (input) => ({
      disposition: "present",
      effectId: input.effectId,
      evidence: {
        ...structuredClone(substituted.authorization.evidenceInput),
        observedAt: substituted.authorization.evidenceInput.observedAt + 1,
        signature: {
          algorithm: "ed25519",
          signer: ORCHESTRATOR,
          value: Buffer.from(new Uint8Array(64).fill(5)).toString("base64url"),
        },
      },
    });
    expect(await publishSellerSessionSettlement(request(substituted), substituted.deps))
      .toMatchObject({ disposition: "rejected", reason: expect.stringContaining("retained signed evidence") });
    expect(substituted.sign).not.toHaveBeenCalled();
    expect(substituted.anchor).not.toHaveBeenCalled();

    const mutating = harness();
    mutating.deps.resolveRetainedSignedEvidence = async (input) => {
      (input as { effectId: string }).effectId = "substituted-effect";
      return { disposition: "absent" };
    };
    expect(await publishSellerSessionSettlement(request(mutating), mutating.deps))
      .toMatchObject({ disposition: "indeterminate", reason: expect.stringContaining("reconciliation threw") });
    expect(mutating.sign).not.toHaveBeenCalled();
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

  it("contains pre-anchor key-resolution and verification throws", async () => {
    const keyFailure = harness();
    keyFailure.deps.evidence.resolvePublicKey = async () => {
      throw new Error("key backend unavailable");
    };
    await expect(
      publishSellerSessionSettlement(request(keyFailure), keyFailure.deps),
    ).resolves.toMatchObject({
      disposition: "indeterminate",
      reason: expect.stringContaining("could not be resolved"),
      effectId: expect.stringMatching(/^seller-settlement:v1:[0-9a-f]{64}$/),
    });
    expect(keyFailure.sign).toHaveBeenCalledOnce();
    expect(keyFailure.anchor).not.toHaveBeenCalled();

    const verifierFailure = harness();
    verifierFailure.deps.evidence.verify = async () => {
      throw new Error("signature backend unavailable");
    };
    await expect(
      publishSellerSessionSettlement(request(verifierFailure), verifierFailure.deps),
    ).resolves.toMatchObject({
      disposition: "error",
      reason: expect.stringContaining("could not be evaluated"),
      effectId: expect.stringMatching(/^seller-settlement:v1:[0-9a-f]{64}$/),
    });
    expect(verifierFailure.sign).toHaveBeenCalledOnce();
    expect(verifierFailure.anchor).not.toHaveBeenCalled();
  });

  it("contains a post-readback evidence-verification throw", async () => {
    const h = harness();
    let verificationCount = 0;
    h.deps.evidence.verify = (bytes, signature, publicKey) => {
      verificationCount += 1;
      if (verificationCount === 2) {
        throw new Error("readback verifier unavailable");
      }
      return ed25519Verify(bytes, signature, publicKeyFromRaw(publicKey));
    };
    await expect(
      publishSellerSessionSettlement(request(h), h.deps),
    ).resolves.toMatchObject({
      disposition: "error",
      reason: expect.stringContaining("could not be evaluated"),
      effectId: expect.stringMatching(/^seller-settlement:v1:[0-9a-f]{64}$/),
    });
    expect(verificationCount).toBe(2);
    expect(h.anchor).toHaveBeenCalledOnce();
  });

  it("advertises and enforces an ed25519-only evidence signer before effects", async () => {
    const h = harness();
    const unsupportedSigner = vi.fn(() => new Uint8Array(64));
    h.deps.evidenceSigner = {
      // @ts-expect-error settlement publication verification has no secp256k1 backend
      algorithm: "ecdsa-secp256k1",
      signer: ORCHESTRATOR,
      sign: unsupportedSigner,
    };
    await expect(
      publishSellerSessionSettlement(request(h), h.deps),
    ).resolves.toMatchObject({
      disposition: "error",
      reason: expect.stringContaining("must use ed25519"),
    });
    expect(h.inspect).not.toHaveBeenCalled();
    expect(h.resolveProof).not.toHaveBeenCalled();
    expect(unsupportedSigner).not.toHaveBeenCalled();
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

  it("does not produce new pay-x402 evidence from a legacy transaction-level ref", async () => {
    const legacy = authorization();
    legacy.evidenceInput.paymentTxRefs = [{
      kind: "x402",
      httpResource: "https://seller.example/resource",
      paymentReceiptHash: "d".repeat(64),
      settlementTxHash: TX_HASH,
      chainId: 8453,
      protocolVersion: "2",
    }];
    legacy.evidenceHash = sha256Hex(canonicalize(legacy.evidenceInput));
    const h = harness(legacy);
    expect(await publishSellerSessionSettlement(request(h), h.deps)).toMatchObject({
      disposition: "rejected",
      reason: expect.stringContaining("requires a signed x402-event"),
    });
    expect(h.resolveProof).not.toHaveBeenCalled();
    expect(h.sign).not.toHaveBeenCalled();
    expect(h.anchor).not.toHaveBeenCalled();
  });
});
