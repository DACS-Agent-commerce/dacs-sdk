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
import { DacsError, SubstrateError } from "../../src/errors.js";
import {
  createCompletedCounterpartyBundleCounterSignature,
  finalizeCompletedCounterpartyBundleCore,
  type AnchoredCounterpartyBundle,
  type CounterpartyBundleFinalizationProvider,
  type CounterpartySigningSessionParty,
  type FinalizeCompletedCounterpartyBundleInput,
} from "../../src/agent/counterpartyBundleFinalization.js";
import {
  attestationBundleHash,
  bundleSignedScope,
} from "../../src/agent/twoSidedBundle.js";
import type {
  CompletedSellerBundleCounterSignatureRequest,
  FinalizedSellerBundle,
  VerifyFinalizedSellerBundleInput,
} from "../../src/seller/bundleFinalization.js";

const NOW = 1_786_100_000_000;
const JOB_ID = "counterparty-finalization-81";
const BUYER = "did:demos:buyer";
const SELLER = "did:demos:seller";
const ORCHESTRATOR = "did:demos:orchestrator";
const BUYER_HASH = "1".repeat(64);
const SELLER_HASH = "2".repeat(64);
const ORCHESTRATOR_HASH = "3".repeat(64);
const BUYER_SEED = new Uint8Array(32).fill(81);
const SELLER_SEED = new Uint8Array(32).fill(82);
const ORCHESTRATOR_SEED = new Uint8Array(32).fill(83);

