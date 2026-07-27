import type { AnchorBinding, BindingIndex } from "./binding.js";

/**
 * Typed read-with-verification over the published binding (#54). This is the
 * discipline the binding module's header states as a MUST: resolution is
 * discovery, not trust, so a consumer that dereferences a resolved native address
 * MUST verify the record itself before trusting it. This surface makes that the
 * default path rather than an easily-forgotten follow-up.
 *
 * The flow is: resolve the logical address through the {@link BindingIndex}
 * (owner-filtered), read the native address, then verify —
 *  1. CONTENT HASH — if the binding carries a `contentHash`, the read record's
 *     hash MUST equal it. A forged index entry that copies the real owner but
 *     points at attacker bytes fails here (the hash won't match the record the
 *     honest producer signed). Injected `contentHashOf` so this stays pure and
 *     substrate-neutral (wire `contentHash ∘ stripSignature`).
 *  2. SIGNATURE — an optional injected check. When supplied, the record's
 *     signature MUST verify; when omitted, the caller takes responsibility for
 *     the signature separately (e.g. via the artifact-specific verifier).
 *
 * Every failure mode is a distinct, fail-closed status — a substrate hiccup
 * (`indeterminate`) is never conflated with a real absence (`absent`) or a
 * verification failure.
 */
export type VerifiedRead =
  | { status: "verified"; nativeAddress: string; record: Record<string, unknown> }
  | { status: "hash-mismatch"; nativeAddress: string; record: Record<string, unknown> }
  | { status: "signature-invalid"; nativeAddress: string; record: Record<string, unknown> }
  | {
      status: "unverifiable";
      nativeAddress: string;
      record: Record<string, unknown>;
      reason: string;
    }
  | { status: "unreadable"; nativeAddress: string }
  | { status: "absent" }
  | { status: "indeterminate"; reason: string };

export interface VerifiedReadDeps {
  /** Read the record anchored at a native address (null if absent). */
  read: (nativeAddress: string) => Promise<Record<string, unknown> | null>;
  /**
   * Content hash of a record's signed scope — compared against the binding's
   * `contentHash`. Pure/substrate-neutral; wire `contentHash ∘ stripSignature`.
   */
  contentHashOf: (record: Record<string, unknown>) => string;
  /**
   * OPTIONAL signature check over the read record. When supplied, the record MUST
   * verify or the read is `signature-invalid`. When omitted, `verified` asserts
   * only the content-hash binding and the caller MUST verify the signature itself.
   */
  verifySignature?: (
    record: Record<string, unknown>,
    binding: AnchorBinding,
  ) => Promise<boolean> | boolean;
}

/**
 * Resolve a logical address through the published binding, read the native
 * address, and verify the record. See {@link VerifiedRead} for the outcomes.
 */
export async function resolveAndRead(
  index: BindingIndex,
  logicalAddress: string,
  expectedOwner: string,
  deps: VerifiedReadDeps,
): Promise<VerifiedRead> {
  const resolution = await index.resolve(logicalAddress, expectedOwner);
  if (resolution.status === "indeterminate") {
    return { status: "indeterminate", reason: resolution.reason };
  }
  if (resolution.status === "absent") return { status: "absent" };

  const { binding } = resolution;
  const nativeAddress = binding.nativeAddress;

  let record: Record<string, unknown> | null;
  try {
    record = await deps.read(nativeAddress);
  } catch (e) {
    // A read that FAILED is not an absence — the record may exist but be
    // momentarily unreachable. Fail closed to `indeterminate`.
    return {
      status: "indeterminate",
      reason: `read of ${nativeAddress} failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!record) return { status: "unreadable", nativeAddress };

  // (1) Content-hash binding: the read record MUST hash to what the binding pins.
  if (binding.contentHash !== undefined) {
    if (deps.contentHashOf(record) !== binding.contentHash) {
      return { status: "hash-mismatch", nativeAddress, record };
    }
  }

  // (2) Signature: when a verifier is supplied it MUST pass.
  if (deps.verifySignature) {
    let ok: boolean;
    try {
      ok = await deps.verifySignature(record, binding);
    } catch (e) {
      return {
        status: "unverifiable",
        nativeAddress,
        record,
        reason: `signature verification threw: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    if (!ok) return { status: "signature-invalid", nativeAddress, record };
  } else if (binding.contentHash === undefined) {
    // Nothing to check here: no binding hash AND no signature verifier. The record
    // is returned but NOT verified — the caller must verify it before trusting it.
    return {
      status: "unverifiable",
      nativeAddress,
      record,
      reason: "binding carries no contentHash and no signature verifier was supplied",
    };
  }

  return { status: "verified", nativeAddress, record };
}
