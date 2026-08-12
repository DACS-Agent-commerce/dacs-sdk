import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, test, vi } from "vitest";

const moduleMocks = vi.hoisted(() => ({
  finalizeCore: vi.fn(),
  prepareCounterSignatureRequest: vi.fn(),
  verifyFinalizedBundle: vi.fn(),
  verifyTerminalResult: vi.fn(),
  projectAudit: vi.fn(),
}));

vi.mock("../../src/seller/bundleFinalization.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../src/seller/bundleFinalization.js")
  >();
  return {
    ...actual,
    finalizeCompletedSellerBundleCore: moduleMocks.finalizeCore,
    prepareCompletedSellerBundleCounterSignatureRequest:
      moduleMocks.prepareCounterSignatureRequest,
    verifyFinalizedSellerBundleReadOnly: moduleMocks.verifyFinalizedBundle,
  };
});

vi.mock("../../src/agent/runDurableFulfilmentCore.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../src/agent/runDurableFulfilmentCore.js")
  >();
  return {
    ...actual,
    verifyDurableSellerTerminalResult: moduleMocks.verifyTerminalResult,
    projectDurableSellerAuditPending: moduleMocks.projectAudit,
  };
});

import {
  BUNDLE_BINDING_SEPARATOR,
  type AnchorReceipt,
  type AttestationRef,
  type BundleBinding,
  type FaultAttestationBundle,
} from "../../src/artifacts/index.js";
import {
  bundleAddress,
  contentHash,
  sha256Hex,
} from "../../src/canonical/index.js";
import { signedBytes } from "../../src/crypto/index.js";
import {
  attestationBundleHash,
  buildTwoSidedBundle,
  type TwoSidedSession,
} from "../../src/agent/twoSidedBundle.js";
import {
  createInMemoryFencedSessionStore,
  sessionReceiptKey,
  type FencedSessionStoreV2,
  type SessionLeaseToken,
  type SessionPaymentAuthorizationBinding,
  type SessionRecord,
  type TransitionInput,
} from "../../src/agent/fencedSessionStore.js";
import { createFsFencedSessionStore } from "../../src/agent/fencedSessionStoreFs.js";
import {
  finalizeCompletedSellerBundleCore,
  prepareCompletedSellerBundleCounterSignatureRequest,
  type FinalizeCompletedSellerBundleInput,
  type FinalizedSellerBundle,
  type SellerBundleFinalizationProvider,
} from "../../src/seller/bundleFinalization.js";
import {
  projectDurableSellerAuditPending,
  verifyDurableSellerTerminalResult,
  type DurableSellerTerminalVerification,
} from "../../src/agent/runDurableFulfilmentCore.js";
import {
  finalizeCompletedSellerBundleDurable,
  getSellerBundleFinalizationStatus,
  sellerBundleFinalizationCheckpointKey,
  type DurableSellerBundleFinalizationProvider,
  type FinalizeCompletedSellerBundleDurableInput,
  type SellerBundleEffectFence,
  type SellerBundleFencedComponentSigner,
  type SellerBundleFinalizationDurability,
} from "../../src/seller/durableBundleFinalization.js";

const NOW = 1_786_100_000_000;
const JOB_ID = "seller-bundle-durable-v2";
const BUYER = `demos:0x${"1".repeat(64)}`;
const SELLER = `demos:0x${"2".repeat(64)}`;
const AGREEMENT_HASH = "a".repeat(64);
const FULFILMENT_ID = "b".repeat(64);
const LOGICAL_ADDRESS = bundleAddress(JOB_ID, "seller");
const NATIVE_ADDRESS = `stor-${"7".repeat(40)}`;
const BUNDLE_BYTES = new Uint8Array([1, 3, 3, 7]);
const SELLER_SIGNATURE_BYTES = new Uint8Array(64).fill(7);
const BINDING_SIGNATURE_BYTES = new Uint8Array(64).fill(8);
const BUYER_SIGNATURE = Buffer.from(new Uint8Array(64).fill(6)).toString("base64url");

const finalizeCoreMock = vi.mocked(finalizeCompletedSellerBundleCore);
const prepareRequestMock = vi.mocked(
  prepareCompletedSellerBundleCounterSignatureRequest,
);
const verifyTerminalResultMock = vi.mocked(verifyDurableSellerTerminalResult);
const projectAuditMock = vi.mocked(projectDurableSellerAuditPending);
const verifyFinalizedBundleMock = moduleMocks.verifyFinalizedBundle;

function anchorReceipt(
  hash: string,
  logicalAddress = LOGICAL_ADDRESS,
  nativeAddress = NATIVE_ADDRESS,
): AnchorReceipt {
  return {
    receiptVersion: "1",
    substrate: "test:final",
    finalityProfile: "test-final",
    logicalAddress,
    nativeAddress,
    contentHash: hash,
    transactionRef: { kind: "test", value: `tx-${hash.slice(0, 16)}` },
    writer: SELLER,
    state: "finalized",
    observationDisposition: "established",
    observedAt: NOW,
    blockRef: { id: `block-${hash.slice(0, 8)}`, timestamp: NOW - 1_000 },
    evidence: { kind: "test-finality", value: `proof-${hash.slice(0, 16)}` },
  };
}

function paymentBinding(): SessionPaymentAuthorizationBinding {
  return {
    authorizationHash: "3".repeat(64),
    fulfilmentId: FULFILMENT_ID,
    handoffBindingHash: "4".repeat(64),
    agreementHash: AGREEMENT_HASH,
    paymentEvidenceHash: "5".repeat(64),
    settlementId: `demos:${"6".repeat(64)}`,
    paymentPhaseIndex: 0,
    deliveryPhaseIndex: 1,
  };
}

async function seedCompletedDelivery(
  store: FencedSessionStoreV2,
  binding: SessionPaymentAuthorizationBinding,
): Promise<void> {
  await store.create({
    jobId: JOB_ID,
    agreementHash: binding.agreementHash,
    now: 0,
  });
  const acquired = await store.acquireLease({
    jobId: JOB_ID,
    owner: "delivery-worker",
    ttlMs: 100,
    sellerPhaseIndex: binding.deliveryPhaseIndex,
    now: 0,
  });
  if (!acquired.ok) throw new Error(`delivery lease failed: ${acquired.reason}`);
  const bound = await store.bindSessionAuthorization({
    jobId: JOB_ID,
    binding,
    leaseToken: acquired.lease,
    now: 1,
  });
  if (!bound.ok) throw new Error(`delivery binding failed: ${bound.reason}`);
  const completed = await store.transition({
    jobId: JOB_ID,
    expectedRevision: bound.record.revision,
    leaseToken: acquired.lease,
    phase: `seller:delivery-completed:${binding.deliveryPhaseIndex}`,
    lease: null,
    now: 2,
  });
  if (!completed.ok) throw new Error(`delivery completion failed: ${completed.reason}`);
}

