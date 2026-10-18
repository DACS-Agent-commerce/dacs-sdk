import { afterEach, describe, expect, test, vi } from "vitest";
import { DACS_CURRENT_PROFILE_ADMISSION_ERROR } from "../../src/version.js";
import { keccak256, stringToHex } from "viem";
import { createX402Rail, x402Settle, x402SettleCore, dacsX402AuthorizationNonce, verifyDacsX402AuthorizationNonce } from "../../src/rails/x402.js";
import { payDemSettle, payDemSettleCore } from "../../src/rails/payDem.js";
import { createEvmErc20Rail, evmErc20Settle, evmErc20SettleCore } from "../../src/rails/evmErc20.js";
import { payD402Settle, payD402SettleCore } from "../../src/rails/payD402.js";
import { advanceAp2Settlement } from "../../src/rails/ap2.js";
import { createStripeAp2Integration } from "../../src/rails/ap2Stripe.js";
import { advanceSolanaSplSettlement, createInMemorySolanaSplSettlementStore } from "../../src/rails/solanaSpl.js";
import { advanceX402BuyerSettlement } from "../../src/rails/x402BuyerSettlement.js";
import { createDacsX402BuyerEvmChallengeClient } from "../../src/rails/x402BuyerDacsEvm.js";
import { prepareX402BuyerSettlement, createX402BuyerPaidRequestTransport } from "../../src/rails/x402BuyerTransport.js";
import { x402PaywallCore } from "../../src/rails/x402Paywall.js";

import { runSessionCore } from "../../src/agent/runSessionCore.js";

const JOB = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PAYER = `0x${"a".repeat(64)}`;
const PAYEE = `0x${"b".repeat(64)}`;
afterEach(() => vi.unstubAllGlobals());

