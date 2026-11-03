import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

const verifySellerClosure = vi.hoisted(() => vi.fn());

// This suite isolates coordinator composition. The real strict verifier is
// exercised with cryptographic Listing/agreement/composite/evidence fixtures,
// exact commitment coverage, and recursive DPA closure in
// test/seller/bundleFinalization.test.ts. Production imports that verifier
// directly; there is no injectable replacement in the public API.
vi.mock("../../src/seller/bundleFinalization.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/seller/bundleFinalization.js")>()),
  verifyFinalizedSellerBundleReadOnly: verifySellerClosure,
}));

// Explicitly non-live harness: these gates run against a released profile
// record; a case that sets `release.real` gets the real record at the pin.
const release = vi.hoisted(() => ({ real: false }));
vi.mock("../../src/discovery/standardProfileRelease.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/discovery/standardProfileRelease.js")>();
  return { get DACS_STANDARD_PROFILE_STATUS() { return release.real ? actual.DACS_STANDARD_PROFILE_STATUS : "released"; } };
});
afterEach(() => { release.real = false; });

import type {
  AnchorReceipt,
  AttestationRef,
  BundleBinding,
  FaultAttestationBundle,
} from "../../src/artifacts/types.js";
import {
  ARTIFACT_SEPARATORS,
  BUNDLE_BINDING_SEPARATOR,
} from "../../src/artifacts/registry.js";
import { attestationBundleHash } from "../../src/agent/twoSidedBundle.js";
import { bundlesDiverge } from "../../src/agent/bundleConsistency.js";
import { bundleAddress, contentHash } from "../../src/canonical/index.js";
import {
  COMPLETED_TWO_SIDED_SESSION_DEADLINE_MS,
  FIXED_PRICE_PAY_DEM_COMMERCE_PROFILE,
  FIXED_PRICE_PAY_DEM_REGISTRY_INDEX_REF,
  FIXED_PRICE_PAY_DEM_STANDARD_REVISION,
  combineFixedPricePayDemOrderStatus,
  combineFixedPriceX402OrderStatus,
  createFixedPricePayDemBuyerCoordinator,
  createFixedPricePayDemSellerCoordinator,
  createFixedPriceX402BuyerCoordinator,
  createFixedPriceX402SellerCoordinator,
  createInMemoryFixedPricePayDemCoordinatorStore,
  createInMemoryFixedPriceX402CoordinatorStore,
  FIXED_PRICE_X402_COMMERCE_PROFILE,
  FIXED_PRICE_X402_REGISTRY_INDEX_REF,
  FIXED_PRICE_X402_STANDARD_REVISION,
  verifyCompletedTwoSidedSession,
  verifyFixedPricePayDemAuditCompletion,
  verifyFixedPriceX402AuditCompletion,
  type FixedPricePayDemOrderInput,
  type FixedPricePayDemProtocolBinding,
  type FixedPricePayDemTrackOperation,
  type FixedPriceX402AuditCompletionDeps,
  type FixedPricePayDemAuditCompletionDeps,
  COMPLETED_SESSION_MODULE_VERSIONS,
  DACS_STANDARD_PROFILE_STATUS,
  type FixedPriceX402CoordinatorRole,
  type FixedPriceX402OrderInput,
  type FixedPriceX402ProtocolBinding,
  type FixedPriceX402TrackOperation,
} from "../../src/commerce/index.js";
import {
  ed25519Sign,
  ed25519Verify,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  rawPublicKey,
  signedBytes,
} from "../../src/crypto/index.js";
import { DacsError, IndeterminateSubstrateError, SubstrateError } from "../../src/errors.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7E";

function party(seedByte: number) {
  const seed = Uint8Array.from(Buffer.alloc(32, seedByte));
  const privateKey = privateKeyFromSeed(seed);
  const publicKey = rawPublicKey(publicKeyFromSeed(seed));
  return {
    did: `did:demos:agent:${Buffer.from(publicKey).toString("hex")}`,
    privateKey,
    publicKey,
  };
}

const BUYER = party(71);
const SELLER = party(72);
const h = (character: string): string => character.repeat(64);
function trustedAdmission() {
  return { status: "valid", releasePin: FIXED_PRICE_X402_STANDARD_REVISION, profileStatus: DACS_STANDARD_PROFILE_STATUS,
    moduleVersions: { ...COMPLETED_SESSION_MODULE_VERSIONS },
    roles: [
      { jobId: JOB_ID, role: "buyer", participant: BUYER.did },
      { jobId: JOB_ID, role: "seller", participant: SELLER.did },
    ] };
}

const PROTOCOL: FixedPriceX402ProtocolBinding = {
  commerceProfile: FIXED_PRICE_X402_COMMERCE_PROFILE,
  standardRevision: FIXED_PRICE_X402_STANDARD_REVISION,
  phase: "pay-x402",
  orchestratorTopology: "seller-as-phase-orchestrator-v1",
  orchestrator: SELLER.did,
  rail: {
    registryIndexRef: FIXED_PRICE_X402_REGISTRY_INDEX_REF,
    registryIndexHash: h("1"),
    railDefinitionRef: "dacs4:rail:x402%3Adefault:2",
    railDefinitionHash: h("2"),
    railId: "x402:default",
    railVersion: 2,
    railType: "x402",
    phaseHandler: "pay-x402",
    network: "eip155:8453",
    availability: "live",
  },
};

const PAY_DEM_PROTOCOL: FixedPricePayDemProtocolBinding = {
  commerceProfile: FIXED_PRICE_PAY_DEM_COMMERCE_PROFILE,
  standardRevision: FIXED_PRICE_PAY_DEM_STANDARD_REVISION,
  phase: "pay-dem",
  orchestratorTopology: "seller-as-phase-orchestrator-v1",
  orchestrator: SELLER.did,
  rail: {
    registryIndexRef: FIXED_PRICE_PAY_DEM_REGISTRY_INDEX_REF,
    registryIndexHash: h("3"),
    railDefinitionRef: "dacs4:rail:demos-native%3ADEM:1",
    railDefinitionHash: h("4"),
    railId: "demos-native:DEM",
    railVersion: 1,
    railType: "demos-native",
    phaseHandler: "pay-dem",
    network: "demos",
    availability: "live",
  },
};

function order(role: FixedPriceX402CoordinatorRole): FixedPriceX402OrderInput {
  return {
    jobId: JOB_ID,
    buyer: BUYER.did,
    seller: SELLER.did,
    protocol: PROTOCOL,
    sdkJobs: role === "buyer"
      ? {
          role,
          agreement: "buyer:agreement",
          payment: "buyer:payment",
          paymentEvidence: "buyer:payment-evidence",
          buyerReceived: "buyer:received",
          audit: "buyer:audit",
        }
      : {
          role,
          agreement: "seller:agreement",
          payment: "seller:payment",
          paymentEvidence: "seller:payment-evidence",
          fulfilment: "seller:fulfilment",
          deliveryEvidence: "seller:delivery-evidence",
          audit: "seller:audit",
        },
  };
}

function payDemOrder(role: FixedPriceX402CoordinatorRole): FixedPricePayDemOrderInput {
  return {
    ...order(role),
    protocol: PAY_DEM_PROTOCOL,
  };
}

function artifacts() {
  const listing = {
    dacsVersion: "1",
    listingVersion: 1,
    listingId: "svc",
    seller: {
      identity: {
        bundleVersion: "1",
        presentedBy: SELLER.did,
        presentedAt: 1780000000000,
        claims: [{ ref: SELLER.did }],
        presentation: {
          kind: "per-claim",
          signatures: [{ ref: SELLER.did, signature: "identity-proof" }],
        },
      },
      displayName: "Seller",
      publicEndpoint: "https://seller.example/dacs",
    },
    offering: {
      title: "Payload",
      description: "A signed payload",
      category: "data",
      tags: ["payload"],
      deliverable: {
        kind: "attested-payload",
        payloadFormat: "application/json",
        verificationMethod: { kind: "self-signed" },
      },
    },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [
      { kind: "negotiate-fixed-price" },
      { kind: "commit-agreement" },
      { kind: "pay-x402", parameters: { rail: "x402:default" } },
      { kind: "deliver-attested-payload" },
    ],
    pricing: { kind: "fixed", price: { amount: "1", currency: "USDC" } },
    acceptedRails: [{ railId: "x402:default" }],
    terms: { deadlineSecAfterCommit: 600 },
    validity: { notBefore: 1779999999000 },
    signature: {
      algorithm: "ed25519",
      signer: SELLER.did,
      value: Buffer.alloc(64, 3).toString("base64url"),
    },
  };
  const agreement = {
    agreementVersion: "1",
    jobId: JOB_ID,
    listingRef: {
      listingId: listing.listingId,
      version: 1,
      contentHash: contentHash(listing),
    },
    parties: [
      {
        role: "buyer",
        bundleHash: h("c"),
        primaryClaim: BUYER.did,
        vetRecordRef: {
          anchor: { kind: "storage-program", locator: "buyer-vet" },
          contentHash: h("4"),
        },
      },
      {
        role: "seller",
        bundleHash: h("d"),
        primaryClaim: SELLER.did,
        vetRecordRef: {
          anchor: { kind: "storage-program", locator: "seller-vet" },
          contentHash: h("5"),
        },
      },
    ],
    terms: {
      deliverable: { deliverableType: "attested-payload", hash: h("6") },
      price: { amount: "1", currency: "USDC" },
      rail: { railId: "x402:default" },
      deadline: 1780000600000,
    },
    derivedFromPattern: "fixed-price",
    generatedAt: 1780000000000,
    signatures: [
      { party: BUYER.did, algorithm: "ed25519", value: Buffer.alloc(64, 5).toString("base64url") },
      { party: SELLER.did, algorithm: "ed25519", value: Buffer.alloc(64, 6).toString("base64url") },
    ],
  };
  const evidence = {
    evidenceVersion: "1",
    jobId: JOB_ID,
    phase: "pay-x402",
    outcome: "success",
    paymentTxRefs: [{
      kind: "x402",
      httpResource: "https://seller.example/pay",
      paymentReceiptHash: h("e"),
      settlementTxHash: "0xabc",
      chainId: 84532,
      protocolVersion: "1",
    }],
    paymentAmount: { amount: "1", currency: "USDC" },
    settlementFinality: {
      model: "provider-receipt",
      finalityObservedAt: 1780000000000,
    },
    observedAt: 1780000000000,
    signature: {
      algorithm: "ed25519",
      signer: SELLER.did,
      value: Buffer.alloc(64, 4).toString("base64url"),
    },
  };
  return { listing, agreement, evidence };
}

function signBundle(
  body: Omit<FaultAttestationBundle, "anchoredByRole" | "signatures">,
  role: FixedPriceX402CoordinatorRole,
): FaultAttestationBundle {
  const message = signedBytes(
    ARTIFACT_SEPARATORS.FaultAttestationBundle,
    contentHash(body as unknown as Record<string, unknown>),
  );
  return {
    ...body,
    anchoredByRole: role,
    signatures: [BUYER, SELLER].map((signer) => ({
      party: signer.did,
      algorithm: "ed25519",
      value: Buffer.from(ed25519Sign(message, signer.privateKey)).toString("base64url"),
    })),
  };
}

