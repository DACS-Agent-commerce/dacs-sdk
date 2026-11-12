/**
 * Fault classification for SDK operations. Blame and retry behaviour
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

/**
 * The error code catalog: each code names a reason and the category it belongs to.
 * Codes are lower case, shaped `domain.reason`, and stay the same when a message is reworded.
 * `tools/lint/error-codes.mjs` reads this table; `sdk.unclassified` is reserved for that check and never goes in it.
 *
 * Three subclasses own their `code` and keep it outside this catalog:
 * - `WireError`: lower-case words joined by underscores, such as `bad_sig`, chosen at each `fail()` call;
 * - `RawJsonAdmissionError`: upper-case words joined by dashes, such as `INVALID-JSON`, chosen at each `reject()` call;
 * - `AnchorWaitError`: one of the `AnchorWaitFailureCode` values.
 */
const codeCategory = {
  "schema.invalid_field": "permanent",
} as const satisfies Record<string, FaultCategory>;

/** A code from the catalog. */
export type DacsErrorCode = keyof typeof codeCategory;

/** True when `code` is a catalog code; names inherited from `Object.prototype` are not. */
export function isDacsErrorCode(code: string): code is DacsErrorCode {
  return Object.hasOwn(codeCategory, code);
}

/** Base error for everything this SDK throws. */
export class DacsError extends Error {
  /**
   * Fault classification. A category given in the options is used as is (the category classes below fix theirs);
   * otherwise a coded error takes the catalog's category and an uncoded one defaults to `permanent` (safe: don't auto-retry).
   * Do not pass a `category` beside a `code` to the base class: `tools/lint/error-codes.mjs` refuses it in migrated files.
   */
  readonly category: FaultCategory;
  /**
   * What went wrong, when the error is coded. An uncoded error has no `code` property at all.
   * Subclasses that own their code use other strings, so narrow with `isDacsErrorCode` before a `switch`.
   */
  declare readonly code?: DacsErrorCode | (string & {});

  constructor(
    message: string,
    options?: { cause?: unknown; category?: FaultCategory; code?: DacsErrorCode },
  ) {
    super(message, options);
    this.name = "DacsError";
    if (options?.code === undefined) {
      this.category = options?.category ?? "permanent";
    } else {
      this.code = options.code;
      this.category = options.category ?? codeCategory[options.code];
    }
  }
}

/** A transient fault — a retry may succeed. */
export class TransientError extends DacsError {
  constructor(message: string, options?: { cause?: unknown; code?: DacsErrorCode }) {
    super(message, { ...options, category: "transient" });
    this.name = "TransientError";
  }
}

/** The counterparty misbehaved (terms mismatch, invalid signature, …). */
export class CounterpartyError extends DacsError {
  constructor(message: string, options?: { cause?: unknown; code?: DacsErrorCode }) {
    super(message, { ...options, category: "counterparty" });
    this.name = "CounterpartyError";
  }
}

/** The substrate (chain / anchor layer) faulted — blameless, not a party's fault. */
export class SubstrateError extends DacsError {
  constructor(message: string, options?: { cause?: unknown; code?: DacsErrorCode }) {
    super(message, { ...options, category: "substrate" });
    this.name = "SubstrateError";
  }
}

/**
 * The requested operation is valid, but this SDK component cannot execute the
 * required capability. This is a local implementation boundary, not evidence
 * that a counterparty artifact is nonconformant.
 */
export class UnsupportedCapabilityError extends DacsError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, { ...options, category: "permanent" });
    this.name = "UnsupportedCapabilityError";
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
 * Thrown by an operation this build declares but does not implement. Callers
 * classify it as `permanent`: retrying does not help.
 */
export class NotImplementedError extends DacsError {
  constructor(feature: string, taskRef?: string) {
    super(
      `Not implemented: ${feature}` +
        (taskRef ? ` (planned: ${taskRef})` : ""),
    );
    this.name = "NotImplementedError";
  }
}
