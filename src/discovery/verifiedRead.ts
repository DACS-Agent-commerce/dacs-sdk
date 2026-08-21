import type { AnchorBinding, BindingIndex } from "./binding.js";
import { normalizedBindingOwner } from "./owner.js";

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
 *  2. ARTIFACT VERIFICATION — an injected artifact-specific check must validate
 *     the canonical signed scope, registered separator, supported version,
 *     signature algorithm, authorized signer, and expected owner/role. Without
 *     that check the bytes remain `unverifiable`, even when their hash matches an
 *     untrusted binding selected by an attacker.
 *
 * Every failure mode is a distinct, fail-closed status — a substrate hiccup
 * (`indeterminate`) is never conflated with a real absence (`absent`) or a
 * verification failure.
 */
export type VerifiedRead =
  | { status: "verified"; nativeAddress: string; record: Record<string, unknown> }
  | { status: "hash-mismatch"; nativeAddress: string; record: Record<string, unknown> }
  | { status: "signature-invalid"; nativeAddress: string; record: Record<string, unknown> }
  | { status: "binding-mismatch"; reason: string }
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
  /** Read the record at its native locator and optional catalog anchor kind. */
  read: (
    nativeAddress: string,
    anchorKind?: string,
  ) => Promise<Record<string, unknown> | null>;
  /**
   * Content hash of a record's signed scope — compared against the binding's
   * `contentHash`. Pure/substrate-neutral; wire `contentHash ∘ stripSignature`.
   */
  contentHashOf: (record: Record<string, unknown>) => string;
  /**
   * Artifact-specific signature and authorization check. When omitted the record
   * can be returned for inspection, but it MUST remain `unverifiable`: the
   * binding, including its contentHash, is untrusted discovery data.
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
  let resolution;
  try {
    resolution = await index.resolve(logicalAddress, expectedOwner);
  } catch (e) {
    return {
      status: "indeterminate",
      reason: `binding resolution failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (resolution.status === "indeterminate") {
    return { status: "indeterminate", reason: resolution.reason };
  }
  if (resolution.status === "absent") return { status: "absent" };

  let binding: AnchorBinding;
  try {
    const snapshot: unknown = structuredClone(resolution.binding);
    if (
      typeof snapshot !== "object" ||
      snapshot === null ||
      Array.isArray(snapshot)
    ) {
      throw new Error("binding is not an object");
    }
    binding = snapshot as AnchorBinding;
  } catch (e) {
    return {
      status: "indeterminate",
      reason: `binding snapshot failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (
    typeof binding.logicalAddress !== "string" ||
    binding.logicalAddress !== logicalAddress ||
    typeof binding.owner !== "string" ||
    normalizedBindingOwner(binding.owner) !==
      normalizedBindingOwner(expectedOwner) ||
    (binding.anchorKind !== undefined &&
      (typeof binding.anchorKind !== "string" ||
        binding.anchorKind.length === 0 ||
        binding.anchorKind !== binding.anchorKind.trim())) ||
    typeof binding.nativeAddress !== "string" ||
    binding.nativeAddress.trim().length === 0 ||
    binding.revoked === true
  ) {
    return {
      status: "binding-mismatch",
      reason:
        "binding index returned a logical address, owner, native address, or state that does not match the request",
    };
  }
  const nativeAddress = binding.nativeAddress;

  let record: Record<string, unknown> | null;
  try {
    record = await deps.read(nativeAddress, binding.anchorKind);
  } catch (e) {
    // A read that FAILED is not an absence — the record may exist but be
    // momentarily unreachable. Fail closed to `indeterminate`.
    return {
      status: "indeterminate",
      reason: `read of ${nativeAddress} failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!record) return { status: "unreadable", nativeAddress };
  try {
    const snapshot: unknown = structuredClone(record);
    if (
      typeof snapshot !== "object" ||
      snapshot === null ||
      Array.isArray(snapshot)
    ) {
      throw new Error("record is not an object");
    }
    record = snapshot as Record<string, unknown>;
  } catch (e) {
    return {
      status: "indeterminate",
      reason: `read record snapshot failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // (1) Content-hash binding: a reader cannot authenticate the pointer without
  // an exact signed-scope hash, even when the pointed-to record has a valid
  // signature. A valid artifact at the wrong logical slot is still the wrong
  // artifact.
  if (binding.contentHash === undefined) {
    return {
      status: "unverifiable",
      nativeAddress,
      record,
      reason: "published binding does not carry a content hash",
    };
  }
  let actualContentHash: string;
  try {
    actualContentHash = deps.contentHashOf(record);
  } catch (e) {
    return {
      status: "unverifiable",
      nativeAddress,
      record,
      reason: `content hash computation failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (actualContentHash !== binding.contentHash) {
    return { status: "hash-mismatch", nativeAddress, record };
  }

  // (2) Authorship/authorization: a hash against an untrusted pointer is never
  // enough to call attacker-selected bytes verified.
  if (deps.verifySignature) {
    let ok: boolean;
    try {
      ok = await deps.verifySignature(
        structuredClone(record),
        structuredClone(binding),
      );
    } catch (e) {
      return {
        status: "unverifiable",
        nativeAddress,
        record,
        reason: `signature verification threw: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    if (!ok) return { status: "signature-invalid", nativeAddress, record };
  } else {
    return {
      status: "unverifiable",
      nativeAddress,
      record,
      reason: "no artifact-specific signature and signer-authorisation verifier was supplied",
    };
  }

  return { status: "verified", nativeAddress, record };
}
