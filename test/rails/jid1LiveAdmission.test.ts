import { describe, expect, it, vi } from "vitest";

import { UnsupportedCapabilityError } from "../../src/errors.js";
import { createX402Rail, x402Settle, x402SettleCore } from "../../src/rails/x402.js";
import { createX402Paywall, x402PaywallCore } from "../../src/rails/x402Paywall.js";
import { createDacsX402BuyerEvmChallengeClient } from "../../src/rails/x402BuyerDacsEvm.js";
import { createX402BuyerPaidRequestTransport, prepareX402BuyerSettlement } from "../../src/rails/x402BuyerTransport.js";

import { advanceX402BuyerSettlement } from "../../src/rails/x402BuyerSettlement.js";
import { createX402SellerSpine } from "../../src/seller/x402Spine.js";
import { verifySellerPaymentIntake } from "../../src/seller/paymentIntake.js";
import * as liveProfile from "../../src/negotiate/liveProfile.js";

const JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const MESSAGE = "Live JID-1 actions are unavailable: the pinned Standard has no coordinated corrective release";

describe("unreleased JID-1 live admission", () => {
  it("refuses the seller spine before capturing any caller authority", () => {
    const read = vi.fn(() => { throw new Error("seller authority was consumed"); });
    expect(() => createX402SellerSpine(new Proxy({}, { get: read }) as never))
      .toThrow(UnsupportedCapabilityError);
    expect(read).not.toHaveBeenCalled();
  });

  it("rechecks admission before recovery reads input or retained seller state", async () => {
    const effect = vi.fn();
    const stub = (): any => new Proxy(effect, {
      get: (_target, key) => key === "bind" ? Function.prototype.bind : stub(),
    });
    const construction = vi.spyOn(liveProfile, "requireJid1LiveProfile")
      .mockImplementationOnce(() => undefined);
    let spine;
    try {
      spine = createX402SellerSpine(stub());
    } finally {
      construction.mockRestore();
    }
    effect.mockClear();
    const read = vi.fn(() => { throw new Error("recovery scope was consumed"); });
    await expect(spine.recoverPaymentAuthorization(new Proxy({}, { get: read }) as never))
      .rejects.toThrow(MESSAGE);
    expect(effect).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("refuses x402 intake before resolvers while allowing pay-dem intake to resolve", async () => {
    const resolve = vi.fn(async () => ({ disposition: "indeterminate", reason: "fixture-unavailable" }));
    const deps = {
      resolveCommittedAgreement: resolve,
      resolveListingAtCommit: vi.fn(), resolveRail: vi.fn(),
      resolveIdentityBundle: vi.fn(), resolvePayerAddress: vi.fn(),
      resolvePayeeDestination: vi.fn(), observeDemosTransfer: vi.fn(),
      observeX402Transfer: vi.fn(), verifyX402ReceiptExtensions: vi.fn(),
      classifyX402SettlementChain: vi.fn(), receiptStore: { claim: vi.fn() },
    };
    const scope = { jobId: JOB_ID, phaseIndex: 0, railId: "test", payerPayingKey: "payer" };
    await expect(verifySellerPaymentIntake({ ...scope, receipt: {
      kind: "pay-x402", protocolVersion: "2", httpResource: "https://seller.example/pay",
      paymentReceiptHash: "a".repeat(64), responseHeader: { name: "PAYMENT-RESPONSE", value: "receipt" },
    } }, deps as never)).rejects.toThrow(MESSAGE);
    expect(resolve).not.toHaveBeenCalled();
    await expect(verifySellerPaymentIntake({ ...scope, receipt: {
      kind: "pay-dem", txHash: "b".repeat(64),
    } }, deps as never)).resolves.toMatchObject({ disposition: "indeterminate", reason: "agreement-fixture-unavailable" });
    expect(resolve).toHaveBeenCalledTimes(1);
  });
  it("refuses production constructors before reading caller pins, loading signers or initializing a facilitator", async () => {
    const read = vi.fn(() => { throw new Error("caller context was consumed"); });
    const caller = new Proxy({
      jobId: JOB_ID,
      profile: { release: "v0.4", authenticated: true, participants: ["buyer", "seller"] },
    }, { get: read });
    for (const operation of [
      () => createX402Rail(caller as never),
      () => createX402Paywall(caller as never, caller as never),
      () => createDacsX402BuyerEvmChallengeClient(caller as never),
    ]) {
      await expect(operation()).rejects.toBeInstanceOf(UnsupportedCapabilityError);
      await expect(operation()).rejects.toThrow(MESSAGE);
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("refuses a canonical session before the bridge claims or reconciles a payment", () => {
    const settle = vi.fn();
    const once = vi.fn();
    const reconcile = vi.fn();
    const bridge = x402Settle({ address: `0x${"11".repeat(20)}`, finalityBlocks: 2, settle }, {
      url: "https://seller.example/deliver", network: "eip155:84532",
      recipientEvm: `0x${"22".repeat(20)}`, asset: `0x${"33".repeat(20)}`,
    }, { store: { once } as never, reconcile });
    expect(() => bridge({ jobId: JOB_ID, phaseIndex: 0 } as never)).toThrow(MESSAGE);
    expect(settle).not.toHaveBeenCalled();
    expect(once).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("refuses the buyer core before any injected client or transport can run", async () => {
    const read = vi.fn(() => { throw new Error("buyer dependency was consumed"); });
    const caller = new Proxy({ jobId: JOB_ID }, { get: read });
    await expect(x402SettleCore(caller as never, caller as never)).rejects.toThrow(MESSAGE);
    expect(read).not.toHaveBeenCalled();
  });

  it("refuses the durable coordinator before retained state, claims, authorization or transport", async () => {
    const read = vi.fn(() => { throw new Error("durable dependency was consumed"); });
    const caller = new Proxy({}, { get: read });
    const result = advanceX402BuyerSettlement(caller as never);
    await expect(result).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    await expect(result).rejects.toThrow(MESSAGE);
    expect(read).not.toHaveBeenCalled();
  });

  it("refuses the seller core before request parsing, store reads or settlement callbacks", async () => {
    const read = vi.fn(() => { throw new Error("seller dependency was consumed"); });
    await expect(x402PaywallCore({ jobId: JOB_ID, phaseIndex: 0 } as never,
      new Proxy({}, { get: read }) as never)).rejects.toThrow(MESSAGE);
    expect(read).not.toHaveBeenCalled();
  });

  it("refuses buyer preparation before challenge requests or caller-supplied signing clients", async () => {
    const read = vi.fn(() => { throw new Error("preparation context was consumed"); });
    const caller = new Proxy({}, { get: read });
    await expect(prepareX402BuyerSettlement(caller as never, caller as never)).rejects.toThrow(MESSAGE);
    expect(read).not.toHaveBeenCalled();
  });

  it("refuses submission of a retained authorization before disclosure, DNS or the effect fence", async () => {
    const transport = createX402BuyerPaidRequestTransport();
    const read = vi.fn(() => { throw new Error("retained authorization was consumed"); });
    const assertCurrent = vi.fn();
    await expect(transport.submitRetained(new Proxy({}, { get: read }) as never,
      { assertCurrent, settlementKey: "retained-payment", bindingHash: "aa".repeat(32),
        idempotencyKey: "retained-payment", owner: "worker", generation: 1 })).rejects.toThrow(MESSAGE);
    expect(read).not.toHaveBeenCalled();
    expect(assertCurrent).not.toHaveBeenCalled();
  });
});
