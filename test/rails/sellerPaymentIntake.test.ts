import { describe, expect, test, vi } from "vitest";

import { isSettlementEvidence } from "../../src/artifacts/index.js";
import { canonicalize, sha256Hex } from "../../src/canonical/index.js";
import {
  createInMemorySellerPaymentIntakeStore,
  payDemSettlementIdentity,
  sellerPaymentIntakeCore,
  sellerX402AuthorizationNonce,
  x402SettlementIdentity,
  type SellerCommittedAgreement,
  type SellerPaymentClaim,
  type SellerPaymentIntakeDeps,
  type SellerPaymentIntakeStore,
  type SellerPinnedListing,
  type SellerPinnedRail,
  type SellerRailPin,
  type VerifiedPayDemSellerReceipt,
  type VerifiedSellerReceipt,
  type VerifiedX402SellerReceipt,
} from "../../src/rails/sellerPaymentIntake.js";
import { verifyRailReceiptEvidence } from "../../src/rails/receiptEvidence.js";

const NOW = 1_780_000_000_000;
const TX_A = `0x${"ab".repeat(32)}`;
const TX_B = `0x${"cd".repeat(32)}`;
const PAYER_KEY = `0x${"11".repeat(20)}`;
const PAYEE_KEY = `0x${"22".repeat(20)}`;
const TOKEN = `0x${"33".repeat(20)}`;

interface Fixture {
  agreement: SellerCommittedAgreement;
  listing: SellerPinnedListing;
  rail: SellerPinnedRail;
  claim: SellerPaymentClaim;
  receipt: VerifiedSellerReceipt;
  deps: SellerPaymentIntakeDeps;
}

function x402Response(transactionHash = TX_A) {
  const settlementResponseJcs = canonicalize({
    network: "eip155:8453",
    success: true,
    transaction: transactionHash,
    x402Version: "2",
  });
  return {
    settlementResponseJcs,
    paymentReceiptHash: sha256Hex(settlementResponseJcs),
  };
}

