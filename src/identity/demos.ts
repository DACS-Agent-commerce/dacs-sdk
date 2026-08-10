import { DacsError } from "../errors.js";

// DID schemes are case-insensitive. The registered method/profile and the
// embedded Ed25519 key remain deliberately strict and lowercase.
const DEMOS_AGENT_CLAIM_REF = /^[dD][iI][dD]:demos:agent:([0-9a-f]{64})$/;

/** Build the canonical DACS-1 Demos agent ClaimReference from a raw Ed25519 key. */
export function demosAgentClaimRef(publicKey: Uint8Array | string): string {
  const hex =
    typeof publicKey === "string"
      ? publicKey.replace(/^0x/i, "")
      : Buffer.from(publicKey).toString("hex");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new DacsError("Demos agent public key must be exactly 32 bytes");
  }
  return `did:demos:agent:${hex.toLowerCase()}`;
}

/**
 * Decode a registered Demos agent ClaimReference to its raw Ed25519 key.
 * Unregistered address notation and lookalike identifiers return null rather
 * than being silently treated as aliases.
 */
export function demosAgentPublicKey(claimRef: string): Uint8Array | null {
  const match = DEMOS_AGENT_CLAIM_REF.exec(claimRef);
  return match ? Uint8Array.from(Buffer.from(match[1]!, "hex")) : null;
}

/** Return whether a string is a valid Demos agent ClaimReference on read. */
export function isDemosAgentClaimRef(claimRef: string): boolean {
  return DEMOS_AGENT_CLAIM_REF.test(claimRef);
}