function receipt(
  logicalAddress: string,
  nativeAddress: string,
  hash: string,
  writer: string,
  substrate = "test:final",
): AnchorReceipt {
  return {
    receiptVersion: "1",
    substrate,
    finalityProfile: substrate === "demos" ? "demos-bft" : "test-final",
    logicalAddress,
    nativeAddress,
    contentHash: hash,
    transactionRef: { kind: "demos", value: `tx:${hash}` },
    writer,
    state: "finalized",
    observationDisposition: "established",
    observedAt: 1780000000000,
    blockRef: { id: "block-10", height: "10", timestamp: 1780000000000 },
    evidence: { kind: "demos-bft-proof", value: "proof" },
  };
}

function binding(
  bundle: FaultAttestationBundle,
  role: FixedPriceX402CoordinatorRole,
  nativeAddress: string,
): BundleBinding {
  const signer = role === "buyer" ? BUYER : SELLER;
  const body = {
    bindingVersion: "1" as const,
    jobId: bundle.jobId,
    role,
    logicalAddress: bundleAddress(bundle.jobId, role),
    nativeAddress,
    bundleContentHash: attestationBundleHash(bundle),
    signer: signer.did,
  };
  return {
    ...body,
    signature: {
      algorithm: "ed25519",
      signer: signer.did,
      value: Buffer.from(ed25519Sign(
        signedBytes(
          BUNDLE_BINDING_SEPARATOR,
          contentHash(body as unknown as Record<string, unknown>),
        ),
        signer.privateKey,
      )).toString("base64url"),
    },
  };
}

async function fixture(phaseKind: "pay-x402" | "pay-dem" = "pay-x402") {
  const { listing, agreement, evidence } = artifacts();
  const agreementRef: AttestationRef = {
    anchor: { kind: "storage-program", locator: "agreement-j1" },
    contentHash: contentHash(agreement),
  };
  const evidenceRef: AttestationRef = {
    anchor: { kind: "storage-program", locator: "settlement-j1" },
    contentHash: contentHash(evidence),
  };
  const body: Omit<FaultAttestationBundle, "anchoredByRole" | "signatures"> = {
    faultBundleVersion: "1",
    faultedParty: "none",
    jobId: JOB_ID,
    outcome: "completed",
    listingRef: {
      listingId: listing.listingId,
      version: 1,
      contentHash: contentHash(listing),
    },
    agreementRef,
    parties: [
      { role: "buyer", bundleHash: h("c"), primaryClaim: BUYER.did },
      { role: "seller", bundleHash: h("d"), primaryClaim: SELLER.did },
    ],
    phaseSummary: [{
      index: 0,
      kind: phaseKind,
      outcome: "ok",
      attestationRef: evidenceRef,
    }],
    vetRecords: [],
    settlementEvidence: [evidenceRef],
    recipeRegistryVersion: 1,
    railRegistryVersion: 1,
    finalisedAt: 1780000000000,
  };
  const buyerBundle = signBundle(body, "buyer");
  const sellerBundle = signBundle(body, "seller");
  const buyerNative = "native:buyer-bundle";
  const sellerNative = "native:seller-bundle";
  const store = createInMemoryFixedPriceX402CoordinatorStore({ now: () => 1780000000000 });
  const operation = (
    role: FixedPriceX402CoordinatorRole,
    track: string,
  ): FixedPriceX402TrackOperation => async () => ({
    status: "final",
    outcome: "success",
    reference: track === "audit"
      ? (role === "buyer" ? buyerNative : sellerNative)
      : `${role}:${track}`,
  });
  const buyer = createFixedPriceX402BuyerCoordinator({
    store,
    workerId: "buyer-worker",
    operations: Object.fromEntries([
      "agreement",
      "payment",
      "payment-evidence",
      "buyer-received",
      "audit",
    ].map((track) => [track, operation("buyer", track)])),
  });
  const seller = createFixedPriceX402SellerCoordinator({
    store,
    workerId: "seller-worker",
    operations: Object.fromEntries([
      "agreement",
      "payment",
      "payment-evidence",
      "delivery",
      "delivery-evidence",
      "audit",
    ].map((track) => [track, operation("seller", track)])),
  });
  await buyer.startOrder(order("buyer"));
  await seller.startOrder(order("seller"));
  await buyer.runPending({ limit: 10 });
  await seller.runPending({ limit: 10 });
  const buyerStatus = (await buyer.getOrderStatus(JOB_ID))!;
  const sellerStatus = (await seller.getOrderStatus(JOB_ID))!;
  const publicKeys = new Map([
    [BUYER.did, BUYER.publicKey],
    [SELLER.did, SELLER.publicKey],
  ]);
  const bundles = new Map<string, Record<string, unknown>>([
    [buyerNative, buyerBundle as unknown as Record<string, unknown>],
    [sellerNative, sellerBundle as unknown as Record<string, unknown>],
  ]);
  const buyerReceipt = receipt(
    bundleAddress(JOB_ID, "buyer"),
    buyerNative,
    attestationBundleHash(buyerBundle),
    BUYER.did,
  );
  const sellerReceipt = receipt(
    bundleAddress(JOB_ID, "seller"),
    sellerNative,
    attestationBundleHash(sellerBundle),
    SELLER.did,
  );
  const sellerFinalizationProvider = {
    mapping: "pure" as const,
    bundleCopyVerifier: {
      resolvePublicKey: async (did: string) => publicKeys.get(did) ?? null,
      verify: (bytes: Uint8Array, signature: Uint8Array, key: Uint8Array) =>
        ed25519Verify(bytes, signature, publicKeyFromRaw(key)),
    },
  } as unknown as FixedPriceX402AuditCompletionDeps["sellerFinalizationProvider"];
  const deps: FixedPriceX402AuditCompletionDeps & FixedPricePayDemAuditCompletionDeps = {
    authenticateSessionProfile: () => trustedAdmission(),
    sellerFinalizationProvider,
    readBundleCopy: (nativeAddress) => bundles.get(nativeAddress) ?? null,
    verifyBundleAnchor: () => ({ disposition: "valid", mapping: "pure" }),
  };
  const closureResult = {
    state: "finalised" as const,
    logicalAddress: bundleAddress(JOB_ID, "seller"),
    nativeAddress: sellerNative,
    bundleContentHash: attestationBundleHash(sellerBundle),
    sellerBundle,
    buyerBundle,
    anchorReceipt: sellerReceipt,
    resumedBundle: false,
    resumedBinding: false,
  };
  verifySellerClosure.mockReset();
  verifySellerClosure.mockImplementation(async (_verificationInput, suppliedResult) =>
    structuredClone(suppliedResult));
  return {
    buyerStatus,
    sellerStatus,
    buyerNative,
    sellerNative,
    buyerBundle,
    sellerBundle,
    buyerReceipt,
    sellerReceipt,
    closureResult,
    sellerFinalizationProvider,
    deps,
    input: {
      buyer: buyerStatus,
      seller: sellerStatus,
      sellerClosure: {
        verificationInput: { durableSession: "authenticated-fixture" } as never,
        result: closureResult,
      },
      copies: {
        buyer: {
          role: "buyer" as const,
          nativeAddress: buyerNative,
          bundle: buyerBundle,
          anchorReceipt: buyerReceipt,
        },
        seller: {
          role: "seller" as const,
          nativeAddress: sellerNative,
          bundle: sellerBundle,
          anchorReceipt: sellerReceipt,
        },
      },
    },
  };
}

