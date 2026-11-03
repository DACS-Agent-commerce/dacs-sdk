import { snapshotWireJsonRead } from "../canonical/snapshot.js";
import { demosAddressFromClaim, normalizeDemosNativeAddress } from "../rails/demosAddress.js";

/**
 * A rail's projection of a terminal failed Demos record. The rail must build it
 * from the node's `getTxByHash` record only after matching the signed
 * hash/nonce, inclusion block and native body. It describes failure of this
 * attempt; it never authorizes a replacement debit.
 *
 * Fields are projections of the node's `getTxByHash` record, in canonical form:
 * `txHash`, `payer` and `payee` are 64 lower-case hex without `0x` (the node
 * serves `0x`-prefixed keys); `nonce` is the record's decimal nonce string
 * converted to a safe integer; `amountOs` is the decimal OS amount. The public
 * result carries this projection; the SDK rail authenticates fresh results
 * with a separate private record verdict.
 */
export interface DemosFailedRecordProof {
  kind: "demos-failed-record";
  txHash: string;
  nonce: number;
  blockNumber: number;
  payer: string;
  payee: string;
  amountOs: string;
}

const RESULT_KEYS = new Set([
  "ok", "txHash", "chainId", "payer", "payee", "errorClass", "failureProof",
  "blockNumber", "txRefKind", "finality", "txRef", "finalityObservedAt",
  "x402Receipt",
]);
const REQUIRED_RESULT_KEYS = [
  "ok", "txHash", "chainId", "payer", "payee", "errorClass", "failureProof",
  "blockNumber", "txRefKind",
];

type DemosFailureResult = {
  ok: boolean; txHash: string; chainId: string; payer: string; payee: string;
  errorClass?: unknown; failureProof?: unknown; blockNumber?: unknown;
  txRefKind?: unknown; finality?: unknown; txRef?: unknown;
  finalityObservedAt?: unknown; x402Receipt?: unknown;
};

/**
 * Check that a failed result carries a well-formed failure proof bound to it.
 * This checks shape and bindings only; it does not authenticate the proof
 * against the node, so `true` may be acted on only for a proof the caller's
 * own rail built as described on {@link DemosFailedRecordProof}.
 *
 * The input is first copied as data-only JSON, so proxies, accessors, exotic
 * prototypes (`Date`, class instances), symbol or non-enumerable keys and
 * `undefined` members are refused without running caller code. Both bindings
 * are required: the proof must carry exactly `amountOs`, and the result's
 * chainId must be exactly `expectedNetwork`. Anything unknown, missing or
 * non-canonical returns false and never throws: `ok` must be exactly `false`,
 * the result and the proof may carry only their declared keys, the keys this
 * check requires must be owned, and payer/payee must be unpadded strings that
 * resolve to Demos keys.
 */
export function hasDefinitiveDemosFailure(
  result: DemosFailureResult,
  amountOs: string,
  expectedNetwork: string,
): boolean {
  try {
    return isBoundDemosFailure(
      snapshotWireJsonRead(result, "Demos failure result"),
      amountOs,
      expectedNetwork,
    );
  } catch {
    return false;
  }
}

function isBoundDemosFailure(
  result: DemosFailureResult,
  amountOs: string,
  expectedNetwork: string,
): boolean {
  if (result === null || typeof result !== "object" || Array.isArray(result) ||
      Object.keys(result).some((key) => !RESULT_KEYS.has(key)) ||
      !REQUIRED_RESULT_KEYS.every((key) => Object.prototype.hasOwnProperty.call(result, key)) ||
      typeof result.txHash !== "string" ||
      typeof result.payer !== "string" || result.payer.trim() !== result.payer ||
      typeof result.payee !== "string" || result.payee.trim() !== result.payee) return false;
  const proof = result.failureProof;
  const payer = demosAddressFromClaim(result.payer) ?? normalizeDemosNativeAddress(result.payer);
  const payee = demosAddressFromClaim(result.payee) ?? normalizeDemosNativeAddress(result.payee);
  if (result.ok !== false || result.errorClass !== "permanent" ||
      typeof result.chainId !== "string" || result.chainId.length === 0 ||
      result.chainId.trim() !== result.chainId ||
      result.chainId.normalize("NFC") !== result.chainId ||
      result.chainId !== expectedNetwork ||
      !/^[0-9a-f]{64}$/.test(result.txHash) ||
      payer === null || payee === null ||
      result.txRefKind !== "demos" || result.finality !== undefined ||
      result.txRef !== undefined || result.finalityObservedAt !== undefined ||
      result.x402Receipt !== undefined ||
      proof === null || typeof proof !== "object" || Array.isArray(proof)) return false;
  const value = proof as Record<string, unknown>;
  const keys = ["kind", "txHash", "nonce", "blockNumber", "payer", "payee", "amountOs"];
  return Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    value.kind === "demos-failed-record" && value.txHash === result.txHash &&
    Number.isSafeInteger(value.nonce) && (value.nonce as number) >= 0 &&
    Number.isSafeInteger(value.blockNumber) && (value.blockNumber as number) >= 0 &&
    value.blockNumber === result.blockNumber && value.payer === payer &&
    value.payee === payee && typeof value.amountOs === "string" &&
    /^[1-9][0-9]*$/.test(value.amountOs) &&
    value.amountOs === amountOs;
}
