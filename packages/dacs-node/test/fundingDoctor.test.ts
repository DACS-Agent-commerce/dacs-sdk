import { describe, expect, it, vi } from "vitest";

import {
  DACS_FIXED_PRICE_PURCHASE_DEMOS_WRITE_GRAPH_V1,
  estimateDacsFixedPriceDemosCostV1,
  inspectDacsDemosBalanceHeadroomV1,
  inspectDacsX402AssetBalanceV1,
  inspectDacsX402GasBalanceV1,
  inspectDacsX402TokenDomainV1,
} from "../src/fundingDoctor.js";

describe("fixed-price Demos cost estimate", () => {
  it("publishes the exact auditable generated write graph", () => {
    expect(DACS_FIXED_PRICE_PURCHASE_DEMOS_WRITE_GRAPH_V1).toEqual({
      buyer: [
        "counterparty-vet", "agreement", "payment-evidence", "buyer-bundle",
        "buyer-bundle-binding",
      ],
      seller: [
        "counterparty-vet", "finality-commitment", "deliverable", "delivery-evidence",
        "seller-bundle", "seller-bundle-binding",
      ],
    });
    expect(Object.isFrozen(DACS_FIXED_PRICE_PURCHASE_DEMOS_WRITE_GRAPH_V1.buyer)).toBe(true);
    expect(Object.isFrozen(DACS_FIXED_PRICE_PURCHASE_DEMOS_WRITE_GRAPH_V1.seller)).toBe(true);
  });

  it("budgets both role write graphs and one write of safety headroom", () => {
    expect(estimateDacsFixedPriceDemosCostV1({
      rail: "x402",
      maximumStorageWriteFeeDem: { buyer: "2", seller: "3" },
    })).toEqual({
      rail: "x402",
      maximumStorageWriteFeeDem: { buyer: "2", seller: "3" },
      expectedStorageWrites: { buyer: 5, seller: 6 },
      safetyMarginWrites: { buyer: 1, seller: 1 },
      maximumStorageFeesDem: { buyer: "10", seller: "18" },
      safetyMarginDem: { buyer: "2", seller: "3" },
      minimumDem: { buyer: "12", seller: "21" },
      maximumTotalDemosDebitDem: "33",
    });
  });

  it("adds the native transfer-and-fee ceiling only to the pay-DEM buyer", () => {
    expect(estimateDacsFixedPriceDemosCostV1({
      rail: "pay-dem",
      maximumStorageWriteFeeDem: { buyer: "2", seller: "2" },
      maximumPayDemTotalDebitDem: "3.5",
    })).toMatchObject({
      minimumDem: { buyer: "15.5", seller: "14" },
      maximumTotalDemosDebitDem: "29.5",
    });
  });

  it("rejects missing pay-DEM debit and non-canonical fee ceilings", () => {
    expect(() => estimateDacsFixedPriceDemosCostV1({
      rail: "pay-dem",
      maximumStorageWriteFeeDem: { buyer: "2", seller: "2" },
    })).toThrow(/total debit/);
    expect(() => estimateDacsFixedPriceDemosCostV1({
      rail: "x402",
      maximumStorageWriteFeeDem: { buyer: "02", seller: "2" },
    })).toThrow(/write fee/);
  });
});

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

