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
  FIXED_PRICE_X402_COMMERCE_PROFILE,
  FIXED_PRICE_X402_REGISTRY_INDEX_REF,
  FIXED_PRICE_X402_STANDARD_REVISION,
  fixedPriceX402ProtocolBindingHash,
  paymentEvidenceHandshakeScopeHash,
  type BuyerPaymentEvidenceHandshakeOptions,
  type FixedPriceX402ProtocolBinding,
  type PaymentEvidenceAnchorCompletion,
  type PaymentEvidenceAnchorFence,
  type PaymentEvidenceAnchorRequest,
  type PaymentEvidenceAuthenticatedPeer,
} from "../../src/commerce/index.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const SELLER = "did:example:seller";
const BUYER = "did:example:buyer";
const AUTH_HASH = "a".repeat(64);
const COMPLETION_AUTH_HASH = "b".repeat(64);
const ABSENCE_HASH = "e".repeat(64);

const PROTOCOL: FixedPriceX402ProtocolBinding = {
  commerceProfile: FIXED_PRICE_X402_COMMERCE_PROFILE,
  standardRevision: FIXED_PRICE_X402_STANDARD_REVISION,
  phase: "pay-x402",
  orchestratorTopology: "seller-as-phase-orchestrator-v1",
  orchestrator: SELLER,
  rail: {
    registryIndexRef: FIXED_PRICE_X402_REGISTRY_INDEX_REF,
    registryIndexHash: "1".repeat(64),
    railDefinitionRef: "dacs4:rail:x402%3Adefault:2",
    railDefinitionHash: "2".repeat(64),
    railId: "x402:default",
    railVersion: 2,
    railType: "x402",
    phaseHandler: "pay-x402",
    network: "eip155:8453",
    availability: "live",
  },
};
const SCOPE_HASH = paymentEvidenceHandshakeScopeHash({
  seller: SELLER,
  buyer: BUYER,
  protocolHash: fixedPriceX402ProtocolBindingHash(PROTOCOL),
});

function txHash(index: number): string {
  return (index + 1).toString(16).padStart(64, "0");
}

function evidence(index = 0, outcome: "success" | "failure" = "success"): SettlementEvidence {
  const base = {
    evidenceVersion: "1" as const,
    jobId: JOB_ID,
    phase: "pay-x402" as const,
    observedAt: 7_000 + index,
    signature: { algorithm: "ed25519" as const, signer: SELLER, value: "c2ln" },
  };
  if (outcome === "failure") {
    return { ...base, outcome, reason: "x402-server-refused" };
  }
  return {
    ...base,
    outcome,
    paymentTxRefs: [{
      kind: "x402-event",
      httpResource: `https://seller.example/orders/${index}`,
      paymentReceiptHash: txHash(index + 100),
      settlementTxHash: txHash(index),
      chainId: 8453,
      logIndex: index,
      protocolVersion: "2",
    }],
    paymentAmount: { amount: "1", currency: "USDC" },
    settlementFinality: {
      model: "provider-receipt",
      finalityObservedAt: 7_000 + index,
    },
  };
}

function request(index = 0, overrides: Readonly<{
  effectId?: string;
  logicalAddress?: string;
  evidence?: SettlementEvidence;
}> = {}): PaymentEvidenceAnchorRequest {
  const artifact = overrides.evidence ?? evidence(index);
  return createPaymentEvidenceAnchorRequest({
    seller: SELLER,
    buyer: BUYER,
    protocol: PROTOCOL,
    effectId: overrides.effectId ?? `payment-evidence:${JOB_ID}:${index}`,
    logicalAddress: overrides.logicalAddress ??
      `dacs4:payment:${JOB_ID}:x402%3Adefault:${index}`,
    evidenceHash: contentHash(artifact as unknown as Record<string, unknown>),
    evidence: artifact,
    expectedWriter: { role: "buyer", primaryClaim: BUYER },
  });
}

function finalAnchor(candidate: PaymentEvidenceAnchorRequest): {
  evidenceRef: AttestationRef;
  anchorReceipt: AnchorReceipt;
} {
  return {
    evidenceRef: {
      anchor: { kind: "storage-program", locator: candidate.logicalAddress },
      contentHash: candidate.evidenceHash,
      signer: SELLER,
    },
    anchorReceipt: {
      receiptVersion: "1",
      substrate: "demos",
      finalityProfile: "demos-bft",
      logicalAddress: candidate.logicalAddress,
      nativeAddress: `native:${candidate.logicalAddress}`,
      contentHash: candidate.evidenceHash,
      transactionRef: { kind: "demos", value: `tx:${candidate.evidenceHash}` },
      writer: BUYER,
      state: "finalized",
      observationDisposition: "established",
      observedAt: 7_000,
      blockRef: { id: "block-10", height: "10", timestamp: 7_000 },
      evidence: { kind: "demos-bft-proof", value: "proof" },
    },
  };
}

