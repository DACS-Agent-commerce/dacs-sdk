import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { IdentityBundle, Listing, PaymentRailRef } from "../../src/artifacts/index.js";
import { canonicalize, contentHash, sha256Hex } from "../../src/canonical/index.js";
import {
  canonicalSellerSettlementId,
  createInMemorySellerReceiptStore,
  verifySellerPaymentIntake,
  x402Eip3009Nonce,
  type CommittedAgreementResolution,
  type DemosTransferObservation,
  type SellerPaymentIntakeDeps,
  type SellerPaymentIntakeInput,
  type SellerReceiptStore,
  type SellerSupportedRailDefinition,
  type X402TransferObservation,
} from "../../src/seller/index.js";

const BUYER_DEMOS = `did:demos:${"aa".repeat(32)}`;
const SELLER_DEMOS = `did:demos:${"bb".repeat(32)}`;
const BUYER = "did:example:buyer";
const SELLER = "did:example:seller";
const PAYER = `0x${"11".repeat(20)}`;
const PAYEE = `0x${"22".repeat(20)}`;
const DEMOS_TX = `0x${"ab".repeat(32)}`;
const EVM_TX = `0x${"cd".repeat(32)}`;
const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";

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

function hashBundle(bundle: IdentityBundle): string {
  return sha256Hex(canonicalize(bundle));
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
      deliverable: { kind: "external", description: "test output" },
    },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [
      { kind: "commit-payee-bound-agreement" },
      { kind, parameters: { rail: railRef.railId } },
      { kind: "deliver-attested-payload" },
    ],
    pricing: {
      kind: "fixed",
      price: { amount: isDemos ? "1.25" : "2.5", currency: isDemos ? "DEM" : "USDC" },
    },
    acceptedRails: [railRef],
    terms: {},
    validity: { notBefore: 0, notAfter: 20_000 },
    signature: { algorithm: "ed25519", signer: sellerBundle.presentedBy, value: "c2ln" },
  };
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
        bundleHash: hashBundle(buyerBundle),
        primaryClaim: buyerBundle.presentedBy,
        vetRecordRef: { kind: "composite", id: "buyer-vet", contentHash: "01" },
      },
      {
        role: "seller",
        bundleHash: hashBundle(sellerBundle),
        primaryClaim: sellerBundle.presentedBy,
        vetRecordRef: { kind: "composite", id: "seller-vet", contentHash: "02" },
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
        phaseIndex: 1,
        payeeAddress: isDemos ? "bb".repeat(32) : PAYEE,
      }],
    },
    derivedFromPattern: "fixed-price",
    generatedAt: 500,
    signatures: [
      { party: buyerBundle.presentedBy, algorithm: "ed25519", value: "c2ln" },
      { party: sellerBundle.presentedBy, algorithm: "ed25519", value: "c2ln" },
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
        phaseIndex: 1,
        railId: railRef.railId,
        payerPayingKey: BUYER_DEMOS,
        receipt: { kind: "pay-dem", txHash: DEMOS_TX },
      }
    : {
        jobId: JOB_ID,
        phaseIndex: 1,
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
    finalityObservedAt: 5_000,
    sessionBinding: { kind: "eip3009", nonce: x402Eip3009Nonce(JOB_ID, 1) },
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
    resolveListingAtCommit: async () => ({
      disposition: "verified",
      step: 9,
      reason: "verified",
      listing: ctx.listing,
      listingContentHash: listingRef.contentHash,
      revocation: "absent",
      railResolution: { disposition: "verified", reason: "verified" },
    }),
    resolveRail: async () => ({ disposition: "verified", rail: ctx.rail }),
    resolveIdentityBundle: async (hash) => ({
      disposition: "verified",
      bundle: hash === hashBundle(ctx.buyerBundle) ? ctx.buyerBundle : ctx.sellerBundle,
    }),
    resolvePayerAddress: async () => ({ disposition: "verified", address: PAYER }),
    resolvePayeeDestination: async () => ({
      disposition: "bound",
      address: PAYEE,
      tier: 3,
    }),
    observeDemosTransfer: async () => ctx.demosObservation,
    observeX402Transfer: async () => ctx.x402Observation,
    receiptStore: store,
  };
  return ctx;
}

function refreshCommitment(ctx: Context): void {
  const agreementHash = contentHash(ctx.agreement);
  ctx.committed.agreementHash = agreementHash;
  ctx.committed.commitment.agreementHash = agreementHash;
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

    // A fresh core/dependency graph simulates restart; the durable store is shared.
    const restarted = makeContext("pay-dem", store);
    const duplicate = await verifySellerPaymentIntake(restarted.input, restarted.deps);
    expect(duplicate).toMatchObject({
      disposition: "verified",
      fulfilment: "already-claimed",
    });
  });

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

  it("uses SB-1/SB-2 canonical identities and rejects cross-session reuse", async () => {
    expect(canonicalSellerSettlementId({ kind: "demos", txHash: DEMOS_TX }))
      .toBe(`demos:${"ab".repeat(32)}`);
    expect(canonicalSellerSettlementId({
      kind: "evm", chainId: 84532, txHash: EVM_TX.toUpperCase(), logIndex: 2,
    })).toBe(`evm:84532:${"cd".repeat(32)}:2`);
    expect(canonicalSellerSettlementId({
      kind: "evm", chainId: 84532, txHash: "abc", logIndex: 2,
    })).toBeNull();

    const store = createInMemorySellerReceiptStore([{
      settlementId: `demos:${"ab".repeat(32)}`,
      jobId: "another-job",
      phaseIndex: 1,
      evidenceHash: "ef".repeat(32),
    }]);
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
      const initial = Object.entries(vector.consumed).map(([id, binding]) => ({
        settlementId: id,
        jobId: binding.jobId,
        phaseIndex: binding.phaseIndex,
        evidenceHash: "00".repeat(32),
      }));
      const store = createInMemorySellerReceiptStore(initial);
      const result = await store.claim({
        settlementId: settlementId!,
        jobId: vector.record.jobId!,
        phaseIndex: vector.record.phaseIndex!,
        evidenceHash: "00".repeat(32),
      });
      const expectedStatus = vector.effect === "count"
        ? "claimed"
        : vector.effect === "already-counted"
          ? "already-claimed"
          : "conflict";
      expect(result.status, vector.name).toBe(expectedStatus);
    }
  });

  it("atomically grants one fulfilment claim under concurrent retries", async () => {
    const store = createInMemorySellerReceiptStore();
    const request = {
      settlementId: `demos:${"ef".repeat(32)}`,
      jobId: JOB_ID,
      phaseIndex: 1,
      evidenceHash: "01".repeat(32),
    };
    const results = await Promise.all(
      Array.from({ length: 12 }, () => store.claim(request)),
    );
    expect(results.filter((result) => result.status === "claimed")).toHaveLength(1);
    expect(results.filter((result) => result.status === "already-claimed")).toHaveLength(11);
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

  const mismatchCases: Array<{
    name: string;
    mutate: (ctx: Context) => void;
  }> = [
    { name: "job", mutate: (ctx) => { ctx.input.jobId = "wrong-job"; } },
    { name: "phase", mutate: (ctx) => { ctx.input.phaseIndex = 2; } },
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
