import { parseCanonicalClaimReference } from "../identity/claimReference.js";
import { canonicalDemosAgentPublicKey } from "../identity/demos.js";

/**
 * The Demos address a DACS primary claim settles to. In the Demos model a CCI
 * *is* the ed25519 public-key hex, so a Demos claim resolves INTRINSICALLY to its
 * address — no external mapping is trusted. Accepts only the exact
 * `did:demos:agent:<64-lowercase-hex>` profile or the DACS-1
 * `cci-xm:demos:<subchain>:0x<64-hex>` profile. ClaimReference parameters do not
 * contribute to identity and are ignored after the complete native address.
 *
 * STRICT (#32): a non-Demos scheme that merely *ends* in 64 hex — `did:ethr:…`,
 * `cci-xm:evm:mainnet:0x…`, `web2:…:…` — is NOT Demos-bound and returns null, so
 * pay-dem refuses to transfer rather than treating a foreign-scheme claim as an
 * intrinsic Demos destination. A claim that embeds no Demos key returns null too.
 */
export function demosAddressFromClaim(claim: string): string | null {
  // This is a ClaimReference boundary, not the explicit native-address config
  // boundary below. Never trim, case-fold, reorder, or otherwise repair signed
  // protocol bytes before applying CF-2.
  const parsed = parseCanonicalClaimReference(claim);
  if (!parsed) return null;
  const did = canonicalDemosAgentPublicKey(claim);
  if (did) return Buffer.from(did).toString("hex");
  const cci = parsed.identity.scheme === "cci-xm"
    ? /^demos:[^:]+:0x([0-9a-fA-F]{64})$/.exec(
        parsed.identity.identifier,
      )
    : null;
  if (cci) {
    return cci[1]!.toLowerCase();
  }
  return null;
}

/** Strict native Demos rail-address normalisation (not a ClaimReference parser). */
export function normalizeDemosNativeAddress(address: string): string | null {
  const native = address.trim().match(/^(?:0x)?([0-9a-fA-F]{64})$/);
  return native ? native[1]!.toLowerCase() : null;
}