async function bundleTemplates(): Promise<{
  seller: FaultAttestationBundle;
  buyer: FaultAttestationBundle;
}> {
  const session: TwoSidedSession = {
    jobId: JOB_ID,
    outcome: "completed",
    listingRef: {
      listingId: "listing-durable-v2",
      version: 1,
      contentHash: "8".repeat(64),
    },
    agreementRef: {
      anchor: { kind: "storage-program", locator: `agreement:${JOB_ID}` },
      contentHash: AGREEMENT_HASH,
    },
    phaseSummary: [
      { index: 0, kind: "commit-payee-bound-agreement", outcome: "ok" },
      { index: 1, kind: "pay-x402", outcome: "ok" },
      { index: 2, kind: "deliver-storage-program", outcome: "ok" },
    ],
    vetRecords: [],
    settlementEvidence: [
      {
        anchor: { kind: "storage-program", locator: `payment:${JOB_ID}` },
        contentHash: "9".repeat(64),
      },
    ],
    recipeRegistryVersion: 1,
    railRegistryVersion: 1,
    finalisedAt: NOW,
    buyer: {
      primaryClaim: BUYER,
      bundleHash: "c".repeat(64),
      signer: () => new Uint8Array(64).fill(1),
    },
    seller: {
      primaryClaim: SELLER,
      bundleHash: "d".repeat(64),
      signer: () => new Uint8Array(64).fill(2),
    },
  };
  const copies = await buildTwoSidedBundle(session);
  if (!copies.sellerCopy || !copies.buyerCopy) {
    throw new Error("test bundle templates were not produced");
  }
  return {
    seller: structuredClone(copies.sellerCopy),
    buyer: structuredClone(copies.buyerCopy),
  };
}

function encodedSignature(value: Uint8Array | string): string {
  return typeof value === "string" ? value : Buffer.from(value).toString("base64url");
}

interface Harness {
  input: FinalizeCompletedSellerBundleDurableInput;
  provider: DurableSellerBundleFinalizationProvider;
  binding: SessionPaymentAuthorizationBinding;
  sellerSign: ReturnType<typeof vi.fn>;
  bindingSign: ReturnType<typeof vi.fn>;
  submitBundle: ReturnType<typeof vi.fn>;
  publishBinding: ReturnType<typeof vi.fn>;
  lastResult?: FinalizedSellerBundle;
}

