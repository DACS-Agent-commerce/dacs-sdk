import { types as nodeTypes } from "node:util";

import { baseUnits, canonicalizeDecimal, sha256Hex } from "../canonical/index.js";
import { snapshotWireJsonRead } from "../canonical/snapshot.js";
import { DacsError } from "../errors.js";
import type { SubstrateAdapter } from "../substrate/SubstrateAdapter.js";
import type {
  Ap2AttestedProviderStatus,
  Ap2ProviderAdapter,
  Ap2ProviderSubmission,
} from "./ap2.js";

const STRIPE_API = "https://api.stripe.com/v1";
const STRIPE_KEY_RE = /^rk_(test|live)_[A-Za-z0-9]+$/;
const STRIPE_PAYMENT_INTENT_RE = /^pi_[A-Za-z0-9]+$/;
const HASH_RE = /^(?:0x)?([0-9a-fA-F]{64})$/;

export interface StripeAp2IntegrationOptions {
  /** Restricted key with PaymentIntents create/write permission. */
  createCredential: string;
  /** Distinct restricted key with PaymentIntents read-only permission. */
  statusCredential: string;
  /** DACS/AP2 merchant id bound to the credential-owning Stripe account. */
  payeeId: string;
  /** ISO-4217 exponent used for exact provider base-unit conversion. */
  currencyMinorUnits: number;
  /** Connected Demos SR-3 adapter; only the status key crosses this seam. */
  substrate: Pick<SubstrateAdapter, "proxyFetch">;
  /** Defaults to global fetch; injectable for deterministic tests. */
  fetchImpl?: typeof fetch;
  /** Live restricted keys are refused unless explicitly enabled. */
  allowLive?: boolean;
}

function option<T>(owner: unknown, key: string, label: string, optional = false): T | undefined {
  if (owner === null || typeof owner !== "object" || nodeTypes.isProxy(owner)) {
    throw new DacsError(`${label} options must be a stable object`);
  }
  let cursor: object | null = owner;
  while (cursor !== null) {
    if (nodeTypes.isProxy(cursor)) throw new DacsError(`${label} owner must not be a proxy`);
    const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
    if (descriptor) {
      if (!("value" in descriptor)) throw new DacsError(`${label} must not be an accessor`);
      return descriptor.value as T;
    }
    cursor = Object.getPrototypeOf(cursor) as object | null;
  }
  if (optional) return undefined;
  throw new DacsError(`${label} is missing`);
}

function stableCallback<T extends Function>(value: unknown, owner: unknown, label: string): T {
  if (typeof value !== "function" || nodeTypes.isProxy(value)) {
    throw new DacsError(`${label} must be a stable function`);
  }
  return Function.prototype.bind.call(value, owner) as T;
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new DacsError(`${label} must be a non-empty exact string`);
  }
  return value;
}

function credential(value: unknown, label: string, allowLive: boolean): string {
  if (typeof value !== "string" || !STRIPE_KEY_RE.test(value)) {
    throw new DacsError(`${label} must be a Stripe restricted API key`);
  }
  if (!allowLive && value.startsWith("rk_live_")) {
    throw new DacsError(`${label} is live; explicit allowLive is required`);
  }
  return value;
}

function paymentIntentId(value: unknown, label: string): string {
  if (typeof value !== "string" || !STRIPE_PAYMENT_INTENT_RE.test(value)) {
    throw new DacsError(`${label} is not a Stripe PaymentIntent id`);
  }
  return value;
}

function stripeError(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: { type?: unknown; code?: unknown; message?: unknown };
    };
    const type = typeof parsed.error?.type === "string" ? parsed.error.type : "stripe-error";
    const code = typeof parsed.error?.code === "string" ? `/${parsed.error.code}` : "";
    const message = typeof parsed.error?.message === "string"
      ? parsed.error.message.replace(/[\r\n]+/g, " ").slice(0, 240)
      : `HTTP ${status}`;
    return `${type}${code}: ${message}`;
  } catch {
    return `HTTP ${status}`;
  }
}

function parseStripeObject(body: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (cause) {
    throw new DacsError(`${label} was not JSON`, { cause });
  }
  const snapshot = snapshotWireJsonRead(parsed, label);
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new DacsError(`${label} must be a JSON object`);
  }
  return snapshot as Record<string, unknown>;
}

function attestationHash(value: unknown): string {
  if (typeof value !== "string") throw new DacsError("DAHR AP2 responseHash is missing");
  const match = value.match(HASH_RE);
  if (!match) throw new DacsError("DAHR AP2 responseHash is malformed");
  return match[1]!.toLowerCase();
}

function stripeMetadata(value: unknown): Readonly<Record<string, string>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DacsError("Stripe AP2 metadata is missing");
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") throw new DacsError("Stripe AP2 metadata is not textual");
    result[key] = item;
  }
  return Object.freeze(result);
}

