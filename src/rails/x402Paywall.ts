import { isDeepStrictEqual } from "node:util";

import { canonicalize, sha256Hex } from "../canonical/index.js";
import { CounterpartyError } from "../errors.js";
import {
  deriveX402ReceiptCommitment,
  verifyX402ReceiptClaim,
} from "../seller/x402Receipt.js";
import {
  x402Eip3009Nonce,
  type SellerPaymentClaim,
} from "../seller/paymentIntake.js";

/** Framework-neutral subset required by `@x402/core`'s HTTP adapter. */
export interface X402PaywallHttpAdapter {
  getHeader(name: string): string | undefined;
  getMethod(): string;
  getPath(): string;
  getUrl(): string;
  getAcceptHeader(): string;
  getUserAgent(): string;
  getQueryParams?(): Record<string, string | string[]>;
  getQueryParam?(name: string): string | string[] | undefined;
  getBody?(): unknown;
}

export interface X402PaywallPaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

export interface X402PaywallPaymentPayload {
  x402Version: number;
  resource?: Record<string, unknown>;
  accepted: X402PaywallPaymentRequirements;
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

export interface X402PaywallHttpContext {
  adapter: X402PaywallHttpAdapter;
  path: string;
  method: string;
  paymentHeader?: string;
  routePattern?: string;
}

export interface X402PaywallResponse<T = unknown> {
  status: number;
  headers: Record<string, string>;
  body?: T;
  isHtml?: boolean;
}

interface X402PaymentCancellationDispatcher {
  cancel(options: {
    reason: "handler_threw" | "handler_failed";
    error?: unknown;
    responseStatus?: number;
  }): Promise<void>;
}

export type X402PaywallProcessResult =
  | { type: "no-payment-required" }
  | {
      type: "payment-verified";
      cancellationDispatcher: X402PaymentCancellationDispatcher;
      paymentPayload: X402PaywallPaymentPayload;
      paymentRequirements: X402PaywallPaymentRequirements;
      declaredExtensions?: Record<string, unknown>;
    }
  | { type: "payment-error"; response: X402PaywallResponse };

export type X402PaywallSettlementResult =
  | {
      success: true;
      transaction: string;
      network: string;
      payer?: string;
      amount?: string;
      headers: Record<string, string>;
      requirements: X402PaywallPaymentRequirements;
      extensions?: Record<string, unknown>;
      extra?: Record<string, unknown>;
      [key: string]: unknown;
    }
  | {
      success: false;
      transaction: string;
      network: string;
      errorReason: string;
      errorMessage?: string;
      headers: Record<string, string>;
      response: X402PaywallResponse;
      [key: string]: unknown;
    };

export interface X402PaywallServerLike {
  initialize(): Promise<void>;
  processHTTPRequest(context: X402PaywallHttpContext): Promise<X402PaywallProcessResult>;
  processSettlement(
    paymentPayload: X402PaywallPaymentPayload,
    requirements: X402PaywallPaymentRequirements,
    declaredExtensions?: Record<string, unknown>,
    transportContext?: {
      request: X402PaywallHttpContext;
      responseBody?: Buffer;
      responseHeaders?: Record<string, string>;
    },
  ): Promise<X402PaywallSettlementResult>;
}

export interface X402PaywallExpectedTerms {
  network: `eip155:${string}`;
  payTo: string;
  amount: string;
  asset: string;
  eip712: { name: string; version: string };
}

export interface X402PaywallHandleInput {
  /** Exact DACS session bound into the payer-signed EIP-3009 nonce (SB-3). */
  jobId: string;
  /** Exact pay-x402 phase index recovered from the PC-2/SB-1 address. */
  phaseIndex: number;
  request: X402PaywallHttpAdapter;
}

/** Cloneable, store-retained x402 settlement intent. */
export interface X402PaywallSettlementIntent {
  intentVersion: "1";
  settlementKey: string;
  bindingHash: string;
  jobId: string;
  phaseIndex: number;
  httpResource: string;
  payer: string;
  /** Exact v2 bearer header required to resume this retained authorization. */
  paymentHeader: string;
  paymentPayload: X402PaywallPaymentPayload;
  paymentRequirements: X402PaywallPaymentRequirements;
  declaredExtensions?: Record<string, unknown>;
}

export type X402PaywallSettlementOutcome =
  | {
      status: "settled";
      settlement: X402PaywallSettlementResult & { success: true };
    }
  | {
      status: "failed";
      /**
       * A terminal, irreversible failure: reconciliation proved that the
       * retained authorization neither settled nor can still settle. A mere
       * not-found observation while the authorization remains live is pending.
       */
      reason: string;
      settlement?: X402PaywallSettlementResult & { success: false };
    };

export type X402PaywallSettlementClaim =
  | { status: "claimed" | "held"; intent: X402PaywallSettlementIntent }
  | {
      status: "settled" | "failed";
      intent: X402PaywallSettlementIntent;
      outcome: X402PaywallSettlementOutcome;
    }
  | { status: "conflict" };

export type X402PaywallSettlementLoad =
  | { status: "absent" }
  | { status: "held"; intent: X402PaywallSettlementIntent }
  | {
      status: "settled" | "failed";
      intent: X402PaywallSettlementIntent;
      outcome: X402PaywallSettlementOutcome;
    };

/**
 * Durable write-ahead store for one x402 authorization/session binding.
 * `claim` MUST atomically retain the first intent by `settlementKey`. The same
 * key with different `bindingHash` MUST return `conflict`; it must never replace
 * the retained authorization. `recordOutcome` MUST be atomic and no-overwrite.
 */
export interface X402PaywallSettlementStore {
  /** Load an existing intent before re-running provider verification. */
  load(settlementKey: string): Promise<X402PaywallSettlementLoad>;
  claim(
    intent: Readonly<X402PaywallSettlementIntent>,
  ): Promise<X402PaywallSettlementClaim>;
  recordOutcome(input: {
    settlementKey: string;
    bindingHash: string;
    outcome: Readonly<X402PaywallSettlementOutcome>;
  }): Promise<X402PaywallSettlementClaim>;
}

export type X402PaywallSettlementReconciliation =
  | { status: "pending" | "indeterminate"; reason: string }
  | X402PaywallSettlementOutcome;

export type X402PaywallPaymentAuthorization<TAuthorization = unknown> =
  | { disposition: "authorized"; authorization: TAuthorization }
  | { disposition: "rejected" | "indeterminate"; reason: string };

export interface X402PaywallAuthorizationContext {
  jobId: string;
  phaseIndex: number;
  payer: string;
  request: X402PaywallHttpAdapter;
  paymentClaim: Extract<SellerPaymentClaim, { kind: "pay-x402" }>;
  settlement: X402PaywallSettlementResult & { success: true };
}

export interface X402PaywallFulfilmentContext<TAuthorization = unknown> {
  jobId: string;
  phaseIndex: number;
  /** Stable transport key. #120 still derives its canonical fulfilment id from its retained permit. */
  idempotencyKey: string;
  payer: string;
  request: X402PaywallHttpAdapter;
  paymentPayload: Readonly<X402PaywallPaymentPayload>;
  paymentRequirements: Readonly<X402PaywallPaymentRequirements>;
  paymentClaim: Extract<SellerPaymentClaim, { kind: "pay-x402" }>;
  settlement: X402PaywallSettlementResult & { success: true };
  /** Opaque result of the mandatory post-settlement #119 authorization gate. */
  authorization: Readonly<TAuthorization>;
}

export type X402PaywallFulfilment<T = unknown> =
  | {
      disposition: "fulfilled";
      status?: number;
      headers?: Record<string, string>;
      body?: T;
    }
  | {
      disposition: "failed" | "indeterminate";
      reason: string;
      status?: number;
      headers?: Record<string, string>;
    };

export type X402PaywallResult<T = unknown> =
  | {
      disposition:
        | "payment-required"
        | "rejected"
        | "settlement-failed";
      settled: false;
      reason: string;
      response: X402PaywallResponse;
      settlement?: X402PaywallSettlementResult & { success: false };
    }
  | {
      disposition: "indeterminate";
      /** `unknown` means value may have moved and ordinary retry is forbidden. */
      settled: false | "unknown";
      reason: string;
      response: X402PaywallResponse;
      settlement?: X402PaywallSettlementResult;
    }
  | {
      disposition: "settlement-evidence-indeterminate";
      settled: true;
      reason: string;
      response: X402PaywallResponse;
      settlement: X402PaywallSettlementResult & { success: true };
    }
  | {
      disposition:
        | "authorization-rejected"
        | "authorization-indeterminate"
        | "fulfilment-failed"
        | "fulfilment-indeterminate";
      settled: true;
      reason: string;
      response: X402PaywallResponse;
      payer: string;
      paymentClaim: Extract<SellerPaymentClaim, { kind: "pay-x402" }>;
      settlement: X402PaywallSettlementResult & { success: true };
    }
  | {
      disposition: "settled";
      settled: true;
      reason: "verified-authorized-fulfilled-settled";
      response: X402PaywallResponse<T>;
      payer: string;
      paymentClaim: Extract<SellerPaymentClaim, { kind: "pay-x402" }>;
      settlement: X402PaywallSettlementResult & { success: true };
    };

export interface X402PaywallCoreDeps<TAuthorization = unknown, T = unknown> {
  server: X402PaywallServerLike;
  expected: X402PaywallExpectedTerms;
  settlementStore: X402PaywallSettlementStore;
  reconcileSettlement(
    intent: Readonly<X402PaywallSettlementIntent>,
  ): Promise<X402PaywallSettlementReconciliation>;
  /** Call #119 here. Only `authorized` may reach the delivery callback. */
  authorizePayment(
    context: Readonly<X402PaywallAuthorizationContext>,
  ): Promise<X402PaywallPaymentAuthorization<TAuthorization>>;
  /**
   * Call #120/#121 here using the authorization retained by #119's store.
   * Implementations MUST be idempotent for the supplied stable key: a client
   * may retry after settlement while delivery reconciliation is still pending.
   */
  fulfil(
    context: Readonly<X402PaywallFulfilmentContext<TAuthorization>>,
  ): Promise<X402PaywallFulfilment<T>>;
}

export interface X402PaywallFacilitatorLike {
  verify(paymentPayload: unknown, paymentRequirements: unknown): Promise<unknown>;
  settle(paymentPayload: unknown, paymentRequirements: unknown): Promise<unknown>;
  getSupported(): Promise<unknown>;
}

export interface X402PaywallConfig {
  /** x402 route pattern. DACS pay-x402 uses GET, e.g. `GET /deliver/:jobId`. */
  route: string;
  network: `eip155:${string}`;
  payTo: string;
  /** Exact integer token base units; no decimal or currency conversion occurs. */
  amount: string;
  asset: string;
  /** Required EIP-712 token domain advertised to the buyer. */
  eip712: { name: string; version: string };
  facilitator:
    | X402PaywallFacilitatorLike
    | {
        url: string;
        createAuthHeaders?: () => Promise<{
          verify: Record<string, string>;
          settle: Record<string, string>;
          supported: Record<string, string>;
          bazaar?: Record<string, string>;
        }>;
      };
  maxTimeoutSeconds?: number;
  description?: string;
  mimeType?: string;
  serviceName?: string;
  extra?: Record<string, unknown>;
}

export interface X402PaywallHandlers<TAuthorization = unknown, T = unknown> {
  settlementStore: X402PaywallSettlementStore;
  reconcileSettlement: X402PaywallCoreDeps<TAuthorization, T>["reconcileSettlement"];
  authorizePayment: X402PaywallCoreDeps<TAuthorization, T>["authorizePayment"];
  fulfil: X402PaywallCoreDeps<TAuthorization, T>["fulfil"];
}

export interface X402Paywall<T = unknown> {
  readonly terms: X402PaywallExpectedTerms;
  handle(input: X402PaywallHandleInput): Promise<X402PaywallResult<T>>;
}

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const EVM_TX_RE = /^0x[0-9a-fA-F]{64}$/;
const INTEGER_RE = /^(0|[1-9][0-9]*)$/;
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const FULFILMENT_KEY_SEPARATOR = "dacs-x402-fulfil:v1:";
const SETTLEMENT_KEY_SEPARATOR = "dacs-x402-settlement:v1:";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function validNetwork(network: string): network is `eip155:${string}` {
  const match = /^eip155:([1-9][0-9]*)$/.exec(network);
  if (!match) return false;
  const chainId = Number(match[1]);
  return Number.isSafeInteger(chainId) && chainId > 0;
}

function chainIdFromNetwork(network: string): number | null {
  if (!validNetwork(network)) return null;
  return Number(network.slice("eip155:".length));
}

function validAmount(amount: string): boolean {
  if (!INTEGER_RE.test(amount)) return false;
  try {
    return BigInt(amount) > 0n;
  } catch {
    return false;
  }
}

/** Stable transport replay key; it is not #120's authorization-bound fulfilment id. */
export function x402PaywallFulfilmentKey(input: {
  jobId: string;
  phaseIndex: number;
}): string {
  if (typeof input.jobId !== "string" || input.jobId.length === 0 ||
      !Number.isSafeInteger(input.phaseIndex) || input.phaseIndex < 0) {
    throw new TypeError("x402 paywall fulfilment key requires jobId and phaseIndex");
  }
  const digest = sha256Hex(
    `${FULFILMENT_KEY_SEPARATOR}${input.jobId.normalize("NFC")}:${input.phaseIndex}`,
  );
  return `dacs:x402-fulfil:${digest}`;
}

/** Stable key for the one durable x402 settlement intent for a DACS phase. */
export function x402PaywallSettlementKey(input: {
  jobId: string;
  phaseIndex: number;
}): string {
  if (typeof input.jobId !== "string" || input.jobId.length === 0 ||
      !Number.isSafeInteger(input.phaseIndex) || input.phaseIndex < 0) {
    throw new TypeError("x402 paywall settlement key requires jobId and phaseIndex");
  }
  const digest = sha256Hex(
    `${SETTLEMENT_KEY_SEPARATOR}${input.jobId.normalize("NFC")}:${input.phaseIndex}`,
  );
  return `dacs:x402-settlement:${digest}`;
}

function jsonResponse(status: number, reason: string): X402PaywallResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: { error: reason },
  };
}

function safeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const entries: Array<[string, string]> = [];
  const names = new Set<string>();
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (typeof value !== "string" || !HEADER_NAME_RE.test(name) || /[\r\n]/.test(value)) {
      throw new TypeError("invalid HTTP header");
    }
    const normalized = name.toLowerCase();
    if (names.has(normalized)) {
      throw new TypeError("HTTP headers contain a case-insensitive duplicate");
    }
    names.add(normalized);
    entries.push([name, value]);
  }
  return Object.fromEntries(entries);
}

function safeSettlementHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const safe = safeHeaders(headers);
  const entry = Object.entries(safe).find(
    ([name]) => name.toUpperCase() === "PAYMENT-RESPONSE",
  );
  if (!entry) {
    throw new TypeError("x402 v2 settlement must return PAYMENT-RESPONSE");
  }
  // The facilitator controls the protocol receipt, not application headers.
  return Object.fromEntries([entry]);
}

function safeProtocolResponse(response: X402PaywallResponse): X402PaywallResponse | null {
  let snapshot: X402PaywallResponse;
  try {
    snapshot = structuredClone(response);
  } catch {
    return null;
  }
  if (!isRecord(snapshot) || !Number.isInteger(snapshot.status) ||
      snapshot.status < 100 || snapshot.status > 599 || !isRecord(snapshot.headers) ||
      snapshot.isHtml !== undefined && typeof snapshot.isHtml !== "boolean") return null;
  try {
    return {
      status: snapshot.status,
      headers: safeHeaders(snapshot.headers),
      ...(snapshot.body === undefined ? {} : { body: snapshot.body }),
      ...(snapshot.isHtml === undefined ? {} : { isHtml: snapshot.isHtml }),
    };
  } catch {
    return null;
  }
}

