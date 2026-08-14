import { describe, expect, it, vi } from "vitest";

import type {
  AnchorReceipt,
  AttestationRef,
  SettlementEvidence,
} from "../../src/artifacts/types.js";
import { contentHash } from "../../src/canonical/index.js";
import {
  createBuyerPaymentEvidenceHandshake,
  createInMemoryPaymentEvidenceHandshakeStore,
  createPaymentEvidenceAnchorRequest,
  createSellerPaymentEvidenceHandshake,
  type PaymentEvidenceAnchorCompletion,
  type PaymentEvidenceAnchorRequest,
} from "../../src/commerce/index.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const SELLER = "did:example:seller";
const BUYER = "did:example:buyer";
const NOW = 7_000;
const AUTH_HASH = "a".repeat(64);
const COMPLETION_AUTH_HASH = "b".repeat(64);

function evidence(): SettlementEvidence {
  return {
    evidenceVersion: "1",
    jobId: JOB_ID,
    phase: "pay-x402",
    outcome: "success",
    paymentTxRefs: [{
      kind: "x402-event",
      httpResource: "https://seller.example/orders/1",
      paymentReceiptHash: "c".repeat(64),
      settlementTxHash: "d".repeat(64),
      chainId: 8453,
      logIndex: 2,
      protocolVersion: "2",
    }],
    paymentAmount: { amount: "1", currency: "USDC" },
    settlementFinality: {
      model: "provider-receipt",
      finalityObservedAt: NOW,
    },
    observedAt: NOW,
    signature: { algorithm: "ed25519", signer: SELLER, value: "c2ln" },
  };
}

function finalAnchor(request: PaymentEvidenceAnchorRequest): {
  evidenceRef: AttestationRef;
  anchorReceipt: AnchorReceipt;
} {
  return {
    evidenceRef: {
      anchor: { kind: "storage-program", locator: request.logicalAddress },
      contentHash: request.evidenceHash,
      signer: SELLER,
    },
    anchorReceipt: {
      receiptVersion: "1",
      substrate: "demos",
      finalityProfile: "demos-bft",
      logicalAddress: request.logicalAddress,
      nativeAddress: `native:${request.logicalAddress}`,
      contentHash: request.evidenceHash,
      transactionRef: { kind: "demos", value: `tx:${request.evidenceHash}` },
      writer: BUYER,
      state: "finalized",
      observationDisposition: "established",
      observedAt: NOW,
      blockRef: { id: "block-10", height: "10", timestamp: NOW },
      evidence: { kind: "demos-bft-proof", value: "proof" },
    },
  };
}

function seller(store = createInMemoryPaymentEvidenceHandshakeStore()) {
  return createSellerPaymentEvidenceHandshake({
    store,
    seller: SELLER,
    buyer: BUYER,
    authenticateCompletion: () => ({
      disposition: "authenticated",
      authenticationHash: COMPLETION_AUTH_HASH,
    }),
    verifyAnchorReceipt: () => ({ disposition: "valid" }),
    now: () => NOW,
  });
}

function buyer(
  store = createInMemoryPaymentEvidenceHandshakeStore(),
  anchor = vi.fn((input: { logicalAddress: string; evidenceHash: string }) => ({
    disposition: "anchored" as const,
    ...finalAnchor({
      logicalAddress: input.logicalAddress,
      evidenceHash: input.evidenceHash,
    } as PaymentEvidenceAnchorRequest),
  })),
) {
  return {
    anchor,
    handshake: createBuyerPaymentEvidenceHandshake({
      store,
      buyer: BUYER,
      workerId: "buyer-wallet-worker",
      authenticateRequest: () => ({
        disposition: "authenticated",
        authenticationHash: AUTH_HASH,
      }),
      verifyEvidence: () => ({ disposition: "valid" }),
      anchorEvidence: anchor,
      verifyAnchorReceipt: () => ({ disposition: "valid" }),
      now: () => NOW,
    }),
  };
}

async function queueRequest(
  handshake: ReturnType<typeof seller>,
): Promise<PaymentEvidenceAnchorRequest> {
  const artifact = evidence();
  const result = await handshake.anchorEvidence({
    effectId: `payment-evidence:${JOB_ID}:3`,
    logicalAddress: `dacs4:payment:${JOB_ID}:rail-x402-base:3`,
    evidenceHash: contentHash(artifact as unknown as Record<string, unknown>),
    evidence: artifact,
    expectedWriter: { role: "buyer", primaryClaim: BUYER },
  });
  expect(result).toEqual({
    disposition: "indeterminate",
    reason: "payment-evidence buyer anchor request is durably pending",
  });
  return (await handshake.listOutboundRequests())[0]!;
}