async function createHarness(
  mapping: "pure" | "write-input" = "write-input",
): Promise<Harness> {
  const templates = await bundleTemplates();
  const binding = paymentBinding();
  const bundleContentHash = attestationBundleHash(templates.seller);
  const deliveryEvidence = {
    evidenceVersion: "1" as const,
    jobId: JOB_ID,
    phase: "deliver-storage-program" as const,
    observedAt: NOW - 2_000,
    outcome: "success" as const,
    deliverableContentHash: "e".repeat(64),
    deliverableAnchor: {
      kind: "storage-program",
      locator: `deliverable:${JOB_ID}`,
    },
    signature: {
      algorithm: "ed25519" as const,
      signer: SELLER,
      value: Buffer.from(new Uint8Array(64).fill(5)).toString("base64url"),
    },
  };
  const evidenceRef: AttestationRef = {
    anchor: { kind: "storage-program", locator: `evidence:${JOB_ID}` },
    contentHash: contentHash(deliveryEvidence),
  };
  const agreementRef: AttestationRef = {
    anchor: { kind: "storage-program", locator: `agreement:${JOB_ID}` },
    contentHash: AGREEMENT_HASH,
  };
  const buyerVetRef: AttestationRef = {
    anchor: { kind: "storage-program", locator: `vet:${JOB_ID}:buyer` },
    contentHash: "a".repeat(64),
  };
  const sellerVetRef: AttestationRef = {
    anchor: { kind: "storage-program", locator: `vet:${JOB_ID}:seller` },
    contentHash: "b".repeat(64),
  };
  const agreement: FinalizeCompletedSellerBundleInput["agreement"] = {
    artifactKind: "payee-bound",
    ref: `agreement:${JOB_ID}`,
    contentHash: AGREEMENT_HASH,
    jobId: JOB_ID,
    listingPin: {
      listingId: "listing-durable-v2",
      version: 1,
      contentHash: "8".repeat(64),
    },
    buyer: {
      primaryClaim: BUYER,
      bundleHash: "c".repeat(64),
      vetRecordRef: buyerVetRef,
    },
    seller: {
      primaryClaim: SELLER,
      bundleHash: "d".repeat(64),
      vetRecordRef: sellerVetRef,
    },
    deliverableRef: { deliverableType: "storage-program", hash: "e".repeat(64) },
    commitment: {
      status: "finalized",
      ref: `commitment:${JOB_ID}`,
      agreementHash: AGREEMENT_HASH,
      recordContentHash: "f".repeat(64),
      finalizedAt: NOW - 10_000,
      signer: SELLER,
    },
  };
  const fulfilment = {
    decision: "completed" as const,
    fulfilmentId: FULFILMENT_ID,
    evidence: deliveryEvidence,
    evidenceHash: evidenceRef.contentHash,
    evidenceRef,
    evidenceAnchorReceipt: anchorReceipt(
      evidenceRef.contentHash,
      `evidence:${JOB_ID}`,
      `evidence-native-${JOB_ID}`,
    ),
    bundleContribution: {
      phaseSummary: {
        index: 2,
        kind: "deliver-storage-program" as const,
        outcome: "ok" as const,
        attestationRef: evidenceRef,
      },
      settlementEvidence: evidenceRef,
    },
    consumedPaymentAuthorization: {
      jobId: JOB_ID,
      phaseIndex: 0,
      agreementHash: AGREEMENT_HASH,
    } as FinalizeCompletedSellerBundleInput["fulfilment"]["consumedPaymentAuthorization"],
  } satisfies FinalizeCompletedSellerBundleInput["fulfilment"];

  const sellerSign = vi.fn(
    (_bytes: Uint8Array, _fence: Readonly<SellerBundleEffectFence>) =>
      new Uint8Array(SELLER_SIGNATURE_BYTES),
  );
  const bindingSign = vi.fn(
    (
      _bytes: Uint8Array,
      _context: Parameters<SellerBundleFencedComponentSigner>[1],
      _fence: Readonly<SellerBundleEffectFence>,
    ) => new Uint8Array(BINDING_SIGNATURE_BYTES),
  );
  const input: FinalizeCompletedSellerBundleDurableInput = {
    agreement,
    verifiedListing: {
      pin: structuredClone(agreement.listingPin),
      sellerPrimaryClaim: SELLER,
      buyerRequirement: { requirementVersion: "1", required: [] },
      pipeline: [],
      deliverable: { kind: "storage-program", accessModel: "public" },
    },
    agreementRef,
    fulfilment,
    session: {
      recordVersion: "1",
      jobId: JOB_ID,
      state: "audit-pending",
      listingRef: agreement.listingPin,
      parties: [
        {
          role: "buyer",
          bundleHash: agreement.buyer.bundleHash,
          primaryClaim: BUYER,
          vetRecordRef: buyerVetRef,
        },
        {
          role: "seller",
          bundleHash: agreement.seller.bundleHash,
          primaryClaim: SELLER,
          vetRecordRef: sellerVetRef,
        },
      ],
      pipeline: [],
      phaseResults: [],
      startedAt: NOW - 20_000,
      lastUpdatedAt: NOW - 1_000,
      recipeRegistryVersion: 1,
      railRegistryVersion: 1,
    },
    sessionArtifacts: {
      agreementCommitment: {
        anchor: { kind: "storage-program", locator: `commitment:${JOB_ID}` },
        contentHash: agreement.commitment.recordContentHash,
      },
      vetRecords: [],
      vetRequirements: [],
      settlementEvidence: [evidenceRef],
    },
    finalisedAt: NOW,
    seller: {
      primaryClaim: SELLER,
      bundleHash: agreement.seller.bundleHash,
      signer: sellerSign,
    },
    counterSignatures: [
      { algorithm: "ed25519", party: BUYER, value: BUYER_SIGNATURE },
    ],
    dependencies: [],
    ...(mapping === "write-input"
      ? {
          bindingSigner: {
            algorithm: "ed25519" as const,
            signer: SELLER,
            sign: bindingSign,
          },
        }
      : {}),
  };

  const submitBundle = vi.fn(
    (
      _logicalAddress: string,
      _bundle: Readonly<FaultAttestationBundle>,
      _fence: Readonly<SellerBundleEffectFence>,
    ) => undefined,
  );
  const publishBinding = vi.fn(
    (
      _binding: Readonly<BundleBinding>,
      _fence: Readonly<SellerBundleEffectFence>,
    ) => ({ disposition: "published" as const }),
  );
  const provider = {
    mapping,
    bundleCopyVerifier: {
      resolvePublicKey: vi.fn(),
      verify: vi.fn(),
    } as unknown as SellerBundleFinalizationProvider["bundleCopyVerifier"],
    compositeVerificationDeps: {
      resolveRecipe: vi.fn(),
      isRecipeSignerAuthorized: vi.fn(),
      isVerifyResultSignerAuthorized: vi.fn(),
      resolvePublicKey: vi.fn(),
      verify: vi.fn(),
      verifyAuthorityAttestation: vi.fn(),
    } as unknown as SellerBundleFinalizationProvider["compositeVerificationDeps"],
    resolveDependency: vi.fn(() => ({ disposition: "absent" as const })),
    verifyDependencyReceipt: vi.fn(() => "valid" as const),
    verifyDependencyBinding: vi.fn(() => "valid" as const),
    verifyListingPublisherIdentityLinkage: vi.fn(() => "valid" as const),
    verifyVetRequirementProvenance: vi.fn(() => "valid" as const),
    resolveSellerBundle: vi.fn(() => ({ disposition: "absent" as const })),
    submitSellerBundle: submitBundle,
    verifyBundleAnchorReceipt: vi.fn(() => "valid" as const),
    resolveBundleBinding: vi.fn(() => ({ disposition: "absent" as const })),
    publishBundleBinding: publishBinding,
    verifyBundleBinding: vi.fn(() => "valid" as const),
  } satisfies DurableSellerBundleFinalizationProvider;

  const harness: Harness = {
    input,
    provider,
    binding,
    sellerSign,
    bindingSign,
    submitBundle,
    publishBinding,
  };

  prepareRequestMock.mockReset();
  prepareRequestMock.mockReturnValue({
    bundleContentHash,
    signedScope: { jobId: JOB_ID },
    signedBytes: new Uint8Array(BUNDLE_BYTES),
    requiredCounterSigners: [BUYER],
  });
  verifyTerminalResultMock.mockReset();
  verifyTerminalResultMock.mockImplementation(async ({ suppliedResult }) => ({
    result: structuredClone(suppliedResult),
    binding: structuredClone(binding),
    handoff: {} as Awaited<
      ReturnType<typeof verifyDurableSellerTerminalResult>
    >["handoff"],
    deliveryAnchorReceipt: structuredClone(suppliedResult.evidenceAnchorReceipt),
    resultHash: "0".repeat(64),
    finalReceiptHash: "1".repeat(64),
  }));
  projectAuditMock.mockReset();
  projectAuditMock.mockImplementation(async () => ({
    terminal: {
      result: structuredClone(input.fulfilment),
      binding: structuredClone(binding),
      handoff: {} as Awaited<
        ReturnType<typeof projectDurableSellerAuditPending>
      >["terminal"]["handoff"],
      deliveryAnchorReceipt: structuredClone(input.fulfilment.evidenceAnchorReceipt),
      resultHash: "0".repeat(64),
      finalReceiptHash: "1".repeat(64),
    },
    session: structuredClone(input.session),
    sessionArtifacts: structuredClone(input.sessionArtifacts) as Awaited<
      ReturnType<typeof projectDurableSellerAuditPending>
    >["sessionArtifacts"],
  }));
  verifyFinalizedBundleMock.mockImplementation(
    async (_input, suppliedResult) => structuredClone(suppliedResult),
  );
  finalizeCoreMock.mockReset();
  finalizeCoreMock.mockImplementation(async (wrappedInput, wrappedProvider) => {
    if (typeof wrappedInput.seller.signer !== "function") {
      throw new Error("mock core requires a remote seller signer");
    }
    const sellerSignature = encodedSignature(
      await wrappedInput.seller.signer(new Uint8Array(BUNDLE_BYTES)),
    );
    const detachedBuyer = wrappedInput.counterSignatures?.find(
      (signature) => signature.party === BUYER,
    );
    if (!detachedBuyer) throw new Error("mock core requires the detached buyer signature");
    const signatures = [
      {
        algorithm: detachedBuyer.algorithm,
        party: detachedBuyer.party,
        value: detachedBuyer.value,
      },
      { algorithm: "ed25519" as const, party: SELLER, value: sellerSignature },
    ];
    const sellerBundle = {
      ...structuredClone(templates.seller),
      signatures: structuredClone(signatures),
    } as FaultAttestationBundle;
    const buyerBundle = {
      ...structuredClone(templates.buyer),
      signatures: structuredClone(signatures),
    } as FaultAttestationBundle;
    await wrappedProvider.submitSellerBundle(LOGICAL_ADDRESS, sellerBundle);

    let bundleBinding: BundleBinding | undefined;
    if (mapping === "write-input") {
      if (!wrappedInput.bindingSigner || !wrappedProvider.publishBundleBinding) {
        throw new Error("mock core requires write-input binding capabilities");
      }
      const unsignedBinding: Omit<BundleBinding, "signature"> = {
        bindingVersion: "1",
        jobId: JOB_ID,
        role: "seller",
        logicalAddress: LOGICAL_ADDRESS,
        nativeAddress: NATIVE_ADDRESS,
        bundleContentHash,
        anchorTx: "test:bundle-anchor-tx",
        signer: SELLER,
      };
      const bindingBytes = signedBytes(
        BUNDLE_BINDING_SEPARATOR,
        contentHash(unsignedBinding as unknown as Record<string, unknown>),
      );
      const bindingSignature = encodedSignature(
        await wrappedInput.bindingSigner.sign(bindingBytes, {
          algorithm: "ed25519",
          signer: SELLER,
        }),
      );
      bundleBinding = {
        ...unsignedBinding,
        signature: {
          algorithm: "ed25519",
          signer: SELLER,
          value: bindingSignature,
        },
      };
      const publication = await wrappedProvider.publishBundleBinding(bundleBinding);
      if (publication.disposition !== "published") {
        throw new Error(`mock core publication ${publication.disposition}`);
      }
    }

    const result: FinalizedSellerBundle = {
      state: "finalised",
      logicalAddress: LOGICAL_ADDRESS,
      nativeAddress: NATIVE_ADDRESS,
      bundleContentHash,
      sellerBundle,
      buyerBundle,
      anchorReceipt: anchorReceipt(bundleContentHash),
      anchorTx: "test:bundle-anchor-tx",
      ...(bundleBinding ? { binding: bundleBinding } : {}),
      resumedBundle: false,
      resumedBinding: false,
    };
    harness.lastResult = structuredClone(result);
    return result;
  });

  return harness;
}