function signScope(
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

function scope(): Record<string, unknown> {
  return {
    faultBundleVersion: "1",
    faultedParty: "none",
    jobId: JOB_ID,
    outcome: "completed",
    listingRef: {
      listingId: "counterparty-finalization-listing",
      version: 1,
      contentHash: "4".repeat(64),
    },
    agreementRef: {
      anchor: { kind: "storage-program", locator: "dacs3:agreement:81" },
      contentHash: "5".repeat(64),
    },
    parties: [
      { role: "buyer", primaryClaim: BUYER, bundleHash: BUYER_HASH },
      { role: "seller", primaryClaim: SELLER, bundleHash: SELLER_HASH },
      {
        role: "orchestrator",
        primaryClaim: ORCHESTRATOR,
        bundleHash: ORCHESTRATOR_HASH,
      },
    ],
    phaseSummary: [],
    vetRecords: [],
    settlementEvidence: [],
    recipeRegistryVersion: 7,
    railRegistryVersion: 9,
    finalisedAt: NOW,
  };
}

function copies() {
  const signedScope = scope();
  const buyerSignature = signScope(signedScope, BUYER, BUYER_SEED);
  const sellerSignature = signScope(signedScope, SELLER, SELLER_SEED);
  const orchestratorSignature = signScope(
    signedScope,
    ORCHESTRATOR,
    ORCHESTRATOR_SEED,
  );
  const common = {
    ...structuredClone(signedScope),
    signatures: [buyerSignature, sellerSignature, orchestratorSignature],
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
    orchestratorBundle: {
      ...common,
      anchoredByRole: "orchestrator",
    } as FaultAttestationBundle,
    buyerSignature,
    orchestratorSignature,
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
    requiredCounterSigners: [BUYER, ORCHESTRATOR],
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

function anchored(
  bundle: FaultAttestationBundle,
  logicalAddress = bundleAddress(bundle.jobId, "orchestrator"),
): AnchoredCounterpartyBundle {
  const hash = attestationBundleHash(bundle);
  const nativeAddress = `stor-${"7".repeat(40)}`;
  return {
    bundle: structuredClone(bundle),
    nativeAddress,
    anchorTx: "test:orchestrator-anchor-tx",
    anchorReceipt: receipt(logicalAddress, nativeAddress, hash),
  };
}

interface FixtureState {
  anchored?: AnchoredCounterpartyBundle;
  binding?: BundleBinding;
}

function addNestedAccessor(target: object): ReturnType<typeof vi.fn> {
  const getter = vi.fn(() => {
    throw new Error("nested accessor must not run");
  });
  Object.defineProperty(target, "liveValue", {
    enumerable: true,
    configurable: true,
    get: getter,
  });
  return getter;
}

function nestedProxy<T extends object>(target: T): {
  value: T;
  trap: ReturnType<typeof vi.fn>;
} {
  const trap = vi.fn(() => {
    throw new Error("nested proxy trap must not run");
  });
  return {
    value: new Proxy(target, {
      get: trap,
      ownKeys: trap,
      getOwnPropertyDescriptor: trap,
      getPrototypeOf: trap,
    }),
    trap,
  };
}

function fixture(mapping: "pure" | "write-input" = "pure") {
  const bundleCopies = copies();
  const request = requestFor(bundleCopies.sellerBundle);
  const signer = vi.fn((bytes: Uint8Array) =>
    ed25519Sign(bytes, privateKeyFromSeed(ORCHESTRATOR_SEED)),
  );
  const localParty: CounterpartySigningSessionParty = {
    role: "orchestrator",
    primaryClaim: ORCHESTRATOR,
    bundleHash: ORCHESTRATOR_HASH,
    signer,
  };
  const sellerVerificationInput = {
    counterSignatures: [
      structuredClone(bundleCopies.buyerSignature),
      structuredClone(bundleCopies.orchestratorSignature),
    ],
  } as unknown as VerifyFinalizedSellerBundleInput;
  const sellerHash = attestationBundleHash(bundleCopies.sellerBundle);
  const sellerLogicalAddress = bundleAddress(JOB_ID, "seller");
  const sellerNativeAddress = `stor-${"9".repeat(40)}`;
  const sellerFinalization: FinalizedSellerBundle = {
    state: "finalised",
    logicalAddress: sellerLogicalAddress,
    nativeAddress: sellerNativeAddress,
    bundleContentHash: sellerHash,
    sellerBundle: bundleCopies.sellerBundle,
    buyerBundle: bundleCopies.buyerBundle,
    orchestratorBundle: bundleCopies.orchestratorBundle,
    anchorReceipt: receipt(sellerLogicalAddress, sellerNativeAddress, sellerHash),
    anchorTx: "test:seller-anchor-tx",
    resumedBundle: false,
    resumedBinding: false,
  };
  const state: FixtureState = {};
  const submitCounterpartyBundle = vi.fn(
    (
      logicalAddress: string,
      bundle: Readonly<FaultAttestationBundle>,
      role: "buyer" | "orchestrator",
    ) => {
      expect(role).toBe("orchestrator");
      state.anchored = anchored(
        structuredClone(bundle) as FaultAttestationBundle,
        logicalAddress,
      );
    },
  );
  const resolveCounterpartyBundle = vi.fn(() =>
    state.anchored
      ? { disposition: "present" as const, anchored: structuredClone(state.anchored) }
      : { disposition: "absent" as const },
  );
  const publishBundleBinding = vi.fn((binding: Readonly<BundleBinding>) => {
    state.binding = structuredClone(binding);
    return { disposition: "published" as const };
  });
  const keys = new Map([
    [BUYER, rawPublicKey(publicKeyFromSeed(BUYER_SEED))],
    [SELLER, rawPublicKey(publicKeyFromSeed(SELLER_SEED))],
    [ORCHESTRATOR, rawPublicKey(publicKeyFromSeed(ORCHESTRATOR_SEED))],
  ]);
  const provider = {
    mapping,
    bundleCopyVerifier: {
      resolvePublicKey: vi.fn(async (claim: string) => keys.get(claim) ?? null),
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
        reason: "unused orchestrator fixture seam",
      })),
    },
    resolveDependency: vi.fn(() => ({ disposition: "absent" as const })),
    verifyDependencyReceipt: vi.fn(() => "indeterminate" as const),
    verifyDependencyBinding: vi.fn(() => "indeterminate" as const),
    verifyListingPublisherIdentityLinkage: vi.fn(() => "indeterminate" as const),
    verifyVetRequirementProvenance: vi.fn(() => "indeterminate" as const),
    resolveSellerBundle: vi.fn(() => ({ disposition: "absent" as const })),
    resolveCounterpartyBundle,
    submitCounterpartyBundle,
    verifyBundleAnchorReceipt: vi.fn(() => "valid" as const),
    resolveBundleBinding: vi.fn(() =>
      state.binding
        ? { disposition: "present" as const, binding: structuredClone(state.binding) }
        : { disposition: "absent" as const },
    ),
    publishBundleBinding,
    verifyBundleBinding: vi.fn(() => "valid" as const),
  } as unknown as CounterpartyBundleFinalizationProvider;
  const finalizeInput: FinalizeCompletedCounterpartyBundleInput = {
    sellerVerificationInput,
    sellerFinalization,
    counterSignature: bundleCopies.orchestratorSignature,
    localParty,
  };
  return {
    ...bundleCopies,
    request,
    signer,
    localParty,
    sellerVerificationInput,
    sellerFinalization,
    state,
    provider,
    finalizeInput,
    submitCounterpartyBundle,
    resolveCounterpartyBundle,
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

describe("DACS-5 role-owned counter-signing", () => {
  test("authenticates and signs as a distinct orchestrator without a remote signer", async () => {
    const f = fixture();
    const signature = await createCompletedCounterpartyBundleCounterSignature(
      {
        sellerVerificationInput: {} as never,
        localParty: f.localParty,
      },
      f.request,
      f.provider,
    );

    expect(signature).toEqual(f.orchestratorSignature);
    expect(sellerMocks.verifyRequest).toHaveBeenCalledOnce();
    expect(f.signer).toHaveBeenCalledOnce();
    expect(Array.from(f.signer.mock.calls[0]![0])).toEqual(
      Array.from(f.request.signedBytes),
    );
  });

  test("rejects a request missing the local orchestrator role before signing", async () => {
    const f = fixture();
    const missing = structuredClone(f.request);
    missing.signedScope.parties = (
      missing.signedScope.parties as Array<Record<string, unknown>>
    ).filter((party) => party.role !== "orchestrator");
    sellerMocks.verifyRequest.mockResolvedValueOnce(missing);

    await expect(
      createCompletedCounterpartyBundleCounterSignature(
        { sellerVerificationInput: {} as never, localParty: f.localParty },
        f.request,
        f.provider,
      ),
    ).rejects.toThrow("local orchestrator IdentityBundle");
    expect(f.signer).not.toHaveBeenCalled();
  });

  test("rejects nested accessors and proxies in supplied request data without invoking them", async () => {
    const accessor = fixture();
    const listing = accessor.request.signedScope.listingRef as object;
    const getter = addNestedAccessor(listing);
    await expect(
      createCompletedCounterpartyBundleCounterSignature(
        { sellerVerificationInput: {} as never, localParty: accessor.localParty },
        accessor.request,
        accessor.provider,
      ),
    ).rejects.toThrow("cannot contain accessors");
    expect(getter).not.toHaveBeenCalled();
    expect(sellerMocks.verifyRequest).not.toHaveBeenCalled();
    expect(accessor.signer).not.toHaveBeenCalled();

    const proxied = fixture();
    const party = nestedProxy(
      (proxied.request.signedScope.parties as Array<Record<string, unknown>>)[2]!,
    );
    (proxied.request.signedScope.parties as Array<Record<string, unknown>>)[2] =
      party.value;
    await expect(
      createCompletedCounterpartyBundleCounterSignature(
        { sellerVerificationInput: {} as never, localParty: proxied.localParty },
        proxied.request,
        proxied.provider,
      ),
    ).rejects.toThrow("cannot contain proxies");
    expect(party.trap).not.toHaveBeenCalled();
    expect(sellerMocks.verifyRequest).not.toHaveBeenCalled();
    expect(proxied.signer).not.toHaveBeenCalled();
  });

  test("rejects nested live data returned by the seller request verifier before signing", async () => {
    const accessor = fixture();
    const accessorResult = structuredClone(accessor.request);
    const getter = addNestedAccessor(accessorResult.signedScope.listingRef as object);
    sellerMocks.verifyRequest.mockResolvedValueOnce(accessorResult);
    await expect(
      createCompletedCounterpartyBundleCounterSignature(
        { sellerVerificationInput: {} as never, localParty: accessor.localParty },
        accessor.request,
        accessor.provider,
      ),
    ).rejects.toThrow("cannot contain accessors");
    expect(getter).not.toHaveBeenCalled();
    expect(accessor.signer).not.toHaveBeenCalled();

    const proxied = fixture();
    const proxyResult = structuredClone(proxied.request);
    const party = nestedProxy(
      (proxyResult.signedScope.parties as Array<Record<string, unknown>>)[2]!,
    );
    (proxyResult.signedScope.parties as Array<Record<string, unknown>>)[2] =
      party.value;
    sellerMocks.verifyRequest.mockResolvedValueOnce(proxyResult);
    await expect(
      createCompletedCounterpartyBundleCounterSignature(
        { sellerVerificationInput: {} as never, localParty: proxied.localParty },
        proxied.request,
        proxied.provider,
      ),
    ).rejects.toThrow("cannot contain proxies");
    expect(party.trap).not.toHaveBeenCalled();
    expect(proxied.signer).not.toHaveBeenCalled();
  });

  test("rejects nested live seller-verification input before request authentication", async () => {
    const accessor = fixture();
    const verificationRecord: Record<string, unknown> = { retained: true };
    const getter = addNestedAccessor(verificationRecord);
    await expect(
      createCompletedCounterpartyBundleCounterSignature(
        {
          sellerVerificationInput: {
            verificationRecord,
          } as never,
          localParty: accessor.localParty,
        },
        accessor.request,
        accessor.provider,
      ),
    ).rejects.toThrow("cannot contain accessors");
    expect(getter).not.toHaveBeenCalled();
    expect(sellerMocks.verifyRequest).not.toHaveBeenCalled();
    expect(accessor.signer).not.toHaveBeenCalled();

    const proxied = fixture();
    const verificationProxy = nestedProxy({ retained: true });
    await expect(
      createCompletedCounterpartyBundleCounterSignature(
        {
          sellerVerificationInput: {
            verificationRecord: verificationProxy.value,
          } as never,
          localParty: proxied.localParty,
        },
        proxied.request,
        proxied.provider,
      ),
    ).rejects.toThrow("cannot contain proxies");
    expect(verificationProxy.trap).not.toHaveBeenCalled();
    expect(sellerMocks.verifyRequest).not.toHaveBeenCalled();
    expect(proxied.signer).not.toHaveBeenCalled();
  });

  test("rejects typed-array subclasses and partial backing-buffer views", async () => {
    class DerivedBytes extends Uint8Array {}

    const subclass = fixture();
    subclass.request.signedBytes = new DerivedBytes(subclass.request.signedBytes);
    await expect(
      createCompletedCounterpartyBundleCounterSignature(
        { sellerVerificationInput: {} as never, localParty: subclass.localParty },
        subclass.request,
        subclass.provider,
      ),
    ).rejects.toThrow("non-canonical byte array");
    expect(sellerMocks.verifyRequest).not.toHaveBeenCalled();
    expect(subclass.signer).not.toHaveBeenCalled();

    const partial = fixture();
    const backing = new ArrayBuffer(partial.request.signedBytes.byteLength + 2);
    const view = new Uint8Array(
      backing,
      1,
      partial.request.signedBytes.byteLength,
    );
    view.set(partial.request.signedBytes);
    partial.request.signedBytes = view;
    await expect(
      createCompletedCounterpartyBundleCounterSignature(
        { sellerVerificationInput: {} as never, localParty: partial.localParty },
        partial.request,
        partial.provider,
      ),
    ).rejects.toThrow("non-canonical byte array");
    expect(sellerMocks.verifyRequest).not.toHaveBeenCalled();
    expect(partial.signer).not.toHaveBeenCalled();
  });

  test("rejects symbol-owned local signer fields before authentication", async () => {
    const f = fixture();
    const localParty = { ...f.localParty } as CounterpartySigningSessionParty & {
      [key: symbol]: unknown;
    };
    Object.defineProperty(localParty, Symbol("live-capability"), {
      value: f.signer,
      enumerable: true,
      configurable: true,
    });

    await expect(
      createCompletedCounterpartyBundleCounterSignature(
        { sellerVerificationInput: {} as never, localParty },
        f.request,
        f.provider,
      ),
    ).rejects.toThrow("non-canonical or live shape");
    expect(sellerMocks.verifyRequest).not.toHaveBeenCalled();
    expect(f.signer).not.toHaveBeenCalled();
  });
});

describe("DACS-5 orchestrator role-owned publication", () => {
  test("publishes only the exact orchestrator copy at its deterministic address", async () => {
    const f = fixture();
    const result = await finalizeCompletedCounterpartyBundleCore(
      f.finalizeInput,
      f.provider,
    );

    expect(result).toMatchObject({
      state: "finalised",
      role: "orchestrator",
      logicalAddress: bundleAddress(JOB_ID, "orchestrator"),
      bundleContentHash: attestationBundleHash(f.orchestratorBundle),
      bundle: { anchoredByRole: "orchestrator", jobId: JOB_ID },
    });
    expect(f.submitCounterpartyBundle).toHaveBeenCalledOnce();
    expect(f.submitCounterpartyBundle).toHaveBeenCalledWith(
      bundleAddress(JOB_ID, "orchestrator"),
      expect.objectContaining({ anchoredByRole: "orchestrator" }),
      "orchestrator",
    );
    expect(result.logicalAddress).not.toBe(bundleAddress(JOB_ID, "buyer"));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.bundle.parties)).toBe(true);
  });

  test("rejects a missing role copy and signature substitution before effects", async () => {
    const missing = fixture();
    const withoutRole = structuredClone(missing.sellerFinalization);
    delete withoutRole.orchestratorBundle;
    sellerMocks.verifyFinalization.mockResolvedValueOnce(withoutRole);
    await expect(
      finalizeCompletedCounterpartyBundleCore(missing.finalizeInput, missing.provider),
    ).rejects.toThrow("lacks the authenticated orchestrator role copy");
    expect(missing.submitCounterpartyBundle).not.toHaveBeenCalled();

    const substituted = fixture();
    substituted.finalizeInput.counterSignature = {
      ...substituted.orchestratorSignature,
      value: Buffer.from(new Uint8Array(64).fill(9)).toString("base64url"),
    };
    await expect(
      finalizeCompletedCounterpartyBundleCore(
        substituted.finalizeInput,
        substituted.provider,
      ),
    ).rejects.toThrow("substituted the reviewed detached signature");
    expect(substituted.submitCounterpartyBundle).not.toHaveBeenCalled();
  });

  test("rejects wrong-address and wrong-role readbacks without overwriting", async () => {
    const wrongAddress = fixture();
    wrongAddress.state.anchored = anchored(
      wrongAddress.orchestratorBundle,
      bundleAddress(JOB_ID, "buyer"),
    );
    await expect(
      finalizeCompletedCounterpartyBundleCore(
        wrongAddress.finalizeInput,
        wrongAddress.provider,
      ),
    ).rejects.toThrow("exact established finalized publication");
    expect(wrongAddress.submitCounterpartyBundle).not.toHaveBeenCalled();

    const wrongRole = fixture();
    const rebound = structuredClone(wrongRole.orchestratorBundle);
    rebound.anchoredByRole = "buyer";
    wrongRole.state.anchored = anchored(rebound);
    await expect(
      finalizeCompletedCounterpartyBundleCore(
        wrongRole.finalizeInput,
        wrongRole.provider,
      ),
    ).rejects.toThrow("exact established finalized publication");
    expect(wrongRole.submitCounterpartyBundle).not.toHaveBeenCalled();
  });

  test("surfaces ambiguous publication and never performs a blind retry", async () => {
    const f = fixture();
    f.provider.submitCounterpartyBundle = vi.fn(() => {
      throw new Error("timeout after broadcast");
    });

    const error = await finalizeCompletedCounterpartyBundleCore(
      f.finalizeInput,
      f.provider,
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(SubstrateError);
    expect((error as Error).message).toContain(
      "ambiguous; resolve before any retry",
    );
    expect(f.provider.submitCounterpartyBundle).toHaveBeenCalledOnce();
  });

  test("publishes and authenticates an orchestrator-owned BB-1 binding", async () => {
    const f = fixture("write-input");
    const result = await finalizeCompletedCounterpartyBundleCore(
      f.finalizeInput,
      f.provider,
    );

    expect(result.binding).toMatchObject({
      role: "orchestrator",
      signer: ORCHESTRATOR,
      logicalAddress: bundleAddress(JOB_ID, "orchestrator"),
      nativeAddress: `stor-${"7".repeat(40)}`,
      bundleContentHash: attestationBundleHash(f.orchestratorBundle),
    });
    expect(f.publishBundleBinding).toHaveBeenCalledOnce();
    expect(f.provider.verifyBundleBinding).toHaveBeenCalled();
  });

  test("performs no local effect when seller finalization authentication fails", async () => {
    const f = fixture("write-input");
    sellerMocks.verifyFinalization.mockRejectedValueOnce(
      new DacsError("seller finalization scope substitution"),
    );

    await expect(
      finalizeCompletedCounterpartyBundleCore(f.finalizeInput, f.provider),
    ).rejects.toThrow("seller finalization scope substitution");
    expect(f.resolveCounterpartyBundle).not.toHaveBeenCalled();
    expect(f.submitCounterpartyBundle).not.toHaveBeenCalled();
    expect(f.publishBundleBinding).not.toHaveBeenCalled();
  });

  test("rejects nested live data in supplied and verified seller finalizations before effects", async () => {
    const supplied = fixture();
    const suppliedGetter = addNestedAccessor(
      supplied.sellerFinalization.orchestratorBundle!.parties[2]!,
    );
    await expect(
      finalizeCompletedCounterpartyBundleCore(supplied.finalizeInput, supplied.provider),
    ).rejects.toThrow("cannot contain accessors");
    expect(suppliedGetter).not.toHaveBeenCalled();
    expect(sellerMocks.verifyFinalization).not.toHaveBeenCalled();
    expect(supplied.submitCounterpartyBundle).not.toHaveBeenCalled();

    const verified = fixture();
    const verifiedResult = structuredClone(verified.sellerFinalization);
    const party = nestedProxy(verifiedResult.orchestratorBundle!.parties[2]!);
    verifiedResult.orchestratorBundle!.parties[2] = party.value;
    sellerMocks.verifyFinalization.mockResolvedValueOnce(verifiedResult);
    await expect(
      finalizeCompletedCounterpartyBundleCore(verified.finalizeInput, verified.provider),
    ).rejects.toThrow("cannot contain proxies");
    expect(party.trap).not.toHaveBeenCalled();
    expect(verified.submitCounterpartyBundle).not.toHaveBeenCalled();
    expect(verified.publishBundleBinding).not.toHaveBeenCalled();
  });

  test("rejects nested live finalization-verification input before seller authentication", async () => {
    const accessor = fixture();
    const getter = addNestedAccessor(
      accessor.sellerVerificationInput.counterSignatures![1]!,
    );
    await expect(
      finalizeCompletedCounterpartyBundleCore(accessor.finalizeInput, accessor.provider),
    ).rejects.toThrow("cannot contain accessors");
    expect(getter).not.toHaveBeenCalled();
    expect(sellerMocks.verifyFinalization).not.toHaveBeenCalled();
    expect(accessor.submitCounterpartyBundle).not.toHaveBeenCalled();

    const proxied = fixture();
    const signature = nestedProxy(
      proxied.sellerVerificationInput.counterSignatures![1]!,
    );
    proxied.sellerVerificationInput.counterSignatures![1] = signature.value;
    await expect(
      finalizeCompletedCounterpartyBundleCore(proxied.finalizeInput, proxied.provider),
    ).rejects.toThrow("cannot contain proxies");
    expect(signature.trap).not.toHaveBeenCalled();
    expect(sellerMocks.verifyFinalization).not.toHaveBeenCalled();
    expect(proxied.submitCounterpartyBundle).not.toHaveBeenCalled();
  });

  test("rejects nested live role-lookup payloads without overwriting", async () => {
    const accessor = fixture();
    const accessorAnchored = anchored(accessor.orchestratorBundle);
    const getter = addNestedAccessor(
      (accessorAnchored.bundle as FaultAttestationBundle).parties[2]!,
    );
    accessor.provider.resolveCounterpartyBundle = vi.fn(() => ({
      disposition: "present" as const,
      anchored: accessorAnchored,
    }));
    await expect(
      finalizeCompletedCounterpartyBundleCore(accessor.finalizeInput, accessor.provider),
    ).rejects.toThrow("cannot contain accessors");
    expect(getter).not.toHaveBeenCalled();
    expect(accessor.provider.submitCounterpartyBundle).not.toHaveBeenCalled();

    const proxied = fixture();
    const proxyAnchored = anchored(proxied.orchestratorBundle);
    const proxyBundle = proxyAnchored.bundle as FaultAttestationBundle;
    const party = nestedProxy(proxyBundle.parties[2]!);
    proxyBundle.parties[2] = party.value;
    proxied.provider.resolveCounterpartyBundle = vi.fn(() => ({
      disposition: "present" as const,
      anchored: proxyAnchored,
    }));
    await expect(
      finalizeCompletedCounterpartyBundleCore(proxied.finalizeInput, proxied.provider),
    ).rejects.toThrow("cannot contain proxies");
    expect(party.trap).not.toHaveBeenCalled();
    expect(proxied.provider.submitCounterpartyBundle).not.toHaveBeenCalled();
  });

  test("rejects nested live binding lookup payloads before binding publication", async () => {
    const accessor = fixture("write-input");
    accessor.state.anchored = anchored(accessor.orchestratorBundle);
    const bindingRecord: Record<string, unknown> = { disposition: "present" };
    const getter = addNestedAccessor(bindingRecord);
    accessor.provider.resolveBundleBinding = vi.fn(() => bindingRecord as never);
    await expect(
      finalizeCompletedCounterpartyBundleCore(accessor.finalizeInput, accessor.provider),
    ).rejects.toThrow("cannot contain accessors");
    expect(getter).not.toHaveBeenCalled();
    expect(accessor.publishBundleBinding).not.toHaveBeenCalled();

    const proxied = fixture("write-input");
    proxied.state.anchored = anchored(proxied.orchestratorBundle);
    const binding = nestedProxy({ role: "orchestrator" });
    proxied.provider.resolveBundleBinding = vi.fn(() => ({
      disposition: "present" as const,
      binding: binding.value,
    }));
    await expect(
      finalizeCompletedCounterpartyBundleCore(proxied.finalizeInput, proxied.provider),
    ).rejects.toThrow("cannot contain proxies");
    expect(binding.trap).not.toHaveBeenCalled();
    expect(proxied.publishBundleBinding).not.toHaveBeenCalled();
  });

  test("rejects nested live binding publication results without blind retry", async () => {
    const accessor = fixture("write-input");
    const publication: Record<string, unknown> = { disposition: "published" };
    const getter = addNestedAccessor(publication);
    accessor.provider.publishBundleBinding = vi.fn(() => publication as never);
    await expect(
      finalizeCompletedCounterpartyBundleCore(accessor.finalizeInput, accessor.provider),
    ).rejects.toThrow("publication outcome is ambiguous");
    expect(getter).not.toHaveBeenCalled();
    expect(accessor.provider.publishBundleBinding).toHaveBeenCalledOnce();

    const proxied = fixture("write-input");
    const metadata = nestedProxy({ accepted: true });
    proxied.provider.publishBundleBinding = vi.fn(() => ({
      disposition: "published" as const,
      metadata: metadata.value,
    }) as never);
    await expect(
      finalizeCompletedCounterpartyBundleCore(proxied.finalizeInput, proxied.provider),
    ).rejects.toThrow("publication outcome is ambiguous");
    expect(metadata.trap).not.toHaveBeenCalled();
    expect(proxied.provider.publishBundleBinding).toHaveBeenCalledOnce();
  });

  test("rejects live provider descriptors before verification or publication", async () => {
    const f = fixture();
    Object.defineProperty(f.provider, "resolveCounterpartyBundle", {
      enumerable: true,
      configurable: true,
      get: () => f.resolveCounterpartyBundle,
    });

    await expect(
      finalizeCompletedCounterpartyBundleCore(f.finalizeInput, f.provider),
    ).rejects.toThrow("must be one owned data property");
    expect(sellerMocks.verifyFinalization).not.toHaveBeenCalled();
    expect(f.submitCounterpartyBundle).not.toHaveBeenCalled();
  });
});