function mergeHeaders(
  application: Record<string, string>,
  protocol: Record<string, string>,
): Record<string, string> {
  const merged = new Map<string, { name: string; value: string }>();
  for (const [name, value] of Object.entries(application)) {
    merged.set(name.toLowerCase(), { name, value });
  }
  // Protocol settlement headers always win, including case-insensitive aliases.
  for (const [name, value] of Object.entries(protocol)) {
    merged.set(name.toLowerCase(), { name, value });
  }
  return Object.fromEntries([...merged.values()].map(({ name, value }) => [name, value]));
}

function bodyBuffer(body: unknown): Buffer | undefined {
  if (body === undefined) return undefined;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof Uint8Array) return Buffer.from(body);
  try {
    return Buffer.from(JSON.stringify(body), "utf8");
  } catch {
    throw new TypeError("fulfilment body is not serializable");
  }
}

function headerValue(headers: Record<string, string>, expected: string): string | null {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toUpperCase() === expected) return value;
  }
  return null;
}

function parseAuthorization(
  payload: unknown,
): { payer: string; to: string; value: string; nonce: string } | null {
  if (!isRecord(payload) || !isRecord(payload.payload) ||
      !isRecord(payload.payload.authorization)) return null;
  const authorization = payload.payload.authorization;
  if (
    typeof authorization.from !== "string" || !EVM_ADDRESS_RE.test(authorization.from) ||
    typeof authorization.to !== "string" || !EVM_ADDRESS_RE.test(authorization.to) ||
    typeof authorization.value !== "string" || !INTEGER_RE.test(authorization.value) ||
    typeof authorization.nonce !== "string"
  ) return null;
  return {
    payer: authorization.from,
    to: authorization.to,
    value: authorization.value,
    nonce: authorization.nonce,
  };
}

function requirementsMatch(
  requirements: unknown,
  expected: X402PaywallExpectedTerms,
): boolean {
  return isRecord(requirements) && isRecord(requirements.extra) &&
    requirements.scheme === "exact" &&
    requirements.network === expected.network &&
    typeof requirements.payTo === "string" &&
    sameAddress(requirements.payTo, expected.payTo) &&
    requirements.amount === expected.amount &&
    typeof requirements.asset === "string" &&
    sameAddress(requirements.asset, expected.asset) &&
    Number.isSafeInteger(requirements.maxTimeoutSeconds) &&
    Number(requirements.maxTimeoutSeconds) > 0 &&
    requirements.extra.name === expected.eip712.name &&
    requirements.extra.version === expected.eip712.version;
}

function requirementsAgree(
  left: unknown,
  right: unknown,
): boolean {
  if (!isRecord(left) || !isRecord(right) || !isRecord(left.extra) ||
      !isRecord(right.extra) || typeof left.payTo !== "string" ||
      typeof right.payTo !== "string" || typeof left.asset !== "string" ||
      typeof right.asset !== "string") return false;
  let sameExtra: boolean;
  try {
    sameExtra = canonicalize(left.extra) === canonicalize(right.extra);
  } catch {
    return false;
  }
  return left.scheme === right.scheme && left.network === right.network &&
    sameAddress(left.payTo, right.payTo) && left.amount === right.amount &&
    sameAddress(left.asset, right.asset) &&
    left.maxTimeoutSeconds === right.maxTimeoutSeconds &&
    sameExtra;
}

async function cancel(
  dispatcher: X402PaymentCancellationDispatcher,
  options: Parameters<X402PaymentCancellationDispatcher["cancel"]>[0],
): Promise<void> {
  try {
    await dispatcher.cancel(options);
  } catch {
    // Cancellation is notification-only. Failure must not turn a rejected or
    // failed handler into authorization to settle.
  }
}

interface X402PaywallRequestSnapshot {
  jobId: string;
  phaseIndex: number;
  request: X402PaywallHttpAdapter;
  context: X402PaywallHttpContext;
  httpResource: string;
}

function snapshotCoreInputUnsafe(
  input: X402PaywallHandleInput,
  expected: X402PaywallExpectedTerms,
): { snapshot?: X402PaywallRequestSnapshot; reason?: string } {
  if (typeof input.jobId !== "string" || input.jobId.length === 0) {
    return { reason: "invalid-jobId" };
  }
  if (!Number.isSafeInteger(input.phaseIndex) || input.phaseIndex < 0) {
    return { reason: "invalid-phaseIndex" };
  }
  const source = input.request;
  if (!source || typeof source.getHeader !== "function" ||
      typeof source.getMethod !== "function" ||
      typeof source.getPath !== "function" ||
      typeof source.getUrl !== "function" ||
      typeof source.getAcceptHeader !== "function" ||
      typeof source.getUserAgent !== "function") {
    return { reason: "invalid-http-adapter" };
  }
  if (!validNetwork(expected.network) || !EVM_ADDRESS_RE.test(expected.payTo) ||
      !EVM_ADDRESS_RE.test(expected.asset) || !validAmount(expected.amount) ||
      !expected.eip712 || typeof expected.eip712.name !== "string" ||
      expected.eip712.name.length === 0 || typeof expected.eip712.version !== "string" ||
      expected.eip712.version.length === 0) {
    return { reason: "invalid-paywall-terms" };
  }

  try {
    // Invoke the security-bearing getters exactly once. The server and every
    // downstream callback receive this stable adapter, never the mutable source.
    const method = source.getMethod();
    const path = source.getPath();
    const httpResource = source.getUrl();
    const acceptHeader = source.getAcceptHeader();
    const userAgent = source.getUserAgent();
    if (method !== "GET") return { reason: "pay-x402-requires-get" };
    if (typeof path !== "string" || path.length === 0 || path[0] !== "/" ||
        typeof httpResource !== "string" || typeof acceptHeader !== "string" ||
        typeof userAgent !== "string") return { reason: "invalid-http-adapter" };
    const resource = new URL(httpResource);
    if (resource.protocol !== "https:" || resource.username || resource.password ||
        resource.hash || resource.pathname !== path) {
      return { reason: "invalid-http-resource" };
    }

    const queryParams = source.getQueryParams
      ? structuredClone(source.getQueryParams())
      : undefined;
    const body = source.getBody ? structuredClone(source.getBody()) : undefined;
    const headerCache = new Map<string, string | undefined>();
    // These are the only x402 v1/v2 authorization headers. Snapshot both at
    // entry so a mutable host request cannot swap authorization mid-flight.
    for (const name of ["PAYMENT-SIGNATURE", "X-PAYMENT"]) {
      headerCache.set(name.toLowerCase(), source.getHeader(name));
    }
    const queryCache = new Map<string, string | string[] | undefined>();
    const request: X402PaywallHttpAdapter = Object.freeze({
      getHeader(name: string) {
        const normalized = name.toLowerCase();
        if (!headerCache.has(normalized)) {
          headerCache.set(normalized, source.getHeader(name));
        }
        return headerCache.get(normalized);
      },
      getMethod: () => method,
      getPath: () => path,
      getUrl: () => httpResource,
      getAcceptHeader: () => acceptHeader,
      getUserAgent: () => userAgent,
      ...(queryParams === undefined
        ? {}
        : { getQueryParams: () => structuredClone(queryParams) }),
      ...(source.getQueryParam === undefined
        ? {}
        : {
            getQueryParam(name: string) {
              if (queryParams !== undefined && Object.prototype.hasOwnProperty.call(queryParams, name)) {
                return structuredClone(queryParams[name]);
              }
              if (!queryCache.has(name)) {
                queryCache.set(name, structuredClone(source.getQueryParam!(name)));
              }
              return structuredClone(queryCache.get(name));
            },
          }),
      ...(source.getBody === undefined
        ? {}
        : { getBody: () => structuredClone(body) }),
    });
    const context: X402PaywallHttpContext = Object.freeze({
      adapter: request,
      path,
      method,
    });
    return {
      snapshot: {
        jobId: input.jobId,
        phaseIndex: input.phaseIndex,
        request,
        context,
        httpResource,
      },
    };
  } catch {
    return { reason: "invalid-http-adapter" };
  }
}

