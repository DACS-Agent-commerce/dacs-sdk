import { types as nodeTypes } from "node:util";

import { sha256Hex } from "../canonical/index.js";
import type { X402BuyerEvmDisclosureRecovery } from "./x402BuyerEvmAuthorization.js";
import {
  createX402BuyerSettlementIntent,
  x402BuyerSettlementStoreInternals,
  type X402BuyerJson,
  type X402BuyerEffectFence,
  type X402BuyerPaidRequestTransport,
  type X402BuyerPaymentRequirements,
  type X402BuyerSettlementIntent,
  type X402BuyerSettlementIntentDraft,
} from "./x402BuyerSettlement.js";
import {
  captureX402OutboundHeadersV1,
  requestX402OutboundV1,
  snapshotDacsPublicHttpsDependenciesV1,
  snapshotX402OutboundTransportPolicyV1,
  X402OutboundTransportError,
  type DacsPublicHttpsDependenciesV1,
  type X402OutboundTransportPolicy,
} from "./x402Outbound.js";

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
  /** Explicit trusted custom/test capability. Production callers should omit. */
  fetchImpl?: typeof fetch;
  transportPolicy?: Readonly<X402OutboundTransportPolicy>;
  publicHttpsDependencies?: Readonly<DacsPublicHttpsDependenciesV1>;
}

export type X402BuyerSettlementPreparation =
  | {
      disposition: "prepared";
      intent: Readonly<X402BuyerSettlementIntent>;
    }
  | { disposition: "rejected" | "indeterminate"; reason: string };

export interface X402BuyerPaidRequestTransportOptions {
  /** Explicit trusted custom/test capability. Production callers should omit. */
  fetchImpl?: typeof fetch;
  /** Captured once; payment and legacy payment headers are forbidden. */
  headers?: X402BuyerHeaderInit;
  transportPolicy?: Readonly<X402OutboundTransportPolicy>;
  publicHttpsDependencies?: Readonly<DacsPublicHttpsDependenciesV1>;
}

export type X402BuyerHeaderInit =
  | Headers
  | Record<string, string>
  | Array<[string, string]>;

