import { describe, expect, it, vi } from "vitest";

import { canonicalize, sha256Hex } from "../../src/canonical/index.js";
import {
  createX402Paywall,
  x402Eip3009Nonce,
  x402PaywallCore,
  x402PaywallFulfilmentKey,
  x402PaywallSettlementKey,
  type X402PaywallConfig,
  type X402PaywallCoreDeps,
  type X402PaywallHttpAdapter,
  type X402PaywallHttpContext,
  type X402PaywallPaymentPayload,
  type X402PaywallPaymentRequirements,
  type X402PaywallProcessResult,
  type X402PaywallServerLike,
  type X402PaywallSettlementIntent,
  type X402PaywallSettlementOutcome,
  type X402PaywallSettlementResult,
  type X402PaywallSettlementStore,
} from "../../src/index.js";
import { dacsX402AuthorizationNonce } from "../../src/rails/x402.js";

const NETWORK = "eip155:84532" as const;
const PAYER = `0x${"11".repeat(20)}`;
const PAY_TO = `0x${"22".repeat(20)}`;
const ASSET = `0x${"33".repeat(20)}`;
const TX_HASH = `0x${"ab".repeat(32)}`;
const JOB_ID = "seller-paywall-job";
const PHASE_INDEX = 2;
const AMOUNT = "250000";

it("keeps buyer and seller SB-3 nonce derivation byte-identical", async () => {
  expect(await dacsX402AuthorizationNonce({
    jobId: JOB_ID,
    phaseIndex: PHASE_INDEX,
  })).toBe(x402Eip3009Nonce(JOB_ID, PHASE_INDEX));
});

const expected = {
  network: NETWORK,
  payTo: PAY_TO,
  amount: AMOUNT,
  asset: ASSET,
  eip712: { name: "USDC", version: "2" },
};

function request(headers: Record<string, string> = {}): X402PaywallHttpAdapter {
  const normalized = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    getHeader: (name) => normalized.get(name.toLowerCase()),
    getMethod: () => "GET",
    getPath: () => `/deliver/${JOB_ID}`,
    getUrl: () => `https://seller.example/deliver/${JOB_ID}`,
    getAcceptHeader: () => "application/json",
    getUserAgent: () => "dacs-test",
  };
}

async function paymentFixture(nonce?: string): Promise<{
  requirements: X402PaywallPaymentRequirements;
  payload: X402PaywallPaymentPayload;
}> {
  const requirements: X402PaywallPaymentRequirements = {
    scheme: "exact",
    network: NETWORK,
    asset: ASSET,
    amount: AMOUNT,
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { name: "USDC", version: "2" },
  };
  return {
    requirements,
    payload: {
      x402Version: 2,
      accepted: { ...requirements },
      payload: {
        authorization: {
          from: PAYER,
          to: PAY_TO,
          value: AMOUNT,
          validAfter: "0",
          validBefore: "9999999999",
          nonce: nonce ?? x402Eip3009Nonce(JOB_ID, PHASE_INDEX),
        },
        signature: `0x${"44".repeat(65)}`,
      },
    },
  };
}

function responseHeader(receipt: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(receipt), "utf8").toString("base64");
}

function paidRequest(payload: X402PaywallPaymentPayload): X402PaywallHttpAdapter {
  return request({
    "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
  });
}

function successfulSettlement(
  requirements: X402PaywallPaymentRequirements,
  overrides: Partial<X402PaywallSettlementResult & { success: true }> = {},
): X402PaywallSettlementResult & { success: true } {
  const receipt = {
    success: true as const,
    transaction: TX_HASH,
    network: NETWORK,
    payer: PAYER,
    amount: AMOUNT,
    extensions: { facilitator: { trace: "kept" } },
  };
  return {
    ...receipt,
    headers: { "PAYMENT-RESPONSE": responseHeader(receipt) },
    requirements,
    ...overrides,
    success: true as const,
  };
}

function mockServer(options: {
  process: X402PaywallProcessResult | (() => Promise<X402PaywallProcessResult>);
  settlement?: X402PaywallSettlementResult | (() => Promise<X402PaywallSettlementResult>);
}): X402PaywallServerLike & {
  processHTTPRequest: ReturnType<typeof vi.fn>;
  processSettlement: ReturnType<typeof vi.fn>;
} {
  return {
    initialize: vi.fn(async () => undefined),
    processHTTPRequest: vi.fn(async () =>
      typeof options.process === "function" ? options.process() : options.process),
    processSettlement: vi.fn(async () => {
      if (typeof options.settlement === "function") return options.settlement();
      if (!options.settlement) throw new Error("unexpected settlement");
      return options.settlement;
    }),
  };
}

