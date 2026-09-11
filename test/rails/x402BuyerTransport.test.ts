import { describe, expect, test, vi } from "vitest";

import { sha256Hex } from "../../src/canonical/index.js";
import {
  createX402BuyerPaidRequestTransport,
  createX402BuyerRetainedDisclosureRecovery,
  prepareX402BuyerSettlement,
  type DacsPublicHttpsRequestV1,
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
      transportPolicy: { mode: "insecure-test" },
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
        transportPolicy: { mode: "insecure-test" },
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
          transportPolicy: { mode: "insecure-test" },
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
      {
        client: client(),
        transportPolicy: { mode: "insecure-test" },
        fetchImpl: async () => { throw new Error("lost"); },
      },
    )).resolves.toEqual({
      disposition: "indeterminate",
      reason: "x402-challenge-unavailable",
    });
    await expect(prepareX402BuyerSettlement(
      {
        authority: authority(),
        challengeHeaders: { "PAYMENT-SIGNATURE": "caller-bearer" },
      },
      { client: client(), fetchImpl: async () => { throw new Error("must not fetch"); } },
    )).resolves.toEqual({
      disposition: "rejected",
      reason: "x402-challenge-headers-invalid",
    });
    await expect(prepareX402BuyerSettlement(
      {
        authority: authority(),
        challengeHeaders: { "X-API-Key": "internal-secret" },
      },
      { client: client(), fetchImpl: async () => { throw new Error("must not fetch"); } },
    )).resolves.toEqual({
      disposition: "rejected",
      reason: "x402-challenge-headers-invalid",
    });
  });

  test("does not accept a custom fetch as an accidental production transport", async () => {
    const fetchImpl = vi.fn(async () => new Response("must not run"));
    await expect(prepareX402BuyerSettlement(
      { authority: authority() },
      { client: client(), fetchImpl: fetchImpl as typeof fetch },
    )).resolves.toEqual({
      disposition: "rejected",
      reason: "x402-challenge-dependencies-invalid",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("default transport rejects private and mixed DNS before signing", async () => {
    const counters = { signs: 0 };
    const request = vi.fn(async () => new Response("must not connect"));
    await expect(prepareX402BuyerSettlement(
      { authority: authority() },
      {
        client: client(counters),
        publicHttpsDependencies: {
          resolveHost: async () => ["8.8.8.8", "127.0.0.1"],
          request,
        },
      },
    )).resolves.toEqual({
      disposition: "rejected",
      reason: "x402-challenge-resource-unsafe",
    });
    expect(counters.signs).toBe(0);
    expect(request).not.toHaveBeenCalled();
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
      { client: client(counters), fetchImpl: async () => { throw new Error("must not fetch"); } },
    )).resolves.toEqual({
      disposition: "rejected",
      reason: "x402-settlement-authority-invalid",
    });
    await expect(prepareX402BuyerSettlement(
      { authority: new Proxy(authority(), {}) },
      { client: client(counters), fetchImpl: async () => { throw new Error("must not fetch"); } },
    )).resolves.toEqual({
      disposition: "rejected",
      reason: "x402-settlement-authority-invalid",
    });
    expect(reads).toBe(0);
    expect(counters.signs).toBe(0);
  });

  test("binds every challenge-client method before the first network await", async () => {
    let releaseResponse!: (response: Response) => void;
    const responseGate = new Promise<Response>((resolve) => {
      releaseResponse = resolve;
    });
    const original = client();
    const substituted = vi.fn(() => {
      throw new Error("substituted method must not run");
    });
    const pending = prepareX402BuyerSettlement(
      { authority: authority() },
      {
        client: original,
        transportPolicy: { mode: "insecure-test" },
        fetchImpl: async () => responseGate,
      },
    );
    original.getPaymentRequiredResponse = substituted;
    original.createPaymentPayload = substituted as never;
    original.encodePaymentSignatureHeader = substituted;
    releaseResponse(new Response(JSON.stringify({
      x402Version: 2,
      resource: { url: RESOURCE },
      accepts: [requirements()],
    }), { status: 402 }));
    await expect(pending).resolves.toMatchObject({ disposition: "prepared" });
    expect(substituted).not.toHaveBeenCalled();
  });

  test("rejects accessor-backed client methods and returned payment headers without reading them", async () => {
    let methodReads = 0;
    const accessorClient = client() as unknown as Record<string, unknown>;
    Object.defineProperty(accessorClient, "encodePaymentSignatureHeader", {
      enumerable: true,
      get() {
        methodReads += 1;
        return () => ({ "PAYMENT-SIGNATURE": "substituted" });
      },
    });
    const fetchImpl = vi.fn(async () => new Response("must not fetch"));
    await expect(prepareX402BuyerSettlement(
      { authority: authority() },
      {
        client: accessorClient as unknown as X402BuyerChallengeClient,
        transportPolicy: { mode: "insecure-test" },
        fetchImpl: fetchImpl as typeof fetch,
      },
    )).resolves.toEqual({
      disposition: "rejected",
      reason: "x402-challenge-dependencies-invalid",
    });
    expect(methodReads).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();

    let headerReads = 0;
    const unsafeHeaderClient = client();
    unsafeHeaderClient.encodePaymentSignatureHeader = () => {
      const headers = {} as Record<string, string>;
      Object.defineProperty(headers, "PAYMENT-SIGNATURE", {
        enumerable: true,
        get() {
          headerReads += 1;
          return "substituted";
        },
      });
      return headers;
    };
    await expect(prepareX402BuyerSettlement(
      { authority: authority() },
      {
        client: unsafeHeaderClient,
        transportPolicy: { mode: "insecure-test" },
        fetchImpl: async () => new Response(JSON.stringify({
          x402Version: 2,
          resource: { url: RESOURCE },
          accepts: [requirements()],
        }), { status: 402 }),
      },
    )).resolves.toEqual({
      disposition: "rejected",
      reason: "x402-payment-signature-invalid",
    });
    expect(headerReads).toBe(0);
  });
});

