import { beforeEach, describe, expect, test, vi } from "vitest";

const sellerMocks = vi.hoisted(() => ({
  verifyRequest: vi.fn(),
  verifyFinalization: vi.fn(),
}));

vi.mock("../../src/seller/bundleFinalization.js", () => ({
  verifyCompletedSellerBundleCounterSignatureRequest: sellerMocks.verifyRequest,
  verifyFinalizedSellerBundleReadOnly: sellerMocks.verifyFinalization,
}));

import {
  BUNDLE_BINDING_SEPARATOR,
  ARTIFACT_SEPARATORS,
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
import { DacsError, SubstrateError } from "../../src/errors.js";
import {
  attestationBundleHash,
  bundleSignedScope,
  type SigningSessionParty,
} from "../../src/agent/twoSidedBundle.js";
import {
  createCompletedBuyerBundleCounterSignature,
  finalizeCompletedBuyerBundleCore,
  type AnchoredBuyerBundle,
  type BuyerBundleFinalizationProvider,
  type CreateCompletedBuyerBundleCounterSignatureInput,
  type FinalizeCompletedBuyerBundleInput,
} from "../../src/agent/buyerBundleFinalization.js";
import type {
  CompletedSellerBundleCounterSignatureRequest,
  FinalizedSellerBundle,
  VerifyCompletedSellerBundleCounterSignatureRequestInput,
  VerifyFinalizedSellerBundleInput,
} from "../../src/seller/bundleFinalization.js";

const NOW = 1_786_100_000_000;
const JOB_ID = "buyer-finalization-81";
const BUYER = "did:demos:buyer";
const SELLER = "did:demos:seller";
const BUYER_HASH = "1".repeat(64);
const SELLER_HASH = "2".repeat(64);
const BUYER_SEED = new Uint8Array(32).fill(71);
const SELLER_SEED = new Uint8Array(32).fill(72);

function signBundleScope(
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

function bundleScope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    faultBundleVersion: "1",
    faultedParty: "none",
    jobId: JOB_ID,
    outcome: "completed",
    listingRef: {
      listingId: "buyer-finalization-listing",
      version: 1,
      contentHash: "3".repeat(64),
    },
    agreementRef: {
      anchor: { kind: "storage-program", locator: "dacs3:agreement:81" },
      contentHash: "4".repeat(64),
    },
    parties: [
      { role: "buyer", primaryClaim: BUYER, bundleHash: BUYER_HASH },
      { role: "seller", primaryClaim: SELLER, bundleHash: SELLER_HASH },
    ],
    phaseSummary: [],
    vetRecords: [],
    settlementEvidence: [],
    recipeRegistryVersion: 7,
    railRegistryVersion: 9,
    finalisedAt: NOW,
    ...overrides,
  };
}

function bundleCopies(scope = bundleScope()): {
  buyerBundle: FaultAttestationBundle;
  sellerBundle: FaultAttestationBundle;
  buyerSignature: BundleSignature;
} {
  const buyerSignature = signBundleScope(scope, BUYER, BUYER_SEED);
  const sellerSignature = signBundleScope(scope, SELLER, SELLER_SEED);
  const common = {
    ...structuredClone(scope),
    signatures: [buyerSignature, sellerSignature],
  };
  return {
    buyerBundle: {
      ...common,
      anchoredByRole: "buyer",
    } as FaultAttestationBundle,
    sellerBundle: {
      ...common,
      anchoredByRole: "seller",
    } as FaultAttestationBundle,
    buyerSignature,
  };
}

