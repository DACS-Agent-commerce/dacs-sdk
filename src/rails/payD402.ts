import type { SettleRequest, SettleResult } from "../agent/runSessionCore.js";
import { DacsError } from "../errors.js";
import type { SettlementIdempotencyStore } from "./idempotency.js";

/**
 * D402 protocol types and terms comparison remain available for inspection.
 * Funded use is disabled: the supported demosdk cannot enforce an approved
 * total debit before broadcast. Re-enabling also requires durable wallet-wide
 * nonce/job binding, authenticated network and credited-payment evidence, and
 * terminal disposition of every prior attempt. DACS-4 does not register this
 * phase, so it must never produce DACS settlement or completion artifacts.
 * Existing payments require independent read-only operator reconciliation;
 * absence, refusal or SDK inclusion alone never authorizes another payment.
 */
export const PAY_D402_AVAILABILITY = "disabled" as const;

function unavailable(): never {
  throw new DacsError(
    "pay-d402 is unavailable: funded use and DACS session settlement are disabled; " +
    "the rail is unregistered and cannot enforce an approved total debit or authenticate settlement. " +
    "Existing payments require read-only operator reconciliation; do not pay again.",
  );
}

/** The 402-advertised payment requirement (demosdk D402PaymentRequirement shape). */
export interface D402PaymentRequirement {
  /** Payment amount: pre-fork `number` DEM or post-fork `string` OS base units. */
  amount: string | number;
  /** Recipient Demos address (payee). */
  recipient: string;
  /** Resource identifier the payment unlocks. */
  resourceId: string;
  /** Optional human description (folded into the tx memo). */
  description?: string;
}

/** Settlement result from a broadcast d402_payment (demosdk D402SettlementResult). */
export interface D402SettlementResult {
  success: boolean;
  hash: string;
  blockNumber?: number;
  message?: string;
  /**
   * demosdk 4.0.17+: broadcast but not seen in a block before the wait ran out.
   * It may still land; resume with `waitForSettlement(hash)`, never pay again.
   */
  pending?: boolean;
}

/** demosdk `waitForSettlement` polling options. */
export interface D402WaitOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

/** Minimal structural view of the demosdk D402Client this rail depends on. */
export interface D402ClientLike {
  createPayment(requirement: D402PaymentRequirement): Promise<unknown>;
  settle(payment: unknown): Promise<D402SettlementResult>;
  /** Optional compatibility member (demosdk 4.0.17+); funded use is disabled. */
  waitForSettlement?(hash: string, options?: D402WaitOptions): Promise<D402SettlementResult>;
}

/** Per-session settlement inputs, derived from the negotiated agreement. */
export interface PayD402SettleParams {
  /** Seller's paywalled delivery URL (returns HTTP 402). */
  paywallUrl: string;
  /** Negotiated recipient Demos address (the expected payTo). */
  recipient: string;
  /**
   * Negotiated price in integer OS base units (1 DEM = 10^9 OS).
   * Retained for compatibility while settlement is disabled.
   */
  amount: string;
  /** Requested network; retained for API compatibility while D402 is disabled. */
  network: string;
  requestInit?: RequestInit;
}

/** Inputs for reading back a previously broadcast payment by its hash. */
export interface PayD402WaitParams {
  txHash: string;
  /** The recipient the payment was made to (recorded as `payee`). */
  recipient: string;
  /** Network label recorded on the evidence. */
  network: string;
  options?: D402WaitOptions;
}

/** Numeric equality over integer base-unit amounts (tolerant of leading zeros / dual number|string shape). */
function sameAmount(a: string, b: string): boolean {
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return a === b;
  }
}

/**
 * SDK-local abort guard for D402: the 402's offered terms MUST match the
 * negotiated agreement. Recipient compared case-insensitively; amount compared
 * as integer OS base units on both sides. Convert any decimal DEM agreement
 * amount to OS before comparison (1.5 DEM is 1500000000 OS).
 * This comparator does not authorize a payment or admit a DACS rail.
 */
export function termsMatchD402(
  expected: { recipient: string; amount: string },
  offered: { recipient: string; amount: string },
): { ok: boolean; reason?: string } {
  if (offered.recipient.trim().toLowerCase() !== expected.recipient.trim().toLowerCase()) {
    return {
      ok: false,
      reason: `recipient mismatch: 402 says ${offered.recipient}, agreement says ${expected.recipient}`,
    };
  }
  if (!sameAmount(offered.amount, expected.amount)) {
    return {
      ok: false,
      reason: `amount mismatch: 402 says ${offered.amount}, agreement says ${expected.amount}`,
    };
  }
  return { ok: true };
}

/** Compatibility configuration; no value enables funded D402 use. */
export interface PayD402RailConfig {
  rpc: string;
  secret: string;
  network?: string;
  fetchImpl?: typeof fetch;
  /** Retained for compatibility; acknowledgement does not enable this rail. */
  acknowledgeExperimental: boolean;
}

/** Compatibility seam for existing integrations; the SDK does not invoke it. */
export interface PayD402Rail {
  readonly address: string;
  settle(params: PayD402SettleParams): Promise<SettleResult>;
  waitForSettlement?(params: PayD402WaitParams): Promise<SettleResult>;
}

export interface PayD402SettleCoreDeps {
  client: Pick<D402ClientLike, "createPayment" | "settle">;
  fetchImpl: typeof fetch;
  payerAddress: string;
}

/** @deprecated Funded D402 use is disabled, including direct core calls. */
export async function payD402SettleCore(
  _params: PayD402SettleParams,
  _deps: PayD402SettleCoreDeps,
): Promise<SettleResult> {
  return unavailable();
}

/** @deprecated No configuration or acknowledgement enables funded D402 use. */
export async function createPayD402Rail(_config: PayD402RailConfig): Promise<PayD402Rail> {
  // Reject before importing chain dependencies, connecting or deriving a wallet.
  return unavailable();
}

export interface PayD402Paywall {
  url: string;
  recipient: string;
  network?: string;
}

/** @deprecated Unregistered D402 cannot be used as a DACS session rail. */
export function payD402Settle(
  _rail: PayD402Rail,
  _paywall: PayD402Paywall,
  _opts?: { store: SettlementIdempotencyStore },
): (req: SettleRequest) => Promise<SettleResult> {
  return async () => unavailable();
}

/** @deprecated SDK inclusion cannot authenticate DACS settlement or recovery. */
export function payD402ResumeSettlement(
  _rail: PayD402Rail,
  _paywall: PayD402Paywall,
  _opts: { wait?: D402WaitOptions } = {},
): (req: SettleRequest) => Promise<SettleResult> {
  return async () => unavailable();
}
