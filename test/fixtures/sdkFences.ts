import type { SettleResult } from "../../src/agent/runSessionCore.js";
import {
  createIdempotencyStore,
  type SettlementBinding,
  type SettlementEffectFence,
  type SettlementLog,
  type SettlementNotInvokedResult,
} from "../../src/rails/idempotency.js";

type Submit = (fence?: Readonly<SettlementEffectFence>) => Promise<SettleResult | SettlementNotInvokedResult>;

/**
 * For a test store that decides itself when to run the bridge's submit (on
 * every call, behind a cached answer, around a reconciliation): `run` hands
 * submit the fence `createIdempotencyStore` builds for a fresh attempt, and
 * the store passes on `readOutcome` and `readAttempt`, the lookups of that
 * same store, so `payDemSettle` lets the rail run. The log forgets every
 * intent and outcome (its `readOutcome` answers null), so only the test store
 * and the bridge order calls. It keeps the last attempt per key unless
 * `keepAttempts` is false (a log that lost its records).
 */
export function sdkFences({ keepAttempts = true }: { keepAttempts?: boolean } = {}) {
  const attempts = new Map<string, Readonly<{ bindingHash: string; txHash: string }>>();
  let generation = 0;
  const log: SettlementLog = {
    async readOutcome() { return null; },
    async claimIntent(input) {
      return {
        status: "acquired",
        bindingHash: input.bindingHash,
        lease: { owner: input.owner, generation: ++generation, stage: "fresh", expiresAt: input.now + input.leaseDurationMs },
      };
    },
    async isCurrent() { return true; },
    async grantRecovery() { return { status: "stale" }; },
    async putOutcome(input) { return { status: "recorded", outcome: { bindingHash: input.bindingHash, result: input.result } }; },
    async releaseIntent() { return "released"; },
    async putAttempt(input) {
      if (keepAttempts) attempts.set(input.key, { bindingHash: input.bindingHash, txHash: input.txHash });
      return "recorded";
    },
    async readAttempt(key) { return attempts.get(key) ?? null; },
  };
  const store = createIdempotencyStore(log);
  return {
    readOutcome: store.readOutcome!,
    readAttempt: store.readAttempt!,
    run: (key: string, binding: Readonly<SettlementBinding>, submit: Submit): Promise<SettleResult> =>
      store.once(key, binding, submit),
  };
}
