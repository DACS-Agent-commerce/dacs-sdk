// Shape checks for a ComponentSignature envelope. Nothing here signs, so
// verification-only code can import it without reaching ./signatures.ts.
import { isSafeJsonString, snapshotCanonicalJsonRead } from "../canonical/snapshot.js";
import { isRecord } from "../internal/isRecord.js";

import type { ComponentSignature, ComponentSignatureAlgorithm } from "./types.js";

/** Closed algorithm set used by ComponentSignature in the DACS v0.x line. */
export const COMPONENT_SIGNATURE_ALGORITHMS = [
  "ed25519",
  "ecdsa-secp256k1",
  "sr1-aggregate",
] as const satisfies readonly ComponentSignatureAlgorithm[];

const ALGORITHM_SET: ReadonlySet<string> = new Set(
  COMPONENT_SIGNATURE_ALGORITHMS,
);

export type ComponentSignatureMalformedReason =
  | "signature-not-an-object"
  | "unsupported-algorithm"
  | "invalid-signer"
  | "invalid-value"
  | "unexpected-signature-fields"
  | "ambiguous-signature-fields"
  | "unregistered-domain-separator"
  | "composite-domain-separator"
  | "signed-scope-not-canonicalizable";

/** True for a non-empty string with no leading or trailing whitespace. */
export const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value;

/** True when `value` names one of {@link COMPONENT_SIGNATURE_ALGORITHMS}. */
export function isComponentSignatureAlgorithm(value: string): boolean {
  return ALGORITHM_SET.has(value);
}

/** CORE §B.7 SIG-6 canonical unpadded Base64URL encoding. */
export function isCanonicalBase64Url(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    return false;
  }
  try {
    return Buffer.from(value, "base64url").toString("base64url") === value;
  } catch {
    return false;
  }
}

/** True when `value` has exactly the ComponentSignature envelope shape. */
export function isComponentSignature(
  value: unknown,
): value is ComponentSignature {
  if (!isRecord(value)) return false;
  try {
    return (
      signatureShapeReason(
        snapshotCanonicalJsonRead(value, "component signature"),
      ) === null
    );
  } catch {
    return false;
  }
}

/** Why `value` is not a ComponentSignature envelope, or null when it is one. */
export function signatureShapeReason(
  value: unknown,
): ComponentSignatureMalformedReason | null {
  if (!isRecord(value)) return "signature-not-an-object";
  const keys = Object.keys(value);
  if (
    keys.length !== 3 ||
    !keys.includes("algorithm") ||
    !keys.includes("signer") ||
    !keys.includes("value")
  ) {
    return "unexpected-signature-fields";
  }
  if (
    typeof value.algorithm !== "string" ||
    !ALGORITHM_SET.has(value.algorithm)
  ) {
    return "unsupported-algorithm";
  }
  if (!isNonEmptyString(value.signer) || !isSafeJsonString(value.signer)) {
    return "invalid-signer";
  }
  if (!isCanonicalBase64Url(value.value)) return "invalid-value";
  return null;
}
