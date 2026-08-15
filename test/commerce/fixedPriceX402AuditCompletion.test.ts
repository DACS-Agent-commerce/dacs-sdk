import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

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
  combineFixedPriceX402OrderStatus,
  createFixedPriceX402BuyerCoordinator,
  createFixedPriceX402SellerCoordinator,
  createInMemoryFixedPriceX402CoordinatorStore,
  FIXED_PRICE_X402_COMMERCE_PROFILE,
  FIXED_PRICE_X402_REGISTRY_INDEX_REF,
  FIXED_PRICE_X402_STANDARD_REVISION,
  verifyFixedPriceX402AuditCompletion,
  type FixedPriceX402AuditCompletionDeps,
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
): AnchorReceipt {
  return {
    receiptVersion: "1",
    substrate: "demos",
    finalityProfile: "demos-bft",
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

async function fixture() {
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
      kind: "pay-x402",
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
  const deps: FixedPriceX402AuditCompletionDeps = {
    bundleCopyVerifier: {
      resolvePublicKey: async (did) => publicKeys.get(did) ?? null,
      verify: (bytes, signature, key) =>
        ed25519Verify(bytes, signature, publicKeyFromRaw(key)),
    },
    verifyBundle: {
      readArtifact: async (ref) => bundles.get(ref) ?? null,
      resolveAttestationRef: async (ref) =>
        ref.anchor.locator === agreementRef.anchor.locator
          ? agreement
          : ref.anchor.locator === evidenceRef.anchor.locator
            ? evidence
            : null,
      resolveListingRef: async () => listing,
      resolvePublicKey: async (did) => publicKeys.get(did) ?? null,
      verify: (bytes, signature, key) =>
        ed25519Verify(bytes, signature, publicKeyFromRaw(key)),
    },
    resolveFinalizedDependencyReceipt: (ref) => receipt(
      ref.anchor.locator,
      `native:${ref.anchor.locator}`,
      ref.contentHash,
      SELLER.did,
    ),
    readFinalizedDependencyArtifact: (_nativeAddress, ref) =>
      ref.anchor.locator === agreementRef.anchor.locator
        ? agreement
        : ref.anchor.locator === evidenceRef.anchor.locator
          ? evidence
          : null,
    verifyAnchorReceipt: () => ({ disposition: "valid" }),
  };
  return {
    buyerStatus,
    sellerStatus,
    buyerNative,
    sellerNative,
    buyerBundle,
    sellerBundle,
    deps,
    input: {
      buyer: buyerStatus,
      seller: sellerStatus,
      mapping: "pure" as const,
      copies: {
        buyer: {
          role: "buyer" as const,
          nativeAddress: buyerNative,
          bundle: buyerBundle,
          anchorReceipt: receipt(
            bundleAddress(JOB_ID, "buyer"),
            buyerNative,
            attestationBundleHash(buyerBundle),
            BUYER.did,
          ),
        },
        seller: {
          role: "seller" as const,
          nativeAddress: sellerNative,
          bundle: sellerBundle,
          anchorReceipt: receipt(
            bundleAddress(JOB_ID, "seller"),
            sellerNative,
            attestationBundleHash(sellerBundle),
            SELLER.did,
          ),
        },
      },
    },
  };
}

describe("fixed-price x402 DACS-5 ST-11 completion gate", () => {
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
  });

  it("rejects opaque audit references and missing finalized dependency receipts", async () => {
    const fx = await fixture();
    const opaque = structuredClone(fx.input);
    (opaque.buyer.tracks.audit as { reference: string }).reference = "opaque-callback-string";
    await expect(verifyFixedPriceX402AuditCompletion(opaque, fx.deps))
      .rejects.toThrow(/exact bundle/);

    await expect(verifyFixedPriceX402AuditCompletion(fx.input, {
      ...fx.deps,
      resolveFinalizedDependencyReceipt: () => null,
    })).rejects.toThrow(/no finalized receipt/);

    await expect(verifyFixedPriceX402AuditCompletion(fx.input, {
      ...fx.deps,
      readFinalizedDependencyArtifact: () => null,
    })).rejects.toThrow(/not readable at its finalized native address/);

    await expect(verifyFixedPriceX402AuditCompletion(fx.input, {
      ...fx.deps,
      resolveFinalizedDependencyReceipt: (ref) => receipt(
        ref.anchor.locator,
        `native:${ref.anchor.locator}`,
        ref.contentHash,
        "did:example:unauthorized-writer",
      ),
    })).rejects.toThrow(/unauthorized writer/);
  });

  it("rejects a recursively unresolved copy even when its local signatures are valid", async () => {
    const fx = await fixture();
    await expect(verifyFixedPriceX402AuditCompletion(fx.input, {
      ...fx.deps,
      verifyBundle: {
        ...fx.deps.verifyBundle,
        resolveAttestationRef: async () => null,
      },
    })).rejects.toThrow(/full recursive verification/);
  });

  it("requires authenticated BB-1 publication for write-input mappings", async () => {
    const fx = await fixture();
    const writeInput = {
      ...fx.input,
      mapping: "write-input" as const,
      copies: {
        buyer: {
          ...fx.input.copies.buyer,
          binding: binding(fx.buyerBundle, "buyer", fx.buyerNative),
        },
        seller: {
          ...fx.input.copies.seller,
          binding: binding(fx.sellerBundle, "seller", fx.sellerNative),
        },
      },
    };
    await expect(verifyFixedPriceX402AuditCompletion(writeInput, fx.deps))
      .rejects.toThrow(/requires a BundleBinding verifier/);
    await expect(verifyFixedPriceX402AuditCompletion(writeInput, {
      ...fx.deps,
      verifyBundleBinding: () => ({ disposition: "valid" }),
    })).resolves.toMatchObject({ milestone: "audit-complete" });

    await expect(verifyFixedPriceX402AuditCompletion({
      ...writeInput,
      mapping: "pure",
    }, {
      ...fx.deps,
      verifyBundleBinding: () => ({ disposition: "valid" }),
    })).rejects.toThrow(/pure .* mapping must not carry/);
  });

  it("rejects a bundle roster that contradicts the pinned orchestrator topology", async () => {
    const fx = await fixture();
    const input = structuredClone(fx.input);
    input.copies.buyer.bundle.parties.push({
      role: "orchestrator",
      bundleHash: h("f"),
      primaryClaim: "did:example:other-orchestrator",
    });
    await expect(verifyFixedPriceX402AuditCompletion(input, fx.deps))
      .rejects.toThrow(/seller-as-orchestrator topology/);
  });
});
