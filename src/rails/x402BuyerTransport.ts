import { types as nodeTypes } from "node:util";

import { sha256Hex } from "../canonical/index.js";
import type { X402BuyerEvmDisclosureRecovery } from "./x402BuyerEvmAuthorization.js";
import {
  createX402BuyerSettlementIntent,
  type X402BuyerJson,
  type X402BuyerEffectFence,
  type X402BuyerPaidRequestTransport,
  type X402BuyerPaymentRequirements,
  type X402BuyerSettlementIntent,
  type X402BuyerSettlementIntentDraft,
} from "./x402BuyerSettlement.js";

const MAX_CHALLENGE_CHARACTERS = 1_048_576;
const PAYMENT_SIGNATURE = "PAYMENT-SIGNATURE";
const PAYMENT_RESPONSE = "PAYMENT-RESPONSE";

export type X402BuyerPreparationAuthority = Omit<
  X402BuyerSettlementIntentDraft,
  | "chosenRequirements"
  | "signedPaymentPayload"
  | "paymentHeader"
  | "authorizationNonce"
>;

/** Structural subset shared by `x402Client` and `x402HTTPClient`. */
export interface X402BuyerChallengeClient {
  /** Optional local authority filter applied before any signing operation. */
  isPaymentRequirementsAuthorized?(
    requirements: Readonly<X402BuyerPaymentRequirements>,
  ): boolean;
  getPaymentRequiredResponse(
    getHeader: (name: string) => string | null | undefined,
    body?: unknown,
  ): unknown;
  createPaymentPayload(paymentRequired: unknown): Promise<unknown>;
  encodePaymentSignatureHeader(paymentPayload: unknown): Record<string, string>;
}

export interface PrepareX402BuyerSettlementInput {
  /** Complete authenticated DACS authority, excluding challenge-derived fields. */
  authority: Readonly<X402BuyerPreparationAuthority>;
  /** Optional `Accept` header for the unpaid GET; every other caller header is refused. */
  challengeHeaders?: X402BuyerHeaderInit;
}

export interface PrepareX402BuyerSettlementDeps {
  client: X402BuyerChallengeClient;
  /** Caller-supplied transport that must enforce the DACS-1 §6.3.6 boundary. */
  fetchImpl: typeof fetch;
}

export type X402BuyerSettlementPreparation =
  | {
      disposition: "prepared";
      intent: Readonly<X402BuyerSettlementIntent>;
    }
  | { disposition: "rejected" | "indeterminate"; reason: string };

export interface X402BuyerPaidRequestTransportOptions {
  /** Caller-supplied transport that must enforce the DACS-1 §6.3.6 boundary. */
  fetchImpl: typeof fetch;
  /** Optional `Accept` header; every other base header is refused before payment is added. */
  headers?: X402BuyerHeaderInit;
}

export type X402BuyerHeaderInit =
  | Headers
  | Record<string, string>
  | Array<[string, string]>;

