/**
 * Fault classification for SDK operations (T9). Blame and retry behaviour
 * differ by category, so callers must be able to tell them apart:
 *
 * - `transient`    — retry may succeed (timeout, nonce race, rate limit).
 * - `permanent`    — retry will not help (bad input, validation, unregistered).
 * - `counterparty` — the other party misbehaved (terms mismatch, bad signature).
 * - `substrate`    — the chain/anchor layer is down — blameless, NOT the
 *                    counterparty's fault; never settle blame on a party for a
 *                    substrate outage.
 */
export type FaultCategory = "transient" | "permanent" | "counterparty" | "substrate";

/** Base error for everything this SDK throws. */
export class DacsError extends Error {
  /** Fault classification; defaults to `permanent` (safe: don't auto-retry). */
  readonly category: FaultCategory;

  constructor(
    message: string,
    options?: { cause?: unknown; category?: FaultCategory },
  ) {
    super(message, options);
    this.name = "DacsError";
    this.category = options?.category ?? "permanent";
  }
}

/** A transient fault — a retry may succeed. */
export class TransientError extends DacsError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, { ...options, category: "transient" });
    this.name = "TransientError";
  }
}

/** The counterparty misbehaved (terms mismatch, invalid signature, …). */
export class CounterpartyError extends DacsError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, { ...options, category: "counterparty" });
    this.name = "CounterpartyError";
  }
}

/** The substrate (chain / anchor layer) faulted — blameless, not a party's fault. */
export class SubstrateError extends DacsError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, { ...options, category: "substrate" });
    this.name = "SubstrateError";
  }
}

/** The fault category of any thrown value (non-DacsError defaults to transient). */
export function faultCategory(err: unknown): FaultCategory {
  if (err instanceof DacsError) return err.category;
  // Unknown/foreign errors (network throws, RPC client errors) are treated as
  // transient: safe to surface for a retry decision rather than blame a party.
  return "transient";
}

/**
 * Thrown by seam methods that are defined but not yet implemented in the MVP
 * scaffold. The task ref points at the IMPLEMENTATION.md task that lands it.
 */
export class NotImplementedError extends DacsError {
  constructor(feature: string, taskRef?: string) {
    super(
      `Not implemented in MVP scaffold: ${feature}` +
        (taskRef ? ` (planned: ${taskRef})` : ""),
    );
    this.name = "NotImplementedError";
  }
}
