import { contentHash } from "../canonical/index.js";
import type { ChainTxRef } from "../artifacts/types.js";
import { isChainTxRef, isSettlementEvidence } from "../artifacts/validators.js";

/** DACS-4 §9.5.8 SB-1 canonical settlement-transaction identity result. */
export type SettlementTxIdentity =
  | { status: "ok"; settlementTxId: string }
  | { status: "not-applicable"; reason: string }
  | { status: "error"; reason: string };

export interface SettlementEvidenceObservation {
  /** Signed normative SettlementEvidence. */
  evidence: Record<string, unknown>;
  /** BundlePhaseEntry.index recovered from the evidence anchor/ref. */
  phaseIndex: number;
}

export type SettlementUniquenessVerdict =
  | "accepted"
  | "duplicate"
  | "error";

export interface SettlementUniquenessCheck {
  jobId: string;
  phaseIndex: number;
  evidenceHash: string;
  settlementTxIds: string[];
  verdict: SettlementUniquenessVerdict;
  reason?: string;
  /** Winning binding when this record loses an SB-2 collision. */
  conflictsWith?: {
    jobId: string;
    phaseIndex: number;
    evidenceHash: string;
  };
}

export interface SettlementBinding {
  jobId: string;
  phaseIndex: number;
}

/** `null` means the consumer's durable SB-2 ledger could not be read. */
export type ConsumedSettlementSet =
  | Readonly<Record<string, SettlementBinding>>
  | null;

export type SettlementClaimCheck = {
  decision: "pass" | "fail" | "error" | "indeterminate";
  effect: "count" | "already-counted" | "reject" | "verifier-error" | "no-decision";
  settlementTxId?: string;
  reason?: string;
  conflictsWith?: SettlementBinding;
};

const isSafeUint = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function normalizedHash(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.startsWith("0x") || value.startsWith("0X")
    ? value.slice(2)
    : value;
  return /^[0-9a-fA-F]{64}$/.test(raw) ? raw.toLowerCase() : null;
}

/** Decode only far enough to enforce SB-1's exact 64-byte base58 signature. */
function base58DecodedLength(value: string): number | null {
  // A 64-byte value encodes to 64..88 base58 characters. Bound the input
  // before BigInt accumulation so malformed untrusted refs cannot cause
  // unbounded work merely to receive an SB-1 error.
  if (
    value.length < 64 ||
    value.length > 88 ||
    !/^[1-9A-HJ-NP-Za-km-z]+$/.test(value)
  ) {
    return null;
  }
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let decoded = 0n;
  for (const char of value) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) return null;
    decoded = decoded * 58n + BigInt(digit);
  }
  let payloadBytes = 0;
  for (let n = decoded; n > 0n; n >>= 8n) payloadBytes += 1;
  const leadingZeroBytes = value.length - value.replace(/^1+/, "").length;
  return leadingZeroBytes + payloadBytes;
}

/**
 * Derive the exact SB-1 identity for every rail whose recipe is pinned by the
 * Standard. Unsupported transaction variants are explicit; they never mint an
 * implementation-local uniqueness key.
 */
