import { beforeEach, describe, expect, it, vi } from "vitest";

const factories = vi.hoisted(() => ({
  x402Buyer: vi.fn(),
  payDemBuyer: vi.fn(),
  x402Seller: vi.fn(),
  payDemSeller: vi.fn(),
  join: vi.fn(),
}));

vi.mock("../src/fixedPriceX402BuyerLive.js", () => ({
  createDacsFixedPriceX402BuyerLiveV1: factories.x402Buyer,
}));
vi.mock("../src/fixedPricePayDemBuyerLive.js", () => ({
  createDacsFixedPricePayDemBuyerLiveV1: factories.payDemBuyer,
}));
vi.mock("../src/fixedPriceX402SellerLive.js", () => ({
  createDacsFixedPriceX402SellerLiveV1: factories.x402Seller,
}));
vi.mock("../src/fixedPricePayDemSellerLive.js", () => ({
  createDacsFixedPricePayDemSellerLiveV1: factories.payDemSeller,
}));
vi.mock("../src/multirailCommerceGraph.js", () => ({
  createDacsMultirailLiveCommerceGraphV1: factories.join,
}));

import {
  createDacsFixedPriceMultirailBuyerLiveV1,
  createDacsFixedPriceMultirailSellerLiveV1,
} from "../src/fixedPriceMultirailLive.js";

describe("fixed-price multirail live factories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    factories.x402Buyer.mockResolvedValue("x402-buyer");
    factories.payDemBuyer.mockResolvedValue("pay-dem-buyer");
    factories.x402Seller.mockResolvedValue("x402-seller");
    factories.payDemSeller.mockResolvedValue("pay-dem-seller");
    factories.join.mockImplementation((input) => ({ joined: input }));
  });

  it("joins buyer rails only when they share the exact actor and worker", async () => {
    const context = {};
    const x402 = { context, workerId: "buyer-worker", rail: "x402" };
    const payDem = { context, workerId: "buyer-worker", rail: "pay-dem" };
    await expect(createDacsFixedPriceMultirailBuyerLiveV1({
      x402,
      payDem,
    } as never)).resolves.toEqual({
      joined: { role: "buyer", x402: "x402-buyer", payDem: "pay-dem-buyer" },
    });
    expect(factories.x402Buyer).toHaveBeenCalledWith(x402);
    expect(factories.payDemBuyer).toHaveBeenCalledWith(payDem);
  });

  it("joins seller rails and preserves the x402 application boundary", async () => {
    const context = {};
    const x402 = { context, workerId: "seller-worker", rail: "x402" };
    const payDem = { context, workerId: "seller-worker", rail: "pay-dem" };
    await expect(createDacsFixedPriceMultirailSellerLiveV1({
      x402,
      payDem,
    } as never)).resolves.toEqual({
      joined: { role: "seller", x402: "x402-seller", payDem: "pay-dem-seller" },
    });
  });

  it("rejects rail factories backed by different actor contexts", async () => {
    await expect(createDacsFixedPriceMultirailBuyerLiveV1({
      x402: { context: {}, workerId: "worker" },
      payDem: { context: {}, workerId: "worker" },
    } as never)).rejects.toThrow(/actor-incompatible/);
    expect(factories.x402Buyer).not.toHaveBeenCalled();
  });
});
