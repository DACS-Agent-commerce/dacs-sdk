import {
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  sign as nodeSign,
  verify as nodeVerify,
} from "node:crypto";

import { DacsError } from "../errors.js";

// DER framing for raw Ed25519 keys, so a 32-byte seed / public key can be
// turned into a Node KeyObject without extra dependencies.
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Build an Ed25519 private key from its 32-byte seed. */
export function privateKeyFromSeed(seed: Uint8Array): KeyObject {
  if (seed.length !== 32) {
    throw new DacsError(`ed25519 seed must be 32 bytes, got ${seed.length}`);
  }
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seed)]),
    format: "der",
    type: "pkcs8",
  });
}

/** Derive the public key from a 32-byte seed. */
export function publicKeyFromSeed(seed: Uint8Array): KeyObject {
  return createPublicKey(privateKeyFromSeed(seed));
}

/** Build an Ed25519 public key from its raw 32 bytes. */
export function publicKeyFromRaw(raw: Uint8Array): KeyObject {
  if (raw.length !== 32) {
    throw new DacsError(`ed25519 public key must be 32 bytes, got ${raw.length}`);
  }
  return createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, Buffer.from(raw)]),
    format: "der",
    type: "spki",
  });
}

/** Extract the raw 32-byte public key from a KeyObject. */
export function rawPublicKey(key: KeyObject): Uint8Array {
  const spki = key.export({ format: "der", type: "spki" }) as Buffer;
  return spki.subarray(spki.length - 32);
}

/** Ed25519 signature over a message (RFC 8032, deterministic). */
export function ed25519Sign(message: Uint8Array, privateKey: KeyObject): Uint8Array {
  return nodeSign(null, message, privateKey);
}

/** Verify an Ed25519 signature. */
export function ed25519Verify(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: KeyObject,
): boolean {
  return nodeVerify(null, message, publicKey, signature);
}
