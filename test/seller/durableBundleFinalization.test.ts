import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import type {
  AnchorReceipt,
  AttestationRef,
  BundleBinding,
  FaultAttestationBundle,
} from "../../src/artifacts/index.js";
import { contentHash } from "../../src/canonical/index.js";
import { attestationBundleHash } from "../../src/agent/twoSidedBundle.js";
import type {
  SellerFulfilmentAgreement,
  SellerFulfilmentResult,
} from "../../src/agent/runFulfilmentCore.js";
import {
  createInMemorySessionStore,
  type SessionStore,
} from "../../src/agent/sessionStore.js";
import { createFsSessionStore } from "../../src/agent/sessionStoreFs.js";
import type {
  AnchoredSellerBundle,
  FinalizeCompletedSellerBundleInput,
  SellerBundleFinalizationProvider,
} from "../../src/seller/bundleFinalization.js";
import {
  finalizeCompletedSellerBundleDurable,
  getSellerBundleFinalizationStatus,
  sellerBundleFinalizationCheckpointKey,
  type SellerBundleFinalizationDurability,
} from "../../src/seller/durableBundleFinalization.js";

const NOW = 1_786_100_000_000;
const JOB_ID = "seller-bundle-durable-55";
const BUYER = "did:demos:buyer";
const SELLER = "did:demos:seller";

const artifact = (kind: string): Record<string, unknown> => ({
  artifactVersion: "1",
  kind,
  jobId: JOB_ID,
});

const ref = (name: string, value: Record<string, unknown>): AttestationRef => ({
  anchor: { kind: "storage-program", locator: `dacs-test:${name}` },
  contentHash: contentHash(value),
});

