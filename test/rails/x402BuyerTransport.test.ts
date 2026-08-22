import { describe, expect, test } from "vitest";

import { sha256Hex } from "../../src/canonical/index.js";
import {
  createX402BuyerPaidRequestTransport,
  createX402BuyerRetainedDisclosureRecovery,
  prepareX402BuyerSettlement,
  type PrepareX402BuyerSettlementInput,
  type X402BuyerChallengeClient,
  type X402BuyerEffectFence,
} from "../../src/rails/index.js";

const JOB_ID = "job-durable-buyer-http";
const PHASE_INDEX = 2;
const NETWORK = "eip155:84532" as const;
const PAYER = `0x${"11".repeat(20)}`;
const PAYEE = `0x${"22".repeat(20)}`;
const ASSET = `0x${"33".repeat(20)}`;
const RESOURCE = "https://seller.example/deliver/job-durable-buyer-http";
const NONCE = `0x${sha256Hex(`dacs-sb3:v1:${JOB_ID}:${PHASE_INDEX}`)}`;

function authority(): PrepareX402BuyerSettlementInput["authority"] {
  return {
    jobId: JOB_ID,
    phaseIndex: PHASE_INDEX,
    railId: "x402:base-sepolia",
    railVersion: "2",
    railDescriptorHash: "a".repeat(64),
    agreementHash: "b".repeat(64),
    termsHash: "c".repeat(64),
    sessionBindingHash: "d".repeat(64),
    network: NETWORK,
    payer: PAYER,
    payee: PAYEE,
    asset: ASSET,
    amount: "1000",
    httpResource: RESOURCE,
    method: "GET",
  };
}

function requirements(overrides: Record<string, unknown> = {}) {
  return {
    scheme: "exact",
    network: NETWORK,
    asset: ASSET,
    amount: "1000",
    payTo: PAYEE,
    maxTimeoutSeconds: 120,
    extra: { name: "USD Coin", version: "2", retained: { future: true } },
    ...overrides,
  };
}

function client(counters = { signs: 0 }): X402BuyerChallengeClient {
  return {
    getPaymentRequiredResponse: (_getHeader, body) => body,
    async createPaymentPayload(value) {
      counters.signs += 1;
      const selected = (value as { accepts: unknown[] }).accepts[0];
      return {
        x402Version: 2,
        resource: { url: RESOURCE },
        accepted: selected,
        payload: {
          authorization: {
            from: PAYER,
            to: PAYEE,
            value: "1000",
            validAfter: "0",
            validBefore: "4102444800",
            nonce: NONCE,
          },
          signature: `0x${"44".repeat(65)}`,
        },
      };
    },
    encodePaymentSignatureHeader(payload) {
      return {
        "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
      };
    },
  };
}

async function preparedIntent() {
  const challenge = {
    x402Version: 2,
    resource: { url: RESOURCE },
    accepts: [requirements()],
  };
  const result = await prepareX402BuyerSettlement(
    { authority: authority() },
    {
      client: client(),
      fetchImpl: async () => new Response(JSON.stringify(challenge), { status: 402 }),
    },
  );
  if (result.disposition !== "prepared") throw new Error(result.reason);
  return result.intent;
}

