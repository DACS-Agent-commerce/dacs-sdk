import type { IdentityBundle } from "../artifacts/types.js";
import { canonicalize, sha256Hex } from "../canonical/index.js";

/**
 * DACS-1 §6.3.2 `bundle_hash`.
 *
 * IdentityBundle is not hashed like a generic signed artifact: its canonical
 * form omits `presentation`, while every other member remains in scope.
 */
export function identityBundleHash(bundle: Readonly<IdentityBundle>): string {
  const { presentation: _presentation, ...canonicalForm } = bundle;
  return sha256Hex(canonicalize(canonicalForm));
}
