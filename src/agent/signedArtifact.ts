import { contentHash, stripSignature } from "../canonical/index.js";
import {
  type DomainSeparator,
  signedBytes,
} from "../crypto/index.js";

/**
 * Legacy MVP artifact carrying a raw lowercase-hex signature string.
 *
 * @deprecated Compatibility reads and the quarantined settlement-only session
 * path only. Normative DACS producers use `ComponentSignedArtifact` and
 * `buildComponentSignedArtifact()`, whose signature is the CORE §B.7
 * `ComponentSignature` envelope with canonical unpadded Base64URL bytes.
 */
export type SignedArtifact<T extends object> = T & {
  signature: string;
};

/** Signs raw bytes, returning the signature bytes (e.g. wired to the wallet). */
export type Signer = (bytes: Uint8Array) => Promise<Uint8Array> | Uint8Array;

/** Verifies a signature over raw bytes for a given public key. */
export type Verifier = (
  bytes: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
) => Promise<boolean> | boolean;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return new Uint8Array((clean.match(/.{1,2}/g) ?? []).map((b) => parseInt(b, 16)));
}

/**
 * Build a legacy MVP raw-hex signed artifact.
 *
 * @deprecated Do not use for new DACS artifacts. Use
 * `buildComponentSignedArtifact()` with an authorised CORE §B.7 signer.
 */
export async function buildSignedArtifact<T extends object>(
  artifact: T,
  separator: DomainSeparator,
  sign: Signer,
): Promise<SignedArtifact<T>> {
  const scope = stripSignature(artifact as Record<string, unknown>);
  const bytes = signedBytes(separator, contentHash(scope));
  const signature = await sign(bytes);
  return { ...artifact, signature: toHex(signature) };
}

/**
 * Verify the historical raw-hex signature representation.
 *
 * @deprecated Compatibility reads only. Normative readers use
 * `verifyComponentSignature()` and enforce signer authorisation as well as
 * cryptographic validity.
 */
export async function verifySignedArtifact(
  signed: Record<string, unknown>,
  separator: DomainSeparator,
  publicKey: Uint8Array,
  verify: Verifier,
): Promise<boolean> {
  const signature = signed["signature"];
  if (typeof signature !== "string") return false;
  const bytes = signedBytes(separator, contentHash(stripSignature(signed)));
  try {
    return await verify(bytes, fromHex(signature), publicKey);
  } catch {
    return false;
  }
}
