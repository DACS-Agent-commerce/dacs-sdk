// Ed25519 public keys and signature verification, with no private-key code,
// so verification-only modules need not import ./ed25519.ts.
import { createPublicKey, type KeyObject, verify as nodeVerify } from "node:crypto";

import { DacsError } from "../errors.js";

// DER framing that turns a raw 32-byte Ed25519 public key into a KeyObject.
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

/**
 * Build an Ed25519 public key from its raw 32 bytes. Any other length throws a
 * `DacsError` with code `key.public_key_length_invalid`.
 */
export function publicKeyFromRaw(raw: Uint8Array): KeyObject {
  if (raw.length !== 32) {
    throw new DacsError(`ed25519 public key must be 32 bytes, got ${raw.length}`, {
      code: "key.public_key_length_invalid",
    });
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
