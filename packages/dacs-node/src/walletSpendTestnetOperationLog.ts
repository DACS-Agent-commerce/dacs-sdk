import { canonicalize } from "@kynesyslabs/dacs/canonical";

import { DacsWalletSpendRemoteError, type DacsWalletSpendRemoteOperationStoreV1 } from "./walletSpendRemote.js";

type Claim = Parameters<DacsWalletSpendRemoteOperationStoreV1["claim"]>[0];
type Retained = NonNullable<Awaited<ReturnType<DacsWalletSpendRemoteOperationStoreV1["load"]>>>;

/**
 * In-memory operation log for a long-running service. It keeps at most `limit`
 * operations. Once full, a new claim drops the oldest completed operation that
 * has been kept for at least `minRetainMs`, so a client that lost a reply can
 * still read its outcome by an exact query. A new claim is refused as `full`
 * while every kept operation is unresolved or younger than that. A dropped
 * operation is not lost: the durable wallet state still answers its exact
 * repeat, the same as after a restart.
 */
export function createRetainingDacsWalletSpendOperationLogV1(
  limit: number,
  minRetainMs = 0,
  now: () => number = Date.now,
): DacsWalletSpendRemoteOperationStoreV1 {
  if (!Number.isSafeInteger(limit) || limit <= 0 ||
      !Number.isSafeInteger(minRetainMs) || minRetainMs < 0) {
    throw new Error("wallet-spend-authority-operation-retention-invalid");
  }
  const values = new Map<string, Retained>();
  const completedAt = new Map<string, number>();
  const key = (roleId: string, operationId: string) => `${roleId}\0${operationId}`;
  const conflict = () => new DacsWalletSpendRemoteError("wallet-spend-authority-operation-conflict");
  const dropOldestCompleted = (): boolean => {
    const cutoff = now() - minRetainMs;
    for (const [identity, retained] of values) {
      if (retained.response === undefined) continue;
      if ((completedAt.get(identity) ?? Number.NEGATIVE_INFINITY) > cutoff) continue;
      completedAt.delete(identity);
      return values.delete(identity);
    }
    return false;
  };
  const store: DacsWalletSpendRemoteOperationStoreV1 = {
    async load(input) { return values.get(key(input.roleId, input.operationId)); },
    async claim(input: Claim) {
      const prior = values.get(key(input.roleId, input.operationId));
      if (prior !== undefined) {
        if (prior.requestHash !== input.requestHash ||
            canonicalize(prior.request) !== canonicalize(input.request)) throw conflict();
        return "existing";
      }
      if (values.size >= limit && !dropOldestCompleted()) return "full";
      values.set(key(input.roleId, input.operationId), {
        requestHash: input.requestHash,
        request: structuredClone(input.request),
      });
      return "new";
    },
    async complete(input) {
      const identity = key(input.roleId, input.operationId);
      const prior = values.get(identity);
      if (prior === undefined || prior.requestHash !== input.requestHash) throw conflict();
      if (prior.response !== undefined &&
          canonicalize(prior.response) !== canonicalize(input.response)) throw conflict();
      if (prior.response === undefined) completedAt.set(identity, now());
      values.set(identity, { ...prior, response: input.response });
    },
  };
  return Object.freeze(store);
}
