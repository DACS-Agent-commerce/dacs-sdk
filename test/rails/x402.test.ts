import { describe, expect, test } from "vitest";
import type { SettleResponse } from "@x402/core/types";

import { baseUnits } from "../../src/canonical/decimal.js";
import {
  createX402Rail,
  dacsX402AuthorizationNonce,
  termsMatch,
  verifyDacsX402AuthorizationNonce,
  x402Settle,
  x402SettleCore,
  type X402ClientLike,
  type X402PaymentRequired,
  type X402Rail,
  type X402SettleParams,
} from "../../src/rails/x402.js";

const NETWORK = "eip155:84532";
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const PAYER = "0x2222222222222222222222222222222222222222";
const HARDHAT_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784e7bf4f2ff80";

describe("DACS EIP-3009 session binding", () => {
  test("reproduces the normative SB-3 live, phase, job and ULID vectors", async () => {
    const vectors = [
      ["practice-dacs-0001", 3, "0x2fc3598e85489ed2fb4d2bf9f4eb5cc8dd6998eec89645d64450f9630240e1ff"],
      ["practice-dacs-0001", 4, "0x80fa47321a52f728f5ecbde7a5ceb44dd6086c9902dd8b95980b05909e5ea969"],
      ["practice-dacs-0002", 3, "0x69256a3bf1c9bd6a5ba1ffc93705d44c5322e03de8f1e3ad6b6d709f4254ce29"],
      ["01ARZ3NDEKTSV4RRFFQ69G5FAV", 3, "0xaeed3b79a6eedc2c19ce773a286dc5a897271cd92ed41a7f7ae5847fe3c9e9e2"],
    ] as const;
    for (const [jobId, phaseIndex, expected] of vectors) {
      expect(await dacsX402AuthorizationNonce({ jobId, phaseIndex })).toBe(expected);
    }
  });

  test("classifies matching, mismatching and malformed presented nonces", async () => {
    const input = { jobId: "practice-dacs-0001", phaseIndex: 3 };
    const expected = "0x2fc3598e85489ed2fb4d2bf9f4eb5cc8dd6998eec89645d64450f9630240e1ff";
    expect(await verifyDacsX402AuthorizationNonce(
      input,
      expected,
    )).toBe("present-and-matches");
    expect(await verifyDacsX402AuthorizationNonce(
      { ...input, phaseIndex: 4 },
      expected,
    )).toBe("present-and-mismatches");
    expect(await verifyDacsX402AuthorizationNonce(
      input,
      `0x${"0".repeat(64)}`,
    )).toBe("present-and-mismatches");
    expect(await verifyDacsX402AuthorizationNonce(
      input,
      `0x${"0".repeat(62)}`,
    )).toBe("malformed");
    expect(await verifyDacsX402AuthorizationNonce(input, "0".repeat(64))).toBe("malformed");
    expect(await verifyDacsX402AuthorizationNonce(input, `0x${"A".repeat(64)}`)).toBe("malformed");
  });

  test("the three normative retry cases retain the same derived nonce", async () => {
    const input = { jobId: "practice-dacs-0001", phaseIndex: 3 };
    const expected = "0x2fc3598e85489ed2fb4d2bf9f4eb5cc8dd6998eec89645d64450f9630240e1ff";
    // used+same-transfer resumes, used+different-transfer refuses, and cancelled
    // refuses at the reconcile layer; none may mint a replacement nonce.
    for (const _state of ["used-same", "used-different", "cancelled"]) {
      expect(await dacsX402AuthorizationNonce(input)).toBe(expected);
    }
  });

  test("rejects malformed derivation inputs", async () => {
    await expect(dacsX402AuthorizationNonce({
      jobId: "cafe\u0301-job",
      phaseIndex: 0,
    })).rejects.toThrow(/jobId|non-negative phaseIndex/);
    await expect(dacsX402AuthorizationNonce({
      jobId: "practice-dacs-0001",
      phaseIndex: -1,
    })).rejects.toThrow(/non-negative phaseIndex/);
    await expect(dacsX402AuthorizationNonce({
      jobId: "practice-dacs-0001",
      // @ts-expect-error — exercising the canonical integer runtime guard
      phaseIndex: "03",
    })).rejects.toThrow(/non-negative phaseIndex/);
  });

  test("fails closed when a production rail is asked to settle without a session binding", async () => {
    const rail = await createX402Rail({
      evmPrivateKey: HARDHAT_KEY,
      requireSessionBinding: true,
      fetchImpl: fakeFetch(),
    });
    await expect(rail.settle({
      paywallUrl: "https://seller.example/deliver",
      network: NETWORK,
      recipientEvm: RECIPIENT,
      amount: "1000000",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    })).rejects.toThrow(/jobId\/phaseIndex/);
  });
});

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

