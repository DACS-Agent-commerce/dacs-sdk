import { canonicalize } from "@kynesyslabs/dacs/canonical";

import { DacsWalletSpendRemoteError, type DacsWalletSpendRemoteOperationStoreV1 } from "./walletSpendRemote.js";

type Claim = Parameters<DacsWalletSpendRemoteOperationStoreV1["claim"]>[0];
type Retained = NonNullable<Awaited<ReturnType<DacsWalletSpendRemoteOperationStoreV1["load"]>>>;

/**
 * In-memory operation log for a long-running service. It keeps at most `limit`
 * operations: once full, a new claim drops the oldest completed operation, and is
 * refused as `full` only while every kept operation is still unresolved. A
 * dropped operation is not lost: the durable wallet state still answers its
 * exact repeat, the same as after a restart.
 */
export function createRetainingDacsWalletSpendOperationLogV1(
  limit: number,
): DacsWalletSpendRemoteOperationStoreV1 {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("wallet-spend-authority-operation-retention-invalid");
  }
  const values = new Map<string, Retained>();
  const key = (roleId: string, operationId: string) => `${roleId}\0${operationId}`;
  const conflict = () => new DacsWalletSpendRemoteError("wallet-spend-authority-operation-conflict");
  const dropOldestCompleted = (): boolean => {
    for (const [identity, retained] of values) {
      if (retained.response !== undefined) return values.delete(identity);
    }
    return false;
  };
  return Object.freeze({
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
      values.set(identity, { ...prior, response: input.response });
    },
  });
}
