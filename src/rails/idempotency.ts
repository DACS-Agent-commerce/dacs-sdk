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
 *  2. an INTENT is ATOMICALLY CLAIMED (put-if-absent) BEFORE `submit()` moves
 *     value. Only the caller that wins the claim submits; a caller that finds the
 *     intent already held (a concurrent submit, or a prior attempt that crashed /
 *     lost its response after moving value) MUST NOT submit;
 *  3. on a held intent, the store refuses to resubmit unless a `reconcile`
 *     capability can either prove the prior payment landed (adopt it) or prove it
 *     did NOT (safe to resubmit). With no reconcile it FAILS CLOSED — a stuck
 *     settlement never becomes a double-pay;
 *  4. after submit, a definitive result is recorded; a result with NO tx identity
 *     releases the claim (clean retry); a TX-BEARING but non-definitive result (or
 *     a throw) LEAVES the claim, because value may have moved.
 *
 * SCOPE OF THE GUARANTEE. The atomic claim makes at-most-once hold across
 * concurrent callers *of the same log*. The DEFAULT log is in-process, so that is
 * one process. CROSS-PROCESS at-most-once (a fresh process after a crash, or two
 * hosts) requires a DURABLE log whose `claimIntent` is an atomic compare-and-set —
 * e.g. one backed by the #55 SessionStore lease; the in-memory default is NOT
 * durable and does NOT provide cross-process safety on its own. The
 * reconcile-then-resubmit path additionally assumes a single writer or a leased
 * store (it is not atomic across processes without the lease).
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
  /**
   * ATOMICALLY claim the intent to submit `key` (put-if-absent). Returns
   * `"claimed"` if this caller set the intent — it MUST proceed to submit — or
   * `"held"` if an intent already exists (a concurrent submit, or a crashed prior
   * attempt): the caller MUST NOT submit; it reconciles or fails closed. The
   * ATOMICITY is what makes at-most-once hold across concurrent callers — exactly
   * one `"claimed"` per key. A durable backend MUST implement this as an atomic
   * compare-and-set / insert-if-absent (e.g. the #55 SessionStore lease); the
   * default in-process log relies on the single-threaded event loop.
   */
  claimIntent(key: string): Promise<"claimed" | "held">;
  /**
   * Release a claim ONLY when the rail RETURNED proof no value moved (a result
   * with no tx identity). A tx-bearing or thrown submit leaves the claim in place
   * so the next attempt fails closed / reconciles instead of resubmitting.
   */
  releaseIntent(key: string): Promise<void>;
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
    async claimIntent(key) {
      // Atomic put-if-absent: the check + add run in one synchronous step with no
      // await between them, so two concurrent callers can't both claim on the
      // single-threaded event loop — exactly one gets "claimed".
      if (intents.has(key)) return "held";
      intents.add(key);
      return "claimed";
    },
    async releaseIntent(key) {
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
        // ATOMICALLY claim the intent. "held" means an intent already exists — a
        // concurrent submit, or a prior attempt that crashed after moving value —
        // so we MUST NOT submit under it.
        if ((await log.claimIntent(key)) === "held") {
          // A concurrent winner may have just recorded the outcome — re-check.
          const now = await log.getOutcome(key);
          if (now) return now;
          if (!reconcile) {
            throw new DacsError(
              `settlement ${key} has an unresolved or in-flight prior attempt and no reconcile capability; refusing to resubmit (double-pay risk)`,
            );
          }
          const found = await reconcile(key); // throws if indeterminate → fails closed
          if (found && isDefinitive(found)) {
            await log.putOutcome(key, found);
            return found; // the prior payment landed — adopt it, don't resubmit
          }
          // found === null → reconcile proved NO payment landed → submit under the
          // existing intent below. (Reconcile-then-resubmit assumes a single writer
          // or a leased store; cross-process safety rides the #55 SessionStore lease.)
        }
        // We hold the intent (freshly claimed, or reconcile proved not-paid). Submit
        // exactly once.
        const res = await submit();
        if (isDefinitive(res)) {
          await log.putOutcome(key, res); // payment landed — record it definitively
        } else if (!res.txHash || res.txHash.trim().length === 0) {
          // The rail RETURNED a result with NO tx identity — nothing moved — so
          // this attempt is cleanly retryable: release the claim.
          await log.releaseIntent(key);
        }
        // else: a TX-BEARING but non-definitive result (a tx id exists, so value MAY
        // have moved) — LEAVE the claim so the next attempt reconciles or fails
        // closed, never resubmits. A THROW likewise leaves the claim.
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