function requestFor(
  sellerBundle: FaultAttestationBundle,
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
    requiredCounterSigners: [BUYER],
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

function anchoredBuyer(bundle: FaultAttestationBundle): AnchoredBuyerBundle {
  const hash = attestationBundleHash(bundle);
  const logicalAddress = bundleAddress(bundle.jobId, "buyer");
  const nativeAddress = `stor-${"8".repeat(40)}`;
  return {
    bundle: structuredClone(bundle),
    nativeAddress,
    anchorTx: "test:buyer-anchor-tx",
    anchorReceipt: receipt(logicalAddress, nativeAddress, hash),
  };
}

function signBinding(unsigned: Omit<BundleBinding, "signature">): BundleBinding {
  return {
    ...unsigned,
    signature: {
      signer: BUYER,
      algorithm: "ed25519",
      value: Buffer.from(
        ed25519Sign(
          signedBytes(
            BUNDLE_BINDING_SEPARATOR,
            contentHash(unsigned as unknown as Record<string, unknown>),
          ),
          privateKeyFromSeed(BUYER_SEED),
        ),
      ).toString("base64url"),
    },
  };
}

interface FixtureState {
  anchored?: AnchoredBuyerBundle;
  binding?: BundleBinding;
}

function fixture(mapping: "pure" | "write-input" = "pure") {
  const copies = bundleCopies();
  const request = requestFor(copies.sellerBundle);
  const buyerSigner = vi.fn((bytes: Uint8Array) =>
    ed25519Sign(bytes, privateKeyFromSeed(BUYER_SEED)),
  );
  const buyer: SigningSessionParty = {
    primaryClaim: BUYER,
    bundleHash: BUYER_HASH,
    signer: buyerSigner,
  };
  const sellerVerificationInput = {
    counterSignatures: [structuredClone(copies.buyerSignature)],
  } as unknown as VerifyFinalizedSellerBundleInput;
  const requestVerificationInput = {} as
    VerifyCompletedSellerBundleCounterSignatureRequestInput;
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
    anchorReceipt: receipt(sellerLogicalAddress, sellerNativeAddress, sellerHash),
    anchorTx: "test:seller-anchor-tx",
    resumedBundle: false,
    resumedBinding: false,
  };
  const state: FixtureState = {};
  const submitBuyerBundle = vi.fn(
    (logicalAddress: string, bundle: Readonly<FaultAttestationBundle>) => {
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
  );
  const resolveBuyerBundle = vi.fn((_logicalAddress: string) =>
    state.anchored
      ? { disposition: "present" as const, anchored: structuredClone(state.anchored) }
      : { disposition: "absent" as const },
  );
  const publishBundleBinding = vi.fn((binding: Readonly<BundleBinding>) => {
    state.binding = structuredClone(binding);
    return { disposition: "published" as const };
  });
  const provider = {
    mapping,
    bundleCopyVerifier: {
      resolvePublicKey: vi.fn(async (claim: string) =>
        claim === BUYER
          ? rawPublicKey(publicKeyFromSeed(BUYER_SEED))
          : claim === SELLER
            ? rawPublicKey(publicKeyFromSeed(SELLER_SEED))
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
      verifyAuthorityAttestation: vi.fn(async () => ({
        disposition: "indeterminate",
        reason: "unused buyer fixture seam",
      })),
    },
    resolveDependency: vi.fn(() => ({ disposition: "absent" as const })),
    verifyDependencyReceipt: vi.fn(() => "indeterminate" as const),
    verifyDependencyBinding: vi.fn(() => "indeterminate" as const),
    verifyListingPublisherIdentityLinkage: vi.fn(
      () => "indeterminate" as const,
    ),
    verifyVetRequirementProvenance: vi.fn(() => "indeterminate" as const),
    resolveSellerBundle: vi.fn(() => ({ disposition: "absent" as const })),
    resolveBuyerBundle,
    submitBuyerBundle,
    verifyBundleAnchorReceipt: vi.fn(() => "valid" as const),
    resolveBundleBinding: vi.fn(() =>
      state.binding
        ? { disposition: "present" as const, binding: structuredClone(state.binding) }
        : { disposition: "absent" as const },
    ),
    publishBundleBinding,
    verifyBundleBinding: vi.fn(() => "valid" as const),
  } as unknown as BuyerBundleFinalizationProvider;
  const counterInput: CreateCompletedBuyerBundleCounterSignatureInput = {
    sellerVerificationInput: requestVerificationInput,
    buyer,
  };
  const finalizeInput: FinalizeCompletedBuyerBundleInput = {
    sellerVerificationInput,
    sellerFinalization,
    counterSignature: copies.buyerSignature,
    buyer,
  };
  return {
    ...copies,
    request,
    buyer,
    buyerSigner,
    sellerVerificationInput,
    requestVerificationInput,
    sellerFinalization,
    state,
    provider,
    counterInput,
    finalizeInput,
    submitBuyerBundle,
    resolveBuyerBundle,
    publishBundleBinding,
  };
}

beforeEach(() => {
  sellerMocks.verifyRequest.mockReset();
  sellerMocks.verifyFinalization.mockReset();
  sellerMocks.verifyRequest.mockImplementation(
    async (_input, supplied) => structuredClone(supplied),
  );
  sellerMocks.verifyFinalization.mockImplementation(
    async (_input, supplied) => structuredClone(supplied),
  );
});

describe("DACS-5 buyer completed-bundle counter-signing", () => {
  test("signs only the independently authenticated request and verifies the local buyer key", async () => {
    const f = fixture();
    const signature = await createCompletedBuyerBundleCounterSignature(
      f.counterInput,
      f.request,
      f.provider,
    );

    expect(sellerMocks.verifyRequest).toHaveBeenCalledOnce();
    expect(signature).toEqual(f.buyerSignature);
    expect(Buffer.from(signature.value, "base64url")).toHaveLength(64);
    expect(signature.value).toBe(Buffer.from(signature.value, "base64url").toString("base64url"));
    expect(Array.from(f.buyerSigner.mock.calls[0]![0])).toEqual(
      Array.from(f.request.signedBytes),
    );
    expect(Object.isFrozen(signature)).toBe(true);
  });

  test("never invokes the buyer signer when seller request authentication fails", async () => {
    const f = fixture();
    sellerMocks.verifyRequest.mockRejectedValueOnce(new DacsError("substituted scope"));

    await expect(
      createCompletedBuyerBundleCounterSignature(
        f.counterInput,
        { ...f.request, bundleContentHash: "f".repeat(64) },
        f.provider,
      ),
    ).rejects.toThrow("substituted scope");
    expect(f.buyerSigner).not.toHaveBeenCalled();
  });

  test("rejects a verified request rebound to another buyer identity", async () => {
    const f = fixture();
    const rebound = structuredClone(f.request);
    const parties = rebound.signedScope.parties as Array<Record<string, unknown>>;
    parties[0] = { ...parties[0], primaryClaim: "did:demos:other-buyer" };
    sellerMocks.verifyRequest.mockResolvedValueOnce(rebound);

    await expect(
      createCompletedBuyerBundleCounterSignature(f.counterInput, f.request, f.provider),
    ).rejects.toThrow("local buyer IdentityBundle");
    expect(f.buyerSigner).not.toHaveBeenCalled();
  });

  test("rejects non-Ed25519-length signer output before local acceptance", async () => {
    const f = fixture();
    f.buyer.signer = vi.fn(() => new Uint8Array(63));

    await expect(
      createCompletedBuyerBundleCounterSignature(f.counterInput, f.request, f.provider),
    ).rejects.toThrow("one Ed25519 signature");
  });

  test("rejects a signature that does not verify under the locally resolved buyer key", async () => {
    const f = fixture();
    f.provider.bundleCopyVerifier.verify = vi.fn(async () => false);

    await expect(
      createCompletedBuyerBundleCounterSignature(f.counterInput, f.request, f.provider),
    ).rejects.toThrow("failed local verification");
  });

  test("rejects a provider proxy before authentication or signing", async () => {
    const f = fixture();
    const trap = vi.fn(() => {
      throw new Error("provider proxy trap must not run");
    });
    const liveProvider = new Proxy(f.provider, {
      get: trap,
      ownKeys: trap,
      getOwnPropertyDescriptor: trap,
    });

    await expect(
      createCompletedBuyerBundleCounterSignature(
        f.counterInput,
        f.request,
        liveProvider,
      ),
    ).rejects.toThrow("cannot be a proxy");
    expect(trap).not.toHaveBeenCalled();
    expect(sellerMocks.verifyRequest).not.toHaveBeenCalled();
    expect(f.buyerSigner).not.toHaveBeenCalled();
  });

  test("rejects provider accessors before authenticating or signing", async () => {
    const f = fixture();
    Object.defineProperty(f.provider, "mapping", {
      enumerable: true,
      configurable: true,
      get: () => "pure",
    });

    await expect(
      createCompletedBuyerBundleCounterSignature(
        f.counterInput,
        f.request,
        f.provider,
      ),
    ).rejects.toThrow("mapping must be one owned data property");
    expect(sellerMocks.verifyRequest).not.toHaveBeenCalled();
    expect(f.buyerSigner).not.toHaveBeenCalled();
  });
});

describe("DACS-5 buyer role finalization", () => {
  test("authenticates seller finalization before publishing the exact buyer role copy", async () => {
    const f = fixture();
    const result = await finalizeCompletedBuyerBundleCore(f.finalizeInput, f.provider);

    expect(sellerMocks.verifyFinalization).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      state: "finalised",
      logicalAddress: bundleAddress(JOB_ID, "buyer"),
      bundleContentHash: attestationBundleHash(f.buyerBundle),
      buyerBundle: { anchoredByRole: "buyer", jobId: JOB_ID },
      anchorTx: "test:buyer-anchor-tx",
    });
    expect(result.binding).toBeUndefined();
    expect(f.submitBuyerBundle).toHaveBeenCalledOnce();
    expect(f.submitBuyerBundle.mock.calls[0]).toHaveLength(2);
    expect(f.submitBuyerBundle.mock.calls[0]![0]).toBe(
      bundleAddress(JOB_ID, "buyer"),
    );
    expect(f.submitBuyerBundle.mock.calls[0]![1]).toMatchObject({
      anchoredByRole: "buyer",
      jobId: JOB_ID,
    });
    expect(
      f.resolveBuyerBundle.mock.calls.every((parameters) => parameters.length === 1),
    ).toBe(true);
    expect(
      f.resolveBuyerBundle.mock.calls.every(
        (parameters) => parameters[0] === bundleAddress(JOB_ID, "buyer"),
      ),
    ).toBe(true);
    expect(f.provider.verifyBundleAnchorReceipt).toHaveBeenCalledOnce();
  });

  test("rejects counter-signature substitution before any buyer publication", async () => {
    const f = fixture();
    f.finalizeInput.counterSignature = {
      ...f.buyerSignature,
      value: Buffer.from(new Uint8Array(64).fill(5)).toString("base64url"),
    };

    await expect(
      finalizeCompletedBuyerBundleCore(f.finalizeInput, f.provider),
    ).rejects.toThrow("substituted the reviewed detached signature");
    expect(f.submitBuyerBundle).not.toHaveBeenCalled();
  });

  test("rejects a seller result whose alleged buyer copy has the wrong role", async () => {
    const f = fixture();
    const wrong = structuredClone(f.sellerFinalization);
    wrong.buyerBundle.anchoredByRole = "seller";
    sellerMocks.verifyFinalization.mockResolvedValueOnce(wrong);

    await expect(
      finalizeCompletedBuyerBundleCore(f.finalizeInput, f.provider),
    ).rejects.toThrow("wrong buyer bundle role");
    expect(f.submitBuyerBundle).not.toHaveBeenCalled();
  });

  test("rejects a readback with a missing finalized receipt", async () => {
    const f = fixture();
    const anchored = anchoredBuyer(f.buyerBundle);
    delete (anchored as unknown as { anchorReceipt?: AnchorReceipt }).anchorReceipt;
    f.state.anchored = anchored;

    await expect(
      finalizeCompletedBuyerBundleCore(f.finalizeInput, f.provider),
    ).rejects.toThrow("established finalized publication");
    expect(f.submitBuyerBundle).not.toHaveBeenCalled();
  });

  test("rejects forged and indeterminate receipt proofs", async () => {
    const forged = fixture();
    forged.state.anchored = anchoredBuyer(forged.buyerBundle);
    forged.provider.verifyBundleAnchorReceipt = vi.fn(() => "invalid" as const);
    await expect(
      finalizeCompletedBuyerBundleCore(forged.finalizeInput, forged.provider),
    ).rejects.toThrow("anchor receipt proof is invalid");

    const indeterminate = fixture();
    indeterminate.state.anchored = anchoredBuyer(indeterminate.buyerBundle);
    indeterminate.state.anchored.anchorReceipt = {
      ...indeterminate.state.anchored.anchorReceipt,
      observationDisposition: "indeterminate",
      preservedReceiptHash: "a".repeat(64),
    };
    await expect(
      finalizeCompletedBuyerBundleCore(
        indeterminate.finalizeInput,
        indeterminate.provider,
      ),
    ).rejects.toThrow("established finalized publication");

    const unresolvedProof = fixture();
    unresolvedProof.state.anchored = anchoredBuyer(unresolvedProof.buyerBundle);
    unresolvedProof.provider.verifyBundleAnchorReceipt = vi.fn(
      () => "indeterminate" as const,
    );
    await expect(
      finalizeCompletedBuyerBundleCore(
        unresolvedProof.finalizeInput,
        unresolvedProof.provider,
      ),
    ).rejects.toBeInstanceOf(SubstrateError);
  });

  test("fails closed on an existing different buyer bundle and never overwrites it", async () => {
    const f = fixture();
    const different = bundleCopies(bundleScope({ finalisedAt: NOW + 1 })).buyerBundle;
    f.state.anchored = anchoredBuyer(different);

    await expect(
      finalizeCompletedBuyerBundleCore(f.finalizeInput, f.provider),
    ).rejects.toThrow("established finalized publication");
    expect(f.submitBuyerBundle).not.toHaveBeenCalled();
  });

  test("surfaces an ambiguous submission and does not perform a blind retry", async () => {
    const f = fixture();
    f.provider.submitBuyerBundle = vi.fn(() => {
      throw new Error("timeout after broadcast");
    });

    const error = await finalizeCompletedBuyerBundleCore(
      f.finalizeInput,
      f.provider,
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(SubstrateError);
    expect((error as Error).message).toContain(
      "ambiguous; resolve before any retry",
    );
    expect(f.provider.submitBuyerBundle).toHaveBeenCalledOnce();
  });

  test("rejects an existing BundleBinding that maps different content", async () => {
    const f = fixture("write-input");
    f.state.anchored = anchoredBuyer(f.buyerBundle);
    f.state.binding = signBinding({
      bindingVersion: "1",
      jobId: JOB_ID,
      role: "buyer",
      logicalAddress: bundleAddress(JOB_ID, "buyer"),
      nativeAddress: "stor-different-native",
      bundleContentHash: attestationBundleHash(f.buyerBundle),
      anchorTx: "test:buyer-anchor-tx",
      signer: BUYER,
    });

    await expect(
      finalizeCompletedBuyerBundleCore(f.finalizeInput, f.provider),
    ).rejects.toThrow("maps different content");
    expect(f.publishBundleBinding).not.toHaveBeenCalled();
  });

  test("reconciles binding publication ambiguity only when the exact binding is readable", async () => {
    const f = fixture("write-input");
    f.state.anchored = anchoredBuyer(f.buyerBundle);
    f.provider.publishBundleBinding = vi.fn(() => {
      throw new Error("timeout after publication");
    });

    await expect(
      finalizeCompletedBuyerBundleCore(f.finalizeInput, f.provider),
    ).rejects.toThrow("publication outcome is ambiguous");

    const reconciled = fixture("write-input");
    reconciled.state.anchored = anchoredBuyer(reconciled.buyerBundle);
    reconciled.provider.publishBundleBinding = vi.fn((binding) => {
      reconciled.state.binding = structuredClone(binding);
      throw new DacsError("timeout after accepted publication");
    });
    await expect(
      finalizeCompletedBuyerBundleCore(
        reconciled.finalizeInput,
        reconciled.provider,
      ),
    ).resolves.toMatchObject({
      binding: { role: "buyer", signer: BUYER },
    });
  });

  test("publishes a verified buyer binding and returns a frozen identical result on repeat", async () => {
    const f = fixture("write-input");
    const first = await finalizeCompletedBuyerBundleCore(f.finalizeInput, f.provider);
    const second = await finalizeCompletedBuyerBundleCore(f.finalizeInput, f.provider);

    expect(first).toEqual(second);
    expect(first.binding).toMatchObject({
      role: "buyer",
      signer: BUYER,
      logicalAddress: bundleAddress(JOB_ID, "buyer"),
      nativeAddress: `stor-${"8".repeat(40)}`,
      bundleContentHash: attestationBundleHash(f.buyerBundle),
    });
    expect(first.binding?.signature.algorithm).toBe("ed25519");
    expect(Buffer.from(first.binding!.signature.value, "base64url")).toHaveLength(64);
    expect(f.submitBuyerBundle).toHaveBeenCalledOnce();
    expect(f.publishBundleBinding).toHaveBeenCalledOnce();
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.buyerBundle.parties)).toBe(true);
    expect(Object.isFrozen(first.buyerBundle.parties[0])).toBe(true);
    expect(() => {
      (first.buyerBundle.parties[0] as { primaryClaim: string }).primaryClaim =
        "did:demos:mutated";
    }).toThrow(TypeError);
    expect(first.buyerBundle.parties[0]!.primaryClaim).toBe(BUYER);
  });

  test("rejects a finalization provider proxy before seller verification", async () => {
    const f = fixture();
    const trap = vi.fn(() => {
      throw new Error("provider proxy trap must not run");
    });
    const liveProvider = new Proxy(f.provider, {
      get: trap,
      ownKeys: trap,
      getOwnPropertyDescriptor: trap,
    });

    await expect(
      finalizeCompletedBuyerBundleCore(f.finalizeInput, liveProvider),
    ).rejects.toThrow("cannot be a proxy");
    expect(trap).not.toHaveBeenCalled();
    expect(sellerMocks.verifyFinalization).not.toHaveBeenCalled();
    expect(f.submitBuyerBundle).not.toHaveBeenCalled();
  });
});

