import { signatureScopeHash, stripSignature } from "../canonical/index.js";
import {
  type DomainSeparator,
  signedBytes,
} from "../crypto/index.js";

/**
 * An artifact with its detached signature attached. The signed scope is the
 * artifact with `signature` omitted; the signature is over
 * `signedBytes(separator, signatureScopeHash(signedScope))` (§7.7).
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
 * Build a signed artifact: sign the content hash under `separator` and attach
 * the signature. The artifact must not already carry a `signature` field
 * (it's stripped from the signed scope regardless).
 */
export async function buildSignedArtifact<T extends object>(
  artifact: T,
  separator: DomainSeparator,
  sign: Signer,
): Promise<SignedArtifact<T>> {
  const scope = stripSignature(artifact as Record<string, unknown>);
  const bytes = signedBytes(separator, signatureScopeHash(scope));
  const signature = await sign(bytes);
  return { ...artifact, signature: toHex(signature) };
}

/**
 * Verify a signed artifact against a signer's public key. Recomputes the
 * content hash of the signed scope (re-canonicalised), so a tampered field or
 * a lifted signature fails.
 */
export async function verifySignedArtifact(
  signed: Record<string, unknown>,
  separator: DomainSeparator,
  publicKey: Uint8Array,
  verify: Verifier,
): Promise<boolean> {
  const signature = signed["signature"];
  if (typeof signature !== "string") return false;
  const bytes = signedBytes(separator, signatureScopeHash(stripSignature(signed)));
  try {
    return await verify(bytes, fromHex(signature), publicKey);
  } catch {
    return false;
  }
}
