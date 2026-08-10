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

export interface X402PaywallFulfilmentContext {
  jobId: string;
  phaseIndex: number;
  /** Stable operational key for the application's durable at-most-once work record. */
  idempotencyKey: string;
  payer: string;
  request: X402PaywallHttpAdapter;
  paymentPayload: Readonly<X402PaywallPaymentPayload>;
  paymentRequirements: Readonly<X402PaywallPaymentRequirements>;
}

export interface X402PaywallFulfilment<T = unknown> {
  status?: number;
  headers?: Record<string, string>;
  body?: T;
}

export type X402PaywallResult<T = unknown> =
  | {
      disposition:
        | "payment-required"
        | "rejected"
        | "fulfilment-failed"
        | "settlement-failed"
        | "indeterminate";
      settled: false;
      reason: string;
      response: X402PaywallResponse;
      /** Present only when settlement may already have moved value. */
      settlement?: X402PaywallSettlementResult;
    }
  | {
      disposition: "settled";
      settled: true;
      reason: "verified-fulfilled-settled";
      response: X402PaywallResponse<T>;
      payer: string;
      paymentClaim: Extract<SellerPaymentClaim, { kind: "pay-x402" }>;
      settlement: X402PaywallSettlementResult & { success: true };
    };

export interface X402PaywallCoreDeps<T = unknown> {
  server: X402PaywallServerLike;
  expected: X402PaywallExpectedTerms;
  fulfil(context: X402PaywallFulfilmentContext): Promise<X402PaywallFulfilment<T>>;
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

export interface X402Paywall<T = unknown> {
  readonly terms: X402PaywallExpectedTerms;
  handle(input: X402PaywallHandleInput): Promise<X402PaywallResult<T>>;
}

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const EVM_TX_RE = /^0x[0-9a-fA-F]{64}$/;
const INTEGER_RE = /^(0|[1-9][0-9]*)$/;
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const FULFILMENT_KEY_SEPARATOR = "dacs-x402-fulfil:v1:";

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

/** Stable operational key; it is never added to a signed DACS artifact. */
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

function jsonResponse(status: number, reason: string): X402PaywallResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: { error: reason },
  };
}

function safeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const entries: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (typeof value !== "string" || !HEADER_NAME_RE.test(name) || /[\r\n]/.test(value)) {
      throw new TypeError("fulfilment returned an invalid HTTP header");
    }
    entries.push([name, value]);
  }
  return Object.fromEntries(entries);
}

