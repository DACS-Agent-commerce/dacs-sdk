import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { IdentityBundle, Listing, PaymentRailRef } from "../../src/artifacts/index.js";
import { isListing } from "../../src/artifacts/validators.js";
import { canonicalize, contentHash, sha256Hex } from "../../src/canonical/index.js";
import { identityBundleHash } from "../../src/identity/index.js";
import {
  canonicalSellerSettlementId,
  createInMemorySellerReceiptStore,
  verifySellerPaymentIntake,
  x402Eip3009Nonce,
  type CommittedAgreementResolution,
  type DemosTransferObservation,
  type SellerPaymentIntakeDeps,
  type SellerPaymentIntakeInput,
  type SellerListingAtCommitResolution,
  type SellerPaymentEvidenceInput,
  type SellerReceiptClaim,
  type SellerReceiptStore,
  type SellerSupportedRailDefinition,
  type X402TransferObservation,
} from "../../src/seller/index.js";

const BUYER_DEMOS = `did:demos:agent:${"aa".repeat(32)}`;
const SELLER_DEMOS = `did:demos:agent:${"bb".repeat(32)}`;
const BUYER = "did:example:buyer";
const SELLER = "did:example:seller";
const PAYER = `0x${"11".repeat(20)}`;
const PAYEE = `0x${"22".repeat(20)}`;
const DEMOS_TX = `0x${"ab".repeat(32)}`;
const EVM_TX = `0x${"cd".repeat(32)}`;
const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const PAYMENT_PHASE_INDEX = 2;
const AGREEMENT_SIGNATURE = Buffer.alloc(64, 7).toString("base64url");

function identity(primary: string, extraClaim?: string): IdentityBundle {
  const refs = extraClaim ? [primary, extraClaim] : [primary];
  return {
    bundleVersion: "1",
    presentedBy: primary,
    presentedAt: 100,
    claims: refs.map((ref) => ({ ref })),
    presentation: {
      kind: "per-claim",
      signatures: refs.map((ref) => ({ ref, signature: "c2ln" })),
    },
  };
}

type Context = {
  input: SellerPaymentIntakeInput;
  agreement: Record<string, unknown>;
  committed: Extract<CommittedAgreementResolution, { disposition: "verified" }>;
  listing: Listing;
  rail: SellerSupportedRailDefinition;
  buyerBundle: IdentityBundle;
  sellerBundle: IdentityBundle;
  demosObservation: DemosTransferObservation;
  x402Observation: X402TransferObservation;
  deps: SellerPaymentIntakeDeps;
};

function listingAtCommitResolution(
  listing: Listing,
  admittedAt = 900,
): SellerListingAtCommitResolution {
  const listingRef = {
    listingId: listing.listingId,
    version: listing.listingVersion,
    contentHash: contentHash(listing as unknown as Record<string, unknown>),
  };
  const dpaSelected = listing.pipeline.some(
    (phase) => phase.kind === "deliver-attested-payload",
  );
  if (!dpaSelected) {
    return {
      rawListing: listing as unknown as Record<string, unknown>,
      validation: {
        disposition: "verified",
        step: 9,
        reason: "verified",
        listing,
        listingContentHash: listingRef.contentHash,
        revocation: "absent",
        railResolution: { disposition: "verified", reason: "verified" },
      },
    };
  }
  const deliverable = listing.offering.deliverable;
  if (deliverable.kind !== "attested-payload" || !deliverable.verificationMethod) {
    throw new Error("DPA fixture requires an attested-payload verification method");
  }
  const verificationMethodHash = sha256Hex(
    canonicalize(deliverable.verificationMethod),
  );
  const deliverableSpecHash = sha256Hex(canonicalize(deliverable));
  return {
    rawListing: listing as unknown as Record<string, unknown>,
    validation: {
      disposition: "verified",
      step: 9,
      reason: "verified",
      listing,
      listingContentHash: listingRef.contentHash,
      revocation: "absent",
      railResolution: { disposition: "verified", reason: "verified" },
      payloadVerificationCapability: {
        operation: "verify",
        disposition: "supported",
        reason: "supported",
        verificationMethodKind: deliverable.verificationMethod.kind,
        verificationMethodHash,
        deliverableSpecHash,
      },
    },
    payloadVerificationProducerAdmission: {
      operation: "produce",
      disposition: "supported",
      listingRef,
      verificationMethodKind: deliverable.verificationMethod.kind,
      verificationMethodHash,
      deliverableSpecHash,
      admittedAt,
    },
  };
}

function makeContext(
  kind: "pay-dem" | "pay-x402",
  store: SellerReceiptStore = createInMemorySellerReceiptStore(),
): Context {
  const isDemos = kind === "pay-dem";
  const buyerBundle = identity(
    isDemos ? BUYER_DEMOS : BUYER,
    isDemos ? undefined : `cci-xm:evm:base:${PAYER}`,
  );
  const sellerBundle = identity(isDemos ? SELLER_DEMOS : SELLER);
  const railRef: PaymentRailRef = isDemos
    ? { railId: "demos-native:DEM", railVersion: 1 }
    : {
        railId: "x402:default",
        railVersion: 1,
        parameters: { httpResource: "https://seller.example/pay/order" },
      };
  const rail: SellerSupportedRailDefinition = isDemos
    ? {
        railVersion: 1,
        railId: railRef.railId,
        railType: "demos-native",
        asset: { kind: "native-dem", symbol: "DEM", decimals: 9 },
        network: { kind: "demos" },
        phaseHandler: "pay-dem",
        parameters: {},
        availability: "live",
      }
    : {
        railVersion: 1,
        railId: railRef.railId,
        railType: "x402",
        asset: {
          kind: "erc20",
          chainId: 84532,
          contract: `0x${"33".repeat(20)}`,
          symbol: "USDC",
          decimals: 6,
        },
        network: {
          kind: "x402-resource",
          resourceBaseUrl: "https://seller.example/pay",
        },
        phaseHandler: "pay-x402",
        parameters: { finalityBlocks: 3 },
        availability: "live",
      };
  const listing: Listing = {
    dacsVersion: "1",
    listingVersion: 4,
    listingId: "listing-atomic-delivery",
    seller: {
      identity: sellerBundle,
      displayName: "Seller",
      publicEndpoint: "https://seller.example/engage",
    },
    offering: {
      title: "Atomic delivery",
      description: "One verified deliverable",
      category: "software",
      tags: ["test"],
      deliverable: {
        kind: "attested-payload",
        payloadFormat: "application/json",
        verificationMethod: { kind: "self-signed" },
      },
    },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [
      { kind: "negotiate-fixed-price" },
      { kind: "commit-payee-bound-agreement" },
      { kind, parameters: { rail: railRef.railId } },
      { kind: "deliver-attested-payload" },
    ],
    pricing: {
      kind: "fixed",
      price: { amount: isDemos ? "1.25" : "2.5", currency: isDemos ? "DEM" : "USDC" },
    },
    acceptedRails: [railRef],
    terms: { deadlineSecAfterCommit: 9 },
    validity: { notBefore: 0, notAfter: 20_000 },
    signature: { algorithm: "ed25519", signer: sellerBundle.presentedBy, value: "c2ln" },
  };
  if (!isListing(listing)) throw new Error("payment fixture must be a normative Listing");
  const listingRef = {
    listingId: listing.listingId,
    version: listing.listingVersion,
    contentHash: contentHash(listing as unknown as Record<string, unknown>),
  };
  const agreement: Record<string, unknown> = {
    payeeBoundAgreementVersion: "1",
    jobId: JOB_ID,
    listingRef,
    parties: [
      {
        role: "buyer",
        bundleHash: identityBundleHash(buyerBundle),
        primaryClaim: buyerBundle.presentedBy,
        vetRecordRef: {
          anchor: { kind: "storage-program", locator: "buyer-vet" },
          contentHash: "01".repeat(32),
        },
      },
      {
        role: "seller",
        bundleHash: identityBundleHash(sellerBundle),
        primaryClaim: sellerBundle.presentedBy,
        vetRecordRef: {
          anchor: { kind: "storage-program", locator: "seller-vet" },
          contentHash: "02".repeat(32),
        },
      },
    ],
    terms: {
      deliverable: {
        deliverableType: listing.offering.deliverable.kind,
        hash: sha256Hex(canonicalize(listing.offering.deliverable)),
      },
      price: listing.pricing.kind === "fixed" ? listing.pricing.price : null,
      rail: railRef,
      deadline: 10_000,
      payoutBindings: [{
        railId: railRef.railId,
        phaseIndex: PAYMENT_PHASE_INDEX,
        payeeAddress: isDemos ? "bb".repeat(32) : PAYEE,
      }],
    },
    derivedFromPattern: "fixed-price",
    generatedAt: 500,
    signatures: [
      {
        party: buyerBundle.presentedBy,
        algorithm: "ed25519",
        value: AGREEMENT_SIGNATURE,
      },
      {
        party: sellerBundle.presentedBy,
        algorithm: "ed25519",
        value: AGREEMENT_SIGNATURE,
      },
    ],
  };
  const agreementHash = contentHash(agreement);
  const committed: Extract<CommittedAgreementResolution, { disposition: "verified" }> = {
    disposition: "verified",
    agreement,
    agreementHash,
    commitment: {
      finality: "finalized",
      jobId: JOB_ID,
      agreementHash,
      listingRef,
      committedAt: 1_000,
    },
    railRegistryVersion: 7,
  };

  const receiptObject = {
    success: true,
    transaction: EVM_TX,
    network: "eip155:84532",
    payer: PAYER,
    extensions: { "org.example.audit": { retained: true } },
  };
  const responseHeader = Buffer.from(JSON.stringify(receiptObject)).toString("base64");
  const paymentReceiptHash = sha256Hex(canonicalize(receiptObject));
  const input: SellerPaymentIntakeInput = isDemos
    ? {
        jobId: JOB_ID,
        phaseIndex: PAYMENT_PHASE_INDEX,
        railId: railRef.railId,
        payerPayingKey: BUYER_DEMOS,
        receipt: { kind: "pay-dem", txHash: DEMOS_TX },
      }
    : {
        jobId: JOB_ID,
        phaseIndex: PAYMENT_PHASE_INDEX,
        railId: railRef.railId,
        payerPayingKey: `cci-xm:evm:base:${PAYER}`,
        receipt: {
          kind: "pay-x402",
          protocolVersion: "2",
          responseHeader: { name: "PAYMENT-RESPONSE", value: responseHeader },
          httpResource: "https://seller.example/pay/order",
          paymentReceiptHash,
          settlementTxHash: EVM_TX,
          chainId: 84532,
        },
      };
  const demosObservation: DemosTransferObservation = {
    status: "included",
    txHash: DEMOS_TX,
    payer: "aa".repeat(32),
    payee: "bb".repeat(32),
    amountOs: "1250000000",
    blockNumber: 88,
    includedAt: 5_000,
  };
  const x402Observation: X402TransferObservation = {
    status: "finalized",
    chainId: 84532,
    txHash: EVM_TX,
    logIndex: 2,
    payer: PAYER,
    payee: PAYEE,
    amountBaseUnits: "2500000",
    asset: {
      contract: rail.railType === "x402" ? rail.asset.contract : "",
      symbol: "USDC",
      decimals: 6,
    },
    confirmations: 3,
    includedAt: 4_000,
    finalityObservedAt: 5_000,
    sessionBinding: {
      kind: "eip3009",
      nonce: x402Eip3009Nonce(JOB_ID, PAYMENT_PHASE_INDEX),
    },
  };
  const ctx = {} as Context;
  Object.assign(ctx, {
    input,
    agreement,
    committed,
    listing,
    rail,
    buyerBundle,
    sellerBundle,
    demosObservation,
    x402Observation,
  });
  ctx.deps = {
    resolveCommittedAgreement: async () => ctx.committed,
    resolveListingAtCommit: async () => listingAtCommitResolution(ctx.listing),
    resolveRail: async ({ railRegistryVersion }) => ({
      disposition: "verified",
      rail: ctx.rail,
      railRegistryVersion,
    }),
    resolveIdentityBundle: async (hash) => ({
      disposition: "verified",
      bundle: hash === identityBundleHash(ctx.buyerBundle) ? ctx.buyerBundle : ctx.sellerBundle,
    }),
    resolvePayerAddress: async () => ({ disposition: "verified", address: PAYER }),
    resolvePayeeDestination: async () => ({
      disposition: "bound",
      address: PAYEE,
      tier: 3,
    }),
    observeDemosTransfer: async () => ctx.demosObservation,
    observeX402Transfer: async () => ctx.x402Observation,
    verifyX402ReceiptExtensions: async () => ({ disposition: "pass" }),
    classifyX402SettlementChain: async () => ({ disposition: "l2" }),
    receiptStore: store,
  };
  return ctx;
}

