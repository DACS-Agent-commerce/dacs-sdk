import { describe, expect, test } from "vitest";

import { baseUnits } from "../../src/canonical/decimal.js";
import {
  termsMatch,
  x402SettleCore,
  type X402ClientLike,
  type X402PaymentRequired,
} from "../../src/rails/x402.js";

const NETWORK = "eip155:84532";
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const PAYER = "0x2222222222222222222222222222222222222222";

describe("baseUnits (exact decimal → integer base units)", () => {
  test("USDC 6-decimal conversions are exact", () => {
    expect(baseUnits("1.5", 6)).toBe("1500000");
    expect(baseUnits("0.5", 6)).toBe("500000");
    expect(baseUnits("0", 6)).toBe("0");
    expect(baseUnits("1234.000001", 6)).toBe("1234000001");
  });

  test("rejects amounts with more precision than the token supports", () => {
    expect(() => baseUnits("1.1234567", 6)).toThrow(/precision/);
  });
});

describe("termsMatch (§4.1 abort guard)", () => {
  const expected = { network: NETWORK, recipientEvm: RECIPIENT, amount: "1.5", decimals: 6 };

  test("matches on equal terms (recipient case-insensitive)", () => {
    expect(
      termsMatch(expected, {
        network: NETWORK,
        payTo: RECIPIENT.toUpperCase(),
        amount: "1500000",
      }).ok,
    ).toBe(true);
  });

  test("rejects network mismatch", () => {
    const m = termsMatch(expected, { network: "eip155:8453", payTo: RECIPIENT, amount: "1500000" });
    expect(m.ok).toBe(false);
    expect(m.reason).toMatch(/network/);
  });

  test("rejects recipient mismatch", () => {
    const m = termsMatch(expected, { network: NETWORK, payTo: "0xdead", amount: "1500000" });
    expect(m.ok).toBe(false);
    expect(m.reason).toMatch(/recipient/);
  });

  test("rejects amount mismatch", () => {
    const m = termsMatch(expected, { network: NETWORK, payTo: RECIPIENT, amount: "9999999" });
    expect(m.ok).toBe(false);
    expect(m.reason).toMatch(/amount/);
  });
});

// ── A fake x402 client + fetch so the 402-dance is exercised without a chain ──

function fakeClient(accepts: X402PaymentRequired["accepts"], txHash = "0xsettled"): X402ClientLike {
  return {
    getPaymentRequiredResponse: () => ({ accepts }),
    createPaymentPayload: async (pr) => pr,
    encodePaymentSignatureHeader: () => ({ "X-PAYMENT": "signed" }),
    getPaymentSettleResponse: () => ({ transaction: txHash }),
  };
}

function fakeFetch(opts: { onPaid?: (init?: RequestInit) => void } = {}) {
  let call = 0;
  const impl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    call += 1;
    if (call === 1) {
      return new Response(JSON.stringify({ x402Version: 2 }), { status: 402 });
    }
    opts.onPaid?.(init);
    return new Response(JSON.stringify({ data: "ok" }), { status: 200 });
  };
  return impl as unknown as typeof fetch;
}

describe("x402SettleCore (buyer 402-dance)", () => {
  const params = {
    paywallUrl: "https://seller.example/deliver",
    network: NETWORK,
    recipientEvm: RECIPIENT,
    amount: "1.5",
    asset: "USDC",
    decimals: 6,
  };

  test("happy path: pays the matching requirement and returns settlement", async () => {
    let paidHeader = "";
    const fetchImpl = fakeFetch({
      onPaid: (init) => {
        paidHeader = new Headers(init?.headers).get("X-PAYMENT") ?? "";
      },
    });
    const client = fakeClient([{ network: NETWORK, payTo: RECIPIENT, amount: "1500000" }]);

    const res = await x402SettleCore(params, { client, fetchImpl, payerAddress: PAYER });

    expect(paidHeader).toBe("signed");
    expect(res).toEqual({
      ok: true,
      txHash: "0xsettled",
      chainId: NETWORK,
      payer: PAYER,
      payee: RECIPIENT,
    });
  });

  test("picks the matching requirement among several advertised", async () => {
    const client = fakeClient([
      { network: "eip155:8453", payTo: RECIPIENT, amount: "1500000" }, // wrong network
      { network: NETWORK, payTo: RECIPIENT, amount: "1500000" }, // the match
    ]);
    const res = await x402SettleCore(params, {
      client,
      fetchImpl: fakeFetch(),
      payerAddress: PAYER,
    });
    expect(res.ok).toBe(true);
  });

  test("aborts (§4.1) when no advertised requirement matches the agreement", async () => {
    const client = fakeClient([{ network: NETWORK, payTo: RECIPIENT, amount: "9999999" }]);
    await expect(
      x402SettleCore(params, { client, fetchImpl: fakeFetch(), payerAddress: PAYER }),
    ).rejects.toThrow(/does not match negotiated agreement/);
  });

  test("throws if the paywall doesn't return a 402", async () => {
    const fetchImpl = (async () =>
      new Response("{}", { status: 200 })) as unknown as typeof fetch;
    await expect(
      x402SettleCore(params, {
        client: fakeClient([]),
        fetchImpl,
        payerAddress: PAYER,
      }),
    ).rejects.toThrow(/expected HTTP 402/);
  });

  test("throws when the 402 advertises no requirements", async () => {
    await expect(
      x402SettleCore(params, {
        client: fakeClient([]),
        fetchImpl: fakeFetch(),
        payerAddress: PAYER,
      }),
    ).rejects.toThrow(/no .accepts. payment requirements/);
  });
});