function requestPeer(candidate: PaymentEvidenceAnchorRequest): PaymentEvidenceAuthenticatedPeer {
  return {
    principal: candidate.seller,
    audience: candidate.buyer,
    messageId: candidate.messageId,
    messageHash: candidate.requestHash,
    authenticationHash: AUTH_HASH,
  };
}

function completionPeer(
  candidate: PaymentEvidenceAnchorCompletion,
): PaymentEvidenceAuthenticatedPeer {
  return {
    principal: BUYER,
    audience: SELLER,
    messageId: candidate.messageId,
    messageHash: candidate.completionHash,
    authenticationHash: COMPLETION_AUTH_HASH,
  };
}

function seller(
  store = createInMemoryPaymentEvidenceHandshakeStore(),
  authenticateCompletion = (candidate: PaymentEvidenceAnchorCompletion) => ({
    disposition: "authenticated" as const,
    peer: completionPeer(candidate),
  }),
) {
  return createSellerPaymentEvidenceHandshake({
    store,
    seller: SELLER,
    buyer: BUYER,
    workerId: "seller-transport-worker",
    protocol: PROTOCOL,
    authenticateCompletion,
    verifyAnchorReceipt: () => ({ disposition: "valid" }),
  });
}

function buyer(input: Readonly<{
  store?: ReturnType<typeof createInMemoryPaymentEvidenceHandshakeStore>;
  anchor?: ReturnType<typeof vi.fn>;
  reconcile?: ReturnType<typeof vi.fn>;
  verifyReceipt?: ReturnType<typeof vi.fn>;
  leaseDurationMs?: number;
  retryDelayMs?: number;
}> = {}) {
  const store = input.store ?? createInMemoryPaymentEvidenceHandshakeStore();
  const anchor = input.anchor ?? vi.fn((effect: { logicalAddress: string; evidenceHash: string }) => ({
    disposition: "anchored" as const,
    ...finalAnchor({
      logicalAddress: effect.logicalAddress,
      evidenceHash: effect.evidenceHash,
    } as PaymentEvidenceAnchorRequest),
  }));
  const reconcile = input.reconcile ?? vi.fn(() => ({
    disposition: "indeterminate" as const,
    reason: "not-used",
  }));
  const verifyReceipt = input.verifyReceipt ?? vi.fn(() => ({ disposition: "valid" as const }));
  return {
    anchor,
    reconcile,
    verifyReceipt,
    handshake: createBuyerPaymentEvidenceHandshake({
      store,
      seller: SELLER,
      buyer: BUYER,
      protocol: PROTOCOL,
      workerId: "buyer-wallet-worker",
      authenticateRequest: (candidate) => ({
        disposition: "authenticated",
        peer: requestPeer(candidate),
      }),
      verifyEvidence: () => ({ disposition: "valid" }),
      anchorEvidence: anchor as unknown as BuyerPaymentEvidenceHandshakeOptions["anchorEvidence"],
      reconcileAnchor: reconcile as unknown as BuyerPaymentEvidenceHandshakeOptions["reconcileAnchor"],
      verifyAnchorReceipt: verifyReceipt as unknown as
        BuyerPaymentEvidenceHandshakeOptions["verifyAnchorReceipt"],
      ...(input.leaseDurationMs === undefined ? {} : { leaseDurationMs: input.leaseDurationMs }),
      ...(input.retryDelayMs === undefined ? {} : { retryDelayMs: input.retryDelayMs }),
    }),
  };
}

function classBacked<T extends object>(delegate: T): T {
  class StoreAdapter {}
  for (const key of Object.keys(delegate) as Array<keyof T>) {
    const member = delegate[key];
    if (typeof member !== "function") continue;
    Object.defineProperty(StoreAdapter.prototype, key, {
      value: (...args: unknown[]) => Reflect.apply(member, delegate, args),
    });
  }
  return new StoreAdapter() as T;
}

