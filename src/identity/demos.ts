import { DacsError } from "../errors.js";

const DEMOS_AGENT_DID = /^[dD][iI][dD]:demos:agent:([0-9a-f]{64})$/;

/** Build the canonical DACS-1 Demos agent ClaimReference from a raw Ed25519 key. */
export function demosAgentClaimRef(publicKey: Uint8Array | string): string {
  const hex = typeof publicKey === "string"
    ? publicKey.replace(/^0x/i, "")
    : Buffer.from(publicKey).toString("hex");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new DacsError("Demos agent public key must be exactly 32 bytes");
  }
  return `did:demos:agent:${hex.toLowerCase()}`;
}

/**
 * Resolve a Demos agent ClaimReference to its raw Ed25519 key. The registered
 * `did` scheme is case-insensitive on read; method components and key material
 * remain strict. The unregistered `demos:0x…` address notation returns null
 * instead of being silently aliased.
 */
export function demosAgentPublicKey(claimRef: string): Uint8Array | null {
  const match = DEMOS_AGENT_DID.exec(claimRef);
  return match ? Uint8Array.from(Buffer.from(match[1]!, "hex")) : null;
}

export function isDemosAgentClaimRef(claimRef: string): boolean {
  return DEMOS_AGENT_DID.test(claimRef);
}