interface TestClock {
  now: number;
}

function durability(
  store: FencedSessionStoreV2,
  options: {
    workerId?: string;
    clock?: TestClock;
    reconcileSignature?: SellerBundleFinalizationDurability["reconcileSignature"];
    reconcileBundleAnchor?: SellerBundleFinalizationDurability["reconcileBundleAnchor"];
    reconcileBindingPublication?: SellerBundleFinalizationDurability["reconcileBindingPublication"];
  } = {},
): SellerBundleFinalizationDurability {
  const clock = options.clock ?? { now: 10 };
  return {
    store,
    workerId: options.workerId ?? "bundle-worker-a",
    leaseTtlMs: 1_000,
    leaseNowMs: () => clock.now,
    terminalVerification: {
      verifyEvidenceSignature: vi.fn(() => "valid"),
      verifyAuditSourceCommitmentSignature: vi.fn(() => "valid"),
      verifyAnchorReceipt: vi.fn(() => "valid"),
    } as unknown as DurableSellerTerminalVerification,
    reconcileSignature:
      options.reconcileSignature ??
      vi.fn(() => ({
        disposition: "signed" as const,
        value: new Uint8Array(SELLER_SIGNATURE_BYTES),
      })),
    reconcileBundleAnchor:
      options.reconcileBundleAnchor ??
      vi.fn(() => ({ disposition: "present" as const })),
    reconcileBindingPublication:
      options.reconcileBindingPublication ??
      vi.fn(() => ({ disposition: "published" as const })),
  };
}

type StoreOverrides = Partial<
  Pick<
    FencedSessionStoreV2,
    | "create"
    | "load"
    | "transition"
    | "claimCheckpoint"
    | "acquireLease"
    | "renewLease"
    | "bindSessionAuthorization"
    | "bindHash"
    | "list"
  >
>;

function wrapStore(
  base: FencedSessionStoreV2,
  overrides: StoreOverrides,
): FencedSessionStoreV2 {
  return {
    apiVersion: base.apiVersion,
    create: overrides.create ?? base.create.bind(base),
    load: overrides.load ?? base.load.bind(base),
    transition: overrides.transition ?? base.transition.bind(base),
    claimCheckpoint:
      overrides.claimCheckpoint ?? base.claimCheckpoint.bind(base),
    acquireLease: overrides.acquireLease ?? base.acquireLease.bind(base),
    renewLease: overrides.renewLease ?? base.renewLease.bind(base),
    bindSessionAuthorization:
      overrides.bindSessionAuthorization ??
      base.bindSessionAuthorization.bind(base),
    bindHash: overrides.bindHash ?? base.bindHash.bind(base),
    list: overrides.list ?? base.list.bind(base),
  };
}

function projectedTerminalStore(
  base: FencedSessionStoreV2,
  mutate: (record: SessionRecord) => SessionRecord,
): FencedSessionStoreV2 {
  const project = (record: SessionRecord): SessionRecord =>
    mutate(structuredClone(record));
  return wrapStore(base, {
    load: async (jobId) => {
      const loaded = await base.load(jobId);
      return loaded.status === "ok"
        ? { status: "ok", record: project(loaded.record) }
        : loaded;
    },
    bindSessionAuthorization: async (input) => {
      const bound = await base.bindSessionAuthorization(input);
      return bound.ok ? { ok: true, record: project(bound.record) } : bound;
    },
  });
}

function clearProviderEffects(harness: Harness): void {
  harness.sellerSign.mockClear();
  harness.bindingSign.mockClear();
  harness.submitBundle.mockClear();
  harness.publishBinding.mockClear();
  finalizeCoreMock.mockClear();
}

type EffectKind = "seller-sign" | "anchor" | "binding-sign" | "publish";

function crashFirstEffect(harness: Harness, effect: EffectKind): void {
  const failure = () => {
    throw new Error(`simulated ${effect} crash after remote effect`);
  };
  if (effect === "seller-sign") harness.sellerSign.mockImplementationOnce(failure);
  if (effect === "anchor") harness.submitBundle.mockImplementationOnce(failure);
  if (effect === "binding-sign") harness.bindingSign.mockImplementationOnce(failure);
  if (effect === "publish") harness.publishBinding.mockImplementationOnce(failure);
}

function effectFences(
  harness: Harness,
  effect: EffectKind,
): Readonly<SellerBundleEffectFence>[] {
  if (effect === "seller-sign") {
    return harness.sellerSign.mock.calls.map((call) => call[1]);
  }
  if (effect === "anchor") {
    return harness.submitBundle.mock.calls.map((call) => call[2]);
  }
  if (effect === "binding-sign") {
    return harness.bindingSign.mock.calls.map((call) => call[2]);
  }
  return harness.publishBinding.mock.calls.map((call) => call[1]);
}

function expectedIdempotencyKey(effect: EffectKind): string {
  if (effect === "seller-sign") {
    return `bundle-signature:${FULFILMENT_ID}:seller:${sha256Hex(BUNDLE_BYTES)}`;
  }
  if (effect === "anchor") return `bundle-anchor:${FULFILMENT_ID}`;
  if (effect === "binding-sign") {
    return `bundle-binding-signature:${FULFILMENT_ID}`;
  }
  return `bundle-binding:${FULFILMENT_ID}`;
}

