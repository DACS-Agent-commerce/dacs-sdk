import { vi } from "vitest";

import type { SettleResult } from "../../src/agent/runSessionCore.js";
import type { SettlementLog } from "../../src/rails/idempotency.js";

/**
 * Leave `result` persisted in `log` as the outcome of the key that `run`
 * claims, the way the store persists a verdict from `createPayDemRail`'s own
 * settle. A test cannot reach that path without the SDK reading a node record:
 * `run` goes through a caller's submission, which the SDK holds as
 * indeterminate (the intent stays held, the attempt record keeps the hash),
 * and this then writes the outcome under the lease `run` was granted. `run`
 * must create its store after this call starts: a store binds the log's
 * methods when created.
 */
export async function seedSdkOutcome(
  log: SettlementLog,
  result: SettleResult,
  run: () => Promise<unknown>,
): Promise<void> {
  const claim = vi.spyOn(log, "claimIntent");
  try {
    await run().catch(() => undefined);
    const [input] = claim.mock.calls[0]!;
    const granted = await claim.mock.results[0]!.value;
    if (granted.status !== "acquired") throw new Error("seed: the run did not claim the key");
    const write = await log.putOutcome({
      key: input.key,
      bindingHash: input.bindingHash,
      lease: granted.lease,
      result,
      now: input.now,
    });
    if (write.status !== "recorded") throw new Error(`seed: outcome write was ${write.status}`);
  } finally {
    claim.mockRestore();
  }
}
