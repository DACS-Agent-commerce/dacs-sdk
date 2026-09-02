import type { IdentityBundle } from "../artifacts/types.js";
import { canonicalize, sha256Hex } from "../canonical/index.js";
import { signedBytes } from "../crypto/signing.js";
import { DacsError } from "../errors.js";

const BUNDLE_PRESENTATION_SEPARATOR = "dacs-bundle-presentation:v1:";
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/;

/**
 * DACS-1 §6.3.2 `bundle_hash`.
 *
 * IdentityBundle is not a generic signed artifact: its canonical form omits
 * `presentation`, while every other member (including `sessionNonce` and
 * unknown minor-version fields) remains in scope.  Keep this artifact-specific
 * rule in one helper so agreement, Vet, payment, and bundle code cannot drift.
 */
export function identityBundleHash(bundle: Readonly<IdentityBundle>): string {
  const { presentation: _presentation, ...canonicalForm } = bundle;
  return sha256Hex(canonicalize(canonicalForm));
}

/**
 * DACS-1 §6.3.2 SIWD Resource for one independently recomputed bundle hash.
 *
 * The URI carries the lowercase hexadecimal encoding of the complete
 * domain-separated presentation bytes. It is deliberately not the bare bundle
 * hash and not a hash of those bytes.
 */
export function siwdBundleResource(bundleHash: string): string {
  if (!LOWERCASE_SHA256.test(bundleHash)) {
    throw new DacsError("SIWD bundle resource requires a lowercase SHA-256 bundle hash");
  }
  return `dacs:${Buffer.from(
    signedBytes(BUNDLE_PRESENTATION_SEPARATOR, bundleHash),
  ).toString("hex")}`;
}

/**
 * Fail-closed DACS-1 SIWD Resources membership check.
 *
 * The caller remains responsible for parsing and authenticating the EIP-4361
 * message. This predicate accepts only an intrinsic, dense array of own string
 * data values and compares exact resource strings, so a bare hex value,
 * alternate URI spelling, accessor, sparse array, or hostile proxy cannot bind
 * a bundle accidentally.
 */
export function siwdResourcesBindBundleHash(
  resources: unknown,
  bundleHash: string,
): boolean {
  try {
    if (
      !Array.isArray(resources) ||
      Object.getPrototypeOf(resources) !== Array.prototype
    ) {
      return false;
    }
    const expected = siwdBundleResource(bundleHash);
    const descriptors = Object.getOwnPropertyDescriptors(resources);
    const keys = Reflect.ownKeys(resources);
    if (
      !keys.every((key) =>
        typeof key === "string" &&
        (key === "length" || /^(0|[1-9][0-9]*)$/.test(key))
      ) ||
      resources.length === 0
    ) {
      return false;
    }
    let matched = false;
    for (let index = 0; index < resources.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor) ||
        typeof descriptor.value !== "string"
      ) {
        return false;
      }
      if (descriptor.value === expected) matched = true;
    }
    return matched;
  } catch {
    return false;
  }
}