function fixture(
  kind: "x402" | "pay-dem" = "x402",
  store: SellerPaymentIntakeStore = createInMemorySellerPaymentIntakeStore(),
): Fixture {
  const railPin: SellerRailPin = {
    railId: kind === "x402" ? "pay-x402-usdc" : "pay-dem",
    railVersion: 3,
    contentHash: kind === "x402" ? "rail-x402-hash" : "rail-dem-hash",
  };
  const listingPin = {
    listingId: "analysis-v1",
    version: 7,
    contentHash: "listing-content-hash",
  };
  const phaseKind = kind === "x402" ? "pay-x402" : "pay-dem";
  const currency = kind === "x402" ? "USDC" : "DEM";
  const payeeAddress = kind === "x402" ? PAYEE_KEY : "demos-seller-key";
  const payingKey = kind === "x402" ? PAYER_KEY : "demos-buyer-key";
  const agreement: SellerCommittedAgreement = {
    artifactKind: "payee-bound",
    ref: "agreement:job-113",
    contentHash: "agreement-content-hash",
    jobId: "job-113",
    listingPin,
    buyer: { primaryClaim: "did:demos:buyer", bundleHash: "buyer-bundle-hash" },
    seller: { primaryClaim: "did:demos:seller", bundleHash: "seller-bundle-hash" },
    price: { amount: "1000000", currency },
    railPin,
    payoutBindings: [{ railId: railPin.railId, phaseIndex: 1, payeeAddress }],
    signaturesVerified: true,
    commitment: {
      status: "finalized",
      ref: "commitment:job-113",
      agreementHash: "agreement-content-hash",
      recordContentHash: "commitment-record-hash",
      finalizedAt: NOW - 2_000,
    },
  };
  const listing: SellerPinnedListing = {
    pin: listingPin,
    sellerPrimaryClaim: agreement.seller.primaryClaim,
    pipeline: [
      { kind: "negotiate-fixed" },
      { kind: phaseKind, parameters: { rail: railPin.railId } },
    ],
  };
  const rail: SellerPinnedRail = {
    pin: railPin,
    railType: kind === "x402" ? "x402" : "demos-native",
    phaseHandler: phaseKind,
    asset: kind === "x402"
      ? { symbol: "USDC", identifier: TOKEN }
      : { symbol: "DEM" },
    network: kind === "x402" ? { kind: "evm", chainId: 8453 } : { kind: "demos" },
  };
  const claim: SellerPaymentClaim = {
    jobId: agreement.jobId,
    phaseIndex: 1,
    agreementRef: agreement.ref,
    agreementHash: agreement.contentHash,
    commitmentRef: agreement.commitment.ref,
    listingPin: { ...listingPin },
    railPin: { ...railPin },
    payer: {
      ...agreement.buyer,
      payingKey,
    },
    payee: {
      ...agreement.seller,
      payeeAddress,
    },
    amount: { ...agreement.price },
    receipt: { kind, message: { opaque: true } },
  };
  const receipt: VerifiedSellerReceipt = kind === "x402"
    ? {
        kind: "x402",
        railId: railPin.railId,
        payer: PAYER_KEY.toUpperCase(),
        payeeAddress: PAYEE_KEY.toUpperCase(),
        amount: claim.amount.amount,
        asset: TOKEN,
        responseNetwork: "eip155:8453",
        chainId: "eip155:8453",
        authorizationId: sellerX402AuthorizationNonce(claim.jobId, claim.phaseIndex)!,
        sessionBinding: {
          kind: "eip-3009",
          nonce: sellerX402AuthorizationNonce(claim.jobId, claim.phaseIndex)!,
        },
        protocolVersion: "2",
        httpResource: "https://seller.example/deliver",
        ...x402Response(),
        transactionHash: TX_A,
        logIndex: 4,
        blockNumber: 90,
        blockTimestamp: NOW - 1_000,
        finalityBlocks: 12,
        finality: { model: "block-depth", finalityObservedAt: NOW - 1_000 },
      }
    : {
        kind: "pay-dem",
        railId: railPin.railId,
        payer: payingKey,
        payeeAddress,
        amount: claim.amount.amount,
        asset: "DEM",
        network: "demos",
        transactionHash: "0xdemos-final-113",
        blockNumber: 42,
        included: true,
        finality: { model: "bft-final", finalityObservedAt: NOW - 500 },
      };
  const deps: SellerPaymentIntakeDeps = {
    resolveAgreement: async () => ({ status: "verified", value: agreement }),
    resolveListing: async () => ({ status: "verified", value: listing }),
    resolveRail: async () => ({ status: "verified", value: rail }),
    verifyX402Receipt: async () => ({
      status: "verified",
      receipt: receipt as VerifiedX402SellerReceipt,
    }),
    verifyPayDemReceipt: async () => ({
      status: "verified",
      receipt: receipt as VerifiedPayDemSellerReceipt,
    }),
    nowMs: () => NOW,
    store,
  };
  return { agreement, listing, rail, claim, receipt, deps };
}

function expectRejected(
  result: Awaited<ReturnType<typeof sellerPaymentIntakeCore>>,
  code: string,
) {
  expect(result).toMatchObject({ decision: "rejected", code });
}