export function deriveSettlementTxId(ref: unknown): SettlementTxIdentity {
  if (!isChainTxRef(ref)) {
    return { status: "error", reason: "malformed ChainTxRef" };
  }

  switch (ref.kind) {
    case "evm": {
      const txHash = normalizedHash(ref.txHash);
      if (!isSafeUint(ref.chainId) || !isSafeUint(ref.logIndex) || !txHash) {
        return {
          status: "error",
          reason: "evm settlement identity requires chainId, logIndex, and a 32-byte txHash",
        };
      }
      return {
        status: "ok",
        settlementTxId: `evm:${ref.chainId}:${txHash}:${ref.logIndex}`,
      };
    }
    case "x402": {
      const txHash = normalizedHash(ref.settlementTxHash);
      if (!isSafeUint(ref.chainId) || !isSafeUint(ref.logIndex) || !txHash) {
        return {
          status: "error",
          reason: "x402 settlement identity requires chainId, logIndex, and a 32-byte settlementTxHash",
        };
      }
      return {
        status: "ok",
        settlementTxId: `evm:${ref.chainId}:${txHash}:${ref.logIndex}`,
      };
    }
    case "solana":
      if (!isSafeUint(ref.instructionIndex) || base58DecodedLength(ref.signature) !== 64) {
        return {
          status: "error",
          reason: "solana settlement identity requires instructionIndex and a 64-byte base58 signature",
        };
      }
      return {
        status: "ok",
        settlementTxId: `solana:${ref.cluster}:${ref.signature}:${ref.instructionIndex}`,
      };
    case "demos": {
      const txHash = normalizedHash(ref.txHash);
      return txHash
        ? { status: "ok", settlementTxId: `demos:${txHash}` }
        : {
            status: "error",
            reason: "demos settlement identity requires a 32-byte txHash",
          };
    }
    case "storage-program":
      return {
        status: "not-applicable",
        reason: "storage-program references are delivery/write identities, not payment settlements",
      };
    default:
      return {
        status: "not-applicable",
        reason: `SB-1 has no standalone identity recipe for intrinsically/provider-bound ${ref.kind} references`,
      };
  }
}

/**
 * Evaluate one SB-2 claim against a consumer's durable consumed-set. This is
 * the stateless verifier form used by the promoted Standard vectors; callers
 * persist a `count` result under the returned `settlementTxId` atomically.
 */
export function verifySettlementClaimUniqueness(
  ref: unknown,
  binding: SettlementBinding,
  consumed: ConsumedSettlementSet,
): SettlementClaimCheck {
  if (
    typeof binding.jobId !== "string" ||
    binding.jobId.length === 0 ||
    !isSafeUint(binding.phaseIndex)
  ) {
    return {
      decision: "error",
      effect: "verifier-error",
      reason: "settlement binding requires a non-empty jobId and non-negative safe phaseIndex",
    };
  }

  const identity = deriveSettlementTxId(ref);
  if (identity.status !== "ok") {
    return {
      decision: "error",
      effect: "verifier-error",
      reason: identity.reason,
    };
  }
  if (consumed === null) {
    return {
      decision: "indeterminate",
      effect: "no-decision",
      settlementTxId: identity.settlementTxId,
      reason: "settlement consumed-set is unreadable",
    };
  }

  const prior = Object.prototype.hasOwnProperty.call(
    consumed,
    identity.settlementTxId,
  )
    ? consumed[identity.settlementTxId]
    : undefined;
  if (prior === undefined) {
    return {
      decision: "pass",
      effect: "count",
      settlementTxId: identity.settlementTxId,
    };
  }
  if (
    typeof prior.jobId !== "string" ||
    !isSafeUint(prior.phaseIndex)
  ) {
    return {
      decision: "indeterminate",
      effect: "no-decision",
      settlementTxId: identity.settlementTxId,
      reason: "settlement consumed-set contains a malformed binding",
    };
  }
  if (
    prior.jobId === binding.jobId &&
    prior.phaseIndex === binding.phaseIndex
  ) {
    return {
      decision: "pass",
      effect: "already-counted",
      settlementTxId: identity.settlementTxId,
    };
  }
  return {
    decision: "fail",
    effect: "reject",
    settlementTxId: identity.settlementTxId,
    reason: `settlementTxId is already bound to ${prior.jobId}/${prior.phaseIndex}`,
    conflictsWith: prior,
  };
}

interface PreparedObservation extends SettlementUniquenessCheck {
  observedAt: number;
  binding: string;
}

