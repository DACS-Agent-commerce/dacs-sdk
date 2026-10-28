import { readFileSync } from "node:fs";

import { describe, expect, test, vi } from "vitest";
import { keccak256, stringToHex } from "viem";

import { baseUnits } from "../../src/canonical/decimal.js";
import { isCanonicalJobId } from "../../src/negotiate/jobId.js";
import { x402Eip3009Nonce } from "../../src/seller/paymentIntake.js";
import {
  createX402Rail,
  dacsX402AuthorizationNonce,
  termsMatch,
  verifyDacsX402AuthorizationNonce,
  x402Settle,
  x402SettleCore,
  type X402ClientLike,
  type X402PaymentRequired,
  type X402PaidEffectFence,
  type X402Rail,
  type X402SettleCoreDeps,
  type X402SettleParams,
} from "../../src/rails/x402.js";

const NETWORK = "eip155:84532";
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const PAYER = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const TX_HASH = `0x${"a".repeat(64)}`;
const TEST_EVM_KEY = keccak256(stringToHex("dacs-sdk:test:x402-rail"));

// The Standard's full-input SB-3 vector: a schema-valid ULID at phase 3.
const ULID_JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ULID_PHASE_3_NONCE =
  "0xaeed3b79a6eedc2c19ce773a286dc5a897271cd92ed41a7f7ae5847fe3c9e9e2";
const SETTLE_JOB_ID = "01JA9X402RA11B1ND1NG000000";