describe("sellerPaymentIntakeCore", () => {
  test("accepts a fully bound x402 settlement and emits normative evidence input", async () => {
    const f = fixture();
    const result = await sellerPaymentIntakeCore(f.claim, f.deps);

    expect(result).toMatchObject({
      decision: "verified",
      duplicate: false,
      settlementIdentity: `evm:8453:${"ab".repeat(32)}:4`,
      fulfilment: { action: "enqueue" },
      evidenceInput: {
        evidenceVersion: "1",
        jobId: "job-113",
        phaseIndex: 1,
        outcome: "success",
        observedAt: NOW - 1_000,
        settlementFinality: {
          model: "block-depth",
          finalityBlocks: 12,
          finalityObservedAt: NOW - 1_000,
        },
      },
    });
    expect(result.decision === "verified" && isSettlementEvidence(result.evidenceInput)).toBe(true);
    if (result.decision === "verified") {
      expect(result.evidenceInput.paymentTxRefs[0]).toMatchObject({
        kind: "x402",
        httpResource: "https://seller.example/deliver",
        protocolVersion: "2",
        paymentReceiptHash: (f.receipt as VerifiedX402SellerReceipt).paymentReceiptHash,
        logIndex: 4,
      });
      expect(await verifyRailReceiptEvidence(
        result.evidenceInput as unknown as Record<string, unknown>,
        {
          verifyChainFinality: async (input) => ({
            status: "success",
            chainId: input.chainId,
            txHash: input.txHash,
            blockNumber: input.blockNumber,
            blockTimestamp: input.blockTimestamp,
            confirmations: input.finalityBlocks,
          }),
        },
      )).toEqual({ decision: "pass", reasons: [] });
    }
  });

  test("accepts an included, BFT-final native DEM settlement", async () => {
    const f = fixture("pay-dem");
    const result = await sellerPaymentIntakeCore(f.claim, f.deps);

    expect(result).toMatchObject({
      decision: "verified",
      settlementIdentity: "demos:0xdemos-final-113",
      evidenceInput: {
        paymentTxRefs: [{ rail: "demos", kind: "demos", blockNumber: 42 }],
        paymentAmount: { amount: "1000000", currency: "DEM" },
        settlementFinality: { model: "bft-final" },
      },
    });
  });

  test("accepts the pinned normative v2 x402 receipt-hash vector", async () => {
    const f = fixture();
    const receipt = f.receipt as VerifiedX402SellerReceipt;
    const vectorPayer = "0x857b06519E91e3A54538791bDbb0E22373e36b66";
    const vectorTx = "0x1fb8611c1aef418f2714dc5ec04f6856c3c2a6f64bf458462ee46329306c14de";
    receipt.payer = vectorPayer;
    receipt.responseNetwork = "eip155:84532";
    receipt.chainId = "eip155:84532";
    receipt.transactionHash = vectorTx;
    receipt.settlementResponseJcs =
      "{\"network\":\"eip155:84532\",\"payer\":\"0x857b06519E91e3A54538791bDbb0E22373e36b66\",\"success\":true,\"transaction\":\"0x1fb8611c1aef418f2714dc5ec04f6856c3c2a6f64bf458462ee46329306c14de\"}";
    receipt.paymentReceiptHash =
      "d8505c979c87711c9c0e88f43c4209dd9a256e9174bd641c72a12ebb78104332";
    f.claim.payer.payingKey = vectorPayer;
    f.rail.network = { kind: "evm", chainId: 84532 };

    expect((await sellerPaymentIntakeCore(f.claim, f.deps)).decision).toBe("verified");
  });

  type Mutator = (f: Fixture) => void;
  test.each<[string, Mutator, string]>([
    ["jobId", (f) => { f.claim.jobId = "wrong-job"; }, "job-mismatch"],
    ["phaseIndex", (f) => { f.claim.phaseIndex = 7; }, "phase-mismatch"],
    ["agreement hash", (f) => { f.claim.agreementHash = "wrong-hash"; }, "agreement-commitment-mismatch"],
    ["commitment ref", (f) => { f.claim.commitmentRef = "wrong-ref"; }, "agreement-commitment-mismatch"],
    ["Listing tuple", (f) => { f.claim.listingPin.contentHash = "wrong-listing"; }, "listing-pin-mismatch"],
    ["rail tuple", (f) => { f.claim.railPin.contentHash = "wrong-rail"; }, "rail-pin-mismatch"],
    ["payer claim", (f) => { f.claim.payer.primaryClaim = "did:demos:mallory"; }, "payer-mismatch"],
    ["payer bundle", (f) => { f.claim.payer.bundleHash = "wrong-bundle"; }, "payer-mismatch"],
    ["payee claim", (f) => { f.claim.payee.primaryClaim = "did:demos:mallory"; }, "payee-mismatch"],
    ["payee bundle", (f) => { f.claim.payee.bundleHash = "wrong-bundle"; }, "payee-mismatch"],
    ["payout destination", (f) => { f.claim.payee.payeeAddress = "0xwrong"; }, "payout-destination-mismatch"],
    ["amount", (f) => { f.claim.amount.amount = "999999"; }, "amount-mismatch"],
    ["asset symbol", (f) => { f.claim.amount.currency = "DAI"; }, "amount-mismatch"],
    ["receipt payer", (f) => { f.receipt.payer = "0xwrong"; }, "receipt-terms-mismatch"],
    ["receipt payee", (f) => { f.receipt.payeeAddress = "0xwrong"; }, "receipt-terms-mismatch"],
    ["receipt amount", (f) => { f.receipt.amount = "999999"; }, "receipt-terms-mismatch"],
    ["receipt asset identity", (f) => { f.receipt.asset = "0xwrong" as "DEM"; }, "receipt-terms-mismatch"],
  ])("rejects a wrong %s", async (_label, mutate, code) => {
    const f = fixture();
    mutate(f);
    expectRejected(await sellerPaymentIntakeCore(f.claim, f.deps), code);
  });

  test("rejects incomplete or duplicate agreement payout bindings", async () => {
    const missing = fixture();
    missing.agreement.payoutBindings = [];
    expectRejected(
      await sellerPaymentIntakeCore(missing.claim, missing.deps),
      "payout-binding-coverage",
    );

    const duplicate = fixture();
    duplicate.listing.pipeline.push({
      kind: "pay-x402",
      parameters: { rail: duplicate.claim.railPin.railId },
    });
    duplicate.agreement.payoutBindings.push({
      ...duplicate.agreement.payoutBindings[0]!,
    });
    expectRejected(
      await sellerPaymentIntakeCore(duplicate.claim, duplicate.deps),
      "payout-binding-coverage",
    );
  });

  test.each([
    ["chain", (receipt: VerifiedX402SellerReceipt) => { receipt.chainId = "eip155:1"; }, "x402-finality-mismatch"],
    ["receipt hash", (receipt: VerifiedX402SellerReceipt) => { receipt.paymentReceiptHash = "0".repeat(64); }, "x402-receipt-hash-mismatch"],
    ["canonical response", (receipt: VerifiedX402SellerReceipt) => { receipt.settlementResponseJcs = "{\"success\":true, \"network\":\"eip155:8453\"}"; }, "x402-receipt-malformed"],
    ["resource", (receipt: VerifiedX402SellerReceipt) => { receipt.httpResource = ""; }, "x402-finality-mismatch"],
    ["finality", (receipt: VerifiedX402SellerReceipt) => { receipt.finalityBlocks = 0; }, "x402-finality-mismatch"],
    ["session nonce", (receipt: VerifiedX402SellerReceipt) => { receipt.sessionBinding = { kind: "eip-3009", nonce: `0x${"00".repeat(32)}` }; }, "x402-session-binding-mismatch"],
  ] as Array<[string, (receipt: VerifiedX402SellerReceipt) => void, string]>) (
    "rejects a wrong x402 %s",
    async (_label, mutate, code) => {
      const f = fixture();
      mutate(f.receipt as VerifiedX402SellerReceipt);
      expectRejected(await sellerPaymentIntakeCore(f.claim, f.deps), code);
    },
  );

  test("rejects pay-DEM without inclusion and BFT finality", async () => {
    const f = fixture("pay-dem");
    const receipt = f.receipt as VerifiedPayDemSellerReceipt;
    (receipt as { included: boolean }).included = false;
    expectRejected(
      await sellerPaymentIntakeCore(f.claim, f.deps),
      "pay-dem-finality-mismatch",
    );
  });

  test("deduplicates atomically across retries and restarted core instances", async () => {
    const store = createInMemorySellerPaymentIntakeStore();
    const firstFixture = fixture("x402", store);
    const first = await sellerPaymentIntakeCore(firstFixture.claim, firstFixture.deps);

    const restarted = fixture("x402", store);
    restarted.deps.nowMs = () => NOW + 30_000;
    const second = await sellerPaymentIntakeCore(restarted.claim, restarted.deps);

    expect(first).toMatchObject({ decision: "verified", duplicate: false });
    expect(second).toMatchObject({
      decision: "verified",
      duplicate: true,
      fulfilment: { action: "already-enqueued" },
    });
    if (first.decision === "verified" && second.decision === "verified") {
      expect(second.evidenceHash).toBe(first.evidenceHash);
      expect(second.fulfilment.fulfilmentId).toBe(first.fulfilment.fulfilmentId);
    }
  });

  test("serializes concurrent duplicate intake to one fulfilment enqueue", async () => {
    const f = fixture();
    const results = await Promise.all([
      sellerPaymentIntakeCore(f.claim, f.deps),
      sellerPaymentIntakeCore(f.claim, f.deps),
    ]);
    expect(results.filter((result) =>
      result.decision === "verified" && result.fulfilment.action === "enqueue"
    )).toHaveLength(1);
    expect(results.filter((result) =>
      result.decision === "verified" && result.fulfilment.action === "already-enqueued"
    )).toHaveLength(1);
  });

  test("rejects settlement reuse across sessions", async () => {
    const store = createInMemorySellerPaymentIntakeStore();
    const first = fixture("x402", store);
    expect((await sellerPaymentIntakeCore(first.claim, first.deps)).decision).toBe("verified");

    const replay = fixture("x402", store);
    replay.claim.jobId = "job-other";
    replay.agreement.jobId = "job-other";
    const receipt = replay.receipt as VerifiedX402SellerReceipt;
    receipt.authorizationId = sellerX402AuthorizationNonce("job-other", 1)!;
    receipt.sessionBinding = { kind: "eip-3009", nonce: receipt.authorizationId };
    expectRejected(
      await sellerPaymentIntakeCore(replay.claim, replay.deps),
      "settlement-replay",
    );
  });

  test("rejects authorization reuse even when the transaction differs", async () => {
    const store = createInMemorySellerPaymentIntakeStore();
    const first = fixture("x402", store);
    const firstReceipt = first.receipt as VerifiedX402SellerReceipt;
    firstReceipt.authorizationId = "permit2:authorization-113";
    firstReceipt.sessionBinding = { kind: "permit2-witness", jobId: "job-113", phaseIndex: 1 };
    expect((await sellerPaymentIntakeCore(first.claim, first.deps)).decision).toBe("verified");

    const replay = fixture("x402", store);
    replay.claim.jobId = "job-other";
    replay.agreement.jobId = "job-other";
    const receipt = replay.receipt as VerifiedX402SellerReceipt;
    receipt.transactionHash = TX_B;
    Object.assign(receipt, x402Response(TX_B));
    receipt.authorizationId = firstReceipt.authorizationId;
    receipt.sessionBinding = { kind: "permit2-witness", jobId: "job-other", phaseIndex: 1 };
    expectRejected(
      await sellerPaymentIntakeCore(replay.claim, replay.deps),
      "authorization-replay",
    );
  });

  test("reconciles an ambiguous receipt by deterministic identity before deciding", async () => {
    const f = fixture();
    const receipt = f.receipt as VerifiedX402SellerReceipt;
    const settlementIdentity = x402SettlementIdentity(receipt)!;
    const authorizationIdentity = `x402:${receipt.authorizationId}`;
    const reconcileReceipt = vi.fn(async () => ({
      status: "verified" as const,
      receipt,
    }));
    f.deps.verifyX402Receipt = async () => ({
      status: "ambiguous",
      settlementIdentity,
      authorizationIdentity,
      reason: "submission response was lost",
    });
    f.deps.reconcileReceipt = reconcileReceipt;

    expect((await sellerPaymentIntakeCore(f.claim, f.deps)).decision).toBe("verified");
    expect(reconcileReceipt).toHaveBeenCalledWith({
      kind: "x402",
      settlementIdentity,
      authorizationIdentity,
    });
  });

  test.each([
    [true, true],
    [false, false],
  ])("marks retry safety only for authoritative absence (%s)", async (authoritative, safeToRetry) => {
    const f = fixture();
    const receipt = f.receipt as VerifiedX402SellerReceipt;
    f.deps.verifyX402Receipt = async () => ({
      status: "ambiguous",
      settlementIdentity: x402SettlementIdentity(receipt)!,
      authorizationIdentity: `x402:${receipt.authorizationId}`,
      reason: "timeout",
    });
    f.deps.reconcileReceipt = async () => ({ status: "absent", authoritative });
    expect(await sellerPaymentIntakeCore(f.claim, f.deps)).toMatchObject({
      decision: "indeterminate",
      code: "settlement-not-found",
      safeToRetry,
    });
  });

  test("fails closed when ambiguous settlement reconciliation is unavailable", async () => {
    const f = fixture();
    const receipt = f.receipt as VerifiedX402SellerReceipt;
    f.deps.verifyX402Receipt = async () => ({
      status: "ambiguous",
      settlementIdentity: x402SettlementIdentity(receipt)!,
      authorizationIdentity: `x402:${receipt.authorizationId}`,
      reason: "timeout",
    });
    expect(await sellerPaymentIntakeCore(f.claim, f.deps)).toMatchObject({
      decision: "indeterminate",
      code: "reconciliation-required",
      safeToRetry: false,
    });
  });

  test("rejects receipts observed in the future", async () => {
    const f = fixture();
    (f.receipt as VerifiedX402SellerReceipt).blockTimestamp = NOW + 1;
    (f.receipt as VerifiedX402SellerReceipt).finality.finalityObservedAt = NOW + 1;
    expectRejected(
      await sellerPaymentIntakeCore(f.claim, f.deps),
      "receipt-time-invalid",
    );
  });
});

