import { describe, expect, test, vi } from "vitest";
import {
  termsMatchD402, payD402SettleCore, createPayD402Rail, PAY_D402_AVAILABILITY,
  payD402Settle, payD402ResumeSettlement, type PayD402Rail, type PayD402SettleParams, type D402ClientLike,
} from "../../src/rails/payD402.js";

const sdk = vi.hoisted(() => ({ demos: vi.fn(), client: vi.fn() }));
vi.mock("@kynesyslabs/demosdk/websdk", () => ({ Demos: sdk.demos }));
vi.mock("@kynesyslabs/demosdk/d402/client", () => ({ D402Client: sdk.client }));

const RECIPIENT = "demos1recipientaddress0000000000000000000000";
const PAYER = "demos1payeraddress00000000000000000000000000";

describe("termsMatchD402 (§4.1 abort guard, native DEM)", () => {
  const expected = { recipient: RECIPIENT, amount: "1500000000" };

  test("matches on equal terms (recipient case-insensitive, leading zeros ok)", () => {
    expect(
      termsMatchD402(expected, {
        recipient: RECIPIENT.toUpperCase(),
        amount: "01500000000",
      }).ok,
    ).toBe(true);
  });

  test("rejects a recipient mismatch", () => {
    const r = termsMatchD402(expected, { recipient: "demos1someoneelse", amount: "1500000000" });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/recipient mismatch/);
  });

  test("rejects an amount mismatch", () => {
    const r = termsMatchD402(expected, { recipient: RECIPIENT, amount: "999" });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/amount mismatch/);
  });

});

describe("D402 funded-use quarantine", () => {
  test("legacy structural rails and two-argument callers compile and still refuse before rail access", async () => {
    // Keep the pre-existing public structural API: no wait method or options
    // are required to receive the same disabled-rail refusal.
    const rail: PayD402Rail = {
      address: PAYER,
      settle: vi.fn(async () => { throw new Error("must not settle"); }),
    };
    const paywall = { url: "https://seller.example/premium", recipient: RECIPIENT };
    const settle = payD402Settle(rail, paywall);
    const resume = payD402ResumeSettlement(rail, paywall);
    await expect(settle({} as Parameters<typeof settle>[0])).rejects.toThrow(/unavailable.*approved total debit/);
    await expect(resume({} as Parameters<typeof resume>[0])).rejects.toThrow(/unavailable.*approved total debit/);
    expect(rail.settle).not.toHaveBeenCalled();
  });

  test("availability is disabled and acknowledgement cannot construct a wallet or client", async () => {
    expect(PAY_D402_AVAILABILITY).toBe("disabled");
    for (const acknowledgeExperimental of [false, true]) {
      await expect(createPayD402Rail({
        rpc: "https://rpc.example", secret: "unused", acknowledgeExperimental,
        network: "demos:mainnet",
      })).rejects.toThrow(/unavailable.*approved total debit/);
    }
    expect(sdk.demos).not.toHaveBeenCalled();
    expect(sdk.client).not.toHaveBeenCalled();
  });

  test.each(["demos:mainnet", "demos:other"])(
    "direct calls cannot authorize uncapped fees or claim settlement on %s", async (network) => {
      const client: D402ClientLike = {
        createPayment: vi.fn(async () => ({})),
        settle: vi.fn(async () => ({ success: true, hash: "same-hash", blockNumber: 42 })),
      };
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
        recipient: RECIPIENT, amount: "1500000000", resourceId: "same-resource",
      }), { status: 402 }));
      const params: PayD402SettleParams = {
        paywallUrl: "https://seller.example/premium", recipient: RECIPIENT,
        amount: "1500000000", network,
      };
      await expect(payD402SettleCore(params, { client, fetchImpl, payerAddress: PAYER }))
        .rejects.toThrow(/unavailable.*approved total debit/);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(client.createPayment).not.toHaveBeenCalled();
      expect(client.settle).not.toHaveBeenCalled();
    },
  );
});