describe("termsMatch (§4.1 abort guard, base-unit amounts)", () => {
  // DACS Price.amount is already base units (e.g. "1000000" = 1.0 USDC).
  const expected = { network: NETWORK, recipientEvm: RECIPIENT, amount: "1000000" };

  test("matches on equal terms (recipient case-insensitive, leading zeros ok)", () => {
    expect(
      termsMatch(expected, {
        network: NETWORK,
        payTo: RECIPIENT.toUpperCase(),
        amount: "01000000",
      }).ok,
    ).toBe(true);
  });

  test("rejects network mismatch", () => {
    const m = termsMatch(expected, { network: "eip155:8453", payTo: RECIPIENT, amount: "1000000" });
    expect(m.ok).toBe(false);
    expect(m.reason).toMatch(/network/);
  });

  test("rejects recipient mismatch", () => {
    const m = termsMatch(expected, { network: NETWORK, payTo: "0xdead", amount: "1000000" });
    expect(m.ok).toBe(false);
    expect(m.reason).toMatch(/recipient/);
  });

  test("rejects amount mismatch", () => {
    const m = termsMatch(expected, { network: NETWORK, payTo: RECIPIENT, amount: "9999999" });
    expect(m.ok).toBe(false);
    expect(m.reason).toMatch(/amount/);
  });

  test("matches when the asset matches (case-insensitive)", () => {
    const m = termsMatch(
      { ...expected, asset: "USDC" },
      { network: NETWORK, payTo: RECIPIENT, amount: "1000000", asset: "usdc" },
    );
    expect(m.ok).toBe(true);
  });

  test("rejects a different asset for the same amount/recipient/chain", () => {
    const m = termsMatch(
      { ...expected, asset: "USDC" },
      { network: NETWORK, payTo: RECIPIENT, amount: "1000000", asset: "DAI" },
    );
    expect(m.ok).toBe(false);
    expect(m.reason).toMatch(/asset/);
  });

  test("rejects when the expected asset is set but the 402 omits it", () => {
    const m = termsMatch(
      { ...expected, asset: "USDC" },
      { network: NETWORK, payTo: RECIPIENT, amount: "1000000" },
    );
    expect(m.ok).toBe(false);
    expect(m.reason).toMatch(/asset/);
  });
});

// ── A fake x402 client + fetch so the 402-dance is exercised without a chain ──