describe("createX402BuyerPaidRequestTransport", () => {
  test("asserts the generation immediately before sending only the retained bearer", async () => {
    const intent = await preparedIntent();
    const baseHeaders = new Headers({ accept: "application/original+json" });
    let asserted = false;
    let requests = 0;
    const transport = createX402BuyerPaidRequestTransport({
      headers: baseHeaders,
      transportPolicy: { mode: "insecure-test" },
      fetchImpl: async (url, init) => {
        requests += 1;
        expect(asserted).toBe(true);
        expect(url).toBe(RESOURCE);
        expect(init?.method).toBe("GET");
        expect(init?.redirect).toBe("error");
        const sent = new Headers(init?.headers);
        expect(sent.get("PAYMENT-SIGNATURE")).toBe(intent.paymentHeader.value);
        expect(sent.get("accept")).toBe("application/original+json");
        return new Response(null, {
          status: 200,
          headers: { "PAYMENT-RESPONSE": "retained-settlement-header" },
        });
      },
    });
    baseHeaders.set("accept", "application/mutated+json");
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
      transportPolicy: { mode: "insecure-test" },
      fetchImpl: async () => new Response(null, { status: 200 }),
    });
    await expect(noHeader.submitRetained(intent, fence)).resolves.toEqual({
      disposition: "response",
    });
    const lost = createX402BuyerPaidRequestTransport({
      transportPolicy: { mode: "insecure-test" },
      fetchImpl: async () => { throw new Error("response lost"); },
    });
    await expect(lost.submitRetained(intent, fence)).resolves.toEqual({
      disposition: "indeterminate",
      reason: "x402-paid-request-response-indeterminate",
    });
  });

  test("resolves and validates DNS before fencing the exact socket-open boundary", async () => {
    const intent = await preparedIntent();
    const events: string[] = [];
    const transport = createX402BuyerPaidRequestTransport({
      publicHttpsDependencies: {
        resolveHost: async () => {
          events.push("dns");
          return ["8.8.8.8"];
        },
        request: async (input) => {
          events.push("request-entered");
          await input.beforeConnect?.();
          events.push("socket-opened");
          return new Response(null, {
            status: 200,
            headers: { "PAYMENT-RESPONSE": "settled" },
          });
        },
      },
    });
    const fence: X402BuyerEffectFence = {
      owner: "buyer-worker",
      generation: 4,
      settlementKey: intent.settlementKey,
      bindingHash: intent.bindingHash,
      idempotencyKey: intent.settlementKey,
      async assertCurrent() {
        events.push("fence");
      },
    };
    await expect(transport.submitRetained(intent, fence)).resolves.toMatchObject({
      disposition: "response",
    });
    expect(events).toEqual(["dns", "request-entered", "fence", "socket-opened"]);
  });

  test("never fences or sends a retained bearer to a private DNS answer", async () => {
    const intent = await preparedIntent();
    const fence = vi.fn(async () => undefined);
    const request = vi.fn(async () => new Response(null, { status: 200 }));
    const transport = createX402BuyerPaidRequestTransport({
      publicHttpsDependencies: {
        resolveHost: async () => ["169.254.169.254"],
        request,
      },
    });
    await expect(transport.submitRetained(intent, {
      owner: "buyer-worker",
      generation: 1,
      settlementKey: intent.settlementKey,
      bindingHash: intent.bindingHash,
      idempotencyKey: intent.settlementKey,
      assertCurrent: fence,
    })).resolves.toEqual({
      disposition: "indeterminate",
      reason: "x402-paid-request-response-indeterminate",
    });
    expect(fence).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  test("rejects caller-supplied payment headers at construction", () => {
    expect(() => createX402BuyerPaidRequestTransport({
      headers: { "X-PAYMENT": "legacy-bearer" },
    })).toThrow(/stable Accept header/);
  });

  test("requires explicit insecure-test authority for a paid fetch override", () => {
    expect(() => createX402BuyerPaidRequestTransport({
      fetchImpl: async () => new Response(null, { status: 200 }),
    })).toThrow(/explicit insecure-test mode/);
  });

  test("captures the exact durable intent and fence before DNS can yield", async () => {
    const sourceIntent = structuredClone(await preparedIntent());
    const originalResource = sourceIntent.httpResource;
    const originalHeader = sourceIntent.paymentHeader.value;
    let releaseDns!: () => void;
    let dnsEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      dnsEntered = resolve;
    });
    const dnsGate = new Promise<void>((resolve) => {
      releaseDns = resolve;
    });
    const originalFence = vi.fn(async () => undefined);
    const substitutedFence = vi.fn(async () => {
      throw new Error("substituted fence must not run");
    });
    const request = vi.fn(async (input: Readonly<DacsPublicHttpsRequestV1>) => {
      expect(input.url).toBe(originalResource);
      expect(input.headers.get("PAYMENT-SIGNATURE")).toBe(originalHeader);
      await input.beforeConnect?.();
      return new Response(null, {
        status: 200,
        headers: { "PAYMENT-RESPONSE": "settled" },
      });
    });
    const transport = createX402BuyerPaidRequestTransport({
      publicHttpsDependencies: {
        resolveHost: async () => {
          dnsEntered();
          await dnsGate;
          return ["8.8.8.8"];
        },
        request,
      },
    });
    const fence: X402BuyerEffectFence = {
      owner: "buyer-worker",
      generation: 4,
      settlementKey: sourceIntent.settlementKey,
      bindingHash: sourceIntent.bindingHash,
      idempotencyKey: sourceIntent.settlementKey,
      assertCurrent: originalFence,
    };
    const pending = transport.submitRetained(sourceIntent, fence);
    await entered;
    (sourceIntent as { httpResource: string }).httpResource =
      "https://attacker.example/substituted";
    (sourceIntent.paymentHeader as { value: string }).value = "substituted";
    (fence as { assertCurrent: X402BuyerEffectFence["assertCurrent"] }).assertCurrent =
      substitutedFence;
    releaseDns();
    await expect(pending).resolves.toMatchObject({ disposition: "response" });
    expect(originalFence).toHaveBeenCalledOnce();
    expect(substitutedFence).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
  });

  test("rejects accessor or proxy intent and fence authority before DNS without invoking traps", async () => {
    const intent = structuredClone(await preparedIntent());
    let reads = 0;
    Object.defineProperty(intent, "httpResource", {
      enumerable: true,
      get() {
        reads += 1;
        return RESOURCE;
      },
    });
    const resolveHost = vi.fn(async () => ["8.8.8.8"]);
    const transport = createX402BuyerPaidRequestTransport({
      publicHttpsDependencies: {
        resolveHost,
        request: async () => new Response(null, { status: 200 }),
      },
    });
    const safeFence: X402BuyerEffectFence = {
      owner: "buyer-worker",
      generation: 1,
      settlementKey: intent.settlementKey,
      bindingHash: intent.bindingHash,
      idempotencyKey: intent.settlementKey,
      assertCurrent: async () => undefined,
    };
    await expect(transport.submitRetained(intent, safeFence)).resolves.toEqual({
      disposition: "indeterminate",
      reason: "x402-paid-request-response-indeterminate",
    });
    const safeIntent = await preparedIntent();
    const accessorFence = { ...safeFence };
    Object.defineProperty(accessorFence, "assertCurrent", {
      enumerable: true,
      get() {
        reads += 1;
        return async () => undefined;
      },
    });
    await expect(transport.submitRetained(safeIntent, accessorFence)).resolves.toEqual({
      disposition: "indeterminate",
      reason: "x402-paid-request-response-indeterminate",
    });
    await expect(transport.submitRetained(
      new Proxy(safeIntent, {}),
      safeFence,
    )).resolves.toEqual({
      disposition: "indeterminate",
      reason: "x402-paid-request-response-indeterminate",
    });
    expect(reads).toBe(0);
    expect(resolveHost).not.toHaveBeenCalled();
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
      transportPolicy: { mode: "insecure-test" },
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
      transportPolicy: { mode: "insecure-test" },
      fetchImpl: async () => new Response(null, { status: 200 }),
    });
    await expect(headerless({
      intent,
      transactionHash: `0x${"ab".repeat(32)}`,
      fence,
    })).resolves.toBeUndefined();
    const lost = createX402BuyerRetainedDisclosureRecovery({
      transportPolicy: { mode: "insecure-test" },
      fetchImpl: async () => { throw new Error("response lost"); },
    });
    await expect(lost({
      intent,
      transactionHash: `0x${"ab".repeat(32)}`,
      fence,
    })).resolves.toBeUndefined();
  });
});
