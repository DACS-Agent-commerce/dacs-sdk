import {
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  sign as nodeSign,
} from "node:crypto";

import { DacsError } from "../errors.js";

export { publicKeyFromRaw, rawPublicKey, ed25519Verify } from "./ed25519Verify.js";

// DER framing for a raw Ed25519 seed, so 32 bytes can be turned into a Node
// KeyObject without extra dependencies.
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/**
 * Build an Ed25519 private key from its 32-byte seed. A seed of any other
 * length throws a `DacsError` with code `key.seed_length_invalid`.
 */
export function privateKeyFromSeed(seed: Uint8Array): KeyObject {
  if (seed.length !== 32) {
    throw new DacsError(`ed25519 seed must be 32 bytes, got ${seed.length}`, {
      code: "key.seed_length_invalid",
    });
  }
  const encoded = Buffer.alloc(PKCS8_PREFIX.length + seed.byteLength);
  PKCS8_PREFIX.copy(encoded);
  Buffer.from(seed.buffer, seed.byteOffset, seed.byteLength).copy(
    encoded,
    PKCS8_PREFIX.length,
  );
  try {
    return createPrivateKey({
      key: encoded,
      format: "der",
      type: "pkcs8",
    });
  } finally {
    encoded.fill(0);
  }
}

/** Derive the public key from a 32-byte seed. Any other length throws as {@link privateKeyFromSeed} does. */
export function publicKeyFromSeed(seed: Uint8Array): KeyObject {
  return createPublicKey(privateKeyFromSeed(seed));
}

/** Ed25519 signature over a message (RFC 8032, deterministic). */
export function ed25519Sign(message: Uint8Array, privateKey: KeyObject): Uint8Array {
  return nodeSign(null, message, privateKey);
}