const ALLOWED_X402_BUYER_BASE_HEADERS = new Set(["accept"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type BuyerTransportMethod = (...args: never[]) => unknown;

function stableDataProperty(
  source: unknown,
  key: string,
  label: string,
): Readonly<{ found: boolean; value?: unknown }> {
  if ((typeof source !== "object" && typeof source !== "function") ||
      source === null || nodeTypes.isProxy(source)) {
    throw new TypeError(`${label} must be stable data`);
  }
  let cursor: object | null = source;
  while (cursor !== null) {
    if (nodeTypes.isProxy(cursor)) {
      throw new TypeError(`${label} must be stable data`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
    if (descriptor !== undefined) {
      if (!("value" in descriptor)) {
        throw new TypeError(`${label} must be stable data`);
      }
      return Object.freeze({ found: true, value: descriptor.value });
    }
    cursor = Object.getPrototypeOf(cursor) as object | null;
  }
  return Object.freeze({ found: false });
}

function stableBoundMethod<T extends BuyerTransportMethod>(
  source: unknown,
  key: string,
  label: string,
): T {
  const property = stableDataProperty(source, key, label);
  if (!property.found || typeof property.value !== "function" ||
      nodeTypes.isProxy(property.value)) {
    throw new TypeError(`${label} must be a stable method`);
  }
  return Function.prototype.bind.call(property.value, source) as T;
}

function optionalStableBoundMethod<T extends BuyerTransportMethod>(
  source: unknown,
  key: string,
  label: string,
): T | undefined {
  const property = stableDataProperty(source, key, label);
  if (!property.found || property.value === undefined) return undefined;
  if (typeof property.value !== "function" || nodeTypes.isProxy(property.value)) {
    throw new TypeError(`${label} must be a stable method`);
  }
  return Function.prototype.bind.call(property.value, source) as T;
}

function captureChallengeClient(value: unknown): Readonly<X402BuyerChallengeClient> {
  const isPaymentRequirementsAuthorized = optionalStableBoundMethod<
    NonNullable<X402BuyerChallengeClient["isPaymentRequirementsAuthorized"]>
  >(value, "isPaymentRequirementsAuthorized", "x402 requirement authorizer");
  return Object.freeze({
    ...(isPaymentRequirementsAuthorized === undefined
      ? {}
      : { isPaymentRequirementsAuthorized }),
    getPaymentRequiredResponse: stableBoundMethod<
      X402BuyerChallengeClient["getPaymentRequiredResponse"]
    >(value, "getPaymentRequiredResponse", "x402 challenge decoder"),
    createPaymentPayload: stableBoundMethod<
      X402BuyerChallengeClient["createPaymentPayload"]
    >(value, "createPaymentPayload", "x402 payment signer"),
    encodePaymentSignatureHeader: stableBoundMethod<
      X402BuyerChallengeClient["encodePaymentSignatureHeader"]
    >(value, "encodePaymentSignatureHeader", "x402 payment header encoder"),
  });
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
  try {
    return captureX402OutboundHeadersV1(value, "forbid");
  } catch (cause) {
    throw new TypeError(
      "x402 buyer base headers must contain only a stable Accept header",
      { cause },
    );
  }
}

function capturePaymentHeader(headers: unknown): string | null {
  if (!isRecord(headers) || nodeTypes.isProxy(headers) ||
      (Object.getPrototypeOf(headers) !== Object.prototype &&
        Object.getPrototypeOf(headers) !== null) ||
      Object.getOwnPropertySymbols(headers).length !== 0) return null;
  const descriptors = Object.getOwnPropertyDescriptors(headers);
  let found: string | null = null;
  for (const [name, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !("value" in descriptor) ||
        typeof descriptor.value !== "string") return null;
    if (name.toUpperCase() !== PAYMENT_SIGNATURE) continue;
    const value = descriptor.value;
    if (found !== null || typeof value !== "string" || value.length === 0) return null;
    found = value;
  }
  return found;
}

function challengeBody(bytes: Uint8Array): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return text.length === 0 ? undefined : JSON.parse(text) as unknown;
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
  let rawAuthority: unknown;
  let rawChallengeHeaders: unknown;
  try {
    rawAuthority = stableDataProperty(
      input,
      "authority",
      "x402 preparation authority",
    ).value;
    rawChallengeHeaders = stableDataProperty(
      input,
      "challengeHeaders",
      "x402 challenge headers",
    ).value;
  } catch {
    return { disposition: "rejected", reason: "x402-settlement-authority-invalid" };
  }
  const authority = captureX402BuyerPreparationAuthority(rawAuthority);
  if (!authority) {
    return { disposition: "rejected", reason: "x402-settlement-authority-invalid" };
  }
  let challengeHeaders: Headers;
  try {
    challengeHeaders = captureHeaders(rawChallengeHeaders as X402BuyerHeaderInit | undefined);
  } catch {
    return { disposition: "rejected", reason: "x402-challenge-headers-invalid" };
  }
  let client: Readonly<X402BuyerChallengeClient>;
  let fetchImpl: typeof fetch | undefined;
  let transportPolicy: Readonly<X402OutboundTransportPolicy> | undefined;
  let publicHttpsDependencies: Readonly<DacsPublicHttpsDependenciesV1> | undefined;
  try {
    client = captureChallengeClient(stableDataProperty(
      deps,
      "client",
      "x402 challenge client",
    ).value);
    const rawFetch = stableDataProperty(
      deps,
      "fetchImpl",
      "x402 challenge fetch",
    ).value;
    if (rawFetch !== undefined &&
        (typeof rawFetch !== "function" || nodeTypes.isProxy(rawFetch))) {
      throw new TypeError("x402 challenge fetch must be a stable method");
    }
    fetchImpl = rawFetch as typeof fetch | undefined;
    transportPolicy = snapshotX402OutboundTransportPolicyV1(
      stableDataProperty(
        deps,
        "transportPolicy",
        "x402 challenge transport policy",
      ).value as Readonly<X402OutboundTransportPolicy> | undefined,
    );
    publicHttpsDependencies = snapshotDacsPublicHttpsDependenciesV1(
      stableDataProperty(
        deps,
        "publicHttpsDependencies",
        "x402 challenge HTTPS dependencies",
      ).value as Readonly<DacsPublicHttpsDependenciesV1> | undefined,
    );
  } catch {
    return { disposition: "rejected", reason: "x402-challenge-dependencies-invalid" };
  }
  if ((fetchImpl !== undefined && transportPolicy?.mode !== "insecure-test") ||
      (fetchImpl === undefined && transportPolicy?.mode === "insecure-test") ||
      !client) {
    return { disposition: "rejected", reason: "x402-challenge-dependencies-invalid" };
  }

  let response: Awaited<ReturnType<typeof requestX402OutboundV1>>;
  try {
    response = await requestX402OutboundV1({
      url: authority.httpResource,
      headers: challengeHeaders,
      paymentHeaderMode: "forbid",
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
      ...(transportPolicy === undefined ? {} : { policy: transportPolicy }),
      ...(publicHttpsDependencies === undefined
        ? {}
        : { dependencies: publicHttpsDependencies }),
    });
  } catch (error) {
    if (error instanceof X402OutboundTransportError && [
      "x402-outbound-url-invalid",
      "x402-outbound-url-unsafe",
      "x402-outbound-address-unsafe",
      "x402-outbound-header-refused",
      "x402-outbound-headers-too-large",
      "x402-insecure-mode-requires-fetch-override",
      "x402-fetch-override-requires-insecure-mode",
      "x402-redirect-refused",
    ].includes(error.reasonCode)) {
      return { disposition: "rejected", reason: "x402-challenge-resource-unsafe" };
    }
    if (error instanceof X402OutboundTransportError && [
      "x402-response-too-large",
      "x402-response-headers-too-large",
      "x402-response-encoding-refused",
      "x402-response-status-invalid",
    ].includes(error.reasonCode)) {
      return {
        disposition: "rejected",
        reason: "x402-payment-required-response-invalid",
      };
    }
    return { disposition: "indeterminate", reason: "x402-challenge-unavailable" };
  }
  if (response.status !== 402) {
    return { disposition: "rejected", reason: "x402-payment-required-response-missing" };
  }

  let paymentRequired: unknown;
  try {
    const body = challengeBody(response.bytes);
    paymentRequired = client.getPaymentRequiredResponse(
      (name) => response.headers.get(name),
      body,
    );
  } catch {
    return { disposition: "rejected", reason: "x402-payment-required-response-invalid" };
  }
  const selected = chosenRequirements(paymentRequired, authority, client);
  if (!selected) {
    return { disposition: "rejected", reason: "x402-payment-requirements-mismatch" };
  }

  let signedPaymentPayload: unknown;
  let paymentHeader: string | null;
  try {
    signedPaymentPayload = structuredClone(
      await client.createPaymentPayload(selected.paymentRequired),
    );
    paymentHeader = capturePaymentHeader(
      client.encodePaymentSignatureHeader(signedPaymentPayload),
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
  options: Readonly<X402BuyerPaidRequestTransportOptions> = {},
): X402BuyerPaidRequestTransport {
  const fetchImpl = stableDataProperty(
    options,
    "fetchImpl",
    "x402 buyer paid transport fetch",
  ).value as typeof fetch | undefined;
  if (fetchImpl !== undefined &&
      (typeof fetchImpl !== "function" || nodeTypes.isProxy(fetchImpl))) {
    throw new TypeError("x402 buyer paid transport fetch override is invalid");
  }
  const transportPolicy = snapshotX402OutboundTransportPolicyV1(
    stableDataProperty(
      options,
      "transportPolicy",
      "x402 buyer paid transport policy",
    ).value as Readonly<X402OutboundTransportPolicy> | undefined,
  );
  if ((fetchImpl !== undefined && transportPolicy?.mode !== "insecure-test") ||
      (fetchImpl === undefined && transportPolicy?.mode === "insecure-test")) {
    throw new TypeError(
      "x402 buyer paid transport overrides require explicit insecure-test mode",
    );
  }
  const publicHttpsDependencies = snapshotDacsPublicHttpsDependenciesV1(
    stableDataProperty(
      options,
      "publicHttpsDependencies",
      "x402 buyer paid HTTPS dependencies",
    ).value as Readonly<DacsPublicHttpsDependenciesV1> | undefined,
  );
  const retainedHeaders = captureHeaders(stableDataProperty(
    options,
    "headers",
    "x402 buyer paid transport headers",
  ).value as X402BuyerHeaderInit | undefined);
  const transport: X402BuyerPaidRequestTransport = {
    async submitRetained(
      intent: Readonly<X402BuyerSettlementIntent>,
      fence: Readonly<X402BuyerEffectFence>,
    ) {
      let assertCurrent: X402BuyerEffectFence["assertCurrent"];
      let retainedIntent: Readonly<X402BuyerSettlementIntent>;
      try {
        // Rebuild the caller-owned durable record before any await. Every
        // nested value used below therefore comes from validated frozen data,
        // not from an accessor, proxy or object that can change during DNS.
        retainedIntent = x402BuyerSettlementStoreInternals.captureIntent(intent);
        // Capture and bind before requestX402OutboundV1 can enter DNS. The
        // beforeConnect callback below closes over only this exact method, so a
        // caller cannot swap fence.assertCurrent while resolution is pending.
        assertCurrent = stableBoundMethod<X402BuyerEffectFence["assertCurrent"]>(
          fence,
          "assertCurrent",
          "x402 buyer paid effect fence",
        );
      } catch {
        return {
          disposition: "indeterminate" as const,
          reason: "x402-paid-request-response-indeterminate",
        };
      }
      const headers = new Headers(retainedHeaders);
      headers.set(PAYMENT_SIGNATURE, retainedIntent.paymentHeader.value);
      let response: Awaited<ReturnType<typeof requestX402OutboundV1>>;
      try {
        response = await requestX402OutboundV1({
          url: retainedIntent.httpResource,
          headers,
          paymentHeaderMode: "require-one",
          beforeConnect: () => assertCurrent(),
          ...(fetchImpl === undefined ? {} : { fetchImpl }),
          ...(transportPolicy === undefined ? {} : { policy: transportPolicy }),
          ...(publicHttpsDependencies === undefined
            ? {}
            : { dependencies: publicHttpsDependencies }),
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
                httpResource: retainedIntent.httpResource,
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