describe("seller settlement identity helpers", () => {
  test("derives exact SB-1 identities", () => {
    expect(x402SettlementIdentity({
      chainId: "eip155:8453",
      transactionHash: TX_A.toUpperCase(),
      logIndex: 4,
    })).toBe(`evm:8453:${"ab".repeat(32)}:4`);
    expect(payDemSettlementIdentity(" 0xdemos ")).toBe("demos:0xdemos");
    expect(x402SettlementIdentity({ chainId: "8453", transactionHash: TX_A, logIndex: 4 })).toBeNull();
  });

  test("derives the SB-3 nonce from NFC jobId and minimal phaseIndex", () => {
    const vectors = [
      ["practice-dacs-0001", 3, "0x2fc3598e85489ed2fb4d2bf9f4eb5cc8dd6998eec89645d64450f9630240e1ff"],
      ["practice-dacs-0001", 4, "0x80fa47321a52f728f5ecbde7a5ceb44dd6086c9902dd8b95980b05909e5ea969"],
      ["practice-dacs-0002", 3, "0x69256a3bf1c9bd6a5ba1ffc93705d44c5322e03de8f1e3ad6b6d709f4254ce29"],
      ["cafe\u0301-job", 0, "0xc4d6eb3c8774ff6078765567559c1ce1953badb01ba1ea8a5252561712294397"],
      ["01ARZ3NDEKTSV4RRFFQ69G5FAV", 3, "0xaeed3b79a6eedc2c19ce773a286dc5a897271cd92ed41a7f7ae5847fe3c9e9e2"],
    ] as const;
    for (const [jobId, phaseIndex, expected] of vectors) {
      expect(sellerX402AuthorizationNonce(jobId, phaseIndex)).toBe(expected);
    }
    expect(sellerX402AuthorizationNonce("cafe\u0301", 1)).toBe(
      sellerX402AuthorizationNonce("caf\u00e9", 1),
    );
    expect(sellerX402AuthorizationNonce("caf\u00e9", -1)).toBeNull();
  });
});