describe("SDK-owned release admission at direct rail boundaries", () => {
  test.each([JOB, "practice-dacs-0001", JOB.toLowerCase(), `${JOB}\n`, "cafe\u0301-job"])(
    "refuses every public effect path before signer/provider/transport/store calls for %j", async (jobId) => {
      const effect = vi.fn(async () => { throw new Error("unexpected external effect"); });
      vi.stubGlobal("fetch", effect);
      const store = { once: effect, claim: effect, load: effect };
      const rail = { address: PAYER, finalityBlocks: 1, settle: effect };
      const request = { jobId, phase: "pay-x402", rail: "rail", phaseIndex: 0,
        amount: "1", asset: "DEM", expectedPayee: PAYEE };
      const x402 = x402Settle(rail, { url: "https://example.test", network: "eip155:1",
        asset: "token", recipientEvm: PAYEE }, { store } as never);
      const dem = payDemSettle(rail, {}, { store } as never);
      const erc20 = evmErc20Settle(rail, { network: "eip155:1", tokenAddress: "token",
        recipientEvm: PAYEE }, { store } as never);
      const d402 = payD402Settle(rail, { url: "https://example.test", recipient: PAYEE });
      const paid = createX402BuyerPaidRequestTransport({ fetchImpl: effect as never,
        transportPolicy: { mode: "insecure-test" } });
      const calls: Array<() => unknown> = [
        () => runSessionCore("unused-listing", {} as never, { settle: effect, readListing: effect } as never, jobId),
        () => x402(request as never), () => dem(request as never),
        () => erc20(request as never), () => d402(request as never),
        () => x402SettleCore({ jobId } as never, { client: { createPaymentPayload: effect }, fetchImpl: effect } as never),
        () => payDemSettleCore({ recovery: { jobId } } as never, { transfer: effect } as never),
        () => evmErc20SettleCore({ jobId } as never, { transfer: effect, finalityClient: { getChainId: effect } } as never),
        () => payD402SettleCore({ jobId } as never, { client: { createPayment: effect, settle: effect }, fetchImpl: effect } as never),
        () => advanceAp2Settlement({ jobId, store, provider: { submit: effect }, verifier: { verifyCheckoutMandate: effect } } as never),
        () => advanceSolanaSplSettlement({ authority: { jobId }, store,
          adapter: { prepareSignedTransfer: effect, broadcastRetained: effect } } as never),
        () => advanceX402BuyerSettlement({ intent: { jobId }, store, transport: { submitRetained: effect } } as never),
        () => prepareX402BuyerSettlement({ authority: { jobId } } as never, { client: { createPaymentPayload: effect } } as never),
        () => createDacsX402BuyerEvmChallengeClient({ authority: { jobId } } as never),
        () => paid.submitRetained({ jobId } as never, { assertCurrent: effect } as never),
        () => x402PaywallCore({ jobId } as never, { server: { processSettlement: effect }, settlementStore: store } as never),
      ];
      for (const call of calls) {
        await expect(Promise.resolve().then(call)).rejects.toThrow(DACS_CURRENT_PROFILE_ADMISSION_ERROR);
        expect(effect).not.toHaveBeenCalled();
      }
    },
  );

  test("release refusal does not evaluate caller-owned job accessors", async () => {
    const read = vi.fn(() => JOB);
    const params = Object.defineProperty({}, "jobId", { get: read });
    await expect(x402SettleCore(params as never, {} as never))
      .rejects.toThrow(DACS_CURRENT_PROFILE_ADMISSION_ERROR);
    expect(read).not.toHaveBeenCalled();
  });

  test("Stripe's provider submit cannot bypass the SDK coordinator", async () => {
    const fetchImpl = vi.fn();
    const { provider } = createStripeAp2Integration({
      createCredential: ["rk", "test", "CreateFixture"].join("_"),
      statusCredential: ["rk", "test", "StatusFixture"].join("_"),
      payeeId: "merchant", currencyMinorUnits: 2, substrate: { proxyFetch: vi.fn() }, fetchImpl,
    });
    for (const jobId of [JOB, "legacy-job"]) {
      await expect(provider.submit({ intent: { jobId } } as never))
        .rejects.toThrow(DACS_CURRENT_PROFILE_ADMISSION_ERROR);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each(["practice-dacs-0001", "cafe\u0301-job", JOB.toLowerCase(), `${JOB}\n`, JOB.replace("K", "U")])(
    "nonce derivation rejects non-JID-1 bytes without repair: %j", async (jobId) => {
      await expect(dacsX402AuthorizationNonce({ jobId, phaseIndex: 0 })).rejects.toThrow(/JID-1/);
    },
  );

  test("read-only SPL inspection cannot sign or broadcast even when no retained attempt exists", async () => {
    const effect = vi.fn();
    const result = await advanceSolanaSplSettlement({
      reconcileOnly: true,
      authority: { jobId: JOB, phaseIndex: 2, railId: "solana-devnet-usdc",
        railDescriptorHash: "a".repeat(64), agreementHash: "b".repeat(64),
        assetKind: "spl", cluster: "devnet", payer: "1".repeat(32),
        payee: `${"1".repeat(31)}2`, mint: `${"1".repeat(31)}3`,
        assetSymbol: "USDC", amount: "1.25", currency: "USDC", tokenDecimals: 6 },
      owner: "reader", store: createInMemorySolanaSplSettlementStore(),
      adapter: { preflight: effect, prepareSignedTransfer: effect,
        broadcastRetained: effect, reconcile: effect },
    });
    expect(result).toEqual({ status: "indeterminate", reason: "solana-spl-read-only-no-active-attempt" });
    expect(effect).not.toHaveBeenCalled();
  });
});


test("constructed x402 and ERC-20 rails refuse before nonce derivation, getters or network", async () => {
  const effect = vi.fn();
  const evmPrivateKey = keccak256(stringToHex("dacs-sdk:test:release-admission-factory"));
  const x402 = await createX402Rail({ evmPrivateKey, rpcUrl: "https://offline.test",
    finalityBlocks: 1, fetchImpl: effect, transportPolicy: { mode: "insecure-test" } });
  const erc20 = await createEvmErc20Rail({ evmPrivateKey, rpcUrl: "https://offline.test",
    finalityBlocks: 1, network: "eip155:1" });
  const read = vi.fn(() => "legacy-job");
  const params = Object.defineProperty({}, "jobId", { get: read });
  for (const rail of [x402, erc20]) {
    await expect(rail.settle(params as never)).rejects.toThrow(DACS_CURRENT_PROFILE_ADMISSION_ERROR);
  }
  expect(read).not.toHaveBeenCalled();
  expect(effect).not.toHaveBeenCalled();
});


test("fresh nonce derivation refuses the current pin while read-only nonce verification stays available", async () => {
  const input = { jobId: JOB, phaseIndex: 3 };
  await expect(dacsX402AuthorizationNonce(input)).rejects.toThrow(DACS_CURRENT_PROFILE_ADMISSION_ERROR);
  await expect(verifyDacsX402AuthorizationNonce(input,
    "0xaeed3b79a6eedc2c19ce773a286dc5a897271cd92ed41a7f7ae5847fe3c9e9e2"))
    .resolves.toBe("present-and-matches");
});
