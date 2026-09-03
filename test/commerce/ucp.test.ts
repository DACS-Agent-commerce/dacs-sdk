import { describe, expect, it, vi } from "vitest";

import {
  createUcpRestClient,
  DACS_UCP_X402_HANDLER,
  parseUcpBusinessProfile,
  UCP_MVP_VERSION,
} from "../../src/index.js";

const HASH = "a".repeat(64);
const IDEM = "b".repeat(64);

function rawProfile() {
  return {
    ucp: {
      version: UCP_MVP_VERSION,
      services: {
        "dev.ucp.shopping": [{
          version: UCP_MVP_VERSION,
          transport: "rest",
          endpoint: "https://merchant.example/ucp",
        }],
      },
      capabilities: {
        "dev.ucp.shopping.checkout": [{ version: UCP_MVP_VERSION }],
      },
      payment_handlers: {
        [DACS_UCP_X402_HANDLER]: [{
          id: "x402-base-sepolia",
          version: UCP_MVP_VERSION,
          config: {
            railId: "x402:default",
            network: "eip155:84532",
            checkoutCurrency: "USD",
            checkoutCurrencyDecimals: 2,
            assetAmountPerCheckoutUnit: "1",
            asset: `0x${"1".repeat(40)}`,
            assetSymbol: "USDC",
            assetDecimals: 6,
            payTo: `0x${"2".repeat(40)}`,
            resource: "https://merchant.example/pay/widget",
            finalityBlocks: 2,
          },
        }],
      },
    },
    keys: [{ kid: "merchant-key", kty: "OKP", crv: "Ed25519", x: HASH }],
  };
}

function readyCheckout() {
  return {
    ucp: {
      version: UCP_MVP_VERSION,
      payment_handlers: rawProfile().ucp.payment_handlers,
    },
    id: "checkout-1",
    line_items: [{
      id: "line-1",
      item: { id: "widget-1", title: "Widget", price: 100 },
      quantity: 1,
      totals: [{ type: "subtotal", amount: 100 }, { type: "total", amount: 100 }],
    }],
    status: "ready_for_complete",
    currency: "USD",
    totals: [{ type: "subtotal", amount: 100 }, { type: "total", amount: 100 }],
    links: [],
  };
}

describe("strict UCP REST boundary", () => {
  it("discovers the exact release and emits UCP-Agent plus deterministic idempotency", async () => {
    const business = parseUcpBusinessProfile(
      "https://merchant.example/.well-known/ucp",
      rawProfile(),
    );
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("UCP-Agent"))
        .toBe('profile="https://platform.example/.well-known/ucp"');
      expect(new Headers(init?.headers).get("Idempotency-Key")).toBe(IDEM);
      return new Response(JSON.stringify(readyCheckout()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const client = createUcpRestClient({
      business,
      platformProfileUrl: "https://platform.example/.well-known/ucp",
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect((await client.createCheckout({
      line_items: [{ item: { id: "widget-1" }, quantity: 1 }],
    }, IDEM)).id).toBe("checkout-1");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects private key material and insecure remote endpoints", () => {
    const privateProfile = rawProfile();
    (privateProfile.keys[0] as Record<string, unknown>).d = "private";
    expect(() => parseUcpBusinessProfile(
      "https://merchant.example/.well-known/ucp",
      privateProfile,
    )).toThrow(/must never expose private JWK material/);

    expect(() => parseUcpBusinessProfile(
      "http://merchant.example/.well-known/ucp",
      rawProfile(),
    )).toThrow(/must use HTTPS/);
  });

  it("rejects a completed checkout without an order confirmation", async () => {
    const business = parseUcpBusinessProfile(
      "https://merchant.example/.well-known/ucp",
      rawProfile(),
    );
    const malformed = { ...readyCheckout(), status: "completed" };
    const client = createUcpRestClient({
      business,
      platformProfileUrl: "https://platform.example/.well-known/ucp",
      fetchImpl: async () => new Response(JSON.stringify(malformed), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    });
    await expect(client.getCheckout("checkout-1"))
      .rejects.toThrow(/completed UCP Checkout must carry an order confirmation/);
  });

  it("bounds response bodies before parsing", async () => {
    const business = parseUcpBusinessProfile(
      "https://merchant.example/.well-known/ucp",
      rawProfile(),
    );
    const client = createUcpRestClient({
      business,
      platformProfileUrl: "https://platform.example/.well-known/ucp",
      fetchImpl: async () => new Response("{}", {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": "1048577",
        },
      }),
    });
    await expect(client.getCheckout("checkout-1")).rejects.toThrow(/byte limit/);
  });
});