function fakeClient(
  accepts: X402PaymentRequired["accepts"],
  settlement: Partial<SettleResponse> = {},
): X402ClientLike {
  return {
    getPaymentRequiredResponse: () => ({ accepts }),
    createPaymentPayload: async (pr) => pr,
    encodePaymentSignatureHeader: () => ({ "X-PAYMENT": "signed" }),
    getPaymentSettleResponse: () => ({
      success: true,
      transaction: "0xsettled",
      network: NETWORK,
      payer: PAYER,
      amount: "1000000",
      ...settlement,
    }),
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
    amount: "1000000",
    asset: "USDC",
  };

  test("happy path: pays the matching requirement and returns settlement", async () => {
    let paidHeader = "";
    const fetchImpl = fakeFetch({
      onPaid: (init) => {
        paidHeader = new Headers(init?.headers).get("X-PAYMENT") ?? "";
      },
    });
    const client = fakeClient([
      { network: NETWORK, payTo: RECIPIENT, amount: "1000000", asset: "USDC" },
    ]);

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
      { network: "eip155:8453", payTo: RECIPIENT, amount: "1000000", asset: "USDC" }, // wrong network
      { network: NETWORK, payTo: RECIPIENT, amount: "1000000", asset: "USDC" }, // the match
    ]);
    const res = await x402SettleCore(params, {
      client,
      fetchImpl: fakeFetch(),
      payerAddress: PAYER,
    });
    expect(res.ok).toBe(true);
  });

  test("aborts (§4.1) when no advertised requirement matches the agreement", async () => {
    const client = fakeClient([
      { network: NETWORK, payTo: RECIPIENT, amount: "9999999", asset: "USDC" },
    ]);
    await expect(
      x402SettleCore(params, { client, fetchImpl: fakeFetch(), payerAddress: PAYER }),
    ).rejects.toThrow(/does not match negotiated agreement/);
  });

  test("aborts when the 402 advertises a different asset (no wrong-token pay)", async () => {
    // Same chain, recipient, and base-unit amount — but a different token.
    const client = fakeClient([
      { network: NETWORK, payTo: RECIPIENT, amount: "1000000", asset: "DAI" },
    ]);
    await expect(
      x402SettleCore(params, { client, fetchImpl: fakeFetch(), payerAddress: PAYER }),
    ).rejects.toThrow(/asset mismatch/);
  });

  test("aborts when the 402 omits the asset (can't confirm the token)", async () => {
    const client = fakeClient([{ network: NETWORK, payTo: RECIPIENT, amount: "1000000" }]);
    await expect(
      x402SettleCore(params, { client, fetchImpl: fakeFetch(), payerAddress: PAYER }),
    ).rejects.toThrow(/asset mismatch/);
  });

  test("reports non-success when settlement returns no transaction id", async () => {
    // Gate passes (HTTP 200) but X-PAYMENT-RESPONSE carries no tx hash — an
    // unverifiable receipt. Must NOT be reported as a success.
    const client = fakeClient(
      [{ network: NETWORK, payTo: RECIPIENT, amount: "1000000", asset: "USDC" }],
      { transaction: "" },
    );
    const res = await x402SettleCore(params, {
      client,
      fetchImpl: fakeFetch(),
      payerAddress: PAYER,
    });
    expect(res.ok).toBe(false);
    expect(res.txHash).toBe("");
  });

  test("reports non-success when the x402 receipt says settlement failed", async () => {
    const client = fakeClient(
      [{ network: NETWORK, payTo: RECIPIENT, amount: "1000000", asset: "USDC" }],
      {
        success: false,
        errorReason: "settlement_failed",
        transaction: "0xfailed",
      },
    );
    const res = await x402SettleCore(params, {
      client,
      fetchImpl: fakeFetch(),
      payerAddress: PAYER,
    });
    expect(res.ok).toBe(false);
    expect(res.txHash).toBe("0xfailed");
  });

  test("reports non-success and preserves the actual network on a receipt mismatch", async () => {
    const client = fakeClient(
      [{ network: NETWORK, payTo: RECIPIENT, amount: "1000000", asset: "USDC" }],
      { network: "eip155:8453" },
    );
    const res = await x402SettleCore(params, {
      client,
      fetchImpl: fakeFetch(),
      payerAddress: PAYER,
    });
    expect(res.ok).toBe(false);
    expect(res.chainId).toBe("eip155:8453");
  });

  test("reports non-success and preserves the actual payer on a receipt mismatch", async () => {
    const otherPayer = "0x3333333333333333333333333333333333333333";
    const client = fakeClient(
      [{ network: NETWORK, payTo: RECIPIENT, amount: "1000000", asset: "USDC" }],
      { payer: otherPayer },
    );
    const res = await x402SettleCore(params, {
      client,
      fetchImpl: fakeFetch(),
      payerAddress: PAYER,
    });
    expect(res.ok).toBe(false);
    expect(res.payer).toBe(otherPayer);
  });

  test("does not treat a malformed present payer as an omitted payer", async () => {
    const client = fakeClient(
      [{ network: NETWORK, payTo: RECIPIENT, amount: "1000000", asset: "USDC" }],
      { payer: "" },
    );
    const res = await x402SettleCore(params, {
      client,
      fetchImpl: fakeFetch(),
      payerAddress: PAYER,
    });
    expect(res.ok).toBe(false);
  });

  test("reports non-success when the receipt amount contradicts the agreement", async () => {
    const client = fakeClient(
      [{ network: NETWORK, payTo: RECIPIENT, amount: "1000000", asset: "USDC" }],
      { amount: "999999" },
    );
    const res = await x402SettleCore(params, {
      client,
      fetchImpl: fakeFetch(),
      payerAddress: PAYER,
    });
    expect(res.ok).toBe(false);
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

describe("x402Settle bridge (#10: on-chain token id, not the price symbol)", () => {
  test("rejects a request/config destination mismatch before the rail or idempotency store", async () => {
    let calls = 0;
    const rail: X402Rail = {
      address: PAYER,
      settle: async () => {
        calls += 1;
        throw new Error("must not submit");
      },
    };
    const settle = x402Settle(rail, {
      url: "https://seller.example/deliver",
      network: NETWORK,
      recipientEvm: RECIPIENT,
      asset: "0xtoken",
    });
    expect(() =>
      settle({
        rail: "pay-x402",
        phase: "pay-x402",
        amount: "1",
        asset: "USDC",
        payee: "did:example:seller",
        expectedPayee: "0xwrong",
        jobId: "destination-mismatch",
      }),
    ).toThrow(/destination mismatch/);
    expect(calls).toBe(0);
  });

  test("hands the rail the configured token id as the guard's asset", async () => {
    let captured: X402SettleParams | undefined;
    const rail: X402Rail = {
      address: PAYER,
      settle: async (p) => {
        captured = p;
        return { ok: true, txHash: "0x1", chainId: NETWORK, payer: PAYER, payee: RECIPIENT };
      },
    };
    const settle = x402Settle(rail, {
      url: "https://seller.example/deliver",
      network: NETWORK,
      recipientEvm: RECIPIENT,
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // resolved token id
      phaseIndex: 3,
    });

    // runSession passes the human Price.asset symbol; the bridge must NOT use it
    // for the guard — it uses the rail-configured on-chain token id.
    await settle({
      rail: "pay-x402",
      phase: "pay-x402",
      amount: "1000000",
      asset: "USDC",
      payee: RECIPIENT,
      expectedPayee: RECIPIENT,
      jobId: "j1",
    });

    expect(captured?.asset).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    expect(captured?.amount).toBe("1000000");
    expect(captured?.jobId).toBe("j1");
    expect(captured?.phaseIndex).toBe(3);
  });

  test("binds the SESSION's phaseIndex (from req), not the static paywall config", async () => {
    // Regression: the bridge must source phaseIndex from the SettleRequest — the
    // same value the idempotency key uses — so the SB-3 nonce and the dedup key
    // describe the SAME phase. The paywall descriptor omits phaseIndex here (the
    // normal production shape); the session carries phase 2.
    let captured: X402SettleParams | undefined;
    const rail: X402Rail = {
      address: PAYER,
      settle: async (p) => {
        captured = p;
        return { ok: true, txHash: "0x1", chainId: NETWORK, payer: PAYER, payee: RECIPIENT };
      },
    };
    const settle = x402Settle(rail, {
      url: "https://seller.example/deliver",
      network: NETWORK,
      recipientEvm: RECIPIENT,
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      // no phaseIndex on the paywall — the old wiring omitted it to the rail,
      // which (with requireSessionBinding) threw on every settle.
    });

    await settle({
      rail: "pay-x402",
      phase: "pay-x402",
      amount: "1000000",
      asset: "USDC",
      payee: RECIPIENT,
      expectedPayee: RECIPIENT,
      jobId: "j1",
      phaseIndex: 2,
    });

    expect(captured?.phaseIndex).toBe(2);
  });

  test("a session with no phaseIndex binds phase 0 (never undefined) so the binding stays active", async () => {
    let captured: X402SettleParams | undefined;
    const rail: X402Rail = {
      address: PAYER,
      settle: async (p) => {
        captured = p;
        return { ok: true, txHash: "0x1", chainId: NETWORK, payer: PAYER, payee: RECIPIENT };
      },
    };
    const settle = x402Settle(rail, {
      url: "https://seller.example/deliver",
      network: NETWORK,
      recipientEvm: RECIPIENT,
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    });

    await settle({ rail: "pay-x402", phase: "pay-x402", amount: "1000000", asset: "USDC", payee: RECIPIENT, expectedPayee: RECIPIENT, jobId: "j1" });

    expect(captured?.phaseIndex).toBe(0);
  });
});