describe("prepareX402BuyerSettlement", () => {
  test("selects exact terms and returns a fully retained intent before any paid request", async () => {
    let requests = 0;
    const counters = { signs: 0 };
    const result = await prepareX402BuyerSettlement(
      { authority: authority(), challengeHeaders: { accept: "application/json" } },
      {
        client: client(counters),
        fetchImpl: async (url, init) => {
          requests += 1;
          expect(url).toBe(RESOURCE);
          expect(init?.method).toBe("GET");
          expect(init?.redirect).toBe("error");
          expect(new Headers(init?.headers).has("PAYMENT-SIGNATURE")).toBe(false);
          return new Response(JSON.stringify({
            x402Version: 2,
            resource: { url: RESOURCE },
            accepts: [requirements({ amount: "999" }), requirements()],
          }), { status: 402 });
        },
      },
    );

    expect(result.disposition).toBe("prepared");
    if (result.disposition !== "prepared") return;
    expect(requests).toBe(1);
    expect(counters.signs).toBe(1);
    expect(result.intent.authorizationNonce).toBe(NONCE);
    expect(result.intent.chosenRequirements.amount).toBe("1000");
    expect(result.intent.signedPaymentPayload.accepted).toEqual(requirements());
    expect(Object.isFrozen(result.intent)).toBe(true);
  });

  test("rejects substituted challenge terms before invoking the signer", async () => {
    const counters = { signs: 0 };
    const challenges = [
      {
        x402Version: 2,
        resource: { url: RESOURCE },
        accepts: [requirements({ payTo: `0x${"99".repeat(20)}` })],
      },
      {
        x402Version: 2,
        resource: { url: "https://seller.example/deliver/substituted" },
        accepts: [requirements()],
      },
      {
        x402Version: 2,
        resource: { url: RESOURCE },
        accepts: [requirements({ extra: { name: "USD Coin" } })],
      },
    ];
    for (const challenge of challenges) {
      const result = await prepareX402BuyerSettlement(
        { authority: authority() },
        {
          client: client(counters),
          fetchImpl: async () => new Response(JSON.stringify(challenge), { status: 402 }),
        },
      );
      expect(result).toEqual({
        disposition: "rejected",
        reason: "x402-payment-requirements-mismatch",
      });
    }
    expect(counters.signs).toBe(0);
  });

  test("classifies transport loss as indeterminate and refuses preloaded bearers", async () => {
    await expect(prepareX402BuyerSettlement(
      { authority: authority() },
      { client: client(), fetchImpl: async () => { throw new Error("lost"); } },
    )).resolves.toEqual({
      disposition: "indeterminate",
      reason: "x402-challenge-unavailable",
    });
    await expect(prepareX402BuyerSettlement(
      {
        authority: authority(),
        challengeHeaders: { "PAYMENT-SIGNATURE": "caller-bearer" },
      },
      { client: client() },
    )).resolves.toEqual({
      disposition: "rejected",
      reason: "x402-challenge-headers-invalid",
    });
  });

  test("rejects accessor and proxy authority before reading it or invoking the signer", async () => {
    const counters = { signs: 0 };
    const malformed = authority() as unknown as Record<string, unknown>;
    let reads = 0;
    Object.defineProperty(malformed, "agreementHash", {
      enumerable: true,
      get() {
        reads += 1;
        return "b".repeat(64);
      },
    });
    await expect(prepareX402BuyerSettlement(
      { authority: malformed as never },
      { client: client(counters) },
    )).resolves.toEqual({
      disposition: "rejected",
      reason: "x402-settlement-authority-invalid",
    });
    await expect(prepareX402BuyerSettlement(
      { authority: new Proxy(authority(), {}) },
      { client: client(counters) },
    )).resolves.toEqual({
      disposition: "rejected",
      reason: "x402-settlement-authority-invalid",
    });
    expect(reads).toBe(0);
    expect(counters.signs).toBe(0);
  });
});

