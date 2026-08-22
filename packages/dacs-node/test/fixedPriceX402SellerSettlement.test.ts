import { beforeEach, describe, expect, it, vi } from "vitest";
import { createX402Paywall } from "@kynesyslabs/dacs";

const factories = vi.hoisted(() => ({
  authority: vi.fn(),
  observer: vi.fn(),
}));

vi.mock("../src/fixedPriceX402SellerAuthority.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import(
    "../src/fixedPriceX402SellerAuthority.js"
  )>()),
  createDacsFixedPriceX402SellerAuthorityV1: factories.authority,
}));

vi.mock("../src/x402SellerEvm.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/x402SellerEvm.js")>()),
  createDacsX402SellerEvmObserverV1: factories.observer,
}));

import { createDacsFixedPriceX402SellerSettlementV1 } from
  "../src/fixedPriceX402SellerSettlement.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const PAYEE = `0x${"33".repeat(20)}`;
const ASSET = `0x${"44".repeat(20)}`;

function rail() {
  return Object.freeze({
    railVersion: 2,
    railId: "x402:test",
    railType: "x402" as const,
    asset: {
      kind: "erc20" as const,
      chainId: 84532,
      contract: ASSET,
      symbol: "USDC",
      decimals: 6,
    },
    network: {
      kind: "x402-resource" as const,
      resourceBaseUrl: "https://seller.example/dacs/x402/",
    },
    phaseHandler: "pay-x402" as const,
  });
}

describe("fixed-price seller settlement composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    factories.authority.mockReturnValue({
      resolveHttpScope: vi.fn(async () => ({
        paymentPhaseIndex: 2,
        httpResource: `https://seller.example/dacs/x402/${JOB_ID}`,
      })),
      resolveCommittedSession: vi.fn(),
      resolveOrderScope: vi.fn(),
      authorizePaymentComplete: vi.fn(),
      resolveCommittedAgreement: vi.fn(),
      resolveListingAtCommit: vi.fn(),
      resolveRail: vi.fn(),
      resolveIdentityBundle: vi.fn(),
      resolvePayerAddress: vi.fn(),
      resolvePayeeDestination: vi.fn(),
    });
    factories.observer.mockReturnValue({
      network: "eip155:84532",
      chainId: 84532,
      observeX402Transfer: vi.fn(),
      reconcileSettlement: vi.fn(),
      verifyX402ReceiptExtensions: vi.fn(),
      classifyX402SettlementChain: vi.fn(),
    });
  });

  it("derives one route, paywall and intake graph from the same rail", async () => {
    const facilitator = {
      verify: vi.fn(),
      settle: vi.fn(),
      getSupported: vi.fn(async () => ({
        kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }],
        extensions: [],
        signers: {},
      })),
    };
    const context = {
      role: "seller",
      evm: { role: "seller", address: PAYEE },
    };
    const authenticatedRail = rail();
    const result = createDacsFixedPriceX402SellerSettlementV1({
      context: context as never,
      rail: authenticatedRail as never,
      tokenDomain: { name: "USD Coin", version: "2" },
      amount: "1000000",
      facilitator,
      evmRpcUrl: "https://rpc.example",
      authorizationSearchFromBlock: 123,
      maxTimeoutSeconds: 120,
    });

    expect(result.paywall).toEqual({
      route: "GET /dacs/x402/:jobId",
      network: "eip155:84532",
      payTo: PAYEE,
      amount: "1000000",
      asset: ASSET,
      eip712: { name: "USD Coin", version: "2" },
      facilitator,
      maxTimeoutSeconds: 120,
    });
    expect(result.publicBaseUrl).toBe("https://seller.example/");
    expect(factories.authority).toHaveBeenCalledWith({
      context,
      rail: authenticatedRail,
      tokenDomain: { name: "USD Coin", version: "2" },
    });
    expect(factories.observer).toHaveBeenCalledWith({
      rail: authenticatedRail,
      rpcUrl: "https://rpc.example",
      authorizationSearchFromBlock: 123,
    });
    const authority = factories.authority.mock.results[0]!.value;
    const observer = factories.observer.mock.results[0]!.value;
    expect(result.spine.resolveCommittedSession).toBe(
      authority.resolveCommittedSession,
    );
    expect(result.spine.reconcileSettlement).toBe(observer.reconcileSettlement);
    expect(result.spine.paymentIntakeDeps.observeX402Transfer).toBe(
      observer.observeX402Transfer,
    );
    await expect(createX402Paywall(result.paywall, {
      settlementStore: {
        load: vi.fn(),
        claim: vi.fn(),
        recordOutcome: vi.fn(),
      },
      authorizeSettlement: vi.fn(),
      reconcileSettlement: vi.fn(),
      authorizePayment: vi.fn(),
      fulfil: vi.fn(),
    } as never)).resolves.toBeDefined();

    await expect(result.resolveHttpRequest({
      method: "GET",
      pathname: `/dacs/x402/${JOB_ID}`,
      url: `https://seller.example/dacs/x402/${JOB_ID}`,
    }, {} as never)).resolves.toEqual({
      status: "matched",
      jobId: JOB_ID,
      phaseIndex: 2,
    });
    await expect(result.resolveHttpRequest({
      method: "GET",
      pathname: `/dacs/x402/${JOB_ID}`,
      url: `https://seller.example/dacs/x402/${JOB_ID}?smuggled=1`,
    }, {} as never)).resolves.toEqual({
      status: "rejected",
      reasonCode: "x402-resource-binding-mismatch",
    });
    await expect(result.resolveHttpRequest({
      method: "POST",
      pathname: `/dacs/x402/${JOB_ID}`,
      url: `https://seller.example/dacs/x402/${JOB_ID}`,
    }, {} as never)).resolves.toEqual({
      status: "rejected",
      reasonCode: "x402-resource-request-invalid",
    });
  });

  it("refuses a non-x402 resource rail before creating executable callbacks", () => {
    expect(() => createDacsFixedPriceX402SellerSettlementV1({
      context: { role: "seller", evm: { role: "seller", address: PAYEE } } as never,
      rail: { ...rail(), network: { kind: "demos" } } as never,
      tokenDomain: { name: "USD Coin", version: "2" },
      amount: "1000000",
      facilitator: { verify: vi.fn(), settle: vi.fn(), getSupported: vi.fn() },
      evmRpcUrl: "https://rpc.example",
      authorizationSearchFromBlock: 1,
    })).toThrow("fixed-price seller settlement requires an x402 ERC-20 rail");
    expect(factories.authority).not.toHaveBeenCalled();
    expect(factories.observer).not.toHaveBeenCalled();
  });
});
