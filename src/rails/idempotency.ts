import type { SettleResult } from "../agent/runSessionCore.js";

/**
 * Settlement idempotency (issue #43 — the runtime at-most-once guarantee).
 *
 * `runSessionCore` pays before it anchors SettlementEvidence, so a crash/timeout
 * between a successful payment and the evidence write leaves no evidence — and a
 * resume of the same jobId would pay AGAIN. Two concurrent runs can likewise both
 * observe the empty evidence address and both settle. The reference rail bridges
 * also discarded `req.jobId`, so a rail had no idempotency key to dedupe on.
 *
 * This store closes that window: settlement submits are keyed by
 * `(railId, jobId, phaseIndex)` and run through {@link SettlementIdempotencyStore.once},
 * which submits AT MOST ONCE per key —
 *  - a completed submission is recorded and returned on any later call for the
 *    same key (crash-resume safety, when `done` is durable);
 *  - concurrent calls share one in-flight submission (only one transfer is sent).
 *
 * Residual window (documented, not silently ignored): a crash in the instant
 * between the on-chain tx confirming and `done` recording it is the rail's own
 * on-chain idempotency window — closing it fully needs a write-ahead intent plus
 * a rail `reconcile` (query-chain-before-resubmit) capability, tracked with the
 * SB-3 x402 session binding in #33. This store removes the settle→anchor window
 * and the concurrency race, which is the P0.
 */

/** Deterministic settlement idempotency key: `railId:jobId:phaseIndex`. */
export function settlementKey(railId: string, jobId: string, phaseIndex: number): string {
  return `${railId}:${jobId}:${phaseIndex}`;
}

export interface SettlementIdempotencyStore {
  /**
   * Run `submit` AT MOST ONCE for `key`. If a completed result is already
   * recorded, return it without calling `submit`; if a submit for `key` is
   * in flight, await and share it; otherwise submit, record a definitive result
   * (ok + non-empty txHash), and return it. A non-definitive result (failed /
   * no tx id) is NOT recorded, so a genuine failure can be retried.
   */
  once(key: string, submit: () => Promise<SettleResult>): Promise<SettleResult>;
}

/**
 * A settlement idempotency store. In-flight de-duplication is always in-process;
 * pass a `done` map backed by durable storage (or one that survives a resume) for
 * crash-safety across runs. Without a durable `done`, this still prevents the
 * concurrent-double-submit race within a single process.
 */
export function createIdempotencyStore(
  done: Map<string, SettleResult> = new Map(),
): SettlementIdempotencyStore {
  const inflight = new Map<string, Promise<SettleResult>>();
  return {
    async once(key, submit) {
      const recorded = done.get(key);
      if (recorded) return recorded; // already settled for this key — never resubmit
      const flying = inflight.get(key);
      if (flying) return flying; // a concurrent submit is in progress — share it
      const p = (async () => {
        const res = await submit();
        // Record only a definitive submission so a real failure stays retryable.
        if (res.ok && res.txHash.trim().length > 0) done.set(key, res);
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