const ALLOWED_X402_BUYER_BASE_HEADERS = new Set(["accept"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyUnicodeScalars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function captureX402BuyerPreparationAuthority(
  value: unknown,
): Readonly<X402BuyerPreparationAuthority> | null {
  const keys = [
    "jobId",
    "phaseIndex",
    "railId",
    "railVersion",
    "railDescriptorHash",
    "agreementHash",
    "termsHash",
    "sessionBindingHash",
    "network",
    "payer",
    "payee",
    "asset",
    "amount",
    "httpResource",
    "method",
  ] as const;
  if (!isRecord(value) || nodeTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.keys(descriptors).length !== keys.length ||
      keys.some((key) => {
        const descriptor = descriptors[key];
        return !descriptor || !descriptor.enumerable || !("value" in descriptor) ||
          descriptor.value === undefined;
      })) return null;
  const data = Object.fromEntries(
    keys.map((key) => [key, descriptors[key]!.value]),
  ) as Record<string, unknown>;
  const chainMatch = typeof data.network === "string"
    ? /^eip155:([1-9][0-9]*)$/.exec(data.network)
    : null;
  if (typeof data.jobId !== "string" || data.jobId.length === 0 ||
      /[\u0000-\u001f\u007f]/.test(data.jobId) ||
      !hasOnlyUnicodeScalars(data.jobId) ||
      !Number.isSafeInteger(data.phaseIndex) || Number(data.phaseIndex) < 0 ||
      Object.is(data.phaseIndex, -0) ||
      typeof data.railId !== "string" || !/^[\x20-\x7e]+$/.test(data.railId) ||
      typeof data.railVersion !== "string" || !/^[\x20-\x7e]+$/.test(data.railVersion) ||
      ![data.railDescriptorHash, data.agreementHash, data.termsHash,
        data.sessionBindingHash].every((item) =>
        typeof item === "string" && /^[0-9a-f]{64}$/.test(item)) ||
      !chainMatch || !Number.isSafeInteger(Number(chainMatch[1])) ||
      ![data.payer, data.payee, data.asset].every((item) =>
        typeof item === "string" && /^0x[0-9a-fA-F]{40}$/.test(item)) ||
      typeof data.amount !== "string" || !/^[1-9][0-9]*$/.test(data.amount) ||
      data.method !== "GET" || typeof data.httpResource !== "string") return null;
  try {
    const resource = new URL(data.httpResource);
    if ((resource.protocol !== "https:" && resource.protocol !== "http:") ||
        resource.username || resource.password || resource.hash) return null;
  } catch {
    return null;
  }
  return Object.freeze(data as unknown as X402BuyerPreparationAuthority);
}

function sameAddress(left: unknown, right: string): boolean {
  return typeof left === "string" && left.toLowerCase() === right.toLowerCase();
}

function asRequirements(value: unknown): X402BuyerPaymentRequirements | null {
  if (!isRecord(value) || typeof value.scheme !== "string" ||
      typeof value.network !== "string" || typeof value.amount !== "string" ||
      typeof value.asset !== "string" || typeof value.payTo !== "string" ||
      !Number.isSafeInteger(value.maxTimeoutSeconds) ||
      Number(value.maxTimeoutSeconds) <= 0 || !isRecord(value.extra)) return null;
  try {
    return structuredClone(value) as unknown as X402BuyerPaymentRequirements;
  } catch {
    return null;
  }
}

function chosenRequirements(
  paymentRequired: unknown,
  authority: Readonly<X402BuyerPreparationAuthority>,
  client: Readonly<X402BuyerChallengeClient>,
): {
  paymentRequired: Record<string, unknown>;
  requirements: X402BuyerPaymentRequirements;
} | null {
  let snapshot: unknown;
  try {
    snapshot = structuredClone(paymentRequired);
  } catch {
    return null;
  }
  if (!isRecord(snapshot) || snapshot.x402Version !== 2 ||
      !Array.isArray(snapshot.accepts) || !isRecord(snapshot.resource) ||
      snapshot.resource.url !== authority.httpResource) return null;
  for (const candidate of snapshot.accepts) {
    const requirements = asRequirements(candidate);
    if (!requirements || requirements.scheme !== "exact" ||
        requirements.network !== authority.network ||
        requirements.amount !== authority.amount ||
        !sameAddress(requirements.asset, authority.asset) ||
        !sameAddress(requirements.payTo, authority.payee) ||
        typeof requirements.extra.name !== "string" ||
        requirements.extra.name.length === 0 ||
        typeof requirements.extra.version !== "string" ||
        requirements.extra.version.length === 0) continue;
    try {
      if (client.isPaymentRequirementsAuthorized &&
          client.isPaymentRequirementsAuthorized(requirements) !== true) continue;
    } catch {
      continue;
    }
    const scoped = structuredClone(snapshot);
    scoped.accepts = [structuredClone(requirements)];
    return { paymentRequired: scoped, requirements };
  }
  return null;
}

function expectedNonce(jobId: string, phaseIndex: number): `0x${string}` {
  return `0x${sha256Hex(
    `dacs-sb3:v1:${jobId.normalize("NFC")}:${phaseIndex}`,
  )}`;
}

function captureHeaders(value: X402BuyerHeaderInit | undefined): Headers {
  const headers = new Headers(value);
  if (headers.has(PAYMENT_SIGNATURE) || headers.has("X-PAYMENT")) {
    throw new TypeError("x402 buyer base headers cannot contain payment authorization");
  }
  for (const name of headers.keys()) {
    if (!ALLOWED_X402_BUYER_BASE_HEADERS.has(name)) {
      throw new TypeError("x402 buyer base headers must be allowlisted and non-credentialed");
    }
  }
  return headers;
}

function capturePaymentHeader(headers: Record<string, string>): string | null {
  let found: string | null = null;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toUpperCase() !== PAYMENT_SIGNATURE) continue;
    if (found !== null || typeof value !== "string" || value.length === 0) return null;
    found = value;
  }
  return found;
}

async function challengeBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > MAX_CHALLENGE_CHARACTERS) {
    throw new TypeError("x402 challenge body exceeds the retained input limit");
  }
  if (text.length === 0) return undefined;
  return JSON.parse(text) as unknown;
}

/**
 * Fetch, select and sign an x402 v2 challenge without submitting payment.
 * The returned intent is the only value that may cross the durable WAL before
 * `advanceX402BuyerSettlement` invokes the paid transport.
 */
