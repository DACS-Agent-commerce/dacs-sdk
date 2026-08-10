import { describe, expect, it, vi } from "vitest";

import { canonicalize, sha256Hex } from "../../src/canonical/index.js";
import {
  createX402Paywall,
  x402Eip3009Nonce,
  x402PaywallCore,
  x402PaywallFulfilmentKey,
  type X402PaywallHttpAdapter,
  type X402PaywallPaymentPayload,
  type X402PaywallPaymentRequirements,
  type X402PaywallProcessResult,
  type X402PaywallServerLike,
  type X402PaywallSettlementResult,
} from "../../src/index.js";

const NETWORK = "eip155:84532" as const;
const PAYER = `0x${"11".repeat(20)}`;
const PAY_TO = `0x${"22".repeat(20)}`;
const ASSET = `0x${"33".repeat(20)}`;
const TX_HASH = `0x${"ab".repeat(32)}`;
const JOB_ID = "seller-paywall-job";
const PHASE_INDEX = 2;
const AMOUNT = "250000";

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

describe("x402PaywallCore — DACS-4 §9.5.7/§9.5.8", () => {
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
      { server, expected, fulfil },
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
      { server, expected, fulfil },
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
      { jobId: JOB_ID, phaseIndex: PHASE_INDEX, request: request() },
      { server, expected, fulfil },
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

  it("cancels verification and does not settle when fulfilment throws", async () => {
    const { payload, requirements } = await paymentFixture();
    const cancel = vi.fn(async () => undefined);
    const server = mockServer({
      process: {
        type: "payment-verified",
        paymentPayload: payload,
        paymentRequirements: requirements,
        cancellationDispatcher: { cancel },
      },
    });
    const fulfil = vi.fn(async () => {
      throw new Error("application failure");
    });

    const result = await x402PaywallCore(
      { jobId: JOB_ID, phaseIndex: PHASE_INDEX, request: request() },
      { server, expected, fulfil },
    );

    expect(result).toMatchObject({
      disposition: "fulfilment-failed",
      response: { status: 500, body: { error: "fulfilment-failed" } },
    });
    expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ reason: "handler_threw" }));
    expect(server.processSettlement).not.toHaveBeenCalled();
  });

  it("withholds the prepared deliverable when settlement fails", async () => {
    const { payload, requirements } = await paymentFixture();
    const server = mockServer({
      process: {
        type: "payment-verified",
        paymentPayload: payload,
        paymentRequirements: requirements,
        cancellationDispatcher: { cancel: vi.fn(async () => undefined) },
      },
      settlement: {
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
      },
    });

    const result = await x402PaywallCore(
      { jobId: JOB_ID, phaseIndex: PHASE_INDEX, request: request() },
      {
        server,
        expected,
        fulfil: async () => ({ body: { secret: "deliverable" } }),
      },
    );

    expect(result).toMatchObject({
      disposition: "settlement-failed",
      settled: false,
      response: { status: 402, body: { error: "settlement-failed" } },
    });
    expect(result.response.body).not.toEqual({ secret: "deliverable" });
  });

  it("runs verify → fulfil → settle and emits an exact seller payment claim", async () => {
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
      { jobId: JOB_ID, phaseIndex: PHASE_INDEX, request: request() },
      {
        server,
        expected,
        fulfil: async (context) => {
          order.push("fulfil");
          expect(context.idempotencyKey).toBe(x402PaywallFulfilmentKey({
            jobId: JOB_ID,
            phaseIndex: PHASE_INDEX,
          }));
          return {
            status: 201,
            headers: {
              "x-delivery": "ready",
              "payment-response": "application-must-not-override-protocol",
            },
            body: { deliverable: "released-only-after-settlement" },
          };
        },
      },
    );

    expect(order).toEqual(["verify", "fulfil", "settle"]);
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
    if (!result.settled) throw new Error("expected settled result");
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
    const result = await x402PaywallCore(
      { jobId: JOB_ID, phaseIndex: PHASE_INDEX, request: request() },
      { server, expected, fulfil: async () => ({ body: "secret" }) },
    );
    expect(result).toMatchObject({
      disposition: "indeterminate",
      settled: false,
      reason: "settled-receipt-is-not-dacs-verifiable",
      response: { status: 503 },
      settlement: { success: true, transaction: TX_HASH },
    });
    expect(result.response.body).not.toBe("secret");
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

  it("rejects non-CAIP networks and missing EIP-712 domains before loading peers", async () => {
    await expect(createX402Paywall({
      route: "GET /delivery",
      network: "base-sepolia" as `eip155:${string}`,
      payTo: PAY_TO,
      amount: AMOUNT,
      asset: ASSET,
      eip712: { name: "USDC", version: "2" },
      facilitator,
    }, async () => ({}))).rejects.toThrow("CAIP-2");

    await expect(createX402Paywall({
      route: "GET /delivery",
      network: NETWORK,
      payTo: PAY_TO,
      amount: AMOUNT,
      asset: ASSET,
      eip712: { name: "", version: "" },
      facilitator,
    }, async () => ({}))).rejects.toThrow("EIP-712");
  });

  it("runs the public factory through an actual x402 402 → paid response", async () => {
    const fulfil = vi.fn(async () => ({ body: { delivered: true } }));
    const paywall = await createX402Paywall({
      route: `GET /deliver/${JOB_ID}`,
      network: NETWORK,
      payTo: PAY_TO,
      amount: AMOUNT,
      asset: ASSET,
      eip712: { name: "USDC", version: "2" },
      facilitator,
      mimeType: "application/json",
    }, fulfil);

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