function safeProtocolResponse(response: X402PaywallResponse): X402PaywallResponse | null {
  if (!isRecord(response) || !Number.isInteger(response.status) ||
      response.status < 100 || response.status > 599 || !isRecord(response.headers) ||
      response.isHtml !== undefined && typeof response.isHtml !== "boolean") return null;
  try {
    return {
      status: response.status,
      headers: safeHeaders(response.headers),
      ...(response.body === undefined ? {} : { body: response.body }),
      ...(response.isHtml === undefined ? {} : { isHtml: response.isHtml }),
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

function validatedCoreInput(
  input: X402PaywallHandleInput,
  expected: X402PaywallExpectedTerms,
): string | null {
  if (typeof input.jobId !== "string" || input.jobId.length === 0) return "invalid-jobId";
  if (!Number.isSafeInteger(input.phaseIndex) || input.phaseIndex < 0) {
    return "invalid-phaseIndex";
  }
  if (!input.request || typeof input.request.getMethod !== "function" ||
      typeof input.request.getPath !== "function" ||
      typeof input.request.getUrl !== "function") return "invalid-http-adapter";
  if (!validNetwork(expected.network) || !EVM_ADDRESS_RE.test(expected.payTo) ||
      !EVM_ADDRESS_RE.test(expected.asset) || !validAmount(expected.amount) ||
      !expected.eip712 || typeof expected.eip712.name !== "string" ||
      expected.eip712.name.length === 0 || typeof expected.eip712.version !== "string" ||
      expected.eip712.version.length === 0) {
    return "invalid-paywall-terms";
  }
  try {
    const resource = new URL(input.request.getUrl());
    if (resource.protocol !== "https:" || resource.username || resource.password) {
      return "invalid-http-resource";
    }
  } catch {
    return "invalid-http-resource";
  }
  return null;
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

/**
 * DACS pay-x402 seller sequence: verify authorization, enforce SB-3, prepare
 * the deliverable, settle, then release the response. The callback output is
 * withheld on every verification, fulfilment, and settlement failure.
 */
export async function x402PaywallCore<T>(
  input: X402PaywallHandleInput,
  deps: X402PaywallCoreDeps<T>,
): Promise<X402PaywallResult<T>> {
  const invalid = validatedCoreInput(input, deps.expected);
  if (invalid) {
    return {
      disposition: "rejected",
      settled: false,
      reason: invalid,
      response: jsonResponse(400, invalid),
    };
  }

  let context: X402PaywallHttpContext;
  let httpResource: string;
  try {
    context = {
      adapter: input.request,
      path: input.request.getPath(),
      method: input.request.getMethod(),
    };
    httpResource = input.request.getUrl();
  } catch {
    return {
      disposition: "rejected",
      settled: false,
      reason: "invalid-http-adapter",
      response: jsonResponse(400, "invalid-http-adapter"),
    };
  }
  let processed: X402PaywallProcessResult;
  try {
    processed = await deps.server.processHTTPRequest(context);
  } catch {
    return {
      disposition: "indeterminate",
      settled: false,
      reason: "payment-verification-unavailable",
      response: jsonResponse(503, "payment-verification-unavailable"),
    };
  }
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
  const acceptedMatches = requirementsMatch(accepted, deps.expected);
  const requirementsAreExpected = requirementsMatch(paymentRequirements, deps.expected);
  const expectedNonce = x402Eip3009Nonce(input.jobId, input.phaseIndex);
  const idempotencyKey = x402PaywallFulfilmentKey(input);
  if (
    !isRecord(paymentPayload) || paymentPayload.x402Version !== 2 || !authorization ||
    !acceptedMatches || !requirementsAreExpected ||
    !requirementsAgree(accepted, paymentRequirements) ||
    !sameAddress(authorization.to, deps.expected.payTo) ||
    authorization.value !== deps.expected.amount ||
    authorization.nonce !== expectedNonce
  ) {
    await cancel(cancellationDispatcher, {
      reason: "handler_failed",
      responseStatus: 403,
    });
    return {
      disposition: "rejected",
      settled: false,
      reason: "payment-session-or-terms-mismatch",
      response: jsonResponse(403, "payment-session-or-terms-mismatch"),
    };
  }

  let fulfilment: X402PaywallFulfilment<T>;
  try {
    fulfilment = await deps.fulfil({
      jobId: input.jobId,
      phaseIndex: input.phaseIndex,
      idempotencyKey,
      payer: authorization.payer,
      request: input.request,
      paymentPayload,
      paymentRequirements,
    });
  } catch (error) {
    await cancel(cancellationDispatcher, { reason: "handler_threw", error });
    return {
      disposition: "fulfilment-failed",
      settled: false,
      reason: "fulfilment-threw",
      response: jsonResponse(500, "fulfilment-failed"),
    };
  }

  if (!fulfilment || typeof fulfilment !== "object" || Array.isArray(fulfilment)) {
    await cancel(cancellationDispatcher, {
      reason: "handler_failed",
      responseStatus: 500,
    });
    return {
      disposition: "fulfilment-failed",
      settled: false,
      reason: "invalid-fulfilment-response",
      response: jsonResponse(500, "invalid-fulfilment-response"),
    };
  }

  const status = fulfilment.status ?? 200;
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    await cancel(cancellationDispatcher, {
      reason: "handler_failed",
      responseStatus: 500,
    });
    return {
      disposition: "fulfilment-failed",
      settled: false,
      reason: "invalid-fulfilment-status",
      response: jsonResponse(500, "invalid-fulfilment-status"),
    };
  }
  if (status < 200 || status >= 300) {
    await cancel(cancellationDispatcher, { reason: "handler_failed", responseStatus: status });
    let headers: Record<string, string>;
    try {
      headers = safeHeaders(fulfilment.headers);
    } catch {
      headers = { "content-type": "application/json" };
    }
    return {
      disposition: "fulfilment-failed",
      settled: false,
      reason: "fulfilment-returned-non-success",
      response: { status, headers, body: fulfilment.body },
    };
  }

  let applicationHeaders: Record<string, string>;
  let responseBody: Buffer | undefined;
  try {
    applicationHeaders = safeHeaders(fulfilment.headers);
    responseBody = bodyBuffer(fulfilment.body);
  } catch {
    await cancel(cancellationDispatcher, {
      reason: "handler_failed",
      responseStatus: 500,
    });
    return {
      disposition: "fulfilment-failed",
      settled: false,
      reason: "invalid-fulfilment-response",
      response: jsonResponse(500, "invalid-fulfilment-response"),
    };
  }

  let settlement: X402PaywallSettlementResult;
  try {
    settlement = await deps.server.processSettlement(
      paymentPayload,
      paymentRequirements,
      processed.declaredExtensions,
      {
        request: context,
        ...(responseBody === undefined ? {} : { responseBody }),
        responseHeaders: applicationHeaders,
      },
    );
  } catch {
    return {
      disposition: "indeterminate",
      settled: false,
      reason: "settlement-result-indeterminate",
      response: jsonResponse(503, "settlement-result-indeterminate"),
    };
  }
  if (!isRecord(settlement) || typeof settlement.success !== "boolean") {
    return {
      disposition: "indeterminate",
      settled: false,
      reason: "invalid-settlement-protocol-response",
      response: jsonResponse(502, "invalid-settlement-protocol-response"),
    };
  }
  if (!settlement.success) {
    const response = safeProtocolResponse(settlement.response);
    if (!response) {
      return {
        disposition: "indeterminate",
        settled: false,
        reason: "invalid-settlement-protocol-response",
        response: jsonResponse(502, "invalid-settlement-protocol-response"),
        settlement,
      };
    }
    return {
      disposition: "settlement-failed",
      settled: false,
      reason: settlement.errorReason || "settlement-failed",
      response,
      settlement,
    };
  }

  let protocolHeaders: Record<string, string>;
  try {
    protocolHeaders = safeHeaders(settlement.headers);
  } catch {
    return {
      disposition: "indeterminate",
      settled: false,
      reason: "invalid-settlement-protocol-response",
      response: jsonResponse(502, "invalid-settlement-protocol-response"),
      settlement,
    };
  }
  const safeSettlement = { ...settlement, headers: protocolHeaders };

  const paymentClaim = settlementClaim(
    safeSettlement,
    deps.expected,
    authorization.payer,
    httpResource,
  );
  if (!paymentClaim) {
    return {
      disposition: "indeterminate",
      settled: false,
      reason: "settled-receipt-is-not-dacs-verifiable",
      response: jsonResponse(503, "settled-receipt-is-not-dacs-verifiable"),
      settlement,
    };
  }

  return {
    disposition: "settled",
    settled: true,
    reason: "verified-fulfilled-settled",
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

/**
 * Construct an initialized, framework-neutral x402 v2/EIP-3009 seller paywall.
 * `@x402/core` and `@x402/evm` are optional peers and are loaded only here.
 */
export async function createX402Paywall<T>(
  config: X402PaywallConfig,
  fulfil: X402PaywallCoreDeps<T>["fulfil"],
): Promise<X402Paywall<T>> {
  const expected = validateConfig(config);
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

  const facilitator = isFacilitator(config.facilitator)
    ? config.facilitator
    : new core.HTTPFacilitatorClient(config.facilitator);
  const resourceServer = new core.x402ResourceServer(facilitator as never);
  resourceServer.register(config.network, new evm.ExactEvmScheme());
  const server = new core.x402HTTPResourceServer(resourceServer, {
    [config.route]: {
      accepts: {
        scheme: "exact",
        network: config.network,
        payTo: config.payTo,
        price: { amount: config.amount, asset: config.asset },
        ...(config.maxTimeoutSeconds === undefined
          ? {}
          : { maxTimeoutSeconds: config.maxTimeoutSeconds }),
        extra: {
          ...(config.extra ?? {}),
          name: config.eip712.name,
          version: config.eip712.version,
        },
      },
      ...(config.description === undefined ? {} : { description: config.description }),
      ...(config.mimeType === undefined ? {} : { mimeType: config.mimeType }),
      ...(config.serviceName === undefined ? {} : { serviceName: config.serviceName }),
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
        fulfil,
      });
    },
  };
}