function settlementStore(): X402PaywallSettlementStore & {
  retained: Map<string, {
    intent: X402PaywallSettlementIntent;
    outcome?: X402PaywallSettlementOutcome;
  }>;
} {
  const retained = new Map<string, {
    intent: X402PaywallSettlementIntent;
    outcome?: X402PaywallSettlementOutcome;
  }>();
  return {
    retained,
    async load(settlementKey) {
      const existing = retained.get(settlementKey);
      if (!existing) return { status: "absent" };
      if (existing.outcome) {
        return {
          status: existing.outcome.status,
          intent: structuredClone(existing.intent),
          outcome: structuredClone(existing.outcome),
        };
      }
      return { status: "held", intent: structuredClone(existing.intent) };
    },
    async claim(input) {
      const intent = structuredClone(input);
      const existing = retained.get(intent.settlementKey);
      if (!existing) {
        retained.set(intent.settlementKey, { intent });
        return { status: "claimed", intent };
      }
      if (existing.intent.bindingHash !== intent.bindingHash) return { status: "conflict" };
      if (existing.outcome) {
        return {
          status: existing.outcome.status,
          intent: structuredClone(existing.intent),
          outcome: structuredClone(existing.outcome),
        };
      }
      return { status: "held", intent: structuredClone(existing.intent) };
    },
    async recordOutcome(input) {
      const existing = retained.get(input.settlementKey);
      if (!existing || existing.intent.bindingHash !== input.bindingHash) {
        return { status: "conflict" };
      }
      const outcome = structuredClone(input.outcome);
      if (existing.outcome && canonicalize(existing.outcome) !== canonicalize(outcome)) {
        return { status: "conflict" };
      }
      existing.outcome ??= outcome;
      return {
        status: existing.outcome.status,
        intent: structuredClone(existing.intent),
        outcome: structuredClone(existing.outcome),
      };
    },
  };
}

function coreDeps<T = unknown>(
  server: X402PaywallServerLike,
  overrides: Partial<X402PaywallCoreDeps<{ permitId: string }, T>> = {},
): X402PaywallCoreDeps<{ permitId: string }, T> {
  return {
    server,
    expected,
    settlementStore: settlementStore(),
    authorizeSettlement: async () => ({
      disposition: "authorized",
      authorization: { scopeVersion: "test-1", jobId: JOB_ID },
    }),
    reconcileSettlement: async () => ({ status: "pending", reason: "still-pending" }),
    authorizePayment: async () => ({
      disposition: "authorized",
      authorization: { permitId: "permit-1" },
    }),
    fulfil: async () => ({ disposition: "fulfilled" }),
    ...overrides,
  };
}