describe("fixed-price x402 DACS-5 ST-11 completion gate", () => {
  it("exposes a rail-neutral strict two-sided completion result", async () => {
    const fx = await fixture();
    await expect(verifyCompletedTwoSidedSession({
      jobId: JOB_ID,
      buyer: BUYER.did,
      seller: SELLER.did,
      sellerClosure: fx.input.sellerClosure,
      copies: fx.input.copies,
    }, fx.deps)).resolves.toEqual({
      state: "audit-complete",
      jobId: JOB_ID,
      buyer: {
        logicalAddress: bundleAddress(JOB_ID, "buyer"),
        nativeAddress: fx.buyerNative,
        bundleContentHash: attestationBundleHash(fx.buyerBundle),
      },
      seller: {
        logicalAddress: bundleAddress(JOB_ID, "seller"),
        nativeAddress: fx.sellerNative,
        bundleContentHash: attestationBundleHash(fx.sellerBundle),
      },
    });
  });

  it("requires independent admission on the direct rail-neutral completion gate", async () => {
    const fx = await fixture();
    const read = vi.fn(fx.deps.readBundleCopy);
    const { authenticateSessionProfile: _unused, ...missing } = fx.deps;
    await expect(verifyCompletedTwoSidedSession({
      jobId: JOB_ID, buyer: BUYER.did, seller: SELLER.did,
      sellerClosure: fx.input.sellerClosure, copies: fx.input.copies,
    }, { ...missing, readBundleCopy: read } as never)).rejects.toThrow(/authenticateSessionProfile.*required/);
    expect(read).not.toHaveBeenCalled();
    expect(verifySellerClosure).not.toHaveBeenCalled();
  });

  it("binds the rail-neutral result to independently supplied session parties", async () => {
    const fx = await fixture();
    await expect(verifyCompletedTwoSidedSession({
      jobId: JOB_ID,
      buyer: SELLER.did,
      seller: BUYER.did,
      sellerClosure: fx.input.sellerClosure,
      copies: fx.input.copies,
    }, fx.deps)).rejects.toThrow(/authenticated role authority/);
  });

  it("rejects a non-canonical job id before granting audit-complete authority", async () => {
    const fx = await fixture();
    await expect(verifyCompletedTwoSidedSession({
      jobId: "legacy-job",
      buyer: BUYER.did,
      seller: SELLER.did,
      sellerClosure: fx.input.sellerClosure,
      copies: fx.input.copies,
    }, fx.deps)).rejects.toThrow(/canonical uppercase ULID/);
    expect(verifySellerClosure).not.toHaveBeenCalled();
  });

  it("uses the pinned v0.3 perspective-pair rule instead of coarse track outcomes", () => {
    const vectors = JSON.parse(readFileSync(new URL(
      "../../vendor/DACS-Standard/conformance/vectors/security/fault-bundle-perspective-pair-v0.3.json",
      import.meta.url,
    ), "utf8")) as {
      vectors: Array<{
        copies: { buyer?: Record<string, unknown>; seller?: Record<string, unknown> };
        want: { convergence?: "unified" | "divergent" };
      }>;
    };
    const pairs = vectors.vectors.filter((entry) =>
      entry.copies.buyer && entry.copies.seller && entry.want.convergence
    );
    expect(pairs).toHaveLength(2);
    for (const entry of pairs) {
      expect(bundlesDiverge(entry.copies.buyer!, entry.copies.seller!))
        .toBe(entry.want.convergence === "divergent");
    }
  });

  it("is the only coordinator surface that projects normative audit-complete", async () => {
    const fx = await fixture();
    expect(combineFixedPriceX402OrderStatus({
      buyer: fx.buyerStatus,
      seller: fx.sellerStatus,
    }).milestone).toBe("actor-audit-final");
    await expect(verifyFixedPriceX402AuditCompletion(fx.input, fx.deps))
      .resolves.toMatchObject({ milestone: "audit-complete" });
    expect(verifySellerClosure).toHaveBeenCalledOnce();
    expect(verifySellerClosure.mock.calls[0]![0]).toEqual(
      fx.input.sellerClosure.verificationInput,
    );
  });

  it("projects the same strict audit-complete boundary for native DEM", async () => {
    const fx = await fixture("pay-dem");
    const operation = (
      role: FixedPriceX402CoordinatorRole,
      track: string,
    ): FixedPricePayDemTrackOperation => async () => ({
      status: "final",
      outcome: "success",
      reference: track === "audit"
        ? (role === "buyer" ? fx.buyerNative : fx.sellerNative)
        : `${role}:${track}`,
    });
    const store = createInMemoryFixedPricePayDemCoordinatorStore({
      now: () => 1780000000000,
    });
    const buyer = createFixedPricePayDemBuyerCoordinator({
      store,
      workerId: "buyer-dem-worker",
      operations: Object.fromEntries([
        "agreement",
        "payment",
        "payment-evidence",
        "buyer-received",
        "audit",
      ].map((track) => [track, operation("buyer", track)])),
    });
    const seller = createFixedPricePayDemSellerCoordinator({
      store,
      workerId: "seller-dem-worker",
      operations: Object.fromEntries([
        "agreement",
        "payment",
        "payment-evidence",
        "delivery",
        "delivery-evidence",
        "audit",
      ].map((track) => [track, operation("seller", track)])),
    });
    await buyer.startOrder(payDemOrder("buyer"));
    await seller.startOrder(payDemOrder("seller"));
    await buyer.runPending({ limit: 10 });
    await seller.runPending({ limit: 10 });
    const buyerStatus = (await buyer.getOrderStatus(JOB_ID))!;
    const sellerStatus = (await seller.getOrderStatus(JOB_ID))!;
    expect(combineFixedPricePayDemOrderStatus({ buyer: buyerStatus, seller: sellerStatus })
      .milestone).toBe("actor-audit-final");
    const admissionInput = { buyer: buyerStatus, seller: sellerStatus,
      sellerClosure: fx.input.sellerClosure, copies: fx.input.copies };
    const badAdmissions: unknown[] = [undefined, { status: "invalid" },
      { ...trustedAdmission(), releasePin: "00".repeat(20) },
      // The pin and tuple alone, or a stale candidate acknowledgement, never admit.
      (({ profileStatus: _status, ...pinOnly }) => pinOnly)(trustedAdmission()),
      { ...trustedAdmission(), profileStatus: "unreleased-candidate" },
      { ...trustedAdmission(), moduleVersions: { ...COMPLETED_SESSION_MODULE_VERSIONS, dacs5: "0.4" } },
      { ...trustedAdmission(), moduleVersions: { core: "0.3" } },
      { ...trustedAdmission(), roles: [...trustedAdmission().roles, trustedAdmission().roles[0]] },
      { ...trustedAdmission(), roles: trustedAdmission().roles.map((entry) => ({ ...entry, jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7F" })) },
      { ...trustedAdmission(), roles: trustedAdmission().roles.map((entry) => ({ ...entry, participant: entry.role === "buyer" ? SELLER.did : BUYER.did })) },
    ];
    for (const bad of badAdmissions) {
      verifySellerClosure.mockClear();
      const read = vi.fn(fx.deps.readBundleCopy);
      await expect(verifyFixedPricePayDemAuditCompletion(admissionInput, { ...fx.deps,
        readBundleCopy: read, authenticateSessionProfile: () => bad })).rejects.toThrow();
      expect(read).not.toHaveBeenCalled();
      expect(verifySellerClosure).not.toHaveBeenCalled();
    }
    const { authenticateSessionProfile: _unused, ...missing } = fx.deps;
    await expect(verifyFixedPricePayDemAuditCompletion(admissionInput, missing as never))
      .rejects.toThrow(/authenticateSessionProfile.*required/);
    await expect(verifyFixedPricePayDemAuditCompletion({
      buyer: buyerStatus,
      seller: sellerStatus,
      sellerClosure: fx.input.sellerClosure,
      copies: fx.input.copies,
    }, fx.deps)).resolves.toMatchObject({
      protocol: { phase: "pay-dem" },
      milestone: "audit-complete",
    });
  });

  it.each(["pay-x402", "pay-dem"] as const)(
    "accepts independently verified equal copies at alternate native addresses for %s", async (rail) => {
      const fx = await fixture(rail);
      const carriedBuyer = binding(fx.buyerBundle, "buyer", fx.buyerNative);
      const carriedSeller = binding(fx.sellerBundle, "seller", fx.sellerNative);
      const alternate = binding(fx.buyerBundle, "buyer", "native:alternate-buyer");
      const verifyBinding = vi.fn(() => ({ disposition: "valid" as const }));
      const input = { jobId: JOB_ID, buyer: BUYER.did, seller: SELLER.did,
        sellerClosure: { ...fx.input.sellerClosure, result: { ...fx.closureResult, binding: carriedSeller } },
        copies: { buyer: { ...fx.input.copies.buyer, binding: carriedBuyer },
          seller: { ...fx.input.copies.seller, binding: carriedSeller } } };
      const deps = { ...fx.deps,
        sellerFinalizationProvider: { ...fx.sellerFinalizationProvider, mapping: "write-input" as const },
        verifyBundleAnchor: () => ({ disposition: "valid" as const, mapping: "write-input" as const }),
        resolveBundleBinding: (_logical: string, _signer: string, role: string) => ({
          disposition: "present" as const, binding: role === "buyer" ? alternate : carriedSeller }),
        readBundleCopy: (address: string, role: "buyer" | "seller") => address === alternate.nativeAddress
          ? fx.buyerBundle as unknown as Record<string, unknown> : fx.deps.readBundleCopy(address, role),
        verifyBundleBinding: verifyBinding,
      };
      await expect(verifyCompletedTwoSidedSession(input, deps)).resolves.toMatchObject({ state: "audit-complete" });
      expect(verifyBinding).toHaveBeenCalledWith(alternate);
      const forged = structuredClone(alternate);
      forged.signature.value = Buffer.alloc(64, 3).toString("base64url");
      await expect(verifyCompletedTwoSidedSession(input, { ...deps,
        resolveBundleBinding: (_logical, _signer, role) => ({ disposition: "present",
          binding: role === "buyer" ? forged : carriedSeller }) })).rejects.toThrow(/signature is invalid/);
      await expect(verifyCompletedTwoSidedSession(input, { ...deps,
        readBundleCopy: (address, role) => address === alternate.nativeAddress
          ? { ...fx.buyerBundle, outcome: "failed-substrate" } as unknown as Record<string, unknown>
          : fx.deps.readBundleCopy(address, role) })).rejects.toThrow(/same verified signed scope/);
    });

  it("rejects opaque audit references, missing readback, and a forged receipt writer", async () => {
    const fx = await fixture();
    const opaque = structuredClone(fx.input);
    (opaque.buyer.tracks.audit as { reference: string }).reference = "opaque-callback-string";
    await expect(verifyFixedPriceX402AuditCompletion(opaque, fx.deps))
      .rejects.toThrow(/exact bundle/);

    // Nothing readable yet is retried; other content is an answer.
    await expect(verifyFixedPriceX402AuditCompletion(fx.input, {
      ...fx.deps,
      readBundleCopy: () => null,
    })).rejects.toThrow(IndeterminateSubstrateError);
    const other = structuredClone(fx.input.copies.buyer.bundle) as unknown as Record<string, unknown>;
    other.jobId = "another-job";
    const answered = await verifyFixedPriceX402AuditCompletion(fx.input, {
      ...fx.deps,
      readBundleCopy: () => other,
    }).catch((error: unknown) => error);
    expect(answered).toBeInstanceOf(DacsError);
    expect(answered).not.toBeInstanceOf(IndeterminateSubstrateError);
    expect(String(answered)).toMatch(/not independently readable/);

    const forged = structuredClone(fx.input);
    forged.copies.buyer.anchorReceipt.writer = "did:example:unauthorized-writer";
    await expect(verifyFixedPriceX402AuditCompletion(forged, fx.deps))
      .rejects.toThrow(/exact established finalized receipt/);
  });

  it("cannot promote a session rejected by the strict recursive ST-11 closure", async () => {
    const fx = await fixture();
    verifySellerClosure.mockRejectedValueOnce(new Error(
      "agreement-commitment is missing from the recursive ST-11 closure",
    ));
    await expect(verifyFixedPriceX402AuditCompletion(fx.input, fx.deps))
      .rejects.toThrow(/agreement-commitment.*recursive ST-11 closure/);
  });

  it("derives write-input mapping from authenticated adapters and requires BB-1", async () => {
    const fx = await fixture();
    const buyerBinding = binding(fx.buyerBundle, "buyer", fx.buyerNative);
    const sellerBinding = binding(fx.sellerBundle, "seller", fx.sellerNative);
    const writeInput = {
      ...fx.input,
      sellerClosure: {
        ...fx.input.sellerClosure,
        result: { ...fx.closureResult, binding: sellerBinding },
      },
      copies: {
        buyer: {
          ...fx.input.copies.buyer,
          binding: buyerBinding,
        },
        seller: {
          ...fx.input.copies.seller,
          binding: sellerBinding,
        },
      },
    };
    const writeDeps = {
      ...fx.deps,
      sellerFinalizationProvider: {
        ...fx.sellerFinalizationProvider,
        mapping: "write-input" as const,
      },
      verifyBundleAnchor: () => ({
        disposition: "valid" as const,
        mapping: "write-input" as const,
      }),
    };
    await expect(verifyFixedPriceX402AuditCompletion(writeInput, writeDeps))
      .rejects.toThrow(/requires a BundleBinding verifier/);
    await expect(verifyFixedPriceX402AuditCompletion(writeInput, {
      ...writeDeps,
      verifyBundleBinding: () => ({ disposition: "valid" }),
    })).rejects.toThrow(/requires a BundleBinding resolver/);
    await expect(verifyFixedPriceX402AuditCompletion(writeInput, {
      ...writeDeps,
      resolveBundleBinding: () => ({
        disposition: "present" as const,
        binding: { ...buyerBinding, nativeAddress: "native:substituted" },
      }),
      verifyBundleBinding: () => ({ disposition: "valid" }),
    })).rejects.toThrow(/not independently resolvable and exact/);
    await expect(verifyFixedPriceX402AuditCompletion(writeInput, {
      ...writeDeps,
      resolveBundleBinding: (_logicalAddress, _signer, role) => ({
        disposition: "present" as const,
        binding: role === "buyer" ? buyerBinding : sellerBinding,
      }),
      verifyBundleBinding: () => ({ disposition: "valid" }),
    })).resolves.toMatchObject({ milestone: "audit-complete" });
  });

  // Final r11 review: a host that retries only IndeterminateSubstrateError
  // treated an unanswered anchor, binding or readback as permanent.
  it("reports every unanswered read as IndeterminateSubstrateError and only answers as DacsError", async () => {
    const fx = await fixture();
    const buyerBinding = binding(fx.buyerBundle, "buyer", fx.buyerNative);
    const sellerBinding = binding(fx.sellerBundle, "seller", fx.sellerNative);
    const input = {
      ...fx.input,
      sellerClosure: { ...fx.input.sellerClosure, result: { ...fx.closureResult, binding: sellerBinding } },
      copies: {
        buyer: { ...fx.input.copies.buyer, binding: buyerBinding },
        seller: { ...fx.input.copies.seller, binding: sellerBinding },
      },
    };
    const deps: FixedPriceX402AuditCompletionDeps = {
      ...fx.deps,
      sellerFinalizationProvider: { ...fx.sellerFinalizationProvider, mapping: "write-input" as const },
      verifyBundleAnchor: () => ({ disposition: "valid" as const, mapping: "write-input" as const }),
      resolveBundleBinding: (_logicalAddress, _signer, role) => ({
        disposition: "present" as const,
        binding: role === "buyer" ? buyerBinding : sellerBinding,
      }),
      verifyBundleBinding: () => ({ disposition: "valid" }),
    };
    await expect(verifyFixedPriceX402AuditCompletion(input, deps))
      .resolves.toMatchObject({ milestone: "audit-complete" });
    // The buyer copy's anchor verifier answers `disposition`; the seller's is valid.
    const buyerAnchor = (disposition: string, reason: string) => (copy: { role: string }) =>
      (copy.role === "buyer" ? { disposition, reason } : { disposition: "valid", mapping: "write-input" }) as never;
    const outcome = (overrides: Partial<FixedPriceX402AuditCompletionDeps>) =>
      verifyFixedPriceX402AuditCompletion(input, { ...deps, ...overrides }).then(
        () => "audit-complete", (error: unknown) => error);
    const fetchFailed = () => { throw new TypeError("fetch failed"); };
    const unanswered: Array<[string, Partial<FixedPriceX402AuditCompletionDeps>]> = [
      ["a thrown readback", { readBundleCopy: fetchFailed }],
      ["an absent readback", { readBundleCopy: () => null }],
      ["an indeterminate anchor", { verifyBundleAnchor: buyerAnchor("indeterminate", "rpc") }],
      ["an errored anchor", { verifyBundleAnchor: buyerAnchor("error", "rpc") }],
      ["a thrown anchor verifier", { verifyBundleAnchor: fetchFailed }],
      ["an indeterminate binding verifier", { verifyBundleBinding: () => ({ disposition: "indeterminate", reason: "rpc" }) }],
      ["an errored binding verifier", { verifyBundleBinding: () => ({ disposition: "error", reason: "rpc" }) }],
      ["a thrown binding verifier", { verifyBundleBinding: fetchFailed }],
      // DemosAdapter's unanswered-read signal is a plain SubstrateError.
      ["a thrown SubstrateError readback", { readBundleCopy: () => {
        throw new SubstrateError("Demos anchor receipt observation unavailable"); } }],
    ];
    for (const [label, overrides] of unanswered) {
      expect(await outcome(overrides), label).toBeInstanceOf(IndeterminateSubstrateError);
    }
    // ST-11, BB-2, BB-8: each copy carries its signed binding, so a
    // discovery lookup that does not show it, or does not answer, never holds
    // a natively readable, receipt-authenticated pair back from completion.
    const undiscovered: Array<[string, Partial<FixedPriceX402AuditCompletionDeps>]> = [
      ["a binding the name index does not show yet", { resolveBundleBinding: () => ({ disposition: "absent" as const }) }],
      ["an undiscovered binding lookup", { resolveBundleBinding: () => ({
        disposition: "indeterminate" as const, reason: "bundle-binding-undiscovered" }) }],
      ["an unanswered binding lookup", { resolveBundleBinding: () => ({
        disposition: "indeterminate" as const, reason: "bundle-binding-unanswered" }) }],
      ["a thrown binding lookup", { resolveBundleBinding: fetchFailed }],
      ["a thrown SubstrateError binding lookup", { resolveBundleBinding: () => {
        throw new SubstrateError("Demos receipt native read failed"); } }],
    ];
    for (const [label, overrides] of undiscovered) {
      expect(await outcome(overrides), label).toBe("audit-complete");
    }
    // BB-6, BB-7: the resolver judges the carried binding together with the
    // candidates it discovered. A candidate set that does not resolve to one
    // copy (an equally signed second copy, say) keeps the side indeterminate.
    const carried: unknown[] = [];
    expect(await outcome({ resolveBundleBinding: (...args: unknown[]) => {
      carried.push(args[3]);
      return { disposition: "present" as const, binding: args[3] };
    } })).toBe("audit-complete");
    expect(carried).toHaveLength(2);
    expect(carried).toEqual(expect.arrayContaining([buyerBinding, sellerBinding]));
    // Fail-closed: a resolver that labels the same BB-6 result its own way
    // (or any reason other than non-observation) holds completion too.
    for (const reason of ["bundle-binding-equivocation", "bundle-binding-budget-exhausted",
      "bundle-binding-candidates-unfetched", "bundle-binding-candidates-rejected",
      "equivocation", "candidate-set-unresolved", "index unavailable", "unanswered"]) {
      const error = await outcome({ resolveBundleBinding: () => ({ disposition: "indeterminate" as const, reason }) });
      expect(error, reason).toBeInstanceOf(IndeterminateSubstrateError);
      expect(String(error), reason).toMatch(new RegExp(`candidate set is unresolved: ${reason}`));
    }
    // The verifier's answer against the carried binding still comes first.
    const forged = await outcome({
      resolveBundleBinding: () => ({ disposition: "indeterminate" as const, reason: "bundle-binding-equivocation" }),
      verifyBundleBinding: () => ({ disposition: "invalid", reason: "forged" }),
    });
    expect(forged).toBeInstanceOf(DacsError);
    expect(forged).not.toBeInstanceOf(IndeterminateSubstrateError);
    // A lookup answer about the session still is one.
    expect(String(await outcome({ resolveBundleBinding: () => {
      throw new DacsError("binding catalog answered for another session"); } })))
      .toMatch(/another session/);
    expect(String(await outcome({ resolveBundleBinding: () => ({ disposition: "unknown" }) as never })))
      .toMatch(/malformed result/);
    const answers: Array<[string, Partial<FixedPriceX402AuditCompletionDeps>, RegExp]> = [
      ["an invalid anchor", { verifyBundleAnchor: buyerAnchor("invalid", "forged") },
      /anchor verification is invalid/],
      ["a thrown answer", { readBundleCopy: () => { throw new DacsError("Demos returned another bundle"); } },
        /Demos returned another bundle/],
      ["another binding", { resolveBundleBinding: () => ({ disposition: "present" as const,
        binding: { ...buyerBinding, nativeAddress: "native:substituted" } }) }, /not independently resolvable/],
      ["an invalid binding", { verifyBundleBinding: () => ({ disposition: "invalid", reason: "forged" }) },
        /BundleBinding verification is invalid/],
    ];
    for (const [label, overrides, message] of answers) {
      const error = await outcome(overrides);
      expect(error, label).toBeInstanceOf(DacsError);
      expect(error, label).not.toBeInstanceOf(IndeterminateSubstrateError);
      expect(String(error), label).toMatch(message);
    }
    // At the deadline, an unanswered anchor on one copy is not an "answer
    // already observed" while the other copy's read is still pending.
    const error = await outcome({
      deadline: { timeoutMs: 1_000, start: (expire) => { const timer = setTimeout(expire, 20); return () => clearTimeout(timer); } },
      verifyBundleAnchor: buyerAnchor("indeterminate", "rpc"),
      readBundleCopy: (nativeAddress, role) => role === "seller"
        ? new Promise(() => undefined) : fx.deps.readBundleCopy(nativeAddress, role),
    });
    expect(error).toBeInstanceOf(IndeterminateSubstrateError);
  });

  // Each ST-11 step 4-5, §10.4.1, BB-4 and BB-5 rejection in the
  // gate is pinned by its own answer. Readback, binding lookup and the
  // closure follow whatever the input carries, so only the check named can
  // reject it.
  it("rejects each copy, receipt and binding that breaks ST-11, §10.4.1, BB-4 or BB-5", async () => {
    const fx = await fixture();
    const sellerBinding = binding(fx.sellerBundle, "seller", fx.sellerNative);
    const base = {
      ...fx.input,
      sellerClosure: {
        ...fx.input.sellerClosure,
        result: { ...fx.closureResult, binding: sellerBinding as BundleBinding | undefined },
      },
      copies: {
        buyer: { ...fx.input.copies.buyer, binding: binding(fx.buyerBundle, "buyer", fx.buyerNative) },
        seller: { ...fx.input.copies.seller, binding: sellerBinding },
      },
    };
    type Input = typeof base;
    type Copy = Input["copies"]["buyer"] | Input["copies"]["seller"];
    const depsFor = (input: Input): FixedPriceX402AuditCompletionDeps => ({
      ...fx.deps,
      sellerFinalizationProvider: { ...fx.sellerFinalizationProvider, mapping: "write-input" as const },
      readBundleCopy: (_nativeAddress, role) =>
        structuredClone(input.copies[role].bundle) as unknown as Record<string, unknown>,
      verifyBundleAnchor: () => ({ disposition: "valid" as const, mapping: "write-input" as const }),
      resolveBundleBinding: (_logicalAddress, _signer, role) => ({
        disposition: "present" as const,
        binding: structuredClone(input.copies[role].binding),
      }),
      verifyBundleBinding: () => ({ disposition: "valid" }),
    });
    // The authenticated closure carries the copies as given.
    const closed = (input: Input): Input => ({
      ...input,
      sellerClosure: {
        ...input.sellerClosure,
        result: {
          ...fx.closureResult,
          nativeAddress: input.copies.seller.nativeAddress,
          bundleContentHash: attestationBundleHash(input.copies.seller.bundle),
          sellerBundle: input.copies.seller.bundle,
          buyerBundle: input.copies.buyer.bundle,
          anchorReceipt: input.copies.seller.anchorReceipt,
          binding: input.copies.seller.binding,
        },
      },
    });
    const outcome = (input: Input) => verifyFixedPriceX402AuditCompletion(input, depsFor(input))
      .then(() => "audit-complete", (error: unknown) => error);
    const mutated = (role: "buyer" | "seller", change: (copy: Copy) => void): Input => {
      const input = structuredClone(base);
      change(input.copies[role]);
      return closed(input);
    };
    const signedBinding = (
      body: Omit<BundleBinding, "signature">,
      signer: { did: string },
      key: { privateKey: ReturnType<typeof privateKeyFromSeed> },
    ): BundleBinding => ({
      ...body,
      signature: {
        algorithm: "ed25519",
        signer: signer.did,
        value: Buffer.from(ed25519Sign(
          signedBytes(BUNDLE_BINDING_SEPARATOR, contentHash(body as unknown as Record<string, unknown>)),
          key.privateKey,
        )).toString("base64url"),
      },
    });
    const rebind = (change: Partial<Omit<BundleBinding, "signature">>, signer = BUYER, key = signer) =>
      (copy: Copy) => {
        const { signature: _signature, ...body } = copy.binding;
        copy.binding = signedBinding({ ...body, ...change }, signer, key);
      };

    await expect(outcome(closed(structuredClone(base)))).resolves.toBe("audit-complete");

    const receiptAnswer = (role: string) =>
      new RegExp(`${role} bundle receipt is not the exact established finalized receipt`);
    const wrongType = /completed buyer bundle has the wrong type or session binding/;
    const bindingAnswer = /completed buyer bundle lacks its exact BB-1 binding/;
    const cases: Array<[string, Input, RegExp]> = [
      // ST-11 step 4 / §10.4.3: the copy's own receipt is established and finalized.
      ["an included buyer receipt", mutated("buyer", (copy) => {
        copy.anchorReceipt.state = "included"; }), receiptAnswer("buyer")],
      ["an included seller receipt", mutated("seller", (copy) => {
        copy.anchorReceipt.state = "included"; }), receiptAnswer("seller")],
      // A well-formed indeterminate receipt preserves the receipt it observed.
      ["an indeterminate receipt disposition", mutated("buyer", (copy) => {
        copy.anchorReceipt.observationDisposition = "indeterminate";
        copy.anchorReceipt.preservedReceiptHash = h("9"); }), receiptAnswer("buyer")],
      ["a receipt for another logical address", mutated("buyer", (copy) => {
        copy.anchorReceipt.logicalAddress = bundleAddress(JOB_ID, "seller"); }), receiptAnswer("buyer")],
      ["a receipt for another native address", mutated("buyer", (copy) => {
        copy.anchorReceipt.nativeAddress = "native:elsewhere"; }), receiptAnswer("buyer")],
      ["a receipt for other content", mutated("buyer", (copy) => {
        copy.anchorReceipt.contentHash = h("e"); }), receiptAnswer("buyer")],
      // §10.4.3: only a completed, unfaulted copy for this job completes.
      ["a non-completed outcome", mutated("buyer", (copy) => {
        (copy.bundle as { outcome: string }).outcome = "failed-perm"; }), wrongType],
      ["another job's copy", mutated("buyer", (copy) => {
        copy.bundle.jobId = "01J8ME0SXKQ4T9V2RC5HJ6WX7F"; }), wrongType],
      // §10.4.1: every signature verifies and every required signer signed.
      ["an under-signed copy", mutated("buyer", (copy) => {
        copy.bundle.signatures = copy.bundle.signatures.filter((entry) => entry.party === BUYER.did);
      }), /completed buyer bundle signature verification failed: copy is missing required signatures/],
      ["a copy with a bad signature", mutated("buyer", (copy) => {
        copy.bundle.signatures = copy.bundle.signatures.map((entry) => entry.party === SELLER.did
          ? { ...entry, value: Buffer.from(ed25519Sign(new Uint8Array([1]), SELLER.privateKey)).toString("base64url") }
          : entry);
      }), /completed buyer bundle signature verification failed/],
      // BB-5 checks 4, 5, 8 and 9: the binding names this copy exactly.
      ["no binding", mutated("buyer", (copy) => {
        delete (copy as { binding?: BundleBinding }).binding; }), bindingAnswer],
      ["a binding by another signer", mutated("buyer", rebind({ signer: SELLER.did }, SELLER)), bindingAnswer],
      ["a binding for other content", mutated("buyer", rebind({ bundleContentHash: h("e") })), bindingAnswer],
      ["a binding for another logical address", mutated("buyer", rebind({
        logicalAddress: bundleAddress(JOB_ID, "seller") })), bindingAnswer],
      ["a binding for another native address", mutated("buyer", rebind({
        nativeAddress: "native:elsewhere" })), bindingAnswer],
      ["a binding for another role", mutated("buyer", rebind({ role: "seller" })), bindingAnswer],
      ["a binding for another job", mutated("buyer", rebind({ jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7F" })),
        bindingAnswer],
      // BB-4: the binding signature verifies under its signer's key.
      ["a binding signed with another key", mutated("buyer", rebind({}, BUYER, SELLER)),
        /completed buyer BundleBinding signature is invalid/],
    ];
    // ST-11: the copies are the authenticated closure's.
    const closure = closed(structuredClone(base));
    const elsewhere = structuredClone(closure);
    elsewhere.sellerClosure.result.nativeAddress = "native:elsewhere";
    const otherReceipt = structuredClone(closure);
    // A new object: structuredClone keeps the closure sharing the copy's receipt.
    otherReceipt.sellerClosure.result.anchorReceipt = {
      ...otherReceipt.sellerClosure.result.anchorReceipt,
      observedAt: otherReceipt.sellerClosure.result.anchorReceipt.observedAt + 1,
    };
    const otherBuyerBundle = structuredClone(closure);
    otherBuyerBundle.sellerClosure.result.buyerBundle = signBundle({
      ...(({ anchoredByRole: _role, signatures: _signatures, ...body }) => body)(fx.buyerBundle),
      finalisedAt: fx.buyerBundle.finalisedAt + 1,
    }, "buyer");
    const otherBinding = structuredClone(closure);
    otherBinding.sellerClosure.result.binding = binding(fx.sellerBundle, "seller", "native:elsewhere");
    const notTheClosure = /completed bundle copies do not match the authenticated durable session closure/;
    cases.push(
      ["a closure at another native address", elsewhere, notTheClosure],
      ["a closure with another receipt", otherReceipt, notTheClosure],
      ["a closure with another buyer copy", otherBuyerBundle, notTheClosure],
      ["a closure with another binding", otherBinding, notTheClosure],
    );
    for (const [label, input, message] of cases) {
      const error = await outcome(input);
      expect(error, label).toBeInstanceOf(DacsError);
      expect(error, label).not.toBeInstanceOf(IndeterminateSubstrateError);
      expect(String(error), label).toMatch(message);
    }
  });

  it("never accepts caller-selected pure mapping for Demos", async () => {
    const fx = await fixture();
    const input = structuredClone(fx.input);
    input.copies.buyer.anchorReceipt = receipt(
      bundleAddress(JOB_ID, "buyer"),
      fx.buyerNative,
      attestationBundleHash(fx.buyerBundle),
      BUYER.did,
      "demos",
    );
    input.copies.seller.anchorReceipt = receipt(
      bundleAddress(JOB_ID, "seller"),
      fx.sellerNative,
      attestationBundleHash(fx.sellerBundle),
      SELLER.did,
      "demos",
    );
    input.sellerClosure.result.anchorReceipt = input.copies.seller.anchorReceipt;
    await expect(verifyFixedPriceX402AuditCompletion(input, {
      ...fx.deps,
      verifyBundleAnchor: () => ({ disposition: "valid", mapping: "pure" }),
    })).rejects.toThrow(/Demos.*write-input mapping/);
  });

  it("rejects role copies with different agreement or settlement inventories", async () => {
    const fx = await fixture();
    const buyerBody = structuredClone(fx.buyerBundle) as FaultAttestationBundle;
    buyerBody.settlementEvidence = [];
    const { anchoredByRole: _role, signatures: _signatures, ...unsigned } = buyerBody;
    const mismatchedBuyer = signBundle(unsigned, "buyer");
    const input = structuredClone(fx.input);
    input.copies.buyer.bundle = mismatchedBuyer;
    input.copies.buyer.anchorReceipt = receipt(
      bundleAddress(JOB_ID, "buyer"),
      fx.buyerNative,
      attestationBundleHash(mismatchedBuyer),
      BUYER.did,
    );
    input.sellerClosure.result.buyerBundle = mismatchedBuyer;
    await expect(verifyFixedPriceX402AuditCompletion(input, {
      ...fx.deps,
      readBundleCopy: (nativeAddress) =>
        nativeAddress === fx.buyerNative
          ? mismatchedBuyer as unknown as Record<string, unknown>
          : fx.sellerBundle as unknown as Record<string, unknown>,
    })).rejects.toThrow(/different signed scopes/);
  });

  it("rejects a bundle roster that contradicts the pinned orchestrator topology", async () => {
    const fx = await fixture();
    const input = structuredClone(fx.input);
    input.copies.buyer.bundle.parties.push({
      role: "orchestrator",
      bundleHash: h("f"),
      primaryClaim: "did:example:other-orchestrator",
    });
    input.sellerClosure.result.buyerBundle = input.copies.buyer.bundle;
    await expect(verifyFixedPriceX402AuditCompletion(input, {
      ...fx.deps,
      readBundleCopy: (nativeAddress) =>
        nativeAddress === fx.buyerNative
          ? input.copies.buyer.bundle as unknown as Record<string, unknown>
          : fx.sellerBundle as unknown as Record<string, unknown>,
    }))
      .rejects.toThrow(/authenticated durable session closure|seller-as-orchestrator topology/);
  });
});

// Coordinator statuses for one rail whose audit tracks end as given; every
// other track succeeds. The bundles and closure stay authentic, so only the
// operational audit tracks can stop the gate.
type AuditTrackResult = Awaited<ReturnType<FixedPriceX402TrackOperation>>;
const auditSuccess = (reference: string): AuditTrackResult => ({ status: "final", outcome: "success", reference });
const auditFailure = (reference: string): AuditTrackResult => ({
  status: "final", outcome: "failure", errorClass: "counterparty", faultedParty: "seller", reference,
});
const auditPending: AuditTrackResult = { status: "pending-retry", reasonCode: "audit-read-unanswered", retryAt: 1780000060000 };

// A deadline the test expires itself: no real waiting.
function manualDeadline() {
  const armed = new Map<number, Readonly<{ timeoutMs: number; expire: () => void }>>();
  let next = 0;
  return {
    start(expire: () => void, timeoutMs: number) {
      const id = next++;
      armed.set(id, { timeoutMs, expire });
      return () => { armed.delete(id); };
    },
    armed: () => [...armed.values()].map((timer) => timer.timeoutMs),
    expire() {
      for (const [id, timer] of [...armed]) {
        armed.delete(id);
        timer.expire();
      }
    },
  };
}

// Lets every promise that can settle without a timer settle.
async function flush() {
  for (let round = 0; round < 10; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

// A failed payment is the failing terminal path an audit failure must match.
const paymentFailure = (role: FixedPriceX402CoordinatorRole): AuditTrackResult => auditFailure(`${role}:payment`);
type TrackResults = Partial<Record<string, AuditTrackResult>>;

async function gateWithAudit(
  rail: "pay-x402" | "pay-dem",
  audit: (fx: Awaited<ReturnType<typeof fixture>>) => Record<FixedPriceX402CoordinatorRole, AuditTrackResult | TrackResults>,
) {
  const fx = await fixture(rail);
  const results = audit(fx);
  const trackResult = (role: FixedPriceX402CoordinatorRole, track: string): AuditTrackResult | undefined => {
    const value = results[role];
    return "status" in value ? (track === "audit" ? value as AuditTrackResult : undefined) : (value as TrackResults)[track];
  };
  const operation = (role: FixedPriceX402CoordinatorRole, track: string) => async () =>
    trackResult(role, track) ?? { status: "final" as const, outcome: "success" as const, reference: `${role}:${track}` };
  const tracks = {
    buyer: ["agreement", "payment", "payment-evidence", "buyer-received", "audit"],
    seller: ["agreement", "payment", "payment-evidence", "delivery", "delivery-evidence", "audit"],
  };
  const operations = (role: FixedPriceX402CoordinatorRole) =>
    Object.fromEntries(tracks[role].map((track) => [track, operation(role, track)]));
  const now = () => 1780000000000;
  let buyerStatus;
  let sellerStatus;
  if (rail === "pay-x402") {
    const store = createInMemoryFixedPriceX402CoordinatorStore({ now });
    const buyer = createFixedPriceX402BuyerCoordinator({ store, workerId: "buyer-gate", operations: operations("buyer") });
    const seller = createFixedPriceX402SellerCoordinator({ store, workerId: "seller-gate", operations: operations("seller") });
    await buyer.startOrder(order("buyer"));
    await seller.startOrder(order("seller"));
    await buyer.runPending({ limit: 10 });
    await seller.runPending({ limit: 10 });
    buyerStatus = (await buyer.getOrderStatus(JOB_ID))!;
    sellerStatus = (await seller.getOrderStatus(JOB_ID))!;
  } else {
    const store = createInMemoryFixedPricePayDemCoordinatorStore({ now });
    const buyer = createFixedPricePayDemBuyerCoordinator({ store, workerId: "buyer-gate", operations: operations("buyer") });
    const seller = createFixedPricePayDemSellerCoordinator({ store, workerId: "seller-gate", operations: operations("seller") });
    await buyer.startOrder(payDemOrder("buyer"));
    await seller.startOrder(payDemOrder("seller"));
    await buyer.runPending({ limit: 10 });
    await seller.runPending({ limit: 10 });
    buyerStatus = (await buyer.getOrderStatus(JOB_ID))!;
    sellerStatus = (await seller.getOrderStatus(JOB_ID))!;
  }
  const input = { ...fx.input, buyer: buyerStatus, seller: sellerStatus };
  const verify = (deps: FixedPriceX402AuditCompletionDeps = fx.deps) => rail === "pay-x402"
    ? verifyFixedPriceX402AuditCompletion(input as never, deps)
    : verifyFixedPricePayDemAuditCompletion(input as never, deps);
  return { fx, buyerStatus, sellerStatus, verify };
}

describe("native DEM exact profile admission", () => {
  const historicalRelease = "965df755aba4ff392f1fb37a93d287242b177ba4";

  it.each(["pay-x402", "pay-dem"] as const)(
    "requires independent admission for %s completion before reading artifacts", async (rail) => {
      const gate = await gateWithAudit(rail, (fx) => ({
        buyer: auditSuccess(fx.buyerNative), seller: auditSuccess(fx.sellerNative),
      }));
      const read = vi.fn(gate.fx.deps.readBundleCopy);
      await expect(gate.verify({ ...gate.fx.deps, authenticateSessionProfile: undefined,
        readBundleCopy: read } as never)).rejects.toThrow(/authenticateSessionProfile/);
      expect(read).not.toHaveBeenCalled();
      expect(verifySellerClosure).not.toHaveBeenCalled();
      // The fixture models a released profile with exact role authority.
      await expect(gate.verify()).resolves.toMatchObject({ milestone: "audit-complete" });
    });

  it.each(["pay-x402", "pay-dem"] as const)(
    "refuses %s completion while the pinned profile is unreleased, before any read", async (rail) => {
      const gate = await gateWithAudit(rail, (fx) => ({
        buyer: auditSuccess(fx.buyerNative), seller: auditSuccess(fx.sellerNative),
      }));
      release.real = true;
      const read = vi.fn(gate.fx.deps.readBundleCopy);
      // The authority states the candidate status in full; that opens nothing.
      await expect(gate.verify({ ...gate.fx.deps, readBundleCopy: read }))
        .rejects.toThrow(/unreleased candidate and is not an admissible live session profile/);
      expect(read).not.toHaveBeenCalled();
      expect(verifySellerClosure).not.toHaveBeenCalled();
    });

  it("binds new native orders to the current completed-session release", () => {
    expect(FIXED_PRICE_PAY_DEM_STANDARD_REVISION).toBe(FIXED_PRICE_X402_STANDARD_REVISION);
  });

  it.each([
    [historicalRelease, FIXED_PRICE_X402_STANDARD_REVISION],
    [FIXED_PRICE_X402_STANDARD_REVISION, historicalRelease],
    [historicalRelease, historicalRelease],
  ])("refuses order release %s with admission release %s before reads", async (orderRelease, admissionRelease) => {
    const gate = await gateWithAudit("pay-dem", (fx) => ({
      buyer: auditSuccess(fx.buyerNative), seller: auditSuccess(fx.sellerNative),
    }));
    for (const status of [gate.buyerStatus, gate.sellerStatus]) {
      (status.protocol as { standardRevision: string }).standardRevision = orderRelease;
    }
    const read = vi.fn(gate.fx.deps.readBundleCopy);
    await expect(gate.verify({ ...gate.fx.deps, readBundleCopy: read,
      authenticateSessionProfile: () => ({ ...trustedAdmission(), releasePin: admissionRelease }),
    } as FixedPricePayDemAuditCompletionDeps)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    expect(verifySellerClosure).not.toHaveBeenCalled();
  });

  it.each(["buyer", "seller"] as const)("refuses a historical %s order beside a current peer", async (role) => {
    const gate = await gateWithAudit("pay-dem", (fx) => ({
      buyer: auditSuccess(fx.buyerNative), seller: auditSuccess(fx.sellerNative),
    }));
    const status = role === "buyer" ? gate.buyerStatus : gate.sellerStatus;
    (status.protocol as { standardRevision: string }).standardRevision = historicalRelease;
    await expect(gate.verify()).rejects.toThrow();
    expect(verifySellerClosure).not.toHaveBeenCalled();
  });
});

describe("native DEM admission deadline", () => {
  it.each(["resolve", "reject"] as const)(
    "bounds pending admission and ignores a late %s without starting reads", async (late) => {
      const gate = await gateWithAudit("pay-dem", (fx) => ({
        buyer: auditSuccess(fx.buyerNative), seller: auditSuccess(fx.sellerNative),
      }));
      const clock = manualDeadline();
      const disarm = vi.fn();
      const start = vi.fn((expire: () => void, timeoutMs: number) => {
        const clear = clock.start(expire, timeoutMs);
        return () => { clear(); disarm(); };
      });
      let resolveAdmission!: (value: unknown) => void;
      let rejectAdmission!: (error: unknown) => void;
      const admission = new Promise<unknown>((resolve, reject) => {
        resolveAdmission = resolve; rejectAdmission = reject;
      });
      const readBundleCopy = vi.fn(gate.fx.deps.readBundleCopy);
      const outcome = gate.verify({ ...gate.fx.deps, readBundleCopy,
        authenticateSessionProfile: () => admission,
        deadline: { timeoutMs: 5_000, start },
      } as FixedPricePayDemAuditCompletionDeps).catch((error: unknown) => error);
      await flush();
      expect(clock.armed()).toEqual([5_000]);
      expect(verifySellerClosure).not.toHaveBeenCalled();
      expect(readBundleCopy).not.toHaveBeenCalled();
      clock.expire();
      const error = await outcome;
      expect(error).toBeInstanceOf(IndeterminateSubstrateError);
      expect(String(error)).toMatch(/trusted session profile admission.*5000 ms/);
      expect(disarm).toHaveBeenCalledOnce();
      if (late === "resolve") resolveAdmission(trustedAdmission());
      else rejectAdmission(new DacsError("late admission rejection"));
      await flush();
      expect(verifySellerClosure).not.toHaveBeenCalled();
      expect(readBundleCopy).not.toHaveBeenCalled();
      expect(start).toHaveBeenCalledOnce();
      expect(clock.armed()).toEqual([]);
      await expect(outcome).resolves.toBe(error);
    },
  );

  it("uses the admission deadline for the subsequent seller closure without rearming", async () => {
    const gate = await gateWithAudit("pay-dem", (fx) => ({
      buyer: auditSuccess(fx.buyerNative), seller: auditSuccess(fx.sellerNative),
    }));
    const clock = manualDeadline();
    const start = vi.fn(clock.start);
    let admit!: (value: unknown) => void;
    const admission = new Promise<unknown>((resolve) => { admit = resolve; });
    verifySellerClosure.mockImplementationOnce(() => new Promise<never>(() => undefined));
    const outcome = gate.verify({ ...gate.fx.deps,
      authenticateSessionProfile: () => admission, deadline: { timeoutMs: 5_000, start },
    } as FixedPricePayDemAuditCompletionDeps).catch((error: unknown) => error);
    await flush();
    expect(clock.armed()).toEqual([5_000]);
    admit(trustedAdmission());
    await flush();
    expect(verifySellerClosure).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    clock.expire();
    const error = await outcome;
    expect(error).toBeInstanceOf(IndeterminateSubstrateError);
    expect(String(error)).toMatch(/seller closure re-verification.*5000 ms/);
    expect(clock.armed()).toEqual([]);
  });

  it.each(["invalid", "permanent error", "unavailable", "success"] as const)(
    "disarms the deadline after admission returns %s", async (result) => {
      const gate = await gateWithAudit("pay-dem", (fx) => ({
        buyer: auditSuccess(fx.buyerNative), seller: auditSuccess(fx.sellerNative),
      }));
      const clock = manualDeadline();
      const disarm = vi.fn();
      const start = vi.fn((expire: () => void, timeoutMs: number) => {
        const clear = clock.start(expire, timeoutMs);
        return () => { clear(); disarm(); };
      });
      const permanent = new DacsError("admission rejected");
      let admit!: () => void;
      const admission = new Promise<void>((resolve) => { admit = resolve; });
      let close!: () => void;
      const closure = new Promise<void>((resolve) => { close = resolve; });
      const sellerClosure = verifySellerClosure.getMockImplementation()!;
      if (result === "success") verifySellerClosure.mockImplementationOnce(async (...args) => {
        await closure;
        return sellerClosure(...args);
      });
      const pending = gate.verify({ ...gate.fx.deps, deadline: { start },
        authenticateSessionProfile: async () => {
          await admission;
          if (result === "permanent error") throw permanent;
          if (result === "unavailable") throw new Error("lookup unavailable");
          return result === "invalid" ? { status: "invalid" } : trustedAdmission();
        },
      } as FixedPricePayDemAuditCompletionDeps).catch((error: unknown) => error);
      await flush();
      expect(start).toHaveBeenCalledOnce();
      expect(clock.armed()).toEqual([COMPLETED_TWO_SIDED_SESSION_DEADLINE_MS]);
      expect(verifySellerClosure).not.toHaveBeenCalled();
      expect(disarm).not.toHaveBeenCalled();
      admit();
      if (result === "success") {
        await flush();
        expect(verifySellerClosure).toHaveBeenCalledOnce();
        expect(start).toHaveBeenCalledOnce();
        expect(clock.armed()).toEqual([COMPLETED_TWO_SIDED_SESSION_DEADLINE_MS]);
        expect(disarm).not.toHaveBeenCalled();
        close();
      }
      const outcome = await pending;
      expect(start).toHaveBeenCalledOnce();
      expect(disarm).toHaveBeenCalledOnce();
      expect(clock.armed()).toEqual([]);
      if (result === "success") expect(outcome).toMatchObject({ milestone: "audit-complete" });
      else {
        expect(verifySellerClosure).not.toHaveBeenCalled();
        if (result === "permanent error") expect(outcome).toBe(permanent);
        else expect(outcome).toBeInstanceOf(result === "unavailable" ? IndeterminateSubstrateError : DacsError);
      }
    },
  );
});

describe.each(["pay-x402", "pay-dem"] as const)("%s audit-complete gate over operational audit tracks", (rail) => {
  it("grants audit-complete when both audit tracks are final successes on the exact bundles", async () => {
    const gate = await gateWithAudit(rail, (fx) => ({ buyer: auditSuccess(fx.buyerNative), seller: auditSuccess(fx.sellerNative) }));
    await expect(gate.verify()).resolves.toMatchObject({ milestone: "audit-complete" });
  });

  it.each(["buyer", "seller"] as const)("refuses while only the other side is final (%s audit pending)", async (pending) => {
    const gate = await gateWithAudit(rail, (fx) => ({
      buyer: pending === "buyer" ? auditPending : auditSuccess(fx.buyerNative),
      seller: pending === "seller" ? auditPending : auditSuccess(fx.sellerNative),
    }));
    const status = pending === "buyer" ? gate.buyerStatus : gate.sellerStatus;
    expect(status.tracks.audit?.state).not.toBe("final");
    await expect(gate.verify()).rejects.toThrow(/both operational audit tracks/);
    expect(verifySellerClosure).not.toHaveBeenCalled();
  });

  it.each(["buyer", "seller"] as const)("refuses a %s audit reference that is not its copy's address", async (role) => {
    const gate = await gateWithAudit(rail, (fx) => ({
      buyer: auditSuccess(role === "buyer" ? "native:elsewhere" : fx.buyerNative),
      seller: auditSuccess(role === "seller" ? "native:elsewhere" : fx.sellerNative),
    }));
    const status = role === "buyer" ? gate.buyerStatus : gate.sellerStatus;
    expect(status.tracks.audit).toMatchObject({ state: "final", outcome: "success", reference: "native:elsewhere" });
    await expect(gate.verify()).rejects.toThrow(/both operational audit tracks to reference their exact bundle/);
    expect(verifySellerClosure).not.toHaveBeenCalled();
  });

  it("refuses when both audit tracks are final failures on the exact bundles", async () => {
    const gate = await gateWithAudit(rail, (fx) => ({
      buyer: { payment: paymentFailure("buyer"), audit: auditFailure(fx.buyerNative) },
      seller: { payment: paymentFailure("seller"), audit: auditFailure(fx.sellerNative) },
    }));
    expect(gate.buyerStatus.tracks.audit).toMatchObject({ state: "final", outcome: "failure" });
    expect(gate.sellerStatus.tracks.audit).toMatchObject({ state: "final", outcome: "failure" });
    await expect(gate.verify()).rejects.toThrow(/both operational audit tracks/);
    expect(verifySellerClosure).not.toHaveBeenCalled();
  });

  it.each(["buyer", "seller"] as const)("refuses one failed audit track while the other is pending (%s failed)", async (failed) => {
    const gate = await gateWithAudit(rail, (fx) => ({
      buyer: failed === "buyer" ? { payment: paymentFailure("buyer"), audit: auditFailure(fx.buyerNative) }
        : { payment: paymentFailure("buyer"), audit: auditPending },
      seller: failed === "seller" ? { payment: paymentFailure("seller"), audit: auditFailure(fx.sellerNative) }
        : { payment: paymentFailure("seller"), audit: auditPending },
    }));
    const status = failed === "buyer" ? gate.buyerStatus : gate.sellerStatus;
    expect(status.tracks.audit).toMatchObject({ state: "final", outcome: "failure" });
    await expect(gate.verify()).rejects.toThrow(/both operational audit tracks/);
    expect(verifySellerClosure).not.toHaveBeenCalled();
  });

  // One copy's read cannot be answered; the substrate answers `invalid` for
  // the other copy's anchor 25 ms after it, or 25 ms before it. The verifier
  // settles both copies and reports the answer, whichever arrives first.
  for (const answerArrives of ["last", "first"] as const) {
    it.each(["buyer", "seller"] as const)(
      `reports an answer against the %s copy that arrives ${answerArrives}, not the other copy's unavailable read`,
      async (answered) => {
        const gate = await gateWithAudit(rail, (fx) => ({
          buyer: auditSuccess(fx.buyerNative), seller: auditSuccess(fx.sellerNative),
        }));
        const pause = () => new Promise((resolve) => setTimeout(resolve, 25));
        const settled: string[] = [];
        const rejection = gate.verify({
          ...gate.fx.deps,
          readBundleCopy: async (nativeAddress, role) => {
            if (role === answered) return gate.fx.deps.readBundleCopy(nativeAddress, role);
            if (answerArrives === "first") await pause();
            settled.push(`${role}:unavailable`);
            throw new IndeterminateSubstrateError(`${role} bundle read unavailable`);
          },
          verifyBundleAnchor: async (copy) => {
            if (answerArrives === "last") await pause();
            settled.push(`${copy.role}:answered`);
            return { disposition: "invalid", reason: `${copy.role}-anchor-invalid` };
          },
        });
        await expect(rejection).rejects.toThrow(`completed ${answered} bundle anchor verification is invalid`);
        expect(settled).toHaveLength(2);
      },
    );
  }

  // One copy's read never settles. The other copy's answer, a rejection, or
  // its unanswered read decides at the deadline; a late read changes nothing.
  for (const hanging of ["buyer", "seller"] as const) {
    const other = hanging === "buyer" ? "seller" : "buyer";
    it.each(["rejects", "goes unanswered"] as const)(
      `decides at the deadline when the ${hanging} copy's read never settles and the other copy %s`,
      async (otherOutcome) => {
        const gate = await gateWithAudit(rail, (fx) => ({
          buyer: auditSuccess(fx.buyerNative), seller: auditSuccess(fx.sellerNative),
        }));
        const clock = manualDeadline();
        let lateRead = (_error: Error): void => undefined;
        let reached = false;
        const outcome = gate.verify({
          ...gate.fx.deps,
          deadline: { timeoutMs: 5_000, start: clock.start },
          readBundleCopy: async (nativeAddress, role) => {
            if (role === hanging) {
              reached = true;
              return await new Promise<never>((_resolve, reject) => { lateRead = reject; });
            }
            if (otherOutcome === "goes unanswered") {
              throw new IndeterminateSubstrateError(`${role} bundle read unavailable`);
            }
            return gate.fx.deps.readBundleCopy(nativeAddress, role);
          },
          verifyBundleAnchor: async (copy) => ({ disposition: "invalid", reason: `${copy.role}-anchor-invalid` }),
        }).then(() => "verified", (error: unknown) => error);
        let decided = false;
        void outcome.then(() => { decided = true; });
        await flush();
        expect(reached).toBe(true);
        expect(clock.armed()).toEqual([5_000]);
        expect(decided).toBe(false);

        clock.expire();
        const error = await outcome;
        if (otherOutcome === "rejects") {
          expect(error).not.toBeInstanceOf(IndeterminateSubstrateError);
          expect(error).toMatchObject({ message: `completed ${other} bundle anchor verification is invalid` });
        } else {
          expect(error).toBeInstanceOf(IndeterminateSubstrateError);
          expect(error).toMatchObject({ message: `${other} bundle read unavailable` });
        }
        // The read answers authoritatively after the deadline: nothing changes.
        lateRead(new DacsError(`late ${hanging} answer`));
        await flush();
        await expect(outcome).resolves.toBe(error);
        expect(clock.armed()).toEqual([]);
      },
    );
  }

  it("reports an indeterminate result when neither copy's read settles by the deadline", async () => {
    const gate = await gateWithAudit(rail, (fx) => ({
      buyer: auditSuccess(fx.buyerNative), seller: auditSuccess(fx.sellerNative),
    }));
    const clock = manualDeadline();
    const outcome = gate.verify({
      ...gate.fx.deps,
      deadline: { timeoutMs: 5_000, start: clock.start },
      readBundleCopy: () => new Promise<never>(() => undefined),
    }).then(() => "verified", (error: unknown) => error);
    await flush();
    clock.expire();
    const error = await outcome;
    expect(error).toBeInstanceOf(IndeterminateSubstrateError);
    expect(error).toMatchObject({ message: "completed buyer bundle copy verification did not settle within 5000 ms" });
  });

  it("disarms the deadline once both copies settle", async () => {
    const gate = await gateWithAudit(rail, (fx) => ({
      buyer: auditSuccess(fx.buyerNative), seller: auditSuccess(fx.sellerNative),
    }));
    const clock = manualDeadline();
    await expect(gate.verify({ ...gate.fx.deps, deadline: { start: clock.start } }))
      .resolves.toMatchObject({ milestone: "audit-complete" });
    expect(clock.armed()).toEqual([]);
  });

  // The one deadline is armed when the gate starts. It already runs while the
  // seller closure is re-verified, before either copy is read.
  it("decides at the deadline when the seller closure's re-verification never settles", async () => {
    const gate = await gateWithAudit(rail, (fx) => ({
      buyer: auditSuccess(fx.buyerNative), seller: auditSuccess(fx.sellerNative),
    }));
    const clock = manualDeadline();
    let lateClosure = (_error: Error): void => undefined;
    verifySellerClosure.mockImplementationOnce(() =>
      new Promise<never>((_resolve, reject) => { lateClosure = reject; }));
    const readBundleCopy = vi.fn(gate.fx.deps.readBundleCopy);
    const outcome = gate.verify({
      ...gate.fx.deps,
      readBundleCopy,
      deadline: { timeoutMs: 5_000, start: clock.start },
    }).then(() => "verified", (error: unknown) => error);
    let decided = false;
    void outcome.then(() => { decided = true; });
    await flush();
    expect(verifySellerClosure).toHaveBeenCalledOnce();
    expect(clock.armed()).toEqual([5_000]);
    expect(decided).toBe(false);

    clock.expire();
    const error = await outcome;
    expect(error).toBeInstanceOf(IndeterminateSubstrateError);
    expect(error).toMatchObject({
      message: "completed seller closure re-verification did not settle within 5000 ms",
    });
    expect(readBundleCopy).not.toHaveBeenCalled();
    lateClosure(new DacsError("late closure answer"));
    await flush();
    await expect(outcome).resolves.toBe(error);
  });

  // Daybreak's round-7 probe: both copies verify and both anchors answer, then
  // a key resolution of the final pair check never settles. The same deadline,
  // still armed, decides; no fresh one is started for that check.
  it("decides at the same deadline when the final pair check's key resolution never settles", async () => {
    const gate = await gateWithAudit(rail, (fx) => ({
      buyer: auditSuccess(fx.buyerNative), seller: auditSuccess(fx.sellerNative),
    }));
    const clock = manualDeadline();
    const start = vi.fn(clock.start);
    const verifier = (gate.fx.sellerFinalizationProvider as unknown as {
      bundleCopyVerifier: {
        resolvePublicKey(did: string): Promise<Uint8Array | null>;
        verify(bytes: Uint8Array, signature: Uint8Array, key: Uint8Array): boolean;
      };
    }).bundleCopyVerifier;
    const anchors: string[] = [];
    let lateKey = (_key: Uint8Array | null): void => undefined;
    const outcome = gate.verify({
      ...gate.fx.deps,
      deadline: { timeoutMs: 5_000, start },
      sellerFinalizationProvider: {
        mapping: "pure",
        bundleCopyVerifier: {
          // Once both anchors answered, only the final pair check resolves keys.
          resolvePublicKey: (did: string) => anchors.length < 2
            ? verifier.resolvePublicKey(did)
            : new Promise<Uint8Array | null>((resolve) => { lateKey = resolve; }),
          verify: verifier.verify,
        },
      } as never,
      verifyBundleAnchor: (copy) => {
        anchors.push(copy.role);
        return { disposition: "valid", mapping: "pure" };
      },
    }).then(() => "verified", (error: unknown) => error);
    let decided = false;
    void outcome.then(() => { decided = true; });
    await flush();
    expect([...anchors].sort()).toEqual(["buyer", "seller"]);
    expect(clock.armed()).toEqual([5_000]);
    expect(decided).toBe(false);

    clock.expire();
    const error = await outcome;
    expect(error).toBeInstanceOf(IndeterminateSubstrateError);
    expect(error).toMatchObject({
      message: "completed bundle pair consistency check did not settle within 5000 ms",
    });
    lateKey(null);
    await flush();
    await expect(outcome).resolves.toBe(error);
    expect(start).toHaveBeenCalledOnce();
    expect(clock.armed()).toEqual([]);
  });

  // The default deadline is a real timer that cannot keep a host process
  // alive, and the gate clears it when it returns.
  it("runs its default deadline on an unreferenced timer and clears it", async () => {
    const gate = await gateWithAudit(rail, (fx) => ({
      buyer: auditSuccess(fx.buyerNative), seller: auditSuccess(fx.sellerNative),
    }));
    const timers = vi.spyOn(globalThis, "setTimeout");
    const clears = vi.spyOn(globalThis, "clearTimeout");
    try {
      const deadlineTimer = () => timers.mock.results[timers.mock.calls.findIndex(
        ([, timeoutMs]) => timeoutMs === COMPLETED_TWO_SIDED_SESSION_DEADLINE_MS,
      )]?.value as ReturnType<typeof setTimeout> | undefined;
      let referenced: boolean | undefined;
      await expect(gate.verify({
        ...gate.fx.deps,
        verifyBundleAnchor: (copy) => {
          referenced = deadlineTimer()?.hasRef();
          return gate.fx.deps.verifyBundleAnchor(copy);
        },
      })).resolves.toMatchObject({ milestone: "audit-complete" });
      expect(referenced).toBe(false);
      expect(clears).toHaveBeenCalledWith(deadlineTimer());
    } finally {
      timers.mockRestore();
      clears.mockRestore();
    }
  });

  it("reports an observed closure rejection unchanged, not as indeterminate, and disarms the deadline", async () => {
    const gate = await gateWithAudit(rail, (fx) => ({
      buyer: auditSuccess(fx.buyerNative), seller: auditSuccess(fx.sellerNative),
    }));
    const clock = manualDeadline();
    verifySellerClosure.mockImplementationOnce(async () => { throw new DacsError("closure says no"); });
    const error = await gate.verify({ ...gate.fx.deps, deadline: { timeoutMs: 5_000, start: clock.start } })
      .then(() => "verified", (e: unknown) => e);
    expect(error).not.toBeInstanceOf(IndeterminateSubstrateError);
    expect((error as Error).message).toBe("closure says no");
    expect(clock.armed()).toEqual([]);
  });

  it.each([0, -1, 1.5, "5000"])("refuses a malformed deadline (%s ms) before reading either copy", async (timeoutMs) => {
    const gate = await gateWithAudit(rail, (fx) => ({
      buyer: auditSuccess(fx.buyerNative), seller: auditSuccess(fx.sellerNative),
    }));
    const readBundleCopy = vi.fn(gate.fx.deps.readBundleCopy);
    await expect(gate.verify({ ...gate.fx.deps, readBundleCopy, deadline: { timeoutMs } as never }))
      .rejects.toThrow("deadline.timeoutMs is malformed");
    expect(readBundleCopy).not.toHaveBeenCalled();
  });

  it.each(["buyer", "seller"] as const)("refuses contradicting final audit outcomes (%s failed)", async (failed) => {
    const gate = await gateWithAudit(rail, (fx) => ({
      buyer: failed === "buyer" ? { payment: paymentFailure("buyer"), audit: auditFailure(fx.buyerNative) }
        : auditSuccess(fx.buyerNative),
      seller: failed === "seller" ? { payment: paymentFailure("seller"), audit: auditFailure(fx.sellerNative) }
        : auditSuccess(fx.sellerNative),
    }));
    expect(gate.buyerStatus.tracks.audit?.state).toBe("final");
    expect(gate.sellerStatus.tracks.audit?.state).toBe("final");
    expect(gate.buyerStatus.tracks.audit?.outcome).not.toBe(gate.sellerStatus.tracks.audit?.outcome);
    await expect(gate.verify()).rejects.toThrow(/outcomes contradict|both operational audit tracks/);
    expect(verifySellerClosure).not.toHaveBeenCalled();
  });
});

// BB-6: a resolver may select a binding other than the carried one. Each
// selected binding below is properly signed, so only the field, readback and
// selected-copy checks can refuse it.
describe("selected BundleBinding at another native address", () => {
  async function selected(
    select: (fx: Awaited<ReturnType<typeof fixture>>) => BundleBinding,
    read: (fx: Awaited<ReturnType<typeof fixture>>) => Record<string, unknown> | null = (fx) =>
      fx.buyerBundle as unknown as Record<string, unknown>,
  ) {
    const fx = await fixture();
    const carriedBuyer = binding(fx.buyerBundle, "buyer", fx.buyerNative);
    const carriedSeller = binding(fx.sellerBundle, "seller", fx.sellerNative);
    const chosen = select(fx);
    const input = { ...fx.input,
      sellerClosure: { ...fx.input.sellerClosure, result: { ...fx.closureResult, binding: carriedSeller } },
      copies: { buyer: { ...fx.input.copies.buyer, binding: carriedBuyer },
        seller: { ...fx.input.copies.seller, binding: carriedSeller } } };
    const deps: FixedPriceX402AuditCompletionDeps = { ...fx.deps,
      sellerFinalizationProvider: { ...fx.sellerFinalizationProvider, mapping: "write-input" as const },
      verifyBundleAnchor: () => ({ disposition: "valid" as const, mapping: "write-input" as const }),
      resolveBundleBinding: (_logical, _signer, role) => ({
        disposition: "present" as const, binding: role === "buyer" ? chosen : carriedSeller }),
      readBundleCopy: (address, role) => address === chosen.nativeAddress && address !== fx.buyerNative
        ? read(fx) : fx.deps.readBundleCopy(address, role),
      verifyBundleBinding: () => ({ disposition: "valid" as const }),
    };
    return verifyFixedPriceX402AuditCompletion(input, deps).then(
      (result) => result.milestone, (error: unknown) => error);
  }
  const OTHER = "native:other-buyer";

  it("accepts an equal copy at another native address", async () => {
    await expect(selected((fx) => binding(fx.buyerBundle, "buyer", OTHER))).resolves.toBe("audit-complete");
  });

  it("refuses the other role's binding for this role", async () => {
    const outcome = await selected((fx) => binding(fx.sellerBundle, "seller", OTHER));
    expect(outcome).toBeInstanceOf(DacsError);
    expect(String(outcome)).toMatch(/completed buyer BundleBinding is not independently resolvable and exact$/);
  });

  it("refuses a binding over other bundle content", async () => {
    const outcome = await selected((fx) => binding({ ...fx.buyerBundle, finalisedAt: 1780000000001 }, "buyer", OTHER));
    expect(String(outcome)).toMatch(/completed buyer BundleBinding is not independently resolvable and exact$/);
  });

  it.each([
    ["carries no signatures", (bundle: FaultAttestationBundle) => ({ ...bundle, signatures: [] })],
    ["carries only its own role's signature", (bundle: FaultAttestationBundle) => ({ ...bundle,
      signatures: bundle.signatures.filter((entry) => entry.party === BUYER.did) })],
    ["carries a corrupted counterparty signature", (bundle: FaultAttestationBundle) => ({ ...bundle,
      signatures: bundle.signatures.map((entry) => entry.party === BUYER.did ? entry
        : { ...entry, value: Buffer.alloc(64, 7).toString("base64url") }) })],
  ])("refuses a selected copy with the same signed scope that %s", async (_case, edit) => {
    const outcome = await selected((fx) => binding(fx.buyerBundle, "buyer", OTHER),
      (fx) => edit(fx.buyerBundle) as unknown as Record<string, unknown>);
    expect(outcome).toBeInstanceOf(DacsError);
    expect(String(outcome)).toMatch(/completed buyer selected BundleBinding does not name the same verified signed scope/);
  });

  it("keeps a selected copy that is not yet readable indeterminate", async () => {
    const outcome = await selected((fx) => binding(fx.buyerBundle, "buyer", OTHER), () => null);
    expect(outcome).toBeInstanceOf(IndeterminateSubstrateError);
    expect(String(outcome)).toMatch(/selected bundle copy is not yet readable/);
  });
});