function refreshCommitment(ctx: Context): void {
  const agreementHash = contentHash(ctx.agreement);
  ctx.committed.agreementHash = agreementHash;
  ctx.committed.commitment.agreementHash = agreementHash;
}

function rebindJob(ctx: Context, jobId: string): void {
  ctx.input.jobId = jobId;
  ctx.agreement.jobId = jobId;
  ctx.committed.commitment.jobId = jobId;
  refreshCommitment(ctx);
}

function rebindDemosSellerClaim(
  ctx: Context,
  primaryClaim: string,
  payoutAddress: string,
): void {
  const sellerBundle = identity(primaryClaim);
  ctx.sellerBundle = sellerBundle;
  ctx.listing.seller.identity = sellerBundle;
  ctx.listing.signature.signer = primaryClaim;

  const parties = ctx.agreement.parties as Array<{
    role: string;
    primaryClaim: string;
    bundleHash: string;
  }>;
  const seller = parties.find((party) => party.role === "seller");
  if (!seller) throw new Error("fixture");
  seller.primaryClaim = primaryClaim;
  seller.bundleHash = identityBundleHash(sellerBundle);

  const signatures = ctx.agreement.signatures as Array<{ party: string }>;
  const sellerSignature = signatures.find((signature) =>
    signature.party === SELLER_DEMOS);
  if (!sellerSignature) throw new Error("fixture");
  sellerSignature.party = primaryClaim;

  const terms = ctx.agreement.terms as {
    payoutBindings: Array<{ payeeAddress: string }>;
  };
  terms.payoutBindings[0]!.payeeAddress = payoutAddress;
  if (ctx.demosObservation.status !== "included") throw new Error("fixture");
  ctx.demosObservation.payee = payoutAddress;
  repinListing(ctx);
}

function repinListing(ctx: Context): void {
  const listingRef = {
    listingId: ctx.listing.listingId,
    version: ctx.listing.listingVersion,
    contentHash: contentHash(ctx.listing as unknown as Record<string, unknown>),
  };
  ctx.agreement.listingRef = listingRef;
  ctx.committed.commitment.listingRef = structuredClone(listingRef);
  ctx.deps.resolveListingAtCommit = async () =>
    listingAtCommitResolution(ctx.listing);
  refreshCommitment(ctx);
}

function mutateX402Receipt(
  ctx: Context,
  mutate: (receipt: Record<string, unknown>) => void,
): void {
  if (ctx.input.receipt.kind !== "pay-x402") throw new Error("x402 fixture required");
  const receipt = JSON.parse(
    Buffer.from(ctx.input.receipt.responseHeader.value, "base64").toString("utf8"),
  ) as Record<string, unknown>;
  mutate(receipt);
  ctx.input.receipt.responseHeader.value = Buffer.from(JSON.stringify(receipt)).toString("base64");
  ctx.input.receipt.paymentReceiptHash = sha256Hex(canonicalize(receipt));
}

function receiptClaim(overrides: Partial<{
  settlementId: string;
  jobId: string;
  phaseIndex: number;
  observedAt: number;
}> = {}): SellerReceiptClaim {
  const settlementId = overrides.settlementId ?? `demos:${"ef".repeat(32)}`;
  const jobId = overrides.jobId ?? JOB_ID;
  const phaseIndex = overrides.phaseIndex ?? PAYMENT_PHASE_INDEX;
  const observedAt = overrides.observedAt ?? 5_000;
  const evidenceInput: SellerPaymentEvidenceInput = {
    evidenceVersion: "1",
    jobId,
    phase: "pay-dem",
    outcome: "success",
    paymentTxRefs: [{ kind: "demos", txHash: `0x${"ef".repeat(32)}`, blockNumber: 1 }],
    paymentAmount: { amount: "1", currency: "DEM" },
    settlementFinality: { model: "bft-final", finalityObservedAt: observedAt },
    observedAt,
  };
  const evidenceHash = sha256Hex(canonicalize(evidenceInput));
  const authorization = {
    jobId,
    phaseIndex,
    agreementHash: "aa".repeat(32),
    listingRef: {
      listingId: "listing-store-test",
      version: 1,
      contentHash: "bb".repeat(32),
    },
    railId: "demos-native:DEM",
    settlementId,
    evidenceHash,
    evidenceInput,
    payoutBindingTier: 1 as const,
  };
  return {
    settlementId,
    jobId,
    phaseIndex,
    observedAt,
    evidenceHash,
    authorization,
  };
}

