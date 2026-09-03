import { describe, expect, it, vi } from "vitest";

import {
  ARTIFACT_SEPARATORS,
  contentHash,
  createIdempotencyStore,
  createUcpDacsMerchantAttestor,
  createUcpMerchantIdentityBinding,
  dacsUcpIdempotencyKey,
  deriveUcpRfqAgreement,
  ed25519Sign,
  ed25519Verify,
  parseUcpBusinessProfile,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  rawPublicKey,
  RAIL_REGISTRY_INDEX_ADDRESS,
  resolveRail,
  runUcpX402Mvp,
  settlementKey,
  signComponentArtifact,
  signFixedPriceAgreement,
  signedBytes,
  UCP_MVP_VERSION,
  UCP_CHECKOUT_BINDING_SEPARATOR,
  UCP_IDENTITY_BINDING_SEPARATOR,
  UCP_ORDER_EVIDENCE_SEPARATOR,
  DACS_UCP_X402_HANDLER,
  type AttestationRef,
  type AuthenticatedRailDefinition,
  type BuildComponentSignatureOptions,
  type CommitmentSignatureVerifier,
  type IdentityBundle,
  type Listing,
  type PaymentRailRef,
  type RailDefinition,
  type RailRegistryDefinitionRef,
  type RailRegistryIndexDocument,
  type RailRegistrySelectionProvider,
  type SettleResult,
  type UcpBusinessProfileSnapshot,
  type UcpCheckout,
  type UcpCompositionSignatureVerifier,
  type UcpOrder,
  type UcpRestClient,
  type UcpRfqAgreementInput,
  type UcpX402MvpDeps,
} from "../../src/index.js";
import type { AnchorReceipt } from "../../src/artifacts/types.js";

const NOW = 1_788_000_000_000;
const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7F";
const BUYER_SEED = Uint8Array.from(Buffer.alloc(32, 41));
const SELLER_SEED = Uint8Array.from(Buffer.alloc(32, 42));
const STEWARD_SEED = Uint8Array.from(Buffer.alloc(32, 43));
const HASH = "a".repeat(64);
const TX_HASH = `0x${"b".repeat(64)}`;
const RECEIPT_HASH = "c".repeat(64);
const TOKEN = `0x${"1".repeat(40)}` as const;
const PAY_TO = `0x${"2".repeat(40)}` as const;

