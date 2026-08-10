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
 * The closed §B.7 registry of signature domain separators — the full 25-entry
 * set at this revision (issue #86; oracle pin
 * c2ecd9fa658776f5511f2414d7b4c3e23b847463). A signature produced under one
 * separator MUST NOT validate under any other (SIG-2).
 *
 * Registry membership (all 25) is distinct from *generic single-hash signing
 * support*: most entries sign the single-hash payload `separator || artifact_hash`
 * and are usable via {@link signArtifact}, but two entries are composite-payload
 * separators ({@link COMPOSITE_DOMAIN_SEPARATORS}) that frame more than one value
 * and MUST use their recipe-specific helpers below. The generic helpers reject
 * the composite separators so a caller can never silently sign the wrong bytes.
 *
 * The non-signature hash-domain tags (`dacs-sealed-bid:v1:`, `dacs-sb3:v1:`) are
 * deliberately NOT here — they domain-separate hash preimages, not signature
 * `signed_bytes`, so SIG-1 does not scope to them.
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
  "dacs-finality-commitment:v1:",
  "dacs-transcript:v1:",
  "dacs-evidence:v1:",
  "dacs-amendment:v1:",
  "dacs-rail:v1:",
  "dacs-entitlement:v1:",
  "dacs-payload-attestation:v1:",
  "dacs-bundle:v1:",
  "dacs-fault-bundle:v1:",
  "dacs-bundle-binding:v1:",
  "dacs-fault-bundle-pointer:v1:",
  "dacs-rating:v1:",
  "dacs-session-binding:v1:",
  "dacs-auto-accept-commitment:v1:",
  "dacs-auto-accept-instance:v1:",
] as const;

export type DomainSeparator = (typeof SIGNATURE_DOMAIN_SEPARATORS)[number];

const SEPARATOR_SET: ReadonlySet<string> = new Set(SIGNATURE_DOMAIN_SEPARATORS);

export function isRegisteredSeparator(sep: string): sep is DomainSeparator {
  return SEPARATOR_SET.has(sep);
}

/**
 * Composite-payload separators (§B.7): these prepend the separator to more than
 * one framed value, so they CANNOT be signed via the single-hash
 * {@link signArtifact}. Each has a recipe-specific helper below
 * ({@link signSessionBinding}, {@link signAutoAcceptInstance}).
 * `dacs-auto-accept-commitment:v1:` is NOT here — despite the auto-accept family
 * it is a plain single-hash signature over `sha256(canonical(commitment))`, so
 * it signs via {@link signArtifact} like any other artifact.
 */
export const COMPOSITE_DOMAIN_SEPARATORS = [
  "dacs-session-binding:v1:",
  "dacs-auto-accept-instance:v1:",
] as const;

export type CompositeDomainSeparator =
  (typeof COMPOSITE_DOMAIN_SEPARATORS)[number];

const COMPOSITE_SET: ReadonlySet<string> = new Set(COMPOSITE_DOMAIN_SEPARATORS);

/**
 * True for the composite-payload separators that must use a recipe-specific
 * helper rather than the generic single-hash signer. A registered separator is
 * generic-signable iff it is registered AND not composite.
 */
export function isCompositeSeparator(
  sep: string,
): sep is CompositeDomainSeparator {
  return COMPOSITE_SET.has(sep);
}

/**
 * SIG-4: an artifact kind not in the closed §B.7 registry signs under a
 * `dacs-x-<kind>:v<version>:` separator, disjoint from the registry above.
 */
export function dacsXSeparator(kind: string, version = "1"): string {
  return `dacs-x-${kind}:v${version}:`;
}

/**
 * `signed_bytes := domain_separator || artifact_hash` (§B.7). The separator is
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
 * Sign a document under a registered SINGLE-HASH domain separator. The artifact
 * hash is the content hash of the document's signed scope (signature field
 * omitted). `signer` is either a 32-byte Ed25519 seed or a prepared private
 * KeyObject.
 *
 * A composite-payload separator (§B.7 — {@link COMPOSITE_DOMAIN_SEPARATORS}) is
 * REJECTED here: its `signed_bytes` frames more than one value, so signing it as
 * a single hash would produce the wrong payload. Use the recipe-specific helper
 * ({@link signSessionBinding}, {@link signAutoAcceptInstance}) instead.
 */
export function signArtifact(
  separator: DomainSeparator,
  doc: Record<string, unknown>,
  signer: Uint8Array | KeyObject,
): Uint8Array {
  if (!isRegisteredSeparator(separator)) {
    throw new DacsError(`unregistered domain separator: ${separator}`);
  }
  if (isCompositeSeparator(separator)) {
    throw new DacsError(
      `composite-payload separator ${separator} cannot be signed as a single ` +
        `hash — use its recipe-specific helper (§B.7)`,
    );
  }
  const key = signer instanceof Uint8Array ? privateKeyFromSeed(signer) : signer;
  return ed25519Sign(signedBytes(separator, contentHash(doc)), key);
}