function majorUnits(minor: number, decimals: number): string {
  if (!Number.isSafeInteger(minor) || minor < 0) {
    throw new DacsError("Stripe AP2 amount is malformed");
  }
  const digits = String(minor).padStart(decimals + 1, "0");
  if (decimals === 0) return canonicalizeDecimal(digits);
  return canonicalizeDecimal(
    `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`,
  );
}

/** Fail early if an operator accidentally configures one credential for both roles. */
export function assertStripeAp2CredentialsAreSplit(input: {
  createCredential: string;
  statusCredential: string;
}): void {
  const createKey = credential(
    option(input, "createCredential", "Stripe AP2 createCredential"),
    "Stripe AP2 createCredential",
    true,
  );
  const statusKey = credential(
    option(input, "statusCredential", "Stripe AP2 statusCredential"),
    "Stripe AP2 statusCredential",
    true,
  );
  if (createKey === statusKey) {
    throw new DacsError("Stripe AP2 create and status credentials must be distinct");
  }
}

/**
 * Stripe PaymentIntents + Demos DAHR reference adapter.
 *
 * The privileged key is reachable only in `submit`; the status key is reachable
 * only in `readAttestedStatus` and transits DAHR through its transient Bearer
 * channel. Every provider side effect is generation-fenced.
 */