describe("verifySellerPaymentIntake", () => {
  it("verifies pay-DEM in OS, emits exact normative evidence, and claims once", async () => {
    const store = createInMemorySellerReceiptStore();
    const first = makeContext("pay-dem", store);
    const result = await verifySellerPaymentIntake(first.input, first.deps);

    expect(result).toMatchObject({
      disposition: "verified",
      fulfilment: "claim",
      settlementId: `demos:${"ab".repeat(32)}`,
      payoutBindingTier: 1,
      evidenceInput: {
        evidenceVersion: "1",
        jobId: JOB_ID,
        phase: "pay-dem",
        outcome: "success",
        paymentAmount: { amount: "1.25", currency: "DEM" },
        settlementFinality: { model: "bft-final", finalityObservedAt: 5_000 },
      },
    });
    expect(result.evidenceInput).not.toHaveProperty("phaseIndex");
    expect(result.evidenceInput?.paymentTxRefs[0]).toEqual({
      kind: "demos",
      txHash: DEMOS_TX,
      blockNumber: 88,
    });
    expect(result.payloadVerificationProducerAdmission).toMatchObject({
      operation: "produce",
      disposition: "supported",
      listingRef: first.committed.commitment.listingRef,
      verificationMethodKind: "self-signed",
      admittedAt: 900,
    });

    // A fresh core/dependency graph simulates restart; the durable store is shared.
    const restarted = makeContext("pay-dem", store);
    const duplicate = await verifySellerPaymentIntake(restarted.input, restarted.deps);
    expect(duplicate).toMatchObject({
      disposition: "verified",
      fulfilment: "already-claimed",
    });
  });

  it("accepts the PB-2 vector's Demos cci-xm seller and equivalent native forms", async () => {
    const ctx = makeContext("pay-dem");
    const sellerAddress = "11".repeat(32);
    rebindDemosSellerClaim(
      ctx,
      `cci-xm:demos:testnet:0x${sellerAddress}`,
      `0x${sellerAddress}`,
    );
    if (ctx.demosObservation.status !== "included") throw new Error("fixture");
    ctx.demosObservation.payer = `0x${"aa".repeat(32)}`;

    await expect(verifySellerPaymentIntake(ctx.input, ctx.deps)).resolves.toMatchObject({
      disposition: "verified",
      fulfilment: "claim",
      payoutBindingTier: 1,
    });
  });

  it.each([
    `cci-xm:demos::0x${"11".repeat(32)}`,
    `cci-xm:demos:testnet:${"11".repeat(32)}`,
    `cci-xm:demos:testnet:0x${"11".repeat(31)}`,
    `cci-xm:evm:testnet:0x${"11".repeat(32)}`,
  ])("rejects a malformed or foreign pay-DEM seller claim: %s", async (claim) => {
    const ctx = makeContext("pay-dem");
    rebindDemosSellerClaim(ctx, claim, `0x${"11".repeat(32)}`);

    await expect(verifySellerPaymentIntake(ctx.input, ctx.deps)).resolves.toMatchObject({
      disposition: "rejected",
      fulfilment: "none",
      reason: "payee-destination-binding-mismatch",
    });
  });

  it("does not accept a ClaimReference in the native payout-address field", async () => {
    const ctx = makeContext("pay-dem");
    const terms = ctx.agreement.terms as {
      payoutBindings: Array<{ payeeAddress: string }>;
    };
    terms.payoutBindings[0]!.payeeAddress = SELLER_DEMOS;
    refreshCommitment(ctx);

    await expect(verifySellerPaymentIntake(ctx.input, ctx.deps)).resolves.toMatchObject({
      disposition: "rejected",
      fulfilment: "none",
      reason: "payee-destination-binding-mismatch",
    });
  });

  it.each(["payer", "payee"] as const)(
    "does not accept a ClaimReference in the observed native %s field",
    async (party) => {
      const ctx = makeContext("pay-dem");
      if (ctx.demosObservation.status !== "included") throw new Error("fixture");
      ctx.demosObservation[party] = party === "payer" ? BUYER_DEMOS : SELLER_DEMOS;

      await expect(verifySellerPaymentIntake(ctx.input, ctx.deps)).resolves.toMatchObject({
        disposition: "rejected",
        fulfilment: "none",
        reason: "demos-transfer-party-or-identity-mismatch",
      });
    },
  );

  it("verifies x402 receipt, chain transfer, finality and SB-3 binding", async () => {
    const ctx = makeContext("pay-x402");
    const result = await verifySellerPaymentIntake(ctx.input, ctx.deps);

    expect(result).toMatchObject({
      disposition: "verified",
      fulfilment: "claim",
      payoutBindingTier: 3,
      sessionBinding: "established",
      settlementId: `evm:84532:${"cd".repeat(32)}:2`,
      evidenceInput: {
        evidenceVersion: "1",
        jobId: JOB_ID,
        phase: "pay-x402",
        outcome: "success",
        paymentAmount: { amount: "2.5", currency: "USDC" },
        settlementFinality: {
          model: "block-depth",
          finalityBlocks: 3,
          finalityObservedAt: 5_000,
        },
      },
    });
    expect(result.evidenceInput).not.toHaveProperty("phaseIndex");
    expect(result.evidenceInput?.paymentTxRefs[0]).toEqual({
      kind: "x402",
      httpResource: "https://seller.example/pay/order",
      paymentReceiptHash: (ctx.input.receipt as { paymentReceiptHash: string }).paymentReceiptHash,
      settlementTxHash: EVM_TX,
      chainId: 84532,
      protocolVersion: "2",
    });
    expect(result.evidenceInput).not.toHaveProperty("responseHeader");
  });

  it("recovers an earlier canonical x402 winner without strengthening SB-3", async () => {
    const store = createInMemorySellerReceiptStore();
    const first = makeContext("pay-x402", store);
    if (first.x402Observation.status !== "finalized") throw new Error("fixture");
    first.x402Observation.sessionBinding = { kind: "absent" };
    await expect(verifySellerPaymentIntake(first.input, first.deps))
      .resolves.toMatchObject({
        disposition: "verified",
        fulfilment: "claim",
        sessionBinding: "not-established",
      });

    const retry = makeContext("pay-x402", store);
    if (retry.x402Observation.status !== "finalized") throw new Error("fixture");
    retry.x402Observation.finalityObservedAt = 6_000;
    const result = await verifySellerPaymentIntake(retry.input, retry.deps);
    expect(result).toMatchObject({
      disposition: "verified",
      fulfilment: "already-claimed",
      sessionBinding: "not-established",
      evidenceInput: {
        observedAt: 5_000,
        settlementFinality: { finalityObservedAt: 5_000 },
      },
    });
  });

  it.each([
    ["missing producer admission", (resolution: SellerListingAtCommitResolution) => {
      delete resolution.payloadVerificationProducerAdmission;
    }],
    ["late producer admission", (resolution: SellerListingAtCommitResolution) => {
      resolution.payloadVerificationProducerAdmission!.admittedAt = 1_001;
    }],
    ["substituted method hash", (resolution: SellerListingAtCommitResolution) => {
      resolution.payloadVerificationProducerAdmission!.verificationMethodHash =
        "00".repeat(32);
    }],
    ["substituted Listing ref", (resolution: SellerListingAtCommitResolution) => {
      resolution.payloadVerificationProducerAdmission!.listingRef.contentHash =
        "11".repeat(32);
    }],
  ] as const)("refuses DPA payment before permit claim for %s", async (_name, mutate) => {
    const ctx = makeContext("pay-dem");
    const backing = createInMemorySellerReceiptStore();
    let claims = 0;
    ctx.deps.receiptStore = {
      claim: async (candidate) => {
        claims += 1;
        return backing.claim(candidate);
      },
      consumePermit: (permitId) => backing.consumePermit(permitId),
    };
    ctx.deps.resolveListingAtCommit = async () => {
      const resolution = listingAtCommitResolution(ctx.listing);
      mutate(resolution);
      return resolution;
    };

    await expect(verifySellerPaymentIntake(ctx.input, ctx.deps)).resolves.toMatchObject({
      fulfilment: "none",
      reason: expect.stringMatching(/payload-verification-producer-admission/),
    });
    expect(claims).toBe(0);
  });

  it("requires the raw Listing, reader result and producer admission from one checkpoint", async () => {
    const ctx = makeContext("pay-dem");
    const resolution = listingAtCommitResolution(ctx.listing);
    ctx.deps.resolveListingAtCommit = async () =>
      resolution.validation as never;
    let claims = 0;
    const backing = createInMemorySellerReceiptStore();
    ctx.deps.receiptStore = {
      claim: async (candidate) => {
        claims += 1;
        return backing.claim(candidate);
      },
      consumePermit: (permitId) => backing.consumePermit(permitId),
    };

    await expect(verifySellerPaymentIntake(ctx.input, ctx.deps)).resolves.toMatchObject({
      disposition: "indeterminate",
      fulfilment: "none",
      reason: "listing-at-commit-admission-unavailable",
    });
    expect(claims).toBe(0);
  });

  it("omits producer admission exactly when the Listing does not select DPA", async () => {
    const ctx = makeContext("pay-dem");
    ctx.listing.offering.deliverable = {
      kind: "storage-program",
      accessModel: "buyer-only",
    };
    ctx.listing.pipeline[3] = { kind: "deliver-storage-program" };
    const terms = ctx.agreement.terms as Record<string, unknown>;
    terms.deliverable = {
      deliverableType: "storage-program",
      hash: sha256Hex(canonicalize(ctx.listing.offering.deliverable)),
    };
    repinListing(ctx);

    const result = await verifySellerPaymentIntake(ctx.input, ctx.deps);
    expect(result).toMatchObject({ disposition: "verified", fulfilment: "claim" });
    expect(result).not.toHaveProperty("payloadVerificationProducerAdmission");

    const unexpected = makeContext("pay-dem");
    unexpected.listing.offering.deliverable = {
      kind: "storage-program",
      accessModel: "buyer-only",
    };
    unexpected.listing.pipeline[3] = { kind: "deliver-storage-program" };
    const unexpectedTerms = unexpected.agreement.terms as Record<string, unknown>;
    unexpectedTerms.deliverable = {
      deliverableType: "storage-program",
      hash: sha256Hex(canonicalize(unexpected.listing.offering.deliverable)),
    };
    repinListing(unexpected);
    unexpected.deps.resolveListingAtCommit = async () => ({
      ...listingAtCommitResolution(unexpected.listing),
      payloadVerificationProducerAdmission:
        listingAtCommitResolution(makeContext("pay-dem").listing)
          .payloadVerificationProducerAdmission!,
    });
    await expect(verifySellerPaymentIntake(unexpected.input, unexpected.deps))
      .resolves.toMatchObject({
        disposition: "rejected",
        fulfilment: "none",
        reason: "payload-verification-producer-admission-unexpected",
      });
  });

  it("owns caller input once even when getters and retained aliases later change", async () => {
    const ctx = makeContext("pay-dem");
    const original = ctx.input;
    let railReads = 0;
    Object.defineProperty(original, "railId", {
      configurable: true,
      enumerable: true,
      get: () => {
        railReads += 1;
        return railReads === 1 ? "demos-native:DEM" : "pay-evil";
      },
    });
    ctx.deps.resolveCommittedAgreement = async () => {
      if (original.receipt.kind === "pay-dem") {
        original.receipt.txHash = `0x${"ff".repeat(32)}`;
      }
      return ctx.committed;
    };

    await expect(verifySellerPaymentIntake(original, ctx.deps)).resolves.toMatchObject({
      disposition: "verified",
      fulfilment: "claim",
      settlementId: `demos:${"ab".repeat(32)}`,
    });
    expect(railReads).toBe(1);
  });

  it("snapshots callback getters and rejects Proxy callback results before permit", async () => {
    const getter = makeContext("pay-dem");
    let dispositionReads = 0;
    getter.deps.resolveCommittedAgreement = async () => {
      const resolution = { ...getter.committed };
      Object.defineProperty(resolution, "disposition", {
        configurable: true,
        enumerable: true,
        get: () => {
          dispositionReads += 1;
          return dispositionReads === 1 ? "verified" : "rejected";
        },
      });
      return resolution;
    };
    await expect(verifySellerPaymentIntake(getter.input, getter.deps))
      .resolves.toMatchObject({ disposition: "verified", fulfilment: "claim" });
    expect(dispositionReads).toBe(1);

    const proxied = makeContext("pay-dem");
    let claims = 0;
    const backing = createInMemorySellerReceiptStore();
    proxied.deps.receiptStore = {
      claim: async (candidate) => {
        claims += 1;
        return backing.claim(candidate);
      },
      consumePermit: (permitId) => backing.consumePermit(permitId),
    };
    proxied.deps.resolveCommittedAgreement = async () =>
      new Proxy(proxied.committed, {});
    await expect(verifySellerPaymentIntake(proxied.input, proxied.deps))
      .resolves.toMatchObject({
        disposition: "error",
        fulfilment: "none",
        reason: "agreement-resolution-invalid-result",
      });
    expect(claims).toBe(0);
  });

  it("isolates retained callback outputs and rejects callback input mutation", async () => {
    const retained = makeContext("pay-dem");
    const rawRail = {
      disposition: "verified" as const,
      rail: retained.rail,
      railRegistryVersion: retained.committed.railRegistryVersion,
    };
    retained.deps.resolveRail = async () => rawRail;
    const resolveBundle = retained.deps.resolveIdentityBundle;
    retained.deps.resolveIdentityBundle = async (hash) => {
      rawRail.rail.railId = "pay-evil";
      return resolveBundle(hash);
    };
    await expect(verifySellerPaymentIntake(retained.input, retained.deps))
      .resolves.toMatchObject({ disposition: "verified", fulfilment: "claim" });

    const mutatedInput = makeContext("pay-dem");
    let claims = 0;
    const backing = createInMemorySellerReceiptStore();
    mutatedInput.deps.receiptStore = {
      claim: async (candidate) => {
        claims += 1;
        return backing.claim(candidate);
      },
      consumePermit: (permitId) => backing.consumePermit(permitId),
    };
    mutatedInput.deps.resolveRail = async (railInput) => {
      railInput.ref.railId = "pay-evil";
      return {
        disposition: "verified",
        rail: mutatedInput.rail,
        railRegistryVersion: railInput.railRegistryVersion,
      };
    };
    await expect(verifySellerPaymentIntake(mutatedInput.input, mutatedInput.deps))
      .resolves.toMatchObject({
        disposition: "indeterminate",
        fulfilment: "none",
        reason: "rail-resolution-unavailable",
      });
    expect(claims).toBe(0);
  });

  it("freezes the receipt claim input and snapshots the store result", async () => {
    const accepted = makeContext("pay-dem");
    const backing = createInMemorySellerReceiptStore();
    let sawFrozenClaim = false;
    accepted.deps.receiptStore = {
      claim: async (candidate) => {
        sawFrozenClaim = Object.isFrozen(candidate) &&
          Object.isFrozen(candidate.authorization) &&
          Object.isFrozen(candidate.authorization.evidenceInput);
        return backing.claim(candidate);
      },
      consumePermit: (permitId) => backing.consumePermit(permitId),
    };
    await expect(verifySellerPaymentIntake(accepted.input, accepted.deps))
      .resolves.toMatchObject({ disposition: "verified", fulfilment: "claim" });
    expect(sawFrozenClaim).toBe(true);

    const proxied = makeContext("pay-dem");
    const proxiedBacking = createInMemorySellerReceiptStore();
    proxied.deps.receiptStore = {
      claim: async (candidate) => new Proxy(
        await proxiedBacking.claim(candidate),
        {},
      ),
      consumePermit: (permitId) => proxiedBacking.consumePermit(permitId),
    };
    await expect(verifySellerPaymentIntake(proxied.input, proxied.deps))
      .resolves.toMatchObject({
        disposition: "indeterminate",
        fulfilment: "none",
        reason: "receipt-store-invalid-result",
      });
  });

  it.each([
    ["an extra union field", (result: Record<string, unknown>) => ({
      ...result,
      unexpected: true,
    })],
    ["a boxed status discriminator", (result: Record<string, unknown>) => ({
      ...result,
      status: new String(result.status),
    })],
  ] as const)("rejects receipt-store results with %s", async (_name, mutate) => {
    const ctx = makeContext("pay-dem");
    const backing = createInMemorySellerReceiptStore();
    ctx.deps.receiptStore = {
      claim: async (candidate) => mutate(
        await backing.claim(candidate) as unknown as Record<string, unknown>,
      ) as never,
      consumePermit: (permitId) => backing.consumePermit(permitId),
    };

    await expect(verifySellerPaymentIntake(ctx.input, ctx.deps))
      .resolves.toMatchObject({
        disposition: "indeterminate",
        fulfilment: "none",
        reason: "receipt-store-invalid-result",
      });
  });

  it("rejects a live Listing checkpoint before any receipt-store side effect", async () => {
    const ctx = makeContext("pay-dem");
    let claims = 0;
    const backing = createInMemorySellerReceiptStore();
    ctx.deps.receiptStore = {
      claim: async (candidate) => {
        claims += 1;
        return backing.claim(candidate);
      },
      consumePermit: (permitId) => backing.consumePermit(permitId),
    };
    ctx.deps.resolveListingAtCommit = async () => new Proxy(
      listingAtCommitResolution(ctx.listing),
      {},
    );

    await expect(verifySellerPaymentIntake(ctx.input, ctx.deps))
      .resolves.toMatchObject({
        disposition: "indeterminate",
        fulfilment: "none",
        reason: "listing-at-commit-admission-unavailable",
      });
    expect(claims).toBe(0);
  });

  it("accepts a distinct post-Vet seller bundle under the Listing seller claim", async () => {
    const ctx = makeContext("pay-dem");
    const sessionSeller = structuredClone(ctx.sellerBundle);
    sessionSeller.sessionNonce = "post-vet-session-0123456789";
    ctx.sellerBundle = sessionSeller;
    const parties = ctx.agreement.parties as Array<Record<string, unknown>>;
    const seller = parties.find((party) => party.role === "seller");
    if (!seller) throw new Error("fixture");
    seller.bundleHash = identityBundleHash(sessionSeller);
    refreshCommitment(ctx);

    await expect(verifySellerPaymentIntake(ctx.input, ctx.deps)).resolves.toMatchObject({
      disposition: "verified",
      fulfilment: "claim",
    });
  });

  it("reuses the complete fixed-price Agreement-to-Listing verifier", async () => {
    const underpriced = makeContext("pay-dem");
    const underpricedTerms = underpriced.agreement.terms as Record<string, unknown>;
    underpricedTerms.price = { amount: "0.5", currency: "DEM" };
    refreshCommitment(underpriced);
    await expect(verifySellerPaymentIntake(underpriced.input, underpriced.deps))
      .resolves.toMatchObject({
        disposition: "rejected",
        reason: "agreement-listing-conformance-failed",
      });

    const wrongPattern = makeContext("pay-dem");
    wrongPattern.agreement.derivedFromPattern = "rfq";
    refreshCommitment(wrongPattern);
    await expect(verifySellerPaymentIntake(wrongPattern.input, wrongPattern.deps))
      .resolves.toMatchObject({
        disposition: "rejected",
        reason: "agreement-listing-conformance-failed",
      });

    const wrongCommit = makeContext("pay-dem");
    wrongCommit.listing.pipeline[1] = { kind: "commit-agreement" };
    repinListing(wrongCommit);
    await expect(verifySellerPaymentIntake(wrongCommit.input, wrongCommit.deps))
      .resolves.toMatchObject({
        disposition: "rejected",
        reason: "agreement-listing-conformance-failed",
      });

    const wrongSeller = makeContext("pay-dem");
    const otherSeller = `did:demos:agent:${"99".repeat(32)}`;
    wrongSeller.listing.seller.identity.presentedBy = otherSeller;
    wrongSeller.listing.seller.identity.claims = [{ ref: otherSeller }];
    wrongSeller.listing.seller.identity.presentation = {
      kind: "per-claim",
      signatures: [{ ref: otherSeller, signature: "c2ln" }],
    };
    wrongSeller.listing.signature.signer = otherSeller;
    repinListing(wrongSeller);
    await expect(verifySellerPaymentIntake(wrongSeller.input, wrongSeller.deps))
      .resolves.toMatchObject({
        disposition: "rejected",
        reason: "agreement-listing-conformance-failed",
      });
  });

  it("accepts fixed-price derivation from an exact negotiable bandCenter", async () => {
    const ctx = makeContext("pay-dem");
    const price = { amount: "1.25", currency: "DEM" } as const;
    ctx.listing.pricing = {
      kind: "negotiable",
      bandCenter: price,
      minPct: 5,
      maxPct: 5,
    };
    repinListing(ctx);

    await expect(verifySellerPaymentIntake(ctx.input, ctx.deps)).resolves.toMatchObject({
      disposition: "verified",
      fulfilment: "claim",
    });
  });

  it("requires the authenticated session rail-registry snapshot", async () => {
    const ctx = makeContext("pay-dem");
    let requestedVersion: number | undefined;
    ctx.deps.resolveRail = async ({ railRegistryVersion }) => {
      requestedVersion = railRegistryVersion;
      return {
        disposition: "verified",
        rail: ctx.rail,
        railRegistryVersion: railRegistryVersion + 1,
      };
    };

    await expect(verifySellerPaymentIntake(ctx.input, ctx.deps)).resolves.toMatchObject({
      disposition: "rejected",
      reason: "unsupported-or-mismatched-rail",
    });
    expect(requestedVersion).toBe(7);
  });

  it("rejects a transaction included before commitment even if finalized later", async () => {
    const ctx = makeContext("pay-x402");
    if (ctx.x402Observation.status !== "finalized") throw new Error("fixture");
    ctx.x402Observation.includedAt = 500;
    ctx.x402Observation.finalityObservedAt = 5_000;

    await expect(verifySellerPaymentIntake(ctx.input, ctx.deps)).resolves.toMatchObject({
      disposition: "rejected",
      reason: "payment-before-finalized-commitment",
    });
  });

  it("enforces registered signed-extension verification and preserves unknown members", async () => {
    const invalid = makeContext("pay-x402");
    let seen: Record<string, unknown> | undefined;
    invalid.deps.verifyX402ReceiptExtensions = async ({ receipt }) => {
      seen = structuredClone(receipt);
      return { disposition: "fail", reason: "invalid-signature" };
    };
    const rejected = await verifySellerPaymentIntake(invalid.input, invalid.deps);
    expect(rejected).toMatchObject({
      disposition: "rejected",
      fulfilment: "none",
      reason: "x402-extension-invalid-signature",
    });
    expect(seen?.extensions).toEqual({ "org.example.audit": { retained: true } });

    const unavailable = makeContext("pay-x402");
    unavailable.deps.verifyX402ReceiptExtensions = async () => ({
      disposition: "indeterminate",
      reason: "registry-unavailable",
    });
    await expect(verifySellerPaymentIntake(unavailable.input, unavailable.deps))
      .resolves.toMatchObject({
        disposition: "indeterminate",
        fulfilment: "none",
        reason: "x402-extension-registry-unavailable",
      });
  });

  it("classifies malformed x402 receipt bytes as permanent rejection", async () => {
    const ctx = makeContext("pay-x402");
    if (ctx.input.receipt.kind !== "pay-x402") throw new Error("fixture");
    ctx.input.receipt.responseHeader.value = "not base64***";

    await expect(verifySellerPaymentIntake(ctx.input, ctx.deps)).resolves.toMatchObject({
      disposition: "rejected",
      fulfilment: "none",
      reason: "x402-invalid-base64",
    });
  });

  it("uses the chain-aware finality default for Ethereum mainnet", async () => {
    const ctx = makeContext("pay-x402");
    if (ctx.rail.railType !== "x402" || ctx.input.receipt.kind !== "pay-x402" ||
        ctx.x402Observation.status !== "finalized") throw new Error("fixture");
    ctx.rail.asset.chainId = 1;
    delete ctx.rail.parameters.finalityBlocks;
    ctx.input.receipt.chainId = 1;
    ctx.x402Observation.chainId = 1;
    ctx.x402Observation.confirmations = 1;
    mutateX402Receipt(ctx, (receipt) => { receipt.network = "eip155:1"; });

    await expect(verifySellerPaymentIntake(ctx.input, ctx.deps)).resolves.toMatchObject({
      disposition: "rejected",
      reason: "x402-finality-mismatch",
    });

    ctx.x402Observation.confirmations = 12;
    await expect(verifySellerPaymentIntake(ctx.input, ctx.deps)).resolves.toMatchObject({
      disposition: "verified",
      evidenceInput: { settlementFinality: { model: "block-depth", finalityBlocks: 12 } },
    });
  });

  it("applies the one-block default only after local L2 classification", async () => {
    const base = makeContext("pay-x402");
    if (base.rail.railType !== "x402" ||
        base.x402Observation.status !== "finalized") throw new Error("fixture");
    delete base.rail.parameters.finalityBlocks;
    base.x402Observation.confirmations = 1;
    await expect(verifySellerPaymentIntake(base.input, base.deps)).resolves.toMatchObject({
      disposition: "verified",
      evidenceInput: { settlementFinality: { finalityBlocks: 1 } },
    });

    const unknown = makeContext("pay-x402");
    if (unknown.rail.railType !== "x402" ||
        unknown.input.receipt.kind !== "pay-x402" ||
        unknown.x402Observation.status !== "finalized") throw new Error("fixture");
    delete unknown.rail.parameters.finalityBlocks;
    unknown.rail.asset.chainId = 999;
    unknown.input.receipt.chainId = 999;
    unknown.x402Observation.chainId = 999;
    mutateX402Receipt(unknown, (receipt) => { receipt.network = "eip155:999"; });
    unknown.deps.classifyX402SettlementChain = async () => ({
      disposition: "unsupported",
      reason: "not-configured",
    });
    await expect(verifySellerPaymentIntake(unknown.input, unknown.deps))
      .resolves.toMatchObject({
        disposition: "rejected",
        reason: "x402-chain-not-configured",
      });
  });

  it("implements the exact SB-3 session-binding branches", async () => {
    for (const sessionBinding of [
      { kind: "absent" as const },
      { kind: "unverifiable" as const, reason: "historical-state-pruned" },
    ]) {
      const ctx = makeContext("pay-x402");
      if (ctx.x402Observation.status !== "finalized") throw new Error("fixture");
      ctx.x402Observation.sessionBinding = sessionBinding;
      await expect(verifySellerPaymentIntake(ctx.input, ctx.deps)).resolves.toMatchObject({
        disposition: "verified",
        sessionBinding: "not-established",
      });
    }

    const unknown = makeContext("pay-x402");
    if (unknown.x402Observation.status !== "finalized") throw new Error("fixture");
    unknown.x402Observation.sessionBinding = { kind: "future-binding" } as never;
    await expect(verifySellerPaymentIntake(unknown.input, unknown.deps))
      .resolves.toMatchObject({
        disposition: "error",
        fulfilment: "none",
        reason: "x402-session-binding-unsupported",
      });

    const malformed = makeContext("pay-x402");
    if (malformed.x402Observation.status !== "finalized") throw new Error("fixture");
    malformed.x402Observation.sessionBinding = { kind: "unverifiable", reason: "" };
    await expect(verifySellerPaymentIntake(malformed.input, malformed.deps))
      .resolves.toMatchObject({
        disposition: "error",
        fulfilment: "none",
        reason: "x402-session-binding-malformed",
      });
  });

  it("reports malformed SB-1 identities and EIP-3009 nonces as verifier errors", async () => {
    const demos = makeContext("pay-dem");
    if (demos.input.receipt.kind !== "pay-dem") throw new Error("fixture");
    demos.input.receipt.txHash = "0x1234";
    await expect(verifySellerPaymentIntake(demos.input, demos.deps)).resolves.toMatchObject({
      disposition: "error",
      fulfilment: "none",
      reason: "malformed-settlement-identity",
    });

    const x402 = makeContext("pay-x402");
    if (x402.x402Observation.status !== "finalized") throw new Error("fixture");
    x402.x402Observation.sessionBinding = { kind: "eip3009", nonce: "0x1234" };
    await expect(verifySellerPaymentIntake(x402.input, x402.deps)).resolves.toMatchObject({
      disposition: "error",
      fulfilment: "none",
      reason: "x402-session-nonce-malformed",
    });

    const malformedX402Identity = makeContext("pay-x402");
    if (malformedX402Identity.input.receipt.kind !== "pay-x402" ||
        malformedX402Identity.x402Observation.status !== "finalized") {
      throw new Error("fixture");
    }
    mutateX402Receipt(malformedX402Identity, (receipt) => {
      receipt.transaction = "0x1234";
    });
    malformedX402Identity.input.receipt.settlementTxHash = "0x1234";
    malformedX402Identity.x402Observation.txHash = "0x1234";
    await expect(verifySellerPaymentIntake(
      malformedX402Identity.input,
      malformedX402Identity.deps,
    ))
      .resolves.toMatchObject({
        disposition: "error",
        fulfilment: "none",
        reason: "malformed-settlement-identity",
      });

    for (const chainId of [-1, 1.5]) {
      const malformedChain = makeContext("pay-x402");
      if (malformedChain.input.receipt.kind !== "pay-x402") throw new Error("fixture");
      malformedChain.input.receipt.chainId = chainId;
      await expect(verifySellerPaymentIntake(malformedChain.input, malformedChain.deps))
        .resolves.toMatchObject({
          disposition: "error",
          fulfilment: "none",
          reason: "malformed-settlement-identity",
        });
    }
  });

  it("uses SB-1/SB-2 canonical identities and rejects cross-session reuse", async () => {
    expect(canonicalSellerSettlementId({ kind: "demos", txHash: DEMOS_TX }))
      .toBe(`demos:${"ab".repeat(32)}`);
    expect(canonicalSellerSettlementId({
      kind: "evm", chainId: 84532, txHash: EVM_TX.toUpperCase(), logIndex: 2,
    })).toBe(`evm:84532:${"cd".repeat(32)}:2`);
    expect(canonicalSellerSettlementId({
      kind: "evm", chainId: 84532, txHash: "abc", logIndex: 2,
    })).toBeNull();

    const store = createInMemorySellerReceiptStore([receiptClaim({
      settlementId: `demos:${"ab".repeat(32)}`,
      jobId: "another-job",
      phaseIndex: 1,
      observedAt: 4_000,
    })]);
    const ctx = makeContext("pay-dem", store);
    const result = await verifySellerPaymentIntake(ctx.input, ctx.deps);
    expect(result).toMatchObject({
      disposition: "rejected",
      fulfilment: "none",
      reason: "settlement-identity-replay",
    });
  });

  it("replays the applicable Standard SB-2 settlement-uniqueness vectors", async () => {
    const set = JSON.parse(readFileSync(new URL(
      "../../vendor/DACS-Standard/conformance/vectors/security/sb2-settlement-uniqueness-v0.1.json",
      import.meta.url,
    ), "utf8")) as {
      vectors: Array<{
        name: string;
        decision: string;
        effect: string;
        consumed: Record<string, { jobId: string; phaseIndex: number }>;
        record: {
          settlementRef?: {
            rail: string;
            chainId?: number;
            txHash?: string;
            logIndex?: number;
          };
          jobId?: string;
          phaseIndex?: number;
        };
      }>;
    };

    const applicable = set.vectors.filter((vector) =>
      ["evm", "demos-native"].includes(vector.record.settlementRef?.rail ?? "") &&
      vector.name !== "ledger-unreadable-indeterminate");
    for (const vector of applicable) {
      const ref = vector.record.settlementRef!;
      const recordIsMalformed = typeof vector.record.jobId !== "string" ||
        !Number.isSafeInteger(vector.record.phaseIndex) ||
        (vector.record.phaseIndex ?? -1) < 0;
      const settlementId = ref.rail === "evm"
        ? canonicalSellerSettlementId({
            kind: "evm",
            chainId: ref.chainId!,
            txHash: ref.txHash!,
            logIndex: ref.logIndex!,
          })
        : canonicalSellerSettlementId({ kind: "demos", txHash: ref.txHash! });
      if (vector.decision === "error") {
        expect(settlementId === null || recordIsMalformed, vector.name).toBe(true);
        continue;
      }
      expect(settlementId, vector.name).not.toBeNull();
      const store = createInMemorySellerReceiptStore();
      for (const [id, binding] of Object.entries(vector.consumed)) {
        const consumed = await store.claim(receiptClaim({
          settlementId: id,
          jobId: binding.jobId,
          phaseIndex: binding.phaseIndex,
          observedAt: 0,
        }));
        if (consumed.status !== "claimed" && consumed.status !== "already-claimed") {
          throw new Error(`invalid consumed fixture: ${vector.name}`);
        }
        await store.consumePermit(consumed.permitId);
      }
      const result = await store.claim(receiptClaim({
        settlementId: settlementId!,
        jobId: vector.record.jobId!,
        phaseIndex: vector.record.phaseIndex!,
        observedAt: 1,
      }));
      if (vector.effect === "already-counted") {
        expect(["already-claimed", "already-consumed"], vector.name)
          .toContain(result.status);
      } else {
        const expectedStatus = vector.effect === "count" ? "claimed" : "conflict";
        expect(result.status, vector.name).toBe(expectedStatus);
      }
    }
  });

  it("atomically grants one fulfilment claim under concurrent retries", async () => {
    const store = createInMemorySellerReceiptStore();
    const request = receiptClaim({
      settlementId: `demos:${"ef".repeat(32)}`,
      jobId: JOB_ID,
      phaseIndex: PAYMENT_PHASE_INDEX,
    });
    const results = await Promise.all(
      Array.from({ length: 12 }, () => store.claim(request)),
    );
    expect(results.filter((result) => result.status === "claimed")).toHaveLength(1);
    expect(results.filter((result) => result.status === "already-claimed")).toHaveLength(11);
    const permits = results.flatMap((result) =>
      result.status === "conflict" ? [] : [result.permitId]);
    expect(new Set(permits).size).toBe(1);
    const consumptions = await Promise.all(
      permits.map((permitId) => store.consumePermit(permitId)),
    );
    expect(consumptions.filter((result) => result.status === "consumed")).toHaveLength(1);
    expect(consumptions.filter((result) => result.status === "already-consumed"))
      .toHaveLength(11);
  });

  it("returns the store-retained authorization on a same-phase retry", async () => {
    const store = createInMemorySellerReceiptStore();
    const firstClaim = receiptClaim({ observedAt: 100 });
    const first = await store.claim(firstClaim);
    if (first.status !== "claimed") throw new Error("fixture");

    const changedRetry = receiptClaim({ observedAt: 200 });
    const retry = await store.claim(changedRetry);
    expect(retry).toMatchObject({
      status: "already-claimed",
      permitId: first.permitId,
      claim: {
        observedAt: 100,
        evidenceHash: firstClaim.evidenceHash,
        authorization: { evidenceInput: { observedAt: 100 } },
      },
    });

    const changedAgreement = structuredClone(changedRetry);
    changedAgreement.authorization.agreementHash = "cc".repeat(32);
    await expect(store.claim(changedAgreement)).resolves.toMatchObject({
      status: "conflict",
      reason: "authorization-scope-conflict",
      existing: { authorization: { agreementHash: "aa".repeat(32) } },
    });
  });

  it("fails closed when an injected receipt store returns a malformed permit", async () => {
    const ctx = makeContext("pay-dem");
    ctx.deps.receiptStore = {
      async claim(input) {
        return { status: "claimed", permitId: "", claim: input };
      },
      async consumePermit() {
        return { status: "invalid" };
      },
    };

    await expect(verifySellerPaymentIntake(ctx.input, ctx.deps)).resolves.toMatchObject({
      disposition: "indeterminate",
      fulfilment: "none",
      reason: "receipt-store-invalid-result",
    });
  });

  it.each([
    "payment amount",
    "finality depth",
    "payout tier",
    "SB-2 ordering",
    "stronger SB-3 result",
  ] as const)("rejects an already-claimed store substitution of %s", async (field) => {
    const backing = createInMemorySellerReceiptStore();
    const first = makeContext("pay-x402", backing);
    if (first.x402Observation.status !== "finalized") throw new Error("fixture");
    if (field === "stronger SB-3 result") {
      first.x402Observation.sessionBinding = { kind: "absent" };
    }
    await expect(verifySellerPaymentIntake(first.input, first.deps))
      .resolves.toMatchObject({ disposition: "verified", fulfilment: "claim" });

    const retry = makeContext("pay-x402");
    if (retry.x402Observation.status !== "finalized") throw new Error("fixture");
    retry.x402Observation.finalityObservedAt = 6_000;
    if (field === "stronger SB-3 result") {
      retry.x402Observation.sessionBinding = { kind: "absent" };
    }
    retry.deps.receiptStore = {
      claim: async (candidate) => {
        const result = await backing.claim(candidate);
        if (result.status !== "already-claimed") throw new Error("fixture");
        const altered = structuredClone(result);
        const claim = altered.claim;
        switch (field) {
          case "payment amount":
            claim.authorization.evidenceInput.paymentAmount.amount = "999";
            break;
          case "finality depth": {
            const finality = claim.authorization.evidenceInput.settlementFinality;
            if (finality.model !== "block-depth") throw new Error("fixture");
            finality.finalityBlocks = 1;
            break;
          }
          case "payout tier":
            claim.authorization.payoutBindingTier = 2;
            break;
          case "SB-2 ordering": {
            claim.observedAt = 7_000;
            claim.authorization.evidenceInput.observedAt = 7_000;
            claim.authorization.evidenceInput.settlementFinality.finalityObservedAt =
              7_000;
            break;
          }
          case "stronger SB-3 result":
            claim.authorization.sessionBinding = "established";
            break;
        }
        const evidenceHash = sha256Hex(canonicalize(
          claim.authorization.evidenceInput,
        ));
        claim.evidenceHash = evidenceHash;
        claim.authorization.evidenceHash = evidenceHash;
        return altered;
      },
      consumePermit: (permitId) => backing.consumePermit(permitId),
    };

    await expect(verifySellerPaymentIntake(retry.input, retry.deps))
      .resolves.toMatchObject({
        disposition: "indeterminate",
        fulfilment: "none",
        reason: "receipt-store-invalid-result",
      });
  });

  it("selects the SB-2 winner by observedAt then evidence hash, independent of arrival", async () => {
    const settlementId = `demos:${"12".repeat(32)}`;
    const later = receiptClaim({
      settlementId,
      jobId: "job-later",
      observedAt: 200,
    });
    const earlier = receiptClaim({
      settlementId,
      jobId: "job-earlier",
      observedAt: 100,
    });
    const store = createInMemorySellerReceiptStore();
    const first = await store.claim(later);
    const second = await store.claim(earlier);
    expect(first.status).toBe("claimed");
    expect(second.status).toBe("claimed");
    if (first.status !== "claimed" || second.status !== "claimed") throw new Error("fixture");
    expect(await store.consumePermit(first.permitId)).toEqual({ status: "invalid" });
    expect(await store.consumePermit(second.permitId)).toMatchObject({
      status: "consumed",
      claim: { jobId: "job-earlier", observedAt: 100 },
    });

    const tieA = receiptClaim({ settlementId, jobId: "job-tie-a", observedAt: 300 });
    const tieB = receiptClaim({ settlementId, jobId: "job-tie-b", observedAt: 300 });
    const [lower, higher] = tieA.evidenceHash < tieB.evidenceHash
      ? [tieA, tieB]
      : [tieB, tieA];
    const tieStore = createInMemorySellerReceiptStore();
    expect((await tieStore.claim(higher)).status).toBe("claimed");
    const replacement = await tieStore.claim(lower);
    expect(replacement.status).toBe("claimed");
    if (replacement.status !== "claimed") throw new Error("fixture");
    expect(await tieStore.consumePermit(replacement.permitId)).toMatchObject({
      status: "consumed",
      claim: { evidenceHash: lower.evidenceHash },
    });
  });

  it("retains the canonical winner when it is discovered after consumption", async () => {
    const settlementId = `demos:${"34".repeat(32)}`;
    const store = createInMemorySellerReceiptStore();
    const first = await store.claim(receiptClaim({
      settlementId,
      jobId: "job-first",
      observedAt: 200,
    }));
    if (first.status !== "claimed") throw new Error("fixture");
    expect((await store.consumePermit(first.permitId)).status).toBe("consumed");

    const lateEarlier = await store.claim(receiptClaim({
      settlementId,
      jobId: "job-late-earlier",
      observedAt: 100,
    }));
    expect(lateEarlier).toMatchObject({
      status: "conflict",
      reason: "winner-already-consumed",
      existing: { jobId: "job-late-earlier", observedAt: 100 },
      consumed: { jobId: "job-first", observedAt: 200 },
    });
    expect(lateEarlier).not.toHaveProperty("permitId");

    const lowerOther = await store.claim(receiptClaim({
      settlementId,
      jobId: "job-lower-other",
      observedAt: 300,
    }));
    expect(lowerOther).toMatchObject({
      status: "conflict",
      reason: "lower-priority",
      existing: { jobId: "job-late-earlier" },
      consumed: { jobId: "job-first" },
    });
    expect(lowerOther).not.toHaveProperty("permitId");

    const replayOld = await store.claim(receiptClaim({
      settlementId,
      jobId: "job-first",
      observedAt: 200,
    }));
    expect(replayOld).toMatchObject({
      status: "already-consumed",
      permitId: first.permitId,
      claim: { jobId: "job-first", observedAt: 200 },
    });
    expect(await store.consumePermit(first.permitId)).toMatchObject({
      status: "already-consumed",
      claim: { jobId: "job-first" },
    });
  });

  it("recovers only the exact consumed claim after SB-2 winner discovery", async () => {
    const store = createInMemorySellerReceiptStore();
    const original = makeContext("pay-dem", store);
    const originalResult = await verifySellerPaymentIntake(original.input, original.deps);
    expect(originalResult).toMatchObject({
      disposition: "verified",
      fulfilment: "claim",
      jobId: JOB_ID,
      phaseIndex: PAYMENT_PHASE_INDEX,
    });
    if (!originalResult.permitId) throw new Error("fixture");
    const originalPermitId = originalResult.permitId;
    const consumed = await store.consumePermit(originalPermitId);
    expect(consumed.status).toBe("consumed");
    if (consumed.status === "invalid") throw new Error("fixture");
    const originalAuthorization = consumed.claim.authorization;

    const earlierWinner = makeContext("pay-dem", store);
    rebindJob(earlierWinner, "01J8ME0SXKQ4T9V2RC5HJ6WX7E");
    if (earlierWinner.demosObservation.status !== "included") throw new Error("fixture");
    earlierWinner.demosObservation.includedAt = 4_000;
    const winnerConflict = await verifySellerPaymentIntake(
      earlierWinner.input,
      earlierWinner.deps,
    );
    expect(winnerConflict).toMatchObject({
      disposition: "indeterminate",
      fulfilment: "none",
      reason: "settlement-winner-conflict-after-consumption",
      consumedAuthorization: originalAuthorization,
    });
    expect(winnerConflict.consumedAuthorization).toEqual(originalAuthorization);
    expect(winnerConflict).not.toHaveProperty("permitId");

    const lowerOther = makeContext("pay-dem", store);
    rebindJob(lowerOther, "01J8ME0SXKQ4T9V2RC5HJ6WX7F");
    if (lowerOther.demosObservation.status !== "included") throw new Error("fixture");
    lowerOther.demosObservation.includedAt = 6_000;
    const lowerConflict = await verifySellerPaymentIntake(lowerOther.input, lowerOther.deps);
    expect(lowerConflict).toMatchObject({
      disposition: "rejected",
      fulfilment: "none",
      reason: "settlement-identity-replay",
      consumedAuthorization: originalAuthorization,
    });
    expect(lowerConflict.consumedAuthorization).toEqual(originalAuthorization);
    expect(lowerConflict).not.toHaveProperty("permitId");

    const substitutedRetry = makeContext("pay-dem", store);
    if (substitutedRetry.demosObservation.status !== "included") {
      throw new Error("fixture");
    }
    substitutedRetry.demosObservation.includedAt = 5_500;
    substitutedRetry.demosObservation.blockNumber = 89;
    const substituted = await verifySellerPaymentIntake(
      substitutedRetry.input,
      substitutedRetry.deps,
    );
    expect(substituted).toMatchObject({
      disposition: "rejected",
      fulfilment: "none",
      reason: "settlement-identity-replay",
      consumedAuthorization: originalAuthorization,
    });
    expect(substituted.consumedAuthorization).toEqual(originalAuthorization);
    expect(substituted).not.toHaveProperty("permitId");

    const retry = makeContext("pay-dem", store);
    if (retry.demosObservation.status !== "included") throw new Error("fixture");
    retry.demosObservation.includedAt = 5_500;
    const recovered = await verifySellerPaymentIntake(retry.input, retry.deps);
    expect(recovered).toMatchObject({
      disposition: "verified",
      fulfilment: "already-claimed",
      reason: "payment-already-consumed",
      ...originalAuthorization,
      permitId: originalPermitId,
    });
    expect(recovered).not.toHaveProperty("consumedAuthorization");
  });

  it("discloses consumed scope conflicts without leaking their recovery permit", async () => {
    const store = createInMemorySellerReceiptStore();
    const original = makeContext("pay-dem", store);
    const originalResult = await verifySellerPaymentIntake(original.input, original.deps);
    if (!originalResult.permitId) throw new Error("fixture");
    const consumed = await store.consumePermit(originalResult.permitId);
    expect(consumed.status).toBe("consumed");
    if (consumed.status === "invalid") throw new Error("fixture");

    const conflicting = makeContext("pay-dem", store);
    conflicting.listing.offering.title = "Different authenticated listing scope";
    repinListing(conflicting);
    const result = await verifySellerPaymentIntake(conflicting.input, conflicting.deps);
    expect(result).toMatchObject({
      disposition: "rejected",
      fulfilment: "none",
      reason: "settlement-authorization-scope-conflict",
      consumedAuthorization: {
        jobId: JOB_ID,
        phaseIndex: PAYMENT_PHASE_INDEX,
        agreementHash: originalResult.agreementHash,
        listingRef: originalResult.listingRef,
        settlementId: originalResult.settlementId,
        evidenceHash: originalResult.evidenceHash,
      },
    });
    expect(result.consumedAuthorization).toEqual(consumed.claim.authorization);
    expect(result).not.toHaveProperty("permitId");
    expect(result.consumedAuthorization?.agreementHash)
      .not.toBe(conflicting.committed.agreementHash);
  });

  it("rejects an injected consumed recovery capability for another session", async () => {
    const backing = createInMemorySellerReceiptStore();
    const original = makeContext("pay-dem", backing);
    const claimed = await verifySellerPaymentIntake(original.input, original.deps);
    if (!claimed.permitId) throw new Error("fixture");
    const consumed = await backing.consumePermit(claimed.permitId);
    if (consumed.status === "invalid") throw new Error("fixture");

    const foreign = makeContext("pay-dem");
    rebindJob(foreign, "01J8ME0SXKQ4T9V2RC5HJ6WX7E");
    foreign.deps.receiptStore = {
      async claim() {
        return {
          status: "already-consumed",
          permitId: claimed.permitId!,
          claim: consumed.claim,
        };
      },
      consumePermit: (permitId) => backing.consumePermit(permitId),
    };

    const result = await verifySellerPaymentIntake(foreign.input, foreign.deps);
    expect(result).toEqual({
      disposition: "indeterminate",
      fulfilment: "none",
      reason: "receipt-store-invalid-result",
    });
  });

  it("recovers the exact consumed x402 claim after a later finality observation", async () => {
    const store = createInMemorySellerReceiptStore();
    const original = makeContext("pay-x402", store);
    const claimed = await verifySellerPaymentIntake(original.input, original.deps);
    if (!claimed.permitId) throw new Error("fixture");
    const consumed = await store.consumePermit(claimed.permitId);
    if (consumed.status === "invalid") throw new Error("fixture");

    const retry = makeContext("pay-x402", store);
    if (retry.x402Observation.status !== "finalized") throw new Error("fixture");
    retry.x402Observation.finalityObservedAt = 6_000;
    const recovered = await verifySellerPaymentIntake(retry.input, retry.deps);
    expect(recovered).toMatchObject({
      disposition: "verified",
      fulfilment: "already-claimed",
      reason: "payment-already-consumed",
      ...consumed.claim.authorization,
      permitId: claimed.permitId,
    });
  });

  it("replays the Standard SB-3 EIP-3009 nonce derivation vectors", () => {
    const set = JSON.parse(readFileSync(new URL(
      "../../vendor/DACS-Standard/conformance/vectors/security/sb3-eip3009-nonce-v0.1.json",
      import.meta.url,
    ), "utf8")) as {
      vectors: Array<{
        name: string;
        jobId: string;
        phaseIndex: number | string;
        expectedNonce?: string;
      }>;
    };
    for (const vector of set.vectors) {
      if (typeof vector.phaseIndex !== "number" || vector.phaseIndex < 0) {
        expect(
          () => x402Eip3009Nonce(vector.jobId, vector.phaseIndex as number),
          vector.name,
        ).toThrow();
      } else if (vector.expectedNonce) {
        expect(x402Eip3009Nonce(vector.jobId, vector.phaseIndex), vector.name)
          .toBe(vector.expectedNonce);
      }
    }
  });

  it("reconciles an ambiguous observation before claiming without rebroadcast", async () => {
    const store = createInMemorySellerReceiptStore();
    const ctx = makeContext("pay-x402", store);
    ctx.x402Observation = { status: "unavailable", reason: "rpc-timeout" };
    const ambiguous = await verifySellerPaymentIntake(ctx.input, ctx.deps);
    expect(ambiguous).toMatchObject({
      disposition: "indeterminate",
      fulfilment: "none",
      reason: "x402-unavailable",
    });

    ctx.x402Observation = makeContext("pay-x402").x402Observation;
    const reconciled = await verifySellerPaymentIntake(ctx.input, ctx.deps);
    expect(reconciled).toMatchObject({ disposition: "verified", fulfilment: "claim" });
  });

  it("falls back to SB-1/SB-2 when SB-3 is absent and discloses the weaker guarantee", async () => {
    const ctx = makeContext("pay-x402");
    if (ctx.x402Observation.status !== "finalized") throw new Error("fixture");
    ctx.x402Observation.sessionBinding = { kind: "absent" };
    const result = await verifySellerPaymentIntake(ctx.input, ctx.deps);
    expect(result).toMatchObject({
      disposition: "verified",
      fulfilment: "claim",
      sessionBinding: "not-established",
    });
  });

  it("preserves a PB-2 tier-2 destination resolver error", async () => {
    const ctx = makeContext("pay-x402");
    ctx.deps.resolvePayeeDestination = async () => ({
      disposition: "error",
      reason: "credential-verification-error",
      tier: 2,
    });

    const result = await verifySellerPaymentIntake(ctx.input, ctx.deps);

    expect(result).toEqual({
      disposition: "error",
      fulfilment: "none",
      reason: "payee-destination-credential-verification-error",
    });
  });

  it("rejects a false intrinsic tier-1 binding for x402", async () => {
    const ctx = makeContext("pay-x402");
    // Deliberately bypass the TypeScript boundary to exercise runtime input.
    ctx.deps.resolvePayeeDestination = (async () => ({
      disposition: "bound",
      address: PAYEE,
      tier: 1,
    })) as unknown as SellerPaymentIntakeDeps["resolvePayeeDestination"];

    const result = await verifySellerPaymentIntake(ctx.input, ctx.deps);

    expect(result).toEqual({
      disposition: "error",
      fulfilment: "none",
      reason: "address-binding-resolution-invalid-result",
    });
  });

  const mismatchCases: Array<{
    name: string;
    mutate: (ctx: Context) => void;
  }> = [
    { name: "job", mutate: (ctx) => { ctx.input.jobId = "wrong-job"; } },
    { name: "phase", mutate: (ctx) => {
      ctx.input.phaseIndex = PAYMENT_PHASE_INDEX + 1;
    } },
    { name: "agreement", mutate: (ctx) => {
      (ctx.agreement.terms as Record<string, unknown>).deadline = 9_999;
    } },
    { name: "rail", mutate: (ctx) => { ctx.input.railId = "x402:other"; } },
    { name: "payer", mutate: (ctx) => { ctx.input.payerPayingKey = "did:example:intruder"; } },
    { name: "payee", mutate: (ctx) => {
      if (ctx.x402Observation.status !== "finalized") throw new Error("fixture");
      ctx.x402Observation.payee = `0x${"44".repeat(20)}`;
    } },
    { name: "payout destination", mutate: (ctx) => {
      const terms = ctx.agreement.terms as { payoutBindings: Array<{ payeeAddress: string }> };
      terms.payoutBindings[0]!.payeeAddress = `0x${"55".repeat(20)}`;
      refreshCommitment(ctx);
    } },
    { name: "amount", mutate: (ctx) => {
      if (ctx.x402Observation.status !== "finalized") throw new Error("fixture");
      ctx.x402Observation.amountBaseUnits = "2499999";
    } },
    { name: "asset", mutate: (ctx) => {
      if (ctx.x402Observation.status !== "finalized") throw new Error("fixture");
      ctx.x402Observation.asset.symbol = "USDT";
    } },
    { name: "nonce", mutate: (ctx) => {
      if (ctx.x402Observation.status !== "finalized") throw new Error("fixture");
      ctx.x402Observation.sessionBinding = { kind: "eip3009", nonce: `0x${"00".repeat(32)}` };
    } },
    { name: "receipt hash", mutate: (ctx) => {
      if (ctx.input.receipt.kind !== "pay-x402") throw new Error("fixture");
      ctx.input.receipt.paymentReceiptHash = "00".repeat(32);
    } },
    { name: "chain", mutate: (ctx) => {
      if (ctx.input.receipt.kind !== "pay-x402") throw new Error("fixture");
      ctx.input.receipt.chainId = 1;
    } },
    { name: "finality", mutate: (ctx) => {
      if (ctx.x402Observation.status !== "finalized") throw new Error("fixture");
      ctx.x402Observation.confirmations = 2;
    } },
  ];

  for (const mismatch of mismatchCases) {
    it(`prevents fulfilment on a wrong ${mismatch.name}`, async () => {
      const ctx = makeContext("pay-x402");
      mismatch.mutate(ctx);
      const result = await verifySellerPaymentIntake(ctx.input, ctx.deps);
      expect(result.disposition).not.toBe("verified");
      expect(result.fulfilment).toBe("none");
    });
  }

  it("fails closed for a receipt whose rail variant differs from the phase", async () => {
    const ctx = makeContext("pay-dem");
    ctx.input.receipt = makeContext("pay-x402").input.receipt;
    const result = await verifySellerPaymentIntake(ctx.input, ctx.deps);
    expect(result).toMatchObject({
      disposition: "rejected",
      fulfilment: "none",
      reason: "receipt-rail-kind-mismatch",
    });
  });
});