function snapshotCoreInput(
  input: X402PaywallHandleInput,
  expected: X402PaywallExpectedTerms,
): { snapshot?: X402PaywallRequestSnapshot; reason?: string } {
  try {
    return snapshotCoreInputUnsafe(input, expected);
  } catch {
    return { reason: "invalid-http-adapter" };
  }
}

function settlementClaim(
  result: X402PaywallSettlementResult & { success: true },
  expected: X402PaywallExpectedTerms,
  payer: string,
  httpResource: string,
): Extract<SellerPaymentClaim, { kind: "pay-x402" }> | null {
  const chainId = chainIdFromNetwork(expected.network);
  if (chainId === null || result.network !== expected.network ||
      !EVM_TX_RE.test(result.transaction) ||
      !requirementsMatch(result.requirements, expected) ||
      typeof result.payer !== "string" || !sameAddress(result.payer, payer) ||
      result.amount !== undefined && result.amount !== expected.amount) return null;

  const value = headerValue(result.headers, "PAYMENT-RESPONSE");
  if (!value) return null;
  const responseHeader = { name: "PAYMENT-RESPONSE", value };
  const commitment = deriveX402ReceiptCommitment({
    protocolVersion: "2",
    responseHeader,
  });
  if (commitment.disposition !== "pass" ||
      !commitment.computedPaymentReceiptHash || !commitment.receipt) return null;
  if (typeof commitment.receipt.payer !== "string" ||
      !sameAddress(commitment.receipt.payer, payer)) return null;
  if (commitment.receipt.amount !== undefined &&
      String(commitment.receipt.amount) !== expected.amount) return null;

  const verified = verifyX402ReceiptClaim({
    protocolVersion: "2",
    responseHeader,
    evidence: {
      paymentReceiptHash: commitment.computedPaymentReceiptHash,
      settlementTxHash: result.transaction,
      chainId,
    },
  });
  if (verified.disposition !== "pass") return null;

  return {
    kind: "pay-x402",
    protocolVersion: "2",
    responseHeader,
    httpResource,
    paymentReceiptHash: commitment.computedPaymentReceiptHash,
    settlementTxHash: result.transaction,
    chainId,
  };
}