describe("DACS EIP-3009 session binding", () => {
  test("replays the Standard SB-3 vectors: full-input cases bind, derivation-only jobIds are refused", async () => {
    const set = JSON.parse(readFileSync(new URL(
      "../../vendor/DACS-Standard/conformance/vectors/security/sb3-eip3009-nonce-v0.1.json",
      import.meta.url,
    ), "utf8")) as {
      vectors: Array<{
        name: string;
        jobId: string;
        phaseIndex: number;
        presentedNonce?: string;
        expectedNonce?: string;
        validationScope: "derivation-only" | "full-input";
        want: { binding?: string };
      }>;
    };
    let fullInput = 0;
    let refused = 0;
    for (const vector of set.vectors) {
      if (vector.validationScope === "full-input") {
        fullInput += 1;
        expect(await dacsX402AuthorizationNonce(vector), vector.name)
          .toBe(vector.expectedNonce);
        expect(await verifyDacsX402AuthorizationNonce(
          vector,
          vector.presentedNonce!,
        ), vector.name).toBe(vector.want.binding);
        continue;
      }
      // CORE JID-3: a derivation-only fixture's jobId is not JID-1, so the
      // buyer must classify it before hashing rather than reproduce the nonce.
      expect(isCanonicalJobId(vector.jobId), vector.name).toBe(false);
      refused += 1;
      await expect(dacsX402AuthorizationNonce(vector), vector.name)
        .rejects.toThrow("x402 DACS binding jobId must be a canonical uppercase ULID");
      if (vector.presentedNonce !== undefined) {
        expect(await verifyDacsX402AuthorizationNonce(
          vector,
          vector.presentedNonce,
        ), vector.name).toBe("malformed");
      }
    }
    expect(fullInput).toBe(1);
    expect(refused).toBe(set.vectors.length - 1);
  });

  test.each([
    ULID_JOB_ID.toLowerCase(),
    `${ULID_JOB_ID.slice(0, -1)}I`,
    `${ULID_JOB_ID.slice(0, -1)}L`,
    `${ULID_JOB_ID.slice(0, -1)}O`,
    `${ULID_JOB_ID.slice(0, -1)}U`,
    ` ${ULID_JOB_ID}`,
    `${ULID_JOB_ID}\n`,
    ULID_JOB_ID.slice(0, -1),
    `${ULID_JOB_ID}0`,
    `8${ULID_JOB_ID.slice(1)}`,
    `${ULID_JOB_ID.slice(0, -2)}%56`,
  ])("refuses non-JID-1 jobId %j before deriving or verifying the nonce", async (jobId) => {
    await expect(dacsX402AuthorizationNonce({ jobId, phaseIndex: 3 }))
      .rejects.toThrow("x402 DACS binding jobId must be a canonical uppercase ULID");
    // Even the nonce recomputed from the same malformed bytes is not accepted.
    expect(await verifyDacsX402AuthorizationNonce(
      { jobId, phaseIndex: 3 },
      x402Eip3009Nonce(jobId, 3),
    )).toBe("malformed");
  });

  test("classifies matching, mismatching and malformed presented nonces", async () => {
    const input = { jobId: ULID_JOB_ID, phaseIndex: 3 };
    const expected = ULID_PHASE_3_NONCE;
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

  // The SB-3 retry dispositions (used by this transfer resumes, used by another
  // refuses, cancelled refuses) are reconciled against chain evidence in
  // test/rails/x402BuyerEvmAuthorization.test.ts ("settled-same",
  // "used-different", "cancelled"). Here only the derivation is pinned: it is
  // a pure function of (jobId, phaseIndex), so a retry can never mint a
  // replacement nonce.
  test("derives the same nonce on every retry of the same job phase", async () => {
    const input = { jobId: ULID_JOB_ID, phaseIndex: 3 };
    const first = await dacsX402AuthorizationNonce(input);
    expect(first).toBe(ULID_PHASE_3_NONCE);
    expect(await dacsX402AuthorizationNonce({ ...input })).toBe(first);
    expect(await dacsX402AuthorizationNonce({ ...input, phaseIndex: 4 })).not.toBe(first);
  });

  // F18: JID-1 is a string grammar; a value that merely stringifies to a
  // canonical ULID is not one.
  test.each([
    [[ULID_JOB_ID]],
    [Object(ULID_JOB_ID)],
    [{ toString: () => ULID_JOB_ID }],
  ])("refuses a non-string jobId that coerces to a canonical ULID", async (jobId) => {
    expect(isCanonicalJobId(jobId)).toBe(false);
    await expect(dacsX402AuthorizationNonce({ jobId: jobId as never, phaseIndex: 3 }))
      .rejects.toThrow("x402 DACS binding jobId must be a canonical uppercase ULID");
  });

  test("rejects malformed derivation inputs", async () => {
    // A decomposed name is never NFC-repaired into a binding (JID-1/JID-3).
    await expect(dacsX402AuthorizationNonce({
      jobId: "cafe\u0301-job",
      phaseIndex: 0,
    })).rejects.toThrow("x402 DACS binding jobId must be a canonical uppercase ULID");
    await expect(dacsX402AuthorizationNonce({
      jobId: ULID_JOB_ID,
      phaseIndex: -1,
    })).rejects.toThrow(/non-negative phaseIndex/);
    await expect(dacsX402AuthorizationNonce({
      jobId: ULID_JOB_ID,
      // @ts-expect-error — exercising the canonical integer runtime guard
      phaseIndex: "03",
    })).rejects.toThrow(/non-negative phaseIndex/);
  });

  test("a production rail refuses a non-JID-1 jobId before any request or signature", async () => {
    const fetchImpl = vi.fn(fakeFetch());
    const rail = await createX402Rail({
      evmPrivateKey: TEST_EVM_KEY,
      requireSessionBinding: true,
      fetchImpl: fetchImpl as typeof fetch,
      transportPolicy: { mode: "insecure-test" },
      rpcUrl: "https://rpc.example",
      finalityBlocks: 2,
    });
    for (const jobId of [ULID_JOB_ID.toLowerCase(), "practice-dacs-0001"]) {
      await expect(rail.settle({
        paywallUrl: "https://seller.example/deliver",
        network: NETWORK,
        recipientEvm: RECIPIENT,
        amount: "1000000",
        asset: TOKEN,
        jobId,
        phaseIndex: 3,
      })).rejects.toThrow("pay-x402 jobId must be a canonical uppercase ULID");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("fails closed when a production rail is asked to settle without a session binding", async () => {
    const rail = await createX402Rail({
      evmPrivateKey: TEST_EVM_KEY,
      requireSessionBinding: true,
      fetchImpl: fakeFetch(),
      transportPolicy: { mode: "insecure-test" },
      rpcUrl: "https://rpc.example",
      finalityBlocks: 2,
    });
    await expect(rail.settle({
      paywallUrl: "https://seller.example/deliver",
      network: NETWORK,
      recipientEvm: RECIPIENT,
      amount: "1000000",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    })).rejects.toThrow(/jobId\/phaseIndex/);
  });

  test("refuses a fetch override without explicit insecure-test authority", async () => {
    await expect(createX402Rail({
      evmPrivateKey: TEST_EVM_KEY,
      fetchImpl: fakeFetch(),
      rpcUrl: "https://rpc.example",
      finalityBlocks: 2,
    })).rejects.toThrow(/explicit insecure-test mode/);
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

function fakeClient(accepts: X402PaymentRequired["accepts"]): X402ClientLike {
  return {
    getPaymentRequiredResponse: () => ({ accepts }),
    createPaymentPayload: async (pr) => pr,
    encodePaymentSignatureHeader: () => ({ "X-PAYMENT": "signed" }),
    getPaymentSettleResponse: () => ({
      success: true,
      transaction: TX_HASH,
      network: NETWORK,
      payer: PAYER,
      amount: "1000000",
    }),
  };
}

function encodedReceipt(settlement: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(settlement), "utf8").toString("base64");
}

function fakeFetch(opts: {
  onPaid?: (init?: RequestInit) => void;
  settlement?: Record<string, unknown>;
  omitReceipt?: boolean;
  rawReceipt?: string;
} = {}) {
  let call = 0;
  const impl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    call += 1;
    if (call === 1) {
      return new Response(JSON.stringify({ x402Version: 2 }), { status: 402 });
    }
    opts.onPaid?.(init);
    const settlement = opts.settlement ?? {
      success: true,
      transaction: TX_HASH,
      network: NETWORK,
      payer: PAYER,
      amount: "1000000",
      extensions: { retained: "yes" },
    };
    return new Response(JSON.stringify({ data: "ok" }), {
      status: 200,
      headers: opts.omitReceipt ? {} : {
        "PAYMENT-RESPONSE": opts.rawReceipt ?? encodedReceipt(settlement),
      },
    });
  };
  return impl as unknown as typeof fetch;
}

function coreDeps(
  client: X402ClientLike,
  fetchImpl: typeof fetch | undefined,
  authenticateTransfer: X402SettleCoreDeps["authenticateTransfer"] = async () => ({
    chainId: 84532,
    transactionHash: "a".repeat(64),
    logIndex: 7,
    blockNumber: 100,
    confirmations: 2,
    finalityObservedAt: 1_700_000_011_000,
  }),
) {
  return {
    client,
    ...(fetchImpl === undefined
      ? {}
      : { fetchImpl, transportPolicy: { mode: "insecure-test" as const } }),
    payerAddress: PAYER,
    assertFinalityContext: async () => {},
    authenticateTransfer,
  };
}

describe("x402SettleCore (buyer 402-dance)", () => {
  const params = {
    paywallUrl: "https://seller.example/deliver",
    network: NETWORK,
    recipientEvm: RECIPIENT,
    amount: "1000000",
    asset: TOKEN,
    finalityBlocks: 2,
  };

  test("happy path: pays the matching requirement and returns settlement", async () => {
    let paidHeader = "";
    const fetchImpl = fakeFetch({
      onPaid: (init) => {
        paidHeader = new Headers(init?.headers).get("X-PAYMENT") ?? "";
      },
    });
    const client = fakeClient([
      { network: NETWORK, payTo: RECIPIENT, amount: "1000000", asset: TOKEN },
    ]);

    const res = await x402SettleCore(params, coreDeps(client, fetchImpl));

    expect(paidHeader).toBe("signed");
    expect(res).toEqual(expect.objectContaining({
      ok: true,
      txHash: TX_HASH,
      chainId: NETWORK,
      payer: PAYER,
      payee: RECIPIENT,
      finality: { model: "block-depth", finalityBlocks: 2 },
      finalityObservedAt: 1_700_000_011_000,
      txRef: expect.objectContaining({
        kind: "x402-event",
        settlementTxHash: "a".repeat(64),
        chainId: 84532,
        logIndex: 7,
        protocolVersion: "2",
      }),
      x402Receipt: expect.objectContaining({
        headerName: "PAYMENT-RESPONSE",
        protocolVersion: "2",
      }),
    }));
  });

  test("checks the recovery generation before sending the signed payment", async () => {
    let paidRequests = 0;
    const fetchImpl = fakeFetch({ onPaid: () => { paidRequests += 1; } });
    const client = fakeClient([
      { network: NETWORK, payTo: RECIPIENT, amount: "1000000", asset: TOKEN },
    ]);
    let fenceChecks = 0;
    await expect(x402SettleCore(
      params,
      coreDeps(client, fetchImpl),
      {
        async assertCurrent() {
          fenceChecks += 1;
          throw new Error("stale effect generation");
        },
      },
    )).rejects.toThrow(/stale effect generation/);
    expect(fenceChecks).toBe(1);
    expect(paidRequests).toBe(0);
  });

  test("refuses paid redirects without forwarding the payment bearer", async () => {
    let calls = 0;
    let paidInit: RequestInit | undefined;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ x402Version: 2 }), { status: 402 });
      }
      if (calls === 2) {
        paidInit = init;
        return new Response(null, {
          status: 307,
          headers: { location: "https://attacker.example/collect" },
        });
      }
      throw new Error("payment bearer followed a redirect");
    }) as typeof fetch;
    const client = fakeClient([
      { network: NETWORK, payTo: RECIPIENT, amount: "1000000", asset: TOKEN },
    ]);

    await expect(x402SettleCore(params, coreDeps(client, fetchImpl)))
      .rejects.toThrow("x402-redirect-refused");
    expect(calls).toBe(2);
    expect(paidInit?.redirect).toBe("error");
    expect(paidInit?.credentials).toBe("omit");
    expect(new Headers(paidInit?.headers).get("X-PAYMENT")).toBe("signed");
  });

  test("default core transport rejects private DNS before payment signing", async () => {
    let signs = 0;
    const base = fakeClient([
      { network: NETWORK, payTo: RECIPIENT, amount: "1000000", asset: TOKEN },
    ]);
    const client: X402ClientLike = {
      ...base,
      async createPaymentPayload(paymentRequired) {
        signs += 1;
        return base.createPaymentPayload(paymentRequired);
      },
    };
    let requests = 0;
    await expect(x402SettleCore(params, {
      ...coreDeps(client, undefined),
      publicHttpsDependencies: {
        resolveHost: async () => ["127.0.0.1"],
        request: async () => {
          requests += 1;
          return new Response("must not connect");
        },
      },
    })).rejects.toThrow("x402-outbound-address-unsafe");
    expect(signs).toBe(0);
    expect(requests).toBe(0);
  });

  test("core never selects a fetch override without explicit test authority", async () => {
    const fetchImpl = vi.fn(async () => new Response("must not run"));
    await expect(x402SettleCore(params, {
      client: fakeClient([]),
      fetchImpl: fetchImpl as typeof fetch,
      payerAddress: PAYER,
      assertFinalityContext: async () => undefined,
      authenticateTransfer: async () => {
        throw new Error("must not authenticate");
      },
    })).rejects.toThrow("x402-fetch-override-requires-insecure-mode");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("canonicalizes the durable transaction identity from authenticated chain data", async () => {
    const upperHash = `0x${"A".repeat(64)}`;
    const client = fakeClient([
      { network: NETWORK, payTo: RECIPIENT, amount: "1000000", asset: TOKEN },
    ]);
    const result = await x402SettleCore(params, coreDeps(client, fakeFetch({
      settlement: {
        success: true,
        transaction: upperHash,
        network: NETWORK,
        payer: PAYER,
        amount: "1000000",
      },
    })));
    expect(result.txHash).toBe(TX_HASH);
    expect(result.txRef).toMatchObject({
      kind: "x402-event",
      settlementTxHash: "a".repeat(64),
    });
  });

  test("preflights finality before the first HTTP request or authorization", async () => {
    let fetchCalls = 0;
    let authorizationCalls = 0;
    let eventCalls = 0;
    const client = fakeClient([
      { network: NETWORK, payTo: RECIPIENT, amount: "1000000", asset: TOKEN },
    ]);
    client.createPaymentPayload = async () => {
      authorizationCalls += 1;
      throw new Error("must not authorize");
    };
    const fetchImpl = (async () => {
      fetchCalls += 1;
      throw new Error("must not fetch");
    }) as unknown as typeof fetch;
    await expect(x402SettleCore(params, {
      ...coreDeps(client, fetchImpl),
      assertFinalityContext: async () => {
        throw new Error("wrong RPC chain");
      },
      authenticateTransfer: async () => {
        eventCalls += 1;
        throw new Error("must not authenticate event");
      },
    })).rejects.toThrow(/wrong RPC chain/);
    expect(fetchCalls).toBe(0);
    expect(authorizationCalls).toBe(0);
    expect(eventCalls).toBe(0);
  });

  test("pins negotiated params before any async finality or HTTP callback", async () => {
    const entryHeaders = new Headers({ accept: "application/original+json" });
    const mutable: X402SettleParams = {
      ...params,
      requestInit: { headers: entryHeaders },
    };
    const underlyingFetch = fakeFetch();
    const requests: Array<{ url: string; policy: string | null }> = [];
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      requests.push({
        url: String(input),
        policy: new Headers(init?.headers).get("accept"),
      });
      return underlyingFetch(input, init);
    }) as typeof fetch;
    const client = fakeClient([
      { network: NETWORK, payTo: RECIPIENT, amount: "1000000", asset: TOKEN },
    ]);
    let authenticated: unknown;
    const result = await x402SettleCore(mutable, {
      ...coreDeps(client, fetchImpl, async (request) => {
        authenticated = request;
        return {
          chainId: 84532,
          transactionHash: "a".repeat(64),
          logIndex: 7,
          blockNumber: 100,
          confirmations: 2,
          finalityObservedAt: 1_700_000_011_000,
        };
      }),
      assertFinalityContext: async () => {
        entryHeaders.set("accept", "application/mutated+json");
        Object.assign(mutable, {
          paywallUrl: "https://attacker.example/deliver",
          network: "eip155:8453",
          recipientEvm: "0x3333333333333333333333333333333333333333",
          amount: "1",
          asset: "0x4444444444444444444444444444444444444444",
          finalityBlocks: 1,
          requestInit: { headers: { accept: "application/replacement+json" } },
        });
      },
    });

    expect(requests).toEqual([
      { url: params.paywallUrl, policy: "application/original+json" },
      { url: params.paywallUrl, policy: "application/original+json" },
    ]);
    expect(authenticated).toEqual({
      chainId: 84532,
      transactionHash: TX_HASH,
      tokenAddress: TOKEN,
      payerAddress: PAYER,
      payeeAddress: RECIPIENT,
      amount: 1000000n,
      minimumConfirmations: 2,
    });
    expect(result).toMatchObject({
      chainId: NETWORK,
      payee: RECIPIENT,
      finality: { model: "block-depth", finalityBlocks: 2 },
      txRef: { httpResource: params.paywallUrl },
    });
  });

  test("binds settlement dependencies and the paid-effect fence before the first await", async () => {
    let releasePreflight!: () => void;
    const preflightGate = new Promise<void>((resolve) => {
      releasePreflight = resolve;
    });
    const originalClient = fakeClient([
      { network: NETWORK, payTo: RECIPIENT, amount: "1000000", asset: TOKEN },
    ]);
    const originalFetch = fakeFetch();
    const originalAuthenticate = vi.fn(async () => ({
      chainId: 84532,
      transactionHash: "a".repeat(64),
      logIndex: 7,
      blockNumber: 100,
      confirmations: 2,
      finalityObservedAt: 1_700_000_011_000,
    }));
    const deps: X402SettleCoreDeps = {
      client: originalClient,
      fetchImpl: originalFetch,
      transportPolicy: { mode: "insecure-test" },
      payerAddress: PAYER,
      assertFinalityContext: async () => preflightGate,
      authenticateTransfer: originalAuthenticate,
    };
    const originalFence = vi.fn(async () => undefined);
    const substituted = vi.fn(() => {
      throw new Error("substituted dependency must not run");
    });
    const fence: X402PaidEffectFence = { assertCurrent: originalFence };
    const pending = x402SettleCore(params, deps, fence);
    originalClient.getPaymentRequiredResponse = substituted;
    originalClient.createPaymentPayload = substituted as never;
    originalClient.encodePaymentSignatureHeader = substituted;
    deps.fetchImpl = substituted as never;
    deps.authenticateTransfer = substituted as never;
    fence.assertCurrent = substituted as never;
    releasePreflight();
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(originalAuthenticate).toHaveBeenCalledOnce();
    expect(originalFence).toHaveBeenCalledOnce();
    expect(substituted).not.toHaveBeenCalled();
  });

  test("rejects accessor-backed client methods and payment-header output without invoking getters", async () => {
    let reads = 0;
    const accessorClient = fakeClient([]) as unknown as Record<string, unknown>;
    Object.defineProperty(accessorClient, "createPaymentPayload", {
      enumerable: true,
      get() {
        reads += 1;
        return async () => undefined;
      },
    });
    const fetchImpl = vi.fn(fakeFetch());
    await expect(x402SettleCore(params, {
      ...coreDeps(accessorClient as unknown as X402ClientLike, fetchImpl as typeof fetch),
    })).rejects.toThrow(/stable (?:data|method)/);
    expect(reads).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();

    const unsafeHeaderClient = fakeClient([
      { network: NETWORK, payTo: RECIPIENT, amount: "1000000", asset: TOKEN },
    ]);
    unsafeHeaderClient.encodePaymentSignatureHeader = () => {
      const headers = {} as Record<string, string>;
      Object.defineProperty(headers, "X-PAYMENT", {
        enumerable: true,
        get() {
          reads += 1;
          return "signed";
        },
      });
      return headers;
    };
    await expect(x402SettleCore(
      params,
      coreDeps(unsafeHeaderClient, fakeFetch()),
    )).rejects.toThrow(/unsafe headers/);
    expect(reads).toBe(0);
  });

  test("rejects accessor and proxy RequestInit before invoking their traps", async () => {
    let reads = 0;
    const accessor = {} as RequestInit;
    Object.defineProperty(accessor, "headers", {
      enumerable: true,
      get() {
        reads += 1;
        return { accept: "application/json" };
      },
    });
    const deps = coreDeps(fakeClient([]), fakeFetch());
    await expect(x402SettleCore({ ...params, requestInit: accessor }, deps))
      .rejects.toThrow(/credential-free GET/);
    await expect(x402SettleCore({
      ...params,
      requestInit: new Proxy({ headers: { accept: "application/json" } }, {}),
    }, deps)).rejects.toThrow(/credential-free GET/);
    expect(reads).toBe(0);
  });

  test("picks the matching requirement among several advertised", async () => {
    const client = fakeClient([
      { network: "eip155:8453", payTo: RECIPIENT, amount: "1000000", asset: TOKEN },
      { network: NETWORK, payTo: RECIPIENT, amount: "1000000", asset: TOKEN },
    ]);
    const res = await x402SettleCore(params, coreDeps(client, fakeFetch()));
    expect(res.ok).toBe(true);
  });

  test("aborts (§4.1) when no advertised requirement matches the agreement", async () => {
    const client = fakeClient([
      { network: NETWORK, payTo: RECIPIENT, amount: "9999999", asset: TOKEN },
    ]);
    await expect(
      x402SettleCore(params, coreDeps(client, fakeFetch())),
    ).rejects.toThrow(/does not match negotiated agreement/);
  });

  test("aborts when the 402 advertises a different asset (no wrong-token pay)", async () => {
    // Same chain, recipient, and base-unit amount — but a different token.
    const client = fakeClient([
      { network: NETWORK, payTo: RECIPIENT, amount: "1000000", asset: "0x1111111111111111111111111111111111111111" },
    ]);
    await expect(
      x402SettleCore(params, coreDeps(client, fakeFetch())),
    ).rejects.toThrow(/asset mismatch/);
  });

  test("aborts when the 402 omits the asset (can't confirm the token)", async () => {
    const client = fakeClient([{ network: NETWORK, payTo: RECIPIENT, amount: "1000000" }]);
    await expect(
      x402SettleCore(params, coreDeps(client, fakeFetch())),
    ).rejects.toThrow(/asset mismatch/);
  });

  test.each([
    ["missing transaction", { transaction: "" }],
    ["failed receipt", { success: false }],
    ["wrong network", { network: "eip155:8453" }],
    ["wrong payer", { payer: "0x3333333333333333333333333333333333333333" }],
    ["wrong amount", { amount: "999999" }],
  ])("rejects %s instead of producing current success", async (_name, change) => {
    const client = fakeClient([
      { network: NETWORK, payTo: RECIPIENT, amount: "1000000", asset: TOKEN },
    ]);
    await expect(x402SettleCore(params, coreDeps(client, fakeFetch({
      settlement: {
        success: true,
        transaction: TX_HASH,
        network: NETWORK,
        payer: PAYER,
        amount: "1000000",
        ...change,
      },
    })))).rejects.toThrow(/x402:/);
  });

  test("rejects success with no raw PAYMENT-RESPONSE", async () => {
    const client = fakeClient([
      { network: NETWORK, payTo: RECIPIENT, amount: "1000000", asset: TOKEN },
    ]);
    const authenticateTransfer = vi.fn(async () => {
      throw new Error("must not authenticate without a complete response");
    });
    await expect(x402SettleCore(
      params,
      coreDeps(client, fakeFetch({ omitReceipt: true }), authenticateTransfer),
    )).rejects.toThrow("x402: paid response returned HTTP 200 without PAYMENT-RESPONSE");
    expect(authenticateTransfer).not.toHaveBeenCalled();
  });

  // DACS-4 X402-4: without the complete successful response there is no
  // success, even when a conforming settlement header rides on an error.
  test.each([402, 409, 500])(
    "refuses a paid HTTP %i that carries a conforming PAYMENT-RESPONSE",
    async (status) => {
      const client = fakeClient([
        { network: NETWORK, payTo: RECIPIENT, amount: "1000000", asset: TOKEN },
      ]);
      const authenticateTransfer = vi.fn(async () => {
        throw new Error("must not authenticate a failed paid response");
      });
      let call = 0;
      const fetchImpl = (async () => {
        call += 1;
        if (call === 1) {
          return new Response(JSON.stringify({ x402Version: 2 }), { status: 402 });
        }
        return new Response(JSON.stringify({ error: "settlement failed" }), {
          status,
          headers: {
            "PAYMENT-RESPONSE": encodedReceipt({
              success: true,
              transaction: TX_HASH,
              network: NETWORK,
              payer: PAYER,
              amount: "1000000",
            }),
          },
        });
      }) as unknown as typeof fetch;
      await expect(x402SettleCore(params, coreDeps(client, fetchImpl, authenticateTransfer)))
        .rejects.toThrow(`x402: paid response returned HTTP ${status} with PAYMENT-RESPONSE`);
      expect(authenticateTransfer).not.toHaveBeenCalled();
    },
  );

  test("rejects malformed raw receipt and independent finality failure", async () => {
    const client = fakeClient([
      { network: NETWORK, payTo: RECIPIENT, amount: "1000000", asset: TOKEN },
    ]);
    await expect(x402SettleCore(
      params,
      coreDeps(client, fakeFetch({ rawReceipt: "not-base64" })),
    )).rejects.toThrow(/not conforming/);
    await expect(x402SettleCore(
      params,
      coreDeps(client, fakeFetch(), async () => {
        throw new Error("not final");
      }),
    )).rejects.toThrow(/not final/);
  });

  test("throws if the paywall doesn't return a 402", async () => {
    const fetchImpl = (async () =>
      new Response("{}", { status: 200 })) as unknown as typeof fetch;
    await expect(
      x402SettleCore(params, {
        client: fakeClient([]),
        fetchImpl,
        transportPolicy: { mode: "insecure-test" },
        payerAddress: PAYER,
        assertFinalityContext: async () => {},
        authenticateTransfer: async () => { throw new Error("unused"); },
      }),
    ).rejects.toThrow(/expected HTTP 402/);
  });

  test("throws when the 402 advertises no requirements", async () => {
    await expect(
      x402SettleCore(params, {
        client: fakeClient([]),
        fetchImpl: fakeFetch(),
        transportPolicy: { mode: "insecure-test" },
        payerAddress: PAYER,
        assertFinalityContext: async () => {},
        authenticateTransfer: async () => { throw new Error("unused"); },
      }),
    ).rejects.toThrow(/no .accepts. payment requirements/);
  });
});

describe("x402Settle bridge (#10: on-chain token id, not the price symbol)", () => {
  test("rejects a request/config destination mismatch before the rail or idempotency store", async () => {
    let calls = 0;
    const rail: X402Rail = {
      address: PAYER,
      finalityBlocks: 12,
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
        jobId: SETTLE_JOB_ID,
      }),
    ).toThrow(/destination mismatch/);
    expect(calls).toBe(0);
  });

  test("refuses a non-JID-1 jobId before the effect identity, idempotency store or rail", async () => {
    const railSettle = vi.fn(async () => {
      throw new Error("must not submit");
    });
    const store = {
      once: vi.fn(async () => {
        throw new Error("must not key an idempotency record");
      }),
    };
    const settle = x402Settle(
      { address: PAYER, finalityBlocks: 12, settle: railSettle },
      {
        url: "https://seller.example/deliver",
        network: NETWORK,
        recipientEvm: RECIPIENT,
        asset: TOKEN,
      },
      { store: store as never },
    );
    for (const jobId of [
      SETTLE_JOB_ID.toLowerCase(),
      `${SETTLE_JOB_ID.slice(0, -1)}O`,
      `${SETTLE_JOB_ID} `,
      "j1",
    ]) {
      expect(() => settle({
        rail: "pay-x402",
        phase: "pay-x402",
        amount: "1000000",
        asset: "USDC",
        payee: RECIPIENT,
        expectedPayee: RECIPIENT,
        jobId,
        phaseIndex: 1,
      })).toThrow("pay-x402 jobId must be a canonical uppercase ULID");
    }
    expect(store.once).not.toHaveBeenCalled();
    expect(railSettle).not.toHaveBeenCalled();
  });

  test("hands the rail the configured token id as the guard's asset", async () => {
    let captured: Omit<X402SettleParams, "finalityBlocks"> | undefined;
    const rail: X402Rail = {
      address: PAYER,
      finalityBlocks: 12,
      settle: async (p) => {
        captured = p;
        return {
          ok: true,
          txHash: "0x1",
          chainId: NETWORK,
          payer: PAYER,
          payee: RECIPIENT,
          finality: { model: "block-depth", finalityBlocks: 12 },
        };
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
      jobId: SETTLE_JOB_ID,
    });

    expect(captured?.asset).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    expect(captured?.amount).toBe("1000000");
    expect(captured?.jobId).toBe(SETTLE_JOB_ID);
    expect(captured?.phaseIndex).toBe(3);
  });

  test("binds the SESSION's phaseIndex (from req), not the static paywall config", async () => {
    // Regression: the bridge must source phaseIndex from the SettleRequest — the
    // same value the idempotency key uses — so the SB-3 nonce and the dedup key
    // describe the SAME phase. The paywall descriptor omits phaseIndex here (the
    // normal production shape); the session carries phase 2.
    let captured: Omit<X402SettleParams, "finalityBlocks"> | undefined;
    const rail: X402Rail = {
      address: PAYER,
      finalityBlocks: 12,
      settle: async (p) => {
        captured = p;
        return {
          ok: true,
          txHash: "0x1",
          chainId: NETWORK,
          payer: PAYER,
          payee: RECIPIENT,
          finality: { model: "block-depth", finalityBlocks: 12 },
        };
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
      jobId: SETTLE_JOB_ID,
      phaseIndex: 2,
    });

    expect(captured?.phaseIndex).toBe(2);
  });

  test("a session with no phaseIndex binds phase 0 (never undefined) so the binding stays active", async () => {
    let captured: Omit<X402SettleParams, "finalityBlocks"> | undefined;
    const rail: X402Rail = {
      address: PAYER,
      finalityBlocks: 12,
      settle: async (p) => {
        captured = p;
        return {
          ok: true,
          txHash: "0x1",
          chainId: NETWORK,
          payer: PAYER,
          payee: RECIPIENT,
          finality: { model: "block-depth", finalityBlocks: 12 },
        };
      },
    };
    const settle = x402Settle(rail, {
      url: "https://seller.example/deliver",
      network: NETWORK,
      recipientEvm: RECIPIENT,
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    });

    await settle({ rail: "pay-x402", phase: "pay-x402", amount: "1000000", asset: "USDC", payee: RECIPIENT, expectedPayee: RECIPIENT, jobId: SETTLE_JOB_ID });

    expect(captured?.phaseIndex).toBe(0);
  });
});

// Exercise the offline protocol below the unreleased live-profile boundary.
// The real, non-overridable boundary is covered by jid1LiveAdmission.test.ts.
vi.mock("../../src/negotiate/liveProfile.js", () => ({ requireJid1LiveProfile: vi.fn() }));
