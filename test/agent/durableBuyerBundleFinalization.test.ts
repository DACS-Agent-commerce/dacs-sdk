import { beforeEach, describe, expect, test, vi } from "vitest";

const protocolMocks = vi.hoisted(() => ({
  verifySettlement: vi.fn(),
  verifyRequest: vi.fn(),
  verifySellerFinalization: vi.fn(),
}));

vi.mock("../../src/agent/sessionSettlement.js", () => ({
  verifyFinalizedSessionSettlement: protocolMocks.verifySettlement,
}));

vi.mock("../../src/seller/bundleFinalization.js", () => ({
  verifyCompletedSellerBundleCounterSignatureRequest: protocolMocks.verifyRequest,
  verifyFinalizedSellerBundleReadOnly: protocolMocks.verifySellerFinalization,
}));

import {
  ARTIFACT_SEPARATORS,
  BUNDLE_BINDING_SEPARATOR,
  type AnchorReceipt,
  type BundleBinding,
  type BundleSignature,
  type FaultAttestationBundle,
} from "../../src/artifacts/index.js";
import {
  bundleAddress,
  canonicalize,
  contentHash,
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
import { DacsError } from "../../src/errors.js";
import { createInMemoryFencedSessionStore } from "../../src/agent/fencedSessionStore.js";
import {
  advanceCompletedBuyerBundleDurable,
  buyerBundleFinalizationCheckpointKey,
  getBuyerBundleFinalizationStatus,
  type BuyerBundleEffectFence,
  type BuyerBundleFinalizationDurability,
  type DurableBuyerBundleFinalizationInput,
  type DurableBuyerBundleFinalizationProvider,
} from "../../src/agent/durableBuyerBundleFinalization.js";
import {
  attestationBundleHash,
  bundleSignedScope,
} from "../../src/agent/twoSidedBundle.js";
import type {
  FinalizedSessionSettlement,
  SessionSettlementContext,
  SessionSettlementVerificationProvider,
} from "../../src/agent/sessionSettlement.js";
import type {
  AnchoredBuyerBundle,
  BuyerBundleLookup,
} from "../../src/agent/buyerBundleFinalization.js";
import type {
  CompletedSellerBundleCounterSignatureRequest,
  FinalizedSellerBundle,
  SellerBundleBindingLookup,
  VerifyCompletedSellerBundleCounterSignatureRequestInput,
} from "../../src/seller/bundleFinalization.js";

const NOW = 1_786_200_000_000;
const JOB_ID = "durable-buyer-finalization-122";
const AGREEMENT_HASH = "4".repeat(64);
const BUYER = "did:demos:buyer";
const SELLER = "did:demos:seller";
const ORCHESTRATOR = "did:demos:orchestrator";
const BUYER_HASH = "1".repeat(64);
const SELLER_HASH = "2".repeat(64);
const ORCHESTRATOR_HASH = "d".repeat(64);
const BUYER_SEED = new Uint8Array(32).fill(81);
const SELLER_SEED = new Uint8Array(32).fill(82);
const ORCHESTRATOR_SEED = new Uint8Array(32).fill(83);
const SETTLEMENT_ID = `evm:8453:${"e".repeat(64)}:0`;

function detachedSignature(
  scope: Record<string, unknown>,
  party: string,
  seed: Uint8Array,
): BundleSignature {
  const hash = sha256Hex(canonicalize(scope));
  return {
    party,
    algorithm: "ed25519",
    value: Buffer.from(
      ed25519Sign(
        signedBytes(ARTIFACT_SEPARATORS.FaultAttestationBundle, hash),
        privateKeyFromSeed(seed),
      ),
    ).toString("base64url"),
  };
}

function bundleScope(distinctOrchestrator = false): Record<string, unknown> {
  return {
    faultBundleVersion: "1",
    faultedParty: "none",
    jobId: JOB_ID,
    outcome: "completed",
    listingRef: {
      listingId: "durable-buyer-listing",
      version: 1,
      contentHash: "3".repeat(64),
    },
    agreementRef: {
      anchor: { kind: "storage-program", locator: "dacs3:agreement:122" },
      contentHash: AGREEMENT_HASH,
    },
    parties: [
      { role: "buyer", primaryClaim: BUYER, bundleHash: BUYER_HASH },
      { role: "seller", primaryClaim: SELLER, bundleHash: SELLER_HASH },
      ...(distinctOrchestrator
        ? [{
            role: "orchestrator",
            primaryClaim: ORCHESTRATOR,
            bundleHash: ORCHESTRATOR_HASH,
          }]
        : []),
    ],
    phaseSummary: [],
    vetRecords: [],
    settlementEvidence: [],
    recipeRegistryVersion: 7,
    railRegistryVersion: 9,
    finalisedAt: NOW,
  };
}

function bundleCopies(distinctOrchestrator = false): {
  buyerBundle: FaultAttestationBundle;
  sellerBundle: FaultAttestationBundle;
  orchestratorBundle?: FaultAttestationBundle;
  buyerSignature: BundleSignature;
  orchestratorSignature?: BundleSignature;
} {
  const scope = bundleScope(distinctOrchestrator);
  const buyerSignature = detachedSignature(scope, BUYER, BUYER_SEED);
  const sellerSignature = detachedSignature(scope, SELLER, SELLER_SEED);
  const orchestratorSignature = distinctOrchestrator
    ? detachedSignature(scope, ORCHESTRATOR, ORCHESTRATOR_SEED)
    : undefined;
  const common = {
    ...structuredClone(scope),
    signatures: [
      buyerSignature,
      sellerSignature,
      ...(orchestratorSignature ? [orchestratorSignature] : []),
    ],
  };
  return {
    buyerBundle: { ...common, anchoredByRole: "buyer" } as FaultAttestationBundle,
    sellerBundle: { ...common, anchoredByRole: "seller" } as FaultAttestationBundle,
    ...(orchestratorSignature
      ? {
          orchestratorBundle: {
            ...common,
            anchoredByRole: "orchestrator",
          } as FaultAttestationBundle,
          orchestratorSignature,
        }
      : {}),
    buyerSignature,
  };
}

function requestFor(
  sellerBundle: FaultAttestationBundle,
  distinctOrchestrator = false,
): CompletedSellerBundleCounterSignatureRequest {
  const signedScope = bundleSignedScope(sellerBundle);
  const bundleContentHash = sha256Hex(canonicalize(signedScope));
  return {
    bundleContentHash,
    signedScope,
    signedBytes: new Uint8Array(
      signedBytes(
        ARTIFACT_SEPARATORS.FaultAttestationBundle,
        bundleContentHash,
      ),
    ),
    requiredCounterSigners: [
      BUYER,
      ...(distinctOrchestrator ? [ORCHESTRATOR] : []),
    ],
  };
}

function receipt(
  logicalAddress: string,
  nativeAddress: string,
  hash: string,
): AnchorReceipt {
  return {
    receiptVersion: "1",
    substrate: "test:final",
    finalityProfile: "test-final",
    logicalAddress,
    nativeAddress,
    contentHash: hash,
    transactionRef: { kind: "test", value: `tx-${hash.slice(0, 16)}` },
    writer: "test-writer",
    state: "finalized",
    observationDisposition: "established",
    observedAt: NOW,
    blockRef: { id: `block-${hash.slice(0, 8)}`, timestamp: NOW - 1_000 },
    evidence: { kind: "test-finality", value: `proof-${hash.slice(0, 16)}` },
  };
}

function settlementContext(): SessionSettlementContext {
  return {
    contextVersion: "1",
    jobId: JOB_ID,
    agreementRef: {
      anchor: { kind: "storage-program", locator: "dacs3:agreement:122" },
      contentHash: AGREEMENT_HASH,
    },
    agreementHash: AGREEMENT_HASH,
    paymentPhaseIndex: 3,
    orchestrator: "did:demos:orchestrator",
    payer: {
      primaryClaim: BUYER,
      payingKey: "0x1111111111111111111111111111111111111111",
    },
    payee: {
      primaryClaim: SELLER,
      receivingKey: "0x2222222222222222222222222222222222222222",
    },
    paymentAmount: { amount: "5", currency: "USDC" },
    rail: {
      railId: "rail-x402-base",
      railVersion: 3,
      railRegistryVersion: 7,
      descriptorHash: "c".repeat(64),
      railType: "x402",
      handler: "pay-x402",
      asset: "USDC",
      network: "eip155:8453",
      finality: { model: "block-depth", finalityBlocks: 12 },
    },
  };
}

function inertSettlementProvider(): SessionSettlementVerificationProvider {
  return {
    authenticateContext: vi.fn(() => ({ disposition: "pass" as const })),
    verifyEvidenceAnchor: vi.fn(() => ({ disposition: "pass" as const })),
    resolveNativeProof: vi.fn(() => ({ disposition: "absent" as const })),
    revalidateSettlement: vi.fn(() => ({
      disposition: "indeterminate" as const,
      reason: "mocked at module boundary",
    })),
    evidence: {
      resolvePublicKey: vi.fn(async () => null),
      verify: vi.fn(async () => false),
    },
  };
}

interface FixtureState {
  requestResolution:
    | { disposition: "present"; value: CompletedSellerBundleCounterSignatureRequest }
    | { disposition: "absent" | "rejected" | "indeterminate"; reason: string };
  sellerResolution:
    | { disposition: "present"; value: FinalizedSellerBundle }
    | { disposition: "absent" | "rejected" | "indeterminate"; reason: string };
  counterSignature?: BundleSignature;
  otherCounterSignatures: BundleSignature[];
  counterSignatureSetDisposition?: {
    disposition: "absent" | "rejected" | "indeterminate";
    reason: string;
  };
  anchored?: AnchoredBuyerBundle;
  binding?: BundleBinding;
  signatures: Map<string, string>;
  fences: Array<{ effect: string; fence: BuyerBundleEffectFence }>;
}

interface Fixture {
  input: DurableBuyerBundleFinalizationInput;
  provider: DurableBuyerBundleFinalizationProvider;
  durability: BuyerBundleFinalizationDurability;
  state: FixtureState;
  store: ReturnType<typeof createInMemoryFencedSessionStore>;
  request: CompletedSellerBundleCounterSignatureRequest;
  sellerFinalization: FinalizedSellerBundle;
  orchestratorSignature?: BundleSignature;
}

async function fixture(
  mapping: "pure" | "write-input" = "pure",
  distinctOrchestrator = false,
): Promise<Fixture> {
  const copies = bundleCopies(distinctOrchestrator);
  const request = requestFor(copies.sellerBundle, distinctOrchestrator);
  const sellerHash = attestationBundleHash(copies.sellerBundle);
  const sellerLogicalAddress = bundleAddress(JOB_ID, "seller");
  const sellerNativeAddress = `stor-${"9".repeat(40)}`;
  const sellerFinalization: FinalizedSellerBundle = {
    state: "finalised",
    logicalAddress: sellerLogicalAddress,
    nativeAddress: sellerNativeAddress,
    bundleContentHash: sellerHash,
    sellerBundle: copies.sellerBundle,
    buyerBundle: copies.buyerBundle,
    ...(copies.orchestratorBundle
      ? { orchestratorBundle: copies.orchestratorBundle }
      : {}),
    anchorReceipt: receipt(sellerLogicalAddress, sellerNativeAddress, sellerHash),
    anchorTx: "test:seller-anchor-tx",
    resumedBundle: false,
    resumedBinding: false,
  };
  const state: FixtureState = {
    requestResolution: { disposition: "present", value: request },
    sellerResolution: { disposition: "present", value: sellerFinalization },
    otherCounterSignatures: copies.orchestratorSignature
      ? [copies.orchestratorSignature]
      : [],
    signatures: new Map(),
    fences: [],
  };
  const recordFence = (effect: string, fence: Readonly<BuyerBundleEffectFence>) => {
    state.fences.push({ effect, fence: structuredClone(fence) });
  };
  const signer = vi.fn((bytes: Uint8Array, fence: Readonly<BuyerBundleEffectFence>) => {
    recordFence("sign", fence);
    const value = Buffer.from(
      ed25519Sign(bytes, privateKeyFromSeed(BUYER_SEED)),
    ).toString("base64url");
    state.signatures.set(fence.idempotencyKey, value);
    return value;
  });
  const agreement = {
    jobId: JOB_ID,
    contentHash: AGREEMENT_HASH,
    buyer: { primaryClaim: BUYER, bundleHash: BUYER_HASH },
    seller: { primaryClaim: SELLER, bundleHash: SELLER_HASH },
  };
  const sellerVerificationInput = {
    agreement,
    seller: { primaryClaim: SELLER, bundleHash: SELLER_HASH },
  } as unknown as VerifyCompletedSellerBundleCounterSignatureRequestInput;
  const context = settlementContext();
  const settlement = {} as FinalizedSessionSettlement;
  const input: DurableBuyerBundleFinalizationInput = {
    sellerVerificationInput,
    settlementContext: context,
    settlement,
    buyer: { primaryClaim: BUYER, bundleHash: BUYER_HASH, signer },
  };
  const resolveBuyerBundle = vi.fn((): BuyerBundleLookup =>
    state.anchored
      ? { disposition: "present", anchored: structuredClone(state.anchored) }
      : { disposition: "absent" },
  );
  const provider: DurableBuyerBundleFinalizationProvider = {
    mapping,
    bundleCopyVerifier: {
      resolvePublicKey: vi.fn(async (claim: string) =>
        claim === BUYER
          ? rawPublicKey(publicKeyFromSeed(BUYER_SEED))
          : claim === SELLER
            ? rawPublicKey(publicKeyFromSeed(SELLER_SEED))
            : claim === ORCHESTRATOR
              ? rawPublicKey(publicKeyFromSeed(ORCHESTRATOR_SEED))
            : null,
      ),
      verify: vi.fn(
        async (message: Uint8Array, signature: Uint8Array, key: Uint8Array) =>
          ed25519Verify(message, signature, publicKeyFromRaw(key)),
      ),
    },
    compositeVerificationDeps: {
      resolveRecipe: vi.fn(async () => null),
      isRecipeSignerAuthorized: vi.fn(async () => false),
      isVerifyResultSignerAuthorized: vi.fn(async () => false),
      resolvePublicKey: vi.fn(async () => null),
      verify: vi.fn(async () => false),
      verifyAuthorityAttestation: vi.fn(async () => "unresolved" as const),
    },
    resolveDependency: vi.fn(() => ({ disposition: "absent" as const })),
    verifyDependencyReceipt: vi.fn(() => "indeterminate" as const),
    verifyDependencyBinding: vi.fn(() => "indeterminate" as const),
    verifyListingPublisherIdentityLinkage: vi.fn(() => "indeterminate" as const),
    verifyVetRequirementProvenance: vi.fn(() => "indeterminate" as const),
    resolveSellerBundle: vi.fn(() => ({ disposition: "absent" as const })),
    verifyBundleAnchorReceipt: vi.fn(() => "valid" as const),
    resolveBuyerBundle,
    submitBuyerBundle: vi.fn(
      (
        logicalAddress: string,
        bundle: Readonly<FaultAttestationBundle>,
        fence: Readonly<BuyerBundleEffectFence>,
      ) => {
        recordFence("anchor", fence);
        const stored = structuredClone(bundle) as FaultAttestationBundle;
        const hash = attestationBundleHash(stored);
        const nativeAddress = `stor-${"8".repeat(40)}`;
        state.anchored = {
          bundle: stored,
          nativeAddress,
          anchorTx: "test:buyer-anchor-tx",
          anchorReceipt: receipt(logicalAddress, nativeAddress, hash),
        };
      },
    ),
    resolveBundleBinding: vi.fn((): SellerBundleBindingLookup =>
      state.binding
        ? { disposition: "present", binding: structuredClone(state.binding) }
        : { disposition: "absent" },
    ),
    publishBundleBinding: vi.fn(
      (
        binding: Readonly<BundleBinding>,
        fence: Readonly<BuyerBundleEffectFence>,
      ) => {
        recordFence("binding-publication", fence);
        state.binding = structuredClone(binding);
        return { disposition: "published" as const };
      },
    ),
    verifyBundleBinding: vi.fn(() => "valid" as const),
  };
  const store = createInMemoryFencedSessionStore();
  await store.create({
    jobId: JOB_ID,
    agreementHash: AGREEMENT_HASH,
    phase: "settled",
    now: NOW,
  });
  let clock = NOW + 1;
  const durability: BuyerBundleFinalizationDurability = {
    store,
    workerId: "buyer-worker-a",
    leaseTtlMs: 60_000,
    leaseNowMs: () => clock++,
    settlementVerification: inertSettlementProvider(),
    transport: {
      resolveSellerRequest: vi.fn(() => structuredClone(state.requestResolution)),
      publishCounterSignature: vi.fn((publication, fence) => {
        recordFence("counter-publication", fence);
        state.counterSignature = structuredClone(publication.signature);
        return { disposition: "published" as const };
      }),
      resolveCounterSignatures: vi.fn(() =>
        state.counterSignatureSetDisposition ?? (state.counterSignature
          ? {
              disposition: "present" as const,
              value: [
                structuredClone(state.counterSignature),
                ...structuredClone(state.otherCounterSignatures),
              ],
            }
          : {
              disposition: "absent" as const,
              reason: "buyer signature is not published",
            }),
      ),
      resolveSellerFinalization: vi.fn(() => structuredClone(state.sellerResolution)),
    },
    reconcileSignature: vi.fn(({ fence }) => {
      recordFence("signature-reconciliation", fence);
      const value = state.signatures.get(fence.idempotencyKey);
      return value === undefined
        ? { disposition: "authoritatively-absent" as const, reason: "not signed" }
        : { disposition: "signed" as const, value };
    }),
    reconcileCounterSignaturePublication: vi.fn(({ signature: _signature }, fence) => {
      recordFence("counter-publication-reconciliation", fence);
      return state.counterSignature
        ? { disposition: "present" as const, signature: structuredClone(state.counterSignature) }
        : { disposition: "authoritatively-absent" as const, reason: "not published" };
    }),
    reconcileBuyerBundleAnchor: vi.fn(({ logicalAddress, bundleContentHash }, fence) => {
      recordFence("anchor-reconciliation", fence);
      const anchored = state.anchored;
      return anchored !== undefined &&
          anchored.anchorReceipt.logicalAddress === logicalAddress &&
          anchored.anchorReceipt.contentHash === bundleContentHash
        ? { disposition: "present" as const }
        : { disposition: "authoritatively-absent" as const, reason: "not anchored" };
    }),
    reconcileBindingPublication: vi.fn((binding, fence) => {
      recordFence("binding-publication-reconciliation", fence);
      return state.binding && canonicalize(state.binding) === canonicalize(binding)
        ? { disposition: "published" as const }
        : { disposition: "authoritatively-absent" as const, reason: "not published" };
    }),
  };
  return {
    input,
    provider,
    durability,
    state,
    store,
    request,
    sellerFinalization,
    ...(copies.orchestratorSignature
      ? { orchestratorSignature: copies.orchestratorSignature }
      : {}),
  };
}

beforeEach(() => {
  protocolMocks.verifySettlement.mockReset();
  protocolMocks.verifyRequest.mockReset();
  protocolMocks.verifySellerFinalization.mockReset();
  protocolMocks.verifySettlement.mockImplementation(async (_context, settlement, _provider, mode) => ({
    disposition: "verified" as const,
    value: {
      state: "verified" as const,
      mode,
      outcome: "success" as const,
      contextHash: "5".repeat(64),
      evidenceHash: "6".repeat(64),
      nativeProofHash: "7".repeat(64),
      nativeObservationHash: mode === "recovery"
        ? "b".repeat(64)
        : "4".repeat(64),
      nativeObservation: {
        observationVersion: "1" as const,
        kind: "evm-transfer",
        observedAt: NOW,
        finality: {
          model: "block-depth" as const,
          finalityBlocks: 12,
          finalityObservedAt: NOW,
        },
        sessionBinding: {
          disposition: "established" as const,
          kind: "eip3009",
          bindingHash: "3".repeat(64),
        },
        details: { observedHeadBlockNumber: mode === "recovery" ? 109 : 101 },
      },
      identityHash: "8".repeat(64),
      observationHash: mode === "recovery" ? "a".repeat(64) : "9".repeat(64),
      settlementBinding: {
        jobId: JOB_ID,
        railId: "rail-x402-base",
        phaseIndex: 3,
        settlementId: SETTLEMENT_ID,
      },
      settlement: structuredClone(settlement),
    },
  }));
  protocolMocks.verifyRequest.mockImplementation(
    async (_input, supplied) => structuredClone(supplied),
  );
  protocolMocks.verifySellerFinalization.mockImplementation(
    async (_input, supplied) => structuredClone(supplied),
  );
});

describe("durable buyer bundle finalization", () => {
  test.each(["pure", "write-input"] as const)(
    "finalizes the authenticated %s mapping with exact primitive checkpoints",
    async (mapping) => {
      const f = await fixture(mapping);
      const progress = await advanceCompletedBuyerBundleDurable(
        f.input,
        f.provider,
        f.durability,
      );

      expect(progress.disposition).toBe("finalised");
      if (progress.disposition !== "finalised") return;
      expect(progress.recovered).toBe(false);
      expect(progress.result.binding !== undefined).toBe(mapping === "write-input");
      expect(progress.completion.sellerClosure.result).toEqual(f.sellerFinalization);
      expect(progress.completion.sellerClosure.verificationInput)
        .toMatchObject({ counterSignatures: [f.state.counterSignature] });
      expect(f.state.counterSignature).toEqual(
        progress.result.buyerBundle.signatures.find(({ party }) => party === BUYER),
      );
      const loaded = await f.store.load(JOB_ID);
      expect(loaded.status).toBe("ok");
      if (loaded.status !== "ok") return;
      expect(loaded.record.phase).toBe("buyer:finalised");
      expect(loaded.record.lease).toBeUndefined();
      const settlementCheckpoint = [...loaded.record.checkpoints].reverse().find(
        ({ key }) => key === buyerBundleFinalizationCheckpointKey.settlement,
      );
      expect(settlementCheckpoint).toMatchObject({
        stage: "outcome",
        data: {
          settlementObservationHash: "9".repeat(64),
          settlementNativeObservationHash: "4".repeat(64),
        },
      });
      for (const checkpoint of loaded.record.checkpoints) {
        for (const value of Object.values(checkpoint.data ?? {})) {
          expect(["string", "number", "boolean"]).toContain(typeof value);
        }
      }
      expect(new Set(f.state.fences.map(({ fence }) => fence.owner))).toEqual(
        new Set(["buyer-worker-a"]),
      );
      expect(f.state.fences.every(({ fence }) => fence.generation === 1)).toBe(true);
      expect(f.state.fences.every(({ fence }) => fence.idempotencyKey.length > 20)).toBe(true);
    },
  );

  test("authenticates and durably retains the complete buyer plus distinct-orchestrator signer set", async () => {
    const f = await fixture("pure", true);
    const progress = await advanceCompletedBuyerBundleDurable(
      f.input,
      f.provider,
      f.durability,
    );

    expect(progress.disposition).toBe("finalised");
    if (progress.disposition !== "finalised") return;
    expect(f.durability.transport.resolveCounterSignatures).toHaveBeenCalledOnce();
    const verificationInputs = protocolMocks.verifySellerFinalization.mock.calls.map(
      ([input]) => input as { counterSignatures: BundleSignature[] },
    );
    expect(verificationInputs.length).toBeGreaterThanOrEqual(2);
    for (const input of verificationInputs) {
      expect(input.counterSignatures.map(({ party }) => party)).toEqual([
        BUYER,
        ORCHESTRATOR,
      ]);
      expect(input.counterSignatures[1]).toEqual(f.orchestratorSignature);
    }
    expect(progress.result.publications).toMatchObject({
      buyer: {
        role: "buyer",
        logicalAddress: bundleAddress(JOB_ID, "buyer"),
        nativeAddress: progress.result.nativeAddress,
      },
      seller: {
        role: "seller",
        logicalAddress: bundleAddress(JOB_ID, "seller"),
        nativeAddress: f.sellerFinalization.nativeAddress,
      },
    });
    const loaded = await f.store.load(JOB_ID);
    expect(loaded.status).toBe("ok");
    if (loaded.status !== "ok") return;
    const checkpoint = [...loaded.record.checkpoints].reverse().find(
      ({ key }) => key === buyerBundleFinalizationCheckpointKey.counterSignatureSet,
    );
    expect(checkpoint?.stage).toBe("outcome");
    const encoded = String(checkpoint?.data?.counterSignatureSet);
    const retained = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as
      BundleSignature[];
    expect(retained.map(({ party }) => party)).toEqual([BUYER, ORCHESTRATOR]);
  });

  test("waits for a missing distinct-orchestrator signature without resolving or anchoring finalization", async () => {
    const f = await fixture("pure", true);
    f.state.counterSignatureSetDisposition = {
      disposition: "absent",
      reason: "orchestrator signature is not published",
    };

    await expect(
      advanceCompletedBuyerBundleDurable(f.input, f.provider, f.durability),
    ).resolves.toEqual({
      disposition: "waiting",
      stage: "counter-signature-set",
      reason: "orchestrator signature is not published",
    });
    expect(f.durability.transport.resolveSellerFinalization).not.toHaveBeenCalled();
    expect(f.state.anchored).toBeUndefined();
  });

  test.each([
    ["substituted buyer", (f: Fixture) => {
      f.state.counterSignature = {
        ...structuredClone(f.state.counterSignature!),
        value: Buffer.from(new Uint8Array(64).fill(11)).toString("base64url"),
      };
    }],
    ["duplicate", (f: Fixture) => {
      f.state.otherCounterSignatures = [structuredClone(f.state.counterSignature!)];
    }],
    ["unknown", (f: Fixture) => {
      f.state.otherCounterSignatures = [{
        ...structuredClone(f.orchestratorSignature!),
        party: "did:demos:unknown",
      }];
    }],
    ["invalid crypto", (f: Fixture) => {
      f.state.otherCounterSignatures = [{
        ...structuredClone(f.orchestratorSignature!),
        value: Buffer.from(
          ed25519Sign(f.request.signedBytes, privateKeyFromSeed(BUYER_SEED)),
        ).toString("base64url"),
      }];
    }],
  ] as const)(
    "rejects a %s complete counter-signature set before seller resolution or buyer anchoring",
    async (_subject, mutate) => {
      const f = await fixture("pure", true);
      const ordinaryResolve = f.durability.transport.resolveCounterSignatures;
      f.durability.transport.resolveCounterSignatures = vi.fn((input) => {
        const result = ordinaryResolve(input);
        mutate(f);
        if (result instanceof Promise) {
          return result.then(() => ({
            disposition: "present" as const,
            value: [
              structuredClone(f.state.counterSignature!),
              ...structuredClone(f.state.otherCounterSignatures),
            ],
          }));
        }
        return {
          disposition: "present" as const,
          value: [
            structuredClone(f.state.counterSignature!),
            ...structuredClone(f.state.otherCounterSignatures),
          ],
        };
      });

      await expect(
        advanceCompletedBuyerBundleDurable(f.input, f.provider, f.durability),
      ).resolves.toMatchObject({
        disposition: "rejected",
        stage: "counter-signature-set",
      });
      expect(f.durability.transport.resolveSellerFinalization).not.toHaveBeenCalled();
      expect(f.state.anchored).toBeUndefined();
    },
  );

  test("reauthenticates the retained complete signer-set WAL without transport re-resolution", async () => {
    const f = await fixture("pure", true);
    f.state.sellerResolution = {
      disposition: "absent",
      reason: "seller finalization pending",
    };
    await expect(
      advanceCompletedBuyerBundleDurable(f.input, f.provider, f.durability),
    ).resolves.toEqual({
      disposition: "waiting",
      stage: "seller-finalisation",
      reason: "seller finalization pending",
    });
    expect(f.durability.transport.resolveCounterSignatures).toHaveBeenCalledOnce();
    f.state.otherCounterSignatures = [];
    f.state.sellerResolution = {
      disposition: "present",
      value: f.sellerFinalization,
    };
    vi.mocked(f.durability.transport.resolveCounterSignatures).mockClear();

    await expect(
      advanceCompletedBuyerBundleDurable(
        f.input,
        f.provider,
        { ...f.durability, workerId: "buyer-worker-b" },
      ),
    ).resolves.toMatchObject({ disposition: "finalised" });
    expect(f.durability.transport.resolveCounterSignatures).not.toHaveBeenCalled();
    const finalInput = protocolMocks.verifySellerFinalization.mock.calls.at(-1)?.[0] as {
      counterSignatures: BundleSignature[];
    };
    expect(finalInput.counterSignatures.map(({ party }) => party)).toEqual([
      BUYER,
      ORCHESTRATOR,
    ]);
  });

  test("rejects cryptographic tamper of terminal complete signer-set WAL without demotion", async () => {
    const f = await fixture("pure", true);
    await expect(
      advanceCompletedBuyerBundleDurable(f.input, f.provider, f.durability),
    ).resolves.toMatchObject({ disposition: "finalised" });
    const tamperingStore = {
      ...f.store,
      load: async (jobId: string) => {
        const loaded = await f.store.load(jobId);
        if (loaded.status !== "ok" || loaded.record.phase !== "buyer:finalised") {
          return loaded;
        }
        const checkpoint = [...loaded.record.checkpoints].reverse().find(
          ({ key }) => key === buyerBundleFinalizationCheckpointKey.counterSignatureSet,
        );
        if (checkpoint?.data) {
          const signatures = JSON.parse(
            Buffer.from(
              String(checkpoint.data.counterSignatureSet),
              "base64url",
            ).toString("utf8"),
          ) as BundleSignature[];
          signatures[1] = {
            ...signatures[1]!,
            value: Buffer.from(new Uint8Array(64).fill(12)).toString("base64url"),
          };
          const json = canonicalize(signatures);
          checkpoint.data.counterSignatureSet = Buffer.from(json, "utf8").toString(
            "base64url",
          );
          checkpoint.data.counterSignatureSetHash = sha256Hex(json);
        }
        return loaded;
      },
    };

    await expect(
      advanceCompletedBuyerBundleDurable(
        f.input,
        f.provider,
        { ...f.durability, store: tamperingStore, workerId: "buyer-worker-b" },
      ),
    ).resolves.toMatchObject({
      disposition: "rejected",
      stage: "counter-signature-set",
    });
    const underlying = await f.store.load(JOB_ID);
    expect(underlying).toMatchObject({
      status: "ok",
      record: { phase: "buyer:finalised" },
    });
  });

  test("returns waiting without signing when the seller request is absent", async () => {
    const f = await fixture();
    f.state.requestResolution = {
      disposition: "absent",
      reason: "seller has not published the request",
    };

    await expect(
      advanceCompletedBuyerBundleDurable(f.input, f.provider, f.durability),
    ).resolves.toEqual({
      disposition: "waiting",
      stage: "seller-request",
      reason: "seller has not published the request",
    });
    expect(f.state.fences).toHaveLength(0);
    const status = await getBuyerBundleFinalizationStatus(f.store, JOB_ID);
    expect(status).toMatchObject({ status: "ok", phase: "settled" });
    if (status.status === "ok") {
      expect(status.lease).toBeUndefined();
      expect(status.checkpoints.request).toBe("not-started");
    }
  });

  test("durably publishes once, waits for the exact seller result, then resumes at a higher generation", async () => {
    const f = await fixture();
    f.state.sellerResolution = {
      disposition: "absent",
      reason: "seller has not finalized",
    };

    await expect(
      advanceCompletedBuyerBundleDurable(f.input, f.provider, f.durability),
    ).resolves.toEqual({
      disposition: "waiting",
      stage: "seller-finalisation",
      reason: "seller has not finalized",
    });
    const before = [...f.state.fences];
    expect(before.filter(({ effect }) => effect === "sign")).toHaveLength(1);
    expect(before.filter(({ effect }) => effect === "counter-publication")).toHaveLength(1);
    f.state.sellerResolution = {
      disposition: "present",
      value: f.sellerFinalization,
    };

    const resumed = await advanceCompletedBuyerBundleDurable(
      f.input,
      f.provider,
      { ...f.durability, workerId: "buyer-worker-b" },
    );
    expect(resumed.disposition).toBe("finalised");
    expect(f.state.fences.filter(({ effect }) => effect === "sign")).toHaveLength(1);
    expect(
      f.state.fences.filter(({ effect }) => effect === "counter-publication"),
    ).toHaveLength(1);
    const anchorFence = f.state.fences.find(({ effect }) => effect === "anchor")?.fence;
    expect(anchorFence).toMatchObject({ owner: "buyer-worker-b", generation: 2 });
    expect(protocolMocks.verifySettlement.mock.calls.map((call) => call[3])).toEqual([
      "initial",
      "recovery",
    ]);
    expect(protocolMocks.verifyRequest).toHaveBeenCalledTimes(4);
  });

  test("reconciles an ambiguous counter-signature publication without blind redrive", async () => {
    const f = await fixture();
    const ordinaryPublish = f.durability.transport.publishCounterSignature;
    f.durability.transport.publishCounterSignature = vi.fn(async (input, fence) => {
      await ordinaryPublish(input, fence);
      throw new Error("crash after accepted publication");
    });

    await expect(
      advanceCompletedBuyerBundleDurable(f.input, f.provider, f.durability),
    ).resolves.toMatchObject({
      disposition: "indeterminate",
      stage: "counter-signature-publication",
    });
    expect(f.durability.transport.publishCounterSignature).toHaveBeenCalledOnce();
    const firstFence = f.state.fences.find(
      ({ effect }) => effect === "counter-publication",
    )?.fence;

    const recovered = await advanceCompletedBuyerBundleDurable(
      f.input,
      f.provider,
      { ...f.durability, workerId: "buyer-worker-b" },
    );
    expect(recovered.disposition).toBe("finalised");
    expect(f.durability.transport.publishCounterSignature).toHaveBeenCalledOnce();
    const reconcileFence = f.state.fences.find(
      ({ effect }) => effect === "counter-publication-reconciliation",
    )?.fence;
    expect(reconcileFence?.idempotencyKey).toBe(firstFence?.idempotencyKey);
    expect(reconcileFence).toMatchObject({ owner: "buyer-worker-b", generation: 2 });
  });

  test("rejects a substituted counter-signature readback without republishing", async () => {
    const f = await fixture();
    const ordinaryPublish = f.durability.transport.publishCounterSignature;
    f.durability.transport.publishCounterSignature = vi.fn(async (input, fence) => {
      await ordinaryPublish(input, fence);
      throw new Error("lost publication acknowledgement");
    });
    await expect(
      advanceCompletedBuyerBundleDurable(f.input, f.provider, f.durability),
    ).resolves.toMatchObject({ disposition: "indeterminate" });
    f.state.counterSignature = {
      ...f.state.counterSignature!,
      value: Buffer.from(new Uint8Array(64).fill(5)).toString("base64url"),
    };

    await expect(
      advanceCompletedBuyerBundleDurable(
        f.input,
        f.provider,
        { ...f.durability, workerId: "buyer-worker-b" },
      ),
    ).rejects.toThrow("substituted");
    expect(f.durability.transport.publishCounterSignature).toHaveBeenCalledOnce();
  });

  test("recovers a signature created before a crash without signing it twice", async () => {
    const f = await fixture();
    const ordinarySigner = f.input.buyer.signer;
    f.input.buyer.signer = vi.fn((bytes, fence) => {
      const value = Buffer.from(
        ed25519Sign(bytes, privateKeyFromSeed(BUYER_SEED)),
      ).toString("base64url");
      f.state.signatures.set(fence.idempotencyKey, value);
      f.state.fences.push({ effect: "sign-after-effect-crash", fence: structuredClone(fence) });
      throw new Error("crash after detached signature creation");
    });

    await expect(
      advanceCompletedBuyerBundleDurable(f.input, f.provider, f.durability),
    ).resolves.toMatchObject({
      disposition: "indeterminate",
      stage: "counter-signature",
    });
    f.input.buyer.signer = ordinarySigner;
    const recovered = await advanceCompletedBuyerBundleDurable(
      f.input,
      f.provider,
      { ...f.durability, workerId: "buyer-worker-b" },
    );

    expect(recovered.disposition).toBe("finalised");
    const originalFence = f.state.fences.find(
      ({ effect }) => effect === "sign-after-effect-crash",
    )?.fence;
    const reconciliationFence = f.state.fences.find(
      ({ effect }) => effect === "signature-reconciliation",
    )?.fence;
    expect(reconciliationFence?.idempotencyKey).toBe(originalFence?.idempotencyKey);
    expect(reconciliationFence).toMatchObject({ generation: 2, owner: "buyer-worker-b" });
    expect(f.state.fences.filter(({ effect }) => effect === "sign")).toHaveLength(0);
  });

  test("redrives a pre-effect signer failure only after authoritative absence", async () => {
    const f = await fixture();
    const ordinarySigner = f.input.buyer.signer;
    f.input.buyer.signer = vi.fn((_bytes, fence) => {
      f.state.fences.push({ effect: "sign-before-effect-crash", fence: structuredClone(fence) });
      throw new Error("signer unavailable before effect");
    });

    await expect(
      advanceCompletedBuyerBundleDurable(f.input, f.provider, f.durability),
    ).resolves.toMatchObject({
      disposition: "indeterminate",
      stage: "counter-signature",
    });
    f.input.buyer.signer = ordinarySigner;
    await expect(
      advanceCompletedBuyerBundleDurable(
        f.input,
        f.provider,
        { ...f.durability, workerId: "buyer-worker-b" },
      ),
    ).resolves.toMatchObject({ disposition: "finalised" });

    const failedFence = f.state.fences.find(
      ({ effect }) => effect === "sign-before-effect-crash",
    )?.fence;
    const reconcileFence = f.state.fences.find(
      ({ effect }) => effect === "signature-reconciliation",
    )?.fence;
    const retryFence = f.state.fences.find(({ effect }) => effect === "sign")?.fence;
    expect(reconcileFence?.idempotencyKey).toBe(failedFence?.idempotencyKey);
    expect(retryFence?.idempotencyKey).toBe(failedFence?.idempotencyKey);
    expect(retryFence).toMatchObject({ generation: 2, owner: "buyer-worker-b" });
  });

  test("serializes overlapping workers with one live generation-fenced lease", async () => {
    const f = await fixture();
    const ordinarySigner = f.input.buyer.signer;
    let releaseSigner!: () => void;
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseSigner = resolve;
    });
    f.input.buyer.signer = vi.fn(async (bytes, fence) => {
      signalEntered();
      await blocked;
      return ordinarySigner(bytes, fence);
    });

    const first = advanceCompletedBuyerBundleDurable(
      f.input,
      f.provider,
      f.durability,
    );
    await entered;
    const overlapping = await advanceCompletedBuyerBundleDurable(
      f.input,
      f.provider,
      { ...f.durability, workerId: "buyer-worker-b" },
    );
    expect(overlapping).toMatchObject({
      disposition: "indeterminate",
      stage: "lease",
    });
    releaseSigner();
    await expect(first).resolves.toMatchObject({ disposition: "finalised" });
    expect(f.state.fences.filter(({ effect }) => effect === "sign")).toHaveLength(1);
  });

  test("does not redrive an unresolved anchor intent until reconciliation proves absence", async () => {
    const f = await fixture();
    const ordinarySubmit = f.provider.submitBuyerBundle;
    f.provider.submitBuyerBundle = vi.fn((_logicalAddress, _bundle, fence) => {
      f.state.fences.push({ effect: "anchor-before-effect-crash", fence: structuredClone(fence) });
      throw new Error("anchor writer failed before submission");
    });

    await expect(
      advanceCompletedBuyerBundleDurable(f.input, f.provider, f.durability),
    ).resolves.toMatchObject({
      disposition: "indeterminate",
      stage: "buyer-bundle-anchor",
    });
    f.provider.submitBuyerBundle = ordinarySubmit;
    f.durability.reconcileBuyerBundleAnchor = vi.fn((_input, fence) => {
      f.state.fences.push({ effect: "anchor-reconciliation-indeterminate", fence: structuredClone(fence) });
      return { disposition: "indeterminate" as const, reason: "anchor lookup unavailable" };
    });

    await expect(
      advanceCompletedBuyerBundleDurable(
        f.input,
        f.provider,
        { ...f.durability, workerId: "buyer-worker-b" },
      ),
    ).resolves.toMatchObject({
      disposition: "indeterminate",
      stage: "buyer-bundle-anchor",
    });
    expect(f.state.anchored).toBeUndefined();
    f.durability.reconcileBuyerBundleAnchor = vi.fn((_input, fence) => {
      f.state.fences.push({ effect: "anchor-reconciliation-absent", fence: structuredClone(fence) });
      return { disposition: "authoritatively-absent" as const, reason: "anchor absent" };
    });

    await expect(
      advanceCompletedBuyerBundleDurable(
        f.input,
        f.provider,
        { ...f.durability, workerId: "buyer-worker-c" },
      ),
    ).resolves.toMatchObject({ disposition: "finalised" });
    const keys = f.state.fences
      .filter(({ effect }) => effect.startsWith("anchor"))
      .map(({ fence }) => fence.idempotencyKey);
    expect(new Set(keys).size).toBe(1);
    expect(f.state.fences.find(({ effect }) => effect === "anchor")?.fence).toMatchObject({
      generation: 3,
      owner: "buyer-worker-c",
    });
  });

  test("adopts exact anchor and binding readback after a post-effect crash without republishing", async () => {
    const f = await fixture("write-input");
    const ordinaryPublish = f.provider.publishBundleBinding!;
    const ordinaryResolve = f.provider.resolveBundleBinding!;
    let obscurePublishedBinding = true;
    f.provider.publishBundleBinding = vi.fn(async (binding, fence) => {
      await ordinaryPublish(binding, fence);
      throw new Error("crash after binding publication");
    });
    f.provider.resolveBundleBinding = vi.fn((logicalAddress, signer) => {
      if (f.state.binding && obscurePublishedBinding) {
        return { disposition: "indeterminate" as const, reason: "read replica lag" };
      }
      return ordinaryResolve(logicalAddress, signer);
    });

    await expect(
      advanceCompletedBuyerBundleDurable(f.input, f.provider, f.durability),
    ).resolves.toMatchObject({
      disposition: "indeterminate",
      stage: "buyer-bundle-binding",
    });
    expect(f.provider.publishBundleBinding).toHaveBeenCalledOnce();
    const firstEffectCount = f.state.fences.length;
    obscurePublishedBinding = false;

    const recovered = await advanceCompletedBuyerBundleDurable(
      f.input,
      f.provider,
      { ...f.durability, workerId: "buyer-worker-b" },
    );
    expect(recovered.disposition).toBe("finalised");
    expect(f.provider.publishBundleBinding).toHaveBeenCalledOnce();
    expect(
      f.state.fences.slice(firstEffectCount).some(
        ({ effect }) => effect === "anchor" || effect === "binding-publication",
      ),
    ).toBe(false);
  });

  test("recovers an exact binding signature after a crash without asking the buyer to sign again", async () => {
    const f = await fixture("write-input");
    const ordinarySigner = f.input.buyer.signer;
    let invocation = 0;
    f.input.buyer.signer = vi.fn(async (bytes, fence) => {
      invocation += 1;
      if (invocation === 1) return ordinarySigner(bytes, fence);
      const value = Buffer.from(
        ed25519Sign(bytes, privateKeyFromSeed(BUYER_SEED)),
      ).toString("base64url");
      f.state.signatures.set(fence.idempotencyKey, value);
      f.state.fences.push({
        effect: "binding-sign-after-effect-crash",
        fence: structuredClone(fence),
      });
      throw new Error("crash after binding signature creation");
    });

    await expect(
      advanceCompletedBuyerBundleDurable(f.input, f.provider, f.durability),
    ).resolves.toMatchObject({
      disposition: "indeterminate",
      stage: "buyer-bundle-binding",
    });
    f.input.buyer.signer = ordinarySigner;
    await expect(
      advanceCompletedBuyerBundleDurable(
        f.input,
        f.provider,
        { ...f.durability, workerId: "buyer-worker-b" },
      ),
    ).resolves.toMatchObject({ disposition: "finalised" });

    expect(f.state.fences.filter(({ effect }) => effect === "sign")).toHaveLength(1);
    const crashed = f.state.fences.find(
      ({ effect }) => effect === "binding-sign-after-effect-crash",
    )?.fence;
    expect(
      f.state.fences.some(
        ({ effect, fence }) =>
          effect === "signature-reconciliation" &&
          fence.idempotencyKey === crashed?.idempotencyKey &&
          fence.generation === 2,
      ),
    ).toBe(true);
  });

  test.each([
    ["absent", "waiting"],
    ["rejected", "rejected"],
    ["indeterminate", "indeterminate"],
  ] as const)(
    "preserves the %s seller-finalization transport state as %s",
    async (transportDisposition, expectedDisposition) => {
      const f = await fixture();
      f.state.sellerResolution = {
        disposition: transportDisposition,
        reason: `seller result is ${transportDisposition}`,
      };
      await expect(
        advanceCompletedBuyerBundleDurable(f.input, f.provider, f.durability),
      ).resolves.toEqual({
        disposition: expectedDisposition,
        stage: "seller-finalisation",
        reason: `seller result is ${transportDisposition}`,
      });
      expect(f.state.anchored).toBeUndefined();
    },
  );

  test("rejects a seller request that substitutes the required buyer before signing", async () => {
    const f = await fixture();
    f.state.requestResolution = {
      disposition: "present",
      value: {
        ...structuredClone(f.request),
        requiredCounterSigners: ["did:demos:other-buyer"],
      },
    };

    await expect(
      advanceCompletedBuyerBundleDurable(f.input, f.provider, f.durability),
    ).rejects.toThrow("does not require this buyer");
    expect(f.state.fences).toHaveLength(0);
  });

  test("performs no signer or publication effect when seller-request authentication fails", async () => {
    const f = await fixture();
    protocolMocks.verifyRequest.mockRejectedValueOnce(
      new DacsError("seller request authentication failed"),
    );

    await expect(
      advanceCompletedBuyerBundleDurable(f.input, f.provider, f.durability),
    ).rejects.toThrow("seller request authentication failed");
    expect(f.state.fences).toHaveLength(0);
    expect(f.state.counterSignature).toBeUndefined();
  });

  test("rejects seller-result substitution before the buyer anchor", async () => {
    const f = await fixture();
    const substituted = structuredClone(f.sellerFinalization);
    substituted.buyerBundle.signatures = substituted.buyerBundle.signatures.map(
      (signature) => signature.party === BUYER
        ? { ...signature, value: Buffer.from(new Uint8Array(64).fill(4)).toString("base64url") }
        : signature,
    );
    f.state.sellerResolution = { disposition: "present", value: substituted };

    await expect(
      advanceCompletedBuyerBundleDurable(f.input, f.provider, f.durability),
    ).rejects.toThrow("substituted the durable buyer signature");
    expect(f.state.anchored).toBeUndefined();
  });

  test("performs no anchor or binding effect when seller-finalization authentication fails", async () => {
    const f = await fixture("write-input");
    protocolMocks.verifySellerFinalization.mockRejectedValueOnce(
      new DacsError("seller finalization authentication failed"),
    );

    await expect(
      advanceCompletedBuyerBundleDurable(f.input, f.provider, f.durability),
    ).rejects.toThrow("seller finalization authentication failed");
    expect(f.state.anchored).toBeUndefined();
    expect(f.state.binding).toBeUndefined();
    expect(
      f.state.fences.some(
        ({ effect }) => effect === "anchor" || effect === "binding-publication",
      ),
    ).toBe(false);
  });

  test.each(["rejected", "indeterminate"] as const)(
    "surfaces a %s settlement verdict before any retained state is trusted",
    async (disposition) => {
      const f = await fixture();
      protocolMocks.verifySettlement.mockResolvedValueOnce({
        disposition,
        reason: `settlement ${disposition}`,
      });
      await expect(
        advanceCompletedBuyerBundleDurable(f.input, f.provider, f.durability),
      ).resolves.toEqual({
        disposition,
        stage: "settlement",
        reason: `settlement ${disposition}`,
      });
      expect(f.state.fences).toHaveLength(0);
    },
  );

  test("requires successful authenticated settlement as a non-authorizing cross-check", async () => {
    const f = await fixture();
    protocolMocks.verifySettlement.mockResolvedValueOnce({
      disposition: "verified",
      value: {
        state: "verified",
        mode: "initial",
        outcome: "failure",
        contextHash: "5".repeat(64),
        evidenceHash: "6".repeat(64),
        nativeProofHash: "7".repeat(64),
        identityHash: "8".repeat(64),
        observationHash: "9".repeat(64),
        settlement: {},
      },
    });

    await expect(
      advanceCompletedBuyerBundleDurable(f.input, f.provider, f.durability),
    ).resolves.toEqual({
      disposition: "rejected",
      stage: "settlement",
      reason: "buyer bundle finalization requires successful settlement",
    });
    expect(f.state.fences).toHaveLength(0);
  });

  test("terminal replay reauthenticates settlement, seller result, and buyer publication read-only", async () => {
    const f = await fixture("write-input");
    const first = await advanceCompletedBuyerBundleDurable(
      f.input,
      f.provider,
      f.durability,
    );
    expect(first.disposition).toBe("finalised");
    const effectCount = f.state.fences.length;
    protocolMocks.verifySettlement.mockClear();
    protocolMocks.verifySellerFinalization.mockClear();

    const replay = await advanceCompletedBuyerBundleDurable(
      f.input,
      f.provider,
      { ...f.durability, workerId: "buyer-worker-b" },
    );

    expect(replay.disposition).toBe("finalised");
    if (replay.disposition === "finalised") {
      expect(replay.recovered).toBe(true);
      expect(replay.completion.sellerClosure.result).toEqual(f.sellerFinalization);
    }
    expect(protocolMocks.verifySettlement).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      "recovery",
    );
    expect(protocolMocks.verifySellerFinalization.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(f.state.fences).toHaveLength(effectCount);
  });

  test("terminal recovery authenticates settlement before reading any retained seller state", async () => {
    const f = await fixture();
    await expect(
      advanceCompletedBuyerBundleDurable(f.input, f.provider, f.durability),
    ).resolves.toMatchObject({ disposition: "finalised" });
    protocolMocks.verifyRequest.mockClear();
    protocolMocks.verifySellerFinalization.mockClear();
    protocolMocks.verifySettlement.mockResolvedValueOnce({
      disposition: "rejected",
      reason: "settlement is no longer established",
    });

    await expect(
      advanceCompletedBuyerBundleDurable(
        f.input,
        f.provider,
        { ...f.durability, workerId: "buyer-worker-b" },
      ),
    ).resolves.toEqual({
      disposition: "rejected",
      stage: "settlement",
      reason: "settlement is no longer established",
    });
    expect(protocolMocks.verifyRequest).not.toHaveBeenCalled();
    expect(protocolMocks.verifySellerFinalization).not.toHaveBeenCalled();
  });

  test("recovers read-only when the process loses the terminal commit acknowledgement", async () => {
    const f = await fixture();
    let injectCrash = true;
    const crashingStore = {
      ...f.store,
      transition: async (input: Parameters<typeof f.store.transition>[0]) => {
        const result = await f.store.transition(input);
        if (injectCrash && input.phase === "buyer:finalised" && result.ok) {
          injectCrash = false;
          throw new Error("crash after terminal commit");
        }
        return result;
      },
    };

    await expect(
      advanceCompletedBuyerBundleDurable(
        f.input,
        f.provider,
        { ...f.durability, store: crashingStore },
      ),
    ).rejects.toThrow("crash after terminal commit");
    const effectCount = f.state.fences.length;
    const recovered = await advanceCompletedBuyerBundleDurable(
      f.input,
      f.provider,
      { ...f.durability, store: f.store, workerId: "buyer-worker-b" },
    );
    expect(recovered).toMatchObject({ disposition: "finalised", recovered: true });
    expect(f.state.fences).toHaveLength(effectCount);
  });

  test("terminal tamper is rejected without demoting the immutable terminal phase", async () => {
    const f = await fixture();
    await expect(
      advanceCompletedBuyerBundleDurable(f.input, f.provider, f.durability),
    ).resolves.toMatchObject({ disposition: "finalised" });
    const tamperingStore = {
      ...f.store,
      load: async (jobId: string) => {
        const loaded = await f.store.load(jobId);
        if (loaded.status !== "ok" || loaded.record.phase !== "buyer:finalised") {
          return loaded;
        }
        const result = [...loaded.record.checkpoints].reverse().find(
          ({ key }) => key === buyerBundleFinalizationCheckpointKey.result,
        );
        if (result?.data) result.data.nativeAddress = "tampered-native-address";
        return loaded;
      },
    };

    await expect(
      advanceCompletedBuyerBundleDurable(
        f.input,
        f.provider,
        { ...f.durability, store: tamperingStore, workerId: "buyer-worker-b" },
      ),
    ).rejects.toThrow("contradicts durable authority");
    const underlying = await f.store.load(JOB_ID);
    expect(underlying).toMatchObject({
      status: "ok",
      record: { phase: "buyer:finalised" },
    });
    if (underlying.status === "ok") expect(underlying.record.lease).toBeUndefined();
  });

  test.each([
    ["anchor", buyerBundleFinalizationCheckpointKey.anchor, "nativeAddress"],
    [
      "binding signature",
      buyerBundleFinalizationCheckpointKey.bindingSignature,
      "signer",
    ],
    [
      "binding publication",
      buyerBundleFinalizationCheckpointKey.bindingPublication,
      "bindingEnvelopeHash",
    ],
  ] as const)(
    "rejects terminal %s checkpoint tamper before authenticated replay",
    async (_subject, checkpointKey, field) => {
      const f = await fixture("write-input");
      await expect(
        advanceCompletedBuyerBundleDurable(f.input, f.provider, f.durability),
      ).resolves.toMatchObject({ disposition: "finalised" });
      const tamperingStore = {
        ...f.store,
        load: async (jobId: string) => {
          const loaded = await f.store.load(jobId);
          if (loaded.status !== "ok" || loaded.record.phase !== "buyer:finalised") {
            return loaded;
          }
          const checkpoint = [...loaded.record.checkpoints].reverse().find(
            ({ key }) => key === checkpointKey,
          );
          if (checkpoint?.data) checkpoint.data[field] = `tampered-${field}`;
          return loaded;
        },
      };

      await expect(
        advanceCompletedBuyerBundleDurable(
          f.input,
          f.provider,
          { ...f.durability, store: tamperingStore, workerId: "buyer-worker-b" },
        ),
      ).rejects.toThrow(/exact|fenced|publication/);
      const underlying = await f.store.load(JOB_ID);
      expect(underlying).toMatchObject({
        status: "ok",
        record: { phase: "buyer:finalised" },
      });
    },
  );

  test("rejects a settlement whose payer is not the exact local buyer", async () => {
    const f = await fixture();
    f.input.settlementContext.payer.primaryClaim = "did:demos:other-buyer";

    await expect(
      advanceCompletedBuyerBundleDurable(f.input, f.provider, f.durability),
    ).rejects.toThrow("exact buyer/seller agreement");
    expect(f.state.fences).toHaveLength(0);
  });

  test("captures provider and durability callbacks from owned data descriptors", async () => {
    const f = await fixture();
    Object.defineProperty(f.durability.transport, "publishCounterSignature", {
      enumerable: true,
      configurable: true,
      get: () => vi.fn(),
    });

    await expect(
      advanceCompletedBuyerBundleDurable(f.input, f.provider, f.durability),
    ).rejects.toThrow("must be an owned data property");
    expect(protocolMocks.verifySettlement).not.toHaveBeenCalled();
  });

  test("rejects provider accessors before settlement authentication or effects", async () => {
    const f = await fixture();
    Object.defineProperty(f.provider, "resolveBuyerBundle", {
      enumerable: true,
      configurable: true,
      get: () => vi.fn(),
    });

    await expect(
      advanceCompletedBuyerBundleDurable(f.input, f.provider, f.durability),
    ).rejects.toThrow("must be an owned data property");
    expect(protocolMocks.verifySettlement).not.toHaveBeenCalled();
    expect(f.state.fences).toHaveLength(0);
  });

  test("rejects nested input accessors without invoking them", async () => {
    const f = await fixture();
    let getterCalls = 0;
    Object.defineProperty(f.input.settlementContext.payer, "primaryClaim", {
      enumerable: true,
      configurable: true,
      get: () => {
        getterCalls += 1;
        throw new Error("nested getter executed");
      },
    });

    await expect(
      advanceCompletedBuyerBundleDurable(f.input, f.provider, f.durability),
    ).rejects.toThrow("cannot contain accessors");
    expect(getterCalls).toBe(0);
    expect(protocolMocks.verifySettlement).not.toHaveBeenCalled();
  });

  test("rejects proxied callback containers before invoking any proxy trap", async () => {
    const f = await fixture();
    let traps = 0;
    const transport = new Proxy(f.durability.transport, {
      get() {
        traps += 1;
        throw new Error("transport proxy get trap executed");
      },
      ownKeys() {
        traps += 1;
        throw new Error("transport proxy ownKeys trap executed");
      },
      getOwnPropertyDescriptor() {
        traps += 1;
        throw new Error("transport proxy descriptor trap executed");
      },
    });

    await expect(
      advanceCompletedBuyerBundleDurable(
        f.input,
        f.provider,
        { ...f.durability, transport },
      ),
    ).rejects.toThrow("cannot be a proxy");
    expect(traps).toBe(0);
    expect(protocolMocks.verifySettlement).not.toHaveBeenCalled();
  });

  test("rejects proxied transport output before invoking any proxy trap", async () => {
    const f = await fixture();
    let traps = 0;
    const proxied = new Proxy(
      { disposition: "present" as const, value: f.request },
      {
        get() {
          traps += 1;
          throw new Error("transport proxy get trap executed");
        },
        ownKeys() {
          traps += 1;
          throw new Error("transport proxy ownKeys trap executed");
        },
        getOwnPropertyDescriptor() {
          traps += 1;
          throw new Error("transport proxy descriptor trap executed");
        },
      },
    );
    f.durability.transport.resolveSellerRequest = vi.fn(() => proxied);

    await expect(
      advanceCompletedBuyerBundleDurable(f.input, f.provider, f.durability),
    ).resolves.toMatchObject({
      disposition: "indeterminate",
      stage: "seller-request",
    });
    expect(traps).toBe(0);
    expect(f.state.fences).toHaveLength(0);
  });

  test("isolates captured input and provider data from mutation across awaits", async () => {
    const f = await fixture();
    const ordinaryVerification = protocolMocks.verifySettlement.getMockImplementation()!;
    let releaseVerification!: () => void;
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    protocolMocks.verifySettlement.mockImplementationOnce(async (...args) => {
      signalEntered();
      await blocked;
      return ordinaryVerification(...args);
    });

    const pending = advanceCompletedBuyerBundleDurable(
      f.input,
      f.provider,
      f.durability,
    );
    await entered;
    f.input.buyer.primaryClaim = "did:demos:mutated-buyer";
    f.input.sellerVerificationInput.agreement.jobId = "mutated-job";
    f.provider.mapping = "write-input";
    f.provider.submitBuyerBundle = vi.fn(() => {
      throw new Error("mutated writer must not be observed");
    });
    releaseVerification();

    const result = await pending;
    expect(result.disposition).toBe("finalised");
    if (result.disposition === "finalised") {
      expect(result.result.binding).toBeUndefined();
      expect(result.result.buyerBundle.jobId).toBe(JOB_ID);
    }
  });

  test("exports every durable stage through the status projection", async () => {
    const f = await fixture();
    const status = await getBuyerBundleFinalizationStatus(f.store, JOB_ID);
    expect(status.status).toBe("ok");
    if (status.status !== "ok") return;
    expect(Object.keys(status.checkpoints).sort()).toEqual(
      Object.keys(buyerBundleFinalizationCheckpointKey).sort(),
    );
  });
});