async function queueRequest(
  handshake: ReturnType<typeof seller>,
  index = 0,
): Promise<PaymentEvidenceAnchorRequest> {
  const candidate = request(index);
  const result = await handshake.anchorEvidence({
    effectId: candidate.effectId,
    logicalAddress: candidate.logicalAddress,
    evidenceHash: candidate.evidenceHash,
    evidence: candidate.evidence,
    expectedWriter: candidate.expectedWriter,
  });
  expect(result.disposition).toBe("indeterminate");
  const page = await handshake.claimOutboundRequests({ limit: 20 });
  const claim = page.items.find((item) => item.request.messageId === candidate.messageId)!;
  await handshake.acknowledgeOutboundRequest(claim);
  return claim.request;
}

describe("actor-separated payment-evidence handshake", () => {
  it("anchors through buyer authority and durably acknowledges both transport outboxes", async () => {
    const sellerHandshake = seller();
    const { handshake: buyerHandshake, anchor } = buyer();
    const candidate = await queueRequest(sellerHandshake);

    expect(await buyerHandshake.receiveRequest(candidate, { jwt: "verified-by-host" }))
      .toBe("accepted");
    expect(await buyerHandshake.receiveRequest(candidate, { jwt: "verified-by-host" }))
      .toBe("existing");
    expect((await buyerHandshake.runPending()).items).toEqual([{
      messageId: candidate.messageId,
      status: "completed",
    }]);
    expect((await buyerHandshake.runPending()).items).toEqual([]);
    expect(anchor).toHaveBeenCalledTimes(1);

    const completionClaim = (await buyerHandshake.claimOutboundCompletions()).items[0]!;
    expect(await sellerHandshake.receiveCompletion(
      completionClaim.completion,
      { mtls: "verified-by-host" },
    )).toBe("accepted");
    await buyerHandshake.acknowledgeOutboundCompletion(completionClaim);
    expect((await buyerHandshake.claimOutboundCompletions()).items).toEqual([]);

    const completed = await sellerHandshake.anchorEvidence({
      effectId: candidate.effectId,
      logicalAddress: candidate.logicalAddress,
      evidenceHash: candidate.evidenceHash,
      evidence: candidate.evidence,
      expectedWriter: candidate.expectedWriter,
    });
    expect(completed.disposition).toBe("anchored");
    expect(anchor).toHaveBeenCalledTimes(1);
  });

  it("paginates more than ten completions without starving the eleventh", async () => {
    const sellerHandshake = seller();
    const { handshake: buyerHandshake } = buyer();
    for (let index = 0; index < 11; index += 1) {
      const candidate = await queueRequest(sellerHandshake, index);
      await buyerHandshake.receiveRequest(candidate, { transport: "test" });
    }
    expect((await buyerHandshake.runPending({ limit: 20 })).items).toHaveLength(11);

    const first = await buyerHandshake.claimOutboundCompletions({ limit: 10 });
    expect(first.items).toHaveLength(10);
    expect(first.nextCursor).toBeDefined();
    const second = await buyerHandshake.claimOutboundCompletions({
      cursor: first.nextCursor,
      limit: 10,
    });
    expect(second.items).toHaveLength(1);
    const hashes = [...first.items, ...second.items].map(
      (item) => item.completion.completionHash,
    );
    expect(new Set(hashes)).toHaveLength(11);
  });

  it("runs one exact retained request without advancing adjacent orders", async () => {
    const first = request(0);
    const second = request(1);
    const { handshake, anchor } = buyer();
    await handshake.receiveRequest(first, {});
    await handshake.receiveRequest(second, {});

    expect((await handshake.runPending({
      messageId: second.messageId,
      requestHash: second.requestHash,
    })).items).toEqual([{
      messageId: second.messageId,
      status: "completed",
    }]);
    expect(anchor).toHaveBeenCalledTimes(1);
    expect((await handshake.runPending()).items).toEqual([{
      messageId: first.messageId,
      status: "completed",
    }]);
    await expect(handshake.runPending({
      messageId: first.messageId,
      requestHash: second.requestHash,
    })).rejects.toThrow(/conflicts with retained state/);
  });

  it("returns the last visited cursor when a runnable page is interrupted", async () => {
    const controller = new AbortController();
    const candidates = [request(0), request(1)];
    const anchor = vi.fn((effect: { logicalAddress: string }) => {
      controller.abort();
      return {
        disposition: "anchored" as const,
        ...finalAnchor(candidates.find(
          (candidate) => candidate.logicalAddress === effect.logicalAddress,
        )!),
      };
    });
    const { handshake } = buyer({ anchor });
    for (const candidate of candidates) await handshake.receiveRequest(candidate, {});

    const first = await handshake.runPending({ limit: 10, signal: controller.signal });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBe(first.items[0]!.messageId);
    expect((await handshake.runPending({ cursor: first.nextCursor, limit: 10 })).items)
      .toHaveLength(1);
  });

  it("passes cooperative cancellation to an in-flight wallet callback", async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const anchor = vi.fn((input: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        observedSignal = input.signal;
        input.signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
          once: true,
        });
      }));
    const { handshake } = buyer({ anchor });
    const candidate = request();
    await handshake.receiveRequest(candidate, {});

    const pending = handshake.runPending({ signal: controller.signal });
    await vi.waitFor(() => expect(observedSignal).toBe(controller.signal));
    controller.abort();
    expect((await pending).items).toEqual([{
      messageId: candidate.messageId,
      status: "reconciliation-required",
      reasonCode: "anchor-threw",
    }]);
  });

  it("accepts structurally valid handshake stores with prototype methods", async () => {
    const sellerStore = classBacked(createInMemoryPaymentEvidenceHandshakeStore());
    const buyerStore = classBacked(createInMemoryPaymentEvidenceHandshakeStore());
    expect(Object.getPrototypeOf(sellerStore)).not.toBe(Object.prototype);
    expect(Object.getPrototypeOf(buyerStore)).not.toBe(Object.prototype);
    const candidate = await queueRequest(seller(sellerStore));
    const { handshake } = buyer({ store: buyerStore });
    await expect(handshake.receiveRequest(candidate, {})).resolves.toBe("accepted");
    await expect(handshake.runPending()).resolves.toMatchObject({
      items: [{ status: "completed" }],
    });
  });

  it("releases ambiguous anchor attempts and requires durable reconciliation before retry", async () => {
    let now = 1_000;
    const signal = new AbortController().signal;
    const store = createInMemoryPaymentEvidenceHandshakeStore({ now: () => now });
    const candidate = request();
    const anchor = vi.fn()
      .mockImplementationOnce((input: { signal?: AbortSignal }) => {
        expect(input.signal).toBe(signal);
        throw new Error("secret provider detail");
      })
      .mockImplementationOnce((input: { signal?: AbortSignal }) => {
        expect(input.signal).toBe(signal);
        return { disposition: "anchored", ...finalAnchor(candidate) };
      });
    const reconcile = vi.fn((input: { signal?: AbortSignal }) => {
      expect(input.signal).toBe(signal);
      return {
        disposition: "absent" as const,
        absenceProofHash: ABSENCE_HASH,
      };
    });
    const verifyReceipt = vi.fn((input: { signal?: AbortSignal }) => {
      expect(input.signal).toBe(signal);
      return { disposition: "valid" as const };
    });
    const { handshake } = buyer({
      store,
      anchor,
      reconcile,
      verifyReceipt,
      retryDelayMs: 5,
    });
    await handshake.receiveRequest(candidate, {});

    expect((await handshake.runPending({ signal })).items).toEqual([{
      messageId: candidate.messageId,
      status: "reconciliation-required",
      reasonCode: "anchor-threw",
    }]);
    expect((await handshake.runPending()).items).toEqual([]);
    const afterFailure = await store.load("buyer", candidate.messageId, SCOPE_HASH);
    expect(afterFailure.status === "ok" ? afterFailure.record.buyerWork?.lease : "bad")
      .toBeUndefined();
    expect(JSON.stringify(afterFailure)).not.toContain("secret provider detail");

    now += 5;
    expect((await handshake.runPending({ signal })).items[0]?.status).toBe("reconciled-absent");
    expect(anchor).toHaveBeenCalledTimes(1);
    expect((await handshake.runPending({ signal })).items[0]?.status).toBe("completed");
    expect(anchor).toHaveBeenCalledTimes(2);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(verifyReceipt).toHaveBeenCalledTimes(1);
  });

  it("fails closed on an unknown acquired claim mode before calling the wallet", async () => {
    const store = createInMemoryPaymentEvidenceHandshakeStore();
    const originalClaim = store.claimBuyer;
    store.claimBuyer = vi.fn(async (input) => {
      const claimed = await originalClaim(input);
      return claimed.status === "acquired"
        ? { ...claimed, mode: "future-mode" } as never
        : claimed;
    });
    const candidate = request();
    const anchor = vi.fn(() => ({
      disposition: "anchored" as const,
      ...finalAnchor(candidate),
    }));
    const { handshake } = buyer({ store, anchor });
    await handshake.receiveRequest(candidate, {});

    await expect(handshake.runPending()).rejects.toThrow(/unknown buyer-claim mode/);
    expect(anchor).not.toHaveBeenCalled();
  });

  it("fences an expired slow anchor before one durably marked reattempt", async () => {
    let now = 1_000;
    const store = createInMemoryPaymentEvidenceHandshakeStore({ now: () => now });
    const candidate = request();
    const anchored = { disposition: "anchored" as const, ...finalAnchor(candidate) };
    let releaseFirst!: () => void;
    const firstMayContinue = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const events: string[] = [];
    const observedKeys: string[] = [];
    type AnchorJournal = {
      fencedThrough: number;
      performingGeneration?: number;
      committedGeneration?: number;
    };
    const journals = new Map<string, AnchorJournal>();
    const journalFor = (idempotencyKey: string) => {
      const existing = journals.get(idempotencyKey);
      if (existing) return existing;
      const created: AnchorJournal = { fencedThrough: 0 };
      journals.set(idempotencyKey, created);
      return created;
    };
    let irreversibleEffects = 0;
    let anchorInvocation = 0;
    const anchor = vi.fn(async (
      _input: unknown,
      fence: Readonly<PaymentEvidenceAnchorFence>,
    ) => {
      anchorInvocation += 1;
      const invocation = anchorInvocation;
      observedKeys.push(fence.idempotencyKey);
      events.push(`anchor-${fence.generation}-entered`);
      if (invocation === 1) await firstMayContinue;
      try {
        await fence.assertCurrent();
      } catch (error) {
        events.push(`anchor-${fence.generation}-stale`);
        throw error;
      }
      const journal = journalFor(fence.idempotencyKey);
      if (fence.generation <= journal.fencedThrough ||
          journal.performingGeneration !== undefined) {
        throw new Error("anchor journal rejected a stale or concurrent generation");
      }
      journal.performingGeneration = fence.generation;
      try {
        irreversibleEffects += 1;
        events.push(`effect-${fence.generation}`);
        journal.committedGeneration = fence.generation;
        return anchored;
      } finally {
        delete journal.performingGeneration;
      }
    });
    const reconcile = vi.fn(async (
      _input: unknown,
      fence: Readonly<PaymentEvidenceAnchorFence>,
    ) => {
      await fence.assertCurrent();
      observedKeys.push(fence.idempotencyKey);
      const journal = journalFor(fence.idempotencyKey);
      if (journal.performingGeneration !== undefined) {
        return { disposition: "indeterminate" as const, reason: "performer-active" };
      }
      if (journal.committedGeneration !== undefined) return anchored;
      journal.fencedThrough = Math.max(journal.fencedThrough, fence.generation);
      events.push(`reconcile-${fence.generation}-fenced`);
      return {
        disposition: "absent" as const,
        absenceProofHash: ABSENCE_HASH,
      };
    });
    const { handshake } = buyer({
      store,
      anchor,
      reconcile,
      leaseDurationMs: 5,
    });
    await handshake.receiveRequest(candidate, {});

    const abandonedWorker = handshake.runPending();
    await vi.waitFor(() => expect(anchor).toHaveBeenCalledTimes(1));
    expect(await store.load("buyer", candidate.messageId, SCOPE_HASH)).toMatchObject({
      status: "ok",
      record: {
        buyerWork: {
          state: "reconciliation-required",
          reasonCode: "anchor-attempt-in-flight",
          lease: { generation: 1 },
        },
      },
    });

    now += 6;
    expect((await handshake.runPending()).items).toEqual([{
      messageId: candidate.messageId,
      status: "reconciled-absent",
    }]);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(anchor).toHaveBeenCalledTimes(1);

    releaseFirst();
    await expect(abandonedWorker).resolves.toEqual({
      items: [{ messageId: candidate.messageId, status: "stale" }],
    });

    expect((await handshake.runPending()).items).toEqual([{
      messageId: candidate.messageId,
      status: "completed",
    }]);
    expect(anchor).toHaveBeenCalledTimes(2);
    expect(irreversibleEffects).toBe(1);
    expect(new Set(observedKeys)).toHaveLength(1);
    expect([...journals.values()]).toEqual([{
      fencedThrough: 2,
      committedGeneration: 3,
    }]);
    expect(events).toEqual([
      "anchor-1-entered",
      "reconcile-2-fenced",
      "anchor-1-stale",
      "anchor-3-entered",
      "effect-3",
    ]);
  });

  it("parks permanent rejection for operator action and requeues only through repair", async () => {
    const candidate = request();
    const anchor = vi.fn()
      .mockReturnValueOnce({ disposition: "rejected", reason: "permanent" })
      .mockReturnValueOnce({ disposition: "anchored", ...finalAnchor(candidate) });
    const reconcile = vi.fn(() => ({
      disposition: "absent" as const,
      absenceProofHash: ABSENCE_HASH,
    }));
    const { handshake } = buyer({ anchor, reconcile });
    await handshake.receiveRequest(candidate, {});
    expect((await handshake.runPending()).items[0]).toMatchObject({
      status: "operator-action",
      reasonCode: "anchor-rejected",
    });
    expect((await handshake.runPending()).items).toEqual([]);

    await handshake.repairRequest(candidate.messageId, candidate.requestHash, "operator-requeue");
    expect((await handshake.runPending()).items[0]?.status).toBe("reconciled-absent");
    expect((await handshake.runPending()).items[0]?.status).toBe("completed");
  });

  it("atomically rejects conflicting effect IDs and logical payment slots", async () => {
    const store = createInMemoryPaymentEvidenceHandshakeStore();
    const { handshake } = buyer({ store });
    const first = request(0);
    await handshake.receiveRequest(first, {});

    const conflictingEffect = request(1, { effectId: first.effectId });
    await expect(handshake.receiveRequest(conflictingEffect, {}))
      .rejects.toThrow(/effect, or payment slot/);

    const conflictingSlot = request(2, { logicalAddress: first.logicalAddress });
    await expect(handshake.receiveRequest(conflictingSlot, {}))
      .rejects.toThrow(/effect, or payment slot/);
    expect((await handshake.runPending({ limit: 10 })).items).toHaveLength(1);
  });

  it("rejects cross-tenant list and claim results before any wallet callback", async () => {
    const store = createInMemoryPaymentEvidenceHandshakeStore();
    const otherBuyer = "did:example:other-buyer";
    const otherEvidence = evidence(77);
    const otherRequest = createPaymentEvidenceAnchorRequest({
      seller: SELLER,
      buyer: otherBuyer,
      protocol: PROTOCOL,
      effectId: `payment-evidence:${JOB_ID}:other`,
      logicalAddress: `dacs4:payment:${JOB_ID}:x402%3Adefault:77`,
      evidenceHash: contentHash(otherEvidence as unknown as Record<string, unknown>),
      evidence: otherEvidence,
      expectedWriter: { role: "buyer", primaryClaim: otherBuyer },
    });
    const otherScopeHash = paymentEvidenceHandshakeScopeHash({
      seller: SELLER,
      buyer: otherBuyer,
      protocolHash: fixedPriceX402ProtocolBindingHash(PROTOCOL),
    });
    await store.putRequest({
      role: "buyer",
      scopeHash: otherScopeHash,
      request: otherRequest,
      requestAuthentication: {
        principal: SELLER,
        audience: otherBuyer,
        messageId: otherRequest.messageId,
        messageHash: otherRequest.requestHash,
        authenticationHash: AUTH_HASH,
      },
    });

    const walletFromList = vi.fn();
    const hostileListStore = {
      ...store,
      listBuyerRunnable: (input: Parameters<typeof store.listBuyerRunnable>[0]) =>
        store.listBuyerRunnable({ ...input, scopeHash: otherScopeHash }),
    };
    await expect(buyer({
      store: hostileListStore,
      anchor: walletFromList,
    }).handshake.runPending()).rejects.toThrow(/actor\/pair\/protocol/);
    expect(walletFromList).not.toHaveBeenCalled();

    const local = buyer({ store });
    const localRequest = request(78);
    await local.handshake.receiveRequest(localRequest, {});
    const walletFromClaim = vi.fn();
    const hostileClaimStore = {
      ...store,
      claimBuyer: (input: Parameters<typeof store.claimBuyer>[0]) => store.claimBuyer({
        ...input,
        scopeHash: otherScopeHash,
        messageId: otherRequest.messageId,
        requestHash: otherRequest.requestHash,
      }),
    };
    await expect(buyer({
      store: hostileClaimStore,
      anchor: walletFromClaim,
    }).handshake.runPending()).rejects.toThrow(/actor\/pair\/protocol\/message/);
    expect(walletFromClaim).not.toHaveBeenCalled();
  });

  it("rejects transport authentication that is not bound to actor, audience and message", async () => {
    const candidate = request();
    const handshake = createBuyerPaymentEvidenceHandshake({
      store: createInMemoryPaymentEvidenceHandshakeStore(),
      seller: SELLER,
      buyer: BUYER,
      protocol: PROTOCOL,
      workerId: "buyer-worker",
      authenticateRequest: () => ({
        disposition: "authenticated",
        peer: { ...requestPeer(candidate), principal: "did:example:attacker" },
      }),
      verifyEvidence: () => ({ disposition: "valid" }),
      anchorEvidence: () => ({ disposition: "anchored", ...finalAnchor(candidate) }),
      reconcileAnchor: () => ({ disposition: "indeterminate", reason: "unused" }),
      verifyAnchorReceipt: () => ({ disposition: "valid" }),
    });
    await expect(handshake.receiveRequest(candidate, { jwt: "attacker" }))
      .rejects.toThrow(/request rejected/);
  });

  it("matches factory and authenticated principals by CORE B.1 CF-3 identity", async () => {
    const candidate = request();
    const handshake = createBuyerPaymentEvidenceHandshake({
      store: createInMemoryPaymentEvidenceHandshakeStore(),
      seller: `${SELLER}?channel=direct`,
      buyer: `${BUYER}?device=one`,
      protocol: { ...PROTOCOL, orchestrator: `${SELLER}?node=one` },
      workerId: "buyer-worker",
      authenticateRequest: () => ({
        disposition: "authenticated",
        peer: {
          ...requestPeer(candidate),
          principal: `${SELLER}?auth=jwt`,
          audience: `${BUYER}?auth=jwt`,
        },
      }),
      verifyEvidence: () => ({ disposition: "valid" }),
      anchorEvidence: () => ({ disposition: "anchored", ...finalAnchor(candidate) }),
      reconcileAnchor: () => ({ disposition: "indeterminate", reason: "unused" }),
      verifyAnchorReceipt: () => ({ disposition: "valid" }),
    });
    await expect(handshake.receiveRequest(candidate, {})).resolves.toBe("accepted");
  });

  it("binds completion authentication to the buyer and retained message", async () => {
    const sellerStore = createInMemoryPaymentEvidenceHandshakeStore();
    const sellerHandshake = seller(sellerStore, (candidate) => ({
      disposition: "authenticated",
      peer: { ...completionPeer(candidate), principal: "did:example:attacker" },
    }));
    const { handshake: buyerHandshake } = buyer();
    const candidate = await queueRequest(sellerHandshake);
    await buyerHandshake.receiveRequest(candidate, {});
    await buyerHandshake.runPending();
    const completion = (await buyerHandshake.claimOutboundCompletions()).items[0]!.completion;
    await expect(sellerHandshake.receiveCompletion(completion, {}))
      .rejects.toThrow(/completion rejected/);
  });

  it("rejects pay-dem, non-live rails, wrong networks, and unpinned revisions", () => {
    const payDem = {
      ...evidence(),
      phase: "pay-dem",
      paymentTxRefs: [{ kind: "demos", txHash: "d".repeat(64) }],
    } as unknown as SettlementEvidence;
    expect(() => request(0, { evidence: payDem })).toThrow(/malformed/);

    const wrongNetwork = structuredClone(PROTOCOL);
    (wrongNetwork as unknown as { rail: { network: string } }).rail.network = "eip155:1";
    expect(() => createPaymentEvidenceAnchorRequest({
      seller: SELLER,
      buyer: BUYER,
      protocol: wrongNetwork,
      effectId: "effect",
      logicalAddress: `dacs4:payment:${JOB_ID}:x402%3Adefault:0`,
      evidenceHash: contentHash(evidence() as unknown as Record<string, unknown>),
      evidence: evidence(),
      expectedWriter: { role: "buyer", primaryClaim: BUYER },
    })).toThrow(/malformed/);

    for (const availability of ["mocked", "disabled", "failed", "operator_gated"] as const) {
      const nonLive = structuredClone(PROTOCOL) as unknown as {
        rail: { availability: string };
      };
      nonLive.rail.availability = availability;
      expect(() => createPaymentEvidenceAnchorRequest({
        seller: SELLER,
        buyer: BUYER,
        protocol: nonLive as unknown as FixedPriceX402ProtocolBinding,
        effectId: "effect",
        logicalAddress: `dacs4:payment:${JOB_ID}:x402%3Adefault:0`,
        evidenceHash: contentHash(evidence() as unknown as Record<string, unknown>),
        evidence: evidence(),
        expectedWriter: { role: "buyer", primaryClaim: BUYER },
      })).toThrow(/unsupported/);
    }

    const wrongRevision = structuredClone(PROTOCOL) as unknown as {
      standardRevision: string;
    };
    wrongRevision.standardRevision = "f".repeat(40);
    expect(() => createPaymentEvidenceAnchorRequest({
      seller: SELLER,
      buyer: BUYER,
      protocol: wrongRevision as unknown as FixedPriceX402ProtocolBinding,
      effectId: "effect",
      logicalAddress: `dacs4:payment:${JOB_ID}:x402%3Adefault:0`,
      evidenceHash: contentHash(evidence() as unknown as Record<string, unknown>),
      evidence: evidence(),
      expectedWriter: { role: "buyer", primaryClaim: BUYER },
    })).toThrow(/unsupported/);

    expect(() => createPaymentEvidenceAnchorRequest({
      seller: SELLER,
      buyer: BUYER,
      protocol: PROTOCOL,
      effectId: "effect",
      logicalAddress: `dacs4:payment:${JOB_ID}:x402%3Adefault:0`,
      evidenceHash: contentHash(evidence() as unknown as Record<string, unknown>),
      evidence: evidence(),
      expectedWriter: null as unknown as { role: "buyer"; primaryClaim: string },
    })).toThrow(/malformed/);
  });

  it("accepts seller-orchestrator signed x402 failure evidence for terminal audit", () => {
    expect(request(0, { evidence: evidence(0, "failure") }).evidence.outcome).toBe("failure");
    const wrongSigner = structuredClone(evidence(0, "failure"));
    wrongSigner.signature.signer = BUYER;
    expect(() => request(0, { evidence: wrongSigner })).toThrow(/malformed/);

    const legacyFailure = structuredClone(evidence(0, "failure"));
    legacyFailure.paymentTxRefs = [{
      kind: "x402",
      httpResource: "https://seller.example/orders/failed",
      paymentReceiptHash: txHash(101),
      chainId: 8453,
      protocolVersion: "2",
    }];
    expect(() => request(0, { evidence: legacyFailure })).toThrow(/malformed/);

    const wrongVersion = structuredClone(evidence(0, "failure"));
    wrongVersion.paymentTxRefs = [{
      kind: "x402-event",
      httpResource: "https://seller.example/orders/failed",
      paymentReceiptHash: txHash(101),
      settlementTxHash: txHash(0),
      chainId: 8453,
      logIndex: 0,
      protocolVersion: "1",
    }];
    expect(() => request(0, { evidence: wrongVersion })).toThrow(/malformed/);
  });

  it("fails closed on malformed outbound-store pages", async () => {
    const buyerStore = createInMemoryPaymentEvidenceHandshakeStore();
    buyerStore.claimBuyerCompletions = vi.fn(async () => ({
      items: [],
      nextCursor: " ",
    }));
    await expect(buyer({ store: buyerStore }).handshake.claimOutboundCompletions())
      .rejects.toThrow(/page is malformed/);

    const sellerStore = createInMemoryPaymentEvidenceHandshakeStore();
    sellerStore.claimSellerRequests = vi.fn(async () => ({
      items: [],
      nextCursor: " ",
    }));
    await expect(seller(sellerStore).claimOutboundRequests())
      .rejects.toThrow(/page is malformed/);
  });

  it("isolates retained state from authenticator mutation", async () => {
    const candidate = request();
    const store = createInMemoryPaymentEvidenceHandshakeStore();
    const handshake = createBuyerPaymentEvidenceHandshake({
      store,
      seller: SELLER,
      buyer: BUYER,
      protocol: PROTOCOL,
      workerId: "buyer-worker",
      authenticateRequest: (message) => {
        (message as { buyer: string }).buyer = "did:example:attacker";
        return { disposition: "authenticated", peer: requestPeer(candidate) };
      },
      verifyEvidence: () => ({ disposition: "valid" }),
      anchorEvidence: () => ({ disposition: "anchored", ...finalAnchor(candidate) }),
      reconcileAnchor: () => ({ disposition: "indeterminate", reason: "unused" }),
      verifyAnchorReceipt: () => ({ disposition: "valid" }),
    });
    await expect(handshake.receiveRequest(candidate, {})).resolves.toBe("accepted");
    const loaded = await store.load("buyer", candidate.messageId, SCOPE_HASH);
    expect(loaded.status === "ok" ? loaded.record.request.buyer : null).toBe(BUYER);
  });
});
