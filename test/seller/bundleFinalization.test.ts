import { readFileSync } from "node:fs";

import { describe, expect, test, vi } from "vitest";

import {
  BUNDLE_BINDING_SEPARATOR,
  ARTIFACT_SEPARATORS,
  type AnchorReceipt,
  type AttestationRef,
  type BundleBinding,
  type FaultAttestationBundle,
} from "../../src/artifacts/index.js";
import {
  bundleAddress,
  contentHash,
} from "../../src/canonical/index.js";
import {
  ed25519Sign,
  ed25519Verify,
  privateKeyFromSeed,
  publicKeyFromSeed,
  signedBytes,
} from "../../src/crypto/index.js";
import {
  attestationBundleHash,
} from "../../src/agent/twoSidedBundle.js";
import type {
  SellerFulfilmentAgreement,
  SellerFulfilmentResult,
} from "../../src/agent/runFulfilmentCore.js";
import {
  finalizeCompletedSellerBundleCore,
  type AnchoredSellerBundle,
  type FinalizeCompletedSellerBundleInput,
  type SellerBundleFinalizationProvider,
} from "../../src/seller/bundleFinalization.js";
import { isBundleBinding } from "../../src/artifacts/validators.js";

const NOW = 1_786_000_000_000;
const BUYER = "did:demos:buyer";
const SELLER = "did:demos:seller";
const BUYER_SEED = new Uint8Array(32).fill(31);
const SELLER_SEED = new Uint8Array(32).fill(32);

const artifact = (kind: string): Record<string, unknown> => ({
  artifactVersion: "1",
  kind,
  jobId: "seller-finalization-17",
});

const ref = (name: string, value: Record<string, unknown>): AttestationRef => ({
  anchor: { kind: "storage-program", locator: `dacs-test:${name}` },
  contentHash: contentHash(value),
});

function receipt(
  contentHashValue: string,
  logicalAddress = `dacs-test:${contentHashValue.slice(0, 12)}`,
  nativeAddress = `stor-${contentHashValue.slice(0, 40)}`,
): AnchorReceipt {
  return {
    receiptVersion: "1",
    substrate: "test:final",
    finalityProfile: "test-final",
    logicalAddress,
    nativeAddress,
    contentHash: contentHashValue,
    transactionRef: { kind: "test", value: `tx-${contentHashValue.slice(0, 16)}` },
    writer: "test-writer",
    state: "finalized",
    observationDisposition: "established",
    observedAt: NOW,
    blockRef: { id: `block-${contentHashValue.slice(0, 8)}`, timestamp: NOW - 1_000 },
    evidence: { kind: "test-finality", value: `proof-${contentHashValue.slice(0, 16)}` },
  };
}

function bundleSignaturesVerify(bundle: FaultAttestationBundle): boolean {
  const keys = new Map([
    [BUYER, publicKeyFromSeed(BUYER_SEED)],
    [SELLER, publicKeyFromSeed(SELLER_SEED)],
  ]);
  if (
    bundle.signatures.length !== 2 ||
    !bundle.signatures.some((signature) => signature.party === BUYER) ||
    !bundle.signatures.some((signature) => signature.party === SELLER)
  ) {
    return false;
  }
  const bytes = signedBytes(
    ARTIFACT_SEPARATORS.FaultAttestationBundle,
    attestationBundleHash(bundle),
  );
  return bundle.signatures.every((signature) => {
    const key = keys.get(signature.party);
    return (
      signature.algorithm === "ed25519" &&
      key !== undefined &&
      ed25519Verify(bytes, Buffer.from(signature.value, "base64url"), key)
    );
  });
}

function bindingSignatureVerifies(binding: BundleBinding): boolean {
  return (
    binding.signer === SELLER &&
    binding.signature.signer === SELLER &&
    binding.signature.algorithm === "ed25519" &&
    ed25519Verify(
      signedBytes(
        BUNDLE_BINDING_SEPARATOR,
        contentHash(binding as unknown as Record<string, unknown>),
      ),
      Buffer.from(binding.signature.value, "base64url"),
      publicKeyFromSeed(SELLER_SEED),
    )
  );
}

