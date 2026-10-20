import { baseUnits } from "../canonical/index.js";
import { demosAddressFromClaim, normalizeDemosNativeAddress } from "../rails/demosAddress.js";

/** DACS-4 §9.5.9: 1 DEM = 10^9 OS (the rail's `DEM_DECIMALS`). */
const DEM_OS_DECIMALS = 9;

/**
 * The exact OS amount a native DEM payment request commits to, or `null` when
 * the request is not a `pay-dem` DEM payment or its amount does not convert.
 */
export function payDemRequestAmountOs(
  request: Readonly<{ phase: string; asset: string; amount: string }>,
): string | null {
  if (request.phase !== "pay-dem" || request.asset !== "DEM") return null;
  try {
    const amountOs = baseUnits(request.amount, DEM_OS_DECIMALS);
    return amountOs === "0" ? null : amountOs;
  } catch {
    return null;
  }
}

/**
 * A trusted rail's attestation of a terminal failed Demos record. It is issued
 * only after matching the signed hash/nonce, inclusion block and native body.
 * It proves failure of this attempt; it never authorizes a replacement debit.
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

/**
 * Validate owned, canonical result data after the caller's snapshot boundary.
 * Rail callers bind the configured network here; session recovery also matches
 * the retained chainId against its durable outcome and anchored evidence.
 */
export function hasDefinitiveDemosFailure(
  result: {
    ok: boolean; txHash: string; chainId: string; payer: string; payee: string;
    errorClass?: unknown; failureProof?: unknown; blockNumber?: unknown;
    txRefKind?: unknown; finality?: unknown; txRef?: unknown;
    finalityObservedAt?: unknown; x402Receipt?: unknown;
  },
  amountOs?: string,
  expectedNetwork?: string,
): boolean {
  const proof = result.failureProof;
  const payer = demosAddressFromClaim(result.payer) ?? normalizeDemosNativeAddress(result.payer);
  const payee = demosAddressFromClaim(result.payee) ?? normalizeDemosNativeAddress(result.payee);
  if (result.ok || result.errorClass !== "permanent" ||
      typeof result.chainId !== "string" || result.chainId.length === 0 ||
      result.chainId.trim() !== result.chainId ||
      result.chainId.normalize("NFC") !== result.chainId ||
      (expectedNetwork !== undefined && result.chainId !== expectedNetwork) ||
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
    (amountOs === undefined || value.amountOs === amountOs);
}
