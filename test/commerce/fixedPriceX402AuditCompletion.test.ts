import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

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
  fixedPriceX402OrderBindingHash,
  fixedPriceX402OrderLocalBindingHash,
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

type MutableProtocol = Omit<FixedPriceX402ProtocolBinding, "rail"> & {
  rail: {
    -readonly [Key in keyof FixedPriceX402ProtocolBinding["rail"]]:
      FixedPriceX402ProtocolBinding["rail"][Key];
  };
};

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
      chainId: 8453,
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
  const deps: FixedPriceX402AuditCompletionDeps = {
    sellerFinalizationProvider,
    resolveAuthenticatedSellerClosureProtocol: () => ({
      disposition: "valid",
      protocol: PROTOCOL,
    }),
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

  it.each([
    ["network", (protocol: MutableProtocol) => {
      protocol.rail.network = "eip155:84532";
    }],
    ["registry index hash", (protocol: MutableProtocol) => {
      protocol.rail.registryIndexHash = h("8");
    }],
    ["rail definition ref", (protocol: MutableProtocol) => {
      protocol.rail.railDefinitionRef = "dacs4:rail:x402%3Aother:2";
    }],
    ["rail definition hash", (protocol: MutableProtocol) => {
      protocol.rail.railDefinitionHash = h("9");
    }],
    ["rail version", (protocol: MutableProtocol) => {
      protocol.rail.railVersion = 3;
    }],
  ] as const)(
    "rejects a consistently repinned coordinator %s when the authenticated closure is unchanged",
    async (_label, mutate) => {
      const fx = await fixture();
      const input = structuredClone(fx.input);
      const protocol = structuredClone(PROTOCOL) as MutableProtocol;
      mutate(protocol);
      const bindingHash = fixedPriceX402OrderBindingHash({
        jobId: JOB_ID,
        buyer: BUYER.did,
        seller: SELLER.did,
        protocol,
      });
      for (const status of [input.buyer, input.seller]) {
        status.protocol = structuredClone(protocol);
        status.bindingHash = bindingHash;
        status.localBindingHash = fixedPriceX402OrderLocalBindingHash({
          jobId: status.jobId,
          buyer: status.buyer,
          seller: status.seller,
          protocol,
          sdkJobs: status.sdkJobs,
        });
      }

      await expect(verifyFixedPriceX402AuditCompletion(input, fx.deps))
        .rejects.toThrow(/authenticated seller closure protocol contradicts/);
    },
  );

  it.each(["invalid", "indeterminate", "error"] as const)(
    "fails closed when authenticated closure protocol resolution is %s",
    async (disposition) => {
      const fx = await fixture();
      await expect(verifyFixedPriceX402AuditCompletion(fx.input, {
        ...fx.deps,
        resolveAuthenticatedSellerClosureProtocol: () => ({
          disposition,
          reason: "authenticated closure provenance could not establish the protocol",
        }),
      })).rejects.toThrow(new RegExp(`closure protocol is ${disposition}`));
    },
  );

  it("fails closed on an unsupported authenticated closure protocol disposition", async () => {
    const fx = await fixture();
    await expect(verifyFixedPriceX402AuditCompletion(fx.input, {
      ...fx.deps,
      resolveAuthenticatedSellerClosureProtocol: () => ({
        disposition: "unsupported",
      }) as never,
    })).rejects.toThrow(/protocol resolver returned a malformed disposition/);
  });

  it("rejects opaque audit references, missing readback, and a forged receipt writer", async () => {
    const fx = await fixture();
    const opaque = structuredClone(fx.input);
    (opaque.buyer.tracks.audit as { reference: string }).reference = "opaque-callback-string";
    await expect(verifyFixedPriceX402AuditCompletion(opaque, fx.deps))
      .rejects.toThrow(/exact bundle/);

    await expect(verifyFixedPriceX402AuditCompletion(fx.input, {
      ...fx.deps,
      readBundleCopy: () => null,
    })).rejects.toThrow(/not independently readable/);

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