function fixture(mapping: "pure" | "write-input" = "pure") {
  const listingArtifact = artifact("listing");
  const agreementArtifact = artifact("agreement");
  const commitmentArtifact = artifact("commitment");
  const paymentArtifact = artifact("payment-evidence");
  const listingHash = contentHash(listingArtifact);
  const agreementRef = ref("agreement", agreementArtifact);
  const commitmentRef = ref("commitment", commitmentArtifact);
  const paymentRef = ref("payment", paymentArtifact);

  const deliveryEvidence = {
    evidenceVersion: "1" as const,
    jobId: "seller-finalization-17",
    phase: "deliver-storage-program" as const,
    observedAt: NOW - 2_000,
    outcome: "success" as const,
    deliverableContentHash: "a".repeat(64),
    deliverableAnchor: {
      kind: "storage-program",
      locator: "dacs4:deliverable:seller-finalization-17",
    },
    signature: {
      algorithm: "ed25519" as const,
      signer: SELLER,
      value: "c2ln",
    },
  };
  const deliveryHash = contentHash(deliveryEvidence);
  const deliveryRef: AttestationRef = {
    anchor: { kind: "storage-program", locator: "dacs4:delivery:seller-finalization-17:2" },
    contentHash: deliveryHash,
  };
  const fulfilment: Extract<SellerFulfilmentResult, { decision: "completed" }> = {
    decision: "completed",
    fulfilmentId: "fulfilment-17",
    evidence: deliveryEvidence,
    evidenceHash: deliveryHash,
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
    ref: "agreement:seller-finalization-17",
    contentHash: agreementRef.contentHash,
    jobId: "seller-finalization-17",
    listingPin: {
      listingId: "listing-finalization-17",
      version: 4,
      contentHash: listingHash,
    },
    buyer: { primaryClaim: BUYER, bundleHash: "b".repeat(64) },
    seller: { primaryClaim: SELLER, bundleHash: "c".repeat(64) },
    deliverableRef: {
      deliverableType: "storage-program",
      hash: "d".repeat(64),
    },
    signaturesVerified: true,
    commitment: {
      status: "finalized",
      ref: "commitment:seller-finalization-17",
      agreementHash: agreementRef.contentHash,
      recordContentHash: commitmentRef.contentHash,
      finalizedAt: NOW - 10_000,
    },
  };

  const buyerSign = vi.fn((bytes: Uint8Array) =>
    ed25519Sign(bytes, privateKeyFromSeed(BUYER_SEED)),
  );
  const sellerSign = vi.fn((bytes: Uint8Array) =>
    ed25519Sign(bytes, privateKeyFromSeed(SELLER_SEED)),
  );
  const bindingSign = vi.fn((bytes: Uint8Array) =>
    ed25519Sign(bytes, privateKeyFromSeed(SELLER_SEED)),
  );
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
    buyer: {
      primaryClaim: BUYER,
      bundleHash: agreement.buyer.bundleHash,
      signer: buyerSign,
    },
    seller: {
      primaryClaim: SELLER,
      bundleHash: agreement.seller.bundleHash,
      signer: sellerSign,
    },
    dependencies: [],
    bindingSigner: {
      algorithm: "ed25519",
      signer: SELLER,
      sign: bindingSign,
    },
  };

  const artifacts = new Map<string, Record<string, unknown>>([
    [listingHash, listingArtifact],
    [agreementRef.contentHash, agreementArtifact],
    [commitmentRef.contentHash, commitmentArtifact],
    [paymentRef.contentHash, paymentArtifact],
    [deliveryRef.contentHash, deliveryEvidence],
  ]);
  input.dependencies = [...artifacts.keys()].map((hash) => ({
    contentHash: hash,
    anchorReceipt: receipt(hash),
  }));

  const state: {
    anchored?: AnchoredSellerBundle;
    binding?: BundleBinding;
  } = {};
  const anchor = (logicalAddress: string, bundle: FaultAttestationBundle): void => {
    const hash = attestationBundleHash(bundle);
    const nativeAddress = `stor-${"7".repeat(40)}`;
    state.anchored = {
      bundle,
      nativeAddress,
      anchorTx: "test:bundle-anchor-tx",
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
    verifySellerBundle: vi.fn((bundle) =>
      bundleSignaturesVerify(bundle) ? "valid" as const : "invalid" as const,
    ),
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
    verifyBundleBinding: vi.fn((binding) =>
      bindingSignatureVerifies(binding) ? "valid" as const : "invalid" as const,
    ),
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

describe("DACS-5 ST-11 seller completed-bundle finalization", () => {
  test("audits every dependency, co-signs both copies, and finalizes only the seller copy", async () => {
    const f = fixture();
    const result = await finalizeCompletedSellerBundleCore(f.input, f.provider);

    expect(result).toMatchObject({
      state: "finalised",
      logicalAddress: bundleAddress("seller-finalization-17", "seller"),
      nativeAddress: `stor-${"7".repeat(40)}`,
      resumedBundle: false,
      resumedBinding: false,
      sellerBundle: { anchoredByRole: "seller", outcome: "completed", faultedParty: "none" },
      buyerBundle: { anchoredByRole: "buyer", outcome: "completed", faultedParty: "none" },
    });
    expect(result.binding).toBeUndefined();
    expect(result.sellerBundle.phaseSummary.map((phase) => phase.index)).toEqual([0, 1, 2]);
    expect(result.sellerBundle.settlementEvidence).toHaveLength(2);
    expect(attestationBundleHash(result.sellerBundle)).toBe(
      attestationBundleHash(result.buyerBundle),
    );
    expect(f.provider.verifyDependencyReceipt).toHaveBeenCalledTimes(5);
    expect(f.provider.resolveDependency).toHaveBeenCalledTimes(5);
    expect(f.provider.submitSellerBundle).toHaveBeenCalledOnce();
    expect(f.provider.resolveBundleBinding).not.toHaveBeenCalled();
    expect(f.provider.publishBundleBinding).not.toHaveBeenCalled();
    expect(f.buyerSign).toHaveBeenCalled();
    expect(f.sellerSign).toHaveBeenCalled();
  });

  test("publishes an exact seller-signed BundleBinding on write-input mappings", async () => {
    const f = fixture("write-input");
    const result = await finalizeCompletedSellerBundleCore(f.input, f.provider);

    expect(result.binding).toMatchObject({
      bindingVersion: "1",
      jobId: "seller-finalization-17",
      role: "seller",
      logicalAddress: bundleAddress("seller-finalization-17", "seller"),
      nativeAddress: `stor-${"7".repeat(40)}`,
      bundleContentHash: result.bundleContentHash,
      anchorTx: "test:bundle-anchor-tx",
      signer: SELLER,
      signature: { signer: SELLER, algorithm: "ed25519" },
    });
    expect(isBundleBinding(result.binding)).toBe(true);
    expect(bindingSignatureVerifies(result.binding!)).toBe(true);
    expect(f.provider.publishBundleBinding).toHaveBeenCalledOnce();
    expect(f.bindingSign).toHaveBeenCalledOnce();
  });

  test("resumes an existing verified seller copy without invoking either party signer", async () => {
    const f = fixture();
    await finalizeCompletedSellerBundleCore(f.input, f.provider);
    f.buyerSign.mockClear();
    f.sellerSign.mockClear();
    vi.mocked(f.provider.submitSellerBundle).mockClear();

    const resumed = await finalizeCompletedSellerBundleCore(f.input, f.provider);
    expect(resumed.resumedBundle).toBe(true);
    expect(f.buyerSign).not.toHaveBeenCalled();
    expect(f.sellerSign).not.toHaveBeenCalled();
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
    expect(attestationBundleHash(resumed.buyerBundle)).toBe(resumed.bundleContentHash);
  });

  test("resumes an existing verified BundleBinding without signing or publishing again", async () => {
    const f = fixture("write-input");
    await finalizeCompletedSellerBundleCore(f.input, f.provider);
    f.buyerSign.mockClear();
    f.sellerSign.mockClear();
    f.bindingSign.mockClear();
    vi.mocked(f.provider.submitSellerBundle).mockClear();
    vi.mocked(f.provider.publishBundleBinding!).mockClear();

    const resumed = await finalizeCompletedSellerBundleCore(f.input, f.provider);
    expect(resumed).toMatchObject({ resumedBundle: true, resumedBinding: true });
    expect(f.buyerSign).not.toHaveBeenCalled();
    expect(f.sellerSign).not.toHaveBeenCalled();
    expect(f.bindingSign).not.toHaveBeenCalled();
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
    expect(f.provider.publishBundleBinding).not.toHaveBeenCalled();
  });

  test("never overwrites an existing seller-role copy that binds different session facts", async () => {
    const f = fixture();
    await finalizeCompletedSellerBundleCore(f.input, f.provider);
    f.state.anchored = {
      ...f.state.anchored!,
      bundle: {
        ...(f.state.anchored!.bundle as FaultAttestationBundle),
        finalisedAt: NOW + 1,
      },
    };
    vi.mocked(f.provider.submitSellerBundle).mockClear();
    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).rejects.toThrow(
      /binds different session content/,
    );
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
  });

  test("reconciles a thrown submission when the exact bundle became readable", async () => {
    const f = fixture();
    f.provider.submitSellerBundle = vi.fn((logicalAddress, bundle) => {
      f.anchor(logicalAddress, bundle);
      throw new Error("HTTP response stalled after inclusion");
    });
    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).resolves.toMatchObject({
      state: "finalised",
      resumedBundle: false,
    });
  });

  test("does not sign or submit while any referenced artifact is unaudited", async () => {
    const f = fixture();
    f.input.dependencies.pop();
    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).rejects.toThrow(
      /exactly cover every referenced artifact/,
    );
    expect(f.buyerSign).not.toHaveBeenCalled();
    expect(f.sellerSign).not.toHaveBeenCalled();
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
  });

  test("fails closed on an indeterminate dependency read before any bundle side effect", async () => {
    const f = fixture();
    f.provider.resolveDependency = vi.fn(() => ({
      disposition: "indeterminate" as const,
      reason: "read quorum unavailable",
    }));
    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).rejects.toThrow(
      /resolution is indeterminate/,
    );
    expect(f.buyerSign).not.toHaveBeenCalled();
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
  });

  test("treats an indeterminate bundle lookup as not-absent and never overwrites", async () => {
    const f = fixture();
    f.provider.resolveSellerBundle = vi.fn(() => ({
      disposition: "indeterminate" as const,
      reason: "ordinary not found is not authoritative absence",
    }));
    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).rejects.toThrow(
      /lookup is indeterminate/,
    );
    expect(f.buyerSign).not.toHaveBeenCalled();
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
  });

  test("requires reconciliation after an ambiguous submission that remains unreadable", async () => {
    const f = fixture();
    f.provider.submitSellerBundle = vi.fn(() => {
      throw new Error("timeout");
    });
    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).rejects.toThrow(
      /resolve before any retry/,
    );
    expect(f.provider.submitSellerBundle).toHaveBeenCalledOnce();
  });

  test("rejects a finalized receipt whose bundle hash binding is wrong", async () => {
    const f = fixture();
    f.provider.submitSellerBundle = vi.fn((logicalAddress, bundle) => {
      f.anchor(logicalAddress, bundle);
      f.state.anchored!.anchorReceipt = {
        ...f.state.anchored!.anchorReceipt,
        contentHash: "f".repeat(64),
      };
    });
    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).rejects.toThrow(
      /exact established finalized AnchorReceipt/,
    );
  });

  test("write-input mapping fails closed when binding discovery is indeterminate", async () => {
    const f = fixture("write-input");
    f.provider.resolveBundleBinding = vi.fn(() => ({
      disposition: "indeterminate" as const,
      reason: "catalog unavailable",
    }));
    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).rejects.toThrow(
      /BundleBinding lookup is indeterminate/,
    );
    expect(f.bindingSign).not.toHaveBeenCalled();
    expect(f.provider.publishBundleBinding).not.toHaveBeenCalled();
  });
});

describe("DACS-5 §10.4.2 BundleBinding Standard vectors", () => {
  test("derives vector logical addresses and rejects the internally inconsistent tuple", () => {
    const vectorSet = JSON.parse(
      readFileSync(
        "vendor/DACS-Standard/conformance/vectors/security/bundle-binding-v0.1.json",
        "utf8",
      ),
    ) as {
      vectors: Array<{
        name: string;
        request: { jobId: string; role: "buyer" | "seller" | "orchestrator" };
        bindings: BundleBinding[];
      }>;
    };
    for (const vector of vectorSet.vectors) {
      const requestedAddress = bundleAddress(vector.request.jobId, vector.request.role);
      for (const binding of vector.bindings) {
        expect(binding.logicalAddress === requestedAddress).toBe(
          vector.name !== "bb-missing-binding",
        );
        expect(binding.logicalAddress).toBe(
          vector.name === "bb-tuple-mismatch"
            ? requestedAddress
            : bundleAddress(binding.jobId, binding.role),
        );
        expect(isBundleBinding(binding)).toBe(vector.name !== "bb-tuple-mismatch");
      }
    }
  });
});
