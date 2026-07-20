import type { SettleResult } from "../agent/runSessionCore.js";
import { DacsError } from "../errors.js";

/**
 * Settlement idempotency (issue #43 — the runtime at-most-once guarantee).
 *
 * `runSessionCore` pays before it anchors SettlementEvidence, so a crash/timeout
 * between a successful payment and the evidence write leaves no evidence — and a
 * resume of the same jobId would pay AGAIN. Two concurrent runs can likewise both
 * observe the empty evidence address and both settle. The reference rail bridges
 * also discarded `req.jobId`, so a rail had no idempotency key to dedupe on.
 *
 * Settlement submits are keyed by `(railId, jobId, phaseIndex)` and run through
 * {@link SettlementIdempotencyStore.once}, which submits AT MOST ONCE per key via
 * a WRITE-AHEAD protocol:
 *  1. a recorded definitive OUTCOME short-circuits — the payment already landed,
 *     so it is returned and never resubmitted;
 *  2. an INTENT is persisted BEFORE `submit()` moves value — so if the call then
 *     crashes or loses its response after value moved, the next attempt SEES the
 *     unresolved intent instead of blindly paying again;
 *  3. on an attempt that finds an unresolved intent, the store refuses to
 *     resubmit unless a `reconcile` capability can either prove the prior payment
 *     landed (adopt it) or prove it did NOT (safe to resubmit). With no reconcile
 *     it FAILS CLOSED — a stuck settlement never becomes a double-pay;
 *  4. concurrent calls for one key share a single in-flight submission.
 *
 * Durability is the {@link SettlementLog}'s job: the default log is in-process
 * (closes the concurrency + same-process resubmit races). For cross-process
 * crash-safety inject a durable log — e.g. one backed by the #55 SessionStore —
 * so both the intent and the outcome survive a fresh process.
 *
 * Deferred (tracked with SB-3 in #33): reproducing x402's EXACT on-chain
 * authorization/session binding on a reconciled resubmit. This store guarantees
 * at-most-one submission; a rail whose resubmit must reuse a bound authorization
 * supplies that via `reconcile`.
 */

/** Deterministic settlement idempotency key: `railId:jobId:phaseIndex`. */
export function settlementKey(railId: string, jobId: string, phaseIndex: number): string {
  return `${railId}:${jobId}:${phaseIndex}`;
}

/**
 * Reconcile an unresolved settlement intent against the rail/chain. Returns the
 * definitive {@link SettleResult} if the prior payment provably LANDED; `null` if
 * it provably did NOT (so a resubmit is safe); and THROWS if it cannot tell — the
 * indeterminate case must fail closed rather than risk a double-pay.
 */
export type SettlementReconcile = (key: string) => Promise<SettleResult | null>;

/**
 * Durable-capable persistence for the write-ahead protocol: definitive outcomes
 * and in-flight intents. Every method is async so a real backend (fs, the #55
 * SessionStore, a KV) can implement it; the default is in-process.
 */
export interface SettlementLog {
  /** The recorded definitive outcome for `key`, if the payment landed. */
  getOutcome(key: string): Promise<SettleResult | undefined>;
  /** Record a definitive outcome — called only after value provably moved. */
  putOutcome(key: string, res: SettleResult): Promise<void>;
  /** True if an intent was written for `key` but no outcome recorded yet. */
  hasIntent(key: string): Promise<boolean>;
  /** Write-ahead an intent BEFORE submitting — value may move after this returns. */
  putIntent(key: string): Promise<void>;
  /** Clear an intent when the rail RETURNED (not threw) proof no value moved. */
  clearIntent(key: string): Promise<void>;
}

export interface SettlementIdempotencyStore {
  /**
   * Run `submit` AT MOST ONCE for `key` under the write-ahead protocol above.
   * `reconcile`, when supplied, resolves an unresolved prior intent; without it
   * an unresolved intent fails closed (throws) rather than resubmitting.
   */
  once(
    key: string,
    submit: () => Promise<SettleResult>,
    reconcile?: SettlementReconcile,
  ): Promise<SettleResult>;
}

/** An in-process {@link SettlementLog} (two Maps). Not durable across processes. */
export function createInMemorySettlementLog(): SettlementLog {
  const outcomes = new Map<string, SettleResult>();
  const intents = new Set<string>();
  return {
    async getOutcome(key) {
      return outcomes.get(key);
    },
    async putOutcome(key, res) {
      outcomes.set(key, res);
    },
    async hasIntent(key) {
      return intents.has(key);
    },
    async putIntent(key) {
      intents.add(key);
    },
    async clearIntent(key) {
      intents.delete(key);
    },
  };
}

const isDefinitive = (res: SettleResult): boolean => res.ok && res.txHash.trim().length > 0;

/**
 * A settlement idempotency store over a {@link SettlementLog} (default in-process).
 * In-flight de-duplication is always in-process; cross-process crash-safety comes
 * from injecting a durable log.
 */
export function createIdempotencyStore(
  log: SettlementLog = createInMemorySettlementLog(),
): SettlementIdempotencyStore {
  const inflight = new Map<string, Promise<SettleResult>>();
  return {
    async once(key, submit, reconcile) {
      const recorded = await log.getOutcome(key);
      if (recorded) return recorded; // already settled for this key — never resubmit
      const flying = inflight.get(key);
      if (flying) return flying; // a concurrent submit is in progress — share it

      const p = (async () => {
        // An intent from a prior attempt with no recorded outcome means value MAY
        // already have moved (crash / lost response after submit). Do NOT resubmit
        // blindly — reconcile, or fail closed.
        if (await log.hasIntent(key)) {
          if (!reconcile) {
            throw new DacsError(
              `settlement ${key} has an unresolved prior attempt and no reconcile capability; refusing to resubmit (double-pay risk)`,
            );
          }
          const found = await reconcile(key); // throws if indeterminate → fails closed
          if (found && isDefinitive(found)) {
            await log.putOutcome(key, found);
            return found; // the prior payment landed — adopt it, don't resubmit
          }
          // found === null → reconcile proved NO payment landed → safe to resubmit.
        }
        // Write-ahead the intent BEFORE moving value, so a crash after submit is
        // detectable as an unresolved intent on the next attempt.
        await log.putIntent(key);
        const res = await submit();
        if (isDefinitive(res)) {
          await log.putOutcome(key, res); // payment landed — record it definitively
        } else {
          // The rail RETURNED a non-definitive result (no tx id) — it is asserting
          // that no value moved, so this attempt is cleanly retryable: clear the
          // write-ahead intent. (A THROW leaves the intent in place → fails closed
          // on the next attempt, since a thrown submit may have moved value before
          // losing its response.)
          await log.clearIntent(key);
        }
        return res;
      })();
      inflight.set(key, p);
      try {
        return await p;
      } finally {
        inflight.delete(key);
      }
    },
  };
}
