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
const FIELD_PRIME = (1n << 255n) - 19n;
const GROUP_ORDER = (1n << 252n) + 27742317777372353535851937790883648493n;
const SMALL_ORDER_Y = new Set([
  0n, 1n, FIELD_PRIME - 1n,
  2707385501144840649318225287225658788936804267575313519463743609750303402022n,
  FIELD_PRIME - 2707385501144840649318225287225658788936804267575313519463743609750303402022n,
]);

function littleEndianInteger(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i]!);
  return value;
}

/** Build an Ed25519 private key from its 32-byte seed. */
export function privateKeyFromSeed(seed: Uint8Array): KeyObject {
  if (seed.length !== 32) {
    throw new DacsError(`ed25519 seed must be 32 bytes, got ${seed.length}`);
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

/** Verify an Ed25519 signature. A private key verifies as its public key. */
export function ed25519Verify(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: KeyObject,
): boolean {
  const key = publicKey.type === "private" ? createPublicKey(publicKey) : publicKey;
  if (signature.length !== 64 || littleEndianInteger(signature.subarray(32)) >= GROUP_ORDER) return false;
  const y = littleEndianInteger(rawPublicKey(key)) & ((1n << 255n) - 1n);
  if (y >= FIELD_PRIME || SMALL_ORDER_Y.has(y)) return false;
  return nodeVerify(null, message, key, signature);
}