/**
 * Verify a document's signature under a single-hash domain separator. SIG-2/
 * SIG-3: the separator and artifact hash are reconstructed independently here; a
 * signature whose payload can't be reproduced (or under the wrong separator)
 * fails. A composite-payload separator fails closed for the same reason
 * {@link signArtifact} rejects it — verify it via its recipe-specific helper.
 */
export function verifyArtifact(
  separator: DomainSeparator,
  doc: Record<string, unknown>,
  signature: Uint8Array,
  publicKey: Uint8Array | KeyObject,
): boolean {
  if (!isRegisteredSeparator(separator)) return false;
  if (isCompositeSeparator(separator)) return false;
  const key = publicKey instanceof Uint8Array ? publicKeyFromRaw(publicKey) : publicKey;
  try {
    return ed25519Verify(signedBytes(separator, contentHash(doc)), signature, key);
  } catch {
    return false;
  }
}

// ── Composite-payload recipes (§B.7) ────────────────────────────────────────
// These separators frame more than one fixed-length hex value after the
// separator, so each appended value MUST be an exact fixed-length hex digest
// (or, for a session key, the fixed-length hex public key) for the
// concatenation to be unambiguously parseable. We validate every framed value
// fail-closed so a wrong-length input can never silently shift the payload.

/** 64-char lowercase hex — a sha256 digest or an Ed25519 public key. */
const HEX_64 = /^[0-9a-f]{64}$/;

function assertFramedHex(label: string, value: string): void {
  if (!HEX_64.test(value)) {
    throw new DacsError(
      `${label} must be a 64-character lowercase hex string (composite framing, §B.7)`,
    );
  }
}

/**
 * `signed_bytes := "dacs-session-binding:v1:" || session_key || bundle_hash`
 * (§6.3.2) — the root key's binding of a session key to an identity bundle.
 * `sessionKeyHex` is the session public key as fixed-length lowercase hex;
 * `bundleHash` is the bundle's sha256 hex.
 */
export function sessionBindingBytes(
  sessionKeyHex: string,
  bundleHash: string,
): Uint8Array {
  assertFramedHex("session_key", sessionKeyHex);
  assertFramedHex("bundle_hash", bundleHash);
  return Buffer.concat([
    Buffer.from("dacs-session-binding:v1:", "utf8"),
    Buffer.from(sessionKeyHex, "ascii"),
    Buffer.from(bundleHash, "ascii"),
  ]);
}

export function signSessionBinding(
  sessionKeyHex: string,
  bundleHash: string,
  signer: Uint8Array | KeyObject,
): Uint8Array {
  const key = signer instanceof Uint8Array ? privateKeyFromSeed(signer) : signer;
  return ed25519Sign(sessionBindingBytes(sessionKeyHex, bundleHash), key);
}

export function verifySessionBinding(
  sessionKeyHex: string,
  bundleHash: string,
  signature: Uint8Array,
  publicKey: Uint8Array | KeyObject,
): boolean {
  const key = publicKey instanceof Uint8Array ? publicKeyFromRaw(publicKey) : publicKey;
  try {
    return ed25519Verify(sessionBindingBytes(sessionKeyHex, bundleHash), signature, key);
  } catch {
    return false;
  }
}

/**
 * `signed_bytes := "dacs-auto-accept-instance:v1:" || agreementHash ||
 * autoAcceptCommitmentHash` (§8.4.1) — the seller's per-session auto-accept
 * signature binding a constructed agreement to the anchored AutoAcceptCommitment.
 * Both inputs are sha256 hex.
 */
export function autoAcceptInstanceBytes(
  agreementHash: string,
  autoAcceptCommitmentHash: string,
): Uint8Array {
  assertFramedHex("agreementHash", agreementHash);
  assertFramedHex("autoAcceptCommitmentHash", autoAcceptCommitmentHash);
  return Buffer.concat([
    Buffer.from("dacs-auto-accept-instance:v1:", "utf8"),
    Buffer.from(agreementHash, "ascii"),
    Buffer.from(autoAcceptCommitmentHash, "ascii"),
  ]);
}

export function signAutoAcceptInstance(
  agreementHash: string,
  autoAcceptCommitmentHash: string,
  signer: Uint8Array | KeyObject,
): Uint8Array {
  const key = signer instanceof Uint8Array ? privateKeyFromSeed(signer) : signer;
  return ed25519Sign(
    autoAcceptInstanceBytes(agreementHash, autoAcceptCommitmentHash),
    key,
  );
}

export function verifyAutoAcceptInstance(
  agreementHash: string,
  autoAcceptCommitmentHash: string,
  signature: Uint8Array,
  publicKey: Uint8Array | KeyObject,
): boolean {
  const key = publicKey instanceof Uint8Array ? publicKeyFromRaw(publicKey) : publicKey;
  try {
    return ed25519Verify(
      autoAcceptInstanceBytes(agreementHash, autoAcceptCommitmentHash),
      signature,
      key,
    );
  } catch {
    return false;
  }
}
