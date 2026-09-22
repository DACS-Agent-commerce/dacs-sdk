import { describe, expect, test, vi } from "vitest";

import { sha256Hex } from "../../src/canonical/index.js";
import { DacsError } from "../../src/errors.js";
import type {
  Ap2EffectFence,
  Ap2SettlementIntent,
} from "../../src/rails/ap2.js";
import {
  assertStripeAp2CredentialsAreSplit,
  createStripeAp2Integration,
} from "../../src/rails/ap2Stripe.js";
import type { ProxyFetchRequest } from "../../src/substrate/SubstrateAdapter.js";

// Assemble synthetic restricted-key shapes at runtime so secret scanners do
// not need repository-wide allow-list exceptions for test fixtures.
const CREATE_KEY = ["rk", "test", "CreateCredential123"].join("_");
const STATUS_KEY = ["rk", "test", "StatusCredential456"].join("_");

const INTENT: Ap2SettlementIntent = {
  intentVersion: "1",
  bindingHash: "a".repeat(64),
  transactionId: "transaction-id",
  jobId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  phaseIndex: 3,
  agreementHash: "b".repeat(64),
  idempotencyKey: "c".repeat(64),
  mandateId: "mandate-1",
  payee: "merchant-dacs",
  amount: "10",
  currency: "USD",
  protocolVersion: "0.2",
  paymentInstrumentId: "pm_card_visa",
};

function fence(): Ap2EffectFence {
  return {
    transactionId: INTENT.transactionId,
    bindingHash: INTENT.bindingHash,
    owner: "worker-a",
    generation: 1,
    idempotencyKey: INTENT.idempotencyKey,
    assertCurrent: vi.fn(async () => undefined),
  };
}

function statusBody(): string {
  return JSON.stringify({
    id: "pi_reference123",
    object: "payment_intent",
    amount: 1000,
    amount_received: 1000,
    currency: "usd",
    status: "succeeded",
    metadata: {
      dacs_job_id: INTENT.jobId,
      dacs_agreement_hash: INTENT.agreementHash,
    },
  });
}

function options(overrides: Record<string, unknown> = {}) {
  return {
    createCredential: CREATE_KEY,
    statusCredential: STATUS_KEY,
    payeeId: INTENT.payee,
    currencyMinorUnits: 2,
    substrate: { proxyFetch: vi.fn() },
    ...overrides,
  };
}

describe("Stripe AP2 reference adapter", () => {
  test("submits exact AP2 terms with only the create credential and generation fence", async () => {
    const fetchImpl = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response(
      JSON.stringify({ id: "pi_reference123", object: "payment_intent" }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const { provider } = createStripeAp2Integration(options({ fetchImpl }));
    const effectFence = fence();
    const result = await provider.submit({
      intent: INTENT,
      checkoutMandate: {},
      paymentMandate: {},
      metadata: {
        dacs_job_id: INTENT.jobId,
        dacs_agreement_hash: INTENT.agreementHash,
      },
      idempotencyKey: INTENT.idempotencyKey,
      fence: effectFence,
    });

    expect(result).toEqual({ disposition: "accepted", providerRef: "pi_reference123" });
    expect(effectFence.assertCurrent).toHaveBeenCalledOnce();
    const [, init] = fetchImpl.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${CREATE_KEY}`);
    expect(headers.get("authorization")).not.toContain(STATUS_KEY);
    expect(headers.get("idempotency-key")).toBe(INTENT.idempotencyKey);
    const form = new URLSearchParams(String(init?.body));
    expect(form.get("amount")).toBe("1000");
    expect(form.get("currency")).toBe("usd");
    expect(form.get("payment_method")).toBe("pm_card_visa");
    expect(form.get("metadata[dacs_job_id]")).toBe(INTENT.jobId);
    expect(form.get("metadata[dacs_agreement_hash]")).toBe(INTENT.agreementHash);
  });

  test("changed AP2-6 key is refused before fetch", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { provider } = createStripeAp2Integration(options({ fetchImpl }));
    await expect(provider.submit({
      intent: INTENT,
      checkoutMandate: {},
      paymentMandate: {},
      metadata: {},
      idempotencyKey: "wrong",
      fence: fence(),
    })).rejects.toThrow(/changed the AP2-6/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("reads status through DAHR with only the status credential and separates both references", async () => {
    const body = statusBody();
    const requests: ProxyFetchRequest[] = [];
    const proxyFetch = vi.fn(async (request: ProxyFetchRequest) => {
      requests.push(request);
      return {
        body,
        status: 200,
        responseHash: sha256Hex(body),
        anchorTxRef: "0xdahr-status-anchor",
        fetchedAt: 1_700_000_000_000,
      };
    });
    const { provider } = createStripeAp2Integration(options({ substrate: { proxyFetch } }));
    const result = await provider.readAttestedStatus({
      intent: INTENT,
      providerRef: "pi_reference123",
      fence: fence(),
    });

    expect(requests[0]?.headers?.Authorization).toBe(`Bearer ${STATUS_KEY}`);
    expect(requests[0]?.headers?.Authorization).not.toContain(CREATE_KEY);
    expect(result).toMatchObject({
      disposition: "captured",
      providerRef: "pi_reference123",
      amount: "10",
      currency: "USD",
      receiptAttestation: {
        anchor: {
          kind: "https",
          locator: "https://api.stripe.com/v1/payment_intents/pi_reference123",
        },
        contentHash: sha256Hex(body),
      },
      receiptTransactionRef: {
        kind: "demos-web2-request",
        value: "0xdahr-status-anchor",
      },
    });
  });

  test("hash mismatch and missing DAHR anchor stay indeterminate", async () => {
    const body = statusBody();
    for (const result of [
      { body, status: 200, responseHash: "0".repeat(64), anchorTxRef: "0xdahr", fetchedAt: 1 },
      { body, status: 200, responseHash: sha256Hex(body), fetchedAt: 1 },
    ]) {
      const { provider } = createStripeAp2Integration(options({
        substrate: { proxyFetch: async () => result },
      }));
      await expect(provider.readAttestedStatus({
        intent: INTENT,
        providerRef: "pi_reference123",
        fence: fence(),
      })).resolves.toMatchObject({ disposition: "indeterminate" });
    }
  });
});

describe("Stripe AP2 credential gate", () => {
  test("shared credentials and live credentials without opt-in are rejected", () => {
    expect(() => createStripeAp2Integration(options({ statusCredential: CREATE_KEY })))
      .toThrow(/must be distinct/);
    expect(() => createStripeAp2Integration(options({
      createCredential: "rk_live_Create123",
      statusCredential: "rk_live_Status123",
    }))).toThrow(/explicit allowLive/);
  });

  test("credential assertion accepts distinct restricted keys and rejects standard keys", () => {
    expect(() => assertStripeAp2CredentialsAreSplit({
      createCredential: CREATE_KEY,
      statusCredential: STATUS_KEY,
    })).not.toThrow();
    expect(() => assertStripeAp2CredentialsAreSplit({
      createCredential: "sk_test_standard",
      statusCredential: STATUS_KEY,
    })).toThrow(DacsError);
  });

  test("configuration accessors are rejected without invocation", () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "createCredential", {
      enumerable: true,
      get() { getterCalls += 1; return CREATE_KEY; },
    });
    expect(() => createStripeAp2Integration(accessor as never)).toThrow(/must not be an accessor/);
    expect(getterCalls).toBe(0);
  });
});