function exactData(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function ownedFrozen<T>(value: T): Readonly<T> | null {
  try {
    return deepFreeze(structuredClone(value));
  } catch {
    return null;
  }
}

function settlementIntent(
  snapshot: X402PaywallRequestSnapshot,
  payer: string,
  paymentHeader: string,
  paymentPayload: X402PaywallPaymentPayload,
  paymentRequirements: X402PaywallPaymentRequirements,
  declaredExtensions?: Record<string, unknown>,
): X402PaywallSettlementIntent | null {
  try {
    const core = {
      intentVersion: "1" as const,
      settlementKey: x402PaywallSettlementKey(snapshot),
      jobId: snapshot.jobId,
      phaseIndex: snapshot.phaseIndex,
      httpResource: snapshot.httpResource,
      payer,
      paymentHeader,
      paymentPayload: structuredClone(paymentPayload),
      paymentRequirements: structuredClone(paymentRequirements),
      ...(declaredExtensions === undefined
        ? {}
        : { declaredExtensions: structuredClone(declaredExtensions) }),
    };
    const bindingHash = sha256Hex(canonicalize(core));
    return { ...core, bindingHash };
  } catch {
    return null;
  }
}

function isSettlementIntent(value: unknown): value is X402PaywallSettlementIntent {
  if (!isRecord(value) || value.intentVersion !== "1" ||
      typeof value.settlementKey !== "string" ||
      typeof value.bindingHash !== "string" || !/^[0-9a-f]{64}$/.test(value.bindingHash) ||
      typeof value.jobId !== "string" || value.jobId.length === 0 ||
      !Number.isSafeInteger(value.phaseIndex) || Number(value.phaseIndex) < 0 ||
      typeof value.httpResource !== "string" ||
      typeof value.payer !== "string" || !EVM_ADDRESS_RE.test(value.payer) ||
      typeof value.paymentHeader !== "string" || value.paymentHeader.length === 0 ||
      !isRecord(value.paymentPayload) || !isRecord(value.paymentRequirements) ||
      value.declaredExtensions !== undefined && !isRecord(value.declaredExtensions)) {
    return false;
  }
  const allowed = [
    "intentVersion",
    "settlementKey",
    "bindingHash",
    "jobId",
    "phaseIndex",
    "httpResource",
    "payer",
    "paymentHeader",
    "paymentPayload",
    "paymentRequirements",
    "declaredExtensions",
  ];
  if (!Object.keys(value).every((key) => allowed.includes(key))) return false;
  let expectedKey: string;
  try {
    expectedKey = x402PaywallSettlementKey({
      jobId: value.jobId,
      phaseIndex: Number(value.phaseIndex),
    });
    const core = {
      intentVersion: "1",
      settlementKey: value.settlementKey,
      jobId: value.jobId,
      phaseIndex: value.phaseIndex,
      httpResource: value.httpResource,
      payer: value.payer,
      paymentHeader: value.paymentHeader,
      paymentPayload: value.paymentPayload,
      paymentRequirements: value.paymentRequirements,
      ...(value.declaredExtensions === undefined
        ? {}
        : { declaredExtensions: value.declaredExtensions }),
    };
    return value.settlementKey === expectedKey &&
      sha256Hex(canonicalize(core)) === value.bindingHash;
  } catch {
    return false;
  }
}

function presentedPaymentPayload(request: X402PaywallHttpAdapter): unknown | null {
  const encoded = request.getHeader("PAYMENT-SIGNATURE");
  if (typeof encoded !== "string" || encoded.length === 0 || /\s/.test(encoded) ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) return null;
  try {
    const decoded = Buffer.from(encoded, "base64");
    const supplied = encoded.replace(/=+$/, "");
    if (decoded.toString("base64").replace(/=+$/, "") !== supplied) return null;
    const json = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

function snapshotProcessResult(value: unknown): X402PaywallProcessResult | null {
  if (!isRecord(value)) return null;
  try {
    if (value.type === "no-payment-required") {
      return { type: "no-payment-required" };
    }
    if (value.type === "payment-error") {
      const response = safeProtocolResponse(value.response as X402PaywallResponse);
      return response ? { type: "payment-error", response } : null;
    }
    if (value.type !== "payment-verified" ||
        !isRecord(value.cancellationDispatcher) ||
        typeof value.cancellationDispatcher.cancel !== "function" ||
        value.declaredExtensions !== undefined && !isRecord(value.declaredExtensions)) {
      return null;
    }
    const dispatcher = value.cancellationDispatcher;
    const cancelMethod = dispatcher.cancel as X402PaymentCancellationDispatcher["cancel"];
    return {
      type: "payment-verified",
      cancellationDispatcher: {
        cancel: (options) => Promise.resolve(cancelMethod.call(dispatcher, options)),
      },
      paymentPayload: structuredClone(value.paymentPayload) as X402PaywallPaymentPayload,
      paymentRequirements: structuredClone(
        value.paymentRequirements,
      ) as X402PaywallPaymentRequirements,
      ...(value.declaredExtensions === undefined
        ? {}
        : { declaredExtensions: structuredClone(value.declaredExtensions) }),
    };
  } catch {
    return null;
  }
}

function isSettlementOutcome(value: unknown): value is X402PaywallSettlementOutcome {
  if (!isRecord(value) || !["settled", "failed"].includes(String(value.status))) {
    return false;
  }
  if (value.status === "settled") {
    return isRecord(value.settlement) && value.settlement.success === true;
  }
  return typeof value.reason === "string" && value.reason.length > 0 &&
    (value.settlement === undefined ||
      isRecord(value.settlement) && value.settlement.success === false);
}

function validStoredClaim(
  value: unknown,
  intent: X402PaywallSettlementIntent,
): value is X402PaywallSettlementClaim {
  if (!isRecord(value) || ![
    "claimed",
    "held",
    "settled",
    "failed",
    "conflict",
  ].includes(String(value.status))) return false;
  if (value.status === "conflict") return Object.keys(value).length === 1;
  if (!isSettlementIntent(value.intent) || !exactData(value.intent, intent)) return false;
  if (value.status === "claimed" || value.status === "held") {
    return value.outcome === undefined;
  }
  return isSettlementOutcome(value.outcome) && value.outcome.status === value.status;
}

function validSettlementLoad(value: unknown): value is X402PaywallSettlementLoad {
  if (!isRecord(value) || !["absent", "held", "settled", "failed"].includes(
    String(value.status),
  )) return false;
  if (value.status === "absent") return Object.keys(value).length === 1;
  if (!isSettlementIntent(value.intent)) return false;
  if (value.status === "held") return value.outcome === undefined;
  return isSettlementOutcome(value.outcome) && value.outcome.status === value.status;
}

async function persistSettlementOutcome(
  store: X402PaywallSettlementStore,
  intent: X402PaywallSettlementIntent,
  outcome: X402PaywallSettlementOutcome,
): Promise<X402PaywallSettlementOutcome | null> {
  const frozenOutcome = ownedFrozen(outcome);
  if (!frozenOutcome) return null;
  let recorded: X402PaywallSettlementClaim;
  try {
    const raw = await store.recordOutcome({
      settlementKey: intent.settlementKey,
      bindingHash: intent.bindingHash,
      outcome: frozenOutcome,
    });
    const snapshot = ownedFrozen(raw);
    if (!snapshot) return null;
    recorded = structuredClone(snapshot);
  } catch {
    return null;
  }
  if (!validStoredClaim(recorded, intent) ||
      (recorded.status !== "settled" && recorded.status !== "failed") ||
      !exactData(recorded.outcome, outcome)) return null;
  return structuredClone(recorded.outcome);
}

function postSettlementError(
  status: number,
  reason: string,
  protocolHeaders: Record<string, string>,
): X402PaywallResponse {
  return {
    status,
    headers: mergeHeaders({ "content-type": "application/json" }, protocolHeaders),
    body: { error: reason },
  };
}

/**
 * DACS seller sequence: verify the payer authorization, atomically retain its
 * SB-3-bound settlement intent, settle or reconcile that exact intent, verify
 * the receipt, run the normative payment/finality gate, then and only then run
 * durable fulfilment. No delivery callback runs under a pre-settlement key.
 */
export async function x402PaywallCore<TAuthorization = unknown, T = unknown>(
  input: X402PaywallHandleInput,
  deps: X402PaywallCoreDeps<TAuthorization, T>,
): Promise<X402PaywallResult<T>> {
  let captured: X402PaywallCoreDeps<TAuthorization, T>;
  try {
    const server = deps?.server;
    const store = deps?.settlementStore;
    const expected = deps?.expected ? ownedFrozen(deps.expected) : null;
    const processHTTPRequest = server?.processHTTPRequest;
    const processSettlement = server?.processSettlement;
    const load = store?.load;
    const claim = store?.claim;
    const recordOutcome = store?.recordOutcome;
    const reconcileSettlement = deps?.reconcileSettlement;
    const authorizePayment = deps?.authorizePayment;
    const fulfil = deps?.fulfil;
    if (!server || typeof processHTTPRequest !== "function" ||
        typeof processSettlement !== "function" || !expected || !store ||
        typeof load !== "function" || typeof claim !== "function" ||
        typeof recordOutcome !== "function" ||
        typeof reconcileSettlement !== "function" ||
        typeof authorizePayment !== "function" || typeof fulfil !== "function") {
      throw new TypeError("invalid paywall dependencies");
    }
    captured = {
      server: Object.freeze({
        initialize: async () => undefined,
        processHTTPRequest: processHTTPRequest.bind(server),
        processSettlement: processSettlement.bind(server),
      }),
      expected,
      settlementStore: Object.freeze({
        load: load.bind(store),
        claim: claim.bind(store),
        recordOutcome: recordOutcome.bind(store),
      }),
      reconcileSettlement: reconcileSettlement.bind(deps),
      authorizePayment: authorizePayment.bind(deps),
      fulfil: fulfil.bind(deps),
    };
  } catch {
    return {
      disposition: "rejected",
      settled: false,
      reason: "invalid-paywall-dependencies",
      response: jsonResponse(500, "invalid-paywall-dependencies"),
    };
  }

  const inputSnapshot = snapshotCoreInput(input, captured.expected);
  if (!inputSnapshot.snapshot) {
    const reason = inputSnapshot.reason ?? "invalid-http-adapter";
    return {
      disposition: "rejected",
      settled: false,
      reason,
      response: reason === "pay-x402-requires-get"
        ? {
            status: 405,
            headers: { "content-type": "application/json", allow: "GET" },
            body: { error: reason },
          }
        : jsonResponse(400, reason),
    };
  }
  const snapshot = inputSnapshot.snapshot;

  let loaded: X402PaywallSettlementLoad;
  try {
    const raw = await captured.settlementStore.load(x402PaywallSettlementKey(snapshot));
    const owned = ownedFrozen(raw);
    if (!owned) throw new TypeError("settlement load is not cloneable");
    loaded = structuredClone(owned);
  } catch {
    return {
      disposition: "indeterminate",
      settled: "unknown",
      reason: "settlement-store-result-indeterminate",
      response: jsonResponse(503, "settlement-store-result-indeterminate"),
    };
  }
  if (!validSettlementLoad(loaded)) {
    return {
      disposition: "indeterminate",
      settled: "unknown",
      reason: "settlement-store-invalid-result",
      response: jsonResponse(503, "settlement-store-invalid-result"),
    };
  }

  let processed: X402PaywallProcessResult;
  const presentedHeader = snapshot.request.getHeader("PAYMENT-SIGNATURE");
  const presented = loaded.status === "absent"
    ? null
    : presentedPaymentPayload(snapshot.request);
  const recoverRetained = loaded.status !== "absent" &&
    loaded.intent.jobId === snapshot.jobId &&
    loaded.intent.phaseIndex === snapshot.phaseIndex &&
    loaded.intent.httpResource === snapshot.httpResource &&
    presentedHeader === loaded.intent.paymentHeader &&
    isDeepStrictEqual(presented, loaded.intent.paymentPayload);
  if (recoverRetained && loaded.status !== "absent") {
    // A provider may reject a settled EIP-3009 nonce on replay. Possession of
    // the byte-equivalent retained authorization resumes the already-verified
    // intent without asking the provider to verify or settle it again.
    processed = {
      type: "payment-verified",
      cancellationDispatcher: { cancel: async () => undefined },
      paymentPayload: structuredClone(loaded.intent.paymentPayload),
      paymentRequirements: structuredClone(loaded.intent.paymentRequirements),
      ...(loaded.intent.declaredExtensions === undefined
        ? {}
        : { declaredExtensions: structuredClone(loaded.intent.declaredExtensions) }),
    };
  } else {
    try {
      processed = await captured.server.processHTTPRequest(snapshot.context);
    } catch {
      return {
        disposition: "indeterminate",
        settled: false,
        reason: "payment-verification-unavailable",
        response: jsonResponse(503, "payment-verification-unavailable"),
      };
    }
  }
  const ownedProcessResult = snapshotProcessResult(processed);
  if (!ownedProcessResult) {
    return {
      disposition: "indeterminate",
      settled: false,
      reason: "invalid-payment-protocol-response",
      response: jsonResponse(502, "invalid-payment-protocol-response"),
    };
  }
  processed = ownedProcessResult;
  if (!isRecord(processed) ||
      !["no-payment-required", "payment-verified", "payment-error"].includes(
        String(processed.type),
      )) {
    return {
      disposition: "indeterminate",
      settled: false,
      reason: "invalid-payment-protocol-response",
      response: jsonResponse(502, "invalid-payment-protocol-response"),
    };
  }
  if (processed.type === "payment-error") {
    const response = safeProtocolResponse(processed.response);
    if (!response) {
      return {
        disposition: "indeterminate",
        settled: false,
        reason: "invalid-payment-protocol-response",
        response: jsonResponse(502, "invalid-payment-protocol-response"),
      };
    }
    return {
      disposition: response.status === 402 ? "payment-required" : "rejected",
      settled: false,
      reason: response.status === 402 ? "payment-required" : "payment-rejected",
      response,
    };
  }
  if (processed.type === "no-payment-required") {
    return {
      disposition: "rejected",
      settled: false,
      reason: "configured-route-was-not-protected",
      response: jsonResponse(500, "configured-route-was-not-protected"),
    };
  }

  const { paymentPayload, paymentRequirements, cancellationDispatcher } = processed;
  const authorization = parseAuthorization(paymentPayload);
  const accepted = isRecord(paymentPayload) ? paymentPayload.accepted : undefined;
  const paymentHeader = snapshot.request.getHeader("PAYMENT-SIGNATURE");
  const presentedPayload = presentedPaymentPayload(snapshot.request);
  const expectedNonce = x402Eip3009Nonce(snapshot.jobId, snapshot.phaseIndex);
  if (
    !cancellationDispatcher || typeof cancellationDispatcher.cancel !== "function" ||
    !isRecord(paymentPayload) || paymentPayload.x402Version !== 2 || !authorization ||
    typeof paymentHeader !== "string" || paymentHeader.length === 0 ||
    !isDeepStrictEqual(presentedPayload, paymentPayload) ||
    !requirementsMatch(accepted, captured.expected) ||
    !requirementsMatch(paymentRequirements, captured.expected) ||
    !requirementsAgree(accepted, paymentRequirements) ||
    !sameAddress(authorization.to, captured.expected.payTo) ||
    authorization.value !== captured.expected.amount ||
    authorization.nonce !== expectedNonce
  ) {
    if (cancellationDispatcher && typeof cancellationDispatcher.cancel === "function") {
      await cancel(cancellationDispatcher, {
        reason: "handler_failed",
        responseStatus: 403,
      });
    }
    return {
      disposition: "rejected",
      settled: false,
      reason: "payment-session-or-terms-mismatch",
      response: jsonResponse(403, "payment-session-or-terms-mismatch"),
    };
  }

  const intent = settlementIntent(
    snapshot,
    authorization.payer,
    paymentHeader,
    paymentPayload,
    paymentRequirements,
    processed.declaredExtensions,
  );
  const frozenIntent = intent && ownedFrozen(intent);
  if (!intent || !frozenIntent) {
    await cancel(cancellationDispatcher, {
      reason: "handler_failed",
      responseStatus: 502,
    });
    return {
      disposition: "indeterminate",
      settled: false,
      reason: "invalid-payment-protocol-response",
      response: jsonResponse(502, "invalid-payment-protocol-response"),
    };
  }

  let stored: X402PaywallSettlementClaim;
  if (recoverRetained && loaded.status !== "absent") {
    if (!exactData(loaded.intent, intent)) {
      return {
        disposition: "indeterminate",
        settled: "unknown",
        reason: "settlement-store-invalid-result",
        response: jsonResponse(503, "settlement-store-invalid-result"),
      };
    }
    stored = loaded.status === "held"
      ? { status: "held", intent: structuredClone(loaded.intent) }
      : {
          status: loaded.status,
          intent: structuredClone(loaded.intent),
          outcome: structuredClone(loaded.outcome),
        };
  } else {
    try {
      const raw = await captured.settlementStore.claim(frozenIntent);
      const owned = ownedFrozen(raw);
      if (!owned) throw new TypeError("settlement claim is not cloneable");
      stored = structuredClone(owned);
    } catch {
      return {
        disposition: "indeterminate",
        settled: "unknown",
        reason: "settlement-store-result-indeterminate",
        response: jsonResponse(503, "settlement-store-result-indeterminate"),
      };
    }
  }
  if (!validStoredClaim(stored, intent)) {
    return {
      disposition: "indeterminate",
      settled: "unknown",
      reason: "settlement-store-invalid-result",
      response: jsonResponse(503, "settlement-store-invalid-result"),
    };
  }
  if (stored.status === "conflict") {
    return {
      disposition: "rejected",
      settled: false,
      reason: "settlement-authorization-conflict",
      response: jsonResponse(409, "settlement-authorization-conflict"),
    };
  }

  let outcome: X402PaywallSettlementOutcome | undefined;
  let mustPersist = false;
  let ambiguousSettlement: X402PaywallSettlementResult | undefined;
  let requireReconciliation = stored.status === "held";
  if (stored.status === "settled" || stored.status === "failed") {
    outcome = structuredClone(stored.outcome);
  } else if (stored.status === "claimed") {
    try {
      const result = await captured.server.processSettlement(
        frozenIntent.paymentPayload as X402PaywallPaymentPayload,
        frozenIntent.paymentRequirements as X402PaywallPaymentRequirements,
        frozenIntent.declaredExtensions as Record<string, unknown> | undefined,
        { request: snapshot.context },
      );
      const owned = ownedFrozen(result);
      if (owned && isRecord(owned) && owned.success === true) {
        outcome = {
          status: "settled",
          settlement: owned as X402PaywallSettlementResult & { success: true },
        };
        mustPersist = true;
      } else {
        if (owned && isRecord(owned) && owned.success === false) {
          ambiguousSettlement = owned as X402PaywallSettlementResult & { success: false };
        }
        requireReconciliation = true;
      }
    } catch {
      requireReconciliation = true;
    }
  }

  if (!outcome && requireReconciliation) {
    let reconciled: X402PaywallSettlementReconciliation;
    try {
      reconciled = await captured.reconcileSettlement(frozenIntent);
    } catch {
      return {
        disposition: "indeterminate",
        settled: "unknown",
        reason: "settlement-reconciliation-unavailable",
        response: jsonResponse(503, "settlement-reconciliation-unavailable"),
        ...(ambiguousSettlement === undefined ? {} : { settlement: ambiguousSettlement }),
      };
    }
    const owned = ownedFrozen(reconciled);
    if (!owned || !isRecord(owned) ||
        !["pending", "indeterminate", "settled", "failed"].includes(
          String(owned.status),
        )) {
      return {
        disposition: "indeterminate",
        settled: "unknown",
        reason: "settlement-reconciliation-invalid-result",
        response: jsonResponse(503, "settlement-reconciliation-invalid-result"),
        ...(ambiguousSettlement === undefined ? {} : { settlement: ambiguousSettlement }),
      };
    }
    if (owned.status === "pending" || owned.status === "indeterminate") {
      const reason = typeof owned.reason === "string" && owned.reason.length > 0
        ? owned.reason
        : "settlement-reconciliation-indeterminate";
      return {
        disposition: "indeterminate",
        settled: "unknown",
        reason,
        response: jsonResponse(503, reason),
        ...(ambiguousSettlement === undefined ? {} : { settlement: ambiguousSettlement }),
      };
    }
    if (!isSettlementOutcome(owned)) {
      return {
        disposition: "indeterminate",
        settled: "unknown",
        reason: "settlement-reconciliation-invalid-result",
        response: jsonResponse(503, "settlement-reconciliation-invalid-result"),
        ...(ambiguousSettlement === undefined ? {} : { settlement: ambiguousSettlement }),
      };
    }
    outcome = structuredClone(owned);
    mustPersist = true;
  }

  if (!outcome) {
    return {
      disposition: "indeterminate",
      settled: "unknown",
      reason: "settlement-result-indeterminate",
      response: jsonResponse(503, "settlement-result-indeterminate"),
      ...(ambiguousSettlement === undefined ? {} : { settlement: ambiguousSettlement }),
    };
  }
  if (mustPersist) {
    const persisted = await persistSettlementOutcome(
      captured.settlementStore,
      intent,
      outcome,
    );
    if (!persisted) {
      let response = jsonResponse(503, "settlement-outcome-persistence-indeterminate");
      if (outcome.status === "settled") {
        try {
          response = postSettlementError(
            503,
            "settlement-outcome-persistence-indeterminate",
            safeSettlementHeaders(outcome.settlement.headers),
          );
        } catch {
          // The settlement result itself is retained below for reconciliation.
        }
      }
      return {
        disposition: "indeterminate",
        settled: "unknown",
        reason: "settlement-outcome-persistence-indeterminate",
        response,
        settlement: outcome.status === "settled"
          ? outcome.settlement
          : outcome.settlement ?? ambiguousSettlement,
      };
    }
    outcome = persisted;
  }

  if (outcome.status === "failed") {
    const response = outcome.settlement
      ? safeProtocolResponse(outcome.settlement.response)
      : null;
    return {
      disposition: "settlement-failed",
      settled: false,
      reason: outcome.reason,
      response: response ?? jsonResponse(402, outcome.reason),
      ...(outcome.settlement === undefined ? {} : { settlement: outcome.settlement }),
    };
  }

  const settlement = outcome.settlement;
  let protocolHeaders: Record<string, string>;
  try {
    protocolHeaders = safeSettlementHeaders(settlement.headers);
  } catch {
    return {
      disposition: "settlement-evidence-indeterminate",
      settled: true,
      reason: "invalid-settlement-protocol-response",
      response: jsonResponse(503, "invalid-settlement-protocol-response"),
      settlement,
    };
  }
  const safeSettlement = { ...settlement, headers: protocolHeaders };
  const paymentClaim = settlementClaim(
    safeSettlement,
    captured.expected,
    authorization.payer,
    snapshot.httpResource,
  );
  if (!paymentClaim) {
    return {
      disposition: "settlement-evidence-indeterminate",
      settled: true,
      reason: "settled-receipt-is-not-dacs-verifiable",
      response: postSettlementError(
        503,
        "settled-receipt-is-not-dacs-verifiable",
        protocolHeaders,
      ),
      settlement,
    };
  }

  const paymentClaimForCallback = ownedFrozen(paymentClaim);
  const settlementForCallback = ownedFrozen(safeSettlement);
  if (!paymentClaimForCallback || !settlementForCallback) {
    return {
      disposition: "settlement-evidence-indeterminate",
      settled: true,
      reason: "settlement-evidence-snapshot-failed",
      response: postSettlementError(503, "settlement-evidence-snapshot-failed", protocolHeaders),
      settlement,
    };
  }

  let paymentAuthorization: X402PaywallPaymentAuthorization<TAuthorization>;
  try {
    paymentAuthorization = await captured.authorizePayment(Object.freeze({
      jobId: snapshot.jobId,
      phaseIndex: snapshot.phaseIndex,
      payer: authorization.payer,
      request: snapshot.request,
      paymentClaim: paymentClaimForCallback,
      settlement: settlementForCallback,
    }));
  } catch {
    return {
      disposition: "authorization-indeterminate",
      settled: true,
      reason: "payment-authorization-unavailable",
      response: postSettlementError(503, "payment-authorization-unavailable", protocolHeaders),
      payer: authorization.payer,
      paymentClaim,
      settlement,
    };
  }
  const authorizationResult = ownedFrozen(paymentAuthorization);
  if (!authorizationResult || !isRecord(authorizationResult) ||
      !["authorized", "rejected", "indeterminate"].includes(
        String(authorizationResult.disposition),
      ) ||
      authorizationResult.disposition === "authorized" &&
        authorizationResult.authorization === undefined ||
      authorizationResult.disposition !== "authorized" &&
        (typeof authorizationResult.reason !== "string" ||
          authorizationResult.reason.length === 0)) {
    return {
      disposition: "authorization-indeterminate",
      settled: true,
      reason: "payment-authorization-invalid-result",
      response: postSettlementError(503, "payment-authorization-invalid-result", protocolHeaders),
      payer: authorization.payer,
      paymentClaim,
      settlement,
    };
  }
  if (authorizationResult.disposition !== "authorized") {
    const rejected = authorizationResult.disposition === "rejected";
    return {
      disposition: rejected ? "authorization-rejected" : "authorization-indeterminate",
      settled: true,
      reason: authorizationResult.reason,
      response: postSettlementError(
        rejected ? 403 : 503,
        authorizationResult.reason,
        protocolHeaders,
      ),
      payer: authorization.payer,
      paymentClaim,
      settlement,
    };
  }

  const paymentClaimForFulfilment = ownedFrozen(paymentClaim);
  const settlementForFulfilment = ownedFrozen(safeSettlement);
  if (!paymentClaimForFulfilment || !settlementForFulfilment) {
    return {
      disposition: "fulfilment-indeterminate",
      settled: true,
      reason: "fulfilment-input-snapshot-failed",
      response: postSettlementError(503, "fulfilment-input-snapshot-failed", protocolHeaders),
      payer: authorization.payer,
      paymentClaim,
      settlement,
    };
  }

  let fulfilmentResult: X402PaywallFulfilment<T>;
  try {
    fulfilmentResult = await captured.fulfil(Object.freeze({
      jobId: snapshot.jobId,
      phaseIndex: snapshot.phaseIndex,
      idempotencyKey: x402PaywallFulfilmentKey(snapshot),
      payer: authorization.payer,
      request: snapshot.request,
      paymentPayload: deepFreeze(structuredClone(intent.paymentPayload)),
      paymentRequirements: deepFreeze(structuredClone(intent.paymentRequirements)),
      paymentClaim: paymentClaimForFulfilment,
      settlement: settlementForFulfilment,
      authorization: authorizationResult.authorization as Readonly<TAuthorization>,
    }));
  } catch {
    return {
      disposition: "fulfilment-indeterminate",
      settled: true,
      reason: "fulfilment-result-indeterminate",
      response: postSettlementError(503, "fulfilment-result-indeterminate", protocolHeaders),
      payer: authorization.payer,
      paymentClaim,
      settlement,
    };
  }
  const fulfilment = ownedFrozen(fulfilmentResult);
  if (!fulfilment || !isRecord(fulfilment) ||
      !["fulfilled", "failed", "indeterminate"].includes(String(fulfilment.disposition))) {
    return {
      disposition: "fulfilment-indeterminate",
      settled: true,
      reason: "invalid-fulfilment-response",
      response: postSettlementError(503, "invalid-fulfilment-response", protocolHeaders),
      payer: authorization.payer,
      paymentClaim,
      settlement,
    };
  }
  if (fulfilment.disposition !== "fulfilled") {
    const reason = typeof fulfilment.reason === "string" && fulfilment.reason.length > 0
      ? fulfilment.reason
      : "invalid-fulfilment-response";
    const failed = fulfilment.disposition === "failed";
    const status = Number.isInteger(fulfilment.status) &&
      Number(fulfilment.status) >= 400 && Number(fulfilment.status) <= 599
      ? Number(fulfilment.status)
      : failed ? 500 : 503;
    let headers: Record<string, string> = {};
    try {
      headers = safeHeaders(fulfilment.headers as Record<string, string> | undefined);
    } catch {
      // Error metadata is non-authoritative. The settlement receipt still wins.
    }
    return {
      disposition: failed ? "fulfilment-failed" : "fulfilment-indeterminate",
      settled: true,
      reason,
      response: {
        status,
        headers: mergeHeaders(
          { "content-type": "application/json", ...headers },
          protocolHeaders,
        ),
        body: { error: reason },
      },
      payer: authorization.payer,
      paymentClaim,
      settlement,
    };
  }

  const status = fulfilment.status ?? 200;
  let applicationHeaders: Record<string, string>;
  try {
    if (!Number.isInteger(status) || status < 200 || status >= 300) {
      throw new TypeError("fulfilled response must have a 2xx status");
    }
    applicationHeaders = safeHeaders(fulfilment.headers);
    bodyBuffer(fulfilment.body);
  } catch {
    return {
      disposition: "fulfilment-indeterminate",
      settled: true,
      reason: "invalid-fulfilment-response",
      response: postSettlementError(503, "invalid-fulfilment-response", protocolHeaders),
      payer: authorization.payer,
      paymentClaim,
      settlement,
    };
  }

  return {
    disposition: "settled",
    settled: true,
    reason: "verified-authorized-fulfilled-settled",
    response: {
      status,
      headers: mergeHeaders(applicationHeaders, protocolHeaders),
      body: fulfilment.body,
    },
    payer: authorization.payer,
    paymentClaim,
    settlement,
  };
}

function isFacilitator(value: X402PaywallConfig["facilitator"]): value is X402PaywallFacilitatorLike {
  return typeof (value as X402PaywallFacilitatorLike).verify === "function" &&
    typeof (value as X402PaywallFacilitatorLike).settle === "function" &&
    typeof (value as X402PaywallFacilitatorLike).getSupported === "function";
}

function missingOptionalPeer(error: unknown, packageName: string): boolean {
  if (!isRecord(error) || error.code !== "ERR_MODULE_NOT_FOUND" ||
      typeof error.message !== "string") return false;
  return error.message.includes(packageName);
}

function validateConfig(config: X402PaywallConfig): X402PaywallExpectedTerms {
  if (!/^GET \/\S*$/.test(config.route)) {
    throw new TypeError("createX402Paywall requires a `GET /…` route pattern");
  }
  if (!validNetwork(config.network)) {
    throw new TypeError("createX402Paywall requires a positive CAIP-2 eip155 network");
  }
  if (!EVM_ADDRESS_RE.test(config.payTo) || !EVM_ADDRESS_RE.test(config.asset)) {
    throw new TypeError("createX402Paywall requires EVM payTo and asset addresses");
  }
  if (!validAmount(config.amount)) {
    throw new TypeError("createX402Paywall amount must be positive integer base units");
  }
  if (!config.eip712 || typeof config.eip712.name !== "string" ||
      config.eip712.name.length === 0 || typeof config.eip712.version !== "string" ||
      config.eip712.version.length === 0) {
    throw new TypeError("createX402Paywall requires the token EIP-712 name and version");
  }
  if (config.maxTimeoutSeconds !== undefined &&
      (!Number.isSafeInteger(config.maxTimeoutSeconds) || config.maxTimeoutSeconds <= 0)) {
    throw new TypeError("createX402Paywall maxTimeoutSeconds must be a positive integer");
  }
  if (!isFacilitator(config.facilitator)) {
    let url: URL;
    try {
      url = new URL(config.facilitator.url);
    } catch {
      throw new TypeError("createX402Paywall facilitator URL is invalid");
    }
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new TypeError("createX402Paywall facilitator URL must be credential-free HTTPS");
    }
  }
  return {
    network: config.network,
    payTo: config.payTo,
    amount: config.amount,
    asset: config.asset,
    eip712: { ...config.eip712 },
  };
}

function snapshotConfig(
  config: X402PaywallConfig,
  expected: X402PaywallExpectedTerms,
): X402PaywallConfig {
  const configuredFacilitator = config.facilitator;
  const facilitator: X402PaywallConfig["facilitator"] = isFacilitator(
    configuredFacilitator,
  )
    ? Object.freeze({
        verify: configuredFacilitator.verify.bind(configuredFacilitator),
        settle: configuredFacilitator.settle.bind(configuredFacilitator),
        getSupported: configuredFacilitator.getSupported.bind(configuredFacilitator),
      })
    : Object.freeze({
        url: configuredFacilitator.url,
        ...(configuredFacilitator.createAuthHeaders === undefined
          ? {}
          : {
              createAuthHeaders: configuredFacilitator.createAuthHeaders.bind(
                configuredFacilitator,
              ),
            }),
      });
  const configuredExtra = config.extra;
  const extra = configuredExtra === undefined ? undefined : ownedFrozen(configuredExtra);
  if (configuredExtra !== undefined && !extra) {
    throw new TypeError("createX402Paywall extra must be cloneable");
  }
  return Object.freeze({
    route: config.route,
    network: expected.network,
    payTo: expected.payTo,
    amount: expected.amount,
    asset: expected.asset,
    eip712: { ...expected.eip712 },
    facilitator,
    ...(config.maxTimeoutSeconds === undefined
      ? {}
      : { maxTimeoutSeconds: config.maxTimeoutSeconds }),
    ...(config.description === undefined ? {} : { description: config.description }),
    ...(config.mimeType === undefined ? {} : { mimeType: config.mimeType }),
    ...(config.serviceName === undefined ? {} : { serviceName: config.serviceName }),
    ...(extra === undefined ? {} : { extra: extra as Record<string, unknown> }),
  });
}

/**
 * Construct an initialized, framework-neutral x402 v2/EIP-3009 seller paywall.
 * `@x402/core` and `@x402/evm` are optional peers and are loaded only here.
 */
export async function createX402Paywall<TAuthorization = unknown, T = unknown>(
  config: X402PaywallConfig,
  handlers: X402PaywallHandlers<TAuthorization, T>,
): Promise<X402Paywall<T>> {
  const expected = validateConfig(config);
  const capturedConfig = snapshotConfig(config, expected);
  if (!handlers || !handlers.settlementStore ||
      typeof handlers.settlementStore.load !== "function" ||
      typeof handlers.settlementStore.claim !== "function" ||
      typeof handlers.settlementStore.recordOutcome !== "function" ||
      typeof handlers.reconcileSettlement !== "function" ||
      typeof handlers.authorizePayment !== "function" ||
      typeof handlers.fulfil !== "function") {
    throw new TypeError(
      "createX402Paywall requires durable settlement recovery, payment authorization, and fulfilment handlers",
    );
  }
  const handlerStore = handlers.settlementStore;
  const capturedHandlers: X402PaywallHandlers<TAuthorization, T> = Object.freeze({
    settlementStore: Object.freeze({
      load: handlerStore.load.bind(handlerStore),
      claim: handlerStore.claim.bind(handlerStore),
      recordOutcome: handlerStore.recordOutcome.bind(handlerStore),
    }),
    reconcileSettlement: handlers.reconcileSettlement.bind(handlers),
    authorizePayment: handlers.authorizePayment.bind(handlers),
    fulfil: handlers.fulfil.bind(handlers),
  });
  const core = await import("@x402/core/server").catch((error: unknown) => {
    if (missingOptionalPeer(error, "@x402/core")) {
      throw new CounterpartyError(
        "createX402Paywall requires the optional peer @x402/core",
      );
    }
    throw error;
  });
  const evm = await import("@x402/evm/exact/server").catch((error: unknown) => {
    if (missingOptionalPeer(error, "@x402/evm")) {
      throw new CounterpartyError(
        "createX402Paywall requires the optional peer @x402/evm",
      );
    }
    throw error;
  });

  const facilitator = isFacilitator(capturedConfig.facilitator)
    ? capturedConfig.facilitator
    : new core.HTTPFacilitatorClient(capturedConfig.facilitator);
  const resourceServer = new core.x402ResourceServer(facilitator as never);
  resourceServer.register(capturedConfig.network, new evm.ExactEvmScheme());
  const server = new core.x402HTTPResourceServer(resourceServer, {
    [capturedConfig.route]: {
      accepts: {
        scheme: "exact",
        network: capturedConfig.network,
        payTo: capturedConfig.payTo,
        price: { amount: capturedConfig.amount, asset: capturedConfig.asset },
        ...(capturedConfig.maxTimeoutSeconds === undefined
          ? {}
          : { maxTimeoutSeconds: capturedConfig.maxTimeoutSeconds }),
        extra: {
          ...(capturedConfig.extra ?? {}),
          name: capturedConfig.eip712.name,
          version: capturedConfig.eip712.version,
        },
      },
      ...(capturedConfig.description === undefined
        ? {}
        : { description: capturedConfig.description }),
      ...(capturedConfig.mimeType === undefined
        ? {}
        : { mimeType: capturedConfig.mimeType }),
      ...(capturedConfig.serviceName === undefined
        ? {}
        : { serviceName: capturedConfig.serviceName }),
    },
  });
  await server.initialize();

  const structuralServer = server as unknown as X402PaywallServerLike;
  return {
    terms: { ...expected, eip712: { ...expected.eip712 } },
    handle(input) {
      return x402PaywallCore(input, {
        server: structuralServer,
        expected,
        settlementStore: capturedHandlers.settlementStore,
        reconcileSettlement: capturedHandlers.reconcileSettlement,
        authorizePayment: capturedHandlers.authorizePayment,
        fulfil: capturedHandlers.fulfil,
      });
    },
  };
}