describe("actor-separated payment-evidence handshake", () => {
  it("anchors through the buyer authority and replays without a second write", async () => {
    const sellerStore = createInMemoryPaymentEvidenceHandshakeStore();
    const buyerStore = createInMemoryPaymentEvidenceHandshakeStore();
    const sellerHandshake = seller(sellerStore);
    const { handshake: buyerHandshake, anchor } = buyer(buyerStore);
    const request = await queueRequest(sellerHandshake);

    expect(await buyerHandshake.receiveRequest(structuredClone(request))).toBe("accepted");
    expect(await buyerHandshake.receiveRequest(structuredClone(request))).toBe("existing");
    expect(await buyerHandshake.runPending()).toEqual([{
      messageId: request.messageId,
      status: "completed",
    }]);
    expect(await buyerHandshake.runPending()).toEqual([]);
    expect(anchor).toHaveBeenCalledTimes(1);

    const completion = (await buyerHandshake.listOutboundCompletions())[0]!;
    expect(await sellerHandshake.receiveCompletion(structuredClone(completion)))
      .toBe("accepted");
    expect(await sellerHandshake.receiveCompletion(structuredClone(completion)))
      .toBe("existing");

    const completed = await sellerHandshake.anchorEvidence({
      effectId: request.effectId,
      logicalAddress: request.logicalAddress,
      evidenceHash: request.evidenceHash,
      evidence: request.evidence,
      expectedWriter: request.expectedWriter,
    });
    expect(completed.disposition).toBe("anchored");
    expect(anchor).toHaveBeenCalledTimes(1);
  });

  it("survives a lost completion by replaying the durable buyer outbox", async () => {
    const sellerHandshake = seller();
    const { handshake: buyerHandshake, anchor } = buyer();
    const request = await queueRequest(sellerHandshake);
    await buyerHandshake.receiveRequest(request);
    await buyerHandshake.runPending();

    const lost = (await buyerHandshake.listOutboundCompletions())[0]!;
    const replayed = (await buyerHandshake.listOutboundCompletions())[0]!;
    expect(replayed).toEqual(lost);
    await sellerHandshake.receiveCompletion(replayed);
    expect(anchor).toHaveBeenCalledTimes(1);
  });

  it("rejects completion-before-request and receipt substitution", async () => {
    const sellerHandshake = seller();
    const { handshake: buyerHandshake } = buyer();
    const request = await queueRequest(sellerHandshake);
    await buyerHandshake.receiveRequest(request);
    await buyerHandshake.runPending();
    const completion = (await buyerHandshake.listOutboundCompletions())[0]!;

    await expect(seller().receiveCompletion(completion))
      .rejects.toThrow(/no retained seller request/);

    const substituted = structuredClone(completion) as unknown as {
      anchorReceipt: { writer: string };
    };
    substituted.anchorReceipt.writer = "did:example:attacker";
    await expect(sellerHandshake.receiveCompletion(
      substituted as unknown as PaymentEvidenceAnchorCompletion,
    ))
      .rejects.toThrow(/malformed|does not bind/);
  });

  it("refuses a valid request addressed to another buyer authority", async () => {
    const sellerHandshake = seller();
    const request = await queueRequest(sellerHandshake);
    const wrongBuyer = createBuyerPaymentEvidenceHandshake({
      store: createInMemoryPaymentEvidenceHandshakeStore(),
      buyer: "did:example:different-buyer",
      workerId: "wrong-wallet-worker",
      authenticateRequest: () => ({
        disposition: "authenticated",
        authenticationHash: AUTH_HASH,
      }),
      verifyEvidence: () => ({ disposition: "valid" }),
      anchorEvidence: () => ({ disposition: "indeterminate", reason: "must not run" }),
      verifyAnchorReceipt: () => ({ disposition: "valid" }),
    });
    await expect(wrongBuyer.receiveRequest(request))
      .rejects.toThrow(/different buyer/);
  });

  it("does not retain a completion after its buyer lease expires", async () => {
    let now = NOW;
    let retainedFence: { assertCurrent(): Promise<void>; generation: number } | undefined;
    const store = createInMemoryPaymentEvidenceHandshakeStore();
    const sellerHandshake = seller();
    const request = await queueRequest(sellerHandshake);
    const buyerHandshake = createBuyerPaymentEvidenceHandshake({
      store,
      buyer: BUYER,
      workerId: "buyer-wallet-worker",
      leaseDurationMs: 10,
      now: () => now,
      authenticateRequest: () => ({
        disposition: "authenticated",
        authenticationHash: AUTH_HASH,
      }),
      verifyEvidence: () => ({ disposition: "valid" }),
      anchorEvidence: (_input, fence) => {
        retainedFence = fence;
        now += 11;
        return { disposition: "anchored", ...finalAnchor(request) };
      },
      verifyAnchorReceipt: () => ({ disposition: "valid" }),
    });
    await buyerHandshake.receiveRequest(request);
    expect((await buyerHandshake.runPending())[0]?.status).toBe("stale");
    await expect(retainedFence?.assertCurrent()).rejects.toThrow(/stale/);
    expect(await buyerHandshake.listOutboundCompletions()).toEqual([]);

    await buyerHandshake.runPending();
    const loaded = await store.load("buyer", request.messageId);
    expect(loaded.status === "ok" ? loaded.record.leaseGeneration : -1).toBe(2);
  });

  it("isolates retained state from transport callback mutation", async () => {
    const sellerHandshake = seller();
    const request = await queueRequest(sellerHandshake);
    const store = createInMemoryPaymentEvidenceHandshakeStore();
    const buyerHandshake = createBuyerPaymentEvidenceHandshake({
      store,
      buyer: BUYER,
      workerId: "buyer-wallet-worker",
      authenticateRequest: (candidate) => {
        (candidate as { buyer: string }).buyer = "did:example:attacker";
        return { disposition: "authenticated", authenticationHash: AUTH_HASH };
      },
      verifyEvidence: () => ({ disposition: "valid" }),
      anchorEvidence: () => ({ disposition: "indeterminate", reason: "unused" }),
      verifyAnchorReceipt: () => ({ disposition: "valid" }),
    });
    await expect(buyerHandshake.receiveRequest(request)).resolves.toBe("accepted");
    const loaded = await store.load("buyer", request.messageId);
    expect(loaded.status === "ok" ? loaded.record.request.buyer : null).toBe(BUYER);
  });

  it("rejects non-canonical payment anchor addresses before transport", () => {
    const artifact = evidence();
    expect(() => createPaymentEvidenceAnchorRequest({
      seller: SELLER,
      buyer: BUYER,
      effectId: `payment-evidence:${JOB_ID}:3`,
      logicalAddress: `dacs4:payment:${JOB_ID}:3`,
      evidenceHash: contentHash(artifact as unknown as Record<string, unknown>),
      evidence: artifact,
      expectedWriter: { role: "buyer", primaryClaim: BUYER },
    })).toThrow(/cannot be derived safely/);
  });

  it("does not publish a buyer completion when independent receipt verification fails", async () => {
    const sellerHandshake = seller();
    const request = await queueRequest(sellerHandshake);
    const handshake = createBuyerPaymentEvidenceHandshake({
      store: createInMemoryPaymentEvidenceHandshakeStore(),
      buyer: BUYER,
      workerId: "buyer-wallet-worker",
      authenticateRequest: () => ({
        disposition: "authenticated",
        authenticationHash: AUTH_HASH,
      }),
      verifyEvidence: () => ({ disposition: "valid" }),
      anchorEvidence: () => ({ disposition: "anchored", ...finalAnchor(request) }),
      verifyAnchorReceipt: () => ({
        disposition: "invalid",
        reason: "native proof does not authenticate",
      }),
      now: () => NOW,
    });
    await handshake.receiveRequest(request);
    expect(await handshake.runPending()).toEqual([{
      messageId: request.messageId,
      status: "rejected",
      reason: "native proof does not authenticate",
    }]);
    expect(await handshake.listOutboundCompletions()).toEqual([]);
  });

  it("refuses seller evidence that fails cryptographic verification", async () => {
    const sellerHandshake = seller();
    const request = await queueRequest(sellerHandshake);
    const store = createInMemoryPaymentEvidenceHandshakeStore();
    const anchor = vi.fn();
    const handshake = createBuyerPaymentEvidenceHandshake({
      store,
      buyer: BUYER,
      workerId: "buyer-wallet-worker",
      authenticateRequest: () => ({
        disposition: "authenticated",
        authenticationHash: AUTH_HASH,
      }),
      verifyEvidence: () => ({
        disposition: "invalid",
        reason: "seller signature is invalid",
      }),
      anchorEvidence: anchor,
      verifyAnchorReceipt: () => ({ disposition: "valid" }),
    });
    await expect(handshake.receiveRequest(request))
      .rejects.toThrow(/seller signature is invalid/);
    expect(await store.load("buyer", request.messageId)).toEqual({ status: "missing" });
    expect(anchor).not.toHaveBeenCalled();
  });

  it("fails closed when an inbox returns corrupt retained state", async () => {
    const sellerHandshake = seller();
    const request = await queueRequest(sellerHandshake);
    const retained = createInMemoryPaymentEvidenceHandshakeStore();
    const { handshake: setup } = buyer(retained);
    await setup.receiveRequest(request);
    const loaded = await retained.load("buyer", request.messageId);
    expect(loaded.status).toBe("ok");
    const corrupt = structuredClone(loaded.status === "ok" ? loaded.record : null) as
      unknown as { leaseGeneration: number; role: "buyer" };
    corrupt.leaseGeneration = 2;
    const store = {
      ...retained,
      list: async () => [{ status: "ok" as const, record: corrupt }],
    };
    const { handshake } = buyer(store as unknown as typeof retained);
    await expect(handshake.runPending()).rejects.toThrow(/lease history is inconsistent/);
  });
});