beforeEach(() => {
  moduleMocks.finalizeCore.mockReset();
  moduleMocks.prepareCounterSignatureRequest.mockReset();
  moduleMocks.verifyFinalizedBundle.mockReset();
  moduleMocks.verifyTerminalResult.mockReset();
  moduleMocks.projectAudit.mockReset();
});

describe("durable seller bundle coordinator v2", () => {
  test("rejects caller-assembled session facts that differ from the WAL projection", async () => {
    const harness = await createHarness("write-input");
    const store = createInMemoryFencedSessionStore();
    await seedCompletedDelivery(store, harness.binding);
    const project = projectAuditMock.getMockImplementation();
    if (!project) throw new Error("projection mock missing");
    const authoritative = await project({} as never);
    authoritative.session.lastUpdatedAt -= 1;
    projectAuditMock.mockResolvedValueOnce(authoritative);

    await expect(finalizeCompletedSellerBundleDurable(
      harness.input,
      harness.provider,
      durability(store),
    )).rejects.toThrow("exact authenticated WAL projection");
    expect(finalizeCoreMock).not.toHaveBeenCalled();
  });

  test("passes one exact generation fence to every irreversible effect and commits atomically", async () => {
    const harness = await createHarness("write-input");
    const base = createInMemoryFencedSessionStore();
    await seedCompletedDelivery(base, harness.binding);
    const transitions: TransitionInput[] = [];
    const observedStore = wrapStore(base, {
      transition: async (input) => {
        transitions.push(structuredClone(input));
        return base.transition(input);
      },
    });

    const result = await finalizeCompletedSellerBundleDurable(
      harness.input,
      harness.provider,
      durability(observedStore),
    );

    const expectedGeneration = 2;
    expect(harness.sellerSign.mock.calls[0]?.[1]).toEqual({
      owner: "bundle-worker-a",
      generation: expectedGeneration,
      idempotencyKey: expectedIdempotencyKey("seller-sign"),
    });
    expect(harness.submitBundle.mock.calls[0]?.[2]).toEqual({
      owner: "bundle-worker-a",
      generation: expectedGeneration,
      idempotencyKey: expectedIdempotencyKey("anchor"),
    });
    expect(harness.bindingSign.mock.calls[0]?.[2]).toEqual({
      owner: "bundle-worker-a",
      generation: expectedGeneration,
      idempotencyKey: expectedIdempotencyKey("binding-sign"),
    });
    expect(harness.publishBinding.mock.calls[0]?.[1]).toEqual({
      owner: "bundle-worker-a",
      generation: expectedGeneration,
      idempotencyKey: expectedIdempotencyKey("publish"),
    });
    expect([
      harness.sellerSign.mock.calls[0]?.[1],
      harness.submitBundle.mock.calls[0]?.[2],
      harness.bindingSign.mock.calls[0]?.[2],
      harness.publishBinding.mock.calls[0]?.[1],
    ].every((fence) => Object.isFrozen(fence))).toBe(true);

    const terminalWrites = transitions.filter(
      (transition) => transition.phase === "seller:finalised",
    );
    expect(terminalWrites).toHaveLength(1);
    expect(terminalWrites[0]).toMatchObject({
      checkpoint: {
        key: sellerBundleFinalizationCheckpointKey.result,
        stage: "outcome",
      },
      receipt: { kind: "bundle", ref: NATIVE_ADDRESS },
      lease: null,
    });
    const loaded = await base.load(JOB_ID);
    expect(loaded.status).toBe("ok");
    if (loaded.status !== "ok") return;
    expect(loaded.record).toMatchObject({
      phase: "seller:finalised",
      leaseGeneration: expectedGeneration,
    });
    expect(loaded.record.lease).toBeUndefined();
    expect(
      loaded.record.checkpoints.find(
        (checkpoint) =>
          checkpoint.key === sellerBundleFinalizationCheckpointKey.result &&
          checkpoint.stage === "outcome",
      ),
    ).toBeDefined();
    expect(
      loaded.record.receipts.find((receipt) => sessionReceiptKey(receipt) === "bundle"),
    ).toMatchObject({ ref: NATIVE_ADDRESS });
    expect(result).toEqual(harness.lastResult);

    const status = await getSellerBundleFinalizationStatus(base, JOB_ID);
    expect(status).toMatchObject({
      status: "ok",
      phase: "seller:finalised",
      signatures: {
        buyer: "outcome",
        seller: "outcome",
        orchestrator: "not-started",
        binding: "outcome",
      },
      bundleAnchor: "outcome",
      bindingPublication: "outcome",
      bundleReceipt: NATIVE_ADDRESS,
    });
  });

  test("projects a recoverable partial status after an anchor-side ambiguity", async () => {
    const harness = await createHarness("pure");
    const store = createInMemoryFencedSessionStore();
    await seedCompletedDelivery(store, harness.binding);
    crashFirstEffect(harness, "anchor");

    await expect(
      finalizeCompletedSellerBundleDurable(
        harness.input,
        harness.provider,
        durability(store),
      ),
    ).rejects.toThrow(/simulated anchor crash/);

    expect(await getSellerBundleFinalizationStatus(store, JOB_ID)).toMatchObject({
      status: "ok",
      phase: "seller:bundle-anchor-pending",
      signatures: {
        buyer: "intent",
        seller: "outcome",
        orchestrator: "not-started",
        binding: "not-started",
      },
      bundleAnchor: "intent",
      bindingPublication: "not-started",
    });
    const loaded = await store.load(JOB_ID);
    expect(loaded.status === "ok" && loaded.record.lease).toBeUndefined();
  });

  test.each([
    ["bundle-worker-a", "same owner"],
    ["bundle-worker-b", "different owner"],
  ] as const)("takes over with a larger generation for the %s recovery", async (workerId, _label) => {
    const harness = await createHarness("pure");
    const store = createInMemoryFencedSessionStore();
    await seedCompletedDelivery(store, harness.binding);
    crashFirstEffect(harness, "seller-sign");

    await expect(
      finalizeCompletedSellerBundleDurable(
        harness.input,
        harness.provider,
        durability(store, { workerId: "bundle-worker-a" }),
      ),
    ).rejects.toThrow(/simulated seller-sign crash/);

    const reconcileSignature = vi.fn<
      SellerBundleFinalizationDurability["reconcileSignature"]
    >(() => ({
      disposition: "authoritatively-absent",
      reason: "remote signer proved no signature exists",
    }));
    const recovered = await finalizeCompletedSellerBundleDurable(
      harness.input,
      harness.provider,
      durability(store, { workerId, reconcileSignature }),
    );
    expect(recovered.state).toBe("finalised");
    expect(effectFences(harness, "seller-sign")).toEqual([
      {
        owner: "bundle-worker-a",
        generation: 2,
        idempotencyKey: expectedIdempotencyKey("seller-sign"),
      },
      {
        owner: workerId,
        generation: 3,
        idempotencyKey: expectedIdempotencyKey("seller-sign"),
      },
    ]);
    expect(reconcileSignature).toHaveBeenCalledOnce();
    expect(reconcileSignature.mock.calls[0]?.[0].fence).toEqual({
      owner: workerId,
      generation: 3,
      idempotencyKey: expectedIdempotencyKey("seller-sign"),
    });
  });

  test("a superseded generation cannot append, release, or finalise", async () => {
    const harness = await createHarness("pure");
    const store = createInMemoryFencedSessionStore();
    await seedCompletedDelivery(store, harness.binding);
    const clock = { now: 10 };
    let staleFence: Readonly<SellerBundleEffectFence> | undefined;
    harness.sellerSign.mockImplementationOnce(async (_bytes, fence) => {
      staleFence = structuredClone(fence);
      clock.now = 2_000;
      const takeover = await store.acquireLease({
        jobId: JOB_ID,
        owner: "takeover-worker",
        ttlMs: 1_000,
        now: clock.now,
      });
      if (!takeover.ok) throw new Error(`takeover failed: ${takeover.reason}`);
      return new Uint8Array(SELLER_SIGNATURE_BYTES);
    });

    await expect(
      finalizeCompletedSellerBundleDurable(
        harness.input,
        harness.provider,
        durability(store, { clock }),
      ),
    ).rejects.toThrow(/stale|lease-fenced/);
    expect(staleFence).toMatchObject({ owner: "bundle-worker-a", generation: 2 });
    if (!staleFence) throw new Error("stale fence was not captured");
    const loaded = await store.load(JOB_ID);
    if (loaded.status !== "ok") throw new Error("takeover record missing");
    expect(loaded.record.lease).toMatchObject({
      owner: "takeover-worker",
      generation: 3,
    });
    const token: SessionLeaseToken = {
      owner: staleFence.owner,
      generation: staleFence.generation,
    };
    const revision = loaded.record.revision;
    const attempts = await Promise.all([
      store.transition({
        jobId: JOB_ID,
        expectedRevision: revision,
        leaseToken: token,
        checkpoint: { key: "stale:append", stage: "outcome" },
        now: clock.now,
      }),
      store.transition({
        jobId: JOB_ID,
        expectedRevision: revision,
        leaseToken: token,
        lease: null,
        now: clock.now,
      }),
      store.transition({
        jobId: JOB_ID,
        expectedRevision: revision,
        leaseToken: token,
        phase: "seller:finalised",
        lease: null,
        now: clock.now,
      }),
    ]);
    expect(attempts).toEqual([
      expect.objectContaining({ ok: false, reason: "lease-fenced" }),
      expect.objectContaining({ ok: false, reason: "lease-fenced" }),
      expect.objectContaining({ ok: false, reason: "lease-fenced" }),
    ]);
    const after = await store.load(JOB_ID);
    expect(after.status === "ok" && after.record.phase).toBe("seller:bundle-signing");
    expect(after.status === "ok" && after.record.lease).toMatchObject({
      owner: "takeover-worker",
      generation: 3,
    });
  });

  test.each([
    "seller-sign",
    "anchor",
    "binding-sign",
    "publish",
  ] as const)("re-drives %s only after authoritative absence under the new fence", async (effect) => {
    const harness = await createHarness("write-input");
    const store = createInMemoryFencedSessionStore();
    await seedCompletedDelivery(store, harness.binding);
    crashFirstEffect(harness, effect);

    const reconcileSignature = vi.fn<
      SellerBundleFinalizationDurability["reconcileSignature"]
    >((input) =>
      effect === "seller-sign" && input.purpose === "bundle" ||
      effect === "binding-sign" && input.purpose === "bundle-binding"
        ? {
            disposition: "authoritatively-absent",
            reason: "signature authority proves absence",
          }
        : {
            disposition: "signed",
            value: input.purpose === "bundle-binding"
              ? new Uint8Array(BINDING_SIGNATURE_BYTES)
              : new Uint8Array(SELLER_SIGNATURE_BYTES),
          },
    );
    const reconcileBundleAnchor = vi.fn<
      SellerBundleFinalizationDurability["reconcileBundleAnchor"]
    >(() =>
      effect === "anchor"
        ? {
            disposition: "authoritatively-absent",
            reason: "anchor authority proves absence",
          }
        : { disposition: "present" },
    );
    const reconcileBindingPublication = vi.fn<
      SellerBundleFinalizationDurability["reconcileBindingPublication"]
    >(() =>
      effect === "publish"
        ? {
            disposition: "authoritatively-absent",
            reason: "catalog authority proves absence",
          }
        : { disposition: "published" },
    );
    const recoveryDurability = durability(store, {
      workerId: "bundle-worker-b",
      reconcileSignature,
      reconcileBundleAnchor,
      reconcileBindingPublication,
    });

    await expect(
      finalizeCompletedSellerBundleDurable(
        harness.input,
        harness.provider,
        durability(store),
      ),
    ).rejects.toThrow(/simulated/);
    await expect(
      finalizeCompletedSellerBundleDurable(
        harness.input,
        harness.provider,
        recoveryDurability,
      ),
    ).resolves.toMatchObject({ state: "finalised" });

    const fences = effectFences(harness, effect);
    expect(fences).toHaveLength(2);
    expect(fences[0]).toMatchObject({ owner: "bundle-worker-a", generation: 2 });
    expect(fences[1]).toEqual({
      owner: "bundle-worker-b",
      generation: 3,
      idempotencyKey: expectedIdempotencyKey(effect),
    });
    const reconciliationFence = effect === "seller-sign" || effect === "binding-sign"
      ? reconcileSignature.mock.calls.find((call) =>
          call[0].purpose === (effect === "seller-sign" ? "bundle" : "bundle-binding")
        )?.[0].fence
      : effect === "anchor"
        ? reconcileBundleAnchor.mock.calls[0]?.[0].fence
        : reconcileBindingPublication.mock.calls[0]?.[1];
    expect(reconciliationFence).toEqual(fences[1]);
    expect(Object.isFrozen(reconciliationFence)).toBe(true);
  });

  test.each([
    "seller-sign",
    "anchor",
    "binding-sign",
    "publish",
  ] as const)("accepts a definitive %s reconciliation without re-driving it", async (effect) => {
    const harness = await createHarness("write-input");
    const store = createInMemoryFencedSessionStore();
    await seedCompletedDelivery(store, harness.binding);
    crashFirstEffect(harness, effect);
    await expect(
      finalizeCompletedSellerBundleDurable(
        harness.input,
        harness.provider,
        durability(store),
      ),
    ).rejects.toThrow(/simulated/);

    const recovery = durability(store, { workerId: "bundle-worker-b" });
    await expect(
      finalizeCompletedSellerBundleDurable(
        harness.input,
        harness.provider,
        recovery,
      ),
    ).resolves.toMatchObject({ state: "finalised" });
    expect(effectFences(harness, effect)).toHaveLength(1);
    if (effect === "seller-sign" || effect === "binding-sign") {
      expect(vi.mocked(recovery.reconcileSignature)).toHaveBeenCalled();
    } else if (effect === "anchor") {
      expect(vi.mocked(recovery.reconcileBundleAnchor)).toHaveBeenCalledOnce();
    } else {
      expect(vi.mocked(recovery.reconcileBindingPublication)).toHaveBeenCalledOnce();
    }
  });

  test.each([
    ["seller-sign", "malformed"],
    ["seller-sign", "indeterminate"],
    ["anchor", "malformed"],
    ["anchor", "indeterminate"],
    ["binding-sign", "malformed"],
    ["binding-sign", "indeterminate"],
    ["publish", "malformed"],
    ["publish", "indeterminate"],
  ] as const)("never re-drives %s after a %s reconciliation", async (effect, disposition) => {
    const harness = await createHarness("write-input");
    const store = createInMemoryFencedSessionStore();
    await seedCompletedDelivery(store, harness.binding);
    crashFirstEffect(harness, effect);
    await expect(
      finalizeCompletedSellerBundleDurable(
        harness.input,
        harness.provider,
        durability(store),
      ),
    ).rejects.toThrow(/simulated/);

    const reconcileSignature = vi.fn<
      SellerBundleFinalizationDurability["reconcileSignature"]
    >((input) => {
      const target = effect === "seller-sign" ? "bundle" : "bundle-binding";
      if ((effect === "seller-sign" || effect === "binding-sign") && input.purpose === target) {
        return disposition === "indeterminate"
          ? { disposition: "indeterminate", reason: "signer state is ambiguous" }
          : ({ disposition: "safe-to-sign" } as never);
      }
      return {
        disposition: "signed",
        value: input.purpose === "bundle-binding"
          ? new Uint8Array(BINDING_SIGNATURE_BYTES)
          : new Uint8Array(SELLER_SIGNATURE_BYTES),
      };
    });
    const reconcileBundleAnchor = vi.fn<
      SellerBundleFinalizationDurability["reconcileBundleAnchor"]
    >(() =>
      effect === "anchor"
        ? disposition === "indeterminate"
          ? { disposition: "indeterminate", reason: "anchor state is ambiguous" }
          : ({ disposition: "safe-to-submit" } as never)
        : { disposition: "present" },
    );
    const reconcileBindingPublication = vi.fn<
      SellerBundleFinalizationDurability["reconcileBindingPublication"]
    >(() =>
      effect === "publish"
        ? disposition === "indeterminate"
          ? { disposition: "indeterminate", reason: "catalog state is ambiguous" }
          : ({ disposition: "safe-to-publish" } as never)
        : { disposition: "published" },
    );

    await expect(
      finalizeCompletedSellerBundleDurable(
        harness.input,
        harness.provider,
        durability(store, {
          workerId: "bundle-worker-b",
          reconcileSignature,
          reconcileBundleAnchor,
          reconcileBindingPublication,
        }),
      ),
    ).rejects.toThrow(/malformed|indeterminate|ambiguous|publication/);
    expect(effectFences(harness, effect)).toHaveLength(1);
  });

  test("rejects detached buyer signature-envelope substitution on terminal replay", async () => {
    const harness = await createHarness("pure");
    const store = createInMemoryFencedSessionStore();
    await seedCompletedDelivery(store, harness.binding);
    await finalizeCompletedSellerBundleDurable(
      harness.input,
      harness.provider,
      durability(store),
    );
    clearProviderEffects(harness);
    const substituted: FinalizeCompletedSellerBundleDurableInput = {
      ...harness.input,
      counterSignatures: [
        {
          algorithm: "ed25519",
          party: BUYER,
          value: Buffer.from(new Uint8Array(64).fill(9)).toString("base64url"),
        },
      ],
    };

    await expect(
      finalizeCompletedSellerBundleDurable(
        substituted,
        harness.provider,
        durability(store),
      ),
    ).rejects.toThrow(/checkpoint|detached buyer signature/);
    expect(finalizeCoreMock).not.toHaveBeenCalled();
    expect(harness.sellerSign).not.toHaveBeenCalled();
    expect(harness.submitBundle).not.toHaveBeenCalled();
  });

  test.each([
    [
      "missing result outcome",
      (record: SessionRecord) => ({
        ...record,
        checkpoints: record.checkpoints.filter(
          (checkpoint) => checkpoint.key !== sellerBundleFinalizationCheckpointKey.result,
        ),
      }),
    ],
    [
      "corrupt result encoding",
      (record: SessionRecord) => {
        const checkpoint = record.checkpoints.find(
          (candidate) =>
            candidate.key === sellerBundleFinalizationCheckpointKey.result &&
            candidate.stage === "outcome",
        );
        if (checkpoint?.data) checkpoint.data.result = "AA";
        return record;
      },
    ],
    [
      "rebound result authority",
      (record: SessionRecord) => {
        const checkpoint = record.checkpoints.find(
          (candidate) =>
            candidate.key === sellerBundleFinalizationCheckpointKey.result &&
            candidate.stage === "outcome",
        );
        if (checkpoint?.data) checkpoint.data.authorizationHash = "f".repeat(64);
        return record;
      },
    ],
    [
      "missing anchor outcome",
      (record: SessionRecord) => ({
        ...record,
        checkpoints: record.checkpoints.filter(
          (checkpoint) =>
            checkpoint.key !== sellerBundleFinalizationCheckpointKey.anchor ||
            checkpoint.stage !== "outcome",
        ),
      }),
    ],
    [
      "missing bundle receipt",
      (record: SessionRecord) => ({
        ...record,
        receipts: record.receipts.filter((receipt) => sessionReceiptKey(receipt) !== "bundle"),
      }),
    ],
  ] as const)("rejects terminal state with %s before any provider effect", async (_label, mutate) => {
    const harness = await createHarness("pure");
    const store = createInMemoryFencedSessionStore();
    await seedCompletedDelivery(store, harness.binding);
    await finalizeCompletedSellerBundleDurable(
      harness.input,
      harness.provider,
      durability(store),
    );
    clearProviderEffects(harness);

    await expect(
      finalizeCompletedSellerBundleDurable(
        harness.input,
        harness.provider,
        durability(projectedTerminalStore(store, mutate)),
      ),
    ).rejects.toThrow(/terminal|result|checkpoint|anchor|receipt|decode|authority/);
    expect(finalizeCoreMock).not.toHaveBeenCalled();
    expect(harness.sellerSign).not.toHaveBeenCalled();
    expect(harness.submitBundle).not.toHaveBeenCalled();
  });

  test("fails closed on missing or corrupt state without invoking the provider", async () => {
    const harness = await createHarness("pure");
    const missing = createInMemoryFencedSessionStore();
    await expect(
      finalizeCompletedSellerBundleDurable(
        harness.input,
        harness.provider,
        durability(missing),
      ),
    ).rejects.toThrow(/existing durable fulfilment state/);
    const corrupt = wrapStore(missing, {
      load: async () => ({ status: "corrupt", reason: "invalid terminal checkpoint" }),
    });
    await expect(
      finalizeCompletedSellerBundleDurable(
        harness.input,
        harness.provider,
        durability(corrupt),
      ),
    ).rejects.toThrow(/state is corrupt/);
    expect(finalizeCoreMock).not.toHaveBeenCalled();
    expect(harness.sellerSign).not.toHaveBeenCalled();
    expect(harness.submitBundle).not.toHaveBeenCalled();
  });

  test("authenticates both the fresh result and terminal replay without demoting on rejection", async () => {
    const harness = await createHarness("write-input");
    const store = createInMemoryFencedSessionStore();
    await seedCompletedDelivery(store, harness.binding);

    const first = await finalizeCompletedSellerBundleDurable(
      harness.input,
      harness.provider,
      durability(store),
    );
    expect(verifyFinalizedBundleMock).toHaveBeenCalledOnce();
    expect(verifyFinalizedBundleMock.mock.calls[0]?.[1]).toEqual(first);
    expect(verifyFinalizedBundleMock.mock.calls[0]?.[2]).not.toHaveProperty(
      "submitSellerBundle",
    );
    expect(verifyFinalizedBundleMock.mock.calls[0]?.[2]).not.toHaveProperty(
      "publishBundleBinding",
    );

    clearProviderEffects(harness);
    const replay = await finalizeCompletedSellerBundleDurable(
      harness.input,
      harness.provider,
      durability(store, { workerId: "replay-worker" }),
    );
    expect(replay).toEqual(first);
    expect(verifyFinalizedBundleMock).toHaveBeenCalledTimes(2);
    expect(verifyFinalizedBundleMock.mock.calls[1]?.[1]).toEqual(first);
    expect(finalizeCoreMock).not.toHaveBeenCalled();
    expect(harness.sellerSign).not.toHaveBeenCalled();
    expect(harness.submitBundle).not.toHaveBeenCalled();

    const terminalBeforeRejection = await store.load(JOB_ID);
    verifyFinalizedBundleMock.mockRejectedValueOnce(
      new Error("terminal bundle authentication rejected"),
    );
    await expect(
      finalizeCompletedSellerBundleDurable(
        harness.input,
        harness.provider,
        durability(store, { workerId: "rejected-replay-worker" }),
      ),
    ).rejects.toThrow(/authentication rejected/);
    expect(await store.load(JOB_ID)).toEqual(terminalBeforeRejection);
    expect(finalizeCoreMock).not.toHaveBeenCalled();
    expect(harness.sellerSign).not.toHaveBeenCalled();
    expect(harness.bindingSign).not.toHaveBeenCalled();
    expect(harness.submitBundle).not.toHaveBeenCalled();
    expect(harness.publishBinding).not.toHaveBeenCalled();
  });

  test("terminal replay returns the persisted result and no outage can demote it", async () => {
    const harness = await createHarness("write-input");
    const store = createInMemoryFencedSessionStore();
    await seedCompletedDelivery(store, harness.binding);
    const first = await finalizeCompletedSellerBundleDurable(
      harness.input,
      harness.provider,
      durability(store),
    );
    const before = await store.load(JOB_ID);
    clearProviderEffects(harness);
    harness.sellerSign.mockImplementation(() => {
      throw new Error("seller unavailable");
    });
    harness.bindingSign.mockImplementation(() => {
      throw new Error("binding signer unavailable");
    });
    harness.submitBundle.mockImplementation(() => {
      throw new Error("anchor provider unavailable");
    });
    harness.publishBinding.mockImplementation(() => {
      throw new Error("catalog unavailable");
    });

    await expect(
      finalizeCompletedSellerBundleDurable(
        harness.input,
        harness.provider,
        durability(store),
      ),
    ).resolves.toEqual(first);
    expect(finalizeCoreMock).not.toHaveBeenCalled();
    expect(harness.sellerSign).not.toHaveBeenCalled();
    expect(harness.bindingSign).not.toHaveBeenCalled();
    expect(harness.submitBundle).not.toHaveBeenCalled();
    expect(harness.publishBinding).not.toHaveBeenCalled();

    projectAuditMock.mockRejectedValueOnce(
      new Error("terminal verification provider unavailable"),
    );
    await expect(
      finalizeCompletedSellerBundleDurable(
        harness.input,
        harness.provider,
        durability(store),
      ),
    ).rejects.toThrow(/verification provider unavailable/);
    expect(await store.load(JOB_ID)).toEqual(before);
  });

  test.each(["memory", "filesystem"] as const)(
    "has terminal replay parity on the %s fenced store",
    async (kind) => {
      const directory = kind === "filesystem"
        ? await mkdtemp(join(tmpdir(), "dacs-bundle-v2-"))
        : undefined;
      try {
        const harness = await createHarness("pure");
        const store = directory
          ? await createFsFencedSessionStore({ dir: directory })
          : createInMemoryFencedSessionStore();
        await seedCompletedDelivery(store, harness.binding);
        crashFirstEffect(harness, "anchor");
        await expect(finalizeCompletedSellerBundleDurable(
          harness.input,
          harness.provider,
          durability(store),
        )).rejects.toThrow(/simulated anchor crash/);
        const recoveryStore = directory
          ? await createFsFencedSessionStore({ dir: directory })
          : store;
        const first = await finalizeCompletedSellerBundleDurable(
          harness.input,
          harness.provider,
          durability(recoveryStore, { workerId: "recovery-worker" }),
        );
        expect(harness.submitBundle).toHaveBeenCalledOnce();
        clearProviderEffects(harness);
        const replayStore = directory
          ? await createFsFencedSessionStore({ dir: directory })
          : store;
        const replay = await finalizeCompletedSellerBundleDurable(
          harness.input,
          harness.provider,
          durability(replayStore, { workerId: "replay-worker" }),
        );
        expect(replay).toEqual(first);
        expect(finalizeCoreMock).not.toHaveBeenCalled();
        expect(harness.sellerSign).not.toHaveBeenCalled();
        expect(harness.submitBundle).not.toHaveBeenCalled();
        expect(await getSellerBundleFinalizationStatus(replayStore, JOB_ID)).toMatchObject({
          status: "ok",
          phase: "seller:finalised",
          bundleReceipt: NATIVE_ADDRESS,
        });
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