export function createStripeAp2Integration(
  rawOptions: StripeAp2IntegrationOptions,
): Readonly<{ provider: Ap2ProviderAdapter }> {
  const createCredential = option<string>(
    rawOptions, "createCredential", "Stripe AP2 createCredential",
  )!;
  const statusCredential = option<string>(
    rawOptions, "statusCredential", "Stripe AP2 statusCredential",
  )!;
  const payeeId = nonEmpty(
    option<string>(rawOptions, "payeeId", "Stripe AP2 payeeId"),
    "Stripe AP2 payeeId",
  );
  const currencyMinorUnits = option<number>(
    rawOptions, "currencyMinorUnits", "Stripe AP2 currencyMinorUnits",
  );
  if (!Number.isSafeInteger(currencyMinorUnits) ||
      (currencyMinorUnits as number) < 0 || (currencyMinorUnits as number) > 3) {
    throw new DacsError("Stripe AP2 currencyMinorUnits must be an ISO-4217 exponent from 0 to 3");
  }
  const substrate = option<Pick<SubstrateAdapter, "proxyFetch">>(
    rawOptions, "substrate", "Stripe AP2 substrate",
  )!;
  const proxyFetch = stableCallback<SubstrateAdapter["proxyFetch"]>(
    option<SubstrateAdapter["proxyFetch"]>(
      substrate, "proxyFetch", "Stripe AP2 substrate.proxyFetch",
    ),
    substrate,
    "Stripe AP2 substrate.proxyFetch",
  );
  const allowLive = option<boolean>(rawOptions, "allowLive", "Stripe AP2 allowLive", true);
  if (allowLive !== undefined && typeof allowLive !== "boolean") {
    throw new DacsError("Stripe AP2 allowLive must be boolean when present");
  }
  assertStripeAp2CredentialsAreSplit({ createCredential, statusCredential });
  const createKey = credential(createCredential, "Stripe AP2 createCredential", allowLive === true);
  const statusKey = credential(statusCredential, "Stripe AP2 statusCredential", allowLive === true);
  const fetchImpl = stableCallback<typeof fetch>(
    option<typeof fetch>(rawOptions, "fetchImpl", "Stripe AP2 fetchImpl", true) ?? fetch,
    undefined,
    "Stripe AP2 fetchImpl",
  );
  const decimals = currencyMinorUnits as number;

  const provider: Ap2ProviderAdapter = {
    capabilities: Object.freeze({
      createCredential: true,
      statusOnlyCredential: true,
      credentialsDistinct: true,
      createCredentialRelayed: false,
      providerMetadataWritable: true,
      providerMetadataReadable: true,
      providerIdempotencyKeys: true,
    }),

    async submit(input): Promise<Ap2ProviderSubmission> {
      if (input.idempotencyKey !== input.intent.idempotencyKey ||
          input.fence.idempotencyKey !== input.intent.idempotencyKey) {
        throw new DacsError("Stripe AP2 submission changed the AP2-6 idempotency key");
      }
      if (input.intent.payee !== payeeId) {
        return { disposition: "declined", reason: "stripe-ap2-payee-mismatch" };
      }
      const amountMinor = baseUnits(input.intent.amount, decimals);
      if (!/^[1-9][0-9]*$/.test(amountMinor)) {
        return { disposition: "declined", reason: "stripe-ap2-amount-invalid" };
      }
      const form = new URLSearchParams();
      form.set("amount", amountMinor);
      form.set("currency", input.intent.currency.toLowerCase());
      form.set("payment_method", input.intent.paymentInstrumentId);
      form.append("payment_method_types[]", "card");
      form.set("confirm", "true");
      form.set("error_on_requires_action", "true");
      form.set("metadata[dacs_job_id]", input.metadata.dacs_job_id ?? "");
      form.set("metadata[dacs_agreement_hash]", input.metadata.dacs_agreement_hash ?? "");

      try {
        await input.fence.assertCurrent();
        const response = await fetchImpl(`${STRIPE_API}/payment_intents`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${createKey}`,
            "Content-Type": "application/x-www-form-urlencoded",
            "Idempotency-Key": input.idempotencyKey,
          },
          body: form.toString(),
        });
        const body = await response.text();
        if (!response.ok) {
          const reason = stripeError(body, response.status);
          return response.status === 409 || response.status === 429 || response.status >= 500
            ? { disposition: "indeterminate", reason }
            : { disposition: "declined", reason };
        }
        const object = parseStripeObject(body, "Stripe AP2 PaymentIntent response");
        return {
          disposition: "accepted",
          providerRef: paymentIntentId(object.id, "Stripe AP2 response id"),
        };
      } catch (error) {
        return {
          disposition: "indeterminate",
          reason: error instanceof Error ? error.message : "stripe-ap2-submit-unavailable",
        };
      }
    },

    async readAttestedStatus(input): Promise<Ap2AttestedProviderStatus> {
      const ref = paymentIntentId(input.providerRef, "Stripe AP2 providerRef");
      const locator = stripeAp2ProviderStatusUrl(ref);
      try {
        await input.fence.assertCurrent();
        const result = await proxyFetch({
          url: locator,
          method: "GET",
          headers: { Authorization: `Bearer ${statusKey}` },
        });
        const committedHash = attestationHash(result.responseHash);
        if (sha256Hex(result.body) !== committedHash) {
          return { disposition: "indeterminate", reason: "stripe-ap2-dahr-hash-mismatch" };
        }
        if (typeof result.anchorTxRef !== "string" || result.anchorTxRef.length === 0 ||
            !Number.isSafeInteger(result.fetchedAt) || result.fetchedAt < 0) {
          return { disposition: "indeterminate", reason: "stripe-ap2-dahr-evidence-incomplete" };
        }
        if (result.status === 404) {
          return { disposition: "indeterminate", reason: "stripe-ap2-provider-ref-not-found" };
        }
        if (result.status < 200 || result.status >= 300) {
          return {
            disposition: "indeterminate",
            reason: stripeError(result.body, result.status),
          };
        }
        const object = parseStripeObject(result.body, "Stripe AP2 DAHR PaymentIntent");
        if (paymentIntentId(object.id, "Stripe AP2 DAHR response id") !== ref) {
          return { disposition: "indeterminate", reason: "stripe-ap2-provider-ref-mismatch" };
        }
        if (typeof object.status !== "string" || object.status.length === 0) {
          return { disposition: "indeterminate", reason: "stripe-ap2-status-missing" };
        }
        if (object.status === "canceled") {
          return { disposition: "terminal-not-captured", reason: "stripe-payment-intent-canceled" };
        }
        if (object.status !== "succeeded") {
          return { disposition: "pending", reason: `stripe-payment-intent-${object.status}` };
        }
        if (typeof object.currency !== "string" || !/^[a-z]{3}$/.test(object.currency) ||
            !Number.isSafeInteger(object.amount_received)) {
          return { disposition: "indeterminate", reason: "stripe-ap2-status-fields-malformed" };
        }
        return {
          disposition: "captured",
          providerRef: ref,
          payee: payeeId,
          amount: majorUnits(object.amount_received as number, decimals),
          currency: object.currency.toUpperCase(),
          metadata: stripeMetadata(object.metadata),
          receiptAttestation: {
            anchor: { kind: "https", locator },
            contentHash: committedHash,
          },
          receiptTransactionRef: {
            kind: "demos-web2-request",
            value: result.anchorTxRef,
          },
          capturedAt: result.fetchedAt,
        };
      } catch (error) {
        return {
          disposition: "indeterminate",
          reason: error instanceof Error ? error.message : "stripe-ap2-status-unavailable",
        };
      }
    },
  };

  return Object.freeze({ provider: Object.freeze(provider) });
}

/** Public shape used by tests/runners without retaining secret material. */
export function stripeAp2ProviderStatusUrl(providerRef: string): string {
  return `${STRIPE_API}/payment_intents/${encodeURIComponent(
    paymentIntentId(providerRef, "Stripe AP2 providerRef"),
  )}`;
}