function receipt(
  hash: string,
  logicalAddress = `dacs-test:${hash.slice(0, 12)}`,
  nativeAddress = `stor-${hash.slice(0, 40)}`,
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

function fixture(mapping: "pure" | "write-input" = "pure") {
  const listingArtifact = artifact("listing");
  const agreementArtifact = artifact("agreement");
  const commitmentArtifact = artifact("commitment");
  const paymentArtifact = artifact("payment-evidence");
  const agreementRef = ref("agreement", agreementArtifact);
  const commitmentRef = ref("commitment", commitmentArtifact);
  const paymentRef = ref("payment", paymentArtifact);
  const deliveryEvidence = {
    evidenceVersion: "1" as const,
    jobId: JOB_ID,
    phase: "deliver-storage-program" as const,
    observedAt: NOW - 2_000,
    outcome: "success" as const,
    deliverableContentHash: "a".repeat(64),
    deliverableAnchor: {
      kind: "storage-program",
      locator: `dacs4:deliverable:${JOB_ID}`,
    },
    signature: {
      algorithm: "ed25519" as const,
      signer: SELLER,
      value: "c2ln",
    },
  };
  const deliveryRef: AttestationRef = {
    anchor: { kind: "storage-program", locator: `dacs4:delivery:${JOB_ID}:2` },
    contentHash: contentHash(deliveryEvidence),
  };
  const fulfilment: Extract<SellerFulfilmentResult, { decision: "completed" }> = {
    decision: "completed",
    fulfilmentId: "fulfilment-durable-55",
    evidence: deliveryEvidence,
    evidenceHash: deliveryRef.contentHash,
    evidenceRef: deliveryRef,
    bundleContribution: {
      phaseSummary: {
        index: 2,
        kind: "deliver-storage-program",
        outcome: "ok",
        attestationRef: deliveryRef,
      },
      settlementEvidence: deliveryRef,
    },
  };
  const agreement: SellerFulfilmentAgreement = {
    artifactKind: "payee-bound",
    ref: `agreement:${JOB_ID}`,
    contentHash: agreementRef.contentHash,
    jobId: JOB_ID,
    listingPin: {
      listingId: "listing-durable-55",
      version: 4,
      contentHash: contentHash(listingArtifact),
    },
    buyer: { primaryClaim: BUYER, bundleHash: "b".repeat(64) },
    seller: { primaryClaim: SELLER, bundleHash: "c".repeat(64) },
    deliverableRef: { deliverableType: "storage-program", hash: "d".repeat(64) },
    signaturesVerified: true,
    commitment: {
      status: "finalized",
      ref: `commitment:${JOB_ID}`,
      agreementHash: agreementRef.contentHash,
      recordContentHash: commitmentRef.contentHash,
      finalizedAt: NOW - 10_000,
    },
  };
  const buyerSign = vi.fn(() => new Uint8Array(64).fill(11));
  const sellerSign = vi.fn(() => new Uint8Array(64).fill(12));
  const bindingSign = vi.fn(() => new Uint8Array(64).fill(13));
  const input: FinalizeCompletedSellerBundleInput = {
    agreement,
    agreementRef,
    fulfilment,
    phaseSummary: [
      {
        index: 0,
        kind: "commit-payee-bound-agreement",
        outcome: "ok",
        attestationRef: commitmentRef,
      },
      {
        index: 1,
        kind: "pay-x402",
        outcome: "ok",
        attestationRef: paymentRef,
      },
    ],
    vetRecords: [],
    settlementEvidence: [paymentRef],
    recipeRegistryVersion: 4,
    railRegistryVersion: 7,
    finalisedAt: NOW,
    buyer: { primaryClaim: BUYER, bundleHash: agreement.buyer.bundleHash, signer: buyerSign },
    seller: { primaryClaim: SELLER, bundleHash: agreement.seller.bundleHash, signer: sellerSign },
    dependencies: [],
    bindingSigner: { algorithm: "ed25519", signer: SELLER, sign: bindingSign },
  };
  const artifacts = new Map<string, Record<string, unknown>>([
    [agreement.listingPin.contentHash, listingArtifact],
    [agreementRef.contentHash, agreementArtifact],
    [commitmentRef.contentHash, commitmentArtifact],
    [paymentRef.contentHash, paymentArtifact],
    [deliveryRef.contentHash, deliveryEvidence],
  ]);
  input.dependencies = [...artifacts.keys()].map((hash) => ({
    contentHash: hash,
    anchorReceipt: receipt(hash),
  }));

  const state: { anchored?: AnchoredSellerBundle; binding?: BundleBinding } = {};
  const anchor = (logicalAddress: string, bundle: FaultAttestationBundle): void => {
    const hash = attestationBundleHash(bundle);
    const nativeAddress = `stor-${"7".repeat(40)}`;
    state.anchored = {
      bundle,
      nativeAddress,
      anchorTx: "test:durable-bundle-tx",
      anchorReceipt: receipt(hash, logicalAddress, nativeAddress),
    };
  };
  const provider: SellerBundleFinalizationProvider = {
    mapping,
    resolveDependency: vi.fn((dependency) => ({
      disposition: "present" as const,
      artifact: artifacts.get(dependency.contentHash),
    })),
    verifyDependencyReceipt: vi.fn(() => "valid" as const),
    verifyDependencyBinding: vi.fn(() => "valid" as const),
    resolveSellerBundle: vi.fn(() =>
      state.anchored
        ? { disposition: "present" as const, anchored: state.anchored }
        : { disposition: "absent" as const },
    ),
    submitSellerBundle: vi.fn((logicalAddress, bundle) => anchor(logicalAddress, bundle)),
    verifySellerBundle: vi.fn(() => "valid" as const),
    verifyBundleAnchorReceipt: vi.fn(() => "valid" as const),
    resolveBundleBinding: vi.fn(() =>
      state.binding
        ? { disposition: "present" as const, binding: state.binding }
        : { disposition: "absent" as const },
    ),
    publishBundleBinding: vi.fn((binding) => {
      state.binding = binding;
      return { disposition: "published" as const };
    }),
    verifyBundleBinding: vi.fn(() => "valid" as const),
  };
  return {
    input,
    provider,
    state,
    anchor,
    buyerSign,
    sellerSign,
    bindingSign,
  };
}

function durability(
  store: SessionStore,
  options: Partial<
    Pick<
      SellerBundleFinalizationDurability,
      "workerId" | "reconcileSignature" | "reconcileBundleAnchor" | "reconcileBindingPublication"
    >
  > = {},
): SellerBundleFinalizationDurability {
  return {
    store,
    workerId: options.workerId ?? "worker-a",
    leaseTtlMs: 60_000,
    reconcileSignature:
      options.reconcileSignature ?? vi.fn(() => ({ disposition: "safe-to-sign" as const })),
    reconcileBundleAnchor:
      options.reconcileBundleAnchor ?? vi.fn(() => ({ disposition: "safe-to-submit" as const })),
    reconcileBindingPublication:
      options.reconcileBindingPublication ??
      vi.fn(() => ({ disposition: "safe-to-publish" as const })),
  };
}

function failCheckpointOutcomeOnce(base: SessionStore, key: string): SessionStore {
  let fail = true;
  return {
    ...base,
    transition: async (input) => {
      if (
        fail &&
        input.checkpoint?.key === key &&
        input.checkpoint.stage === "outcome"
      ) {
        fail = false;
        throw new Error(`simulated crash after ${key}`);
      }
      return base.transition(input);
    },
  };
}

describe("durable DACS-5 seller bundle finalization (#55)", () => {
  test("checkpoints public signatures, seller anchor, pure mapping, receipt, and final status", async () => {
    const f = fixture();
    const store = createInMemorySessionStore();
    const durable = durability(store);

    const result = await finalizeCompletedSellerBundleDurable(f.input, f.provider, durable);

    expect(result.state).toBe("finalised");
    expect(f.buyerSign).toHaveBeenCalledOnce();
    expect(f.sellerSign).toHaveBeenCalledOnce();
    expect(f.provider.submitSellerBundle).toHaveBeenCalledOnce();
    expect(durable.reconcileSignature).not.toHaveBeenCalled();
    expect(durable.reconcileBundleAnchor).not.toHaveBeenCalled();
    expect(await getSellerBundleFinalizationStatus(store, JOB_ID)).toMatchObject({
      status: "ok",
      phase: "seller:finalised",
      signatures: {
        buyer: "outcome",
        seller: "outcome",
        orchestrator: "not-started",
        binding: "not-started",
      },
      bundleAnchor: "outcome",
      bindingPublication: "not-applicable",
      bundleReceipt: `stor-${"7".repeat(40)}`,
    });
  });

  test("replays from finalized substrate state without signing, anchoring, or publishing again", async () => {
    const f = fixture("write-input");
    const store = createInMemorySessionStore();
    const durable = durability(store);
    const first = await finalizeCompletedSellerBundleDurable(f.input, f.provider, durable);
    f.buyerSign.mockClear();
    f.sellerSign.mockClear();
    f.bindingSign.mockClear();
    vi.mocked(f.provider.submitSellerBundle).mockClear();
    vi.mocked(f.provider.publishBundleBinding!).mockClear();

    const replay = await finalizeCompletedSellerBundleDurable(f.input, f.provider, durable);
    expect(replay).toEqual({ ...first, resumedBundle: true, resumedBinding: true });
    expect(f.buyerSign).not.toHaveBeenCalled();
    expect(f.sellerSign).not.toHaveBeenCalled();
    expect(f.bindingSign).not.toHaveBeenCalled();
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
    expect(f.provider.publishBundleBinding).not.toHaveBeenCalled();
  });

  test("recovers a crash after remote signing without requesting the same signature again", async () => {
    const f = fixture();
    const base = createInMemorySessionStore();
    const store = failCheckpointOutcomeOnce(
      base,
      sellerBundleFinalizationCheckpointKey.signature("buyer"),
    );
    const reconcileSignature = vi.fn((input: { role: string }) =>
      input.role === "buyer"
        ? {
            disposition: "signed" as const,
            value: new Uint8Array(64).fill(11),
          }
        : { disposition: "safe-to-sign" as const },
    );
    const durable = durability(store, { reconcileSignature });

    await expect(
      finalizeCompletedSellerBundleDurable(f.input, f.provider, durable),
    ).rejects.toThrow(/simulated crash/);
    expect(f.buyerSign).toHaveBeenCalledOnce();
    expect(f.sellerSign).not.toHaveBeenCalled();
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();

    const recovered = await finalizeCompletedSellerBundleDurable(
      f.input,
      f.provider,
      durable,
    );
    expect(recovered.state).toBe("finalised");
    expect(reconcileSignature).toHaveBeenCalledOnce();
    expect(f.buyerSign).toHaveBeenCalledOnce();
    expect(f.sellerSign).toHaveBeenCalledOnce();
  });

  test("recovers a crash after bundle anchoring without repeating the external write", async () => {
    const f = fixture();
    const base = createInMemorySessionStore();
    const store = failCheckpointOutcomeOnce(
      base,
      sellerBundleFinalizationCheckpointKey.anchor,
    );
    const durable = durability(store);

    await expect(
      finalizeCompletedSellerBundleDurable(f.input, f.provider, durable),
    ).rejects.toThrow(/simulated crash/);
    expect(f.state.anchored).toBeDefined();
    expect(f.provider.submitSellerBundle).toHaveBeenCalledOnce();
    f.buyerSign.mockClear();
    f.sellerSign.mockClear();

    const recovered = await finalizeCompletedSellerBundleDurable(
      f.input,
      f.provider,
      durable,
    );
    expect(recovered.resumedBundle).toBe(true);
    expect(f.provider.submitSellerBundle).toHaveBeenCalledOnce();
    expect(f.buyerSign).not.toHaveBeenCalled();
    expect(f.sellerSign).not.toHaveBeenCalled();
  });

  test("reuses checkpointed signatures and retries an anchor only after safe-to-submit", async () => {
    const f = fixture();
    const store = createInMemorySessionStore();
    const reconcileAnchor = vi.fn(() => ({ disposition: "safe-to-submit" as const }));
    const durable = durability(store, { reconcileBundleAnchor: reconcileAnchor });
    vi.mocked(f.provider.submitSellerBundle)
      .mockImplementationOnce(() => {
        throw new Error("crash before confirmed anchor");
      })
      .mockImplementation((logicalAddress, bundle) => f.anchor(logicalAddress, bundle));

    await expect(
      finalizeCompletedSellerBundleDurable(f.input, f.provider, durable),
    ).rejects.toThrow(/resolve before any retry/);
    expect(f.buyerSign).toHaveBeenCalledOnce();
    expect(f.sellerSign).toHaveBeenCalledOnce();

    const recovered = await finalizeCompletedSellerBundleDurable(
      f.input,
      f.provider,
      durable,
    );
    expect(recovered.state).toBe("finalised");
    expect(reconcileAnchor).toHaveBeenCalledOnce();
    expect(f.provider.submitSellerBundle).toHaveBeenCalledTimes(2);
    expect(f.buyerSign).toHaveBeenCalledOnce();
    expect(f.sellerSign).toHaveBeenCalledOnce();
  });

  test("never re-submits an unresolved prior anchor intent", async () => {
    const f = fixture();
    const store = createInMemorySessionStore();
    const reconcileAnchor = vi.fn(() => ({
      disposition: "indeterminate" as const,
      reason: "pending writer nonce cannot be ordered",
    }));
    const durable = durability(store, { reconcileBundleAnchor: reconcileAnchor });
    vi.mocked(f.provider.submitSellerBundle).mockImplementation(() => {
      throw new Error("timeout");
    });
    await expect(
      finalizeCompletedSellerBundleDurable(f.input, f.provider, durable),
    ).rejects.toThrow(/resolve before any retry/);

    await expect(
      finalizeCompletedSellerBundleDurable(f.input, f.provider, durable),
    ).rejects.toThrow(/resolve before any retry/);
    expect(f.provider.submitSellerBundle).toHaveBeenCalledOnce();
    expect(reconcileAnchor).toHaveBeenCalledOnce();
  });

  test("recovers a crash after binding publication without publishing again", async () => {
    const f = fixture("write-input");
    const base = createInMemorySessionStore();
    const store = failCheckpointOutcomeOnce(
      base,
      sellerBundleFinalizationCheckpointKey.bindingPublication,
    );
    const durable = durability(store);

    await expect(
      finalizeCompletedSellerBundleDurable(f.input, f.provider, durable),
    ).rejects.toThrow(/simulated crash/);
    expect(f.state.binding).toBeDefined();
    expect(f.provider.publishBundleBinding).toHaveBeenCalledOnce();
    f.bindingSign.mockClear();

    const recovered = await finalizeCompletedSellerBundleDurable(
      f.input,
      f.provider,
      durable,
    );
    expect(recovered.resumedBinding).toBe(true);
    expect(f.provider.publishBundleBinding).toHaveBeenCalledOnce();
    expect(f.bindingSign).not.toHaveBeenCalled();
  });

  test("never republishes an unresolved prior BundleBinding intent", async () => {
    const f = fixture("write-input");
    const store = createInMemorySessionStore();
    const reconcileBindingPublication = vi.fn(() => ({
      disposition: "indeterminate" as const,
      reason: "catalog write acknowledgement cannot be authenticated",
    }));
    const durable = durability(store, { reconcileBindingPublication });
    vi.mocked(f.provider.publishBundleBinding!).mockImplementation(() => {
      throw new Error("catalog timeout");
    });

    await expect(
      finalizeCompletedSellerBundleDurable(f.input, f.provider, durable),
    ).rejects.toThrow(/publication outcome is ambiguous/);
    expect(f.provider.publishBundleBinding).toHaveBeenCalledOnce();
    expect(f.bindingSign).toHaveBeenCalledOnce();

    await expect(
      finalizeCompletedSellerBundleDurable(f.input, f.provider, durable),
    ).rejects.toThrow(/publication is indeterminate/);
    expect(reconcileBindingPublication).toHaveBeenCalledOnce();
    expect(f.provider.publishBundleBinding).toHaveBeenCalledOnce();
    expect(f.bindingSign).toHaveBeenCalledOnce();
  });

  test("replays from a newly opened filesystem store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dacs-seller-bundle-recovery-"));
    try {
      const f = fixture();
      const firstStore = await createFsSessionStore({ dir: directory });
      await finalizeCompletedSellerBundleDurable(
        f.input,
        f.provider,
        durability(firstStore),
      );
      f.buyerSign.mockClear();
      f.sellerSign.mockClear();
      vi.mocked(f.provider.submitSellerBundle).mockClear();

      const reopenedStore = await createFsSessionStore({ dir: directory });
      const replay = await finalizeCompletedSellerBundleDurable(
        f.input,
        f.provider,
        durability(reopenedStore),
      );
      expect(replay.resumedBundle).toBe(true);
      expect(f.buyerSign).not.toHaveBeenCalled();
      expect(f.sellerSign).not.toHaveBeenCalled();
      expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("fails closed when another worker holds the active seller lease", async () => {
    const f = fixture();
    const store = createInMemorySessionStore();
    await store.create({
      jobId: JOB_ID,
      agreementHash: f.input.agreement.contentHash,
      phase: "seller:audit-pending",
    });
    await store.acquireLease({ jobId: JOB_ID, owner: "worker-a", ttlMs: 60_000 });

    await expect(
      finalizeCompletedSellerBundleDurable(
        f.input,
        f.provider,
        durability(store, { workerId: "worker-b" }),
      ),
    ).rejects.toThrow(/lease is held by another worker/);
    expect(f.buyerSign).not.toHaveBeenCalled();
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
  });

  test("corrupt durable state is never reset to missing", async () => {
    const f = fixture();
    const base = createInMemorySessionStore();
    const corrupt: SessionStore = {
      ...base,
      load: async () => ({ status: "corrupt", reason: "invalid checkpoint" }),
    };
    await expect(
      finalizeCompletedSellerBundleDurable(f.input, f.provider, durability(corrupt)),
    ).rejects.toThrow(/state is corrupt/);
    expect(f.buyerSign).not.toHaveBeenCalled();
  });
});