describe("x402PaywallCore — DACS-4 §9.5.7/§9.5.8", () => {
  it("fails closed instead of throwing on malformed input or provider results", async () => {
    const challengeServer = mockServer({
      process: {
        type: "payment-error",
        response: { status: 402, headers: { "PAYMENT-REQUIRED": "challenge" } },
      },
    });
    await expect(x402PaywallCore(
      undefined as unknown as Parameters<typeof x402PaywallCore>[0],
      coreDeps(challengeServer),
    )).resolves.toMatchObject({
      disposition: "rejected",
      reason: "invalid-http-adapter",
    });

    const throwingResult = Object.defineProperty({}, "type", {
      get() {
        throw new Error("provider-owned getter failed");
      },
    }) as X402PaywallProcessResult;
    const providerServer = mockServer({ process: throwingResult });
    await expect(x402PaywallCore(
      { jobId: JOB_ID, phaseIndex: PHASE_INDEX, request: request() },
      coreDeps(providerServer),
    )).resolves.toMatchObject({
      disposition: "indeterminate",
      reason: "invalid-payment-protocol-response",
    });
  });

  it("returns the 402 challenge without invoking fulfilment or settlement", async () => {
    const server = mockServer({
      process: {
        type: "payment-error",
        response: { status: 402, headers: { "PAYMENT-REQUIRED": "challenge" } },
      },
    });
    const fulfil = vi.fn();

    const result = await x402PaywallCore(
      { jobId: JOB_ID, phaseIndex: PHASE_INDEX, request: request() },
      coreDeps(server, { fulfil }),
    );

    expect(result.disposition).toBe("payment-required");
    expect(fulfil).not.toHaveBeenCalled();
    expect(server.processSettlement).not.toHaveBeenCalled();
  });

  it("fails closed when a configured route is unexpectedly unprotected", async () => {
    const server = mockServer({ process: { type: "no-payment-required" } });
    const fulfil = vi.fn();
    const result = await x402PaywallCore(
      { jobId: JOB_ID, phaseIndex: PHASE_INDEX, request: request() },
      coreDeps(server, { fulfil }),
    );
    expect(result).toMatchObject({
      disposition: "rejected",
      settled: false,
      reason: "configured-route-was-not-protected",
      response: { status: 500 },
    });
    expect(fulfil).not.toHaveBeenCalled();
  });

  it("rejects a verified payment carrying the wrong session nonce before work", async () => {
    const { payload, requirements } = await paymentFixture(`0x${"ff".repeat(32)}`);
    const cancel = vi.fn(async () => undefined);
    const server = mockServer({
      process: {
        type: "payment-verified",
        paymentPayload: payload,
        paymentRequirements: requirements,
        cancellationDispatcher: { cancel },
      },
    });
    const fulfil = vi.fn();

    const result = await x402PaywallCore(
      { jobId: JOB_ID, phaseIndex: PHASE_INDEX, request: paidRequest(payload) },
      coreDeps(server, { fulfil }),
    );

    expect(result).toMatchObject({
      disposition: "rejected",
      reason: "payment-session-or-terms-mismatch",
      response: { status: 403 },
    });
    expect(cancel).toHaveBeenCalledWith({
      reason: "handler_failed",
      responseStatus: 403,
    });
    expect(fulfil).not.toHaveBeenCalled();
    expect(server.processSettlement).not.toHaveBeenCalled();
  });

  it("never invokes fulfilment when the post-settlement payment gate rejects", async () => {
    const { payload, requirements } = await paymentFixture();
    const cancel = vi.fn(async () => undefined);
    const settlement = successfulSettlement(requirements);
    const server = mockServer({
      process: {
        type: "payment-verified",
        paymentPayload: payload,
        paymentRequirements: requirements,
        cancellationDispatcher: { cancel },
      },
      settlement,
    });
    const fulfil = vi.fn(async () => ({ disposition: "fulfilled" as const }));

    const result = await x402PaywallCore(
      { jobId: JOB_ID, phaseIndex: PHASE_INDEX, request: paidRequest(payload) },
      coreDeps(server, {
        authorizePayment: async () => ({
          disposition: "rejected",
          reason: "agreement-not-finalized",
        }),
        fulfil,
      }),
    );

    expect(result).toMatchObject({
      disposition: "authorization-rejected",
      settled: true,
      reason: "agreement-not-finalized",
      response: { status: 403 },
    });
    expect(server.processSettlement).toHaveBeenCalledTimes(1);
    expect(fulfil).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("requires authoritative reconciliation before treating settlement as failed", async () => {
    const { payload, requirements } = await paymentFixture();
    const failedSettlement: X402PaywallSettlementResult & { success: false } = {
      success: false,
      transaction: "",
      network: NETWORK,
      errorReason: "insufficient_funds",
      headers: {},
      response: {
        status: 402,
        headers: { "content-type": "application/json" },
        body: { error: "settlement-failed" },
      },
    };
    const server = mockServer({
      process: {
        type: "payment-verified",
        paymentPayload: payload,
        paymentRequirements: requirements,
        cancellationDispatcher: { cancel: vi.fn(async () => undefined) },
      },
      settlement: failedSettlement,
    });
    const fulfil = vi.fn(async () => ({ disposition: "fulfilled" as const }));

    const result = await x402PaywallCore(
      { jobId: JOB_ID, phaseIndex: PHASE_INDEX, request: paidRequest(payload) },
      coreDeps(server, {
        reconcileSettlement: async () => ({
          status: "failed",
          reason: "insufficient_funds",
          settlement: failedSettlement,
        }),
        fulfil,
      }),
    );

    expect(result).toMatchObject({
      disposition: "settlement-failed",
      settled: false,
      response: { status: 402, body: { error: "settlement-failed" } },
    });
    expect(fulfil).not.toHaveBeenCalled();
  });

  it("runs verify → pre-authorize → settle → authorize → fulfil and emits an exact payment claim", async () => {
    const { payload, requirements } = await paymentFixture();
    const order: string[] = [];
    const settlement = successfulSettlement(requirements);
    const server = mockServer({
      process: async () => {
        order.push("verify");
        return {
          type: "payment-verified",
          paymentPayload: payload,
          paymentRequirements: requirements,
          cancellationDispatcher: { cancel: vi.fn(async () => undefined) },
        };
      },
      settlement: async () => {
        order.push("settle");
        return settlement;
      },
    });

    const result = await x402PaywallCore(
      { jobId: JOB_ID, phaseIndex: PHASE_INDEX, request: paidRequest(payload) },
      coreDeps(server, {
        authorizeSettlement: async () => {
          order.push("pre-authorize");
          return {
            disposition: "authorized",
            authorization: { scopeVersion: "test-1", jobId: JOB_ID },
          };
        },
        authorizePayment: async (context) => {
          order.push("authorize");
          expect(context.sessionAuthorization).toEqual({
            scopeVersion: "test-1",
            jobId: JOB_ID,
          });
          return {
            disposition: "authorized",
            authorization: { permitId: "permit-1" },
          };
        },
        fulfil: async (context) => {
          order.push("fulfil");
          expect(context.idempotencyKey).toBe(x402PaywallFulfilmentKey({
            jobId: JOB_ID,
            phaseIndex: PHASE_INDEX,
          }));
          expect(context.authorization).toEqual({ permitId: "permit-1" });
          expect(Object.isFrozen(context.authorization)).toBe(true);
          return {
            disposition: "fulfilled",
            status: 201,
            headers: {
              "x-delivery": "ready",
              "payment-response": "application-must-not-override-protocol",
            },
            body: { deliverable: "released-only-after-settlement" },
          };
        },
      }),
    );

    expect(order).toEqual([
      "verify",
      "pre-authorize",
      "settle",
      "authorize",
      "fulfil",
    ]);
    expect(result).toMatchObject({
      disposition: "settled",
      settled: true,
      payer: PAYER,
      response: {
        status: 201,
        body: { deliverable: "released-only-after-settlement" },
      },
      paymentClaim: {
        kind: "pay-x402",
        protocolVersion: "2",
        httpResource: `https://seller.example/deliver/${JOB_ID}`,
        settlementTxHash: TX_HASH,
        chainId: 84532,
      },
    });
    if (result.disposition !== "settled") throw new Error("expected settled result");
    expect(result.response.headers["PAYMENT-RESPONSE"]).toBe(
      settlement.headers["PAYMENT-RESPONSE"],
    );
    expect(result.response.headers["payment-response"]).toBeUndefined();
    expect(result.paymentClaim.paymentReceiptHash).toBe(
      sha256Hex(canonicalize({
        success: true,
        transaction: TX_HASH,
        network: NETWORK,
        payer: PAYER,
        amount: AMOUNT,
        extensions: { facilitator: { trace: "kept" } },
      })),
    );
    // The paywall authenticates only the complete receipt envelope. It cannot
    // mint the v0.6 event coordinate; seller intake adds that only after an
    // independent finalized ledger observation.
    expect(result.paymentClaim).not.toHaveProperty("logIndex");
    expect(result.paymentClaim).not.toHaveProperty("settlementId");
  });

  it("isolates and freezes every security-bearing callback boundary", async () => {
    const { payload, requirements } = await paymentFixture();
    const settlement = successfulSettlement(requirements);
    const mutableExpected = structuredClone(expected);
    const backing = settlementStore();
    const store: X402PaywallSettlementStore = {
      load: (key) => backing.load(key),
      claim: async (intent) => {
        expect(Object.isFrozen(intent)).toBe(true);
        expect(Object.isFrozen(intent.paymentPayload.payload)).toBe(true);
        return backing.claim(intent);
      },
      recordOutcome: async (input) => {
        expect(Object.isFrozen(input.outcome)).toBe(true);
        return backing.recordOutcome(input);
      },
    };
    const server = mockServer({
      process: {
        type: "payment-verified",
        paymentPayload: payload,
        paymentRequirements: requirements,
        cancellationDispatcher: { cancel: vi.fn(async () => undefined) },
      },
      settlement,
    });
    server.processSettlement.mockImplementation(async (
      settlementPayload: X402PaywallPaymentPayload,
      settlementRequirements: X402PaywallPaymentRequirements,
    ) => {
      expect(Object.isFrozen(settlementPayload)).toBe(true);
      expect(Object.isFrozen(settlementPayload.payload)).toBe(true);
      expect(Object.isFrozen(settlementRequirements)).toBe(true);
      expect(() => {
        settlementPayload.x402Version = 1;
      }).toThrow();
      mutableExpected.amount = "1";
      return settlement;
    });
    const body = { delivery: { token: "original" } };
    let authorizationSettlement: unknown;

    const result = await x402PaywallCore(
      { jobId: JOB_ID, phaseIndex: PHASE_INDEX, request: paidRequest(payload) },
      coreDeps(server, {
        expected: mutableExpected,
        settlementStore: store,
        authorizePayment: async (context) => {
          expect(Object.isFrozen(context)).toBe(true);
          expect(Object.isFrozen(context.paymentClaim)).toBe(true);
          expect(Object.isFrozen(context.settlement)).toBe(true);
          authorizationSettlement = context.settlement;
          return {
            disposition: "authorized",
            authorization: { permitId: "permit-1", nested: { retained: true } },
          };
        },
        fulfil: async (context) => {
          expect(Object.isFrozen(context)).toBe(true);
          expect(Object.isFrozen(context.authorization)).toBe(true);
          expect(Object.isFrozen((context.authorization as unknown as {
            nested: { retained: boolean };
          }).nested)).toBe(true);
          expect(Object.isFrozen(context.paymentPayload.payload)).toBe(true);
          expect(Object.isFrozen(context.paymentClaim)).toBe(true);
          expect(context.settlement).not.toBe(authorizationSettlement);
          return { disposition: "fulfilled", body };
        },
      }),
    );
    expect(result).toMatchObject({
      disposition: "settled",
      response: { body: { delivery: { token: "original" } } },
    });
    body.delivery.token = "caller-mutated-after-return";
    expect(result.response.body).toEqual({ delivery: { token: "original" } });
  });

  it("requires the exact retained PAYMENT-SIGNATURE before bypassing provider verification", async () => {
    const { payload, requirements } = await paymentFixture();
    const settlement = successfulSettlement(requirements);
    const verified: X402PaywallProcessResult = {
      type: "payment-verified",
      paymentPayload: payload,
      paymentRequirements: requirements,
      cancellationDispatcher: { cancel: vi.fn(async () => undefined) },
    };
    const process = vi.fn()
      .mockResolvedValueOnce(verified)
      .mockResolvedValue({
        type: "payment-error",
        response: { status: 402, headers: { "PAYMENT-REQUIRED": "retry-challenge" } },
      });
    const server = mockServer({ process, settlement });
    const authorizePayment = vi.fn(async () => ({
      disposition: "indeterminate" as const,
      reason: "authorization-write-pending",
    }));
    const fulfil = vi.fn();
    const deps = coreDeps(server, {
      settlementStore: settlementStore(),
      authorizePayment,
      fulfil,
    });

    const first = await x402PaywallCore(
      { jobId: JOB_ID, phaseIndex: PHASE_INDEX, request: paidRequest(payload) },
      deps,
    );
    expect(first).toMatchObject({
      disposition: "authorization-indeterminate",
      settled: true,
    });

    // Same parsed JSON, different bearer bytes. The phase is already reserved,
    // so this is an indeterminate conflict, never a fresh unpaid request.
    const differentlyEncoded = request({
      "PAYMENT-SIGNATURE": Buffer.from(
        JSON.stringify(payload, null, 2),
        "utf8",
      ).toString("base64"),
    });
    const retried = await x402PaywallCore(
      { jobId: JOB_ID, phaseIndex: PHASE_INDEX, request: differentlyEncoded },
      deps,
    );
    expect(retried).toMatchObject({
      disposition: "indeterminate",
      settled: "unknown",
      reason: "settlement-authorization-conflict",
      response: { status: 409 },
    });
    expect(server.processHTTPRequest).toHaveBeenCalledTimes(1);
    expect(server.processSettlement).toHaveBeenCalledTimes(1);
    expect(authorizePayment).toHaveBeenCalledTimes(1);
    expect(fulfil).not.toHaveBeenCalled();
  });

  it("does not release work when a successful settlement lacks a verifiable receipt", async () => {
    const { payload, requirements } = await paymentFixture();
    const settlement = successfulSettlement(requirements, {
      headers: { "PAYMENT-RESPONSE": "not-base64!" },
    });
    const server = mockServer({
      process: {
        type: "payment-verified",
        paymentPayload: payload,
        paymentRequirements: requirements,
        cancellationDispatcher: { cancel: vi.fn(async () => undefined) },
      },
      settlement,
    });
    const authorizePayment = vi.fn();
    const fulfil = vi.fn();
    const result = await x402PaywallCore(
      { jobId: JOB_ID, phaseIndex: PHASE_INDEX, request: paidRequest(payload) },
      coreDeps(server, { authorizePayment, fulfil }),
    );
    expect(result).toMatchObject({
      disposition: "settlement-evidence-indeterminate",
      settled: true,
      reason: "settled-receipt-is-not-dacs-verifiable",
      response: { status: 503 },
      settlement: { success: true, transaction: TX_HASH },
    });
    expect(result.response.body).not.toBe("secret");
    expect(authorizePayment).not.toHaveBeenCalled();
    expect(fulfil).not.toHaveBeenCalled();
  });

  it("rejects case-aliased settlement headers instead of verifying one and releasing another", async () => {
    const { payload, requirements } = await paymentFixture();
    const settlement = successfulSettlement(requirements);
    const server = mockServer({
      process: {
        type: "payment-verified",
        paymentPayload: payload,
        paymentRequirements: requirements,
        cancellationDispatcher: { cancel: vi.fn(async () => undefined) },
      },
      settlement: {
        ...settlement,
        headers: {
          "PAYMENT-RESPONSE": settlement.headers["PAYMENT-RESPONSE"]!,
          "payment-response": responseHeader({
            success: true,
            transaction: `0x${"cd".repeat(32)}`,
            network: NETWORK,
            payer: PAYER,
          }),
        },
      },
    });
    const authorizePayment = vi.fn();
    const fulfil = vi.fn();

    const result = await x402PaywallCore(
      { jobId: JOB_ID, phaseIndex: PHASE_INDEX, request: paidRequest(payload) },
      coreDeps(server, { authorizePayment, fulfil }),
    );
    expect(result).toMatchObject({
      disposition: "settlement-evidence-indeterminate",
      settled: true,
      reason: "invalid-settlement-protocol-response",
    });
    expect(authorizePayment).not.toHaveBeenCalled();
    expect(fulfil).not.toHaveBeenCalled();
  });

  it("snapshots one GET URL and rejects POST before the protocol server", async () => {
    const urls = [
      `https://seller.example/deliver/${JOB_ID}`,
      "https://attacker.example/swapped",
    ];
    const adapter = request();
    const getUrl = vi.fn(() => urls.shift() ?? "https://attacker.example/exhausted");
    const server = mockServer({
      process: { type: "payment-error", response: { status: 402, headers: {} } },
    });
    server.processHTTPRequest.mockImplementation(async (context: X402PaywallHttpContext) => {
      expect(context.adapter.getUrl()).toBe(`https://seller.example/deliver/${JOB_ID}`);
      expect(context.adapter.getUrl()).toBe(`https://seller.example/deliver/${JOB_ID}`);
      return { type: "payment-error", response: { status: 402, headers: {} } };
    });

    await x402PaywallCore(
      {
        jobId: JOB_ID,
        phaseIndex: PHASE_INDEX,
        request: { ...adapter, getUrl },
      },
      coreDeps(server),
    );
    expect(getUrl).toHaveBeenCalledTimes(1);

    const postServer = mockServer({ process: { type: "no-payment-required" } });
    const post = await x402PaywallCore(
      {
        jobId: JOB_ID,
        phaseIndex: PHASE_INDEX,
        request: { ...request(), getMethod: () => "POST" },
      },
      coreDeps(postServer),
    );
    expect(post).toMatchObject({
      disposition: "rejected",
      reason: "pay-x402-requires-get",
      response: { status: 405, headers: { allow: "GET" } },
    });
    expect(postServer.processHTTPRequest).not.toHaveBeenCalled();

    const mismatchedServer = mockServer({ process: { type: "no-payment-required" } });
    const mismatched = await x402PaywallCore(
      {
        jobId: JOB_ID,
        phaseIndex: PHASE_INDEX,
        request: {
          ...request(),
          getUrl: () => "https://seller.example/different-resource",
        },
      },
      coreDeps(mismatchedServer),
    );
    expect(mismatched).toMatchObject({
      disposition: "rejected",
      reason: "invalid-http-resource",
    });
    expect(mismatchedServer.processHTTPRequest).not.toHaveBeenCalled();
  });

  it("recovers an ambiguous settlement after restart without settling or fulfilling twice", async () => {
    const { payload, requirements } = await paymentFixture();
    const settlement = successfulSettlement(requirements);
    const store = settlementStore();
    const settle = vi.fn(async () => {
      throw new Error("facilitator response lost after submission");
    });
    const server = mockServer({
      process: {
        type: "payment-verified",
        paymentPayload: payload,
        paymentRequirements: requirements,
        cancellationDispatcher: { cancel: vi.fn(async () => undefined) },
      },
      settlement: settle,
    });
    const reconcileSettlement = vi.fn()
      .mockResolvedValueOnce({ status: "pending", reason: "chain-index-lag" })
      .mockResolvedValueOnce({ status: "settled", settlement });
    const authorizePayment = vi.fn(async () => ({
      disposition: "authorized" as const,
      authorization: { permitId: "permit-1" },
    }));
    const fulfil = vi.fn(async () => ({
      disposition: "fulfilled" as const,
      body: { delivered: true },
    }));
    const deps = coreDeps(server, {
      settlementStore: store,
      reconcileSettlement,
      authorizePayment,
      fulfil,
    });

    const first = await x402PaywallCore(
      { jobId: JOB_ID, phaseIndex: PHASE_INDEX, request: paidRequest(payload) },
      deps,
    );
    expect(first).toMatchObject({
      disposition: "indeterminate",
      settled: "unknown",
    });
    expect(fulfil).not.toHaveBeenCalled();

    const resumed = await x402PaywallCore(
      { jobId: JOB_ID, phaseIndex: PHASE_INDEX, request: paidRequest(payload) },
      deps,
    );
    expect(resumed).toMatchObject({ disposition: "settled", settled: true });
    expect(settle).toHaveBeenCalledTimes(1);
    expect(server.processHTTPRequest).toHaveBeenCalledTimes(1);
    expect(reconcileSettlement).toHaveBeenCalledTimes(2);
    expect(authorizePayment).toHaveBeenCalledTimes(1);
    expect(fulfil).toHaveBeenCalledTimes(1);
  });

  it("does not let a concurrent retry submit while the original claimant is in flight", async () => {
    const { payload, requirements } = await paymentFixture();
    const settlement = successfulSettlement(requirements);
    let markStarted!: () => void;
    let finishSettlement!: (result: X402PaywallSettlementResult) => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const pendingSettlement = new Promise<X402PaywallSettlementResult>((resolve) => {
      finishSettlement = resolve;
    });
    const settle = vi.fn(async () => {
      markStarted();
      return pendingSettlement;
    });
    const server = mockServer({
      process: {
        type: "payment-verified",
        paymentPayload: payload,
        paymentRequirements: requirements,
        cancellationDispatcher: { cancel: vi.fn(async () => undefined) },
      },
      settlement: settle,
    });
    const reconcileSettlement = vi.fn(async () => ({
      status: "pending" as const,
      reason: "original-claimant-still-live",
    }));
    const fulfil = vi.fn(async () => ({ disposition: "fulfilled" as const }));
    const deps = coreDeps(server, {
      settlementStore: settlementStore(),
      reconcileSettlement,
      fulfil,
    });

    const firstPromise = x402PaywallCore(
      { jobId: JOB_ID, phaseIndex: PHASE_INDEX, request: paidRequest(payload) },
      deps,
    );
    await started;
    const concurrent = await x402PaywallCore(
      { jobId: JOB_ID, phaseIndex: PHASE_INDEX, request: paidRequest(payload) },
      deps,
    );
    expect(concurrent).toMatchObject({
      disposition: "indeterminate",
      settled: "unknown",
      reason: "original-claimant-still-live",
    });
    expect(server.processHTTPRequest).toHaveBeenCalledTimes(1);
    expect(server.processSettlement).toHaveBeenCalledTimes(1);
    expect(reconcileSettlement).toHaveBeenCalledTimes(1);
    expect(fulfil).not.toHaveBeenCalled();

    finishSettlement(settlement);
    await expect(firstPromise).resolves.toMatchObject({
      disposition: "settled",
      settled: true,
    });
    expect(server.processSettlement).toHaveBeenCalledTimes(1);
    expect(fulfil).toHaveBeenCalledTimes(1);
  });

  it("fails closed through claim response loss and reconciles before any submit", async () => {
    const { payload, requirements } = await paymentFixture();
    const backing = settlementStore();
    let loseClaimResponse = true;
    const claim = vi.fn(async (intent: Readonly<X402PaywallSettlementIntent>) => {
      const result = await backing.claim(intent);
      if (loseClaimResponse) {
        loseClaimResponse = false;
        throw new Error("intent committed before response loss");
      }
      return result;
    });
    const store: X402PaywallSettlementStore = {
      load: (key) => backing.load(key),
      claim,
      recordOutcome: (input) => backing.recordOutcome(input),
    };
    const server = mockServer({
      process: {
        type: "payment-verified",
        paymentPayload: payload,
        paymentRequirements: requirements,
        cancellationDispatcher: { cancel: vi.fn(async () => undefined) },
      },
      settlement: successfulSettlement(requirements),
    });
    const reconcileSettlement = vi.fn(async () => ({
      status: "failed" as const,
      reason: "authoritative-no-transfer",
    }));
    const fulfil = vi.fn();
    const deps = coreDeps(server, {
      settlementStore: store,
      reconcileSettlement,
      fulfil,
    });

    const first = await x402PaywallCore(
      { jobId: JOB_ID, phaseIndex: PHASE_INDEX, request: paidRequest(payload) },
      deps,
    );
    expect(first).toMatchObject({ disposition: "indeterminate", settled: "unknown" });
    const resumed = await x402PaywallCore(
      { jobId: JOB_ID, phaseIndex: PHASE_INDEX, request: paidRequest(payload) },
      deps,
    );
    expect(resumed).toMatchObject({
      disposition: "settlement-failed",
      settled: false,
      reason: "authoritative-no-transfer",
    });
    expect(server.processHTTPRequest).toHaveBeenCalledTimes(1);
    expect(server.processSettlement).not.toHaveBeenCalled();
    expect(claim).toHaveBeenCalledTimes(1);
    expect(reconcileSettlement).toHaveBeenCalledTimes(1);
    expect(fulfil).not.toHaveBeenCalled();
  });

  it("replays a committed settlement after outcome-store response loss", async () => {
    const { payload, requirements } = await paymentFixture();
    const settlement = successfulSettlement(requirements);
    const backing = settlementStore();
    let loseResponse = true;
    const claim = vi.fn((intent: Readonly<X402PaywallSettlementIntent>) =>
      backing.claim(intent));
    const store: X402PaywallSettlementStore = {
      load: (key) => backing.load(key),
      claim,
      async recordOutcome(input) {
        const result = await backing.recordOutcome(input);
        if (loseResponse) {
          loseResponse = false;
          throw new Error("durable commit acknowledged late");
        }
        return result;
      },
    };
    const server = mockServer({
      process: {
        type: "payment-verified",
        paymentPayload: payload,
        paymentRequirements: requirements,
        cancellationDispatcher: { cancel: vi.fn(async () => undefined) },
      },
      settlement,
    });
    const fulfil = vi.fn(async () => ({ disposition: "fulfilled" as const }));
    const deps = coreDeps(server, { settlementStore: store, fulfil });

    const first = await x402PaywallCore(
      { jobId: JOB_ID, phaseIndex: PHASE_INDEX, request: paidRequest(payload) },
      deps,
    );
    expect(first).toMatchObject({
      disposition: "settlement-state-indeterminate",
      settled: true,
    });
    expect(first.response.headers["PAYMENT-RESPONSE"]).toBe(
      settlement.headers["PAYMENT-RESPONSE"],
    );
    const resumed = await x402PaywallCore(
      { jobId: JOB_ID, phaseIndex: PHASE_INDEX, request: paidRequest(payload) },
      deps,
    );
    expect(resumed).toMatchObject({ disposition: "settled", settled: true });
    expect(server.processSettlement).toHaveBeenCalledTimes(1);
    expect(server.processHTTPRequest).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(fulfil).toHaveBeenCalledTimes(1);
    expect(backing.retained.get(x402PaywallSettlementKey({
      jobId: JOB_ID,
      phaseIndex: PHASE_INDEX,
    }))?.outcome?.status).toBe("settled");
  });
});

describe("createX402Paywall", () => {
  const facilitator = {
    verify: vi.fn(async () => ({ isValid: true, payer: PAYER })),
    settle: vi.fn(async () => ({
      success: true,
      transaction: TX_HASH,
      network: NETWORK,
      payer: PAYER,
      amount: AMOUNT,
    })),
    getSupported: vi.fn(async () => ({
      kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }],
      extensions: [],
      signers: {},
    })),
  };
  const factoryHandlers = <T,>(fulfil: X402PaywallCoreDeps<{ permitId: string }, T>["fulfil"]) => ({
    settlementStore: settlementStore(),
    authorizeSettlement: async () => ({
      disposition: "authorized" as const,
      authorization: { scopeVersion: "test-1", jobId: JOB_ID },
    }),
    reconcileSettlement: async () => ({ status: "pending" as const, reason: "pending" }),
    authorizePayment: async () => ({
      disposition: "authorized" as const,
      authorization: { permitId: "permit-1" },
    }),
    fulfil,
  });

  it("rejects non-CAIP networks and missing EIP-712 domains before loading peers", async () => {
    await expect(createX402Paywall({
      route: "GET /delivery",
      network: "base-sepolia" as `eip155:${string}`,
      payTo: PAY_TO,
      amount: AMOUNT,
      asset: ASSET,
      eip712: { name: "USDC", version: "2" },
      facilitator,
    }, factoryHandlers(async () => ({ disposition: "fulfilled" })))).rejects.toThrow("CAIP-2");

    await expect(createX402Paywall({
      route: "GET /delivery",
      network: NETWORK,
      payTo: PAY_TO,
      amount: AMOUNT,
      asset: ASSET,
      eip712: { name: "", version: "" },
      facilitator,
    }, factoryHandlers(async () => ({ disposition: "fulfilled" })))).rejects.toThrow("EIP-712");
  });

  it("snapshots factory configuration before optional-peer initialization", async () => {
    const config = {
      route: `GET /deliver/${JOB_ID}`,
      network: NETWORK,
      payTo: PAY_TO,
      amount: AMOUNT,
      asset: ASSET,
      eip712: { name: "USDC", version: "2" },
      facilitator,
      mimeType: "application/json",
    } satisfies X402PaywallConfig;
    const creating = createX402Paywall(
      config,
      factoryHandlers(async () => ({ disposition: "fulfilled" })),
    );
    config.route = "GET /mutated-after-call";
    config.payTo = `0x${"99".repeat(20)}`;
    config.eip712.name = "MUTATED";

    const paywall = await creating;
    expect(paywall.terms).toEqual(expected);
    const unpaid = await paywall.handle({
      jobId: JOB_ID,
      phaseIndex: PHASE_INDEX,
      request: request(),
    });
    expect(unpaid).toMatchObject({ disposition: "payment-required", settled: false });
  });

  it("runs the public factory through an actual x402 402 → paid response", async () => {
    const fulfil = vi.fn(async () => ({
      disposition: "fulfilled" as const,
      body: { delivered: true },
    }));
    const paywall = await createX402Paywall({
      route: `GET /deliver/${JOB_ID}`,
      network: NETWORK,
      payTo: PAY_TO,
      amount: AMOUNT,
      asset: ASSET,
      eip712: { name: "USDC", version: "2" },
      facilitator,
      mimeType: "application/json",
    }, factoryHandlers(fulfil));

    expect(paywall.terms).toEqual(expected);
    expect(typeof paywall.handle).toBe("function");
    expect(facilitator.getSupported).toHaveBeenCalled();

    const unpaid = await paywall.handle({
      jobId: JOB_ID,
      phaseIndex: PHASE_INDEX,
      request: request(),
    });
    expect(unpaid).toMatchObject({ disposition: "payment-required", settled: false });
    const requiredHeader = Object.entries(unpaid.response.headers).find(
      ([name]) => name.toUpperCase() === "PAYMENT-REQUIRED",
    )?.[1];
    expect(requiredHeader).toBeTruthy();
    const paymentRequired = JSON.parse(
      Buffer.from(requiredHeader!, "base64").toString("utf8"),
    ) as {
      x402Version: number;
      resource: Record<string, unknown>;
      accepts: X402PaywallPaymentRequirements[];
    };
    const accepted = paymentRequired.accepts[0]!;
    expect(accepted.extra).toMatchObject({ name: "USDC", version: "2" });
    const nonce = x402Eip3009Nonce(JOB_ID, PHASE_INDEX);
    const paymentPayload = {
      x402Version: paymentRequired.x402Version,
      resource: paymentRequired.resource,
      accepted,
      payload: {
        authorization: {
          from: PAYER,
          to: PAY_TO,
          value: AMOUNT,
          validAfter: "0",
          validBefore: "9999999999",
          nonce,
        },
        signature: `0x${"44".repeat(65)}`,
      },
    };
    const paid = await paywall.handle({
      jobId: JOB_ID,
      phaseIndex: PHASE_INDEX,
      request: request({
        "PAYMENT-SIGNATURE": Buffer.from(
          JSON.stringify(paymentPayload),
          "utf8",
        ).toString("base64"),
      }),
    });

    expect(paid).toMatchObject({
      disposition: "settled",
      settled: true,
      response: { body: { delivered: true } },
      paymentClaim: { kind: "pay-x402", chainId: 84532 },
    });
    expect(fulfil).toHaveBeenCalledTimes(1);
  });
});