describe("createX402BuyerPaidRequestTransport", () => {
  test("asserts the generation immediately before sending only the retained bearer", async () => {
    const intent = await preparedIntent();
    const baseHeaders = new Headers({ accept: "application/json", "x-client": "captured" });
    let asserted = false;
    let requests = 0;
    const transport = createX402BuyerPaidRequestTransport({
      headers: baseHeaders,
      fetchImpl: async (url, init) => {
        requests += 1;
        expect(asserted).toBe(true);
        expect(url).toBe(RESOURCE);
        expect(init?.method).toBe("GET");
        expect(init?.redirect).toBe("error");
        const sent = new Headers(init?.headers);
        expect(sent.get("PAYMENT-SIGNATURE")).toBe(intent.paymentHeader.value);
        expect(sent.get("x-client")).toBe("captured");
        return new Response(null, {
          status: 200,
          headers: { "PAYMENT-RESPONSE": "retained-settlement-header" },
        });
      },
    });
    baseHeaders.set("x-client", "mutated");
    const fence: X402BuyerEffectFence = {
      owner: "buyer-worker",
      generation: 3,
      settlementKey: intent.settlementKey,
      bindingHash: intent.bindingHash,
      idempotencyKey: intent.settlementKey,
      async assertCurrent() {
        asserted = true;
      },
    };
    await expect(transport.submitRetained(intent, fence)).resolves.toEqual({
      disposition: "response",
      disclosure: {
        protocolVersion: "2",
        headerName: "PAYMENT-RESPONSE",
        encodedSettlementHeader: "retained-settlement-header",
        httpResource: RESOURCE,
      },
    });
    expect(requests).toBe(1);
  });

  test("keeps missing responses and request loss non-successful for chain reconciliation", async () => {
    const intent = await preparedIntent();
    const fence: X402BuyerEffectFence = {
      owner: "buyer-worker",
      generation: 1,
      settlementKey: intent.settlementKey,
      bindingHash: intent.bindingHash,
      idempotencyKey: intent.settlementKey,
      assertCurrent: async () => undefined,
    };
    const noHeader = createX402BuyerPaidRequestTransport({
      fetchImpl: async () => new Response(null, { status: 200 }),
    });
    await expect(noHeader.submitRetained(intent, fence)).resolves.toEqual({
      disposition: "response",
    });
    const lost = createX402BuyerPaidRequestTransport({
      fetchImpl: async () => { throw new Error("response lost"); },
    });
    await expect(lost.submitRetained(intent, fence)).resolves.toEqual({
      disposition: "indeterminate",
      reason: "x402-paid-request-response-indeterminate",
    });
  });

  test("rejects caller-supplied payment headers at construction", () => {
    expect(() => createX402BuyerPaidRequestTransport({
      headers: { "X-PAYMENT": "legacy-bearer" },
    })).toThrow(/cannot contain payment authorization/);
  });
});

describe("createX402BuyerRetainedDisclosureRecovery", () => {
  test("replays the exact retained bearer and returns only the settlement disclosure", async () => {
    const intent = await preparedIntent();
    let assertions = 0;
    let requests = 0;
    const fence: X402BuyerEffectFence = {
      owner: "buyer-worker",
      generation: 4,
      settlementKey: intent.settlementKey,
      bindingHash: intent.bindingHash,
      idempotencyKey: intent.settlementKey,
      async assertCurrent() { assertions += 1; },
    };
    const recover = createX402BuyerRetainedDisclosureRecovery({
      fetchImpl: async (url, init) => {
        requests += 1;
        expect(url).toBe(RESOURCE);
        expect(init?.method).toBe("GET");
        expect(init?.redirect).toBe("error");
        expect(new Headers(init?.headers).get("PAYMENT-SIGNATURE"))
          .toBe(intent.paymentHeader.value);
        return new Response("ignored-deliverable", {
          status: 200,
          headers: { "PAYMENT-RESPONSE": "recovered-settlement-header" },
        });
      },
    });

    await expect(recover({
      intent,
      transactionHash: `0x${"ab".repeat(32)}`,
      fence,
    })).resolves.toEqual({
      protocolVersion: "2",
      headerName: "PAYMENT-RESPONSE",
      encodedSettlementHeader: "recovered-settlement-header",
      httpResource: RESOURCE,
    });
    expect(requests).toBe(1);
    expect(assertions).toBe(1);
  });

  test("keeps lost or headerless recovery responses unavailable", async () => {
    const intent = await preparedIntent();
    const fence: X402BuyerEffectFence = {
      owner: "buyer-worker",
      generation: 4,
      settlementKey: intent.settlementKey,
      bindingHash: intent.bindingHash,
      idempotencyKey: intent.settlementKey,
      assertCurrent: async () => undefined,
    };
    const headerless = createX402BuyerRetainedDisclosureRecovery({
      fetchImpl: async () => new Response(null, { status: 200 }),
    });
    await expect(headerless({
      intent,
      transactionHash: `0x${"ab".repeat(32)}`,
      fence,
    })).resolves.toBeUndefined();
    const lost = createX402BuyerRetainedDisclosureRecovery({
      fetchImpl: async () => { throw new Error("response lost"); },
    });
    await expect(lost({
      intent,
      transactionHash: `0x${"ab".repeat(32)}`,
      fence,
    })).resolves.toBeUndefined();
  });
});
