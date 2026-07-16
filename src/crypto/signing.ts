import { type KeyObject } from "node:crypto";

import { contentHash } from "../canonical/hash.js";
import { DacsError } from "../errors.js";
import {
  ed25519Sign,
  ed25519Verify,
  privateKeyFromSeed,
  publicKeyFromRaw,
} from "./ed25519.js";

/**
 * The closed v0.1 registry of signature domain separators (§7.7). A signature
 * produced under one separator MUST NOT validate under any other (SIG-2). The
 * three composite-payload separators (session-binding, auto-accept-*) and the
 * sealed-bid commitment-hash tag are intentionally excluded — this is the set
 * of 17 single-hash signature separators (incl. the DACS-3 payee-bound
 * agreement domain, #62).
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
  "dacs-commitment:v1:",
  "dacs-transcript:v1:",
  "dacs-evidence:v1:",
  "dacs-amendment:v1:",
  "dacs-rail:v1:",
  "dacs-entitlement:v1:",
  "dacs-bundle:v1:",
  "dacs-rating:v1:",
] as const;

export type DomainSeparator = (typeof SIGNATURE_DOMAIN_SEPARATORS)[number];

const SEPARATOR_SET: ReadonlySet<string> = new Set(SIGNATURE_DOMAIN_SEPARATORS);

export function isRegisteredSeparator(sep: string): sep is DomainSeparator {
  return SEPARATOR_SET.has(sep);
}

/**
 * SIG-4: an artifact kind not in the v0.1 registry signs under a
 * `dacs-x-<kind>:v<version>:` separator, disjoint from the registry above.
 */
export function dacsXSeparator(kind: string, version = "1"): string {
  return `dacs-x-${kind}:v${version}:`;
}

/**
 * `signed_bytes := domain_separator || artifact_hash` (§7.7). The separator is
 * a UTF-8 string and the artifact hash is its lowercase ASCII hex; they are
 * concatenated as byte sequences with no separator byte.
 */
export function signedBytes(separator: string, artifactHash: string): Uint8Array {
  return Buffer.concat([
    Buffer.from(separator, "utf8"),
    Buffer.from(artifactHash, "ascii"),
  ]);
}

/**
 * Sign a document under a registered domain separator. The artifact hash is
 * the content hash of the document's signed scope (signature field omitted).
 * `signer` is either a 32-byte Ed25519 seed or a prepared private KeyObject.
 */
export function signArtifact(
  separator: DomainSeparator,
  doc: Record<string, unknown>,
  signer: Uint8Array | KeyObject,
): Uint8Array {
  if (!isRegisteredSeparator(separator)) {
    throw new DacsError(`unregistered domain separator: ${separator}`);
  }
  const key = signer instanceof Uint8Array ? privateKeyFromSeed(signer) : signer;
  return ed25519Sign(signedBytes(separator, contentHash(doc)), key);
}

/**
 * Verify a document's signature under a domain separator. SIG-2/SIG-3: the
 * separator and artifact hash are reconstructed independently here; a signature
 * whose payload can't be reproduced (or under the wrong separator) fails.
 */
export function verifyArtifact(
  separator: DomainSeparator,
  doc: Record<string, unknown>,
  signature: Uint8Array,
  publicKey: Uint8Array | KeyObject,
): boolean {
  if (!isRegisteredSeparator(separator)) return false;
  const key = publicKey instanceof Uint8Array ? publicKeyFromRaw(publicKey) : publicKey;
  try {
    return ed25519Verify(signedBytes(separator, contentHash(doc)), signature, key);
  } catch {
    return false;
  }
}
