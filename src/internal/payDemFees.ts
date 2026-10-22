// Shared fee parsing for the native rail and seller observer. These functions
// only parse values; they cannot attest execution or register SDK capabilities.
// Keep this module out of the package's public entry points.
const OS_PER_DEM = 1_000_000_000n;

function confirmedFeeComponentOs(value: unknown, postFork: boolean): bigint | null {
  if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value)) {
    return BigInt(value);
  }
  if (!postFork && typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    // Pre-denomination-fork fee numbers are DEM. Post-fork fee numbers are
    // ambiguous (the transaction query surface has projected other numeric
    // fields in OS), so a capped write accepts only the normative decimal-
    // string OS form after the fork.
    return BigInt(value) * OS_PER_DEM;
  }
  return null;
}

/**
 * A fee component of a stored record as the transaction query serves it. After
 * the fork that projection serves a safe value as an OS number and a larger
 * one as a decimal string (`fromEntityToWireNumber`, as for `content.amount`;
 * node2's recorded envelopes carry `network_fee: 1000000000`). Only the
 * recovery read of a record the SDK already holds accepts it; the confirmation
 * before broadcast keeps the strict form above.
 */
function recordFeeComponentOs(value: unknown, postFork: boolean): bigint | null {
  if (postFork && typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  return confirmedFeeComponentOs(value, postFork);
}

export function confirmedTransactionFeeOs(
  value: unknown,
  postFork: boolean,
  component: (value: unknown, postFork: boolean) => bigint | null = confirmedFeeComponentOs,
): bigint | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const fee = value as Record<string, unknown>;
  const network = component(fee.network_fee, postFork);
  const rpc = component(fee.rpc_fee, postFork);
  const additional = component(fee.additional_fee, postFork);
  if (network === null || rpc === null || additional === null) return null;
  return network + rpc + additional;
}

/**
 * The fee a stored native record carries: its `transaction_fee` in the
 * query's projection (see `recordFeeComponentOs`), read in the denomination
 * the record was signed in. `undefined` when the record carries none, `null`
 * when it carries one in any other form. A fresh success and a recovery read
 * of the same record take its fee from here, so they agree.
 * @internal Shared with the SDK transfer observer; not re-exported from the
 * rail module, rails index or package root.
 */
export function recordTransactionFeeOs(
  content: Record<string, unknown>,
  postFork: boolean,
): bigint | null | undefined {
  const served = content.transaction_fee;
  return served === undefined
    ? undefined
    : confirmedTransactionFeeOs(served, postFork, recordFeeComponentOs);
}