export async function prepareX402BuyerSettlement(
  input: Readonly<PrepareX402BuyerSettlementInput>,
  deps: Readonly<PrepareX402BuyerSettlementDeps>,
): Promise<X402BuyerSettlementPreparation> {
  const authority = captureX402BuyerPreparationAuthority(input?.authority);
  if (!authority) {
    return { disposition: "rejected", reason: "x402-settlement-authority-invalid" };
  }
  let challengeHeaders: Headers;
  try {
    challengeHeaders = captureHeaders(input?.challengeHeaders);
  } catch {
    return { disposition: "rejected", reason: "x402-challenge-headers-invalid" };
  }
  const fetchImpl = deps?.fetchImpl;
  if (typeof fetchImpl !== "function" || !deps?.client ||
      (deps.client.isPaymentRequirementsAuthorized !== undefined &&
        typeof deps.client.isPaymentRequirementsAuthorized !== "function") ||
      typeof deps.client.getPaymentRequiredResponse !== "function" ||
      typeof deps.client.createPaymentPayload !== "function" ||
      typeof deps.client.encodePaymentSignatureHeader !== "function") {
    return { disposition: "rejected", reason: "x402-challenge-dependencies-invalid" };
  }

  let response: Response;
  try {
    response = await fetchImpl(authority.httpResource, {
      method: "GET",
      headers: challengeHeaders,
      redirect: "error",
    });
  } catch {
    return { disposition: "indeterminate", reason: "x402-challenge-unavailable" };
  }
  if (response.status !== 402) {
    return { disposition: "rejected", reason: "x402-payment-required-response-missing" };
  }

  let paymentRequired: unknown;
  try {
    const body = await challengeBody(response);
    paymentRequired = deps.client.getPaymentRequiredResponse(
      (name) => response.headers.get(name),
      body,
    );
  } catch {
    return { disposition: "rejected", reason: "x402-payment-required-response-invalid" };
  }
  const selected = chosenRequirements(paymentRequired, authority, deps.client);
  if (!selected) {
    return { disposition: "rejected", reason: "x402-payment-requirements-mismatch" };
  }

  let signedPaymentPayload: unknown;
  let paymentHeader: string | null;
  try {
    signedPaymentPayload = structuredClone(
      await deps.client.createPaymentPayload(selected.paymentRequired),
    );
    paymentHeader = capturePaymentHeader(
      deps.client.encodePaymentSignatureHeader(signedPaymentPayload),
    );
  } catch {
    return { disposition: "indeterminate", reason: "x402-payment-signing-unavailable" };
  }
  if (!paymentHeader || !isRecord(signedPaymentPayload)) {
    return { disposition: "rejected", reason: "x402-payment-signature-invalid" };
  }

  try {
    return {
      disposition: "prepared",
      intent: createX402BuyerSettlementIntent({
        ...authority,
        chosenRequirements: selected.requirements,
        signedPaymentPayload: signedPaymentPayload as Record<string, X402BuyerJson>,
        paymentHeader: { name: PAYMENT_SIGNATURE, value: paymentHeader },
        authorizationNonce: expectedNonce(
          authority.jobId,
          authority.phaseIndex,
        ),
      }),
    };
  } catch {
    return { disposition: "rejected", reason: "x402-payment-signature-scope-mismatch" };
  }
}

/**
 * Create the paid HTTP effect used by the durable buyer coordinator. It sends
 * only the retained bearer credential plus an optional caller `Accept` header
 * and the safe transport's own representation/user-agent headers. It refuses
 * redirects and treats the response header as a candidate until the independent
 * authorization provider authenticates the chain event.
 */
export function createX402BuyerPaidRequestTransport(
  options: Readonly<X402BuyerPaidRequestTransportOptions>,
): X402BuyerPaidRequestTransport {
  const fetchImpl = options?.fetchImpl;
  if (typeof fetchImpl !== "function") {
    throw new TypeError("x402 buyer paid transport requires fetch");
  }
  const retainedHeaders = captureHeaders(options.headers);
  const transport: X402BuyerPaidRequestTransport = {
    async submitRetained(
      intent: Readonly<X402BuyerSettlementIntent>,
      fence: Readonly<X402BuyerEffectFence>,
    ) {
      const headers = new Headers(retainedHeaders);
      headers.set(PAYMENT_SIGNATURE, intent.paymentHeader.value);
      let response: Response;
      try {
        // This must remain immediately adjacent to the irreversible request.
        await fence.assertCurrent();
        response = await fetchImpl(intent.httpResource, {
          method: "GET",
          headers,
          redirect: "error",
        });
      } catch {
        return {
          disposition: "indeterminate" as const,
          reason: "x402-paid-request-response-indeterminate",
        };
      }
      const encodedSettlementHeader = response.headers.get(PAYMENT_RESPONSE);
      return {
        disposition: "response" as const,
        ...(encodedSettlementHeader === null
          ? {}
          : {
              disclosure: {
                protocolVersion: "2" as const,
                headerName: PAYMENT_RESPONSE as "PAYMENT-RESPONSE",
                encodedSettlementHeader,
                httpResource: intent.httpResource,
              },
            }),
      };
    },
  };
  return Object.freeze(transport);
}

/**
 * Recover a lost PAYMENT-RESPONSE by replaying only the exact retained paid
 * request. The EIP-3009 authorization provider invokes this callback only
 * after it has observed the retained nonce as used on-chain, and it still
 * authenticates the returned transaction against the canonical receipt.
 * Reusing the same signed nonce cannot authorize a second token transfer.
 */
export function createX402BuyerRetainedDisclosureRecovery(
  options: Readonly<X402BuyerPaidRequestTransportOptions>,
): X402BuyerEvmDisclosureRecovery {
  const transport = createX402BuyerPaidRequestTransport(options);
  return async ({ intent, fence }) => {
    const result = await transport.submitRetained(intent, fence);
    return result.disposition === "response" ? result.disclosure : undefined;
  };
}