function prepareObservation(
  observation: SettlementEvidenceObservation,
): PreparedObservation {
  const { evidence, phaseIndex } = observation;
  let evidenceHash = "";
  try {
    evidenceHash = contentHash(evidence);
  } catch {
    return {
      jobId: typeof evidence.jobId === "string" ? evidence.jobId : "",
      phaseIndex,
      evidenceHash,
      settlementTxIds: [],
      observedAt: Number.NaN,
      binding: "",
      verdict: "error",
      reason: "evidence signed scope is not canonicalizable",
    };
  }
  const fallback = {
    jobId: typeof evidence.jobId === "string" ? evidence.jobId : "",
    phaseIndex,
    evidenceHash,
    settlementTxIds: [],
    observedAt:
      typeof evidence.observedAt === "number" ? evidence.observedAt : Number.NaN,
    binding: "",
  };
  if (!isSafeUint(phaseIndex)) {
    return {
      ...fallback,
      verdict: "error",
      reason: "phaseIndex must be a non-negative safe integer",
    };
  }
  if (!isSettlementEvidence(evidence)) {
    return {
      ...fallback,
      verdict: "error",
      reason: "evidence is not a normative signed SettlementEvidence record",
    };
  }

  const settlementTxIds: string[] = [];
  for (const ref of evidence.paymentTxRefs ?? []) {
    const identity = deriveSettlementTxId(ref);
    if (identity.status === "error") {
      return {
        ...fallback,
        settlementTxIds,
        verdict: "error",
        reason: identity.reason,
      };
    }
    if (identity.status === "not-applicable" && evidence.phase.startsWith("pay-")) {
      return {
        ...fallback,
        settlementTxIds,
        verdict: "error",
        reason: `cannot apply SB-2: ${identity.reason}`,
      };
    }
    if (identity.status === "ok") settlementTxIds.push(identity.settlementTxId);
  }
  const uniqueIds = [...new Set(settlementTxIds)].sort();
  return {
    jobId: evidence.jobId,
    phaseIndex,
    evidenceHash,
    settlementTxIds: uniqueIds,
    observedAt: evidence.observedAt,
    binding: `${evidence.jobId}\u0000${phaseIndex}`,
    verdict: "accepted",
  };
}

function winnerOrder(a: PreparedObservation, b: PreparedObservation): number {
  if (a.observedAt !== b.observedAt) return a.observedAt - b.observedAt;
  if (a.evidenceHash !== b.evidenceHash) {
    return a.evidenceHash < b.evidenceHash ? -1 : 1;
  }
  if (a.binding !== b.binding) return a.binding < b.binding ? -1 : 1;
  return 0;
}

/**
 * Apply SB-2 to a consumer's evidence set. The result preserves input order,
 * while winner selection is order-independent: earliest `observedAt`, then the
 * lower signed-scope evidence hash. Reusing an id inside the same
 * `(jobId,phaseIndex)` binding is not a cross-session collision.
 */
export function reconcileSettlementEvidence(
  observations: readonly SettlementEvidenceObservation[],
): SettlementUniquenessCheck[] {
  const prepared = observations.map(prepareObservation);
  const owners = new Map<string, PreparedObservation>();
  for (const candidate of [...prepared].sort(winnerOrder)) {
    if (candidate.verdict !== "accepted") continue;
    const conflictingId = candidate.settlementTxIds.find((id) => {
      const owner = owners.get(id);
      return owner !== undefined && owner.binding !== candidate.binding;
    });
    if (conflictingId) {
      const winner = owners.get(conflictingId)!;
      candidate.verdict = "duplicate";
      candidate.reason = `settlementTxId ${conflictingId} is already bound to ${winner.jobId}/${winner.phaseIndex}`;
      candidate.conflictsWith = {
        jobId: winner.jobId,
        phaseIndex: winner.phaseIndex,
        evidenceHash: winner.evidenceHash,
      };
      continue;
    }
    for (const id of candidate.settlementTxIds) {
      if (!owners.has(id)) owners.set(id, candidate);
    }
  }

  return prepared.map(
    ({ observedAt: _observedAt, binding: _binding, ...check }) => check,
  );
}
