import { DacsError } from "../errors.js";
import { parseCanonicalClaimReference } from "./claimReference.js";

const DEMOS_AGENT_IDENTIFIER = /^demos:agent:([0-9a-f]{64})$/;

/** Parsed DACS-1 §6.3.1 Demos agent ClaimReference. */
export interface ParsedDemosAgentClaimReference {
  /** Exact CF-2 bytes, including every canonical advisory parameter. */
  canonicalReference: string;
  /** Parameter-free CF-3 identity used for matching and reputation keying. */
  canonicalIdentity: string;
  /** Self-certifying Ed25519 verification key decoded from the identifier. */
  publicKey: Uint8Array;
}

function parseDemosAgent(
  value: unknown,
  canonicalOnly: boolean,
): ParsedDemosAgentClaimReference | null {
  if (typeof value !== "string") return null;
  // DACS-1 §6.3.1 permits case-insensitive Scheme handling on a standalone
  // read, but only the leading `did` component is repaired. The identifier,
  // key, parameter order, and percent encoding still have to be exact CF-2.
  const canonicalCandidate = canonicalOnly
    ? value
    : /^did:/i.test(value)
      ? `did:${value.slice(4)}`
      : value;
  const parsed = parseCanonicalClaimReference(canonicalCandidate);
  const match = parsed?.identity.scheme === "did"
    ? DEMOS_AGENT_IDENTIFIER.exec(parsed.identity.identifier)
    : null;
  if (!parsed || !match) return null;
  return {
    canonicalReference: parsed.reference,
    canonicalIdentity: `did:${parsed.identity.identifier}`,
    publicKey: Uint8Array.from(Buffer.from(match[1]!, "hex")),
  };
}

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
 * Standalone DACS-1 read helper. It accepts case variation only in the leading
 * `did` scheme, returns canonical CF-2 bytes for forwarding, preserves all
 * canonical unknown parameters, and derives the parameter-free CF-3 identity.
 */
export function parseDemosAgentClaimReference(
  claimRef: unknown,
): ParsedDemosAgentClaimReference | null {
  return parseDemosAgent(claimRef, false);
}

/** Decode a standalone/read-compatible Demos ClaimReference. */
export function demosAgentPublicKey(claimRef: string): Uint8Array | null {
  return parseDemosAgentClaimReference(claimRef)?.publicKey ?? null;
}

/**
 * DACS-1 §6.3.1 / CORE §B.1 strict authorization helper for bytes already
 * embedded in a current signed artifact. Unlike the standalone reader, it
 * never repairs the leading scheme.
 */
export function canonicalDemosAgentPublicKey(
  claimRef: unknown,
): Uint8Array | null {
  return parseDemosAgent(claimRef, true)?.publicKey ?? null;
}

/** Classify only the registered Demos agent DID profile on standalone read. */
export function isDemosAgentClaimRef(
  claimRef: unknown,
): claimRef is string {
  return typeof claimRef === "string" &&
    parseDemosAgentClaimReference(claimRef) !== null;
}
