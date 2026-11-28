// The signature separator registry and signed-bytes formatter, with no key
// handling, so verification-only code need not import ./signing.ts.

/**
 * The closed CORE §B.7 registry of signature domain separators, in table
 * order. Hash-only domain tags such as `dacs-sealed-bid:v1:` are not here.
 */
export const SIGNATURE_DOMAIN_SEPARATORS = [
  "dacs-listing:v1:",
  "dacs-revocation:v1:",
  "dacs-bundle-presentation:v1:",
  "dacs-verifyresult:v1:",
  "dacs-composite:v1:",
  "dacs-recipe:v1:",
  "dacs-channelmsg:v1:",
  "dacs-agreement:v1:",
  "dacs-payee-bound-agreement:v1:",
  "dacs-identity-bound-agreement:v1:",
  "dacs-identity-bound-payee-agreement:v1:",
  "dacs-commitment:v1:",
  "dacs-finality-commitment:v1:",
  "dacs-transcript:v1:",
  "dacs-evidence:v1:",
  "dacs-amendment:v1:",
  "dacs-rail:v1:",
  "dacs-entitlement:v1:",
  "dacs-payload-attestation:v1:",
  "dacs-prior-payment-disposition:v1:",
  "dacs-bundle:v1:",
  "dacs-fault-bundle:v1:",
  "dacs-evidence-bound-fault-bundle:v1:",
  "dacs-bundle-binding:v1:",
  "dacs-fault-bundle-pointer:v1:",
  "dacs-evidence-bound-fault-bundle-pointer:v1:",
  "dacs-rating:v1:",
  "dacs-session-binding:v1:",
  "dacs-auto-accept-commitment:v1:",
  "dacs-auto-accept-instance:v1:",
] as const;

export type DomainSeparator = (typeof SIGNATURE_DOMAIN_SEPARATORS)[number];

const SEPARATOR_SET: ReadonlySet<string> = new Set(SIGNATURE_DOMAIN_SEPARATORS);

/** True when `sep` is one of the {@link SIGNATURE_DOMAIN_SEPARATORS}. */
export function isRegisteredSeparator(sep: string): sep is DomainSeparator {
  return SEPARATOR_SET.has(sep);
}

/** Separators that frame more than one value, so they never sign a single hash. */
export const COMPOSITE_DOMAIN_SEPARATORS = [
  "dacs-session-binding:v1:",
  "dacs-auto-accept-instance:v1:",
] as const;

export type CompositeDomainSeparator =
  (typeof COMPOSITE_DOMAIN_SEPARATORS)[number];

const COMPOSITE_SET: ReadonlySet<string> = new Set(COMPOSITE_DOMAIN_SEPARATORS);

/** True when `sep` is one of the {@link COMPOSITE_DOMAIN_SEPARATORS}. */
export function isCompositeSeparator(
  sep: string,
): sep is CompositeDomainSeparator {
  return COMPOSITE_SET.has(sep);
}

/** `signed_bytes := separator (UTF-8) || artifact_hash (ASCII hex)`, per §B.7. */
export function signedBytes(separator: string, artifactHash: string): Uint8Array {
  return Buffer.concat([
    Buffer.from(separator, "utf8"),
    Buffer.from(artifactHash, "ascii"),
  ]);
}
