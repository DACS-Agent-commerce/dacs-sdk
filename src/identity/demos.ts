import { DacsError } from "../errors.js";

// DACS-1 §6.3.1: only the leading ClaimReference scheme is
// case-insensitive on read. The Demos method/profile and key stay lowercase.
const DEMOS_AGENT_CLAIM_REFERENCE =
  /^[dD][iI][dD]:demos:agent:([0-9a-f]{64})$/;

/** Emit the canonical DACS-1 §6.3.1 Demos agent ClaimReference. */
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
 * Decode the self-certifying Demos agent profile from DACS-1 §6.3.1 / §A.1.
 * Foreign schemes and substrate address notation deliberately return null.
 */
export function demosAgentPublicKey(claimRef: string): Uint8Array | null {
  if (typeof claimRef !== "string") return null;
  const match = DEMOS_AGENT_CLAIM_REFERENCE.exec(claimRef);
  return match
    ? Uint8Array.from(Buffer.from(match[1]!, "hex"))
    : null;
}

/** Classify only the registered Demos agent DID profile on read. */
export function isDemosAgentClaimRef(
  claimRef: unknown,
): claimRef is string {
  return typeof claimRef === "string" &&
    DEMOS_AGENT_CLAIM_REFERENCE.test(claimRef);
}
