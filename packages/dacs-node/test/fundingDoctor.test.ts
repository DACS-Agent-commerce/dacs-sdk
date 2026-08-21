import { describe, expect, it, vi } from "vitest";

import { inspectDacsDemosBalanceHeadroomV1 } from "../src/fundingDoctor.js";

function actor(role: "buyer" | "seller", input: Readonly<{
  activated?: boolean;
  balance?: bigint;
}>) {
  return {
    role,
    networkInfo: vi.fn(async () => input.activated === undefined
      ? { forks: {} }
      : { forks: { osDenomination: { activated: input.activated } } }),
    addressInfo: vi.fn(async () => input.balance === undefined
      ? {} : { balance: input.balance }),
  };
}

function options(input: Readonly<{
  buyer: ReturnType<typeof actor>;
  seller: ReturnType<typeof actor>;
  buyerMinimum?: string;
  sellerMinimum?: string;
}>) {
  return {
    actors: { buyer: input.buyer, seller: input.seller },
    minimumDem: {
      buyer: input.buyerMinimum ?? "15",
      seller: input.sellerMinimum ?? "23",
    },
  } as never;
}

describe("Demos balance doctor", () => {
  it("normalizes post-fork OS balances and passes exact role floors", async () => {
    const result = await inspectDacsDemosBalanceHeadroomV1(options({
      buyer: actor("buyer", { activated: true, balance: 15_000_000_000n }),
      seller: actor("seller", { activated: true, balance: 23_250_000_000n }),
    }));
    expect(result).toEqual({
      status: "pass",
      facts: {
        buyerBalanceDem: "15",
        buyerMinimumDem: "15",
        sellerBalanceDem: "23.25",
        sellerMinimumDem: "23",
        denomination: "OS",
      },
    });
  });

  it("normalizes legacy DEM balances before comparing", async () => {
    const result = await inspectDacsDemosBalanceHeadroomV1(options({
      buyer: actor("buyer", { activated: false, balance: 15n }),
      seller: actor("seller", { activated: false, balance: 24n }),
    }));
    expect(result).toMatchObject({ status: "pass", facts: { denomination: "legacy-DEM" } });
  });

  it("blocks an underfunded role and reports only canonical public facts", async () => {
    const result = await inspectDacsDemosBalanceHeadroomV1(options({
      buyer: actor("buyer", { activated: true, balance: 14_999_999_999n }),
      seller: actor("seller", { activated: true, balance: 23_000_000_000n }),
    }));
    expect(result).toMatchObject({
      status: "blocked",
      reasonCode: "demos-balance-insufficient",
      facts: { buyerBalanceDem: "14.999999999", buyerMinimumDem: "15" },
    });
  });

  it("refuses to guess the active denomination", async () => {
    const result = await inspectDacsDemosBalanceHeadroomV1(options({
      buyer: actor("buyer", { balance: 20n }),
      seller: actor("seller", { activated: true, balance: 30_000_000_000n }),
    }));
    expect(result).toEqual({
      status: "blocked",
      reasonCode: "demos-denomination-status-unavailable",
    });
  });

  it("fails malformed account data and rejects non-canonical minima", async () => {
    await expect(inspectDacsDemosBalanceHeadroomV1(options({
      buyer: actor("buyer", { activated: true }),
      seller: actor("seller", { activated: true, balance: 23_000_000_000n }),
    }))).resolves.toEqual({
      status: "fail",
      reasonCode: "demos-balance-response-invalid",
    });
    await expect(inspectDacsDemosBalanceHeadroomV1(options({
      buyer: actor("buyer", { activated: true, balance: 15_000_000_000n }),
      seller: actor("seller", { activated: true, balance: 23_000_000_000n }),
      buyerMinimum: "15.0000000000",
    }))).rejects.toThrow(/minimum is invalid/);
  });

  it("maps RPC failures to a stable blocked outcome", async () => {
    const buyer = actor("buyer", { activated: true, balance: 15_000_000_000n });
    buyer.addressInfo.mockRejectedValueOnce(new Error("private RPC detail"));
    await expect(inspectDacsDemosBalanceHeadroomV1(options({
      buyer,
      seller: actor("seller", { activated: true, balance: 23_000_000_000n }),
    }))).resolves.toEqual({
      status: "blocked",
      reasonCode: "demos-balance-read-unavailable",
    });
  });
});