describe("actual seller-to-buyer verification boundary", () => {
  test("passes the retained provider to real seller verifiers and rejects substituted transport data", async () => {
    vi.doUnmock("../../src/seller/bundleFinalization.js");
    vi.resetModules();
    const actualBuyer = await import(
      "../../src/agent/buyerBundleFinalization.js"
    );

    const counter = fixture();
    const substitutedRequest = {
      ...counter.request,
      bundleContentHash: "f".repeat(64),
    };
    const counterError = await actualBuyer
      .createCompletedBuyerBundleCounterSignature(
        counter.counterInput,
        substitutedRequest,
        counter.provider,
      )
      .catch((error: unknown) => error);
    expect(counterError).toMatchObject({ name: "DacsError", category: "permanent" });
    expect((counterError as Error).message).toContain(
      "counter-signature verification input must contain canonical data only",
    );
    expect(counter.buyerSigner).not.toHaveBeenCalled();

    const finalization = fixture();
    const substitutedFinalization = structuredClone(finalization.sellerFinalization);
    substitutedFinalization.buyerBundle.parties[0] = {
      ...substitutedFinalization.buyerBundle.parties[0]!,
      primaryClaim: "did:demos:substituted-buyer",
    };
    const finalizationError = await actualBuyer
      .finalizeCompletedBuyerBundleCore(
        {
          ...finalization.finalizeInput,
          sellerFinalization: substitutedFinalization,
        },
        finalization.provider,
      )
      .catch((error: unknown) => error);
    expect(finalizationError).toBeInstanceOf(Error);
    expect(finalization.submitBuyerBundle).not.toHaveBeenCalled();
  });
});
