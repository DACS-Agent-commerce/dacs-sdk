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

function statusBody(overrides: Record<string, unknown> = {}): string {
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
    ...overrides,
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

  test.each([
    { currency: "JPY", amount: "10", minorUnits: 0, providerAmount: "10" },
    { currency: "ISK", amount: "10", minorUnits: 2, providerAmount: "1000" },
    { currency: "UGX", amount: "10", minorUnits: 2, providerAmount: "1000" },
    { currency: "HUF", amount: "10.45", minorUnits: 2, providerAmount: "1045" },
    { currency: "TWD", amount: "800.45", minorUnits: 2, providerAmount: "80045" },
  ])("uses Stripe charge units for $currency", async ({
    currency, amount, minorUnits, providerAmount,
  }) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ id: "pi_reference123", object: "payment_intent" }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const { provider } = createStripeAp2Integration(options({
      currencyMinorUnits: minorUnits,
      fetchImpl,
    }));
    const result = await provider.submit({
      intent: { ...INTENT, currency, amount },
      checkoutMandate: {},
      paymentMandate: {},
      metadata: {},
      idempotencyKey: INTENT.idempotencyKey,
      fence: fence(),
    });

    expect(result).toMatchObject({ disposition: "accepted" });
    const form = new URLSearchParams(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(form.get("currency")).toBe(currency.toLowerCase());
    expect(form.get("amount")).toBe(providerAmount);
  });

  test.each([
    { currency: "USD", minorUnits: 0, reason: "stripe-ap2-currency-minor-units-mismatch" },
    { currency: "JPY", minorUnits: 2, reason: "stripe-ap2-currency-minor-units-mismatch" },
    { currency: "BHD", minorUnits: 3, reason: "stripe-ap2-currency-unsupported" },
    { currency: "ZZZ", minorUnits: 2, reason: "stripe-ap2-currency-unsupported" },
  ])("refuses unsupported or misconfigured $currency before fetch", async ({
    currency, minorUnits, reason,
  }) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { provider } = createStripeAp2Integration(options({
      currencyMinorUnits: minorUnits,
      fetchImpl,
    }));
    await expect(provider.submit({
      intent: { ...INTENT, currency },
      checkoutMandate: {},
      paymentMandate: {},
      metadata: {},
      idempotencyKey: INTENT.idempotencyKey,
      fence: fence(),
    })).resolves.toEqual({ disposition: "declined", reason });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each(["ISK", "UGX"])("refuses fractional %s charges before fetch", async (currency) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { provider } = createStripeAp2Integration(options({ fetchImpl }));
    await expect(provider.submit({
      intent: { ...INTENT, currency, amount: "10.5" },
      checkoutMandate: {},
      paymentMandate: {},
      metadata: {},
      idempotencyKey: INTENT.idempotencyKey,
      fence: fence(),
    })).resolves.toEqual({
      disposition: "declined",
      reason: "stripe-ap2-amount-fractional",
    });
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

  test.each([
    {
      label: "different captured currency",
      intent: INTENT,
      minorUnits: 2,
      body: statusBody({ currency: "eur" }),
      reason: "stripe-ap2-currency-mismatch",
    },
    {
      label: "unsupported captured currency",
      intent: INTENT,
      minorUnits: 2,
      body: statusBody({ currency: "zzz" }),
      reason: "stripe-ap2-currency-unsupported",
    },
    {
      label: "wrong configured units",
      intent: { ...INTENT, currency: "JPY", amount: "10" },
      minorUnits: 2,
      body: statusBody({ currency: "jpy", amount: 10, amount_received: 10 }),
      reason: "stripe-ap2-currency-minor-units-mismatch",
    },
    {
      label: "fractional ISK",
      intent: { ...INTENT, currency: "ISK", amount: "10.5" },
      minorUnits: 2,
      body: statusBody({ currency: "isk", amount: 1050, amount_received: 1050 }),
      reason: "stripe-ap2-amount-fractional",
    },
    {
      label: "fractional UGX",
      intent: { ...INTENT, currency: "UGX", amount: "10.5" },
      minorUnits: 2,
      body: statusBody({ currency: "ugx", amount: 1050, amount_received: 1050 }),
      reason: "stripe-ap2-amount-fractional",
    },
  ])("fails closed on $label status", async ({ intent, minorUnits, body, reason }) => {
    const { provider } = createStripeAp2Integration(options({
      currencyMinorUnits: minorUnits,
      substrate: {
        proxyFetch: async () => ({
          body,
          status: 200,
          responseHash: sha256Hex(body),
          anchorTxRef: "0xdahr-status-anchor",
          fetchedAt: 1_700_000_000_000,
        }),
      },
    }));

    await expect(provider.readAttestedStatus({
      intent,
      providerRef: "pi_reference123",
      fence: fence(),
    })).resolves.toEqual({ disposition: "indeterminate", reason });
  });

  test.each([
    { currency: "JPY", amount: "10", minorUnits: 0, amountReceived: 10 },
    { currency: "ISK", amount: "10", minorUnits: 2, amountReceived: 1000 },
    { currency: "UGX", amount: "10", minorUnits: 2, amountReceived: 1000 },
    { currency: "HUF", amount: "10.45", minorUnits: 2, amountReceived: 1045 },
    { currency: "TWD", amount: "800.45", minorUnits: 2, amountReceived: 80045 },
  ])("decodes captured $currency with Stripe charge units", async ({
    currency, amount, minorUnits, amountReceived,
  }) => {
    const body = statusBody({
      currency: currency.toLowerCase(),
      amount: amountReceived,
      amount_received: amountReceived,
    });
    const { provider } = createStripeAp2Integration(options({
      currencyMinorUnits: minorUnits,
      substrate: {
        proxyFetch: async () => ({
          body,
          status: 200,
          responseHash: sha256Hex(body),
          anchorTxRef: "0xdahr-status-anchor",
          fetchedAt: 1_700_000_000_000,
        }),
      },
    }));

    await expect(provider.readAttestedStatus({
      intent: { ...INTENT, currency, amount },
      providerRef: "pi_reference123",
      fence: fence(),
    })).resolves.toMatchObject({ disposition: "captured", currency, amount });
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