const claim = (seed: Uint8Array) =>
  `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
const BUYER = claim(BUYER_SEED);
const SELLER = claim(SELLER_SEED);
const STEWARD = claim(STEWARD_SEED);

function componentSigner(
  party: string,
  seed: Uint8Array,
): BuildComponentSignatureOptions {
  const key = privateKeyFromSeed(seed);
  return {
    algorithm: "ed25519",
    signer: party,
    sign: (bytes) => ed25519Sign(bytes, key),
  };
}

const buyerSigner = componentSigner(BUYER, BUYER_SEED);
const sellerSigner = componentSigner(SELLER, SELLER_SEED);
const publicKeys = new Map([
  [BUYER, publicKeyFromSeed(BUYER_SEED)],
  [SELLER, publicKeyFromSeed(SELLER_SEED)],
]);

const verifyBytes = (signer: string, bytes: Uint8Array, value: string): boolean => {
  const key = publicKeys.get(signer);
  return key ? ed25519Verify(bytes, Buffer.from(value, "base64url"), key) : false;
};

const verifyAgreementSignature: CommitmentSignatureVerifier = (input) =>
  verifyBytes(input.signer, input.signedBytes, input.value) ? "valid" : "invalid";
const verifyCompositionSignature: UcpCompositionSignatureVerifier = (input) =>
  verifyBytes(input.signer, input.signedBytes, input.value) ? "valid" : "invalid";

function identity(primaryClaim: string): IdentityBundle {
  return {
    bundleVersion: "1",
    presentedBy: primaryClaim,
    presentedAt: NOW - 10_000,
    claims: [{ ref: primaryClaim }],
    presentation: {
      kind: "per-claim",
      signatures: [{ ref: primaryClaim, signature: "identity-proof" }],
    },
  };
}

function vetRef(locator: string): AttestationRef {
  return { anchor: { kind: "storage-program", locator }, contentHash: HASH };
}

const rail: PaymentRailRef = {
  railId: "x402:default",
  railVersion: 2,
  parameters: { network: "eip155:84532" },
};

function railReceipt(
  ref: RailRegistryDefinitionRef,
  logicalAddress: string,
): AnchorReceipt {
  return {
    receiptVersion: "1",
    substrate: "test-substrate",
    finalityProfile: "instant-finality",
    logicalAddress,
    nativeAddress: ref.anchor.locator,
    contentHash: ref.contentHash,
    transactionRef: { kind: "test", value: `tx:${ref.contentHash}` },
    writer: STEWARD,
    state: "finalized",
    observationDisposition: "established",
    observedAt: NOW,
    blockRef: { id: "block:1", height: "1" },
    evidence: { kind: "test-proof", value: `proof:${ref.contentHash}` },
  };
}

async function resolveTestX402Rail(
  asset = TOKEN,
): Promise<AuthenticatedRailDefinition> {
  const definition = await signComponentArtifact({
    railVersion: rail.railVersion!,
    railId: rail.railId,
    railType: "x402",
    asset: {
      kind: "erc20",
      chainId: 84532,
      contract: asset,
      symbol: "USDC",
      decimals: 6,
    },
    network: {
      kind: "x402-resource",
      resourceBaseUrl: "https://merchant.example/pay",
    },
    phaseHandler: "pay-x402",
    parameters: { authorization: "eip-3009", finalityBlocks: 2 },
    availability: "live",
    governance: {
      proposedBy: STEWARD,
      acceptedAt: NOW - 60_000,
      anchoring: "single-signer",
    },
  } satisfies Omit<RailDefinition, "signature">, "dacs-rail:v1:", {
    algorithm: "ed25519",
    signer: STEWARD,
    sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(STEWARD_SEED)),
  });
  const definitionRef: RailRegistryDefinitionRef = {
    logicalAddress: "dacs4:rail:x402-default:2",
    anchor: { kind: "storage-program", locator: "rail:x402-default:2" },
    contentHash: contentHash(definition as unknown as Record<string, unknown>),
  };
  const index: RailRegistryIndexDocument = {
    registryId: RAIL_REGISTRY_INDEX_ADDRESS,
    entries: [definitionRef],
  };
  const indexRef: RailRegistryDefinitionRef = {
    logicalAddress: RAIL_REGISTRY_INDEX_ADDRESS,
    anchor: { kind: "storage-program", locator: "rail:index:current" },
    contentHash: contentHash(index as unknown as Record<string, unknown>),
  };
  const documents = new Map<string, Record<string, unknown>>([
    [definitionRef.anchor.locator, definition as unknown as Record<string, unknown>],
    [indexRef.anchor.locator, index as unknown as Record<string, unknown>],
  ]);
  const provider: RailRegistrySelectionProvider = {
    resolveCurrentIndex: async () => ({
      registryVersion: 1,
      indexRef,
      receipt: railReceipt(indexRef, RAIL_REGISTRY_INDEX_ADDRESS),
    }),
    authenticateCurrentIndex: () => "valid",
    readAnchoredJson: async (ref) => documents.get(ref.anchor.locator) ?? null,
    resolveDefinitionReceipt: async () => railReceipt(
      definitionRef,
      definitionRef.logicalAddress,
    ),
    authenticateDefinition: () => "valid",
    stewardWriter: STEWARD,
    stewardPublicKey: rawPublicKey(publicKeyFromSeed(STEWARD_SEED)),
    stewardSigner: STEWARD,
    verify: (bytes, signature, publicKey) =>
      ed25519Verify(bytes, signature, publicKeyFromRaw(publicKey)),
  };
  return resolveRail(RAIL_REGISTRY_INDEX_ADDRESS, {
    railId: rail.railId,
    railVersion: rail.railVersion,
  }, provider);
}

function listing(): Listing {
  return {
    dacsVersion: "1",
    listingVersion: 3,
    listingId: "ucp-negotiated-widget",
    seller: {
      identity: identity(SELLER),
      displayName: "DACS UCP Merchant",
      publicEndpoint: "https://merchant.example/dacs",
    },
    offering: {
      title: "Negotiated Widget",
      description: "A UCP item sold under a DACS RFQ",
      category: "physical.widget",
      tags: ["ucp", "widget"],
      deliverable: {
        kind: "attested-payload",
        payloadFormat: "application/json",
        verificationMethod: { kind: "self-signed" },
      },
    },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [
      { kind: "negotiate-rfq", parameters: { maxTurns: 4, timeoutSec: 300 } },
      { kind: "commit-agreement" },
      { kind: "pay-x402", parameters: { rail: rail.railId } },
      { kind: "deliver-attested-payload" },
    ],
    pricing: {
      kind: "negotiable",
      bandCenter: { amount: "1.25", currency: "USDC" },
      minPct: 20,
      maxPct: 20,
    },
    acceptedRails: [rail],
    terms: { deadlineSecAfterCommit: 900 },
    validity: { notBefore: NOW - 60_000, notAfter: NOW + 3_600_000 },
    signature: {
      algorithm: "ed25519",
      signer: SELLER,
      value: Buffer.alloc(64, 9).toString("base64url"),
    },
  };
}

function business(): Readonly<UcpBusinessProfileSnapshot> {
  const publicX = Buffer.from(rawPublicKey(publicKeyFromSeed(SELLER_SEED)))
    .toString("base64url");
  return parseUcpBusinessProfile("https://merchant.example/.well-known/ucp", {
    ucp: {
      version: UCP_MVP_VERSION,
      services: {
        "dev.ucp.shopping": [{
          version: UCP_MVP_VERSION,
          transport: "rest",
          endpoint: "https://merchant.example/ucp",
        }],
      },
      capabilities: {
        "dev.ucp.shopping.checkout": [{ version: UCP_MVP_VERSION }],
      },
      payment_handlers: {
        [DACS_UCP_X402_HANDLER]: [{
          id: "merchant-x402-base-sepolia",
          version: UCP_MVP_VERSION,
          config: {
            railId: rail.railId,
            network: "eip155:84532",
            checkoutCurrency: "USD",
            checkoutCurrencyDecimals: 2,
            assetAmountPerCheckoutUnit: "1",
            asset: TOKEN,
            assetSymbol: "USDC",
            assetDecimals: 6,
            payTo: PAY_TO,
            resource: "https://merchant.example/pay/widget",
            finalityBlocks: 2,
          },
        }],
      },
    },
    keys: [{ kid: "dacs-merchant-2026", kty: "OKP", crv: "Ed25519", x: publicX }],
  });
}

function derivation(profile: Readonly<UcpBusinessProfileSnapshot>): UcpRfqAgreementInput {
  const value = listing();
  return {
    jobId: JOB_ID,
    verifiedListing: {
      disposition: "verified",
      listing: value,
      pin: {
        listingId: value.listingId,
        version: value.listingVersion,
        contentHash: contentHash(value as unknown as Record<string, unknown>),
      },
    },
    buyer: { identityBundle: identity(BUYER), vetRecordRef: vetRef("stor:buyer-vet") },
    seller: { identityBundle: identity(SELLER), vetRecordRef: vetRef("stor:seller-vet") },
    selectedRail: rail,
    agreedPrice: { amount: "1.1", currency: "USDC" },
    channel: { subnet: "dacs-rfq-private-01", lastMessageHash: "d".repeat(64), turnCount: 3 },
    business: profile,
    generatedAt: NOW,
  };
}

function checkout(profile: Readonly<UcpBusinessProfileSnapshot>): UcpCheckout {
  return {
    ucp: {
      version: UCP_MVP_VERSION,
      payment_handlers: {
        [DACS_UCP_X402_HANDLER]: [{
          id: profile.x402.id,
          version: profile.x402.version,
          config: profile.x402.config,
        }],
      },
    },
    id: "checkout-1",
    line_items: [{
      id: "line-1",
      item: { id: "widget-1", title: "Negotiated Widget", price: 110 },
      quantity: 1,
      totals: [
        { type: "subtotal", amount: 110 },
        { type: "total", amount: 110 },
      ],
    }],
    status: "ready_for_complete",
    currency: "USD",
    totals: [
      { type: "subtotal", amount: 110 },
      { type: "total", amount: 110 },
    ],
    links: [],
    expires_at: new Date(NOW + 600_000).toISOString(),
  };
}

function order(ready: UcpCheckout): UcpOrder {
  return {
    ucp: { version: UCP_MVP_VERSION },
    id: "order-1",
    checkout_id: ready.id,
    permalink_url: "https://merchant.example/orders/order-1",
    line_items: ready.line_items,
    fulfillment: { events: [{ type: "processing", occurred_at: new Date(NOW).toISOString() }] },
    currency: ready.currency,
    totals: ready.totals,
  };
}

function settlement(): SettleResult {
  return {
    ok: true,
    txHash: TX_HASH,
    chainId: "eip155:84532",
    payer: `0x${"3".repeat(40)}`,
    payee: PAY_TO,
    finality: { model: "block-depth", finalityBlocks: 2 },
    finalityObservedAt: NOW + 2_000,
    txRef: {
      kind: "x402-event",
      httpResource: "https://merchant.example/pay/widget",
      paymentReceiptHash: RECEIPT_HASH,
      settlementTxHash: TX_HASH.slice(2),
      chainId: 84532,
      logIndex: 0,
      protocolVersion: "2",
    },
  };
}

async function fixture(overrides: {
  mutateCheckout?: (value: UcpCheckout) => void;
  mutateCompleted?: (value: UcpCheckout) => void;
} = {}) {
  const profile = business();
  const agreementInput = derivation(profile);
  const draft = deriveUcpRfqAgreement(agreementInput);
  const agreement = await signFixedPriceAgreement(
    draft,
    {
      party: BUYER,
      algorithm: "ed25519",
      sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(BUYER_SEED)),
    },
    {
      party: SELLER,
      algorithm: "ed25519",
      sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(SELLER_SEED)),
    },
  );
  const identityBinding = await createUcpMerchantIdentityBinding({
    merchantClaim: SELLER,
    business: profile,
    issuedAt: NOW - 1_000,
    expiresAt: NOW + 3_600_000,
    signer: sellerSigner,
  });
  const ready = checkout(profile);
  overrides.mutateCheckout?.(ready);
  const completed = structuredClone(ready);
  completed.status = "completed";
  completed.order = { id: "order-1", permalink_url: "https://merchant.example/orders/order-1" };
  overrides.mutateCompleted?.(completed);
  const merchantOrder = order(completed);
  const createCheckout = vi.fn(async (
    _request: Parameters<UcpRestClient["createCheckout"]>[0],
    _key: string,
  ) => ready);
  const completeCheckout = vi.fn(async (
    _id: string,
    _request: Parameters<UcpRestClient["completeCheckout"]>[1],
    _key: string,
  ) => completed);
  const getOrder = vi.fn(async (_id: string) => merchantOrder);
  const ucp: UcpRestClient = {
    createCheckout,
    getCheckout: vi.fn(async () => completed),
    completeCheckout,
    getOrder,
  };
  let submits = 0;
  const idem = createIdempotencyStore();
  const settled = settlement();
  const settle = (request: Parameters<UcpX402MvpDeps["settle"]>[0]) =>
    idem.once(settlementKey(request.rail, request.jobId, request.phaseIndex ?? 0), async () => {
      submits += 1;
      return settled;
    });
  const deps: UcpX402MvpDeps = {
    ucp,
    settle,
    merchantAttestor: createUcpDacsMerchantAttestor({ merchantSigner: sellerSigner }),
    authorizeCompletion: async () => ({ approved: true, mechanism: "trusted-ui" }),
    verifyAgreementSignature,
    verifyCompositionSignature,
  };
  return {
    input: {
      agreement,
      derivation: agreementInput,
      business: profile,
      identityBinding,
      authenticatedRail: await resolveTestX402Rail(),
      lineItems: [{ item: { id: "widget-1" }, quantity: 1 }],
      paymentPhaseOrchestrator: BUYER,
      nowMs: () => NOW + 1_000,
      paymentEvidenceSigner: buyerSigner,
    },
    deps,
    spies: { createCheckout, completeCheckout, getOrder },
    submits: () => submits,
  };
}

describe("experimental DACS + UCP + x402 composition", () => {
  it("binds RFQ price, merchant identity, checkout, x402 finality and hash-only order evidence", async () => {
    const f = await fixture();
    const result = await runUcpX402Mvp(f.input, f.deps);

    expect(result.checkoutBinding.payment).toMatchObject({
      amount: "1100000",
      checkoutAmount: "110",
      checkoutCurrency: "USD",
      network: "eip155:84532",
      payTo: PAY_TO,
      phaseIndex: 2,
    });
    expect(result.paymentEvidence).toMatchObject({
      phase: "pay-x402",
      outcome: "success",
      paymentAmount: { amount: "1.1", currency: "USDC" },
      settlementFinality: { model: "block-depth", finalityBlocks: 2 },
    });
    expect(result.orderEvidence).toMatchObject({
      checkoutId: "checkout-1",
      orderId: "order-1",
      orderPermalink: "https://merchant.example/orders/order-1",
    });
    expect(JSON.stringify(result.orderEvidence)).not.toContain("Negotiated Widget");
    expect(f.spies.completeCheckout).toHaveBeenCalledOnce();
    expect(f.submits()).toBe(1);

    await runUcpX402Mvp(f.input, f.deps);
    expect(f.submits()).toBe(1);
    const agreementHash = contentHash(f.input.agreement as unknown as Record<string, unknown>);
    expect(f.spies.createCheckout).toHaveBeenCalledWith(
      { line_items: [{ item: { id: "widget-1" }, quantity: 1 }] },
      dacsUcpIdempotencyKey({
        jobId: JOB_ID,
        agreementHash,
        operation: "create-checkout",
      }),
    );
  });

  it("rejects merchant price inflation before settlement", async () => {
    const f = await fixture({ mutateCheckout: (value) => {
      value.totals.find((row) => row.type === "total")!.amount += 1;
    } });
    await expect(runUcpX402Mvp(f.input, f.deps)).rejects.toThrow(
      /Checkout total differs from the signed DACS agreement/,
    );
    expect(f.submits()).toBe(0);
    expect(f.spies.completeCheckout).not.toHaveBeenCalled();
  });

  it("rejects handler token coordinates that differ from the authenticated rail", async () => {
    const f = await fixture();
    f.input.authenticatedRail = await resolveTestX402Rail(
      `0x${"9".repeat(40)}` as `0x${string}`,
    );
    await expect(runUcpX402Mvp(f.input, f.deps)).rejects.toThrow(
      /coordinates differ from the authenticated DACS rail/,
    );
    expect(f.submits()).toBe(0);
    expect(f.spies.createCheckout).not.toHaveBeenCalled();
  });

  it("does not move funds when UCP completion is not authorised", async () => {
    const f = await fixture();
    f.deps.authorizeCompletion = async () => ({ approved: false, reason: "buyer declined" });
    await expect(runUcpX402Mvp(f.input, f.deps)).rejects.toThrow(/buyer declined/);
    expect(f.submits()).toBe(0);
    expect(f.spies.completeCheckout).not.toHaveBeenCalled();
  });

  it("rejects a payment-evidence signer that is not the authenticated phase orchestrator", async () => {
    const f = await fixture();
    f.input.paymentPhaseOrchestrator = SELLER;
    await expect(runUcpX402Mvp(f.input, f.deps)).rejects.toThrow(
      /payment evidence signer must be the authenticated phase orchestrator/,
    );
    expect(f.submits()).toBe(0);
    expect(f.spies.createCheckout).not.toHaveBeenCalled();
  });

  it("rejects injected items before settlement", async () => {
    const f = await fixture({ mutateCheckout: (value) => {
      value.line_items.push({
        id: "line-injected",
        item: { id: "surprise-1", title: "Surprise", price: 0 },
        quantity: 1,
        totals: [{ type: "subtotal", amount: 0 }, { type: "total", amount: 0 }],
      });
    } });
    await expect(runUcpX402Mvp(f.input, f.deps)).rejects.toThrow(/changed or injected/);
    expect(f.submits()).toBe(0);
  });

  it("rejects a settlement with the wrong recipient or finality before checkout completion", async () => {
    const f = await fixture();
    f.deps.settle = async () => ({
      ...settlement(),
      payee: `0x${"4".repeat(40)}`,
      finality: { model: "block-depth", finalityBlocks: 1 },
    });
    await expect(runUcpX402Mvp(f.input, f.deps)).rejects.toThrow(
      /settlement result differs from the signed checkout binding/,
    );
    expect(f.spies.completeCheckout).not.toHaveBeenCalled();
  });

  it("retries UCP bookkeeping after payment without settling twice", async () => {
    const f = await fixture();
    const complete = f.deps.ucp.completeCheckout.bind(f.deps.ucp);
    let completionAttempts = 0;
    f.deps.ucp.completeCheckout = async (
      ...args: Parameters<UcpRestClient["completeCheckout"]>
    ) => {
      completionAttempts += 1;
      if (completionAttempts === 1) throw new Error("temporary merchant outage");
      return complete(...args);
    };
    await expect(runUcpX402Mvp(f.input, f.deps)).rejects.toThrow(/temporary merchant outage/);
    expect(f.submits()).toBe(1);
    const recovered = await runUcpX402Mvp(f.input, f.deps);
    expect(recovered.completedCheckout.status).toBe("completed");
    expect(f.submits()).toBe(1);
  });

  it("detects post-payment mutation of the completed checkout", async () => {
    const f = await fixture({
      mutateCompleted: (value) => {
        value.totals.find((row) => row.type === "total")!.amount += 1;
      },
    });
    await expect(runUcpX402Mvp(f.input, f.deps)).rejects.toThrow(
      /changed payment-bound commerce terms/,
    );
    expect(f.submits()).toBe(1);
  });

  it("rechecks the DACS agreement deadline after completion approval and before payment", async () => {
    const f = await fixture();
    let clockReads = 0;
    f.input.nowMs = () => {
      clockReads += 1;
      return clockReads === 1 ? NOW + 1_000 : NOW + 901_000;
    };
    await expect(runUcpX402Mvp(f.input, f.deps)).rejects.toThrow(
      /deadline passed before x402 settlement/,
    );
    expect(f.submits()).toBe(0);
  });

  it("rejects a valid signature under the wrong extension domain", async () => {
    const f = await fixture();
    const mutated = structuredClone(f.input.identityBinding);
    const unsigned = { ...mutated } as Record<string, unknown>;
    delete unsigned.signature;
    mutated.signature.value = Buffer.from(ed25519Sign(
      signedBytes(UCP_CHECKOUT_BINDING_SEPARATOR, contentHash(unsigned)),
      privateKeyFromSeed(SELLER_SEED),
    )).toString("base64url");
    await expect(runUcpX402Mvp({ ...f.input, identityBinding: mutated }, f.deps))
      .rejects.toThrow(/identity-binding signature is invalid/);
  });

  it("uses three disjoint experimental signature domains", () => {
    expect(new Set([
      UCP_IDENTITY_BINDING_SEPARATOR,
      UCP_CHECKOUT_BINDING_SEPARATOR,
      UCP_ORDER_EVIDENCE_SEPARATOR,
    ]).size).toBe(3);
    expect(UCP_IDENTITY_BINDING_SEPARATOR).toMatch(/^dacs-x-/);
    expect(ARTIFACT_SEPARATORS.SettlementEvidence).not.toBe(UCP_ORDER_EVIDENCE_SEPARATOR);
  });

  it("rejects an out-of-band negotiated price", () => {
    const profile = business();
    expect(() => deriveUcpRfqAgreement({
      ...derivation(profile),
      agreedPrice: { amount: "0.99", currency: "USDC" },
    })).toThrow(/outside the inclusive 1..1.5 band/);
  });
});