describe("x402 balance doctor", () => {
  const payer = `0x${"1".repeat(40)}`;
  const asset = `0x${"2".repeat(40)}`;

  function client(input: Readonly<{ chainId?: number; asset?: bigint; gas?: bigint }> = {}) {
    return {
      getChainId: vi.fn(async () => input.chainId ?? 84_532),
      getAssetBalance: vi.fn(async () => input.asset ?? 1_000_000n),
      getAssetTokenDomain: vi.fn(async () => ({ name: "USDC", version: "2" })),
      getNativeBalance: vi.fn(async () => input.gas ?? 1_000_000_000_000_000n),
    };
  }

  it("authenticates the configured EIP-712 token domain on-chain", async () => {
    const reader = client();
    await expect(inspectDacsX402TokenDomainV1({
      client: reader,
      chainId: 84_532,
      asset,
      expected: { name: "USDC", version: "2" },
    })).resolves.toEqual({
      status: "pass",
      facts: { domainName: "USDC", domainVersion: "2" },
    });
    reader.getAssetTokenDomain.mockResolvedValueOnce({ name: "USD Coin", version: "2" });
    await expect(inspectDacsX402TokenDomainV1({
      client: reader,
      chainId: 84_532,
      asset,
      expected: { name: "USDC", version: "2" },
    })).resolves.toEqual({
      status: "fail",
      reasonCode: "x402-token-domain-mismatch",
      facts: { domainName: "USD Coin", domainVersion: "2" },
    });
  });

  it("fails closed when token-domain metadata is unavailable or malformed", async () => {
    const unavailable = client();
    unavailable.getAssetTokenDomain.mockRejectedValueOnce(new Error("private RPC detail"));
    await expect(inspectDacsX402TokenDomainV1({
      client: unavailable, chainId: 84_532, asset,
      expected: { name: "USDC", version: "2" },
    })).resolves.toEqual({
      status: "blocked", reasonCode: "x402-token-domain-unavailable",
    });
    const malformed = client();
    malformed.getAssetTokenDomain.mockResolvedValueOnce({ name: "USDC" } as never);
    await expect(inspectDacsX402TokenDomainV1({
      client: malformed, chainId: 84_532, asset,
      expected: { name: "USDC", version: "2" },
    })).resolves.toEqual({
      status: "fail", reasonCode: "x402-token-domain-invalid",
    });
  });

  it("checks exact token units and native gas independently", async () => {
    const reader = client();
    await expect(inspectDacsX402AssetBalanceV1({
      client: reader,
      chainId: 84_532,
      payer,
      asset,
      symbol: "USDC",
      decimals: 6,
      minimumAmount: "1",
    })).resolves.toEqual({
      status: "pass",
      facts: { assetSymbol: "USDC", availableAmount: "1", minimumAmount: "1", chainId: 84_532 },
    });
    await expect(inspectDacsX402GasBalanceV1({
      client: reader,
      chainId: 84_532,
      payer,
      minimumEth: "0.001",
    })).resolves.toEqual({
      status: "pass",
      facts: { availableEth: "0.001", minimumEth: "0.001", chainId: 84_532 },
    });
  });

  it("blocks insufficient token and gas balances", async () => {
    const reader = client({ asset: 999_999n, gas: 999_999_999_999_999n });
    await expect(inspectDacsX402AssetBalanceV1({
      client: reader, chainId: 84_532, payer, asset, symbol: "USDC",
      decimals: 6, minimumAmount: "1",
    })).resolves.toMatchObject({
      status: "blocked", reasonCode: "x402-asset-balance-insufficient",
    });
    await expect(inspectDacsX402GasBalanceV1({
      client: reader, chainId: 84_532, payer, minimumEth: "0.001",
    })).resolves.toMatchObject({
      status: "blocked", reasonCode: "x402-gas-balance-insufficient",
    });
  });

  it("fails wrong-chain and malformed balance responses", async () => {
    await expect(inspectDacsX402AssetBalanceV1({
      client: client({ chainId: 1 }), chainId: 84_532, payer, asset, symbol: "USDC",
      decimals: 6, minimumAmount: "1",
    })).resolves.toEqual({ status: "fail", reasonCode: "x402-asset-chain-mismatch" });
    const malformed = client();
    malformed.getNativeBalance.mockResolvedValueOnce(-1n);
    await expect(inspectDacsX402GasBalanceV1({
      client: malformed, chainId: 84_532, payer, minimumEth: "0.001",
    })).resolves.toEqual({ status: "fail", reasonCode: "x402-gas-balance-invalid" });
  });

  it("rejects amounts with more precision than the authenticated asset", async () => {
    await expect(inspectDacsX402AssetBalanceV1({
      client: client(), chainId: 84_532, payer, asset, symbol: "USDC",
      decimals: 6, minimumAmount: "0.0000001",
    })).rejects.toThrow(/minimum is invalid/);
  });
});
